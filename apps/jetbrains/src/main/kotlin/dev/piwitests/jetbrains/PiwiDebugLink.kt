package dev.piwitests.jetbrains

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.VirtualFile

/**
 * **Debug in my editor**, once [PiwiOpenHandler] opened the failing line of a debug request: a notification, never a
 * modal dialog, asks before anything runs, and only its **Debug** runs the test, as every run Piwi starts here does
 * ([PiwiCommands.runTests]: the IDE's breakpoints included, in the IDE's Playwright runner when the settings choose
 * it), with `RunTestsArgs.debug`. The editor service finds the test in its spec by its title, runs it headed with one
 * worker, and stops once at the failing line: a breakpoint of that run alone, so the IDE's own breakpoints are left as
 * they are. At the stop, the service outlines the failure's suggested locator on the page and says so.
 */
object PiwiDebugLink {
    /** Ask, in `project`, to debug the test of `spec` at the 1-based `line` of `failing`. */
    fun ask(project: Project, spec: VirtualFile, failing: VirtualFile, line: Int, debug: Glue.DebugRequest) {
        val specUri = uriOf(spec) ?: return
        val failingUri = uriOf(failing) ?: return
        // The notification's text is HTML: the title, plain text already, is escaped too.
        val notification = NotificationGroupManager.getInstance().getNotificationGroup("Piwi").createNotification(
            StringUtil.escapeXmlEntities(Glue.debugPrompt(debug.title, line)),
            NotificationType.INFORMATION,
        )
        notification.addAction(
            NotificationAction.createSimpleExpiring(Glue.DEBUG_ANSWER) {
                // The run reads its spec as saved.
                val documents = FileDocumentManager.getInstance()
                documents.getCachedDocument(spec)?.let { if (documents.isDocumentUnsaved(it)) documents.saveDocument(it) }
                PiwiCommands.runTests(project, Glue.debugRunArgs(specUri, failingUri, line, debug), quiet = true)
            },
        )
        notification.notify(project)
    }

    private fun uriOf(file: VirtualFile): String? =
        if (file.isInLocalFileSystem) runCatching { file.toNioPath().toUri().toString() }.getOrNull() else null
}

package dev.piwitests.jetbrains

import com.intellij.codeInsight.daemon.LineMarkerInfo
import com.intellij.codeInsight.daemon.LineMarkerProviderDescriptor
import com.intellij.codeInsight.daemon.LineMarkerSettings
import com.intellij.execution.Location
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import javax.swing.Icon

/**
 * **Run with Piwi** and **Verify ×3 with Piwi** in the menu of the IDE's own run icon
 * (`JSTestRunLineMarkersAdditionalActionGroup`), acting on the line the icon stands on (`Location.DATA_KEY`), in a spec
 * under one of the project's Playwright config folders, on a line where the service finds a `test(…)` call of
 * Playwright's (`piwi/testAt`): never on a describe's line nor in a spec another runner gives its `test`.
 */
class PiwiRunLineMarkerActions : ActionGroup(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun getChildren(e: AnActionEvent?): Array<AnAction> {
        val project = e?.project ?: return EMPTY_ARRAY
        val element = e.getData(Location.DATA_KEY)?.psiElement ?: return EMPTY_ARRAY
        val psiFile = element.containingFile ?: return EMPTY_ARRAY
        val file = psiFile.virtualFile ?: return EMPTY_ARRAY
        val service = project.service<PiwiProjectService>()
        val path = runCatching { file.toNioPath() }.getOrNull() ?: return EMPTY_ARRAY
        if (!Glue.isSpecFile(file.name) || !Glue.inConfigDirs(path, service.playwrightConfigDirs())) return EMPTY_ARRAY
        val document = PsiDocumentManager.getInstance(project).getDocument(psiFile) ?: return EMPTY_ARRAY
        val line = document.getLineNumber(element.textRange.startOffset)
        if (testAt(project, path.toUri().toString(), line)?.location == null) return EMPTY_ARRAY
        val onLine = { builder: com.intellij.openapi.actionSystem.impl.SimpleDataContext.Builder ->
            builder.add(TEST_LINE, line)
            Unit
        }
        val actions = listOfNotNull(
            registeredWith("Piwi.RunTestAtCursor", "Run with Piwi", AllIcons.Actions.Execute, data = onLine),
            registeredWith("Piwi.VerifyTestAtCursor", "Verify ×3 with Piwi", AllIcons.Actions.Rerun, data = onLine),
        )
        if (actions.isEmpty()) return EMPTY_ARRAY
        return arrayOf(Separator.create("Piwi"), *actions.toTypedArray())
    }

    companion object {
        /** How long the run icon's menu waits for the service to say a line holds a test. */
        private const val TEST_AT_MILLIS = 300L

        /** `piwi/testAt` at the start of a line, which `PiwiPluginTest` replaces. */
        @Volatile
        internal var testAt: (Project, String, Int) -> TestAtResult? = { project, uri, line ->
            project.service<PiwiProjectService>().server()?.testAt(TestAtParams(uri, line, 0))?.awaitCancellably(TEST_AT_MILLIS)
        }
    }
}

/**
 * **Piwi test results** on Settings → Editor → General → Gutter Icons: the switch of Piwi's result icon, which
 * `PiwiTestAnnotator` draws and reads it for. It marks nothing itself.
 */
class PiwiTestResultsGutter : LineMarkerProviderDescriptor() {
    /** The key the IDE keeps the switch under, whatever this class is called. */
    override fun getId(): String = "piwi.testResults"

    override fun getName(): String = "Piwi test results"

    override fun getIcon(): Icon = PiwiIcons.outcome("passed")

    override fun getLineMarkerInfo(element: PsiElement): LineMarkerInfo<*>? = null

    companion object {
        /** Whether Piwi's result icon is drawn: on unless switched off on the Gutter Icons page. */
        fun shown(): Boolean = LineMarkerSettings.getSettings().isEnabled(PiwiTestResultsGutter())
    }
}

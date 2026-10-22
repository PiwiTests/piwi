package dev.piwitests.jetbrains

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.icons.AllIcons
import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile
import com.intellij.ui.EditorNotificationPanel
import com.intellij.ui.EditorNotificationProvider
import java.util.function.Function
import javax.swing.JComponent

/**
 * The banner over a file a recording writes into: what it does, how many steps it wrote, and Stop, Pause or Resume;
 * once the developer changed the recorded lines, Resume or Keep My Edits. The service's command, when it offers one,
 * is a link too.
 */
class PiwiRecordingNotificationProvider : EditorNotificationProvider, DumbAware {
    override fun collectNotificationData(project: Project, file: VirtualFile): Function<in FileEditor, out JComponent?>? {
        val recordings = project.getServiceIfCreated(PiwiRecordings::class.java) ?: return null
        val session = recordings.sessionFor(file) ?: return null
        val view = session.view
        val command = session.command
        return Function { fileEditor ->
            EditorNotificationPanel(fileEditor, EditorNotificationPanel.Status.Info).apply {
                icon(AllIcons.Ide.Macro.Recording_1)
                text(view.text)
                for (action in view.actions) {
                    when (action) {
                        Glue.RecordingAction.STOP -> createActionLabel("Stop") { recordings.stop(session) }
                        Glue.RecordingAction.PAUSE -> createActionLabel("Pause") { recordings.pause(session) }
                        Glue.RecordingAction.RESUME -> createActionLabel("Resume") { recordings.resume(session) }
                        Glue.RecordingAction.KEEP_EDITS -> createActionLabel("Keep My Edits") { recordings.stop(session) }
                    }
                }
                val title = command?.title
                if (command != null && title != null) {
                    createActionLabel(title) { PiwiCommands.execute(project, command.command, command.arguments.orEmpty()) }
                }
            }
        }
    }
}

/**
 * The warnings of the recordings into a file, as weak warnings on their lines, with the message on hover: what a
 * reader of the recorded code should check (a brittle locator, a value read from the environment, a file to provide).
 * They stay after the recording, each until its line changes, and offer then the other locators the recorder verified
 * for their step as quick fixes ([UseRecordedLocatorFix]).
 */
class PiwiRecordingAnnotator : ExternalAnnotator<List<RecordingWarningView>, List<RecordingWarningView>>(), DumbAware {
    override fun collectInformation(file: PsiFile, editor: Editor, hasErrors: Boolean): List<RecordingWarningView>? =
        collectInformation(file)

    override fun collectInformation(file: PsiFile): List<RecordingWarningView>? {
        val document = file.viewProvider.document ?: return null
        return file.project.getServiceIfCreated(PiwiRecordings::class.java)?.warnings(document)?.ifEmpty { null }
    }

    override fun doAnnotate(collectedInfo: List<RecordingWarningView>?): List<RecordingWarningView>? = collectedInfo

    override fun apply(file: PsiFile, annotationResult: List<RecordingWarningView>?, holder: AnnotationHolder) {
        for (warning in annotationResult.orEmpty()) {
            val range = warning.range
            if (range.endOffset > file.textLength) continue
            var annotation = holder.newAnnotation(HighlightSeverity.WEAK_WARNING, "Piwi: ${warning.message}").range(range)
            for (choice in warning.choices) {
                annotation = annotation.withFix(
                    UseRecordedLocatorFix(choice.title, range.startOffset, warning.text, choice.start, choice.end, choice.locator),
                )
            }
            annotation.create()
        }
    }
}

/**
 * A quick fix on a recorded line's warning, whose text `line` starts at `offset`: puts `locator`, another one the
 * recorder verified for the step, in place of the written one at `[start, end)` of that text, in one command. It
 * applies while the line holds that text, and the line it changes then shows the warning no more.
 */
class UseRecordedLocatorFix(
    private val title: String,
    private val offset: Int,
    private val line: String,
    private val start: Int,
    private val end: Int,
    private val locator: String,
) : IntentionAction, DumbAware {
    override fun getText(): String = title

    override fun getFamilyName(): String = "Use another recorded locator"

    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean = holdsLine(documentOf(editor, file))

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        val document = documentOf(editor, file) ?: return
        if (holdsLine(document)) document.replaceString(offset + start, offset + end, locator)
    }

    override fun startInWriteAction(): Boolean = true

    private fun documentOf(editor: Editor?, file: PsiFile?): Document? = file?.viewProvider?.document ?: editor?.document

    /** Whether `document` holds the warning's line at its offset, as the warning saw it. */
    private fun holdsLine(document: Document?): Boolean {
        val chars = document?.immutableCharSequence ?: return false
        return offset + line.length <= chars.length && chars.subSequence(offset, offset + line.length).toString() == line
    }
}

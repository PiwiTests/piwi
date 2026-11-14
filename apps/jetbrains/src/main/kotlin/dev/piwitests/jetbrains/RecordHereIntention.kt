package dev.piwitests.jetbrains

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.codeInsight.intention.LowPriorityAction
import com.intellij.codeInsight.intention.preview.IntentionPreviewInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile

/**
 * Record here under Alt+Enter, at the bottom of the list: the same recording as the Record here action, at the caret,
 * where the service says one writes (`piwi/recordPlace`), under its title: **Piwi: record a test here…** past the
 * imports, outside every test, function and class, and **Piwi: record steps here…** in a test's or a function's body.
 * It opens the recording's questions once the intention list has closed, and changes nothing itself.
 */
class RecordHereIntention : IntentionAction, LowPriorityAction, DumbAware {
    /** The title of the last place offered. */
    @Volatile
    private var title = "Piwi: record here…"

    override fun getText(): String = title

    override fun getFamilyName(): String = "Piwi: record here"

    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean {
        val virtualFile = file?.virtualFile ?: return false
        if (editor == null || !PiwiRecordFlow.canRecordInto(project, virtualFile)) return false
        val document = editor.document
        val line = document.getLineNumber(editor.caretModel.offset)
        val offered = project.service<PiwiProjectService>().recordPlace(virtualFile, document.modificationStamp, line)?.title
            ?: return false
        title = offered
        return true
    }

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        val virtualFile = file?.virtualFile ?: return
        if (editor == null) return
        ApplicationManager.getApplication().invokeLater({ PiwiRecordFlow.recordHere(project, editor, virtualFile) }, project.disposed)
    }

    override fun startInWriteAction(): Boolean = false

    override fun generatePreview(project: Project, editor: Editor, file: PsiFile): IntentionPreviewInfo = IntentionPreviewInfo.EMPTY
}

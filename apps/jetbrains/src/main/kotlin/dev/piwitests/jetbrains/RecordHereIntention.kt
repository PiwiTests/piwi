package dev.piwitests.jetbrains

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.codeInsight.intention.LowPriorityAction
import com.intellij.codeInsight.intention.preview.IntentionPreviewInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile

/**
 * **Piwi: Record here** under Alt+Enter, at the bottom of the list: the same recording as the Record Here action, at
 * the caret, in a JavaScript or TypeScript file under one of the project's Playwright config folders. It opens the
 * recording's questions once the intention list has closed, and changes nothing itself.
 */
class RecordHereIntention : IntentionAction, LowPriorityAction, DumbAware {
    override fun getText(): String = "Piwi: Record here"

    override fun getFamilyName(): String = "Piwi: Record here"

    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean {
        val virtualFile = file?.virtualFile ?: return false
        return editor != null && PiwiRecordFlow.canRecordInto(project, virtualFile)
    }

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        val virtualFile = file?.virtualFile ?: return
        if (editor == null) return
        ApplicationManager.getApplication().invokeLater({ PiwiRecordFlow.recordHere(project, editor, virtualFile) }, project.disposed)
    }

    override fun startInWriteAction(): Boolean = false

    override fun generatePreview(project: Project, editor: Editor, file: PsiFile): IntentionPreviewInfo = IntentionPreviewInfo.EMPTY
}

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
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import javax.swing.Icon

/**
 * **Run with Piwi** and **Verify ×3 with Piwi** in the menu of the IDE's own run icon on a test
 * (`JSTestRunLineMarkersAdditionalActionGroup`), acting on the line the icon stands on (`Location.DATA_KEY`), in a spec
 * under one of the project's Playwright config folders: a test with no Piwi result yet runs with Piwi from its line too.
 */
class PiwiRunLineMarkerActions : ActionGroup(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun getChildren(e: AnActionEvent?): Array<AnAction> {
        val project = e?.project ?: return EMPTY_ARRAY
        val element = e.getData(Location.DATA_KEY)?.psiElement ?: return EMPTY_ARRAY
        val psiFile = element.containingFile ?: return EMPTY_ARRAY
        val file = psiFile.virtualFile ?: return EMPTY_ARRAY
        val service = project.service<PiwiProjectService>()
        val path = runCatching { file.toNioPath() }.getOrNull()
        if (!Glue.isSpecFile(file.name) || !Glue.inConfigDirs(path, service.playwrightConfigDirs())) return EMPTY_ARRAY
        val document = PsiDocumentManager.getInstance(project).getDocument(psiFile) ?: return EMPTY_ARRAY
        val line = document.getLineNumber(element.textRange.startOffset)
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
}

/**
 * **Piwi test results** on Settings → Editor → General → Gutter Icons: the switch of Piwi's result icon, which
 * `PiwiTestAnnotator` draws and reads it for. It marks nothing itself.
 */
class PiwiTestResultsGutter : LineMarkerProviderDescriptor() {
    override fun getName(): String = "Piwi test results"

    override fun getIcon(): Icon = PiwiIcons.outcome("passed")

    override fun getLineMarkerInfo(element: PsiElement): LineMarkerInfo<*>? = null

    companion object {
        /** Whether Piwi's result icon is drawn: on unless switched off on the Gutter Icons page. */
        fun shown(): Boolean = LineMarkerSettings.getSettings().isEnabled(PiwiTestResultsGutter())
    }
}

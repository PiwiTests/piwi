package dev.piwitests.jetbrains

import com.intellij.codeInsight.codeVision.CodeVisionAnchorKind
import com.intellij.codeInsight.codeVision.CodeVisionEntry
import com.intellij.codeInsight.codeVision.CodeVisionRelativeOrdering
import com.intellij.codeInsight.codeVision.ui.model.ClickableTextCodeVisionEntry
import com.intellij.codeInsight.hints.codeVision.DaemonBoundCodeVisionProvider
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiFile

/**
 * The lines above a file, a test and a locator (`piwi/fileSummary`): the
 * tests behind each locator line, each test's pass rate, the tests that reach
 * an application file. A click runs what the line names.
 */
class PiwiCodeVisionProvider : DaemonBoundCodeVisionProvider {
    override val id = "piwi.summary"
    override val name = "Piwi"
    override val groupId = "piwi.summary"
    override val defaultAnchor: CodeVisionAnchorKind = CodeVisionAnchorKind.Top
    override val relativeOrderings: List<CodeVisionRelativeOrdering> = listOf(CodeVisionRelativeOrdering.CodeVisionRelativeOrderingFirst)

    override fun computeForEditor(editor: Editor, file: PsiFile): List<Pair<TextRange, CodeVisionEntry>> {
        val project = editor.project ?: return emptyList()
        val virtualFile = file.virtualFile ?: return emptyList()
        if (!PiwiLspServerSupportProvider.isSupported(virtualFile)) return emptyList()
        val document = editor.document
        // The daemon computes this in a read action: the wait gives way to a write action. The gutter's request for the
        // same text answers it, whichever comes first.
        val summary = project.service<PiwiProjectService>()
            .fileSummary(virtualFile, document.modificationStamp)
            ?.awaitCancellably(3_000)
            ?: return emptyList()
        // A test's line is drawn in the gutter (PiwiTestAnnotator), not as text above it.
        return (listOfNotNull(summary.file) + summary.lines.orEmpty().filter { it.status == null }).mapNotNull { line ->
            if (line.line < 0 || line.line >= document.lineCount || line.title.isNullOrBlank()) return@mapNotNull null
            val range = TextRange(document.getLineStartOffset(line.line), document.getLineEndOffset(line.line))
            val entry = ClickableTextCodeVisionEntry(line.title, id, { _, _ ->
                line.command?.let { PiwiCommands.execute(project, it.command, it.arguments.orEmpty()) }
            })
            range to entry
        }
    }
}

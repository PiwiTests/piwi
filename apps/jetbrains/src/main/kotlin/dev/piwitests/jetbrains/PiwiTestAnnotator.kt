package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile
import javax.swing.Icon

/**
 * Each test's latest result on the test itself (`piwi/fileSummary`): an icon in the gutter, its
 * details as the tooltip and a click opening it in the dashboard, a background over a failing
 * test, and a stronger one on the line it failed at, with why as the tooltip, and whether that
 * line changed since the run. While a run the service follows runs a test, the icon says so, then gives that run's
 * result. The summary is fetched outside the read action, shared with Code Vision, and drawn while the IDE indexes.
 */
class PiwiTestAnnotator : ExternalAnnotator<PiwiTestAnnotator.Target, List<SummaryLine>>(), DumbAware {
    class Target(val project: Project, val file: VirtualFile, val stamp: Long)

    override fun collectInformation(file: PsiFile, editor: Editor, hasErrors: Boolean): Target? = collectInformation(file)

    override fun collectInformation(file: PsiFile): Target? {
        val virtualFile = file.virtualFile ?: return null
        if (!PiwiLspServerSupportProvider.isSupported(virtualFile)) return null
        if (!file.project.service<PiwiProjectService>().hasPlaywrightConfig()) return null
        val stamp = file.viewProvider.document?.modificationStamp ?: return null
        return Target(file.project, virtualFile, stamp)
    }

    override fun doAnnotate(target: Target?): List<SummaryLine>? {
        val service = target?.project?.service<PiwiProjectService>() ?: return null
        val summary = service.fileSummary(target.file, target.stamp)?.awaitCancellably(5_000) ?: return null
        val tests = summary.lines.orEmpty().filter { it.status != null }
        service.showsTests(target.file, tests.isNotEmpty())
        return tests
    }

    override fun apply(file: PsiFile, lines: List<SummaryLine>?, holder: AnnotationHolder) {
        val document = file.viewProvider.document ?: return
        val text = document.charsSequence
        for (line in lines.orEmpty()) {
            if (line.line !in 0 until document.lineCount) continue
            val start = document.getLineStartOffset(line.line)
            val end = document.getLineEndOffset(line.line)
            var first = start
            while (first < end && text[first].isWhitespace()) first++
            if (first == end) continue
            holder.newSilentAnnotation(HighlightSeverity.INFORMATION)
                .range(TextRange(first, end))
                .gutterIconRenderer(TestResultGutter(file.project, line))
                .create()
            val failure = line.failure?.takeIf { it.line in 0 until document.lineCount }
            val failedAt = failure?.let { TextRange(document.getLineStartOffset(it.line), document.getLineEndOffset(it.line)) }
            if (line.status == "failed") {
                val last = (line.endLine ?: line.line).coerceIn(line.line, document.lineCount - 1)
                val test = TextRange(start, document.getLineEndOffset(last))
                // Two backgrounds on one line have no set order: the test's goes around the failing line.
                val parts = if (failedAt != null && test.contains(failedAt)) {
                    listOf(TextRange(test.startOffset, failedAt.startOffset), TextRange(failedAt.endOffset, test.endOffset))
                } else {
                    listOf(test)
                }
                for (part in parts.filterNot { it.isEmpty }) {
                    holder.newSilentAnnotation(HighlightSeverity.INFORMATION).range(part).textAttributes(FAILING_TEST).create()
                }
            }
            if (failure != null && failedAt != null && !failedAt.isEmpty) {
                holder.newSilentAnnotation(HighlightSeverity.INFORMATION)
                    .range(failedAt)
                    .textAttributes(FAILING_LINE)
                    .tooltip(Glue.failureTooltip(failure.headline, failure.message, failure.state == "edited"))
                    .create()
            }
        }
    }

    /** A test's latest result in the gutter; a click runs what its line names (it opens the test in the dashboard). */
    private class TestResultGutter(private val project: Project, private val line: SummaryLine) : GutterIconRenderer(), DumbAware {
        override fun getIcon(): Icon = when (line.status) {
            "failed" -> AllIcons.RunConfigurations.TestFailed
            "flaky" -> AllIcons.General.Warning
            "passed" -> AllIcons.RunConfigurations.TestPassed
            "skipped" -> AllIcons.RunConfigurations.TestIgnored
            "running" -> AllIcons.RunConfigurations.TestState.Run
            else -> AllIcons.RunConfigurations.TestNotRan
        }

        override fun getTooltipText(): String = Glue.testResultTooltip(line.status, line.title)

        override fun isNavigateAction(): Boolean = line.command != null

        override fun getClickAction(): AnAction? = line.command?.let { command ->
            object : AnAction() {
                override fun actionPerformed(e: AnActionEvent) {
                    PiwiCommands.execute(project, command.command, command.arguments.orEmpty())
                }
            }
        }

        override fun equals(other: Any?): Boolean = other is TestResultGutter && other.line == line

        override fun hashCode(): Int = line.hashCode()
    }

    companion object {
        /** The background of a failing test: **Settings → Editor → Color Scheme → Piwi**, light red by default. */
        val FAILING_TEST: TextAttributesKey = TextAttributesKey.createTextAttributesKey("PIWI_FAILING_TEST")

        /** The line a failing test failed at, over its background: a stronger red by default. */
        val FAILING_LINE: TextAttributesKey = TextAttributesKey.createTextAttributesKey("PIWI_FAILING_LINE")
    }
}

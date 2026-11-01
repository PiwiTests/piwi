package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
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
 * result. Every test of a spec as it stands (`piwi/testItems`), one not run yet included, gets **Run with Piwi** and
 * **Verify ×3 with Piwi** from its gutter icon: the click of a test with no result, the right-click menu of any. The
 * summary is fetched outside the read action, shared with Code Vision, and drawn while the IDE indexes.
 */
class PiwiTestAnnotator : ExternalAnnotator<PiwiTestAnnotator.Target, PiwiTestAnnotator.Found>(), DumbAware {
    class Target(val project: Project, val file: VirtualFile, val stamp: Long, val uri: String)

    /** Each test's latest result, and the 0-based lines of the spec's tests as it stands. */
    class Found(val results: List<SummaryLine>, val testLines: Set<Int>)

    override fun collectInformation(file: PsiFile, editor: Editor, hasErrors: Boolean): Target? = collectInformation(file)

    override fun collectInformation(file: PsiFile): Target? {
        val virtualFile = file.virtualFile ?: return null
        if (!PiwiLspServerSupportProvider.isSupported(virtualFile)) return null
        if (!file.project.service<PiwiProjectService>().hasPlaywrightConfig()) return null
        val stamp = file.viewProvider.document?.modificationStamp ?: return null
        val uri = runCatching { virtualFile.toNioPath().toUri().toString() }.getOrNull() ?: return null
        return Target(file.project, virtualFile, stamp, uri)
    }

    override fun doAnnotate(target: Target?): Found? {
        val service = target?.project?.service<PiwiProjectService>() ?: return null
        val summary = service.fileSummary(target.file, target.stamp)?.awaitCancellably(5_000)
        val results = summary?.lines.orEmpty().filter { it.status != null }
        service.showsTests(target.file, results.isNotEmpty())
        val testLines = if (Glue.isSpecFile(target.file.name)) {
            service.server()?.testItems(TestItemsParams(listOf(target.uri), false))?.awaitCancellably(5_000)
                ?.contexts.orEmpty().flatMap { it.specs.orEmpty() }.flatMap { it.tests.orEmpty() }.map { it.line }.toSet()
        } else {
            null
        }
        return Found(results, testLines.orEmpty())
    }

    override fun apply(file: PsiFile, found: Found?, holder: AnnotationHolder) {
        val document = file.viewProvider.document ?: return
        val uri = runCatching { file.virtualFile?.toNioPath()?.toUri()?.toString() }.getOrNull() ?: return
        val text = document.charsSequence
        val lines = found?.results.orEmpty()
        /** The range of a line's text, without its indentation; null for a blank line or one past the end. */
        fun codeOf(line: Int): TextRange? {
            if (line !in 0 until document.lineCount) return null
            var first = document.getLineStartOffset(line)
            val end = document.getLineEndOffset(line)
            while (first < end && text[first].isWhitespace()) first++
            return if (first == end) null else TextRange(first, end)
        }
        val withResult = lines.map { it.line }.toSet()
        for (testLine in found?.testLines.orEmpty()) {
            if (testLine in withResult) continue
            val code = codeOf(testLine) ?: continue
            holder.newSilentAnnotation(HighlightSeverity.INFORMATION)
                .range(code)
                .gutterIconRenderer(RunGutter(file.project, uri, testLine))
                .create()
        }
        for (line in lines) {
            if (line.line !in 0 until document.lineCount) continue
            val start = document.getLineStartOffset(line.line)
            val end = document.getLineEndOffset(line.line)
            var first = start
            while (first < end && text[first].isWhitespace()) first++
            if (first == end) continue
            holder.newSilentAnnotation(HighlightSeverity.INFORMATION)
                .range(TextRange(first, end))
                .gutterIconRenderer(TestResultGutter(file.project, line, uri))
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

    /**
     * A test's latest result in the gutter; a click runs what its line names (it opens the test in the dashboard), and
     * the right-click menu runs the test with Piwi.
     */
    private class TestResultGutter(
        private val project: Project,
        private val line: SummaryLine,
        private val uri: String,
    ) : GutterIconRenderer(), DumbAware {
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

        override fun getPopupMenuActions(): ActionGroup = piwiRunActions(project, uri, line.line)

        override fun equals(other: Any?): Boolean = other is TestResultGutter && other.line == line && other.uri == uri

        override fun hashCode(): Int = line.hashCode()
    }

    /** A test with no result yet: **Run with Piwi** on a click, **Verify ×3 with Piwi** in the right-click menu too. */
    private class RunGutter(private val project: Project, private val uri: String, private val line: Int) :
        GutterIconRenderer(), DumbAware {
        override fun getIcon(): Icon = AllIcons.RunConfigurations.TestState.Run

        override fun getTooltipText(): String = "Run with Piwi (right-click: Verify ×3 with Piwi)"

        override fun isNavigateAction(): Boolean = true

        override fun getClickAction(): AnAction = object : AnAction(), DumbAware {
            override fun actionPerformed(e: AnActionEvent) {
                PiwiCommands.runTestAt(project, uri, line, 0, wholeSpec = false)
            }
        }

        override fun getPopupMenuActions(): ActionGroup = piwiRunActions(project, uri, line)

        override fun equals(other: Any?): Boolean = other is RunGutter && other.uri == uri && other.line == line

        override fun hashCode(): Int = uri.hashCode() * 31 + line
    }

    companion object {
        /** **Run with Piwi** and **Verify ×3 with Piwi** for the test whose `test(…)` call holds the 0-based `line`. */
        private fun piwiRunActions(project: Project, uri: String, line: Int): ActionGroup = DefaultActionGroup(
            object : AnAction("Run with Piwi", "Run this test as Piwi runs it, its results on the instance", AllIcons.Actions.Execute), DumbAware {
                override fun actionPerformed(e: AnActionEvent) = PiwiCommands.runTestAt(project, uri, line, 0, wholeSpec = false)
            },
            object : AnAction("Verify ×3 with Piwi", "Run this test three times without retries", AllIcons.Actions.Rerun), DumbAware {
                override fun actionPerformed(e: AnActionEvent) = PiwiCommands.runTestAt(project, uri, line, 0, wholeSpec = false, repeat = 3)
            },
        )

        /** The background of a failing test: **Settings → Editor → Color Scheme → Piwi**, light red by default. */
        val FAILING_TEST: TextAttributesKey = TextAttributesKey.createTextAttributesKey("PIWI_FAILING_TEST")

        /** The line a failing test failed at, over its background: a stronger red by default. */
        val FAILING_LINE: TextAttributesKey = TextAttributesKey.createTextAttributesKey("PIWI_FAILING_LINE")
    }
}

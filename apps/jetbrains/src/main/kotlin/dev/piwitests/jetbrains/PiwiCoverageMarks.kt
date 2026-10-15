package dev.piwitests.jetbrains

import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.impl.DocumentMarkupModel
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.LineMarkerRendererEx
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Condition
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.util.ui.JBUI
import java.awt.Graphics
import java.awt.Rectangle
import java.util.concurrent.ConcurrentHashMap

/**
 * The coverage the project's tests recorded of the open files (`piwi/coverage`), as marks at the left of the gutter
 * and in the scroll bar: the lines tests ran, the executable lines none runs, and, dashed, the lines changed since the
 * coverage run. They are range highlighters on each file's document, which follow its edits until the service pushes
 * the marks it placed again (`piwi/coverageChanged`); the service's hover names the tests behind a line. A file without
 * line coverage shows none. **Tools → Piwi → Show Coverage Marks** hides them, on this machine only
 * (`PiwiLocalSettings.coverageMarks`), and is offered once a file showed some.
 */
@Service(Service.Level.PROJECT)
class PiwiCoverageMarks(private val project: Project) : Disposable {
    /** Each open file's answer, by the URI it was asked with. */
    private val answers = ConcurrentHashMap<String, CoverageResult>()

    /** The files asked about, by URI: a pushed answer names its file by the URI it was asked with. */
    private val files = ConcurrentHashMap<String, VirtualFile>()

    /** The highlighters drawn on each file, by URI; on the event thread. */
    private val drawn = HashMap<String, List<RangeHighlighter>>()

    /** Whether a file showed marks: the action that hides them is offered from then on. */
    @Volatile var known = false
        private set

    @Volatile private var disposed = false

    private val gone = Condition<Any?> { disposed || project.isDisposed }

    /** Whether the marks are drawn; kept in `.idea/workspace.xml`. */
    var shown: Boolean
        get() = project.service<PiwiProjectService>().local().coverageMarks
        set(value) {
            project.service<PiwiProjectService>().local().coverageMarks = value
            ApplicationManager.getApplication().invokeLater({ files.keys.forEach(::draw) }, gone)
        }

    /** Ask the coverage of each file opened from now on, and of those open now. */
    fun start() {
        project.messageBus.connect(this).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun fileOpened(source: FileEditorManager, file: VirtualFile) = ask(file)

                override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
                    if (!source.isFileOpen(file)) forget(file)
                }
            },
        )
        askOpen()
    }

    /** Ask the coverage of every open file again: the service started, or its connection changed. */
    fun askOpen() {
        FileEditorManager.getInstance(project).openFiles.forEach(::ask)
    }

    /** Ask a file's coverage off the event thread, and draw the answer. */
    fun ask(file: VirtualFile) {
        if (!PiwiLspServerSupportProvider.isSupported(file)) return
        val uri = runCatching { file.toNioPath().toUri().toString() }.getOrNull() ?: return
        files[uri] = file
        ApplicationManager.getApplication().executeOnPooledThread {
            if (gone.value(null)) return@executeOnPooledThread
            val result = project.service<PiwiProjectService>().server()?.coverage(UriParams(uri))?.orNull()
            if (result != null) arrived(result)
        }
    }

    /** A file's answer, asked or pushed: kept, and drawn on the event thread. Returns its file. */
    fun arrived(result: CoverageResult): VirtualFile? {
        val uri = result.uri ?: return null
        val file = files[uri] ?: return null
        answers[uri] = result
        if (Glue.hasCoverageMarks(result)) known = true
        ApplicationManager.getApplication().invokeLater({ draw(uri) }, gone)
        return file
    }

    private fun forget(file: VirtualFile) {
        val uris = files.filterValues { it == file }.keys
        for (uri in uris) {
            files.remove(uri)
            answers.remove(uri)
            drawn.remove(uri)?.forEach { it.dispose() }
        }
    }

    /** Draw a file's marks again, on the event thread: none while hidden. */
    private fun draw(uri: String) {
        drawn.remove(uri)?.forEach { if (it.isValid) it.dispose() }
        val file = files[uri] ?: return
        val document = FileDocumentManager.getInstance().getCachedDocument(file) ?: return
        val marks = Glue.coverageMarks(answers[uri], document.lineCount, shown)
        if (marks.isEmpty()) return
        val model = DocumentMarkupModel.forDocument(document, project, true)
        drawn[uri] = marks.map { mark ->
            val key = keyOf(mark.kind)
            model.addRangeHighlighter(
                key,
                document.getLineStartOffset(mark.start),
                document.getLineEndOffset(mark.end),
                HighlighterLayer.SELECTION - 1,
                HighlighterTargetArea.LINES_IN_RANGE,
            ).apply {
                lineMarkerRenderer = CoverageGutterMark(key, dashed = mark.kind == Glue.CoverageKind.CHANGED)
                errorStripeTooltip = mark.tooltip
            }
        }
    }

    override fun dispose() {
        disposed = true
        val highlighters = drawn.values.flatten()
        drawn.clear()
        answers.clear()
        files.clear()
        val remove = { highlighters.forEach { if (it.isValid) it.dispose() } }
        if (ApplicationManager.getApplication().isDispatchThread) remove() else ApplicationManager.getApplication().invokeLater { remove() }
    }

    companion object {
        /** The lines tests ran: **Settings → Editor → Color Scheme → Piwi**, its error stripe color the mark's. */
        val RUN: TextAttributesKey = TextAttributesKey.createTextAttributesKey("PIWI_COVERAGE_RUN")

        /** The executable lines no test runs. */
        val NOT_RUN: TextAttributesKey = TextAttributesKey.createTextAttributesKey("PIWI_COVERAGE_NOT_RUN")

        /** The lines changed since the coverage run. */
        val CHANGED: TextAttributesKey = TextAttributesKey.createTextAttributesKey("PIWI_COVERAGE_CHANGED")

        fun keyOf(kind: Glue.CoverageKind): TextAttributesKey = when (kind) {
            Glue.CoverageKind.RUN -> RUN
            Glue.CoverageKind.NOT_RUN -> NOT_RUN
            Glue.CoverageKind.CHANGED -> CHANGED
        }
    }
}

/**
 * A coverage mark at the left of the gutter, in the error stripe color of its key (else its background), so a color
 * scheme restyles it; dashed for the lines changed since the coverage run.
 */
private class CoverageGutterMark(private val key: TextAttributesKey, private val dashed: Boolean) : LineMarkerRendererEx {
    override fun getPosition(): LineMarkerRendererEx.Position = LineMarkerRendererEx.Position.LEFT

    override fun paint(editor: Editor, g: Graphics, r: Rectangle) {
        val attributes = editor.colorsScheme.getAttributes(key) ?: return
        g.color = attributes.errorStripeColor ?: attributes.backgroundColor ?: return
        val width = minOf(r.width, JBUI.scale(3)).coerceAtLeast(1)
        if (!dashed) {
            g.fillRect(r.x, r.y, width, r.height)
            return
        }
        val dash = JBUI.scale(3)
        var y = r.y
        while (y < r.y + r.height) {
            g.fillRect(r.x, y, width, minOf(dash, r.y + r.height - y))
            y += dash * 2
        }
    }
}

/**
 * **Tools → Piwi → Show Coverage Marks**: the marks of the lines the tests ran, shown by default. Hidden from the menu
 * until a file showed marks: a project without coverage shows nothing of it.
 */
class ToggleCoverageMarksAction : ToggleAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun isSelected(e: AnActionEvent): Boolean = e.project?.service<PiwiCoverageMarks>()?.shown ?: false

    override fun setSelected(e: AnActionEvent, state: Boolean) {
        e.project?.service<PiwiCoverageMarks>()?.shown = state
    }

    override fun update(e: AnActionEvent) {
        super.update(e)
        e.presentation.isEnabledAndVisible = e.project?.getServiceIfCreated(PiwiCoverageMarks::class.java)?.known == true
    }
}

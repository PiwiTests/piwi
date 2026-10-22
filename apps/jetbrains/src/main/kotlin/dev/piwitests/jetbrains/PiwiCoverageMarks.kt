package dev.piwitests.jetbrains

import com.intellij.codeInsight.hint.HintManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.impl.DocumentMarkupModel
import com.intellij.openapi.editor.markup.ActiveGutterRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.LineMarkerRendererEx
import com.intellij.openapi.editor.markup.MarkupModel
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Condition
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.util.ui.JBUI
import java.awt.Graphics
import java.awt.Rectangle
import java.awt.event.MouseEvent
import java.util.concurrent.ConcurrentHashMap

/**
 * The coverage the project's tests recorded of the open files (`piwi/coverage`), as marks at the left of the gutter
 * and in the scroll bar: the lines tests ran, the executable lines none runs, and, dashed, the lines changed since the
 * coverage run. They are range highlighters on each file's document, which follow its edits until the service pushes
 * the marks it placed again (`piwi/coverageChanged`); the service's hover names the tests behind a line, and a mark's
 * tooltip, in the gutter and the scroll bar, says what the marks mean. Only the marks a new answer changes are taken
 * off or drawn. A renamed or moved file is asked again under its new URI. A file without line coverage shows none.
 * **Tools → Piwi → Show Coverage Marks** hides them, on this machine only (`PiwiLocalSettings.coverageMarks`), and is
 * offered once a file showed some.
 */
@Service(Service.Level.PROJECT)
class PiwiCoverageMarks(private val project: Project) : Disposable {
    /** Each open file's answer, by the URI it was asked with. */
    private val answers = ConcurrentHashMap<String, CoverageResult>()

    /** The files asked about, by URI: a pushed answer names its file by the URI it was asked with. */
    private val files = ConcurrentHashMap<String, VirtualFile>()

    /** The highlighters drawn on each file, by URI, then by the mark each one draws; on the event thread. */
    private val drawn = HashMap<String, Map<Glue.CoverageMark, RangeHighlighter>>()

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

    /**
     * Ask the coverage of each file opened from now on, and of those open now; a file renamed or moved, itself or with
     * its folder, again under its new URI. A deleted file is forgotten.
     */
    fun start() {
        val connection = project.messageBus.connect(this)
        connection.subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun fileOpened(source: FileEditorManager, file: VirtualFile) = ask(file)

                override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
                    if (!source.isFileOpen(file)) forget(file)
                }
            },
        )
        connection.subscribe(
            VirtualFileManager.VFS_CHANGES,
            object : BulkFileListener {
                override fun after(events: List<VFileEvent>) {
                    val moved = events.mapNotNull { event ->
                        when {
                            event is VFilePropertyChangeEvent && event.propertyName == VirtualFile.PROP_NAME -> event.file
                            event is VFileMoveEvent -> event.file
                            else -> null
                        }
                    }
                    val deleted = events.any { it is VFileDeleteEvent }
                    if ((moved.isEmpty() && !deleted) || files.isEmpty()) return
                    ApplicationManager.getApplication().invokeLater({ follow(moved) }, gone)
                }
            },
        )
        askOpen()
    }

    /**
     * Forget the files deleted and those under `moved`, on the event thread, and ask those still there again: their URI
     * changed.
     */
    private fun follow(moved: List<VirtualFile>) {
        val changed = files.values.filter { file -> !file.isValid || moved.any { VfsUtilCore.isAncestor(it, file, false) } }
        for (file in changed.toSet()) {
            forget(file)
            if (file.isValid) ask(file)
        }
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
            drawn.remove(uri)?.values?.forEach { if (it.isValid) it.dispose() }
        }
    }

    /**
     * Draw a file's marks again, on the event thread: none while hidden. A highlighter is kept while the answer holds
     * its mark at the lines it covers now, after the edits; only the others are taken off or added.
     */
    private fun draw(uri: String) {
        val old = drawn.remove(uri).orEmpty()
        val document = files[uri]?.let { FileDocumentManager.getInstance().getCachedDocument(it) }
        if (document == null) {
            old.values.forEach { if (it.isValid) it.dispose() }
            return
        }
        val current = LinkedHashMap<Glue.CoverageMark, RangeHighlighter>()
        for ((mark, highlighter) in old) {
            if (!highlighter.isValid) continue
            val now = mark.copy(start = document.getLineNumber(highlighter.startOffset), end = document.getLineNumber(highlighter.endOffset))
            if (current.putIfAbsent(now, highlighter) != null) highlighter.dispose()
        }
        val diff = Glue.coverageMarksDiff(current.keys, Glue.coverageMarks(answers[uri], document.lineCount, shown))
        diff.remove.forEach { current.remove(it)?.dispose() }
        if (diff.add.isNotEmpty()) {
            val model = DocumentMarkupModel.forDocument(document, project, true)
            diff.add.forEach { current[it] = highlight(model, document, it) }
        }
        if (current.isNotEmpty()) drawn[uri] = current
    }

    /** A mark's highlighter, with its bar in the gutter and its tooltip. */
    private fun highlight(model: MarkupModel, document: Document, mark: Glue.CoverageMark): RangeHighlighter {
        val key = keyOf(mark.kind)
        return model.addRangeHighlighter(
            key,
            document.getLineStartOffset(mark.start),
            document.getLineEndOffset(mark.end),
            HighlighterLayer.SELECTION - 1,
            HighlighterTargetArea.LINES_IN_RANGE,
        ).apply {
            val tooltip = Glue.coverageMarkTooltip(mark)
            lineMarkerRenderer = CoverageGutterMark(key, dashed = mark.kind == Glue.CoverageKind.CHANGED, tooltip)
            errorStripeTooltip = tooltip
        }
    }

    override fun dispose() {
        disposed = true
        val highlighters = drawn.values.flatMap { it.values }
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
 * scheme restyles it; dashed for the lines changed since the coverage run. Hovered, it shows its tooltip: what it says
 * of its lines and what the marks mean; clicked, the same as a hint.
 */
private class CoverageGutterMark(
    private val key: TextAttributesKey,
    private val dashed: Boolean,
    private val tooltip: String,
) : LineMarkerRendererEx, ActiveGutterRenderer {
    override fun getPosition(): LineMarkerRendererEx.Position = LineMarkerRendererEx.Position.LEFT

    override fun getTooltipText(): String = tooltip

    override fun canDoAction(e: MouseEvent): Boolean = true

    override fun doAction(editor: Editor, e: MouseEvent) {
        HintManager.getInstance().showInformationHint(editor, tooltip)
        e.consume()
    }

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

package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Condition
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import java.awt.Graphics
import java.awt.Rectangle
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.net.URI
import java.nio.file.Path
import javax.swing.DefaultListModel
import javax.swing.JList

/**
 * The CI runs of the branch while they run (`piwi/ciSessionChanged`), read-only: the **CI Runs** tab of the Piwi tool
 * window, added while one runs, and a plain mark after the line each of their running tests is at, a CI position: no
 * gutter icon, no highlight and no control, since nothing waits there. A running test's **Watch** opens its lane in
 * the Worker tab, read-only (`PiwiRunSessions.showCiWorker`). What the tab lists and what a line says come from `Glue`
 * (`ciRows`, `ciMarksIn`, `ciLaneCaption`), tested by `GlueTest`.
 */
@Service(Service.Level.PROJECT)
class PiwiCiRuns(private val project: Project) : Disposable {
    /** The sessions kept, by `Glue.ciKey`; written on the service's thread, read on the event thread. */
    @Volatile var sessions: Map<String, CiSession> = emptyMap()
        private set

    private val lock = Any()
    @Volatile private var disposed = false
    private val gone = Condition<Any?> { disposed || project.isDisposed }

    /** The marks drawn, by editor. On the event thread. */
    private val drawn = HashMap<Editor, MutableList<Inlay<*>>>()
    private val rows = DefaultListModel<Glue.CiRow>()
    private var tab: Content? = null

    /** The runs listed when the person closed the tab: it opens again for another run only. */
    private var closedWith: Set<String> = emptySet()

    init {
        // An editor opened on a file a CI position is in gets its mark.
        EditorFactory.getInstance().addEditorFactoryListener(
            object : EditorFactoryListener {
                override fun editorCreated(event: EditorFactoryEvent) {
                    if (sessions.isNotEmpty()) ApplicationManager.getApplication().invokeLater({ draw() }, gone)
                }

                override fun editorReleased(event: EditorFactoryEvent) {
                    drawn.remove(event.editor)
                }
            },
            this,
        )
    }

    /** A session heard from the service: the tab and the marks drawn again. */
    fun heard(session: CiSession) {
        synchronized(lock) { sessions = Glue.withCiSession(sessions, session) }
        ApplicationManager.getApplication().invokeLater({ draw() }, gone)
    }

    /** The service's process: its end ends the sessions it told. */
    fun watch(service: ProcessHandler) {
        service.addProcessListener(
            object : ProcessListener {
                override fun processTerminated(event: ProcessEvent) {
                    synchronized(lock) { sessions = emptyMap() }
                    ApplicationManager.getApplication().invokeLater({ draw() }, gone)
                }
            },
            this,
        )
    }

    /** The tab and the marks, as the sessions stand. On the event thread. */
    private fun draw() {
        val now = sessions
        drawTab(now)
        drawMarks(now.values)
        project.getServiceIfCreated(PiwiRunSessions::class.java)?.ciChanged(now)
    }

    private fun drawTab(now: Map<String, CiSession>) {
        val window = ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID) ?: return
        val live = tab?.takeIf { window.contentManager.getIndexOfContent(it) >= 0 }
        if (now.isEmpty()) {
            live?.let { window.contentManager.removeContent(it, true) }
            tab = null
            closedWith = emptySet()
            return
        }
        rows.clear()
        Glue.ciRows(now.values).forEach(rows::addElement)
        if (live != null) {
            live.displayName = tabName(now)
            return
        }
        // Closed by the person: it opens again for a run not listed then.
        if (tab != null && now.keys.all { it in closedWith }) return
        val content = ContentFactory.getInstance().createContent(JBScrollPane(list()), tabName(now), false).apply {
            isCloseable = true
            setDisposer {
                if (tab === this) closedWith = sessions.keys
            }
        }
        window.contentManager.addContent(content)
        tab = content
    }

    private fun tabName(now: Map<String, CiSession>): String = if (now.size == 1) "CI Run" else "CI Runs (${now.size})"

    /**
     * The tab's list: a row opens its lane in the Worker tab, its file at its line, or its page on the dashboard, on a
     * double click or Enter.
     */
    private fun list(): JList<Glue.CiRow> {
        val list = JBList(rows)
        list.cellRenderer = CiRowRenderer()
        list.emptyText.text = "No CI run of the branch runs now."
        list.addMouseListener(
            object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (e.clickCount == 2) list.selectedValue?.let(::open)
                }
            },
        )
        list.addKeyListener(
            object : KeyAdapter() {
                override fun keyPressed(e: KeyEvent) {
                    if (e.keyCode == KeyEvent.VK_ENTER) list.selectedValue?.let(::open)
                }
            },
        )
        return list
    }

    private fun open(row: Glue.CiRow) {
        row.lane?.let { return project.service<PiwiRunSessions>().showCiWorker(it) }
        row.url?.let { return BrowserUtil.browse(it) }
        val file = row.uri?.let { fileOf(it) } ?: return
        OpenFileDescriptor(project, file, row.line, row.character).navigate(true)
    }

    private fun fileOf(uri: String) = runCatching { LocalFileSystem.getInstance().findFileByNioFile(Path.of(URI(uri))) }.getOrNull()

    /** Each editor of a file a CI position is in shows its marks; the others' go. On the event thread. */
    private fun drawMarks(now: Collection<CiSession>) {
        for (inlays in drawn.values) inlays.forEach { if (it.isValid) Disposer.dispose(it) }
        drawn.clear()
        for (uri in Glue.ciMarkedFiles(now)) {
            val file = fileOf(uri) ?: continue
            val document = FileDocumentManager.getInstance().getDocument(file) ?: continue
            val marks = Glue.ciMarksIn(now, uri).filter { it.line < document.lineCount }
            for (editor in EditorFactory.getInstance().getEditors(document, project)) {
                drawn[editor] = marks.mapNotNull { mark ->
                    editor.inlayModel.addAfterLineEndElement(document.getLineEndOffset(mark.line), false, CiMarkInlay(mark.text))
                }.toMutableList()
            }
        }
    }

    override fun dispose() {
        disposed = true
        for (inlays in drawn.values) inlays.forEach { if (it.isValid) Disposer.dispose(it) }
        drawn.clear()
    }
}

/** A CI position's words after its line, in the inlay hints' color, italic: no box, no icon, nothing to click. */
internal class CiMarkInlay(val text: String) : EditorCustomElementRenderer {
    private fun font(editor: Editor) = editor.colorsScheme.getFont(EditorFontType.ITALIC)

    private fun gap(editor: Editor) = editor.contentComponent.getFontMetrics(font(editor)).stringWidth("   ")

    override fun calcWidthInPixels(inlay: Inlay<*>): Int =
        gap(inlay.editor) + inlay.editor.contentComponent.getFontMetrics(font(inlay.editor)).stringWidth(text)

    override fun paint(inlay: Inlay<*>, g: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
        val editor = inlay.editor
        g.font = font(editor)
        g.color = editor.colorsScheme.getAttributes(DefaultLanguageHighlighterColors.INLAY_TEXT_WITHOUT_BACKGROUND)?.foregroundColor
            ?: editor.colorsScheme.defaultForeground
        g.drawString(text, targetRegion.x + gap(editor), targetRegion.y + editor.ascent)
    }
}

/** A row of the CI Runs tab: a run in bold, a test with its result's icon, a link in the link color. */
private class CiRowRenderer : ColoredListCellRenderer<Glue.CiRow>() {
    override fun customizeCellRenderer(list: JList<out Glue.CiRow>, value: Glue.CiRow?, index: Int, selected: Boolean, hasFocus: Boolean) {
        value ?: return
        when (value.kind) {
            "run" -> {
                icon = AllIcons.Actions.Execute
                append(value.text, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
            }
            "open", "watch", "ci-watch" -> {
                icon = if (value.kind == "ci-watch") AllIcons.Actions.Preview else AllIcons.Ide.External_link_arrow
                append(value.text, SimpleTextAttributes.LINK_ATTRIBUTES)
            }
            else -> {
                icon = when (value.status) {
                    "running" -> AllIcons.Process.Step_1
                    "failed" -> AllIcons.RunConfigurations.TestError
                    "flaky" -> AllIcons.RunConfigurations.TestFailed
                    "skipped" -> AllIcons.RunConfigurations.TestIgnored
                    else -> AllIcons.RunConfigurations.TestPassed
                }
                append(value.text)
            }
        }
        if (value.detail.isNotEmpty()) append("   ${value.detail}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
        // Rows under a run are indented under its name.
        ipad.left = if (value.kind == "run") 0 else if (value.kind == "watch" || value.kind == "ci-watch") 36 else 18
    }
}

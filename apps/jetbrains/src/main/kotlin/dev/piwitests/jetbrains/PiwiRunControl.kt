package dev.piwitests.jetbrains

import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseListener
import com.intellij.openapi.editor.event.EditorMouseMotionListener
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.impl.DocumentMarkupModel
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Condition
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.ui.JBUI
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.breakpoints.XBreakpoint
import com.intellij.xdebugger.breakpoints.XBreakpointListener
import com.intellij.xdebugger.ui.DebuggerColors
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.Graphics
import java.awt.Rectangle
import java.awt.event.MouseEvent
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.net.URI
import java.nio.file.Path
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.imageio.ImageIO
import javax.swing.ImageIcon
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * The runs the IDE started, as their workers tell them (`piwi/runSessionChanged`), shown and steered with Piwi's own
 * actions, no debug session: the latest session of each run, kept until it ends. A stop opens its file at its line,
 * marked as the execution point (a range highlighter in [EXECUTION_POINT], the debugger's colors by default, with an
 * arrow in the gutter whose click offers the controls), with a block inlay above it saying what is about to run and
 * offering **Resume**, **Step**, **Run to Caret** and **Finish**; a stop no pause bar shows (a headless run's) shows an
 * image of its page in the Piwi tool window's **Paused Page** tab. The IDE's breakpoints go to each live run as they
 * change (`XBreakpointListener`, `piwi/setRunBreakpoints`), filtered as a run's start filters them. **Stop** ends the
 * process of the run, which Piwi started. The pure half is `Glue.withSession`, `Glue.runControls` and their kin.
 */
@Service(Service.Level.PROJECT)
class PiwiRunSessions(private val project: Project) : Disposable {
    private val lock = Any()

    /** The sessions kept, by ref. */
    @Volatile var sessions: Map<String, RunSession> = emptyMap()
        private set

    /** The breakpoints each run has, by ref (`Glue.breakpointUpdates`); under [lock]. */
    private val sent = LinkedHashMap<String, String>()

    /** The process of each run started here, by ref, which Stop ends. */
    private val processes = ConcurrentHashMap<String, ProcessHandler>()

    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    /** The stops whose file was opened at their line, and what is drawn of each, by `Glue.stopKey`; on the event thread. */
    private val revealed = HashSet<String>()
    private val drawn = HashMap<String, DrawnStop>()

    /** The Paused Page tab, and the stop it shows; on the event thread. */
    private var page: Content? = null
    private var pageStop: String? = null

    private val breakpointsQueued = AtomicBoolean()

    @Volatile private var disposed = false

    private val gone = Condition<Any?> { disposed || project.isDisposed }

    /** Where the controls, the breakpoints and the image requests go, off the event thread: the running service. */
    internal var remote: RunRemote = object : RunRemote {
        private fun server() = project.service<PiwiProjectService>().server()

        override fun control(params: RunControlParams) = server()?.runControl(params)?.orNull()

        override fun pausedPage(params: PausedPageParams) = server()?.pausedPage(params)?.orNull()

        override fun setBreakpoints(params: SetRunBreakpointsParams) {
            server()?.setRunBreakpoints(params)
        }
    }

    private class DrawnStop(val highlighter: RangeHighlighter, val inlays: MutableMap<Editor, Inlay<*>> = HashMap()) {
        fun dispose() {
            if (highlighter.isValid) highlighter.dispose()
            inlays.values.forEach { if (it.isValid) Disposer.dispose(it) }
        }
    }

    init {
        project.messageBus.connect(this).subscribe(
            XBreakpointListener.TOPIC,
            object : XBreakpointListener<XBreakpoint<*>> {
                override fun breakpointAdded(breakpoint: XBreakpoint<*>) = breakpointsChanged()

                override fun breakpointRemoved(breakpoint: XBreakpoint<*>) = breakpointsChanged()

                override fun breakpointChanged(breakpoint: XBreakpoint<*>) = breakpointsChanged()
            },
        )
        val editors = EditorFactory.getInstance()
        // An editor opened on a stop's file gets its inlay.
        editors.addEditorFactoryListener(
            object : EditorFactoryListener {
                override fun editorCreated(event: EditorFactoryEvent) {
                    if (drawn.isNotEmpty()) ApplicationManager.getApplication().invokeLater({ draw() }, gone)
                }
            },
            this,
        )
        val mouse = StopInlayMouse()
        editors.eventMulticaster.addEditorMouseListener(mouse, this)
        editors.eventMulticaster.addEditorMouseMotionListener(mouse, this)
    }

    /** Called on the event thread after each change of the sessions. */
    fun onChange(parent: Disposable, listener: () -> Unit) {
        listeners += listener
        Disposer.register(parent) { listeners -= listener }
    }

    fun controls(): Glue.RunControls = Glue.runControls(sessions)

    fun stops(): List<Glue.ShownStop> = Glue.stopsOf(sessions)

    /** A session heard from the service, on any thread: kept, and drawn on the event thread. */
    fun heard(session: RunSession) {
        val ref = session.ref ?: return
        val fresh = synchronized(lock) {
            val fresh = !session.ended && ref !in sessions
            sessions = Glue.withSession(sessions, session)
            if (session.ended) sent.remove(ref)
            fresh
        }
        // The breakpoints changed between the run's start and its first worker.
        if (fresh) breakpointsChanged()
        changed()
    }

    /** A run started with `breakpoints`: they are not sent to it again. */
    fun started(ref: String, breakpoints: List<EditorBreakpoint>) {
        synchronized(lock) { Glue.rememberBreakpoints(sent, ref, breakpoints) }
    }

    /** The process of the run of `ref`, which Stop ends while it runs. */
    fun track(ref: String, process: ProcessHandler) {
        processes[ref] = process
        process.addProcessListener(
            object : ProcessListener {
                override fun processTerminated(event: ProcessEvent) {
                    processes.remove(ref, process)
                }
            },
            this,
        )
    }

    /** The editor service's process: when it ends, its runs' sessions end with it. */
    fun watch(service: ProcessHandler) {
        service.addProcessListener(
            object : ProcessListener {
                override fun processTerminated(event: ProcessEvent) {
                    synchronized(lock) { sessions = emptyMap() }
                    changed()
                }
            },
            this,
        )
    }

    private fun changed() {
        ApplicationManager.getApplication().invokeLater({
            listeners.forEach { it() }
            draw()
        }, gone)
    }

    /** The IDE's breakpoints to each live run whose breakpoints differ, off the event thread, once for a burst. */
    fun breakpointsChanged() {
        if (sessions.isEmpty() || !breakpointsQueued.compareAndSet(false, true)) return
        AppExecutorUtil.getAppScheduledExecutorService().schedule(
            {
                breakpointsQueued.set(false)
                if (gone.value(null)) return@schedule
                val places = project.service<PiwiProjectService>().breakpoints()
                val updates = synchronized(lock) { Glue.breakpointUpdates(sessions, places, sent) }
                updates.forEach { remote.setBreakpoints(it) }
            },
            BREAKPOINTS_WAIT_MILLIS,
            TimeUnit.MILLISECONDS,
        )
    }

    /**
     * Draw each stop: its file opened at its line the first time, its execution point and an inlay in each editor of
     * its file; a stop no pause bar shows, its page in the Paused Page tab. What a stop that went on drew goes. On the
     * event thread.
     */
    private fun draw() {
        val stops = stops()
        val keys = stops.map(Glue::stopKey).toSet()
        for (key in drawn.keys - keys) drawn.remove(key)?.dispose()
        revealed.retainAll(keys)
        for (stop in stops) {
            val key = Glue.stopKey(stop)
            val file = fileOf(stop.stop.uri) ?: continue
            if (revealed.add(key)) {
                OpenFileDescriptor(project, file, stop.stop.line, stop.stop.character ?: 0).navigate(true)
                if (!stop.stop.bar) showPage(stop)
            }
            val document = FileDocumentManager.getInstance().getDocument(file) ?: continue
            if (stop.stop.line < 0 || stop.stop.line >= document.lineCount) continue
            val shown = drawn.getOrPut(key) { DrawnStop(highlight(document, stop)) }
            for (editor in EditorFactory.getInstance().getEditors(document, project)) {
                if (shown.inlays[editor]?.isValid == true) continue
                editor.inlayModel.addBlockElement(document.getLineStartOffset(stop.stop.line), false, true, 0, StopInlay(stop))
                    ?.let { shown.inlays[editor] = it }
            }
        }
        val shownPage = livePage()
        if (shownPage != null && pageStop != null && pageStop !in keys) {
            pageStop = null
            (shownPage.component as PausedPagePanel).show("The test went on.", null)
        }
        if (shownPage != null && pageStop == null && sessions.isEmpty()) (shownPage.component as PausedPagePanel).show("The run ended.", null)
    }

    private fun toolWindow() = ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID)

    /** The Paused Page tab while the tool window holds it: closing it removes it. */
    private fun livePage(): Content? = page?.takeIf { toolWindow()?.contentManager?.getIndexOfContent(it)?.let { i -> i >= 0 } == true }

    private fun fileOf(uri: String?): VirtualFile? =
        runCatching { LocalFileSystem.getInstance().findFileByNioFile(Path.of(URI(uri ?: ""))) }.getOrNull()

    /** A stop's execution point: the line in the debugger's execution point colors, with the arrow in the gutter. */
    private fun highlight(document: Document, stop: Glue.ShownStop): RangeHighlighter =
        DocumentMarkupModel.forDocument(document, project, true).addRangeHighlighter(
            EXECUTION_POINT,
            document.getLineStartOffset(stop.stop.line),
            document.getLineEndOffset(stop.stop.line),
            DebuggerColors.EXECUTION_LINE_HIGHLIGHTERLAYER,
            HighlighterTargetArea.LINES_IN_RANGE,
        ).apply { gutterIconRenderer = ExecutionPointGutter(this@PiwiRunSessions, stop) }

    /** What the execution points, the inlays and the Paused Page tab show now, which the tests read. On the event thread. */
    internal fun shown(): Shown {
        val panel = livePage()?.component as? PausedPagePanel
        return Shown(
            drawn.values.map { it.highlighter }.filter { it.isValid },
            drawn.values.flatMap { it.inlays.values }.filter { it.isValid },
            panel?.caption,
            panel?.image,
        )
    }

    internal data class Shown(
        val highlighters: List<RangeHighlighter>,
        val inlays: List<Inlay<*>>,
        val pageCaption: String?,
        val pageImage: BufferedImage?,
    )

    /** The page of a stop in the Paused Page tab of the Piwi tool window, asked of its worker. On the event thread. */
    fun showPage(stop: Glue.ShownStop) {
        val key = Glue.stopKey(stop)
        pageStop = key
        val window = toolWindow() ?: return
        val content = livePage() ?: ContentFactory.getInstance()
            .createContent(PausedPagePanel(), PAUSED_PAGE, false)
            .apply { isCloseable = true }
            .also {
                window.contentManager.addContent(it)
                page = it
            }
        window.contentManager.setSelectedContent(content)
        window.show(null)
        val panel = content.component as PausedPagePanel
        val caption = "${Glue.pausedText(stop.stop, stop.test)} · ${Glue.stopPlace(stop.stop)}"
        panel.show("$caption · asking the test for its page…", null)
        ApplicationManager.getApplication().executeOnPooledThread {
            val image = remote.pausedPage(PausedPageParams(stop.ref, stop.worker))?.image
            val picture = Glue.pausedImageBytes(image)?.let { runCatching { ImageIO.read(ByteArrayInputStream(it)) }.getOrNull() }
            ApplicationManager.getApplication().invokeLater({
                if (pageStop == key) panel.show(if (picture != null) caption else "$caption · the test sent no image of its page", picture)
            }, gone)
        }
    }

    /** Answer a stop (`resume`, `step`, `finish`, or `run-to` the `place`), off the event thread, saying why not. */
    fun answer(stop: Glue.ShownStop, action: String, place: EditorBreakpoint? = null) {
        control(RunControlParams(stop.ref, stop.worker, action, place))
    }

    /** Pause every run: each of its workers stops before its next call. */
    fun pause() {
        sessions.keys.forEach { control(RunControlParams(it, action = "pause")) }
    }

    private fun control(params: RunControlParams) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = remote.control(params)
            when {
                result == null -> PiwiCommands.notify(project, "The editor service did not answer.", NotificationType.WARNING)
                !result.ok -> PiwiCommands.notify(project, result.message ?: "The run did not take it.")
            }
        }
    }

    /** End the process of the run of `ref`; false when no run of this IDE runs it. */
    fun stopRun(ref: String): Boolean = processes[ref]?.let {
        it.destroyProcess()
        true
    } ?: false

    /** Run `action` on the stop the caret of `editor` is at, else the only one, else the one chosen. On the event thread. */
    fun atCaret(editor: Editor?, action: (Glue.ShownStop) -> Unit) {
        val uri = editor?.virtualFile?.let { fileUri(it) }
        val candidates = Glue.stopsFor(stops(), uri, editor?.caretModel?.logicalPosition?.line)
        if (candidates.size < 2) return candidates.firstOrNull()?.let(action) ?: PiwiCommands.notify(project, "No test is stopped.")
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(candidates)
            .setRenderer(
                object : SimpleListCellRenderer<Glue.ShownStop>() {
                    override fun customize(list: JList<out Glue.ShownStop>, value: Glue.ShownStop?, index: Int, selected: Boolean, hasFocus: Boolean) {
                        text = value?.let(Glue::stopLabel) ?: ""
                    }
                },
            )
            .setTitle("Which Stopped Test?")
            .setItemChosenCallback(action)
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }

    /** Run to the caret's line of `editor` from `stop`. */
    fun runTo(stop: Glue.ShownStop, editor: Editor?) {
        val uri = editor?.virtualFile?.let { fileUri(it) } ?: return PiwiCommands.notify(project, "Place the caret on the line to run to.")
        answer(stop, "run-to", EditorBreakpoint(uri, editor.caretModel.logicalPosition.line))
    }

    /** The actions offered at a stop, which act on it. */
    fun stopActions(stop: Glue.ShownStop): ActionGroup = DefaultActionGroup().apply {
        for (control in Glue.StopControl.entries) {
            add(
                object : DumbAwareAction(control.label, null, CONTROL_ICONS[control]) {
                    override fun getActionUpdateThread() = ActionUpdateThread.BGT

                    override fun actionPerformed(e: AnActionEvent) = perform(stop, control, e.getData(CommonDataKeys.EDITOR))
                },
            )
        }
        add(
            object : DumbAwareAction(SHOW_PAUSED_PAGE, null, AllIcons.Actions.Preview) {
                override fun getActionUpdateThread() = ActionUpdateThread.BGT

                override fun actionPerformed(e: AnActionEvent) = showPage(stop)
            },
        )
    }

    fun perform(stop: Glue.ShownStop, control: Glue.StopControl, editor: Editor?) {
        if (control == Glue.StopControl.RUN_TO_CARET) runTo(stop, editor) else answer(stop, control.action)
    }

    override fun dispose() {
        disposed = true
        listeners.clear()
        processes.clear()
        val shown = drawn.values.toList()
        drawn.clear()
        val remove = { shown.forEach { it.dispose() } }
        if (ApplicationManager.getApplication().isDispatchThread) remove() else ApplicationManager.getApplication().invokeLater { remove() }
    }

    companion object {
        /** The paused line: **Settings → Editor → Color Scheme → Piwi**, the debugger's execution point by default. */
        val EXECUTION_POINT: TextAttributesKey =
            TextAttributesKey.createTextAttributesKey("PIWI_EXECUTION_POINT", DebuggerColors.EXECUTIONPOINT_ATTRIBUTES)

        const val PAUSED_PAGE = "Paused Page"
        const val SHOW_PAUSED_PAGE = "Show the Paused Page"

        /** The pause after a breakpoint changes before the runs are sent them: a burst of changes is sent once. */
        private const val BREAKPOINTS_WAIT_MILLIS = 100L

        val CONTROL_ICONS = mapOf(
            Glue.StopControl.RESUME to AllIcons.Actions.Resume,
            Glue.StopControl.STEP to AllIcons.Actions.TraceOver,
            Glue.StopControl.RUN_TO_CARET to AllIcons.Actions.RunToCursor,
            Glue.StopControl.FINISH to AllIcons.Actions.StepOut,
        )

        fun fileUri(file: VirtualFile): String? =
            if (file.isInLocalFileSystem) runCatching { file.toNioPath().toUri().toString() }.getOrNull() else null
    }
}

/** What a run's controls ask of the editor service. */
internal interface RunRemote {
    fun control(params: RunControlParams): RunControlResult?

    fun pausedPage(params: PausedPageParams): PausedPageResult?

    fun setBreakpoints(params: SetRunBreakpointsParams)
}

/** The page of a stopped test, under what it is about to run: the Paused Page tab of the Piwi tool window. */
private class PausedPagePanel : JPanel(BorderLayout()) {
    private val label = JBLabel().apply { border = JBUI.Borders.empty(4, 8) }
    private val picture = JBLabel().apply {
        horizontalAlignment = SwingConstants.LEFT
        verticalAlignment = SwingConstants.TOP
    }

    var caption: String? = null
        private set
    var image: BufferedImage? = null
        private set

    init {
        add(label, BorderLayout.NORTH)
        add(JBScrollPane(picture), BorderLayout.CENTER)
    }

    fun show(caption: String, image: BufferedImage?) {
        this.caption = caption
        this.image = image
        label.text = caption
        picture.icon = image?.let { ImageIcon(it) }
    }
}

/** The arrow in the gutter at a stop: what is about to run, and on a click the controls, which act on that stop. */
private class ExecutionPointGutter(private val sessions: PiwiRunSessions, private val stop: Glue.ShownStop) : GutterIconRenderer(), DumbAware {
    override fun getIcon() = AllIcons.Debugger.NextStatement

    override fun getTooltipText(): String = Glue.htmlTooltip(Glue.pausedText(stop.stop, stop.test))

    override fun getPopupMenuActions(): ActionGroup = sessions.stopActions(stop)

    override fun getClickAction(): AnAction = object : AnAction() {
        override fun actionPerformed(e: AnActionEvent) {
            val popup = JBPopupFactory.getInstance().createActionGroupPopup(
                Glue.pausedText(stop.stop, stop.test),
                sessions.stopActions(stop),
                e.dataContext,
                JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
                false,
            )
            val mouse = e.inputEvent as? MouseEvent
            if (mouse != null) popup.show(RelativePoint(mouse)) else popup.showInBestPositionFor(e.dataContext)
        }
    }

    override fun equals(other: Any?): Boolean = other is ExecutionPointGutter && Glue.stopKey(other.stop) == Glue.stopKey(stop)

    override fun hashCode(): Int = Glue.stopKey(stop).hashCode()
}

/**
 * The line above a stop, at its indentation: what is about to run, then **Resume**, **Step**, **Run to Caret** and
 * **Finish** as links, which [StopInlayMouse] clicks.
 */
internal class StopInlay(val stop: Glue.ShownStop) : EditorCustomElementRenderer {
    val text = Glue.pausedText(stop.stop, stop.test)

    /** A piece of the line, from `x` in the editor's content: the text, or a control's link. */
    private data class Piece(val x: Int, val width: Int, val text: String, val control: Glue.StopControl?)

    private fun font(editor: Editor) = editor.colorsScheme.getFont(EditorFontType.PLAIN)

    /** The pieces above `line` of the editor's document. */
    private fun pieces(editor: Editor, line: Int): List<Piece> {
        val document = editor.document
        val chars = document.immutableCharSequence
        var first = document.getLineStartOffset(line)
        while (first < document.getLineEndOffset(line) && chars[first].isWhitespace()) first++
        val metrics = editor.contentComponent.getFontMetrics(font(editor))
        val gap = metrics.stringWidth("   ")
        var x = editor.offsetToXY(first).x
        return buildList {
            add(Piece(x, metrics.stringWidth(text), text, null))
            x += metrics.stringWidth(text)
            for (control in Glue.StopControl.entries) {
                x += gap
                add(Piece(x, metrics.stringWidth(control.label), control.label, control))
                x += metrics.stringWidth(control.label)
            }
        }
    }

    /** The pieces of the inlay, above the line it stands on. */
    private fun pieces(inlay: Inlay<*>): List<Piece> = pieces(inlay.editor, inlay.editor.document.getLineNumber(inlay.offset))

    /** The control whose link is at `x` of the editor's content; null elsewhere. */
    fun controlAt(inlay: Inlay<*>, x: Int): Glue.StopControl? =
        pieces(inlay).firstOrNull { it.control != null && x >= it.x && x < it.x + it.width }?.control

    /** Measured above the stop's line: the inlay asks it before it has an offset. */
    override fun calcWidthInPixels(inlay: Inlay<*>): Int {
        val lines = inlay.editor.document.lineCount
        return pieces(inlay.editor, stop.stop.line.coerceIn(0, maxOf(lines - 1, 0))).last().let { it.x + it.width }
    }

    override fun paint(inlay: Inlay<*>, g: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
        val editor = inlay.editor
        val hint = editor.colorsScheme.getAttributes(DefaultLanguageHighlighterColors.INLAY_TEXT_WITHOUT_BACKGROUND)?.foregroundColor
            ?: editor.colorsScheme.defaultForeground
        g.font = font(editor)
        val baseline = targetRegion.y + editor.ascent
        for (piece in pieces(inlay)) {
            g.color = if (piece.control == null) hint else JBUI.CurrentTheme.Link.Foreground.ENABLED
            g.drawString(piece.text, piece.x, baseline)
        }
    }

    override fun getContextMenuGroup(inlay: Inlay<*>): ActionGroup? =
        inlay.editor.project?.getServiceIfCreated(PiwiRunSessions::class.java)?.stopActions(stop)
}

/** A click on a control of a stop's inlay runs it; the pointer is a hand over one. */
private class StopInlayMouse : EditorMouseListener, EditorMouseMotionListener {
    /** The editors whose pointer is over a control now. */
    private val hovering = WeakHashMap<Editor, Boolean>()

    private fun controlAt(event: EditorMouseEvent): Pair<StopInlay, Glue.StopControl>? {
        val inlay = event.inlay ?: return null
        val renderer = inlay.renderer as? StopInlay ?: return null
        return renderer.controlAt(inlay, event.mouseEvent.x)?.let { renderer to it }
    }

    override fun mouseClicked(event: EditorMouseEvent) {
        val (renderer, control) = controlAt(event) ?: return
        val sessions = event.editor.project?.getServiceIfCreated(PiwiRunSessions::class.java) ?: return
        event.consume()
        sessions.perform(renderer.stop, control, event.editor)
    }

    override fun mouseMoved(event: EditorMouseEvent) {
        val editor = event.editor as? EditorEx ?: return
        val over = controlAt(event) != null
        if ((hovering[editor] ?: false) == over) return
        hovering[editor] = over
        editor.setCustomCursor(StopInlayMouse::class.java, if (over) Cursor.getPredefinedCursor(Cursor.HAND_CURSOR) else null)
    }
}

/**
 * A run control: enabled only while it applies, and, from a key the debugger binds too, only while no debug session
 * runs, so the debugger keeps its keys.
 */
abstract class RunControlAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    abstract fun applies(controls: Glue.RunControls, e: AnActionEvent): Boolean

    override fun update(e: AnActionEvent) {
        val project = e.project
        val controls = project?.getServiceIfCreated(PiwiRunSessions::class.java)?.controls()
        val debugging = e.place == ActionPlaces.KEYBOARD_SHORTCUT && project != null &&
            XDebuggerManager.getInstance(project).currentSession != null
        e.presentation.isEnabled = controls != null && !debugging && applies(controls, e)
    }

    protected fun sessions(e: AnActionEvent): PiwiRunSessions? = e.project?.getServiceIfCreated(PiwiRunSessions::class.java)
}

/** **Pause the Run**: every worker of the runs started here stops before its next call. F9 resumes while one is stopped. */
class PauseRunAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) =
        controls.pausable && !(e.place == ActionPlaces.KEYBOARD_SHORTCUT && controls.stopped)

    override fun actionPerformed(e: AnActionEvent) {
        sessions(e)?.pause()
    }
}

/** **Stop the Run**: ends the process of the run started here, the only one or the one chosen. */
class StopRunAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.active

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val sessions = sessions(e) ?: return
        val stop = { ref: String ->
            if (!sessions.stopRun(ref)) PiwiCommands.notify(project, "The run was not started from this IDE: stop it where it runs.")
        }
        val live = sessions.sessions.values.toList()
        if (live.size < 2) return live.firstOrNull()?.ref?.let(stop) ?: Unit
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(live)
            .setRenderer(
                object : SimpleListCellRenderer<RunSession>() {
                    override fun customize(list: JList<out RunSession>, value: RunSession?, index: Int, selected: Boolean, hasFocus: Boolean) {
                        text = value?.workers.orEmpty().mapNotNull { it.test?.title?.joinToString(" › ") }.joinToString(", ")
                            .ifEmpty { value?.ref.orEmpty() }
                    }
                },
            )
            .setTitle("Stop Which Run?")
            .setItemChosenCallback { session -> session.ref?.let(stop) }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }
}

/** A control answering a stop: the one at the caret's line, else the only one, else the one chosen. */
abstract class StopControlAction(private val control: Glue.StopControl) : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) =
        controls.stopped && (control != Glue.StopControl.RUN_TO_CARET || e.getData(CommonDataKeys.EDITOR) != null)

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        val sessions = sessions(e) ?: return
        sessions.atCaret(editor) { sessions.perform(it, control, editor) }
    }
}

/** **Resume**: the stopped test runs on to the next breakpoint. */
class ResumeRunAction : StopControlAction(Glue.StopControl.RESUME)

/** **Step**: the stopped test stops again before its next call. */
class StepRunAction : StopControlAction(Glue.StopControl.STEP)

/** **Run to Caret**: the stopped test stops at the first call on the caret's line, or at a breakpoint before it. */
class RunToCaretAction : StopControlAction(Glue.StopControl.RUN_TO_CARET)

/** **Finish**: the stopped test runs on without stopping at a breakpoint again in this attempt. */
class FinishRunAction : StopControlAction(Glue.StopControl.FINISH)

/** **Show the Paused Page**: the page of the stopped test, in the Piwi tool window. */
class ShowPausedPageAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.stopped

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        sessions.atCaret(e.getData(CommonDataKeys.EDITOR)) { sessions.showPage(it) }
    }
}

package dev.piwitests.jetbrains

import com.intellij.execution.ExecutionListener
import com.intellij.execution.ExecutionManager
import com.intellij.execution.configurations.RunProfile
import com.intellij.execution.configurations.WrappingRunConfiguration
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionPromoter
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.CustomShortcutSet
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.KeyboardShortcut
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.ReadOnlyModificationException
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
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
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.MessageDialogBuilder
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Condition
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.OnePixelSplitter
import com.intellij.ui.SearchTextField
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.util.Alarm
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.breakpoints.XBreakpoint
import com.intellij.xdebugger.breakpoints.XBreakpointListener
import com.intellij.xdebugger.ui.DebuggerColors
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Rectangle
import java.awt.RenderingHints
import java.awt.datatransfer.StringSelection
import java.awt.event.FocusAdapter
import java.awt.event.FocusEvent
import java.awt.event.InputEvent
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.event.MouseMotionAdapter
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.net.URI
import java.nio.file.Path
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.imageio.ImageIO
import javax.imageio.ImageReader
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.ImageIcon
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JViewport
import javax.swing.KeyStroke
import javax.swing.ScrollPaneConstants
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.text.DefaultHighlighter

/**
 * The runs the IDE started, as their workers tell them (`piwi/runSessionChanged`), shown and steered with Piwi's own
 * actions, no debug session: the latest session of each run, kept until it ends. A stop opens its file at its line,
 * marked as the execution point (a range highlighter in [EXECUTION_POINT], the debugger's colors by default, with an
 * arrow in the gutter, a failure's icon at a failure, whose click offers the controls), with a block inlay above it
 * saying what is about to run, or how the test failed, and offering **Resume**, **Step**, **Run to caret** and
 * **Finish**, then the code actions its worker takes there (`piwi/stopAction`: **Pick a locator**, **Record here**,
 * **Assert**, **Assert a region**, **Mock a request**); a stop no pause bar shows (a headless run's) shows an image of
 * its page in the Piwi tool window's **Paused page** tab, where a click picks the element under it (`piwi/pickAt`)
 * when its worker takes it. The code a stop makes (`piwi/stopCode`) is written in one
 * command in its document, in an editor, so the service hears it; while a test is stopped, the end of the caret's line
 * in its file says how many elements the locator there matches on the stopped page (`piwi/locatorAtCaret`). The IDE's
 * breakpoints go to each live run as they change (`XBreakpointListener`, `piwi/setRunBreakpoints`), filtered as a
 * run's start filters them. A run's lines are those of the documents as they stood when it started: the edits since
 * (`Glue.EditLog`) bring a stop to the line it stands on now, and a breakpoint or the caret's line back to the run's.
 * **Stop** ends the process of the run, which Piwi started, in the console or the IDE's Playwright runner, whose reruns
 * and debug runs it follows too. **Share the run live** shares a run on the team instance its reporter reports to
 * (`piwi/shareRun`), after a warning the first time in the project, and **Stop sharing the run live** ends it;
 * the status bar says how a shared run stands. The pure half is `Glue.withSession`, `Glue.runControls` and their kin.
 */
@Service(Service.Level.PROJECT)
class PiwiRunSessions(private val project: Project) : Disposable {
    private val lock = Any()

    /** The sessions kept, by ref. */
    @Volatile var sessions: Map<String, RunSession> = emptyMap()
        private set

    /**
     * What each run was given of the breakpoints, and where its lines are mapped from, by ref
     * (`Glue.breakpointUpdates`); under [lock].
     */
    private val runs = LinkedHashMap<String, Glue.RunBreakpoints>()

    /** When each run started here that no worker connected for yet, by ref; under [lock]. */
    private val starting = HashMap<String, Long>()

    /** The documents' edits while a run is live or starting; under [lock]. */
    private val edits = Glue.EditLog()

    /** The process of each run started here, by ref, which Stop ends. */
    private val processes = ConcurrentHashMap<String, ProcessHandler>()

    /** The IDE's Playwright run configurations Piwi made, by the ref their environment carries. */
    private val runnerRefs: MutableMap<RunProfile, String> = Collections.synchronizedMap(WeakHashMap())

    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    /**
     * What the IDE shows of the stops (`Glue.StopsShown`), the stops whose file opens once found, in order, and what is
     * drawn of each, by `Glue.stopKey`; the files of stops refreshed from disk once, by URI. On the event thread.
     */
    private val shownStops = Glue.StopsShown()
    private val unopened = LinkedHashSet<String>()
    private val drawn = HashMap<String, DrawnStop>()
    private val refreshed = HashSet<String>()

    /** The Paused page tab, and the stop it shows; on the event thread. */
    private var page: Content? = null
    private var pageStop: String? = null
    /** The Paused page tab's caption of its stop as last drawn (`Glue.stopCaption`), which a note may follow. */
    private var pageCaption = ""
    /** The worker slot of the stop the Paused page tab showed last (a run's ref, a parallel index), which Interact is for. */
    private var pageSlot: Pair<String, Int>? = null
    @Volatile private var watchingPage: PageViewParams? = null

    /** When a control from the IDE last answered a stop: Resume's key stays Piwi's `Glue.RESUMED_MILLIS` after. */
    @Volatile private var answeredAt = 0L

    /** A control answered a stop less than `Glue.RESUMED_MILLIS` ago, while a run is live. */
    fun answeredLately(now: Long = System.currentTimeMillis()): Boolean =
        sessions.isNotEmpty() && now - answeredAt < Glue.RESUMED_MILLIS
    /** The watch the service accepted: Interact is offered only then. On the event thread. */
    private var acceptedPage: PageViewParams? = null
    /** The Worker tab's watches, each sent once the one before was answered. */
    private var laneCalls = CompletableFuture.completedFuture(Unit)
    private val pendingPageFrame = AtomicReference<PageFrame?>(null)
    private val drawingPageFrame = AtomicBoolean(false)
    /**
     * What the Paused page tab sends next, in order: the events for its page (`PageInput`) and the stops Interact gives
     * back (`Glue.ShownStop`), each once the events queued before it were sent and answered. On the event thread.
     */
    private val pageInputs = ArrayDeque<Any>()
    /** A send of the queue waits for its alarm or for its answer: what comes meanwhile waits behind it. */
    private var pageInputBusy = false
    /** The keys and buttons held are let go, after the events queued and before a stop given back after them. */
    private var pageRelease = false
    private val pageInputAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    /**
     * The Paused page tab's calls, each sent once the one before was answered: its watches, its input and the stops it
     * gives back.
     */
    private var pageCalls = CompletableFuture.completedFuture(Unit)

    /**
     * Whether a tab of the Piwi tool window is in sight: the Paused page, where it watches its stop's page, and the
     * Worker and Page tabs, which keep the slot's watch. The tests replace it, their tool window out of sight.
     */
    internal var inSight: (JComponent) -> Boolean = { it.isShowing }

    /** Draws again once the Paused page tab stops waiting for a slot's next stop (`Glue.StopsShown.waitsUntil`). */
    private val waitAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)

    /** The Worker tab, and the slot it watches (a run's ref, a parallel index); on the event thread. */
    private var workerTab: Content? = null
    private var laneTarget: Pair<String, Int>? = null
    @Volatile private var watchingLane: LaneViewParams? = null
    /**
     * The slots (a run's ref and a lane) whose Open the trace so far waits for the service's answer: that slot's button
     * is off meanwhile, another's takes a press. On the event thread.
     */
    private val traceAsking = mutableSetOf<Pair<String, Int>>()
    private val pendingLaneFrame = AtomicReference<LaneFrame?>(null)
    private val drawingLaneFrame = AtomicBoolean(false)
    /** The CI run's lane the Worker tab shows in place of a slot (on the event thread), and its watch. */
    private var ciTarget: Glue.CiLane? = null
    @Volatile private var watchingCi: CiWatchParams? = null
    /** The Worker tab's watch the service accepted, of a slot or a CI lane: a change of its layers goes on it then. */
    @Volatile private var acceptedLane: Any? = null
    /** The layers the Worker tab's watch asked last: selecting Text or Filmstrip asks again when they differ. */
    @Volatile private var layersSent: List<String> = emptyList()
    private val pendingCiFrame = AtomicReference<CiFrame?>(null)
    private val drawingCiFrame = AtomicBoolean(false)
    /** The layers of the Worker tab's lane heard and not handed to it yet, in the order they came. */
    private val pendingLayers = ConcurrentLinkedQueue<Pair<LaneLayerFields, () -> Boolean>>()
    private val drawingLayers = AtomicBoolean(false)

    /** The call each watched slot's running test is in, by run and slot (`Glue.withRunningLine`); under [lock]. */
    private var runningLines: Map<Pair<String, Int>, RunningLine> = emptyMap()
    /** What is drawn of each running line, by run and slot. On the event thread. */
    private val drawnRunning = HashMap<Pair<String, Int>, DrawnRunning>()

    /** What the Page tab writes of the watched slot (`Glue.PageOutput`); under its own lock. */
    private val pageOutput = Glue.PageOutput()
    /** The Page tab and its console while the tool window holds it. On the event thread. */
    private var pageTab: Content? = null
    private var pageConsole: ConsoleView? = null
    /** The person closed the Page tab: it stays closed until the next run begins. */
    @Volatile private var pageClosed = false

    private val breakpointsQueued = AtomicBoolean()

    /** The IDE's breakpoints as the service last heard them (`piwi/setBreakpoints`), as text; under [lock]. */
    private var editorBreakpointsSent = ""

    @Volatile private var disposed = false

    private val gone = Condition<Any?> { disposed || project.isDisposed }

    /** Where the controls, the breakpoints and the image requests go, off the event thread: the running service. */
    internal var remote: RunRemote = object : RunRemote {
        private fun server() = project.service<PiwiProjectService>().server()

        /** The running service, for a request that may outlive the plugin (a tab's disposer): none once it is gone. */
        private fun existingServer() =
            if (project.isDisposed) null else project.getServiceIfCreated(PiwiProjectService::class.java)?.server()

        /** A control no service runs to take is refused here (`ok: false`): nothing sent it. */
        override fun control(params: RunControlParams): RunControlResult? {
            val server = server() ?: return RunControlResult(false, NOT_RUNNING)
            return server.runControl(params).orNull()
        }

        override fun shareRun(params: ShareRunParams) = server()?.shareRun(params)?.orNull()

        override fun answerAsk(params: AnswerAskParams) = server()?.answerAsk(params)?.orNull()

        override fun holdRun(params: HoldRunParams) = server()?.holdRun(params)?.orNull()

        override fun pausedPage(params: PausedPageParams) = server()?.pausedPage(params)?.orNull()

        override fun pageView(params: PageViewParams) = existingServer()?.pageView(params)?.orNull()

        override fun pageInput(params: PageInputParams) = server()?.pageInput(params)?.orNull()

        override fun driveStop(params: DriveStopParams) = existingServer()?.driveStop(params)?.orNull()

        override fun laneView(params: LaneViewParams) = existingServer()?.laneView(params)?.orNull()

        override fun ciWatch(params: CiWatchParams) = existingServer()?.ciWatch(params)?.orNull()

        override fun openTrace(params: OpenTraceParams) = server()?.openTrace(params)?.orNull()

        override fun pickAt(params: PickAtParams) = server()?.pickAt(params)?.orNull()

        override fun action(params: StopActionParams) = server()?.stopAction(params)?.orNull()

        override fun requests(params: StopRequestsParams) = server()?.stopRequests(params)?.orNull()

        override fun bind(params: StopBindParams) = server()?.stopBind(params)?.orNull()

        override fun locatorAtCaret(params: LocatorAtCaretParams) = server()?.locatorAtCaret(params)?.orNull()

        override fun documentVersion(document: Document): Int? =
            LspServerManager.getInstance(project).getServersForProvider(PiwiLspServerSupportProvider::class.java)
                .firstOrNull()?.getDocumentVersion(document)

        override fun setBreakpoints(params: SetRunBreakpointsParams) {
            server()?.setRunBreakpoints(params)
        }

        override fun setEditorBreakpoints(params: SetBreakpointsParams): Boolean {
            val server = server() ?: return false
            server.setBreakpoints(params)
            return true
        }

        override fun commandEnded(params: CommandEndedParams) {
            // The run may end after the plugin was unloaded: its service is then gone.
            existingServer()?.commandEnded(params)
        }
    }

    /** Share live said what it sends in this project since it opened: it asks no more. */
    @Volatile internal var liveWarned = false

    /** This project's runs are shared live, as the service says (`piwi/shareWindowChanged`). */
    @Volatile internal var windowShared = false

    /** The person said yes to what sharing the project's runs sends, once since the project opened. */
    @Volatile internal var windowWarned = false

    /** How Mock a request has the response to mock chosen among those a stop lists: a popup, which the tests replace. */
    internal var chooseRequest: (List<StopRequest>, (StopRequest) -> Unit) -> Unit = { requests, chosen ->
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(requests)
            .setRenderer(RequestRenderer())
            .setNamerForFiltering { it.url.orEmpty() }
            .setTitle("Mock which response?")
            .setItemChosenCallback(chosen)
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }

    /** The count at the caret: its questions, its wait, the inlay at the end of the caret's line and the query it is for. */
    private val caretAsks = Glue.CaretAsks()
    private val caretAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)

    /** Asks, on the event thread, whether the service has a document the code of a stop opened. */
    private val openAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private val caretFade = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private var caretInlay: Inlay<*>? = null
    private var caretQuery: CaretQuery? = null

    /** The stop the count asked about last: the caret leaving its file takes the page's outline down. */
    private var counted: Glue.ShownStop? = null

    /** A question of the count at the caret: the stop and line it asks about, its key, and the editor it shows in. */
    private class CaretQuery(val params: LocatorAtCaretParams, val key: String, val editor: Editor?)

    private class DrawnStop(val highlighter: RangeHighlighter, val inlays: MutableMap<Editor, Inlay<*>> = HashMap()) {
        fun dispose() {
            if (highlighter.isValid) highlighter.dispose()
            inlays.values.forEach { if (it.isValid) Disposer.dispose(it) }
        }
    }

    /** A running line as drawn: its file, its line now, its text, and its inlay in each editor of the file. */
    private class DrawnRunning(val uri: String, val line: Int, val text: String, val inlays: MutableMap<Editor, Inlay<*>> = HashMap()) {
        fun dispose() {
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
        // An editor opened on a stop's or a running line's file gets its inlay; a released editor is let go of.
        editors.addEditorFactoryListener(
            object : EditorFactoryListener {
                override fun editorCreated(event: EditorFactoryEvent) {
                    val running = synchronized(lock) { runningLines.isNotEmpty() }
                    if (drawn.isNotEmpty() || running) ApplicationManager.getApplication().invokeLater({ draw() }, gone)
                }

                override fun editorReleased(event: EditorFactoryEvent) {
                    drawn.values.forEach { it.inlays.remove(event.editor) }
                    drawnRunning.values.forEach { it.inlays.remove(event.editor) }
                }
            },
            this,
        )
        val mouse = StopInlayMouse(project)
        editors.eventMulticaster.addEditorMouseListener(mouse, this)
        editors.eventMulticaster.addEditorMouseMotionListener(mouse, this)
        editors.eventMulticaster.addDocumentListener(EditsListener(), this)
        editors.eventMulticaster.addCaretListener(
            object : CaretListener {
                override fun caretPositionChanged(event: CaretEvent) {
                    if (event.editor.project == project && sessions.isNotEmpty()) caretMoved(event.editor)
                }
            },
            this,
        )
        project.messageBus.connect(this).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    if (sessions.isNotEmpty() || caretAsks.wanted != null) caretMoved(FileEditorManager.getInstance(project).selectedTextEditor)
                }
            },
        )
        // The IDE's Playwright runner starts a configuration Piwi made again on Rerun, Rerun Failed Tests and Debug.
        project.messageBus.connect(this).subscribe(
            ExecutionManager.EXECUTION_TOPIC,
            object : ExecutionListener {
                override fun processStarted(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) {
                    runnerRef(env)?.let { track(it, handler) }
                }

                override fun processTerminated(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler, exitCode: Int) {
                    val ref = runnerRef(env) ?: return
                    ApplicationManager.getApplication().executeOnPooledThread { remote.commandEnded(CommandEndedParams(ref, exitCode)) }
                }
            },
        )
    }

    /** The ref of a run of a configuration Piwi made, its Rerun Failed Tests' wrapping it; null for any other run. */
    private fun runnerRef(env: ExecutionEnvironment): String? {
        val profile = env.runProfile
        return runnerRefs[profile]
            ?: (profile as? WrappingRunConfiguration<*>)?.peer?.let { runnerRefs[it] }
            ?: env.runnerAndConfigurationSettings?.configuration?.let { runnerRefs[it] }
    }

    /** A configuration of the IDE's Playwright runner made for the run of `ref`: each of its runs is followed. */
    fun followRunner(configuration: RunProfile, ref: String) {
        runnerRefs[configuration] = ref
    }

    /**
     * Each document edit that moves lines, while a run is live or starting: the text around the change is read before
     * it (where it starts and ends) and after it (what stayed on its first and last lines).
     */
    private inner class EditsListener : DocumentListener {
        private var before: Triple<Int, Int, Int>? = null

        override fun beforeDocumentChange(event: DocumentEvent) {
            before = if (!tracking()) null else event.document.let { d ->
                val line = d.getLineNumber(event.offset)
                Triple(line, event.offset - d.getLineStartOffset(line), d.getLineNumber(event.offset + event.oldLength))
            }
        }

        override fun documentChanged(event: DocumentEvent) {
            val (line, column, endLine) = before ?: return
            before = null
            val document = event.document
            val file = FileDocumentManager.getInstance().getFile(document)?.let { fileUri(it) } ?: return
            val edit = Glue.lineEdit(line, column, endLine, event.newFragment) { at ->
                if (at < document.lineCount) document.getText(TextRange(document.getLineStartOffset(at), document.getLineEndOffset(at))) else null
            } ?: return
            synchronized(lock) { edits.add(Glue.fileKey(file) ?: return, edit) }
        }
    }

    /** Whether a run is live, or was started here moments ago: its lines map through the edits from then on. */
    private fun tracking(): Boolean {
        if (sessions.isNotEmpty()) return true
        val now = System.currentTimeMillis()
        return synchronized(lock) { starting.values.any { now - it < STARTING_MILLIS } }
    }

    /** Where the edits are mapped from for a run: its start, else when it was first heard. Under [lock]. */
    private fun sinceOf(ref: String): Int = runs[ref]?.since ?: edits.now()

    /** The edits no live or starting run maps through go. Under [lock]. */
    private fun forgetEdits() {
        val now = System.currentTimeMillis()
        starting.values.removeAll { now - it >= STARTING_MILLIS }
        edits.forget(runs.filterKeys { it in sessions || it in starting }.values.minOfOrNull { it.since } ?: Int.MAX_VALUE)
    }

    /** Called on the event thread after each change of the sessions. */
    fun onChange(parent: Disposable, listener: () -> Unit) {
        listeners += listener
        Disposer.register(parent) { listeners -= listener }
    }

    fun controls(): Glue.RunControls = Glue.runControls(sessions)

    /** Every stop, at the line it stands on in its document now. */
    fun stops(): List<Glue.ShownStop> = synchronized(lock) {
        Glue.stopsOf(sessions).map { s ->
            s.copy(stop = s.stop.copy(line = edits.forward(Glue.fileKey(s.stop.uri), s.stop.line, sinceOf(s.ref))))
        }
    }

    /** A session heard from the service, on any thread: kept, and drawn on the event thread. */
    fun heard(session: RunSession) {
        val ref = session.ref ?: return
        val fresh = synchronized(lock) {
            val fresh = !session.ended && ref !in sessions
            starting.remove(ref)
            // A run not started here maps its lines from when it is first heard.
            if (fresh && ref !in runs) Glue.remember(runs, ref, Glue.runStarted(edits.now(), null))
            sessions = Glue.withSession(sessions, session)
            if (session.ended) {
                runs.remove(ref)
                forgetEdits()
            }
            fresh
        }
        if (fresh) {
            // A new run writes in the Page tab again, the person having closed it or not.
            pageClosed = false
            // The breakpoints changed between the run's start and its first worker.
            breakpointsChanged()
        }
        // Before the draws that follow, so a rerun under the ref starts with Interact off.
        if (session.ended) ApplicationManager.getApplication().invokeLater({ runGone(ref) }, gone)
        changed()
    }

    /** A run started with `breakpoints`: they are not sent to it again, and its lines are the documents' now. */
    fun started(ref: String, breakpoints: List<Glue.RunBreakpoint>) {
        synchronized(lock) {
            Glue.remember(runs, ref, Glue.runStarted(edits.now(), breakpoints))
            starting[ref] = System.currentTimeMillis()
        }
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
                    synchronized(lock) {
                        sessions = emptyMap()
                        // A service started again holds none of the IDE's breakpoints.
                        editorBreakpointsSent = ""
                        forgetEdits()
                    }
                    ApplicationManager.getApplication().invokeLater({ runGone(null) }, gone)
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
            caretMoved(FileEditorManager.getInstance(project).selectedTextEditor)
        }, gone)
    }

    /**
     * The IDE's breakpoints to each live run whose breakpoints differ, and to the service as they stand, for a run a
     * terminal starts (`piwi/setBreakpoints`), off the event thread, once for a burst.
     */
    fun breakpointsChanged() {
        if (!breakpointsQueued.compareAndSet(false, true)) return
        AppExecutorUtil.getAppScheduledExecutorService().schedule(
            {
                breakpointsQueued.set(false)
                if (gone.value(null)) return@schedule
                val breakpoints = project.service<PiwiProjectService>().breakpoints()
                val places = breakpoints.map { it.place }
                val text = places.joinToString("\n") { "${it.uri} ${it.line}" }
                val (updates, fresh) = synchronized(lock) {
                    Glue.breakpointUpdates(sessions, breakpoints, runs, edits) to (text != editorBreakpointsSent)
                }
                updates.forEach { remote.setBreakpoints(it) }
                // Kept as sent only once a service heard them: one that starts later hears them then.
                if (fresh && remote.setEditorBreakpoints(SetBreakpointsParams(places))) {
                    synchronized(lock) { editorBreakpointsSent = text }
                }
            },
            BREAKPOINTS_WAIT_MILLIS,
            TimeUnit.MILLISECONDS,
        )
    }

    /**
     * Draw each stop at the line it stands on now: a new stop's file opened at its line once found, with the focus as
     * `Glue.StopsShown` decides then (`reveal`), its execution point and an inlay in each editor of its file; the page
     * `Glue.StopsShown` gives in the Paused page tab, whether its file is found or not, the tab selected unless the
     * Worker tab is, its caption saying who drives the stop and who watches its page as they change. A file the IDE has
     * not read yet is looked for on disk off the event thread, then drawn. What a stop that went on drew goes. On the
     * event thread.
     */
    private fun draw() {
        val stops = stops()
        val keys = stops.map(Glue::stopKey).toSet()
        for (key in drawn.keys - keys) drawn.remove(key)?.dispose()
        unopened.retainAll(keys)
        refreshed.retainAll(stops.mapNotNull { it.stop.uri }.toSet())
        val shownPage = livePage()
        if (shownPage == null) shownStops.view(null)
        val show = shownStops.changed(sessions, stops)
        wakeWhenWaited()
        show.open.forEach { unopened.add(Glue.stopKey(it)) }
        val byKey = stops.associateBy(Glue::stopKey)
        for (key in unopened.toList()) {
            val stop = byKey[key] ?: continue
            val file = fileOf(stop.stop.uri) ?: continue
            unopened.remove(key)
            val focus = shownStops.focusFor(stop)
            shownStops.opened(stop, focus, reveal(stop, file, focus))
        }
        for (stop in stops) {
            val key = Glue.stopKey(stop)
            val file = fileOf(stop.stop.uri)
            if (file == null) {
                refresh(stop.stop.uri)
                continue
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
        if (show.page != null) {
            showPage(show.page, select = selectsPage())
        } else if (shownPage != null && pageStop != null && pageStop !in keys) {
            stopPageView()
            pageStop = null
            (shownPage.component as PausedPagePanel).ended("The test went on.")
        } else if (shownPage != null && pageStop != null) {
            // Who drives the stop and who watches its page, as they change, and whether an action runs in its window.
            val panel = shownPage.component as PausedPagePanel
            panel.acting = byKey[pageStop]?.stop?.acting != null
            val caption = byKey[pageStop]?.let { Glue.stopCaption(it, sessions) } ?: pageCaption
            val shown = panel.caption
            if (caption != pageCaption && shown != null && shown.startsWith(pageCaption)) {
                panel.caption(caption + shown.removePrefix(pageCaption))
                pageCaption = caption
            }
        }
        if (shownPage != null && pageStop == null && sessions.isEmpty()) (shownPage.component as PausedPagePanel).ended("The run ended.")
        val worker = liveWorkerTab()?.component as? PausedPagePanel
        val target = laneTarget
        if (worker != null && target != null) {
            val lane = Glue.laneShown(sessions[target.first], target.second, stops)
            worker.caption(lane.caption)
            worker.layers?.note(Glue.laneLayersNote(lane.worker))
            worker.traceable(Glue.canOpenTrace(lane.worker), target in traceAsking)
            // The service ends the view with the run, and Watch is off for the next.
            if (sessions[target.first] == null && (watchingLane != null || worker.liveWanted)) {
                watchingLane = null
                pendingLaneFrame.set(null)
                worker.watching(false)
                worker.liveWanted = false
            }
        }
        drawRunning()
    }

    /**
     * The call a watched slot's running test is in, or none (`piwi/runningLine`): kept while the Worker tab watches that
     * slot, and drawn on the event thread. [stopLaneView] drops it under [lock] once the watch ends.
     */
    fun runningLine(line: RunningLine) {
        synchronized(lock) {
            val own = watchingLane
            if (line.call != null && (own == null || own.ref != line.ref || own.lane != line.lane)) return
            runningLines = Glue.withRunningLine(runningLines, line)
        }
        ApplicationManager.getApplication().invokeLater({ drawRunning() }, gone)
    }

    /**
     * Mark each running line (`Glue.runningLinesShown`) at the line it stands on now with an inlay after it in each
     * editor of its file, naming the worker and the call; a line whose test ended or stopped, or whose run ended,
     * goes. On the event thread.
     */
    private fun drawRunning() {
        val shown = synchronized(lock) {
            runningLines = runningLines.filterKeys { it.first in sessions }
            Glue.runningLinesShown(runningLines, sessions).mapNotNull { line ->
                line.call?.let { line to edits.forward(Glue.fileKey(it.uri), it.line, sinceOf(line.ref)) }
            }
        }
        val keys = shown.map { (line, _) -> line.ref to line.lane }.toSet()
        for (key in drawnRunning.keys - keys) drawnRunning.remove(key)?.dispose()
        for ((line, at) in shown) {
            val call = line.call ?: continue
            val key = line.ref to line.lane
            val text = Glue.runningLineText(line)
            drawnRunning[key]?.takeIf { it.uri != call.uri || it.line != at || it.text != text }?.let { drawnRunning.remove(key)?.dispose() }
            // A file no editor shows has no document loaded: it is drawn once an editor opens it (`editorCreated`).
            val file = fileOf(call.uri) ?: continue
            val document = FileDocumentManager.getInstance().getCachedDocument(file) ?: continue
            if (at < 0 || at >= document.lineCount) continue
            val drawnLine = drawnRunning.getOrPut(key) { DrawnRunning(call.uri, at, text) }
            for (editor in EditorFactory.getInstance().getEditors(document, project)) {
                if (drawnLine.inlays[editor]?.isValid == true) continue
                editor.inlayModel.addAfterLineEndElement(document.getLineEndOffset(at), false, RunningLineInlay(text))
                    ?.let { drawnLine.inlays[editor] = it }
            }
        }
    }

    /** How many editors the running lines' inlays are held for, which the tests read. On the event thread. */
    internal fun runningEditors(): Int = drawnRunning.values.sumOf { it.inlays.size }

    /** The texts of the running lines' inlays drawn now, which the tests read. On the event thread. */
    internal fun runningShown(): List<String> =
        drawnRunning.values.flatMap { it.inlays.values }.filter { it.isValid }.map { (it.renderer as RunningLineInlay).text }

    /**
     * Write lines in the Page tab of the Piwi tool window, the tab added, not selected, when the tool window holds
     * none, unless the person closed it since the last run began ([pageClosed]). In sight, the tab keeps the slot's
     * watch ([laneSightChanged]). On any thread.
     */
    private fun writePage(lines: List<String>) {
        if (lines.isEmpty()) return
        ApplicationManager.getApplication().invokeLater({
            val window = toolWindow() ?: return@invokeLater
            val open = pageTab?.takeIf { window.contentManager.getIndexOfContent(it) >= 0 }
            if (open == null && pageClosed) return@invokeLater
            val console = pageConsole?.takeIf { open != null } ?: run {
                val console = TextConsoleBuilderFactory.getInstance().createBuilder(project).apply { setViewer(true) }.console
                console.component.addHierarchyListener { laneSightChanged() }
                ContentFactory.getInstance().createContent(console.component, PAGE_TAB, false).apply {
                    isCloseable = true
                    setDisposer {
                        Disposer.dispose(console)
                        if (pageTab === this) {
                            pageTab = null
                            pageConsole = null
                            pageClosed = true
                            laneSightChanged()
                        }
                    }
                    window.contentManager.addContent(this)
                    pageTab = this
                }
                pageConsole = console
                console
            }
            console.print(lines.joinToString("\n", postfix = "\n"), ConsoleViewContentType.NORMAL_OUTPUT)
            pageWritten.addAll(lines)
            while (pageWritten.size > PAGE_LINES_KEPT) pageWritten.removeFirst()
        }, gone)
    }

    /** The lines the Page tab was given last, the newest last, which the tests read. On the event thread. */
    internal val pageWritten = ArrayDeque<String>()

    /**
     * Open a stop's file at its line; whether the file is in sight then. With the focus, as the debugger does. Without
     * it, the editor in use is left alone: a file open in an editor already keeps its caret, and while an editor shows a
     * file, another stays closed, the stop drawn in it when it opens; with no editor shown, it opens without the focus.
     * On the event thread.
     */
    private fun reveal(stop: Glue.ShownStop, file: VirtualFile, focus: Boolean): Boolean {
        val descriptor = OpenFileDescriptor(project, file, stop.stop.line, stop.stop.character ?: 0)
        val manager = FileEditorManager.getInstance(project)
        return when {
            focus -> {
                descriptor.navigate(true)
                true
            }
            manager.isFileOpen(file) -> file in manager.selectedFiles
            manager.selectedFiles.isNotEmpty() -> false
            else -> {
                descriptor.navigate(false)
                true
            }
        }
    }

    /**
     * Open a stop's file at its line with the focus, from the status bar item's menu: the person is then on its slot.
     * On the event thread.
     */
    fun goTo(stop: Glue.ShownStop) {
        val file = fileOf(stop.stop.uri) ?: return PiwiCommands.notify(project, "${Glue.stopPlace(stop.stop)} could not be opened.")
        shownStops.opened(stop, true, reveal(stop, file, true))
        draw()
    }

    /** Draw again once the Paused page tab stops waiting for a slot's next stop. On the event thread. */
    private fun wakeWhenWaited() {
        waitAlarm.cancelAllRequests()
        val until = shownStops.waitsUntil() ?: return
        waitAlarm.addRequest({ draw() }, (until - System.currentTimeMillis()).coerceAtLeast(0L).toInt())
    }

    private fun toolWindow() = ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID)

    /** The Paused page tab while the tool window holds it: closing it removes it. */
    private fun livePage(): Content? = page?.takeIf { toolWindow()?.contentManager?.getIndexOfContent(it)?.let { i -> i >= 0 } == true }

    private fun fileOf(uri: String?): VirtualFile? =
        runCatching { LocalFileSystem.getInstance().findFileByNioFile(Path.of(URI(uri ?: ""))) }.getOrNull()

    /** Look a stop's file up on disk off the event thread, once, and draw again. On the event thread. */
    private fun refresh(uri: String?) {
        if (uri == null || !refreshed.add(uri)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(URI(uri))) }
            ApplicationManager.getApplication().invokeLater({ draw() }, gone)
        }
    }

    /** A stop's execution point: the line in the debugger's execution point colors, with the arrow in the gutter. */
    private fun highlight(document: Document, stop: Glue.ShownStop): RangeHighlighter =
        DocumentMarkupModel.forDocument(document, project, true).addRangeHighlighter(
            EXECUTION_POINT,
            document.getLineStartOffset(stop.stop.line),
            document.getLineEndOffset(stop.stop.line),
            DebuggerColors.EXECUTION_LINE_HIGHLIGHTERLAYER,
            HighlighterTargetArea.LINES_IN_RANGE,
        ).apply { gutterIconRenderer = ExecutionPointGutter(this@PiwiRunSessions, stop) }

    /** What the execution points, the inlays and the Paused page tab show now, which the tests read. On the event thread. */
    internal fun shown(): Shown {
        val panel = livePage()?.component as? PausedPagePanel
        return Shown(
            drawn.values.map { it.highlighter }.filter { it.isValid },
            drawn.values.flatMap { it.inlays.values }.filter { it.isValid },
            panel?.caption,
            panel?.image,
            (caretInlay?.takeIf { it.isValid }?.renderer as? CaretCountInlay)?.text,
            panel?.picks == true,
            panel?.note,
            (liveWorkerTab()?.component as? PausedPagePanel)?.caption,
            liveWorkerTab()?.displayName,
            (liveWorkerTab()?.component as? PausedPagePanel)?.liveWanted == true,
            toolWindow()?.contentManager?.selectedContent?.displayName,
            (liveWorkerTab()?.component as? PausedPagePanel)?.let { if (!it.traceShown) null else it.traceEnabled },
        )
    }

    internal data class Shown(
        val highlighters: List<RangeHighlighter>,
        val inlays: List<Inlay<*>>,
        val pageCaption: String?,
        val pageImage: BufferedImage?,
        val caretCount: String? = null,
        /** A click on the image picks there, as the hint above it says. */
        val pagePicks: Boolean = false,
        /** What the last pick on the image came to. */
        val pageNote: String? = null,
        /** What the Worker tab says of its slot, the tab's name, and whether its Watch is on. */
        val workerCaption: String? = null,
        val workerTab: String? = null,
        val workerWatch: Boolean = false,
        /** The tab of the Piwi tool window in sight. */
        val selectedTab: String? = null,
        /** The Worker tab's Open the trace so far: whether it takes a press, null while it is hidden. */
        val workerTrace: Boolean? = null,
    )

    /** A click at `x`, `y` of the Paused page tab's image, as a person's click reaches it, which the tests send. */
    internal fun clickPage(x: Int, y: Int) {
        (livePage()?.component as? PausedPagePanel)?.click(x, y)
    }

    /**
     * The page of a stop in the Paused page tab of the Piwi tool window, asked of its worker, the tab selected unless
     * `select` is false (the Worker tab is in sight, and keeps the place). On the event thread.
     */
    fun showPage(stop: Glue.ShownStop, select: Boolean = true) {
        // The same slot's next stop keeps Interact while Watch stays on; another slot's, or one taking no input,
        // turns it off before the watch ends.
        val before = livePage()?.component as? PausedPagePanel
        val keep = before != null && Glue.keepsInteract(before.interacting, pageSlot, stop, before.liveWanted)
        if (!keep) before?.letGo()
        stopPageView()
        val key = Glue.stopKey(stop)
        pageStop = key
        shownStops.view(stop)
        val window = toolWindow() ?: return
        val content = livePage() ?: ContentFactory.getInstance()
            .createContent(PausedPagePanel(), PAUSED_PAGE, false)
            .apply {
                isCloseable = true
                // Closed, the tab stops watching its stop's page and Interact goes off; the next stop opens it again.
                setDisposer {
                    if (page === this) {
                        (component as? PausedPagePanel)?.letGo()
                        stopPageView()
                    }
                }
            }
            .also {
                window.contentManager.addContent(it)
                page = it
            }
        if (select) {
            window.contentManager.setSelectedContent(content)
            window.show(null)
        }
        val panel = content.component as PausedPagePanel
        pageSlot = stop.ref to stop.slot
        panel.configureLive(stop.takes.contains("view"), stop.takes.contains("input"), stop.takes.contains("input-clicks"), keep) { on -> watchPage(stop, on) }
        // Interact going off gives back the stop it was last on for: this one, from now on.
        panel.interactOff = { giveBack(stop) }
        panel.acting = stop.stop.acting != null
        panel.viewport = null
        panel.input = { events ->
            if (Glue.actsOnPage(events) && shownStops.acted(stop)) draw()
            pageInput(stop, events)
        }
        panel.releaseInput = {
            if (pageStop == key && watchingPage != null) {
                pageRelease = true
                pageInput(stop, emptyList())
            }
        }
        panel.visibilityChanged = { visible ->
            if (!visible) {
                panel.letGo()
                stopPageView()
                panel.watching(false)
            } else if (panel.liveWanted && watchingPage == null) watchPage(stop, true)
        }
        pageCaption = Glue.stopCaption(stop, sessions)
        panel.show("$pageCaption · asking the test for its page…", null)
        if (panel.liveWanted) watchPage(stop, true)
        ApplicationManager.getApplication().executeOnPooledThread {
            val image = remote.pausedPage(PausedPageParams(stop.ref, stop.worker))?.image
            val picture = Glue.pausedImageBytes(image)?.let(::decode)
            ApplicationManager.getApplication().invokeLater({
                if (pageStop != key) return@invokeLater
                if (picture == null) {
                    if (watchingPage != null) panel.caption(pageCaption)
                    else panel.show("$pageCaption · the test sent no image of its page", null)
                    return@invokeLater
                }
                val pick = image?.takeIf { Glue.picksOnImage(stop.takes, it) }
                    ?.let { shown -> { x: Int, y: Int -> pickOnImage(stop, panel.viewport ?: shown, panel, panel.image ?: picture, x, y) } }
                val watching = watchingPage != null && acceptedPage === watchingPage
                val hasFrame = watching && panel.image != null
                panel.show(pageCaption, if (watching) panel.image ?: picture else picture, pick, watching)
                if (!hasFrame) panel.viewport = image
                panel.watching(watching, keepInteract = true)
                if (panel.liveWanted && !watching) watchPage(stop, true)
            }, gone)
        }
    }

    /**
     * A click at `x`, `y` of a stop's image in the Paused page tab: the element under it picked on the stopped page
     * (`piwi/pickAt`, in CSS pixels of its viewport) off the event thread, its locator going to the editor in place of
     * the one on the stopped line as the pause bar's pick does; the answer said under the caption while the tab shows
     * the same image. On the event thread.
     */
    private fun pickOnImage(stop: Glue.ShownStop, image: PausedImage, panel: PausedPagePanel, picture: BufferedImage, x: Int, y: Int) {
        val (pageX, pageY) = Glue.pagePoint(x, y, picture.width, picture.height, image) ?: return
        panel.note("Picking the element under the click…")
        if (shownStops.acted(stop)) draw()
        ApplicationManager.getApplication().executeOnPooledThread {
            val answer = remote.pickAt(PickAtParams(stop.ref, stop.worker, stop.stop.since ?: "", pageX, pageY))
            ApplicationManager.getApplication().invokeLater({
                if (pageStop == Glue.stopKey(stop)) panel.note(answer?.message ?: Glue.SERVICE_NO_ANSWER)
            }, gone)
        }
    }

    /** `piwi/pageView` on the tab's calls, after what the tab sent before it; `answered` on the event thread. */
    private fun requestPageView(params: PageViewParams, answered: ((RunControlResult?) -> Unit)? = null) {
        pageCall {
            val result = runCatching { remote.pageView(params) }.getOrNull()
            if (answered != null) ApplicationManager.getApplication().invokeLater({ answered(result) }, gone)
        }
    }

    /**
     * The Paused page tab's watch ends after what was queued for it, in order on the tab's calls: its events, its
     * release and the stops given back, then `piwi/pageView` off. On the event thread.
     */
    private fun stopPageView() {
        val previous = watchingPage
        watchingPage = null
        acceptedPage = null
        pendingPageFrame.set(null)
        pageInputAlarm.cancelAllRequests()
        if (previous != null) while (pageInputs.isNotEmpty() || pageRelease) sendQueued(previous)
        pageInputs.filterIsInstance<Glue.ShownStop>().forEach(::sendGiveBack)
        pageInputs.clear()
        pageInputBusy = false
        pageRelease = false
        if (previous != null) requestPageView(previous.copy(on = false))
    }

    private fun watchPage(stop: Glue.ShownStop, on: Boolean) {
        stopPageView()
        val panel = livePage()?.component as? PausedPagePanel ?: return
        // Interact goes off with Watch, and stays on, unusable, until the new watch is accepted.
        panel.watching(false, keepInteract = on)
        if (!on || !inSight(panel) || pageStop != Glue.stopKey(stop)) return
        val params = PageViewParams(stop.ref, stop.worker, stop.stop.since ?: return, true)
        watchingPage = params
        requestPageView(params) { result ->
            if (watchingPage !== params) return@requestPageView
            if (result?.ok == true) {
                acceptedPage = params
                panel.watching(true)
            } else {
                panel.letGo()
                stopPageView()
                panel.watching(false)
                panel.note(result?.message ?: Glue.SERVICE_NO_ANSWER)
                panel.liveWanted = false
            }
        }
    }

    /**
     * Interact went off: the stop it was last on for is given back (`piwi/driveStop`, `on: false`), whichever of the
     * IDE's views drove it, from the input queue: once the events queued before it, the click held back and the release
     * included, were sent and answered, and before those queued after it. Interact itself takes no stop: the person's
     * first click, key, wheel or pick does. On the event thread.
     */
    private fun giveBack(stop: Glue.ShownStop) {
        if (pageInputBusy) pageInputs.addLast(stop) else sendGiveBack(stop)
    }

    /** `piwi/driveStop` off for `stop`, after the tab's sends before it; a refusal is said while the tab shows it. */
    private fun sendGiveBack(stop: Glue.ShownStop) {
        val params = DriveStopParams(stop.ref, stop.worker, stop.stop.since ?: return, false)
        val key = Glue.stopKey(stop)
        pageCall {
            val result = runCatching { remote.driveStop(params) }.getOrNull()
            ApplicationManager.getApplication().invokeLater({
                if (result?.ok != true && pageStop == key) {
                    (livePage()?.component as? PausedPagePanel)?.note(result?.message ?: Glue.SERVICE_NO_ANSWER)
                }
            }, gone)
        }
    }

    /** Send `call` off the event thread once the tab's sends before it were answered. */
    @Synchronized private fun pageCall(call: () -> Unit) {
        pageCalls = pageCalls.handle { _, _ -> Unit }.thenApplyAsync({ call() }, AppExecutorUtil.getAppExecutorService())
    }

    /**
     * The run of `ref` ended, or every run went away (`ref` null): Interact, on for a slot of it, goes off, so a rerun
     * under the ref starts with it off. On the event thread.
     */
    private fun runGone(ref: String?) {
        if (ref != null && pageSlot?.first != ref) return
        pageSlot = null
        (livePage()?.component as? PausedPagePanel)?.stopInteracting()
    }

    /**
     * The Worker tab or the Page tab showed or hid: the slot's watch goes on while either is in sight, ends once neither
     * is, and starts again as one shows while Watch is on. Decided once the tool window's change of tabs is done.
     */
    private fun laneSightChanged() {
        ApplicationManager.getApplication().invokeLater({
            val panel = liveWorkerTab()?.component as? PausedPagePanel ?: return@invokeLater
            if (laneTarget == null) return@invokeLater
            if (!laneInSight(panel)) {
                stopLaneView()
                panel.watching(false)
            } else if (panel.liveWanted && watchingLane == null) {
                watchLane(true)
            }
        }, gone)
    }

    /** Whether the Worker tab (`panel`) or the Page tab is in sight. On the event thread. */
    private fun laneInSight(panel: PausedPagePanel): Boolean = inSight(panel) || livePageOutput()?.let { inSight(it.component) } == true

    /** The Page tab while the tool window holds it. */
    private fun livePageOutput(): Content? =
        pageTab?.takeIf { toolWindow()?.contentManager?.getIndexOfContent(it)?.let { i -> i >= 0 } == true }

    /** The Worker tab while the tool window holds it: closing it removes it. */
    private fun liveWorkerTab(): Content? =
        workerTab?.takeIf { toolWindow()?.contentManager?.getIndexOfContent(it)?.let { i -> i >= 0 } == true }

    /**
     * Watch the slot `lane` of the run `ref` in the Worker tab of the Piwi tool window (`piwi/laneView`): the page of
     * the test the worker there runs, through its tests and stops and the worker Playwright starts in its place, the
     * caption saying what it does. One slot at a time. On the event thread.
     */
    fun showWorker(ref: String, lane: Int) {
        val window = toolWindow() ?: return
        val content = workerTabIn(window, Glue.workerName(lane))
        val panel = content.component as PausedPagePanel
        if (laneTarget != ref to lane) {
            stopLaneView()
            stopCiView()
            ciTarget = null
            laneTarget = ref to lane
            panel.forWorker()
            val shown = Glue.laneShown(sessions[ref], lane, stops()).worker
            layersFor(panel).note(Glue.laneLayersNote(shown))
            panel.openTrace = { openTrace() }
            panel.traceable(Glue.canOpenTrace(shown), (ref to lane) in traceAsking)
            panel.configureLive(true, false, false) { on -> watchLane(on) }
            panel.visibilityChanged = { laneSightChanged() }
            panel.show(Glue.laneShown(sessions[ref], lane, stops()).caption, null)
        }
        panel.liveWanted = true
        if (watchingLane == null) watchLane(true)
    }

    /**
     * The Worker tab's layers, started anew for another slot or CI lane (`ci`, whose note says why none may come until
     * one does), its tabs asking the watch for theirs.
     */
    private fun layersFor(panel: PausedPagePanel, ci: Boolean = false): LaneLayersPanel = panel.withLayers().apply {
        ciLane = ci
        reset()
        sectionsChanged = { relayer() }
        textAsked = { askText(this) }
    }

    /** The layers the Worker tab shows now: the call log and the events, and the text or the filmstrip while selected. */
    private fun layersAsked(): List<String> {
        val layers = (liveWorkerTab()?.component as? PausedPagePanel)?.layers
        return Glue.laneLayersAsked(layers?.textOpen == true, layers?.filmstripOpen == true)
    }

    /**
     * Text or Filmstrip was selected or left, or a watch was accepted: an accepted watch asks for the layers the tab
     * shows when they differ from those it asked last, its view kept on. On the event thread.
     */
    private fun relayer() {
        val asked = layersAsked()
        if (asked == layersSent) return
        val lane = watchingLane
        val ci = watchingCi
        // A refused change leaves the service's layers as they were: the next change of the tabs asks again.
        if (lane != null && acceptedLane === lane) {
            layersSent = asked
            queueWorkerCall({ if (watchingLane === lane) remote.laneView(lane.copy(layers = asked)) else null }) { result ->
                if (watchingLane === lane) layersSent = Glue.layersAfterAnswer(layersSent, asked, result?.ok == true)
            }
        } else if (ci != null && acceptedLane === ci) {
            layersSent = asked
            queueWorkerCall({ if (watchingCi === ci) remote.ciWatch(ci.copy(layers = asked)) else null }) { result ->
                if (watchingCi === ci) layersSent = Glue.layersAfterAnswer(layersSent, asked, result?.ok == true)
            }
        }
    }

    /**
     * Take the text again: the watched lane's worker reads its page's text now, one ask at a time, the button off until
     * it is answered; why not shows over the text.
     */
    private fun askText(layers: LaneLayersPanel) {
        if (!layers.textOpen || layers.textAsking) return
        val lane = watchingLane
        val ci = watchingCi
        val answered = { result: RunControlResult? ->
            layers.textAsking = false
            if (result != null && !result.ok) layers.textRefused(result.message ?: NOT_RUNNING)
        }
        val asked = layersAsked()
        if (lane != null && acceptedLane === lane) {
            layers.textAsking = true
            queueWorkerCall({ if (watchingLane === lane) remote.laneView(lane.copy(layers = asked, text = true)) else null }, answered)
        } else if (ci != null && acceptedLane === ci) {
            layers.textAsking = true
            queueWorkerCall({ if (watchingCi === ci) remote.ciWatch(ci.copy(layers = asked, text = true)) else null }, answered)
        }
    }

    /** A layer of the slot the Worker tab watches, one it asked for. */
    fun laneLayer(layer: LaneViewLayer) {
        val own = watchingLane ?: return
        if (own.ref != layer.ref || own.lane != layer.lane) return
        hearLayer(layer) { watchingLane?.let { it.ref == layer.ref && it.lane == layer.lane } == true }
        val test = sessions[layer.ref]?.workers.orEmpty().firstOrNull { it.parallelIndex == layer.lane }?.test
        writePage(synchronized(pageOutput) { pageOutput.layer(layer, test) })
    }

    /** A layer of the CI lane the Worker tab watches, one it asked for. */
    fun ciLayer(layer: CiLayer) {
        val own = watchingCi ?: return
        if (!Glue.sameCiLane(own, CiFrame(layer.root, layer.runId, layer.shard, layer.lane))) return
        hearLayer(layer) { watchingCi?.let { Glue.sameCiLane(it, CiFrame(layer.root, layer.runId, layer.shard, layer.lane)) } == true }
    }

    /** A layer heard, handed to the Worker tab in the order the layers came (`drawLayers`). */
    private fun hearLayer(layer: LaneLayerFields, current: () -> Boolean) {
        pendingLayers.add(layer to current)
        drawLayers()
    }

    /**
     * Hand the layers heard to the Worker tab on the event thread in the order they came, one pooled thread at a time,
     * each filmstrip image decoded and scaled off the event thread first: an image of a test is never shown after a
     * layer of the next. An image larger than twice a thumbnail's size is let go of before it is decoded.
     */
    private fun drawLayers() {
        if (pendingLayers.isEmpty() || !drawingLayers.compareAndSet(false, true)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                while (true) {
                    val (layer, current) = pendingLayers.poll() ?: break
                    val image = if (layer.layer == "filmstrip") Glue.stripImageBytes(layer.data)?.let(::decode) else null
                    val shown = image?.let { it to stripIcon(it, JBUI.scale(60)) }
                    ApplicationManager.getApplication().invokeLater({
                        if (current()) (liveWorkerTab()?.component as? PausedPagePanel)?.layers?.heard(layer, shown)
                    }, gone)
                }
            } finally {
                drawingLayers.set(false)
            }
            drawLayers()
        }
    }

    /** The Worker tab named `name`, added to the tool window when it holds none, selected and in sight. */
    private fun workerTabIn(window: com.intellij.openapi.wm.ToolWindow, name: String): Content {
        val content = liveWorkerTab() ?: ContentFactory.getInstance()
            .createContent(PausedPagePanel(), name, false)
            .apply {
                isCloseable = true
                // Closed, the tab stops watching its worker; Watch a worker's test, or a CI run's Watch, opens it again.
                setDisposer {
                    if (workerTab === this) {
                        stopLaneView()
                        stopCiView()
                        laneTarget = null
                        ciTarget = null
                    }
                }
            }
            .also {
                window.contentManager.addContent(it)
                workerTab = it
                laneTarget = null
                ciTarget = null
            }
        content.displayName = name
        window.contentManager.setSelectedContent(content)
        window.show(null)
        return content
    }

    /**
     * Watch a CI run's lane in the Worker tab (`piwi/ciWatch`), read-only, in place of the slot it watched: Watch alone,
     * no Interact and no pick, its caption from the CI sessions (`Glue.ciLaneCaption`), and why the watch ended or was
     * refused said under it, a refusal offering the lane's view on the dashboard. On the event thread.
     */
    fun showCiWorker(lane: Glue.CiLane) {
        val window = toolWindow() ?: return
        val content = workerTabIn(window, Glue.ciLaneTitle(lane))
        val panel = content.component as PausedPagePanel
        if (ciTarget != lane) {
            stopLaneView()
            // Another CI lane takes the place of the one watched on the service's side: no word of the one before.
            if (ciTarget != null) {
                watchingCi = null
                pendingCiFrame.set(null)
            } else stopCiView()
            laneTarget = null
            ciTarget = lane
            panel.forCiWorker()
            panel.openTrace = null
            panel.traceable(false, false)
            layersFor(panel, ci = true)
            panel.configureLive(true, false, false) { on -> watchCi(on) }
            panel.visibilityChanged = { visible ->
                if (!visible) {
                    stopCiView()
                    panel.watching(false)
                } else if (panel.liveWanted && watchingCi == null) watchCi(true)
            }
            panel.show(Glue.ciLaneCaption(ciSessions(), lane), null)
        }
        panel.liveWanted = true
        if (watchingCi == null) watchCi(true)
    }

    private fun ciSessions(): Map<String, CiSession> = project.getServiceIfCreated(PiwiCiRuns::class.java)?.sessions.orEmpty()

    /** The CI sessions changed: what the Worker tab says of the CI lane it shows follows. On the event thread. */
    fun ciChanged(sessions: Map<String, CiSession>) {
        val lane = ciTarget ?: return
        val panel = liveWorkerTab()?.component as? PausedPagePanel ?: return
        panel.caption(Glue.ciLaneCaption(sessions, lane))
        // The service ends the watch with the run's session, and Watch is off for the next.
        if (sessions[Glue.ciKey(lane.root, lane.runId)] == null && watchingCi != null) {
            watchingCi = null
            pendingCiFrame.set(null)
            panel.watching(false)
            panel.liveWanted = false
        }
    }

    /** Whether a new page selects the Paused page tab (`Glue.selectsPausedPage`). On the event thread. */
    private fun selectsPage(): Boolean {
        val window = toolWindow() ?: return true
        val tab = liveWorkerTab()
        return Glue.selectsPausedPage(tab != null && window.contentManager.selectedContent == tab, window.isVisible)
    }

    /** End the test a Pause waits for, where it waits in a call (`give-up`): the call given up where it can be. */
    fun giveUp(waiting: Glue.WaitingWorker) {
        control(RunControlParams(waiting.ref, waiting.worker, "give-up"))
    }

    /**
     * **Open the trace so far** for the Worker tab's slot (`piwi/openTrace`): the service starts Playwright's trace
     * viewer on the machine the run runs on. One ask per slot at a time, that slot's button off until the service
     * answers it; its sentence is said in a balloon, a warning when it is not `ok`, naming the worker it is for when the
     * tab shows another slot by then (`Glue.traceAnswerText`). On the event thread.
     */
    fun openTrace() {
        val slot = laneTarget ?: return
        if (!traceAsking.add(slot)) return
        drawTrace()
        ApplicationManager.getApplication().executeOnPooledThread {
            val answer = runCatching { remote.openTrace(OpenTraceParams(slot.first, slot.second)) }.getOrNull()
            ApplicationManager.getApplication().invokeLater({
                traceAsking.remove(slot)
                drawTrace()
                val message = if (answer == null) Glue.SERVICE_NO_ANSWER else answer.message.orEmpty()
                val said = Glue.traceAnswerText(slot, laneTarget, message)
                PiwiCommands.notify(project, said, if (answer?.ok == true) NotificationType.INFORMATION else NotificationType.WARNING)
            }, gone)
        }
    }

    /** Whether the Worker tab's slot can open its test's trace now: its worker takes it, and no ask for it waits. */
    fun traceOpenable(): Boolean {
        val slot = laneTarget ?: return false
        return slot !in traceAsking && Glue.canOpenTrace(Glue.laneShown(sessions[slot.first], slot.second, stops()).worker)
    }

    /**
     * Open the trace so far as the Worker tab's slot stands: shown while its worker can open its test's trace, off while
     * that slot's own ask waits.
     */
    private fun drawTrace() {
        val panel = liveWorkerTab()?.component as? PausedPagePanel ?: return
        val slot = laneTarget ?: return panel.traceable(false, false)
        panel.traceable(Glue.canOpenTrace(Glue.laneShown(sessions[slot.first], slot.second, stops()).worker), slot in traceAsking)
    }

    /** Pause the worker `worker` of the run `ref` and watch its slot `lane` in the Worker tab. On the event thread. */
    fun pauseAndWatch(target: Glue.WatchTarget) {
        showWorker(target.ref, target.lane)
        control(RunControlParams(target.ref, target.worker, "pause"))
    }

    @Synchronized private fun requestLaneView(params: LaneViewParams, answered: ((RunControlResult?) -> Unit)? = null) =
        queueWorkerCall({ remote.laneView(params) }, answered)

    @Synchronized private fun requestCiWatch(params: CiWatchParams, answered: ((RunControlResult?) -> Unit)? = null) =
        queueWorkerCall({ remote.ciWatch(params) }, answered)

    /** A call of the Worker tab, sent once the one before was answered, its answer handed on the event thread. */
    @Synchronized private fun queueWorkerCall(call: () -> RunControlResult?, answered: ((RunControlResult?) -> Unit)?) {
        laneCalls = laneCalls.handle { _, _ -> Unit }.thenApplyAsync({
            val result = runCatching { call() }.getOrNull()
            if (answered != null) ApplicationManager.getApplication().invokeLater({ answered(result) }, gone)
            Unit
        }, AppExecutorUtil.getAppExecutorService())
    }

    private fun stopCiView() {
        val previous = watchingCi
        watchingCi = null
        if (acceptedLane === previous) acceptedLane = null
        pendingCiFrame.set(null)
        if (previous != null) requestCiWatch(previous.copy(on = false))
    }

    private fun watchCi(on: Boolean) {
        stopCiView()
        val panel = liveWorkerTab()?.component as? PausedPagePanel ?: return
        panel.watching(false)
        val lane = ciTarget ?: return
        if (!on || !panel.isShowing) return
        val asked = layersAsked()
        val params = CiWatchParams(lane.root, lane.runId, lane.shard, lane.lane, true, asked)
        watchingCi = params
        layersSent = asked
        panel.note(null)
        requestCiWatch(params) { result ->
            if (watchingCi !== params) return@requestCiWatch
            if (result?.ok == true) {
                acceptedLane = params
                panel.watching(true)
                // A tab selected while the watch opened asks for its layer now.
                return@requestCiWatch relayer()
            }
            watchingCi = null
            // A request the service did not answer in time may have opened the watch: it is let go.
            if (result == null) requestCiWatch(params.copy(on = false))
            val why = result?.message ?: Glue.SERVICE_NO_ANSWER
            panel.note(why)
            panel.liveWanted = false
            val dashboard = lane.dashboard ?: return@requestCiWatch
            PiwiNotifier.create(PiwiNotice.PROBLEM, StringUtil.escapeXmlEntities(why), NotificationType.WARNING)
                .addAction(NotificationAction.createSimpleExpiring("Watch on the dashboard") { BrowserUtil.browse(dashboard) })
                .notify(project)
        }
    }

    /**
     * An image of the CI lane the Worker tab watches, why none shows, or why its watch ended: one image is decoded off
     * the event thread, the newest alone waiting behind it.
     */
    fun ciFrame(frame: CiFrame) {
        val own = watchingCi ?: return
        if (!Glue.sameCiLane(own, frame)) return
        pendingCiFrame.set(frame)
        drawCiFrame()
    }

    private fun drawCiFrame() {
        if (pendingCiFrame.get() == null || !drawingCiFrame.compareAndSet(false, true)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val frame = pendingCiFrame.getAndSet(null)
            val picture = frame?.takeIf { it.refused == null && it.ended == null && (it.data?.length ?: Int.MAX_VALUE) <= 524288 }
                ?.let { Glue.pausedImageBytes(PausedImage("image/jpeg", it.data, null, null)) }
                ?.let(::decode)
            ApplicationManager.getApplication().invokeLater({
                val own = watchingCi
                val panel = liveWorkerTab()?.component as? PausedPagePanel
                if (frame != null && own != null && panel?.isShowing == true && Glue.sameCiLane(own, frame)) {
                    when {
                        frame.ended != null -> {
                            watchingCi = null
                            panel.watching(false)
                            panel.liveWanted = false
                            panel.note(frame.ended)
                        }
                        frame.refused != null -> panel.note(frame.refused)
                        picture != null -> {
                            panel.note(null)
                            panel.frame(picture)
                        }
                    }
                }
                drawingCiFrame.set(false)
                drawCiFrame()
            }, gone)
        }
    }

    private fun stopLaneView() {
        val previous = watchingLane
        watchingLane = null
        if (acceptedLane === previous) acceptedLane = null
        pendingLaneFrame.set(null)
        if (previous != null) {
            requestLaneView(previous.copy(on = false))
            // The running line goes with the watch.
            synchronized(lock) { runningLines = runningLines - (previous.ref to previous.lane) }
            ApplicationManager.getApplication().invokeLater({ drawRunning() }, gone)
        }
    }

    private fun watchLane(on: Boolean) {
        stopLaneView()
        val panel = liveWorkerTab()?.component as? PausedPagePanel ?: return
        panel.watching(false)
        val (ref, lane) = laneTarget ?: return
        if (!on || !laneInSight(panel)) return
        val asked = layersAsked()
        val params = LaneViewParams(ref, lane, true, asked)
        watchingLane = params
        layersSent = asked
        synchronized(pageOutput) { pageOutput.watching(ref, lane) }
        requestLaneView(params) { result ->
            if (watchingLane !== params) return@requestLaneView
            if (result?.ok == true) {
                acceptedLane = params
                panel.watching(true)
                // A tab selected while the watch started asks for its layer now.
                relayer()
            } else {
                stopLaneView()
                panel.note(result?.message ?: Glue.SERVICE_NO_ANSWER)
                panel.liveWanted = false
            }
        }
    }

    /** A frame of the slot the Worker tab watches: one is decoded off the event thread, the newest alone waiting behind it. */
    fun laneFrame(frame: LaneFrame) {
        val own = watchingLane ?: return
        if (own.ref != frame.ref || own.lane != frame.lane) return
        pendingLaneFrame.set(frame)
        drawLaneFrame()
    }

    private fun drawLaneFrame() {
        if (pendingLaneFrame.get() == null || !drawingLaneFrame.compareAndSet(false, true)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val frame = pendingLaneFrame.getAndSet(null)
            val picture = frame?.takeIf { it.refused == null && (it.data?.length ?: Int.MAX_VALUE) <= 524288 }
                ?.let { Glue.pausedImageBytes(PausedImage("image/jpeg", it.data, it.width, it.height)) }
                ?.let(::decode)
            ApplicationManager.getApplication().invokeLater({
                val own = watchingLane
                val panel = liveWorkerTab()?.component as? PausedPagePanel
                if (frame != null && own != null && panel?.isShowing == true && own.ref == frame.ref && own.lane == frame.lane) {
                    if (frame.refused != null) panel.note(frame.refused)
                    else if (picture != null) {
                        panel.note(null)
                        panel.frame(picture)
                    }
                }
                drawingLaneFrame.set(false)
                drawLaneFrame()
            }, gone)
        }
    }

    /** One frame is decoded off the event thread; only the newest one waits behind it. */
    fun frame(frame: PageFrame) {
        val own = watchingPage ?: return
        if (own.ref != frame.ref || own.worker != frame.worker || own.since != frame.since) return
        pendingPageFrame.set(frame)
        drawPageFrame()
    }

    private fun drawPageFrame() {
        if (pendingPageFrame.get() == null || !drawingPageFrame.compareAndSet(false, true)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val frame = pendingPageFrame.getAndSet(null)
            val image = frame?.let { PausedImage("image/jpeg", it.data, it.width, it.height) }
            val picture = image?.takeIf { (it.data?.length ?: Int.MAX_VALUE) <= 524288 }?.let(Glue::pausedImageBytes)?.let(::decode)
            ApplicationManager.getApplication().invokeLater({
                val own = watchingPage
                val panel = livePage()?.component as? PausedPagePanel
                if (frame != null && own != null && panel?.isShowing == true && own.ref == frame.ref && own.worker == frame.worker && own.since == frame.since) {
                    if (frame.refused != null) panel.note(frame.refused)
                    else if (picture != null) {
                        panel.viewport = image
                        panel.frame(picture)
                    }
                }
                drawingPageFrame.set(false)
                drawPageFrame()
            }, gone)
        }
    }

    private fun pageInput(stop: Glue.ShownStop, events: List<PageInput>) {
        val own = watchingPage ?: return
        if (pageStop != Glue.stopKey(stop) || own.since != stop.stop.since) return
        for (event in events) {
            if (event.type == "mouse" && event.action == "move" && (pageInputs.lastOrNull() as? PageInput)?.let { it.type == "mouse" && it.action == "move" } == true) pageInputs.removeLast()
            if (pageInputs.size >= 50) {
                pageInputs.removeAll { it is PageInput }
                pageRelease = true
                (livePage()?.component as? PausedPagePanel)?.note("Too much input at once: the keys and buttons held were let go.")
                break
            }
            pageInputs.addLast(event)
        }
        if (pageInputBusy) return
        pageInputBusy = true
        pageInputAlarm.addRequest({
            if (watchingPage !== own) return@addRequest
            val sent = sendQueued(own) { release, result ->
                if (watchingPage !== own) return@sendQueued
                pageInputBusy = false
                if (result?.ok != true) {
                    (livePage()?.component as? PausedPagePanel)?.note(result?.message ?: Glue.SERVICE_NO_ANSWER)
                    pageInputs.removeAll { it is PageInput }
                    if (!release) pageRelease = true
                }
                if (pageInputs.isNotEmpty() || pageRelease) pageInput(stop, emptyList())
            }
            if (!sent) pageInputBusy = false
        }, 50)
    }

    /**
     * The queue's next send for the watch `own`, put on the tab's calls: the stops given back at its head, once the
     * events and the release asked before them went, then the events up to the next stop given back, or the release
     * once they went. `answered` hears whether it was the release and what it came to, on the event thread. Whether
     * events or a release were put. On the event thread.
     */
    private fun sendQueued(own: PageViewParams, answered: ((Boolean, RunControlResult?) -> Unit)? = null): Boolean {
        while (!pageRelease && pageInputs.firstOrNull() is Glue.ShownStop) sendGiveBack(pageInputs.removeFirst() as Glue.ShownStop)
        val batch = buildList { while (pageInputs.firstOrNull() is PageInput) add(pageInputs.removeFirst() as PageInput) }
        val release = batch.isEmpty() && pageRelease
        if (release) pageRelease = false
        if (batch.isEmpty() && !release) return false
        pageCall {
            val result = runCatching { remote.pageInput(PageInputParams(own.ref, own.worker, own.since, batch, release)) }.getOrNull()
            if (answered != null) ApplicationManager.getApplication().invokeLater({ answered(release, result) }, gone)
        }
        return true
    }

    /**
     * Answer a stop (`resume`, `step`, `finish`, or `run-to` the `place`, a line of the run's code), naming it, off the
     * event thread, saying why not: a refusal undoes what `Glue.StopsShown` recorded of it, the stops drawn again then.
     * On the event thread.
     */
    fun answer(stop: Glue.ShownStop, action: String, place: EditorBreakpoint? = null) {
        val token = shownStops.answered(stop, action)
        answeredAt = System.currentTimeMillis()
        wakeWhenWaited()
        control(RunControlParams(stop.ref, stop.worker, action, place, stop.stop.since)) { result ->
            // Taken, or no answer: the run may have taken it, and what the answer recorded stays.
            if (result == null || result.ok) {
                shownStops.taken(token)
            } else {
                answeredAt = 0L
                if (shownStops.refused(token)) draw()
            }
        }
    }

    /** Pause every run started here: each of its workers stops before its next call. */
    fun pause() {
        sessions.keys.forEach { control(RunControlParams(it, action = "pause")) }
    }

    /**
     * Send a control off the event thread, saying why not; `settled` runs on the event thread then, with the run's
     * answer (null when the service did not answer; `ok: false` when it refused it, or was not running to take it).
     */
    private fun control(params: RunControlParams, settled: ((RunControlResult?) -> Unit)? = null) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = remote.control(params)
            when {
                result == null -> PiwiCommands.notify(project, Glue.SERVICE_NO_ANSWER, NotificationType.WARNING)
                !result.ok -> PiwiCommands.notify(project, result.message ?: "The run did not take it.")
            }
            if (settled != null) ApplicationManager.getApplication().invokeLater({ settled(result) }, gone)
        }
    }

    /**
     * Share a run live on the team instance (`on`), or stop sharing it: the run `ref` names, else the only one it fits,
     * else the one chosen. The first share in this project since it opened says what goes out and to whom, and waits
     * for a yes, unless the run is known to be one that cannot be shared: it is asked anyway, and the service says why.
     * Stopping asks first. Shared, the answer offers the run page's link and Stop sharing. On the event thread.
     */
    fun shareLive(on: Boolean, ref: String? = null) {
        when (val target = if (ref != null) Glue.LiveTarget.One(ref) else Glue.liveTarget(sessions, on)) {
            is Glue.LiveTarget.None -> PiwiCommands.notify(project, target.why)
            is Glue.LiveTarget.One -> shareLiveRun(target.ref, on)
            is Glue.LiveTarget.Choose -> JBPopupFactory.getInstance()
                .createPopupChooserBuilder(target.refs)
                .setRenderer(
                    object : SimpleListCellRenderer<String>() {
                        override fun customize(list: JList<out String>, value: String?, index: Int, selected: Boolean, hasFocus: Boolean) {
                            text = value?.let { sessions[it]?.root ?: it }.orEmpty()
                        }
                    },
                )
                .setTitle(if (on) "Share which run live?" else "Stop sharing which run?")
                .setItemChosenCallback { shareLiveRun(it, on) }
                .createPopup()
                .showCenteredInCurrentWindow(project)
        }
    }

    private fun shareLiveRun(ref: String, on: Boolean) {
        val live = sessions[ref]?.live
        if (!on) {
            // Stopping asks about the run picked; a run that ended or is shared no more has nothing to stop.
            val shared = live?.takeIf { it.shared } ?: return PiwiCommands.notify(project, Glue.SHARE_ENDED)
            if (!confirmStopSharing(shared)) return
        }
        if (on && live?.refused == null && !liveWarned) {
            // The first share of the project chooses its scope too: this run, or the project's runs until stopped.
            val picked = MessageDialogBuilder.yesNoCancel("Share the run live?", Glue.shareLiveWarning(live?.page))
                .yesText("Share this run")
                .noText("Share this project's runs")
                .cancelText("Cancel")
                .show(project)
            if (picked == Messages.CANCEL) return
            if (picked == Messages.NO) return shareWindow(true, ref)
            liveWarned = true
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val answer = remote.shareRun(ShareRunParams(ref, on))
            val page = live?.page
            when {
                answer == null -> PiwiCommands.notify(project, Glue.SERVICE_NO_ANSWER, NotificationType.WARNING)
                !answer.ok || !on || page == null -> PiwiCommands.notify(project, answer.message.orEmpty())
                else -> PiwiNotifier.create(PiwiNotice.REQUEST, answer.message.orEmpty())
                    .addAction(NotificationAction.createSimpleExpiring("Open the run page") { BrowserUtil.browse(page) })
                    .addAction(NotificationAction.createSimpleExpiring("Copy the run page's link") {
                        CopyPasteManager.getInstance().setContents(StringSelection(page))
                    })
                    .addAction(NotificationAction.createSimpleExpiring("Stop sharing…") { shareLive(false, ref) })
                    .notify(project)
            }
        }
    }

    /**
     * Share this project's runs live until the person stops or the project closes (`on`), the run of `ref` too when one
     * is named, or stop sharing them all: the first share of the project says what goes out and waits for a yes, and
     * stopping asks first. On the event thread.
     */
    fun shareWindow(on: Boolean, ref: String? = null) {
        if (!on && !confirmStopSharing(null)) return
        if (on && !windowWarned) {
            val yes = MessageDialogBuilder.yesNo("Share this project's runs live?", Glue.shareLiveWarning(ref?.let { sessions[it]?.live?.page }, window = true))
                .yesText("Share this project's runs")
                .noText("Cancel")
                .ask(project)
            if (!yes) return
            windowWarned = true
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val answer = remote.shareRun(ShareRunParams(ref, on, "window"))
            PiwiCommands.notify(project, answer?.message ?: Glue.SERVICE_NO_ANSWER)
        }
    }

    /**
     * Whether the person confirms stopping a share (`Glue.stopSharingQuestion`): of a run (`live`), or of the project's
     * runs (`live` null). On the event thread.
     */
    private fun confirmStopSharing(live: RunLive?): Boolean =
        MessageDialogBuilder.yesNo(if (live == null) "Stop sharing this project's runs?" else "Stop sharing the run?", Glue.stopSharingQuestion(live))
            .yesText("Stop sharing")
            .noText("Cancel")
            .ask(project)

    /** The service says whether this project's runs are shared live: the status bar says so. */
    fun windowSharedChanged(on: Boolean) {
        windowShared = on
        changed()
    }

    /** A teammate asks to watch a run of this project: Share live shares it, Not now tells them. */
    fun askedToWatch(ask: AskToWatchParams) {
        val ref = ask.ref ?: return
        val id = ask.id ?: return
        PiwiNotifier.create(PiwiNotice.REQUEST, StringUtil.escapeXmlEntities(Glue.askToWatchText(ask.by.orEmpty(), ask.run)))
            .addAction(NotificationAction.createSimpleExpiring("Share live") { shareLive(true, ref) })
            .addAction(NotificationAction.createSimpleExpiring("Not now") {
                ApplicationManager.getApplication().executeOnPooledThread {
                    val answer = remote.answerAsk(AnswerAskParams(ref, id))
                    if (answer != null && !answer.ok) PiwiCommands.notify(project, answer.message.orEmpty())
                }
            })
            .notify(project)
    }

    /**
     * Turn the Hold failures of a run over: the only live run that has one, else the one chosen. The editor service
     * answers what it does now.
     */
    fun holdFailures() {
        when (val target = Glue.holdTarget(sessions)) {
            is Glue.HoldTarget.None -> PiwiCommands.notify(project, target.why)
            is Glue.HoldTarget.One -> holdRun(target.ref, target.on)
            is Glue.HoldTarget.Choose -> JBPopupFactory.getInstance()
                .createPopupChooserBuilder(target.refs)
                .setRenderer(
                    object : SimpleListCellRenderer<String>() {
                        override fun customize(list: JList<out String>, value: String?, index: Int, selected: Boolean, hasFocus: Boolean) {
                            val session = value?.let { sessions[it] }
                            text = listOfNotNull(session?.let(Glue::runLabel) ?: value, session?.hold?.let { Glue.holdText(it) }).joinToString(" · ")
                        }
                    },
                )
                .setTitle("Turn hold failures over for which run?")
                .setItemChosenCallback { ref -> holdRun(ref, sessions[ref]?.hold?.on != true) }
                .createPopup()
                .showCenteredInCurrentWindow(project)
        }
    }

    private fun holdRun(ref: String, on: Boolean) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val answer = remote.holdRun(HoldRunParams(ref, on))
            PiwiCommands.notify(project, answer?.message ?: Glue.SERVICE_NO_ANSWER)
        }
    }

    /** End the process of the run of `ref`; false when no run of this IDE runs it. */
    fun stopRun(ref: String): Boolean = processes[ref]?.let {
        it.destroyProcess()
        true
    } ?: false

    /**
     * Run `action` on the stop `Glue.StopsShown.choose` gives for the caret of `editor` (for a `control` in the moments
     * after an answer, one of the slot answered or none), else on the one chosen; among those `offers` keeps, when it
     * keeps any. On the event thread.
     */
    fun atCaret(
        editor: Editor?,
        offers: (Glue.ShownStop) -> Boolean = { true },
        control: Boolean = false,
        clicked: Glue.ShownStop? = null,
        action: (Glue.ShownStop) -> Unit,
    ) {
        if (clicked != null && offers(clicked)) return action(clicked)
        val uri = editor?.virtualFile?.let { fileUri(it) }
        val line = editor?.caretModel?.logicalPosition?.line
        val all = stops()
        val candidates = Glue.stopsFor(all.filter(offers).ifEmpty { all }, uri, line)
        when (val chosen = shownStops.choose(candidates, uri, line, control)) {
            is Glue.StopChoice.One -> return action(chosen.stop)
            Glue.StopChoice.None -> return if (candidates.isEmpty()) PiwiCommands.notify(project, "No test is stopped.") else Unit
            Glue.StopChoice.Ask -> Unit
        }
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(candidates)
            .setRenderer(
                object : SimpleListCellRenderer<Glue.ShownStop>() {
                    override fun customize(list: JList<out Glue.ShownStop>, value: Glue.ShownStop?, index: Int, selected: Boolean, hasFocus: Boolean) {
                        text = value?.let(Glue::stopLabel) ?: ""
                    }
                },
            )
            .setTitle("Which stopped test?")
            .setItemChosenCallback(action)
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }

    /** Run to the caret's line of `editor` from `stop`: the line as the run's code has it, which edits since may move. */
    fun runTo(stop: Glue.ShownStop, editor: Editor?) {
        val uri = editor?.virtualFile?.let { fileUri(it) } ?: return PiwiCommands.notify(project, "Place the caret on the line to run to.")
        val caret = editor.caretModel.logicalPosition.line
        val line = synchronized(lock) { edits.back(Glue.fileKey(uri), caret, sinceOf(stop.ref)) }
            ?: return PiwiCommands.notify(project, "The caret's line changed since the run started, so the running test has no line to stop at there.")
        answer(stop, "run-to", EditorBreakpoint(uri, line))
    }

    /**
     * The actions offered at a stop, which act on it: its controls, the paused page, then its code actions, the browser
     * and sharing it. Each is the registered action (`Piwi.ResumeRun`, `Piwi.PickAtStop`, …), so its key shows and Find
     * Action reaches it, wrapped to act on this stop (`STOP`) under the stop's own short label.
     */
    fun stopActions(stop: Glue.ShownStop): ActionGroup = DefaultActionGroup().apply {
        for (control in Glue.stopControls(stop)) onStop(CONTROL_IDS.getValue(control), stop, control.label, CONTROL_ICONS[control])?.let(::add)
        onStop("Piwi.ShowPausedPage", stop, SHOW_PAUSED_PAGE, AllIcons.Actions.Preview)?.let(::add)
        val actions = Glue.stopActions(stop)
        if (actions.isNotEmpty()) addSeparator()
        for (action in actions) onStop(CODE_ACTION_IDS.getValue(action), stop, action.label, PiwiIcons.stopAction(action))?.let(::add)
        if (Glue.canShowBrowser(stop)) {
            addSeparator()
            onStop("Piwi.ShowBrowser", stop, SHOW_THE_BROWSER, null)?.let(::add)
        }
        if (Glue.canShare(stop)) {
            addSeparator()
            onStop("Piwi.ShareWithPlaywright", stop, SHARE_WITH_PLAYWRIGHT, null)?.let(::add)
        }
    }

    /** The registered action `id`, acting on `stop` (`STOP` in its data context), under `label` and `icon`. */
    private fun onStop(id: String, stop: Glue.ShownStop, label: String, icon: javax.swing.Icon?): AnAction? =
        registeredWith(id, label, icon) { it.add(STOP, stop) }

    /**
     * Share a stop's browser with Playwright's own tools until its test ends, once the person said yes to the warning,
     * on the event thread: the answer names the command that joins it, to copy, and offers to stop sharing.
     */
    fun share(stop: Glue.ShownStop) {
        val since = stop.stop.since ?: return PiwiCommands.notify(project, "The test went on.")
        val yes = MessageDialogBuilder.yesNo("Share the stopped test's browser with Playwright tools?", Glue.SHARE_WARNING)
            .yesText("Share")
            .noText("Cancel")
            .ask(project)
        if (!yes) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val shared = remote.bind(StopBindParams(stop.ref, stop.worker, since, true))
            val command = shared?.command
            if (shared == null) return@executeOnPooledThread PiwiCommands.notify(project, Glue.SERVICE_NO_ANSWER, NotificationType.WARNING)
            if (!shared.ok || command == null) return@executeOnPooledThread PiwiCommands.notify(project, shared.message.orEmpty())
            PiwiNotifier.create(PiwiNotice.REQUEST, Glue.sharedText(shared), NotificationType.WARNING)
                .addAction(NotificationAction.createSimpleExpiring("Copy the command") {
                    CopyPasteManager.getInstance().setContents(java.awt.datatransfer.StringSelection(command))
                })
                .addAction(NotificationAction.createSimpleExpiring("Stop sharing") {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        val stopped = remote.bind(StopBindParams(stop.ref, stop.worker, since, false))
                        PiwiCommands.notify(project, stopped?.message ?: Glue.SERVICE_NO_ANSWER)
                    }
                })
                .notify(project)
        }
    }

    /**
     * Show the browser: the stop's window comes to the front, off the event thread. Only a refusal is said: the window
     * itself shows it worked.
     */
    fun showBrowser(stop: Glue.ShownStop) {
        val since = stop.stop.since ?: return PiwiCommands.notify(project, "The test went on.")
        if (shownStops.acted(stop)) draw()
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = remote.action(StopActionParams(stop.ref, stop.worker, since, "front", null))
            when {
                result == null -> PiwiCommands.notify(project, Glue.SERVICE_NO_ANSWER, NotificationType.WARNING)
                !result.ok -> PiwiCommands.notify(project, result.message ?: "The test did not take it.")
            }
        }
    }

    fun perform(stop: Glue.ShownStop, link: Glue.StopLink, editor: Editor?) {
        when (link) {
            Glue.StopControl.RUN_TO_CARET -> runTo(stop, editor)
            is Glue.StopControl -> answer(stop, link.action)
            is Glue.StopAction -> start(stop, link)
        }
    }

    /**
     * Start a code action at a stop, off the event thread: Mock a request lists the responses the test kept first, the
     * latest first, to choose the one to mock. The code comes in `piwi/stopCode`, which says what it wrote; the other
     * answers are said here.
     */
    fun start(stop: Glue.ShownStop, action: Glue.StopAction, request: Int? = null) {
        val since = stop.stop.since ?: return PiwiCommands.notify(project, "The test went on.")
        if (shownStops.acted(stop)) draw()
        ApplicationManager.getApplication().executeOnPooledThread {
            if (action == Glue.StopAction.MOCK && request == null) {
                val listed = remote.requests(StopRequestsParams(stop.ref, stop.worker, since))
                val requests = Glue.requestsToMock(listed?.requests)
                return@executeOnPooledThread when {
                    listed == null -> PiwiCommands.notify(project, Glue.SERVICE_NO_ANSWER, NotificationType.WARNING)
                    !listed.ok || requests.isEmpty() -> PiwiCommands.notify(project, listed.message ?: "The test kept no response.")
                    else -> ApplicationManager.getApplication().invokeLater({ chooseRequest(requests) { start(stop, action, it.id) } }, gone)
                }
            }
            val result = remote.action(StopActionParams(stop.ref, stop.worker, since, action.action, request))
            when {
                result == null -> PiwiCommands.notify(project, Glue.SERVICE_NO_ANSWER, NotificationType.WARNING)
                !result.ok || action != Glue.StopAction.MOCK -> PiwiCommands.notify(project, result.message ?: "The test did not take it.")
            }
        }
    }

    /**
     * Write the code a stop made, on the event thread, in one command (one undo step) in its document, so the service
     * follows it as it follows every edit: in an editor, the file opened first when no editor shows it, its code written
     * once the IDE told the service it opened it (`whenOpened`); only into the text the service placed it in (the
     * version it names, else the file as saved), else its code is offered to copy. The block is scrolled to without
     * taking the focus, and the sentence and warnings said.
     */
    fun write(code: StopCode, opened: Boolean = false) {
        if (!ApplicationManager.getApplication().isDispatchThread) {
            return ApplicationManager.getApplication().invokeLater({ write(code, opened) }, gone)
        }
        // Code of a desktop app's throwaway checkout is offered to copy, its sentence saying why; no file is edited.
        if (code.copy) return offerCopy(code)
        val name = code.uri.orEmpty().substringAfterLast('/').let { runCatching { java.net.URLDecoder.decode(it, Charsets.UTF_8) }.getOrDefault(it) }
        val file = fileOf(code.uri) ?: return notWritten(code, "$name could not be found, so the code was not written.")
        val document = FileDocumentManager.getInstance().getDocument(file)
            ?: return notWritten(code, "$name cannot be edited as text, so the code was not written.")
        val editors = FileEditorManager.getInstance(project)
        if (!opened && !editors.isFileOpen(file)) {
            editors.openTextEditor(OpenFileDescriptor(project, file, code.line, 0), false)
            return whenOpened(document) { write(code, true) }
        }
        val placed = if (code.version == null) !FileDocumentManager.getInstance().isDocumentUnsaved(document) else remote.documentVersion(document) == code.version
        val writes = Glue.stopCodeWrites(document.immutableCharSequence, code.edits.orEmpty())
        if (!placed || writes == null) return notWritten(code, "$name changed while the code was made, so it was not written: run the action again.")
        var readOnly = false
        WriteCommandAction.runWriteCommandAction(project, "Write the code made at the stop", null, {
            try {
                writes.forEach { document.replaceString(it.start, it.end, it.text) }
            } catch (_: ReadOnlyModificationException) {
                readOnly = true
            }
        })
        if (readOnly) return notWritten(code, "$name is read-only, so the code was not written.")
        val lines = Glue.writtenLines(code)
        EditorFactory.getInstance().getEditors(document, project).firstOrNull()?.scrollingModel?.scrollTo(LogicalPosition(lines.first, 0), ScrollType.MAKE_VISIBLE)
        val notice = Glue.stopCodeNotice(code)
        PiwiCommands.notify(project, notice.text, if (notice.warning) NotificationType.WARNING else NotificationType.INFORMATION)
    }

    /**
     * `then`, on the event thread, once the IDE gave the service the document it opened (its version known,
     * `RunRemote.documentVersion`), asked every `OPEN_POLL_MILLIS` by an alarm; after `OPEN_WAIT_MILLIS`, all the same,
     * the write then checking the text as it does any other.
     */
    private fun whenOpened(document: Document, then: () -> Unit) {
        val deadline = System.currentTimeMillis() + OPEN_WAIT_MILLIS
        lateinit var check: () -> Unit
        check = {
            if (remote.documentVersion(document) != null || System.currentTimeMillis() >= deadline) then()
            else openAlarm.addRequest({ check() }, OPEN_POLL_MILLIS)
        }
        openAlarm.addRequest({ check() }, OPEN_POLL_MILLIS)
    }

    /** The code a stop made offered to copy, with its sentence and what its reader should check. */
    private fun offerCopy(code: StopCode) {
        val notice = Glue.stopCodeNotice(code)
        PiwiNotifier.create(PiwiNotice.RESULT, StringUtil.escapeXmlEntities(notice.text), if (notice.warning) NotificationType.WARNING else NotificationType.INFORMATION)
            .addAction(NotificationAction.createSimpleExpiring("Copy the code") { CopyPasteManager.getInstance().setContents(StringSelection(code.code.orEmpty())) })
            .notify(project)
    }

    /** Why the code a stop made was not written, with the code to copy. */
    private fun notWritten(code: StopCode, why: String) {
        PiwiNotifier.create(PiwiNotice.PROBLEM, why, NotificationType.WARNING)
            .addAction(NotificationAction.createSimpleExpiring("Copy the code") { CopyPasteManager.getInstance().setContents(StringSelection(code.code.orEmpty())) })
            .notify(project)
    }

    /**
     * The caret moved, or the stops or a line changed, on the event thread: the count asks about the stop in the
     * caret's file (the one on the caret's line, else the first), for the caret's line, `CARET_WAIT_MILLIS` after the
     * caret settled; outside the stopped files, it takes the outline of the stop it counted on down; with no stop whose
     * reporter counts, it asks nothing.
     */
    private fun caretMoved(editor: Editor?) {
        val stops = stops().filter { "locator" in it.takes }
        val uri = editor?.virtualFile?.let { fileUri(it) }
        val line = editor?.caretModel?.logicalPosition?.line
        val inFile = stops.filter { Glue.stopInFile(it, uri) }
        val stop = inFile.firstOrNull { line != null && Glue.stopIsAt(it, uri, line) } ?: inFile.firstOrNull()
        val query = if (stop != null && editor != null && uri != null && line != null && line < editor.document.lineCount) {
            counted = stop
            val text = editor.document.getText(TextRange(editor.document.getLineStartOffset(line), editor.document.getLineEndOffset(line)))
            caretQuery(LocatorAtCaretParams(stop.ref, stop.worker, stop.stop.since.orEmpty(), uri, line), text, editor)
        } else {
            val last = counted?.let { c -> stops.firstOrNull { Glue.stopKey(it) == Glue.stopKey(c) } }
            if (last == null) counted = null
            last?.let { caretQuery(LocatorAtCaretParams(it.ref, it.worker, it.stop.since.orEmpty(), null, null), "", null) }
        }
        if (!caretAsks.want(query?.key)) return
        caretQuery = query
        clearCount()
        caretAlarm.cancelAllRequests()
        if (query != null) caretAlarm.addRequest({ askCount(query) }, CARET_WAIT_MILLIS)
    }

    private fun caretQuery(params: LocatorAtCaretParams, text: String, editor: Editor?) = CaretQuery(
        params,
        listOf(params.ref, params.worker, params.since, params.uri, params.line, text).joinToString("\u0000"),
        editor,
    )

    /** Ask the count of `query` off the event thread, unless another is on its way or it was asked already. */
    private fun askCount(query: CaretQuery) {
        if (!caretAsks.ask(query.key)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val answer = remote.locatorAtCaret(query.params)
            ApplicationManager.getApplication().invokeLater({
                if (caretAsks.answered(query.key)) return@invokeLater showCount(query, answer)
                // The caret moved on: the answer is dropped, and the query it stands at asked once it settled.
                val now = caretQuery
                if (now != null && caretAlarm.isEmpty) askCount(now)
            }, gone)
        }
    }

    /** The count at the end of the caret's line; a refusal for `CARET_REFUSAL_MILLIS`. On the event thread. */
    private fun showCount(query: CaretQuery, answer: LocatorAtCaretResult?) {
        val text = answer?.let(Glue::caretText) ?: return
        val editor = query.editor?.takeIf { !it.isDisposed } ?: return
        val line = query.params.line?.takeIf { it < editor.document.lineCount } ?: return
        caretInlay = editor.inlayModel.addAfterLineEndElement(editor.document.getLineEndOffset(line), true, CaretCountInlay("Piwi: $text"))
        if (!answer.ok || answer.count == null) {
            caretFade.addRequest({ if (caretAsks.wanted == query.key) clearCount() }, CARET_REFUSAL_MILLIS)
        }
    }

    private fun clearCount() {
        caretFade.cancelAllRequests()
        caretInlay?.let { if (it.isValid) Disposer.dispose(it) }
        caretInlay = null
    }

    override fun dispose() {
        // Off the event thread too: only the thread-safe state, and the service told the watch ends.
        val watched = watchingPage
        watchingPage = null
        pendingPageFrame.set(null)
        if (watched != null) requestPageView(watched.copy(on = false))
        val lane = watchingLane
        watchingLane = null
        pendingLaneFrame.set(null)
        if (lane != null) requestLaneView(lane.copy(on = false))
        val ci = watchingCi
        watchingCi = null
        pendingCiFrame.set(null)
        if (ci != null) requestCiWatch(ci.copy(on = false))
        disposed = true
        listeners.clear()
        processes.clear()
        val shown = drawn.values.toList()
        drawn.clear()
        val running = drawnRunning.values.toList()
        drawnRunning.clear()
        val count = caretInlay
        caretInlay = null
        val remove = {
            shown.forEach { it.dispose() }
            running.forEach { it.dispose() }
            count?.let { if (it.isValid) Disposer.dispose(it) }
        }
        if (ApplicationManager.getApplication().isDispatchThread) remove() else ApplicationManager.getApplication().invokeLater { remove() }
    }

    companion object {
        /** The paused line: **Settings → Editor → Color Scheme → Piwi**, the debugger's execution point by default. */
        val EXECUTION_POINT: TextAttributesKey =
            TextAttributesKey.createTextAttributesKey("PIWI_EXECUTION_POINT", DebuggerColors.EXECUTIONPOINT_ATTRIBUTES)

        const val PAUSED_PAGE = "Paused page"
        /** The tab of the Piwi tool window where the watched slot's page says what it says. */
        const val PAGE_TAB = "Page"

        /** The Page tab's last lines kept for the tests to read. */
        private const val PAGE_LINES_KEPT = 200
        const val SHOW_PAUSED_PAGE = "Show the paused page"
        const val SHARE_WITH_PLAYWRIGHT = "Share with Playwright tools"
        const val SHOW_THE_BROWSER = "Show the browser"

        /** What a control says when no editor service runs to send it to. */
        private const val NOT_RUNNING = Glue.SERVICE_NOT_RUNNING

        /** The pause after a breakpoint changes before the runs are sent them: a burst of changes is sent once. */
        private const val BREAKPOINTS_WAIT_MILLIS = 100L

        /** How long a run started here is waited for, its edits kept, before its first worker connects. */
        private const val STARTING_MILLIS = 120_000L

        /**
         * How long the code a stop made waits at most once its file was opened, for the IDE to tell the service it opened
         * it, and how often it asks.
         */
        private const val OPEN_WAIT_MILLIS = 3_000L
        private const val OPEN_POLL_MILLIS = 50

        /** How long the count at the caret waits for the caret to settle, and how long a refusal shows. */
        private const val CARET_WAIT_MILLIS = 200
        private const val CARET_REFUSAL_MILLIS = 3_000

        /** An image of a stopped page, decoded unless it is too large to hold; null for none. */
        private fun decode(bytes: ByteArray): BufferedImage? = runCatching {
            ImageIO.createImageInputStream(ByteArrayInputStream(bytes)).use { input ->
                val reader: ImageReader = ImageIO.getImageReaders(input).asSequence().firstOrNull() ?: return null
                try {
                    reader.input = input
                    if (!Glue.decodableImage(reader.getWidth(0), reader.getHeight(0))) null else reader.read(0)
                } finally {
                    reader.dispose()
                }
            }
        }.getOrNull()

        /** The stop a popup's actions act on, which the registered controls and code actions read before the caret. */
        val STOP: DataKey<Glue.ShownStop> = DataKey.create("piwi.stop")

        /** Each control's registered action. */
        val CONTROL_IDS = mapOf(
            Glue.StopControl.RESUME to "Piwi.ResumeRun",
            Glue.StopControl.STEP to "Piwi.StepRun",
            Glue.StopControl.RUN_TO_CARET to "Piwi.RunToCaret",
            Glue.StopControl.FINISH to "Piwi.FinishRun",
            Glue.StopControl.END to "Piwi.EndTest",
        )

        /** Each code action's registered action. */
        val CODE_ACTION_IDS = mapOf(
            Glue.StopAction.PICK to "Piwi.PickAtStop",
            Glue.StopAction.RECORD to "Piwi.RecordAtStop",
            Glue.StopAction.ASSERT to "Piwi.AssertAtStop",
            Glue.StopAction.ASSERT_REGION to "Piwi.AssertRegionAtStop",
            Glue.StopAction.MOCK to "Piwi.MockAtStop",
        )

        val CONTROL_ICONS = mapOf(
            Glue.StopControl.RESUME to AllIcons.Actions.Resume,
            Glue.StopControl.STEP to AllIcons.Actions.TraceOver,
            Glue.StopControl.RUN_TO_CARET to AllIcons.Actions.RunToCursor,
            Glue.StopControl.FINISH to AllIcons.Actions.StepOut,
            Glue.StopControl.END to AllIcons.RunConfigurations.TestIgnored,
        )

        fun fileUri(file: VirtualFile): String? =
            if (file.isInLocalFileSystem) runCatching { file.toNioPath().toUri().toString() }.getOrNull() else null
    }
}

/** What a run's controls and code actions ask of the editor service. */
internal interface RunRemote {
    fun control(params: RunControlParams): RunControlResult?

    fun shareRun(params: ShareRunParams): RunControlResult?

    fun answerAsk(params: AnswerAskParams): RunControlResult?

    fun holdRun(params: HoldRunParams): RunControlResult?

    fun pausedPage(params: PausedPageParams): PausedPageResult?

    fun pageView(params: PageViewParams): RunControlResult?

    fun pageInput(params: PageInputParams): RunControlResult?

    /** The IDE gives a stop back as Interact goes off (`on: false`). */
    fun driveStop(params: DriveStopParams): RunControlResult?

    fun laneView(params: LaneViewParams): RunControlResult?

    /** The Worker tab watches a CI run's lane (`on`), or stops. */
    fun ciWatch(params: CiWatchParams): RunControlResult?

    /**
     * **Open the trace so far** for the Worker tab's slot: the service starts Playwright's trace viewer on the machine the
     * run runs on.
     */
    fun openTrace(params: OpenTraceParams): RunControlResult?

    fun pickAt(params: PickAtParams): PickAtResult?

    fun action(params: StopActionParams): RunControlResult?

    fun requests(params: StopRequestsParams): StopRequestsResult?

    fun bind(params: StopBindParams): StopBindResult?

    fun locatorAtCaret(params: LocatorAtCaretParams): LocatorAtCaretResult?

    /** The version of `document` the IDE gave the service, which a stop's code names when it was placed in that text. */
    fun documentVersion(document: Document): Int?

    fun setBreakpoints(params: SetRunBreakpointsParams)

    /** The IDE's breakpoints to the service as they stand: false when no service runs to hear them. */
    fun setEditorBreakpoints(params: SetBreakpointsParams): Boolean

    fun commandEnded(params: CommandEndedParams)
}

/** How long a left click waits for a second one before it goes alone, and how far apart two clicks of one may be. */
private const val DOUBLE_CLICK_MILLIS = 250
private const val CLICK_SLOP = 4.0

/**
 * The page of a stopped test, under what it is about to run: the Paused page tab of the Piwi tool window. Where a click
 * on the image picks, a hint says so above it and the cursor is a crosshair over it; what the pick came to shows
 * under the caption. For a stop that takes `view`, **Watch** replaces the image with the page's frames, and
 * **Interact**, once the watch is accepted, sends the mouse and the keyboard to the page: a click then picks only with
 * Shift. The person's first click, key, wheel or pick drives the stop; Interact going off (unchecked, Escape, Watch
 * off or refused, the tab hidden, between stops too) gives it back (`interactOff`). It stays selected for the next stop
 * of the same worker slot while Watch stays on.
 */
internal class PausedPagePanel : JPanel(BorderLayout()) {
    var viewport: PausedImage? = null
    var input: ((List<PageInput>) -> Unit)? = null
    var releaseInput: (() -> Unit)? = null
    var visibilityChanged: ((Boolean) -> Unit)? = null
    /** Interact went off, whatever turned it off: the stop it was last on for is given back. */
    var interactOff: (() -> Unit)? = null
    /**
     * An action runs in the test's window at the stop shown (a pick, a check: the stop's `acting`): Escape
     * on the image goes to the page, whose Escape it is, rather than giving the stop back.
     */
    var acting = false
    private var changedLive: ((Boolean) -> Unit)? = null
    private val live = JCheckBox("Watch").apply { toolTipText = "Update this page while the test is paused. Nothing is stored or shared." }
    private val interact = JCheckBox("Interact").apply { toolTipText = "Send clicks, scrolling and typing to the page; the first drives the stop. Stays on at the worker's next stops; Escape gives the stop back, but goes to the page while a pick or a check runs there; Shift+click picks."; isEnabled = false }
    /** **Open the trace so far**, in the Worker tab: shown while its slot's worker can open its test's trace (`traceable`). */
    private val trace = JButton(Glue.OPEN_TRACE, AllIcons.FileTypes.Archive).apply {
        toolTipText = Glue.OPEN_TRACE_TITLE
        isVisible = false
    }
    /** **Open the trace so far** was pressed. */
    var openTrace: (() -> Unit)? = null
    var liveWanted: Boolean
        get() = live.isSelected
        set(value) { live.isSelected = value }
    /** Interact is selected: input goes to the page while the watch is accepted. */
    val interacting: Boolean get() = interact.isSelected
    private var isWatching = false
    private var captured = false
    private var held: Pair<String, Pair<Double, Double>>? = null
    private var heldCount: Int? = null
    private var clickCounts = false
    private var modifiers = emptyList<String>()
    private fun active() = isWatching && interact.isSelected

    /** A press nothing was sent for yet, at a stop that plays no click count: it ends as a click or starts a drag. */
    private class Press(val button: String, val at: Pair<Double, Double>, val keys: List<String>)
    private class WaitingClick(val button: String, val at: Pair<Double, Double>, val count: Int)
    private var pressed: Press? = null
    /** A left click held back for a second or a third, sent as one click with its count, as the Runs window does. */
    private var clickWaiting: WaitingClick? = null
    private val clickTimer = javax.swing.Timer(DOUBLE_CLICK_MILLIS) { flushClick() }.apply { isRepeats = false }

    private fun far(a: Pair<Double, Double>, b: Pair<Double, Double>) =
        kotlin.math.abs(a.first - b.first) > CLICK_SLOP || kotlin.math.abs(a.second - b.second) > CLICK_SLOP

    /** The click held back goes now, before anything that follows it. */
    private fun flushClick() {
        clickTimer.stop()
        val waiting = clickWaiting ?: return
        clickWaiting = null
        input?.invoke(listOf(PageInput("mouse", "click", waiting.at.first, waiting.at.second, waiting.button, waiting.count)))
    }

    /** A press that did not become a drag came up: a click, held back while a second one may follow. */
    private fun endClick(press: Press) {
        if (press.keys.isNotEmpty()) {
            flushClick()
            input?.invoke(
                press.keys.map { PageInput("key", "down", key = it) } +
                    PageInput("mouse", "click", press.at.first, press.at.second, press.button, 1) +
                    press.keys.reversed().map { PageInput("key", "up", key = it) },
            )
            return
        }
        val waiting = clickWaiting
        val count = if (waiting != null && waiting.button == press.button && !far(waiting.at, press.at)) waiting.count + 1 else 1
        if (count == 1) flushClick()
        clickTimer.stop()
        clickWaiting = null
        if (press.button == "left" && count < 3) {
            clickWaiting = WaitingClick(press.button, press.at, count)
            clickTimer.restart()
        } else {
            input?.invoke(listOf(PageInput("mouse", "click", press.at.first, press.at.second, press.button, count)))
        }
    }

    /** The key a press sends the page, as Playwright names it, or null for a key the IDE keeps. */
    private fun pageKey(e: KeyEvent): String? {
        val mac = com.intellij.openapi.util.SystemInfo.isMac
        val primary = if (mac) e.isMetaDown else e.isControlDown
        if ((mac && e.isControlDown) || (!mac && e.isMetaDown) || (primary && e.isAltDown)) return null
        val named = when (e.keyCode) {
            KeyEvent.VK_ENTER -> "Enter"; KeyEvent.VK_TAB -> "Tab"; KeyEvent.VK_BACK_SPACE -> "Backspace"; KeyEvent.VK_DELETE -> "Delete"
            KeyEvent.VK_LEFT -> "ArrowLeft"; KeyEvent.VK_RIGHT -> "ArrowRight"; KeyEvent.VK_UP -> "ArrowUp"; KeyEvent.VK_DOWN -> "ArrowDown"
            KeyEvent.VK_HOME -> "Home"; KeyEvent.VK_END -> "End"; KeyEvent.VK_PAGE_UP -> "PageUp"; KeyEvent.VK_PAGE_DOWN -> "PageDown"
            KeyEvent.VK_A -> "a".takeIf { primary }; KeyEvent.VK_Y -> "y".takeIf { primary }; KeyEvent.VK_Z -> "z".takeIf { primary }
            else -> null
        } ?: return null
        if (e.isAltDown && !mac) return null
        if (primary && named in listOf("Tab", "PageUp", "PageDown")) return null
        return (if (primary) "ControlOrMeta+" else if (e.isAltDown) "Alt+" else "") + (if (e.isShiftDown) "Shift+" else "") + named
    }

    private fun pressOnPage(key: String) {
        flushClick()
        input?.invoke(listOf(PageInput("key", "press", key = key)))
    }

    /** The panel of the Worker tab: Watch shows the page of the worker's test, running or stopped. */
    fun forWorker() {
        picture.accessibleContext.accessibleName = Glue.WORKER_PAGE_NAME
        live.text = "Watch"
        live.toolTipText = "Show the page of the test this worker runs, a few images a second, through its tests and stops. Nothing is stored or shared."
    }

    /** The panel of the Worker tab on a CI run's lane: Watch alone, read-only. */
    fun forCiWorker() {
        picture.accessibleContext.accessibleName = Glue.CI_WORKER_PAGE_NAME
        live.text = "Watch"
        live.toolTipText = "Show the page of the test this worker of the CI run runs, a few images a second, as the team instance relays it with the editor's key: the worker hid the secret fields first. Read-only: nothing here acts on CI. Nothing is stored."
    }

    /**
     * **Open the trace so far** shows while the slot's worker can open its test's trace (`shown`), and is off while an
     * ask waits for the service's answer (`asking`).
     */
    fun traceable(shown: Boolean, asking: Boolean) {
        trace.isVisible = shown
        trace.isEnabled = !asking
    }

    /** The image's accessible name, which says whose page it is: what the tests read. */
    fun pageName(): String? = picture.accessibleContext.accessibleName

    /** Whether **Open the trace so far** shows, and takes a press: what the tests read. */
    internal val traceShown: Boolean get() = trace.isVisible
    internal val traceEnabled: Boolean get() = trace.isEnabled

    /** The live view of a stop: Interact stays selected only with `keepInteract`, for a stop that takes input. */
    fun configureLive(available: Boolean, acceptsInput: Boolean, acceptsClickCounts: Boolean, keepInteract: Boolean = false, changed: (Boolean) -> Unit) {
        live.isVisible = available
        interact.isVisible = available && acceptsInput
        if (!available) liveWanted = false
        changedLive = changed
        clickCounts = acceptsClickCounts
        watching(false, keepInteract && available && acceptsInput)
    }

    /**
     * The watch is accepted (`on`), or not: Interact is enabled only while it is, and goes off with it unless
     * `keepInteract`, kept selected while the next watch is asked.
     */
    fun watching(on: Boolean, keepInteract: Boolean = false) {
        isWatching = on
        interact.isEnabled = on
        if (!on) {
            if (!keepInteract) turnInteractOff()
            captured = false; held = null; modifiers = emptyList()
            pressed = null; clickWaiting = null; clickTimer.stop()
        }
        drawPick()
    }

    /** Interact goes off, `interactOff` told when it was on. */
    private fun turnInteractOff() {
        if (!interact.isSelected) return
        interact.isSelected = false
        interactOff?.invoke()
    }

    /** Interact goes off, its stop given back: its run ended or went away. */
    fun stopInteracting() {
        turnInteractOff()
        drawPick()
    }

    /**
     * Interact goes off as its watch ends (the tab hidden or closed, a watch refused, another slot's stop): the click
     * held back and the keys and buttons held are let go first, then its stop is given back.
     */
    fun letGo() {
        if (active()) release()
        stopInteracting()
    }

    /** The hint and the crosshair show where a click picks: everywhere but while interacting. */
    private fun drawPick() {
        hint.isVisible = picks && !active()
        picture.cursor = if (picks && !active()) Cursor.getPredefinedCursor(Cursor.CROSSHAIR_CURSOR) else Cursor.getDefaultCursor()
    }

    fun frame(image: BufferedImage) {
        this.image = image
        picture.icon = ImageIcon(image)
    }

    /**
     * The tab shows no stop, `caption` saying why: Interact stays as it is, for the slot's next stop, until the tab
     * hides.
     */
    fun ended(caption: String) {
        live.isVisible = false
        interact.isVisible = false
        changedLive = null
        visibilityChanged = { visible -> if (!visible) watching(false) }
        show(caption, null)
    }

    fun caption(text: String) {
        caption = text
        label.text = text
    }

    private fun point(x: Int, y: Int): Pair<Double, Double>? {
        val current = image ?: return null
        val at = Glue.pagePoint(x, y, current.width, current.height, viewport) ?: return null
        return at.first.toDouble() to at.second.toDouble()
    }

    private fun release(releaseFocus: Boolean = true) {
        flushClick()
        pressed = null
        val button = held
        val events = mutableListOf<PageInput>()
        if (button != null) events += PageInput("mouse", "up", button.second.first, button.second.second, button.first, heldCount)
        events += modifiers.reversed().map { PageInput("key", "up", key = it) }
        if (releaseFocus && releaseInput != null) releaseInput?.invoke()
        else if (events.isNotEmpty()) input?.invoke(events)
        held = null
        modifiers = emptyList()
        if (releaseFocus) captured = false
    }
    // The caption and the note are plain text: a test's title or an instance's refusal never renders as HTML.
    private val label = JBLabel().apply {
        border = JBUI.Borders.empty(4, 8, 0, 8)
        putClientProperty("html.disable", true)
    }
    private val hint = JBLabel(Glue.PICK_HINT).apply {
        border = JBUI.Borders.empty(2, 8, 0, 8)
        foreground = UIUtil.getContextHelpForeground()
        isVisible = false
    }
    private val noteLabel = JBLabel().apply {
        border = JBUI.Borders.empty(2, 8, 0, 8)
        isVisible = false
        putClientProperty("html.disable", true)
    }
    private val picture = JBLabel().apply {
        horizontalAlignment = SwingConstants.LEFT
        verticalAlignment = SwingConstants.TOP
    }
    private val scroll = JBScrollPane(picture)

    /** The lane's layers under the image, in the Worker tab; null in the Paused page tab. */
    var layers: LaneLayersPanel? = null
        private set

    /** The Worker tab's panel: the lane's layers under the image, the two in a splitter. */
    fun withLayers(): LaneLayersPanel = layers ?: LaneLayersPanel().also { made ->
        remove(scroll)
        add(OnePixelSplitter(true, 0.6f).apply { firstComponent = scroll; secondComponent = made }, BorderLayout.CENTER)
        layers = made
        revalidate()
    }

    var caption: String? = null
        private set
    var image: BufferedImage? = null
        private set
    var note: String? = null
        private set

    /** What a click at a point of the image, in its own pixels, does; null where a click picks nothing. */
    private var pick: ((Int, Int) -> Unit)? = null

    val picks: Boolean get() = pick != null

    init {
        live.addActionListener {
            release()
            // Watch off turns Interact off before the watch ends: the stop is given back after the input let go.
            if (!live.isSelected) stopInteracting()
            changedLive?.invoke(liveWanted)
        }
        trace.addActionListener { openTrace?.invoke() }
        interact.addActionListener {
            release()
            drawPick()
            // Turned on, Interact only routes the input: the first click, key, wheel or pick drives the stop.
            if (!interact.isSelected) interactOff?.invoke()
        }
        addHierarchyListener { visibilityChanged?.invoke(isShowing) }
        val header = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.emptyBottom(4)
            add(label)
            add(JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 4, 0)).apply { add(live); add(interact); add(trace) })
            add(hint)
            add(noteLabel)
        }
        add(header, BorderLayout.NORTH)
        add(scroll, BorderLayout.CENTER)
        picture.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.button == MouseEvent.BUTTON1 && (!active() || e.isShiftDown)) click(e.x, e.y)
            }
            override fun mousePressed(e: MouseEvent) {
                if (!active() || e.isShiftDown || e.button !in listOf(MouseEvent.BUTTON1, MouseEvent.BUTTON3)) return
                val at = point(e.x, e.y) ?: return
                // One button held at a time: a second press lets go of the first.
                if (held != null) release(false)
                pressed?.let { pressed = null; endClick(it) }
                picture.requestFocusInWindow()
                captured = true
                e.consume()
                val button = if (e.button == MouseEvent.BUTTON3) "right" else "left"
                val keys = listOfNotNull("Control".takeIf { e.isControlDown }, "Alt".takeIf { e.isAltDown }, "Meta".takeIf { e.isMetaDown })
                if (!clickCounts) {
                    // Nothing goes yet: the press ends as a click, or starts a drag once the pointer moves away.
                    clickWaiting?.let { if (it.button != button || far(it.at, at) || keys.isNotEmpty()) flushClick() }
                    pressed = Press(button, at, keys)
                    return
                }
                held = button to at
                heldCount = e.clickCount.coerceIn(1, 3)
                modifiers = keys
                input?.invoke(modifiers.map { PageInput("key", "down", key = it) } + PageInput("mouse", "down", at.first, at.second, button, heldCount))
            }
            override fun mouseReleased(e: MouseEvent) {
                val press = pressed
                if (press != null) { pressed = null; endClick(press); e.consume(); return }
                if (held != null) { point(e.x, e.y)?.let { held = held!!.first to it }; release(false); e.consume() }
            }
        })
        picture.addMouseMotionListener(object : MouseMotionAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                if (!active()) return
                val at = point(e.x, e.y) ?: return
                clickWaiting?.let { if (far(it.at, at)) flushClick() }
                val press = pressed
                if (press != null) {
                    if (!far(press.at, at)) return
                    // A drag: the button goes down where it was pressed, then follows the pointer.
                    pressed = null
                    flushClick()
                    held = press.button to press.at
                    heldCount = null
                    modifiers = press.keys
                    input?.invoke(modifiers.map { PageInput("key", "down", key = it) } + PageInput("mouse", "down", press.at.first, press.at.second, press.button))
                }
                input?.invoke(listOf(PageInput("mouse", "move", at.first, at.second)))
            }
            override fun mouseDragged(e: MouseEvent) = mouseMoved(e)
        })
        // The wheel scrolls the page while interacting, and the image otherwise: a listener here takes it from the pane.
        picture.addMouseWheelListener { e ->
            val at = if (active() && picture.hasFocus()) point(e.x, e.y) else null
            if (at == null) scroll.dispatchEvent(SwingUtilities.convertMouseEvent(picture, e, scroll))
            else {
                val delta = (e.preciseWheelRotation * 40).coerceIn(-10000.0, 10000.0)
                flushClick()
                input?.invoke(listOf(PageInput("wheel", x = at.first, y = at.second, deltaX = if (e.isShiftDown) delta else 0.0, deltaY = if (e.isShiftDown) 0.0 else delta)))
                e.consume()
            }
        }
        picture.isFocusable = true
        picture.focusTraversalKeysEnabled = false
        picture.accessibleContext.accessibleName = Glue.PAUSED_PAGE_NAME
        picture.addFocusListener(object : FocusAdapter() { override fun focusLost(e: FocusEvent) { release() } })
        picture.addKeyListener(object : KeyAdapter() {
            override fun keyTyped(e: KeyEvent) {
                val mac = com.intellij.openapi.util.SystemInfo.isMac
                // AltGr types a character: Windows reports it as Control and Alt.
                val altGraph = e.isAltGraphDown || (!mac && e.isControlDown && e.isAltDown)
                val plain = !e.isControlDown && !e.isMetaDown && (!e.isAltDown || mac)
                val char = e.keyChar
                if (active() && (altGraph || plain) && !Character.isISOControl(char) && char != KeyEvent.CHAR_UNDEFINED) {
                    // A printable ASCII character is pressed, so the page hears its keydown and keyup.
                    val event = if (char in ' '..'~') PageInput("key", "press", key = char.toString()) else PageInput("text", text = char.toString())
                    flushClick()
                    input?.invoke(listOf(event)); e.consume()
                }
            }
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_TAB && (!active() || !captured)) { if (e.isShiftDown) picture.transferFocusBackward() else picture.transferFocus(); e.consume(); return }
                if (!active()) return
                if (e.keyCode == KeyEvent.VK_ESCAPE && acting) {
                    pressOnPage("Escape")
                    e.consume()
                    return
                }
                if (e.keyCode == KeyEvent.VK_ESCAPE) {
                    // Escape lets go of the input held, then turns Interact off, which gives the stop back.
                    release()
                    turnInteractOff()
                    drawPick()
                    interact.requestFocusInWindow()
                    e.consume()
                    return
                }
                val mac = com.intellij.openapi.util.SystemInfo.isMac
                val primary = if (mac) e.isMetaDown else e.isControlDown
                if (primary && !e.isAltDown && e.keyCode == KeyEvent.VK_V && !(mac && e.isControlDown) && !(!mac && e.isMetaDown)) {
                    val text = CopyPasteManager.getInstance().getContents<String>(java.awt.datatransfer.DataFlavor.stringFlavor).orEmpty()
                    val events = text.replace("\r\n", "\n").filter { !it.isISOControl() || it == '\n' || it == '\t' }.chunked(1000).take(50).map { PageInput("text", text = it) }
                    if (events.isNotEmpty()) { flushClick(); input?.invoke(events) }
                    e.consume(); return
                }
                pageKey(e)?.let { pressOnPage(it); e.consume() }
            }
        })
        // The IDE runs its own shortcuts on these keys (Undo, Redo, Select All) before a key listener hears them: while
        // interacting, the image takes them for the page, and otherwise leaves them to the IDE.
        val primaryMask = if (com.intellij.openapi.util.SystemInfo.isMac) InputEvent.META_DOWN_MASK else InputEvent.CTRL_DOWN_MASK
        object : AnAction() {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT

            override fun update(e: AnActionEvent) {
                e.presentation.isEnabled = active()
            }

            override fun actionPerformed(e: AnActionEvent) {
                (e.inputEvent as? KeyEvent)?.let { pageKey(it) }?.let { pressOnPage(it) }
            }
        }.registerCustomShortcutSet(
            CustomShortcutSet(
                KeyboardShortcut(KeyStroke.getKeyStroke(KeyEvent.VK_Z, primaryMask), null),
                KeyboardShortcut(KeyStroke.getKeyStroke(KeyEvent.VK_Z, primaryMask or InputEvent.SHIFT_DOWN_MASK), null),
                KeyboardShortcut(KeyStroke.getKeyStroke(KeyEvent.VK_Y, primaryMask), null),
                KeyboardShortcut(KeyStroke.getKeyStroke(KeyEvent.VK_A, primaryMask), null),
            ),
            picture,
        )
    }

    /** What the tab shows; Interact stays as it is, `configureLive` and the watch deciding it. */
    fun show(caption: String, image: BufferedImage?, pick: ((Int, Int) -> Unit)? = null, preserveWatching: Boolean = false) {
        if (!preserveWatching) watching(false, keepInteract = true)
        this.caption = caption
        this.image = image
        this.pick = pick.takeIf { image != null }
        label.text = caption
        picture.icon = image?.let { ImageIcon(it) }
        drawPick()
        note(null)
    }

    fun note(text: String?) {
        note = text
        noteLabel.text = text.orEmpty()
        noteLabel.isVisible = text != null
    }

    /** A click at `x`, `y` of the label, whose icon is drawn at its top left: a point of the image picks there. */
    fun click(x: Int, y: Int) {
        val shown = image ?: return
        if (x < 0 || y < 0 || x >= shown.width || y >= shown.height) return
        pick?.invoke(x, y)
    }
}

/** A label that shows its text as it is: a text from the run never renders as HTML. */
private fun plainLabel(text: String = "") = JBLabel(text).apply { putClientProperty("html.disable", true) }

/** A text that wraps, read-only, for words from the run. */
private fun plainArea() = JBTextArea().apply {
    isEditable = false
    lineWrap = true
    wrapStyleWord = true
    isOpaque = false
    border = JBUI.Borders.empty()
}

/** An image of the filmstrip `height` pixels high, scaled off the event thread. */
internal fun stripIcon(image: BufferedImage, height: Int): BufferedImage {
    val width = maxOf(1, image.width * height / maxOf(1, image.height))
    return BufferedImage(width, height, BufferedImage.TYPE_INT_RGB).also { small ->
        val g = small.createGraphics()
        try {
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
            g.drawImage(image, 0, 0, width, height, null)
        } finally {
            g.dispose()
        }
    }
}

/** An event line of the Worker tab: its words as plain text, its level as an icon. */
private class EventLineRenderer : ColoredListCellRenderer<Glue.EventLine>() {
    override fun customizeCellRenderer(list: JList<out Glue.EventLine>, value: Glue.EventLine?, index: Int, selected: Boolean, hasFocus: Boolean) {
        val line = value ?: return
        icon = when (line.level) {
            "error" -> AllIcons.General.Error
            "warning" -> AllIcons.General.Warning
            else -> AllIcons.General.Information
        }
        append(line.text, if (line.level == "error") SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes.REGULAR_ATTRIBUTES)
        // The platform renders a tooltip as HTML: the address is escaped first.
        toolTipText = line.url?.let { Glue.htmlTooltip(it) }
    }
}

/**
 * What the Worker tab shows of its lane under the image (`piwi/laneLayer`, `piwi/ciLayer`): Why it waits (the call
 * log's last lines, what its locator matches), then the Events, Text and Filmstrip tabs. The call log and the events
 * are asked for while the tab watches, the page's text and the filmstrip while their tab is selected
 * (`sectionsChanged`). Every text from the run goes into a plain text component or an `html.disable` label. On the
 * event thread.
 */
internal class LaneLayersPanel : JPanel(BorderLayout()) {
    /** The Text or Filmstrip tab was selected or left: the watch asks for the layers the tab shows. */
    var sectionsChanged: (() -> Unit)? = null
    /** Take the text again: the lane's worker reads its page's text now. */
    var textAsked: (() -> Unit)? = null
    var shown: Glue.LaneLayersShown = Glue.NO_LANE_LAYERS
        private set
    /** The lane is a CI run's: the note says why none of its layers may come until the first does. */
    var ciLane = false
    /** Why the page's text asked again did not come, until the next text. */
    private var textRefusal: String? = null
    /** The filmstrip's images, by call: as they came, and small for the strip. */
    private val images = HashMap<String, Pair<BufferedImage, BufferedImage>>()
    private var enlarged: String? = null
    private var found = 0

    private val note = plainLabel().apply {
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(2, 8)
        isVisible = false
    }
    private val waitsHead = plainLabel()
    private val waitsTarget = plainLabel().apply { foreground = UIUtil.getContextHelpForeground() }
    private val waitsLines = plainArea().apply { font = Font(Font.MONOSPACED, Font.PLAIN, JBUI.Fonts.label().size) }
    private val waits = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        border = JBUI.Borders.compound(JBUI.Borders.empty(2, 8), JBUI.Borders.customLine(JBColor.border(), 1), JBUI.Borders.empty(2, 6))
        isVisible = false
        add(JBLabel("Why it waits").apply { font = font.deriveFont(Font.BOLD) })
        add(waitsHead)
        add(waitsTarget)
        add(waitsLines)
    }
    private val events = DefaultListModel<Glue.EventLine>()
    private val eventList = JBList(events).apply {
        cellRenderer = EventLineRenderer()
        emptyText.text = "Nothing yet: console errors, failed and slow requests and the backend's errors show here."
        accessibleContext.accessibleName = "The page's events, the newest first"
    }
    private val textNote = plainLabel().apply { foreground = UIUtil.getContextHelpForeground() }
    private val text = plainArea().apply {
        lineWrap = false
        font = Font(Font.MONOSPACED, Font.PLAIN, JBUI.Fonts.label().size)
        accessibleContext.accessibleName = "The page as roles and names"
    }
    private val search = SearchTextField(false).apply { toolTipText = "Find in the page's text" }
    private val textAgain = JButton("Take the text again").apply {
        toolTipText = "Read the page's text now, its secret fields hidden"
        addActionListener { textAsked?.invoke() }
    }

    /** The page's text asked again waits for its answer: Take the text again is off meanwhile. */
    var textAsking: Boolean = false
        set(value) {
            field = value
            textAgain.isEnabled = !value
        }
    private val strip = JPanel(FlowLayout(FlowLayout.LEFT, 4, 4))
    private val stripEmpty = plainLabel("One image for each call of the test that ended: click one to see it larger.").apply {
        foreground = UIUtil.getContextHelpForeground()
    }
    private val large = JBLabel().apply { verticalAlignment = SwingConstants.TOP }
    private val largeTitle = plainLabel()
    private val tabs = JBTabbedPane()

    /** The Text tab is selected: the watch asks for the page's text. */
    val textOpen: Boolean get() = tabs.selectedIndex == 1
    /** The Filmstrip tab is selected: the watch asks for the filmstrip. */
    val filmstripOpen: Boolean get() = tabs.selectedIndex == 2

    init {
        add(JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(note)
            add(waits)
        }, BorderLayout.NORTH)
        val textTab = JPanel(BorderLayout()).apply {
            add(JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                add(JPanel(FlowLayout(FlowLayout.LEFT, 4, 2)).apply {
                    add(search)
                    add(textAgain)
                })
                add(textNote)
            }, BorderLayout.NORTH)
            add(JBScrollPane(text), BorderLayout.CENTER)
        }
        val stripTab = JPanel(BorderLayout()).apply {
            add(JPanel(BorderLayout()).apply {
                add(stripEmpty, BorderLayout.NORTH)
                add(JBScrollPane(strip, ScrollPaneConstants.VERTICAL_SCROLLBAR_NEVER, ScrollPaneConstants.HORIZONTAL_SCROLLBAR_AS_NEEDED), BorderLayout.CENTER)
            }, BorderLayout.NORTH)
            add(JBScrollPane(JPanel(BorderLayout()).apply {
                add(largeTitle, BorderLayout.NORTH)
                add(large, BorderLayout.CENTER)
            }), BorderLayout.CENTER)
        }
        tabs.addTab("Events", JBScrollPane(eventList))
        tabs.addTab("Text", textTab)
        tabs.addTab("Filmstrip", stripTab)
        tabs.addChangeListener { sectionsChanged?.invoke() }
        add(tabs, BorderLayout.CENTER)
        search.textEditor.addActionListener { find(found + 1) }
        search.addDocumentListener(object : com.intellij.ui.DocumentAdapter() {
            override fun textChanged(e: javax.swing.event.DocumentEvent) = find(0)
        })
    }

    /**
     * Find the search's words in the page's text from `from`, marked, and the caret moved there unless `moves` is false;
     * the start again past the last.
     */
    private fun find(from: Int, moves: Boolean = true) {
        text.highlighter.removeAllHighlights()
        val query = search.text
        val at = Glue.findIn(text.text, query, from)
        if (at < 0) return
        found = at
        text.highlighter.addHighlight(at, at + query.length, DefaultHighlighter.DefaultHighlightPainter(UIUtil.getListSelectionBackground(true)))
        if (moves) text.caretPosition = at
    }

    /** Why the lane shows no layers (a reporter that sends its images alone); null hides it. */
    fun note(words: String?) {
        note.text = words.orEmpty()
        note.isVisible = words != null
    }

    /** The layers start anew: another slot or CI lane. */
    fun reset() {
        shown = Glue.NO_LANE_LAYERS
        images.clear()
        enlarged = null
        textRefusal = null
        found = 0
        drawWaits()
        drawEvents()
        drawText()
        drawStrip()
        if (ciLane) note(Glue.ciLaneLayersNote(shown))
    }

    /** A layer of the lane the tab watches: `image` is the filmstrip's, decoded off the event thread. */
    fun heard(layer: LaneLayerFields, image: Pair<BufferedImage, BufferedImage>?) {
        val (next, changed) = Glue.withLaneLayer(shown, layer)
        shown = next
        // The images of calls the strip no longer holds go first: a later test's call of the same id is another image.
        images.keys.retainAll(next.strip.map { it.call }.toSet())
        val call = layer.thumb?.call
        if (image != null && call != null && "strip" in changed && next.strip.any { it.call == call }) images[call] = image
        if ("waits" in changed) drawWaits()
        if ("events" in changed) drawEvents()
        if ("text" in changed) {
            textRefusal = null
            drawText()
        }
        if ("strip" in changed) drawStrip()
        if (ciLane) note(Glue.ciLaneLayersNote(shown))
    }

    /** Why the page's text asked again did not come, said over the text. */
    fun textRefused(why: String) {
        textRefusal = why
        textNote.text = why
    }

    private fun drawWaits() {
        val view = shown.waits
        waits.isVisible = view != null
        waitsHead.text = view?.head.orEmpty()
        waitsHead.foreground = if (view?.failed == true) JBColor.RED else JBUI.CurrentTheme.Label.foreground()
        waitsTarget.text = view?.target.orEmpty()
        waitsTarget.isVisible = view?.target != null
        waitsLines.text = view?.lines.orEmpty().joinToString("\n")
    }

    private fun drawEvents() {
        events.clear()
        events.addAll(shown.events)
        tabs.setTitleAt(0, if (shown.events.isEmpty()) "Events" else "Events (${shown.events.size})")
    }

    /** The page's text as it came: the caret and the scroll stay where the person left them, the search's mark again. */
    private fun drawText() {
        val now = shown.text?.text.orEmpty()
        if (text.text != now) {
            val viewport = text.parent as? JViewport
            val place = viewport?.viewPosition
            val caret = text.caretPosition
            text.text = now
            text.caretPosition = minOf(caret, now.length)
            find(found, moves = false)
            // The caret set again scrolls to it once the event thread is free: the view goes back to where it was after.
            if (viewport != null && place != null) SwingUtilities.invokeLater { viewport.viewPosition = place }
        }
        textNote.text = textRefusal ?: Glue.laneTextNote(shown.text)
    }

    private fun drawStrip() {
        val calls = shown.strip.map { it.call }.toSet()
        images.keys.retainAll(calls)
        strip.removeAll()
        for (image in shown.strip) {
            val (_, small) = images[image.call] ?: continue
            val name = "${image.index}. ${image.title}"
            strip.add(JButton(ImageIcon(small)).apply {
                putClientProperty("html.disable", true)
                isContentAreaFilled = false
                border = JBUI.Borders.customLine(if (enlarged == image.call) JBUI.CurrentTheme.Focus.focusColor() else JBColor.border(), 1)
                // The platform renders a tooltip as HTML: the title, from the run, is escaped first.
                toolTipText = Glue.htmlTooltip(name)
                accessibleContext.accessibleName = name
                addActionListener { enlarge(if (enlarged == image.call) null else image.call) }
            })
        }
        stripEmpty.isVisible = shown.strip.isEmpty()
        if (enlarged != null && enlarged !in images) enlarge(null) else showEnlarged()
        strip.revalidate()
        strip.repaint()
    }

    /** Show the filmstrip's image of `call` larger, with its call's title; null shows none. */
    private fun enlarge(call: String?) {
        val changed = enlarged != call
        enlarged = call?.takeIf { it in images }
        if (changed) drawStrip() else showEnlarged()
    }

    private fun showEnlarged() {
        val call = enlarged
        val image = shown.strip.firstOrNull { it.call == call }
        large.icon = call?.let { images[it] }?.first?.let { ImageIcon(it) }
        largeTitle.text = image?.let { "${it.index}. ${it.title}" }.orEmpty()
    }
}

/** The arrow in the gutter at a stop: what is about to run, and on a click the controls, which act on that stop. */
private class ExecutionPointGutter(private val sessions: PiwiRunSessions, private val stop: Glue.ShownStop) : GutterIconRenderer(), DumbAware {
    override fun getIcon() = if (Glue.isFailure(stop.stop)) PiwiIcons.FAILED else AllIcons.Debugger.NextStatement

    override fun getTooltipText(): String = Glue.htmlTooltip(
        listOfNotNull(
            Glue.pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout),
            Glue.stopPresence(stop, sessions.sessions),
        ).joinToString("\n"),
    )

    override fun getPopupMenuActions(): ActionGroup = sessions.stopActions(stop)

    override fun getClickAction(): AnAction = object : AnAction() {
        override fun actionPerformed(e: AnActionEvent) {
            val popup = JBPopupFactory.getInstance().createActionGroupPopup(
                Glue.pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout),
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
 * The line above a stop, at its indentation: what is about to run, then its controls (**Resume**, **Step**, **Run to
 * caret** and **Finish**; **Resume** alone at a failure) and its code actions as links, which [StopInlayMouse] clicks.
 */
internal class StopInlay(val stop: Glue.ShownStop) : EditorCustomElementRenderer {
    val text = Glue.pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout)

    /** The links after the text, in order. */
    val links: List<Glue.StopLink> = Glue.stopControls(stop) + Glue.stopActions(stop)

    /** A piece of the line, from `x` in the editor's content: the text, or a link. */
    private data class Piece(val x: Int, val width: Int, val text: String, val control: Glue.StopLink?)

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
            for (link in links) {
                x += gap
                add(Piece(x, metrics.stringWidth(link.inlayLabel), link.inlayLabel, link))
                x += metrics.stringWidth(link.inlayLabel)
            }
        }
    }

    /** The pieces of the inlay, above the line it stands on. */
    private fun pieces(inlay: Inlay<*>): List<Piece> = pieces(inlay.editor, inlay.editor.document.getLineNumber(inlay.offset))

    /** The control or code action whose link is at `x` of the editor's content; null elsewhere. */
    fun controlAt(inlay: Inlay<*>, x: Int): Glue.StopLink? =
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

/** The call a watched slot's test is in, at the end of its line, drawn as the count at the caret is. */
internal class RunningLineInlay(val text: String) : EditorCustomElementRenderer by CaretCountInlay(text)

/** The count at the end of the caret's line, in the inlay hints' color. */
internal class CaretCountInlay(val text: String) : EditorCustomElementRenderer {
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

/** A response in Mock a request's list: its method and URL, then its status, type, size and when it finished. */
private class RequestRenderer : ColoredListCellRenderer<StopRequest>() {
    override fun customizeCellRenderer(list: JList<out StopRequest>, value: StopRequest?, index: Int, selected: Boolean, hasFocus: Boolean) {
        value ?: return
        append(Glue.requestLabel(value))
        append("   ${Glue.requestDetails(value)}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
    }
}

/**
 * A click on a control of a stop's inlay runs it; the pointer is a hand over one. Each project's runs listen on every
 * editor: the editors of another project are its own runs'.
 */
private class StopInlayMouse(private val project: Project) : EditorMouseListener, EditorMouseMotionListener {
    /** The editors whose pointer is over a control now. */
    private val hovering = WeakHashMap<Editor, Boolean>()

    private fun controlAt(event: EditorMouseEvent): Pair<StopInlay, Glue.StopLink>? {
        if (event.editor.project != project) return null
        val inlay = event.inlay ?: return null
        val renderer = inlay.renderer as? StopInlay ?: return null
        return renderer.controlAt(inlay, event.mouseEvent.x)?.let { renderer to it }
    }

    override fun mouseClicked(event: EditorMouseEvent) {
        val (renderer, control) = controlAt(event) ?: return
        val sessions = project.getServiceIfCreated(PiwiRunSessions::class.java) ?: return
        event.consume()
        sessions.perform(renderer.stop, control, event.editor)
    }

    override fun mouseMoved(event: EditorMouseEvent) {
        if (event.editor.project != project) return
        val editor = event.editor as? EditorEx ?: return
        val over = controlAt(event) != null
        if ((hovering[editor] ?: false) == over) return
        hovering[editor] = over
        editor.setCustomCursor(StopInlayMouse::class.java, if (over) Cursor.getPredefinedCursor(Cursor.HAND_CURSOR) else null)
    }
}

/**
 * A run control: enabled only while it applies, and, from a key the debugger binds too, only while the debugger does
 * not take that key (`givesWayTo`), so the debugger keeps its keys.
 */
abstract class RunControlAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    abstract fun applies(controls: Glue.RunControls, e: AnActionEvent): Boolean

    /** From the keyboard, the control gives way to these debug sessions: by default to any. */
    open fun givesWayTo(debugSessions: List<XDebugSession>): Boolean = debugSessions.isNotEmpty()

    override fun update(e: AnActionEvent) {
        val project = e.project
        val controls = project?.getServiceIfCreated(PiwiRunSessions::class.java)?.controls()
        val debugging = e.place == ActionPlaces.KEYBOARD_SHORTCUT && project != null &&
            givesWayTo(XDebuggerManager.getInstance(project).debugSessions.toList())
        e.presentation.isEnabled = controls != null && !debugging && applies(controls, e)
    }

    protected fun sessions(e: AnActionEvent): PiwiRunSessions? = e.project?.getServiceIfCreated(PiwiRunSessions::class.java)
}

/**
 * Puts the run controls first among the actions a shortcut runs, so a keymap that gives their key to another action too
 * (the VS Code keymaps' F5, `Debug`; NetBeans' F4, `EditSource`) runs Piwi's while a run is live; a control that does
 * not apply is disabled, and the next action runs.
 */
class PiwiRunActionPromoter : ActionPromoter {
    override fun promote(actions: List<AnAction>, context: DataContext): List<AnAction> {
        val sessions = CommonDataKeys.PROJECT.getData(context)?.getServiceIfCreated(PiwiRunSessions::class.java)
        if (sessions == null || !sessions.controls().active) return emptyList()
        return actions.filter { it is RunControlAction }
    }
}

/** **Pause the run**: every worker of the runs started here stops before its next call; on the debugger's Pause key. */
class PauseRunAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.pausable

    /** The debugger's Pause acts on a running session: Pause gives way to one, not to sessions all suspended. */
    override fun givesWayTo(debugSessions: List<XDebugSession>) = debugSessions.any { !it.isSuspended }

    override fun actionPerformed(e: AnActionEvent) {
        sessions(e)?.pause()
    }
}

/**
 * **Stop the run**: ends the process of the run started here, the only one or the one chosen; a run started in a
 * terminal is the terminal's to stop.
 */
class StopRunAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.stoppable

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val sessions = sessions(e) ?: return
        val stop = { ref: String ->
            if (!sessions.stopRun(ref)) PiwiCommands.notify(project, "The run was not started from this IDE: stop it where it runs.")
        }
        val live = sessions.sessions.values.filter { !it.terminal && it.checkout == null }
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
            .setTitle("Stop which run?")
            .setItemChosenCallback { session -> session.ref?.let(stop) }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }
}

/**
 * A control answering a stop: the one at the caret's line, else the only one, else the one chosen. From the keyboard
 * it gives way only to a suspended debug session, the only kind the debugger's step and resume keys act on.
 */
abstract class StopControlAction(private val control: Glue.StopControl) : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) =
        controls.stopped && (control != Glue.StopControl.RUN_TO_CARET || e.getData(CommonDataKeys.EDITOR) != null)

    override fun givesWayTo(debugSessions: List<XDebugSession>) = debugSessions.any { it.isSuspended }

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        val sessions = sessions(e) ?: return
        sessions.atCaret(editor, { control in Glue.stopControls(it) }, control = true, clicked = e.getData(PiwiRunSessions.STOP)) {
            sessions.perform(it, control, editor)
        }
    }
}

/**
 * **Resume**: the stopped test runs on to the next breakpoint. Its key stays Piwi's `Glue.RESUMED_MILLIS` after an
 * answer, so a second press acts on no other stop and starts no debug session.
 */
class ResumeRunAction : StopControlAction(Glue.StopControl.RESUME) {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) =
        super.applies(controls, e) ||
            (e.place == ActionPlaces.KEYBOARD_SHORTCUT && sessions(e)?.answeredLately() == true)

    /** Held after an answer with no stop to act on, the key does nothing. */
    override fun actionPerformed(e: AnActionEvent) {
        if (sessions(e)?.controls()?.stopped == true) super.actionPerformed(e)
    }
}

/** **Step**: the stopped test stops again before its next call. */
class StepRunAction : StopControlAction(Glue.StopControl.STEP)

/** **Run to the caret**: the stopped test stops at the first call on the caret's line, or at a breakpoint before it. */
class RunToCaretAction : StopControlAction(Glue.StopControl.RUN_TO_CARET)

/** **Finish**: the stopped test runs on without stopping at a breakpoint again in this attempt. */
class FinishRunAction : StopControlAction(Glue.StopControl.FINISH)

/**
 * **End the test**: the stopped test ends there, reported as skipped, its stopped call never run where Piwi holds it;
 * with no shortcut.
 */
class EndTestAction : StopControlAction(Glue.StopControl.END) {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.endable || controls.waiting != null

    /** At a stop, as the other controls; else where a Pause waits for the call a test runs. */
    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        if (sessions.controls().endable) return super.actionPerformed(e)
        val waiting = Glue.waitingWorkers(sessions.sessions)
        if (waiting.size < 2) return waiting.firstOrNull()?.let(sessions::giveUp) ?: Unit
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(waiting)
            .setTitle("End which waiting test?")
            .setRenderer(object : ColoredListCellRenderer<Glue.WaitingWorker>() {
                override fun customizeCellRenderer(list: JList<out Glue.WaitingWorker>, value: Glue.WaitingWorker?, index: Int, selected: Boolean, hasFocus: Boolean) {
                    append(value?.waiting?.title.orEmpty())
                    append("   ${value?.let { Glue.workerName(it.slot) }.orEmpty()}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
            })
            .setItemChosenCallback { sessions.giveUp(it) }
            .createPopup()
            .showInBestPositionFor(e.dataContext)
    }
}

/**
 * **Open the trace so far** of the test the Worker tab watches: Playwright's trace viewer on the machine the run runs
 * on, as the tab's button does; enabled while that test's worker can open it.
 */
class OpenTraceSoFarAction : RunControlAction() {
    /** The Worker tab's slot and its asks are the event thread's. */
    override fun getActionUpdateThread() = ActionUpdateThread.EDT

    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = sessions(e)?.traceOpenable() == true

    override fun actionPerformed(e: AnActionEvent) {
        sessions(e)?.openTrace()
    }
}

/** **Show the paused page**: the page of the stopped test, in the Piwi tool window. */
class ShowPausedPageAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.stopped

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        sessions.atCaret(e.getData(CommonDataKeys.EDITOR), clicked = e.getData(PiwiRunSessions.STOP)) { sessions.showPage(it) }
    }
}

/**
 * **Watch a worker's test**: the page of the test a worker runs, in the Worker tab of the Piwi tool window, for a worker
 * whose reporter shows it: the only one, or the one chosen.
 */
class WatchWorkerAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.watchable

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        chooseWorker(e, "Watch which worker?", Glue.watchableWorkers(sessions.sessions)) { sessions.showWorker(it.ref, it.lane) }
    }
}

/** **Pause and watch a worker's test**: the worker chosen stops before its next call, watched in the Worker tab. */
class PauseAndWatchAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.watchable && controls.pausable

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        val targets = Glue.watchableWorkers(sessions.sessions, pausable = true)
        if (targets.isEmpty()) {
            e.project?.let { PiwiCommands.notify(it, "No running test can be paused and watched.") }
            return
        }
        chooseWorker(e, "Pause and watch which worker?", targets) { sessions.pauseAndWatch(it) }
    }
}

/** The only worker of `targets`, or the one chosen in a popup titled `title`; nothing for none. */
private fun chooseWorker(e: AnActionEvent, title: String, targets: List<Glue.WatchTarget>, then: (Glue.WatchTarget) -> Unit) {
    if (targets.size < 2) return targets.firstOrNull()?.let(then) ?: Unit
    JBPopupFactory.getInstance()
        .createPopupChooserBuilder(targets)
        .setTitle(title)
        .setRenderer(object : ColoredListCellRenderer<Glue.WatchTarget>() {
            override fun customizeCellRenderer(list: JList<out Glue.WatchTarget>, value: Glue.WatchTarget?, index: Int, selected: Boolean, hasFocus: Boolean) {
                append(value?.label.orEmpty())
            }
        })
        .setItemChosenCallback { then(it) }
        .createPopup()
        .showInBestPositionFor(e.dataContext)
}

/** A code action at a stop: the one at the caret's line among those offering it, else the only one, else the one chosen. */
abstract class StopCodeAction(private val action: Glue.StopAction) : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = action in controls.actions

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        sessions.atCaret(e.getData(CommonDataKeys.EDITOR), { action in Glue.stopActions(it) }, clicked = e.getData(PiwiRunSessions.STOP)) {
            sessions.start(it, action)
        }
    }
}

/** **Pick a locator**: the pause bar's pick in the test's window, the locator replacing the one on the stopped line. */
class PickAtStopAction : StopCodeAction(Glue.StopAction.PICK)

/** **Record at the stop**: what is done in the test's window, recorded above the stopped line. */
class RecordAtStopAction : StopCodeAction(Glue.StopAction.RECORD)

/** **Assert**: a check of an element in the test's window, written above the stopped line. */
class AssertAtStopAction : StopCodeAction(Glue.StopAction.ASSERT)

/** **Assert a region**: the ARIA snapshot of a region picked in the test's window, written above the stopped line. */
class AssertRegionAtStopAction : StopCodeAction(Glue.StopAction.ASSERT_REGION)

/** **Mock a request**: a response the test kept, chosen in a list, answered by a route written above the stopped line. */
class MockAtStopAction : StopCodeAction(Glue.StopAction.MOCK)

/**
 * **Share the run live**: the run on the team instance its reporter reports to, for anyone who can open it there, once
 * the person said yes to what it sends (the first time in the project since it opened); a run that cannot be shared
 * says why.
 */
class ShareRunLiveAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.active

    override fun actionPerformed(e: AnActionEvent) {
        sessions(e)?.shareLive(true)
    }
}

/**
 * **Hold failures**: turns the run's Hold failures over: on, a failed test no pause bar shows waits at its line for an
 * answer; off, it goes on at once. The run keeps it whichever surface set it.
 */
class HoldFailuresAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.holdable

    override fun update(e: AnActionEvent) {
        super.update(e)
        val controls = e.project?.getServiceIfCreated(PiwiRunSessions::class.java)?.controls()
        e.presentation.text = Glue.holdActionText(controls ?: Glue.RunControls(active = false, pausable = false, pausing = false, stopped = false))
    }

    override fun actionPerformed(e: AnActionEvent) {
        sessions(e)?.holdFailures()
    }
}

/** **Stop sharing the run live**: once the person confirms, the views of the run on the team instance end, and nothing more goes there. */
class StopSharingRunAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.liveShared

    override fun actionPerformed(e: AnActionEvent) {
        sessions(e)?.shareLive(false)
    }
}

/**
 * **Share this project's runs live until I stop**: each run of the project from now on is shared live until the
 * person stops or the project closes, asked with a warning the first time.
 */
class ShareWindowLiveAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val sessions = e.project?.getServiceIfCreated(PiwiRunSessions::class.java)
        e.presentation.isEnabledAndVisible = e.project != null && sessions?.windowShared != true
    }

    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<PiwiRunSessions>()?.shareWindow(true)
    }
}

/** **Stop sharing this project's runs live**: once the person confirms, every shared run of the project stops being shared. */
class StopSharingWindowLiveAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project?.getServiceIfCreated(PiwiRunSessions::class.java)?.windowShared == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<PiwiRunSessions>()?.shareWindow(false)
    }
}

/**
 * **Show the stopped test's browser**: the window of the stop at the caret's line among those it can show, else the
 * only one, else the one chosen, comes to the front.
 */
class ShowBrowserAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.browserShowable

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        sessions.atCaret(e.getData(CommonDataKeys.EDITOR), Glue::canShowBrowser, clicked = e.getData(PiwiRunSessions.STOP)) { sessions.showBrowser(it) }
    }
}

/**
 * **Share the stopped test's browser with Playwright tools**: the stop at the caret's line among those whose reporter takes it,
 * else the only one, else the one chosen, shared once the person said yes to the warning, until its test ends.
 */
class ShareWithPlaywrightAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.shareable

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        sessions.atCaret(e.getData(CommonDataKeys.EDITOR), Glue::canShare, clicked = e.getData(PiwiRunSessions.STOP)) { sessions.share(it) }
    }
}


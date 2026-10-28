package dev.piwitests.jetbrains

import com.intellij.execution.ExecutionListener
import com.intellij.execution.ExecutionManager
import com.intellij.execution.configurations.RunProfile
import com.intellij.execution.configurations.WrappingRunConfiguration
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionPromoter
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.DefaultActionGroup
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
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.MessageDialogBuilder
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Condition
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.util.Alarm
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.breakpoints.XBreakpoint
import com.intellij.xdebugger.breakpoints.XBreakpointListener
import com.intellij.xdebugger.ui.DebuggerColors
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.Graphics
import java.awt.Rectangle
import java.awt.datatransfer.StringSelection
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.net.URI
import java.nio.file.Path
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.imageio.ImageIO
import javax.imageio.ImageReader
import javax.swing.BoxLayout
import javax.swing.ImageIcon
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * The runs the IDE started, as their workers tell them (`piwi/runSessionChanged`), shown and steered with Piwi's own
 * actions, no debug session: the latest session of each run, kept until it ends. A stop opens its file at its line,
 * marked as the execution point (a range highlighter in [EXECUTION_POINT], the debugger's colors by default, with an
 * arrow in the gutter, a failure's icon at a failure, whose click offers the controls), with a block inlay above it
 * saying what is about to run, or how the test failed, and offering **Resume**, **Step**, **Run to Caret** and
 * **Finish**, then the code actions its worker takes there (`piwi/stopAction`: **Pick a Locator**, **Record Here**,
 * **Assert**, **Assert a Region**, **Mock a Request**); a stop no pause bar shows (a headless run's) shows an image of
 * its page in the Piwi tool window's **Paused Page** tab, where a click picks the element under it (`piwi/pickAt`)
 * when its worker takes it. The code a stop makes (`piwi/stopCode`) is written in one
 * command in its document, in an editor, so the service hears it; while a test is stopped, the end of the caret's line
 * in its file says how many elements the locator there matches on the stopped page (`piwi/locatorAtCaret`). The IDE's
 * breakpoints go to each live run as they change (`XBreakpointListener`, `piwi/setRunBreakpoints`), filtered as a
 * run's start filters them. A run's lines are those of the documents as they stood when it started: the edits since
 * (`Glue.EditLog`) bring a stop to the line it stands on now, and a breakpoint or the caret's line back to the run's.
 * **Stop** ends the process of the run, which Piwi started, in the console or the IDE's Playwright runner, whose reruns
 * and debug runs it follows too. The pure half is `Glue.withSession`, `Glue.runControls` and their kin.
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
     * The stops whose file was opened at their line, whose page was shown, and what is drawn of each, by
     * `Glue.stopKey`; the files of stops refreshed from disk once, by URI. On the event thread.
     */
    private val revealed = HashSet<String>()
    private val paged = HashSet<String>()
    private val drawn = HashMap<String, DrawnStop>()
    private val refreshed = HashSet<String>()

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

        override fun commandEnded(params: CommandEndedParams) {
            // The run may end after the plugin was unloaded: its service is then gone.
            if (!project.isDisposed) project.getServiceIfCreated(PiwiProjectService::class.java)?.server()?.commandEnded(params)
        }
    }

    /** How Mock a Request has the response to mock chosen among those a stop lists: a popup, which the tests replace. */
    internal var chooseRequest: (List<StopRequest>, (StopRequest) -> Unit) -> Unit = { requests, chosen ->
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(requests)
            .setRenderer(RequestRenderer())
            .setNamerForFiltering { it.url.orEmpty() }
            .setTitle("Mock Which Response?")
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
        // The breakpoints changed between the run's start and its first worker.
        if (fresh) breakpointsChanged()
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
                        forgetEdits()
                    }
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

    /** The IDE's breakpoints to each live run whose breakpoints differ, off the event thread, once for a burst. */
    fun breakpointsChanged() {
        if (sessions.isEmpty() || !breakpointsQueued.compareAndSet(false, true)) return
        AppExecutorUtil.getAppScheduledExecutorService().schedule(
            {
                breakpointsQueued.set(false)
                if (gone.value(null)) return@schedule
                val breakpoints = project.service<PiwiProjectService>().breakpoints()
                val updates = synchronized(lock) { Glue.breakpointUpdates(sessions, breakpoints, runs, edits) }
                updates.forEach { remote.setBreakpoints(it) }
            },
            BREAKPOINTS_WAIT_MILLIS,
            TimeUnit.MILLISECONDS,
        )
    }

    /**
     * Draw each stop at the line it stands on now: its file opened at its line the first time, its execution point and
     * an inlay in each editor of its file; a stop no pause bar shows, its page in the Paused Page tab, whether its file
     * is found or not. A file the IDE has not read yet is looked for on disk off the event thread, then drawn. What a
     * stop that went on drew goes. On the event thread.
     */
    private fun draw() {
        val stops = stops()
        val keys = stops.map(Glue::stopKey).toSet()
        for (key in drawn.keys - keys) drawn.remove(key)?.dispose()
        revealed.retainAll(keys)
        paged.retainAll(keys)
        refreshed.retainAll(stops.mapNotNull { it.stop.uri }.toSet())
        for (stop in stops) {
            val key = Glue.stopKey(stop)
            val file = fileOf(stop.stop.uri)
            if (file == null) refresh(stop.stop.uri)
            if (file != null && revealed.add(key)) {
                OpenFileDescriptor(project, file, stop.stop.line, stop.stop.character ?: 0).navigate(true)
            }
            if (!stop.stop.bar && paged.add(key)) showPage(stop)
            if (file == null) continue
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

    /** What the execution points, the inlays and the Paused Page tab show now, which the tests read. On the event thread. */
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
    )

    /** A click at `x`, `y` of the Paused Page tab's image, as a person's click reaches it, which the tests send. */
    internal fun clickPage(x: Int, y: Int) {
        (livePage()?.component as? PausedPagePanel)?.click(x, y)
    }

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
            val picture = Glue.pausedImageBytes(image)?.let(::decode)
            ApplicationManager.getApplication().invokeLater({
                if (pageStop != key) return@invokeLater
                if (picture == null) return@invokeLater panel.show("$caption · the test sent no image of its page", null)
                val pick = image?.takeIf { Glue.picksOnImage(stop.takes, it) }
                    ?.let { shown -> { x: Int, y: Int -> pickOnImage(stop, shown, panel, picture, x, y) } }
                panel.show(caption, picture, pick)
            }, gone)
        }
    }

    /**
     * A click at `x`, `y` of a stop's image in the Paused Page tab: the element under it picked on the stopped page
     * (`piwi/pickAt`, in CSS pixels of its viewport) off the event thread, its locator going to the editor in place of
     * the one on the stopped line as the pause bar's pick does; the answer said under the caption while the tab shows
     * the same image. On the event thread.
     */
    private fun pickOnImage(stop: Glue.ShownStop, image: PausedImage, panel: PausedPagePanel, picture: BufferedImage, x: Int, y: Int) {
        val (pageX, pageY) = Glue.pagePoint(x, y, picture.width, picture.height, image) ?: return
        panel.note("Picking the element under the click…")
        ApplicationManager.getApplication().executeOnPooledThread {
            val answer = remote.pickAt(PickAtParams(stop.ref, stop.worker, stop.stop.since ?: "", pageX, pageY))
            ApplicationManager.getApplication().invokeLater({
                if (panel.image === picture) panel.note(answer?.message ?: "The editor service did not answer.")
            }, gone)
        }
    }

    /**
     * Answer a stop (`resume`, `step`, `finish`, or `run-to` the `place`, a line of the run's code), naming it, off the
     * event thread, saying why not.
     */
    fun answer(stop: Glue.ShownStop, action: String, place: EditorBreakpoint? = null) {
        control(RunControlParams(stop.ref, stop.worker, action, place, stop.stop.since))
    }

    /** Pause every run started here: each of its workers stops before its next call. */
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

    /**
     * Run `action` on the stop the caret of `editor` is at, else the only one, else the one chosen; among those `offers`
     * keeps, when it keeps any. On the event thread.
     */
    fun atCaret(editor: Editor?, offers: (Glue.ShownStop) -> Boolean = { true }, action: (Glue.ShownStop) -> Unit) {
        val uri = editor?.virtualFile?.let { fileUri(it) }
        val all = stops()
        val candidates = Glue.stopsFor(all.filter(offers).ifEmpty { all }, uri, editor?.caretModel?.logicalPosition?.line)
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

    /** Run to the caret's line of `editor` from `stop`: the line as the run's code has it, which edits since may move. */
    fun runTo(stop: Glue.ShownStop, editor: Editor?) {
        val uri = editor?.virtualFile?.let { fileUri(it) } ?: return PiwiCommands.notify(project, "Place the caret on the line to run to.")
        val caret = editor.caretModel.logicalPosition.line
        val line = synchronized(lock) { edits.back(Glue.fileKey(uri), caret, sinceOf(stop.ref)) }
            ?: return PiwiCommands.notify(project, "The caret's line changed since the run started, so the running test has no line to stop at there.")
        answer(stop, "run-to", EditorBreakpoint(uri, line))
    }

    /** The actions offered at a stop, which act on it: its controls, the paused page, then its code actions. */
    fun stopActions(stop: Glue.ShownStop): ActionGroup = DefaultActionGroup().apply {
        for (control in Glue.stopControls(stop.stop)) {
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
        val actions = Glue.stopActions(stop)
        if (actions.isNotEmpty()) addSeparator()
        for (action in actions) {
            add(
                object : DumbAwareAction(action.label) {
                    override fun getActionUpdateThread() = ActionUpdateThread.BGT

                    override fun actionPerformed(e: AnActionEvent) = start(stop, action)
                },
            )
        }
        if (Glue.canShare(stop)) {
            addSeparator()
            add(
                object : DumbAwareAction(SHARE_WITH_PLAYWRIGHT) {
                    override fun getActionUpdateThread() = ActionUpdateThread.BGT

                    override fun actionPerformed(e: AnActionEvent) = share(stop)
                },
            )
        }
    }

    /**
     * Share a stop's browser with Playwright's own tools until its test ends, once the person said yes to the warning,
     * on the event thread: the answer names the command that joins it, to copy, and offers to stop sharing.
     */
    fun share(stop: Glue.ShownStop) {
        val since = stop.stop.since ?: return PiwiCommands.notify(project, "The test went on.")
        val yes = MessageDialogBuilder.yesNo("Share the Stopped Browser with Playwright Tools?", Glue.SHARE_WARNING)
            .yesText("Share")
            .noText("Cancel")
            .ask(project)
        if (!yes) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val shared = remote.bind(StopBindParams(stop.ref, stop.worker, since, true))
            val command = shared?.command
            if (shared == null) return@executeOnPooledThread PiwiCommands.notify(project, "The editor service did not answer.", NotificationType.WARNING)
            if (!shared.ok || command == null) return@executeOnPooledThread PiwiCommands.notify(project, shared.message.orEmpty())
            NotificationGroupManager.getInstance().getNotificationGroup("Piwi")
                .createNotification(Glue.sharedText(shared), NotificationType.WARNING)
                .addAction(NotificationAction.createSimpleExpiring("Copy the Command") {
                    CopyPasteManager.getInstance().setContents(java.awt.datatransfer.StringSelection(command))
                })
                .addAction(NotificationAction.createSimpleExpiring("Stop Sharing") {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        val stopped = remote.bind(StopBindParams(stop.ref, stop.worker, since, false))
                        PiwiCommands.notify(project, stopped?.message ?: "The editor service did not answer.")
                    }
                })
                .notify(project)
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
     * Start a code action at a stop, off the event thread: Mock a Request lists the responses the test kept first, the
     * latest first, to choose the one to mock. The code comes in `piwi/stopCode`, which says what it wrote; the other
     * answers are said here.
     */
    fun start(stop: Glue.ShownStop, action: Glue.StopAction, request: Int? = null) {
        val since = stop.stop.since ?: return PiwiCommands.notify(project, "The test went on.")
        ApplicationManager.getApplication().executeOnPooledThread {
            if (action == Glue.StopAction.MOCK && request == null) {
                val listed = remote.requests(StopRequestsParams(stop.ref, stop.worker, since))
                val requests = Glue.requestsToMock(listed?.requests)
                return@executeOnPooledThread when {
                    listed == null -> PiwiCommands.notify(project, "The editor service did not answer.", NotificationType.WARNING)
                    !listed.ok || requests.isEmpty() -> PiwiCommands.notify(project, listed.message ?: "The test kept no response.")
                    else -> ApplicationManager.getApplication().invokeLater({ chooseRequest(requests) { start(stop, action, it.id) } }, gone)
                }
            }
            val result = remote.action(StopActionParams(stop.ref, stop.worker, since, action.action, request))
            when {
                result == null -> PiwiCommands.notify(project, "The editor service did not answer.", NotificationType.WARNING)
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
        WriteCommandAction.runWriteCommandAction(project, "Write the Code Made at the Stop", null, {
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

    /** Why the code a stop made was not written, with the code to copy. */
    private fun notWritten(code: StopCode, why: String) {
        NotificationGroupManager.getInstance().getNotificationGroup("Piwi").createNotification(why, NotificationType.WARNING)
            .addAction(NotificationAction.createSimpleExpiring("Copy the Code") { CopyPasteManager.getInstance().setContents(StringSelection(code.code.orEmpty())) })
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
        disposed = true
        listeners.clear()
        processes.clear()
        val shown = drawn.values.toList()
        drawn.clear()
        val count = caretInlay
        caretInlay = null
        val remove = {
            shown.forEach { it.dispose() }
            count?.let { if (it.isValid) Disposer.dispose(it) }
        }
        if (ApplicationManager.getApplication().isDispatchThread) remove() else ApplicationManager.getApplication().invokeLater { remove() }
    }

    companion object {
        /** The paused line: **Settings → Editor → Color Scheme → Piwi**, the debugger's execution point by default. */
        val EXECUTION_POINT: TextAttributesKey =
            TextAttributesKey.createTextAttributesKey("PIWI_EXECUTION_POINT", DebuggerColors.EXECUTIONPOINT_ATTRIBUTES)

        const val PAUSED_PAGE = "Paused Page"
        const val SHOW_PAUSED_PAGE = "Show the Paused Page"
        const val SHARE_WITH_PLAYWRIGHT = "Share with Playwright Tools"

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

/** What a run's controls and code actions ask of the editor service. */
internal interface RunRemote {
    fun control(params: RunControlParams): RunControlResult?

    fun pausedPage(params: PausedPageParams): PausedPageResult?

    fun pickAt(params: PickAtParams): PickAtResult?

    fun action(params: StopActionParams): RunControlResult?

    fun requests(params: StopRequestsParams): StopRequestsResult?

    fun bind(params: StopBindParams): StopBindResult?

    fun locatorAtCaret(params: LocatorAtCaretParams): LocatorAtCaretResult?

    /** The version of `document` the IDE gave the service, which a stop's code names when it was placed in that text. */
    fun documentVersion(document: Document): Int?

    fun setBreakpoints(params: SetRunBreakpointsParams)

    fun commandEnded(params: CommandEndedParams)
}

/**
 * The page of a stopped test, under what it is about to run: the Paused Page tab of the Piwi tool window. Where a click
 * on the image picks, a hint says so above it and the cursor is a crosshair over it; what the pick came to shows
 * under the caption.
 */
private class PausedPagePanel : JPanel(BorderLayout()) {
    private val label = JBLabel().apply { border = JBUI.Borders.empty(4, 8, 0, 8) }
    private val hint = JBLabel(Glue.PICK_HINT).apply {
        border = JBUI.Borders.empty(2, 8, 0, 8)
        foreground = UIUtil.getContextHelpForeground()
        isVisible = false
    }
    private val noteLabel = JBLabel().apply {
        border = JBUI.Borders.empty(2, 8, 0, 8)
        isVisible = false
    }
    private val picture = JBLabel().apply {
        horizontalAlignment = SwingConstants.LEFT
        verticalAlignment = SwingConstants.TOP
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
        val header = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.emptyBottom(4)
            add(label)
            add(hint)
            add(noteLabel)
        }
        add(header, BorderLayout.NORTH)
        add(JBScrollPane(picture), BorderLayout.CENTER)
        picture.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.button == MouseEvent.BUTTON1) click(e.x, e.y)
            }
        })
    }

    fun show(caption: String, image: BufferedImage?, pick: ((Int, Int) -> Unit)? = null) {
        this.caption = caption
        this.image = image
        this.pick = pick.takeIf { image != null }
        label.text = caption
        picture.icon = image?.let { ImageIcon(it) }
        hint.isVisible = picks
        picture.cursor = if (picks) Cursor.getPredefinedCursor(Cursor.CROSSHAIR_CURSOR) else Cursor.getDefaultCursor()
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

/** The arrow in the gutter at a stop: what is about to run, and on a click the controls, which act on that stop. */
private class ExecutionPointGutter(private val sessions: PiwiRunSessions, private val stop: Glue.ShownStop) : GutterIconRenderer(), DumbAware {
    override fun getIcon() = if (Glue.isFailure(stop.stop)) AllIcons.RunConfigurations.TestError else AllIcons.Debugger.NextStatement

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
 * The line above a stop, at its indentation: what is about to run, then its controls (**Resume**, **Step**, **Run to
 * Caret** and **Finish**; **Resume** alone at a failure) and its code actions as links, which [StopInlayMouse] clicks.
 */
internal class StopInlay(val stop: Glue.ShownStop) : EditorCustomElementRenderer {
    val text = Glue.pausedText(stop.stop, stop.test)

    /** The links after the text, in order. */
    val links: List<Glue.StopLink> = Glue.stopControls(stop.stop) + Glue.stopActions(stop)

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

/** A response in Mock a Request's list: its method and URL, then its status, type, size and when it finished. */
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
            XDebuggerManager.getInstance(project).debugSessions.isNotEmpty()
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

/** A code action at a stop: the one at the caret's line among those offering it, else the only one, else the one chosen. */
abstract class StopCodeAction(private val action: Glue.StopAction) : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = action in controls.actions

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        sessions.atCaret(e.getData(CommonDataKeys.EDITOR), { action in Glue.stopActions(it) }) { sessions.start(it, action) }
    }
}

/** **Pick a Locator**: the pause bar's pick in the test's window, the locator replacing the one on the stopped line. */
class PickAtStopAction : StopCodeAction(Glue.StopAction.PICK)

/** **Record Here**: what is done in the test's window, recorded above the stopped line. */
class RecordAtStopAction : StopCodeAction(Glue.StopAction.RECORD)

/** **Assert**: a check of an element in the test's window, written above the stopped line. */
class AssertAtStopAction : StopCodeAction(Glue.StopAction.ASSERT)

/** **Assert a Region**: the ARIA snapshot of a region picked in the test's window, written above the stopped line. */
class AssertRegionAtStopAction : StopCodeAction(Glue.StopAction.ASSERT_REGION)

/** **Mock a Request**: a response the test kept, chosen in a list, answered by a route written above the stopped line. */
class MockAtStopAction : StopCodeAction(Glue.StopAction.MOCK)

/**
 * **Share the Stopped Browser with Playwright Tools**: the stop at the caret's line among those whose reporter takes it,
 * else the only one, else the one chosen, shared once the person said yes to the warning, until its test ends.
 */
class ShareWithPlaywrightAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.shareable

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        sessions.atCaret(e.getData(CommonDataKeys.EDITOR), Glue::canShare) { sessions.share(it) }
    }
}


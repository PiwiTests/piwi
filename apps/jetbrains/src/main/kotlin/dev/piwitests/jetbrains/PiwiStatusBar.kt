package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.ide.DataManager
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.AnimatedIcon
import com.intellij.ui.ClickListener
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.NamedColorUtil
import java.awt.Point
import java.awt.datatransfer.StringSelection
import java.awt.event.MouseEvent
import com.intellij.xdebugger.XDebugSession
import javax.swing.Icon
import javax.swing.JComponent

/**
 * The latest run on the checked-out branch, or the run in progress, of the Playwright config the selected file belongs
 * to, in the status bar: an icon and the text, in the error color while its tests fail, and a click opens a popup of
 * Piwi's actions. While a recording runs, its state and step count; while a run started here is stopped, where.
 */
class PiwiStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = ID

    override fun getDisplayName() = "Piwi"

    override fun isAvailable(project: Project) = project.service<PiwiProjectService>().hasPlaywrightConfig()

    override fun createWidget(project: Project): StatusBarWidget = PiwiStatusBarWidget(project)

    override fun disposeWidget(widget: StatusBarWidget) = Disposer.dispose(widget)

    override fun canBeEnabledOn(statusBar: StatusBar) = true

    companion object {
        const val ID = "piwi.status"
    }
}

/**
 * The status bar item: a label with the icon and the text of `Glue.statusView` for the context of the selected
 * editor's file (`Glue.statusContext`), drawn again when the service's answers, a recording, a run's stops or the
 * selected editor change. A click opens the popup of [actions] above it.
 */
class PiwiStatusBarWidget(private val project: Project) : CustomStatusBarWidget {
    private val label = StatusLabel()

    init {
        object : ClickListener() {
            override fun onClick(event: MouseEvent, clickCount: Int): Boolean {
                showPopup()
                return true
            }
        }.installOn(label, true)
    }

    override fun ID() = PiwiStatusBarWidgetFactory.ID

    override fun getComponent(): JComponent = label

    override fun install(statusBar: StatusBar) {
        val service = service()
        service.onChange(this) {
            update()
            if (!service.status?.contexts.orEmpty().none { it.connected }) CopyMcpConfigurationAction.offer(project)
        }
        service.refreshStatus()
        project.service<PiwiRecordings>().onChange(this) { update() }
        project.service<PiwiRunSessions>().onChange(this) { update() }
        project.messageBus.connect(this).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) = update()
            },
        )
        update()
    }

    private fun service() = project.service<PiwiProjectService>()

    private fun view() = service().let {
        Glue.statusView(it.status, it.runs, it.local().desktop, startProblem = it.startProblem, file = shownFile(project), trusted = it.trusted())
    }

    private fun recording() = project.getServiceIfCreated(PiwiRecordings::class.java)?.current()

    private fun runs() = project.getServiceIfCreated(PiwiRunSessions::class.java)

    /**
     * Draws the item again: the recording in progress, where a run started here is stopped or that it is pausing, that
     * it is shared live and how many watch it, how far it is, `Piwi: refreshing…` while the latest run is read again,
     * else the view of the selected file's context, with its icon and, while its tests fail, the error color. A run's
     * tooltip says what each worker runs now (`Glue.workersNowText`) and who else has it open. On the event thread.
     */
    fun update() {
        val recording = recording()
        val stopped = runs()?.let { Glue.runControlStatus(it.controls(), it.stops()) }
        val shared = runs()?.let { Glue.liveStatus(it.controls(), it.windowShared) }
        val sharedLive = runs()?.let { Glue.sharedLive(it.sessions) }
        val progress = runs()?.let { Glue.runProgressText(it.sessions) }
        // What each worker runs now and who else has the runs open, said in the tooltip of a run's state.
        val workers = runs()?.let { Glue.workersNowText(it.sessions) }?.let { "\n$it" }.orEmpty()
        val present = workers + runs()?.let { Glue.runsPresenceText(it.sessions) }?.let { "\n$it" }.orEmpty()
        val refreshing = service().refreshing
        val view = view()
        label.text = when {
            recording != null -> Glue.recordingStatus(recording.state, recording.steps, recording.edited, recording.stopping)
            stopped != null -> Glue.withProgress(stopped, progress)
            shared != null -> Glue.withProgress(shared, progress)
            progress != null -> progress
            refreshing -> Glue.REFRESHING
            else -> view.text
        }
        label.icon = when {
            recording != null -> PIWI_ICON
            // A held failure shows the error's icon, any other stop the pause's.
            stopped != null -> if (runs()?.let { Glue.heldFailuresOnly(it.stops()) } == true) PiwiIcons.FAILED else AllIcons.Actions.Pause
            shared != null -> PiwiIcons.LIVE
            progress != null -> AnimatedIcon.Default.INSTANCE
            refreshing -> AnimatedIcon.Default.INSTANCE
            else -> icon(view.icon)
        }
        label.error = when {
            recording != null || stopped != null || shared != null -> false
            progress != null -> runs()?.let { Glue.runsFailing(it.sessions) } == true
            else -> !refreshing && view.error
        }
        label.toolTipText = Glue.htmlTooltip(
            recording?.let { "${it.view.text}\nClick to go to the recorded lines or to control the recording." }
                ?: stopped?.let { "$it$present\nClick for the run's controls." }
                ?: sharedLive?.let { "${Glue.sharedLiveText(it)}$present\nClick for the run's controls." }
                ?: progress?.let { "$it$present\nClick for the run's controls." }
                ?: view.tooltip,
        )
    }

    private fun icon(icon: Glue.StatusIcon): Icon = when (icon) {
        Glue.StatusIcon.PIWI -> PIWI_ICON
        Glue.StatusIcon.CONNECT -> PiwiIcons.CONNECT
        Glue.StatusIcon.UNREACHABLE -> AllIcons.Actions.OfflineMode
        Glue.StatusIcon.RUNNING -> AnimatedIcon.Default.INSTANCE
        Glue.StatusIcon.FAILING -> PiwiIcons.FAILED
        Glue.StatusIcon.PASSED -> AllIcons.RunConfigurations.TestPassed
        Glue.StatusIcon.WARNING -> AllIcons.General.Warning
    }

    /**
     * The popup's actions: while a run started here is live, each stop, named as the choice among several names it,
     * which goes to its line, and the run's controls; while a run is shared live, the share's own entries
     * (`Glue.liveMenu`: the run page, its link, Stop sharing…), first while the item shows the share; then what the
     * item's state calls for (going to the recorded lines while a recording runs, with its controls), then the failing
     * tests, the failures, the dashboard and the baseline, the test at the caret and Record here, then Reload Piwi,
     * Connect and the settings. The registered actions keep their own logic, and the popup leaves out those that do not
     * apply.
     */
    fun actions(): ActionGroup {
        val manager = ActionManager.getInstance()
        val first: AnAction? = if (recording() != null) {
            manager.getAction("Piwi.GoToRecordedLines")
        } else {
            when (view().action) {
                Glue.StatusAction.REFRESH -> manager.getAction("Piwi.RefreshRun")
                Glue.StatusAction.RETRY -> manager.getAction("Piwi.Refresh")
                Glue.StatusAction.CONNECT -> manager.getAction("Piwi.Connect")
                Glue.StatusAction.NODE_SETTINGS -> manager.getAction("Piwi.NodeSettings")
                Glue.StatusAction.SETTINGS -> manager.getAction("Piwi.OpenSettings")
                Glue.StatusAction.NONE -> null
            }
        }
        fun registered(vararg ids: String) = ids.mapNotNull { manager.getAction(it) }.filter { it !== first }
        val runs = runs()
        val live = runs?.let { Glue.liveMenu(it.sessions, it.windowShared) }.orEmpty()
        // The share leads while the item shows it: neither a recording nor a stop does.
        val shareShown = recording() == null && runs?.let { Glue.runControlStatus(it.controls(), it.stops()) } == null
        return DefaultActionGroup().apply {
            fun addLive() {
                if (live.isEmpty()) return
                addAll(live.map { LiveEntryAction(it) })
                addSeparator()
            }
            if (shareShown) addLive()
            if (runs?.controls()?.active == true) {
                val stops = runs.stops()
                // Each stop as the registered Go to the stopped line, acting on it (`STOP`), named as the choice names it.
                stops.forEach { stop ->
                    val icon = if (Glue.isFailure(stop.stop)) PiwiIcons.FAILED else AllIcons.Debugger.NextStatement
                    val presence = listOfNotNull("Go to the line the test is stopped at", Glue.stopPresence(stop, runs.sessions))
                    registeredWith("Piwi.ShowStop", Glue.stopLabel(stop), icon, presence.joinToString(". ")) {
                        it.add(PiwiRunSessions.STOP, stop)
                    }?.let(::add)
                }
                if (stops.isNotEmpty()) addSeparator()
                // The share's own entries already stop it: their Stop sharing rows are not offered twice.
                addAll(registered(*RUN_ACTIONS).filter { live.isEmpty() || manager.getId(it) !in SHARE_STOPS })
                addSeparator()
            }
            if (!shareShown) addLive()
            if (first != null) {
                add(first)
                addAll(registered("Piwi.PauseRecording", "Piwi.ResumeRecording", "Piwi.StopRecording"))
                addSeparator()
            }
            // One entry per page: a run's page the share's entries open is not offered twice, nor the run in progress
            // Open the latest run would open; Open in dashboard is the editor's and the tree's.
            val opened = live.filter { it.kind == Glue.LiveEntryKind.OPEN_PAGE }.mapNotNull { it.ref }.toSet()
            val pages = runs?.sessions?.let { Glue.runPages(it) }.orEmpty().filter { (ref, _) -> ref !in opened }
            for ((_, page) in pages) {
                registeredWith("Piwi.OpenRunPage", "Open run #${page.id}") { it.add(RUN_PAGE, page) }?.let(::add)
            }
            val pageUrls = pages.map { (_, page) -> page.url } + live.mapNotNull { it.url }
            val running = Glue.liveRun(service().status, service().runs, shownFile(project))?.url
            addAll(registered("Piwi.RerunFailing"))
            addAll(registered("Piwi.OpenFailures"))
            if (running == null || running !in pageUrls) addAll(registered("Piwi.OpenLatestRun"))
            addAll(registered("Piwi.CompareWith"))
            addSeparator()
            addAll(registered("Piwi.RunTestAtCursor", "Piwi.RecordHere"))
            addSeparator()
            addAll(registered("Piwi.Refresh", "Piwi.Connect", "Piwi.OpenSettings"))
        }
    }

    /** Opens the popup of [actions] above the item, with the data of the selected editor: its file and its caret. */
    private fun showPopup() {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor
        val context = DataManager.getInstance().getDataContext(editor?.contentComponent ?: label)
        val popup = JBPopupFactory.getInstance().createActionGroupPopup(
            "Piwi",
            actions(),
            context,
            JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
            false,
            ActionPlaces.STATUS_BAR_PLACE,
        )
        popup.show(RelativePoint(label, Point(0, -popup.content.preferredSize.height)))
    }

    /**
     * An entry of the menu on a share (`Glue.liveMenu`): the run page opened in the browser, its link copied, or the
     * share stopped once the person confirms (`PiwiRunSessions.shareLive`, `shareWindow`).
     */
    private inner class LiveEntryAction(private val entry: Glue.LiveEntry) : DumbAwareAction(
        entry.label,
        null,
        when (entry.kind) {
            Glue.LiveEntryKind.OPEN_PAGE -> AllIcons.General.Web
            Glue.LiveEntryKind.COPY_LINK -> AllIcons.Actions.Copy
            Glue.LiveEntryKind.STOP_SHARING, Glue.LiveEntryKind.STOP_SHARING_PROJECT -> PiwiIcons.STOP_LIVE
        },
    ) {
        init {
            templatePresentation.setText(entry.label, false)
        }

        override fun getActionUpdateThread() = ActionUpdateThread.BGT

        override fun actionPerformed(e: AnActionEvent) {
            when (entry.kind) {
                Glue.LiveEntryKind.OPEN_PAGE -> entry.url?.let { BrowserUtil.browse(it) }
                Glue.LiveEntryKind.COPY_LINK -> entry.url?.let { CopyPasteManager.getInstance().setContents(StringSelection(it)) }
                Glue.LiveEntryKind.STOP_SHARING -> runs()?.shareLive(false, entry.ref)
                Glue.LiveEntryKind.STOP_SHARING_PROJECT -> runs()?.shareWindow(false)
            }
        }
    }

    companion object {
        /**
         * The `Piwi.RunControl` group's actions, in its order (its controls, the page, the code actions, sharing, Stop),
         * which Tools → Piwi and this popup both list while a run is live.
         */
        val RUN_ACTIONS = arrayOf(
            "Piwi.PauseRun", "Piwi.ResumeRun", "Piwi.StepRun", "Piwi.RunToCaret", "Piwi.FinishRun", "Piwi.EndTest",
            "Piwi.ShowPausedPage", "Piwi.WatchWorker", "Piwi.PauseAndWatch", "Piwi.OpenTraceSoFar", "Piwi.PickAtStop",
            "Piwi.RecordAtStop", "Piwi.AssertAtStop", "Piwi.AssertRegionAtStop", "Piwi.MockAtStop", "Piwi.ShowBrowser",
            "Piwi.ShareWithPlaywright", "Piwi.ShareRunLive", "Piwi.StopSharingRun", "Piwi.ShareWindowLive",
            "Piwi.StopSharingWindowLive", "Piwi.HoldFailures", "Piwi.StopRun",
        )

        /** The run actions the share's own entries stand for while they show. */
        val SHARE_STOPS = setOf("Piwi.StopSharingRun", "Piwi.StopSharingWindowLive")

        /** The path of the selected editor's file, whose Playwright config the item speaks for; null with none open. */
        fun shownFile(project: Project): String? = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?.path
    }
}

/** Piwi's icon, the tool window's. */
private val PIWI_ICON: Icon = IconLoader.getIcon("/icons/piwi.svg", PiwiStatusBarWidget::class.java)

/**
 * The item's label: an icon and a text in the status bar's font and insets, the text in the status bar's foreground,
 * or the error foreground with [error]; both are theme colors.
 */
internal class StatusLabel : JBLabel() {
    var error = false
        set(value) {
            field = value
            foreground = if (value) NamedColorUtil.getErrorForeground() else JBUI.CurrentTheme.StatusBar.Widget.FOREGROUND
        }

    init {
        error = false
    }

    override fun updateUI() {
        super.updateUI()
        font = JBUI.CurrentTheme.StatusBar.font()
        border = JBUI.CurrentTheme.StatusBar.Widget.border()
    }
}

/** **Open the failures**: the Piwi tool window, as a run's notification opens it. */
class OpenFailuresAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID)?.activate(null)
    }
}

/** **Node.js settings…**: the interpreter the editor service starts with, the service started again once closed. */
class NodeSettingsAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<PiwiProjectService>()?.openNodeSettings()
    }
}

/** **Go to the recorded lines**: the block the recording in progress writes; enabled only while one runs. */
class GoToRecordedLinesAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    private fun recording(e: AnActionEvent) = e.project?.getServiceIfCreated(PiwiRecordings::class.java)?.current()

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = recording(e) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val recording = recording(e) ?: return
        OpenFileDescriptor(project, recording.file, recording.blockStart() ?: 0).navigate(true)
    }
}

/**
 * **Go to the stopped line**: the line a test is stopped at, its file opened with the focus, a stop whose file was left
 * closed included: the stop a popup names (`STOP`), else the one at the caret's line, else the only one, else the one
 * chosen; on the debugger's Show Execution Point key.
 */
class ShowStopAction : RunControlAction() {
    override fun applies(controls: Glue.RunControls, e: AnActionEvent) = controls.stopped

    /** Show Execution Point acts on a suspended debug session alone: the key is Piwi's otherwise. */
    override fun givesWayTo(debugSessions: List<XDebugSession>) = debugSessions.any { it.isSuspended }

    override fun actionPerformed(e: AnActionEvent) {
        val sessions = sessions(e) ?: return
        sessions.atCaret(e.getData(CommonDataKeys.EDITOR), clicked = e.getData(PiwiRunSessions.STOP)) { sessions.goTo(it) }
    }
}

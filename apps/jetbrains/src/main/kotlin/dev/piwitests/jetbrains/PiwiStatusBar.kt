package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.DataManager
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
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
import java.awt.event.MouseEvent
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
        Glue.statusView(it.status, it.runs, it.local().desktop, startProblem = it.startProblem, file = shownFile(project))
    }

    private fun recording() = project.getServiceIfCreated(PiwiRecordings::class.java)?.current()

    private fun runs() = project.getServiceIfCreated(PiwiRunSessions::class.java)

    /**
     * Draws the item again: the recording in progress, where a run started here is stopped or that it is pausing,
     * `Piwi: refreshing…` while the latest run is read again, else the view of the selected file's context, with its icon
     * and, while its tests fail, the error color. On the event thread.
     */
    fun update() {
        val recording = recording()
        val stopped = runs()?.let { Glue.runControlStatus(it.controls(), it.stops()) }
        val refreshing = service().refreshing
        val view = view()
        label.text = when {
            recording != null -> Glue.recordingStatus(recording.state, recording.steps, recording.edited, recording.stopping)
            stopped != null -> stopped
            refreshing -> Glue.REFRESHING
            else -> view.text
        }
        label.icon = when {
            recording != null -> PIWI_ICON
            stopped != null -> AllIcons.Actions.Pause
            refreshing -> AnimatedIcon.Default.INSTANCE
            else -> icon(view.icon)
        }
        label.error = recording == null && stopped == null && !refreshing && view.error
        label.toolTipText = Glue.htmlTooltip(
            recording?.let { "${it.view.text}\nClick to go to the recorded lines or to control the recording." }
                ?: stopped?.let { "$it\nClick for the run's controls." }
                ?: view.tooltip,
        )
    }

    private fun icon(icon: Glue.StatusIcon): Icon = when (icon) {
        Glue.StatusIcon.PIWI -> PIWI_ICON
        Glue.StatusIcon.CONNECT -> AllIcons.General.User
        Glue.StatusIcon.UNREACHABLE -> AllIcons.Actions.OfflineMode
        Glue.StatusIcon.RUNNING -> AnimatedIcon.Default.INSTANCE
        Glue.StatusIcon.FAILING -> AllIcons.RunConfigurations.TestFailed
        Glue.StatusIcon.PASSED -> AllIcons.RunConfigurations.TestPassed
        Glue.StatusIcon.WARNING -> AllIcons.General.Warning
    }

    /**
     * The popup's actions: the controls of a run started here while one is live, then what the item's state calls for
     * (going to the recorded lines while a recording runs, with its controls), then the failing tests, the failures, the
     * dashboard and the baseline, the test at the caret and Record Here, then Refresh, Connect and the settings. The
     * registered actions keep their own logic, and the popup leaves out those that do not apply.
     */
    fun actions(): ActionGroup {
        val manager = ActionManager.getInstance()
        val first: AnAction? = if (recording() != null) {
            GoToRecordingAction()
        } else {
            when (view().action) {
                Glue.StatusAction.REFRESH -> ReadRunAgainAction()
                Glue.StatusAction.RETRY -> manager.getAction("Piwi.Refresh")
                Glue.StatusAction.CONNECT -> manager.getAction("Piwi.Connect")
                Glue.StatusAction.NODE_SETTINGS -> NodeSettingsAction()
                Glue.StatusAction.SETTINGS -> manager.getAction("Piwi.OpenSettings")
                Glue.StatusAction.NONE -> null
            }
        }
        fun registered(vararg ids: String) = ids.mapNotNull { manager.getAction(it) }.filter { it !== first }
        return DefaultActionGroup().apply {
            if (runs()?.controls()?.active == true) {
                addAll(registered(*RUN_ACTIONS))
                addSeparator()
            }
            if (first != null) {
                add(first)
                addAll(registered("Piwi.PauseRecording", "Piwi.ResumeRecording", "Piwi.StopRecording"))
                addSeparator()
            }
            addAll(registered("Piwi.RerunFailing"))
            add(OpenFailuresAction())
            addAll(registered("Piwi.OpenLatestRun", "Piwi.OpenInDashboard", "Piwi.CompareWith"))
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
            null,
            actions(),
            context,
            JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
            false,
            ActionPlaces.STATUS_BAR_PLACE,
        )
        popup.show(RelativePoint(label, Point(0, -popup.content.preferredSize.height)))
    }

    /** **Read the Latest Run Again**: `piwi/refreshRun`, then the status, the item saying so meanwhile. */
    private inner class ReadRunAgainAction : DumbAwareAction("Read the Latest Run Again", null, AllIcons.Actions.Refresh) {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT

        override fun actionPerformed(e: AnActionEvent) {
            service().refreshRun()
            update()
        }
    }

    /** **Node.js Settings…**: the interpreter the editor service starts with, the service started again once closed. */
    private inner class NodeSettingsAction : DumbAwareAction("Node.js Settings…", null, AllIcons.General.Settings) {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT

        override fun actionPerformed(e: AnActionEvent) = service().openNodeSettings()
    }

    /** **Go to the Recorded Lines**: the block the recording in progress writes. */
    private inner class GoToRecordingAction : DumbAwareAction("Go to the Recorded Lines", null, AllIcons.Actions.EditSource) {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT

        override fun actionPerformed(e: AnActionEvent) {
            val recording = recording() ?: return
            OpenFileDescriptor(project, recording.file, recording.blockStart() ?: 0).navigate(true)
        }
    }

    companion object {
        /** The controls of a run started here, as the popup lists them while one is live. */
        val RUN_ACTIONS = arrayOf(
            "Piwi.ResumeRun", "Piwi.StepRun", "Piwi.RunToCaret", "Piwi.FinishRun", "Piwi.ShowPausedPage", "Piwi.PauseRun",
            "Piwi.StopRun",
        )

        /** The path of the selected editor's file, whose Playwright config the item speaks for; null with none open. */
        fun shownFile(project: Project): String? = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?.path
    }
}

/** Piwi's icon, the tool window's. */
private val PIWI_ICON: Icon = IconLoader.getIcon("/icons/piwi.svg", PiwiStatusBarWidget::class.java)

/** **Open the Failures**: the Piwi tool window, as a run's notification opens it. */
private class OpenFailuresAction : DumbAwareAction("Open the Failures", null, PIWI_ICON) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID)?.activate(null)
    }
}

/**
 * The item's label: an icon and a text in the status bar's font and insets, the text in the status bar's foreground,
 * or the error foreground with [error]; both are theme colors.
 */
private class StatusLabel : JBLabel() {
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

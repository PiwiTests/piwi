package dev.piwitests.jetbrains

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import java.awt.Component
import java.awt.event.MouseEvent

/**
 * The latest run on the checked-out branch, or the run in progress, in the status bar: a click reads it again. While a
 * recording runs, its state and step count.
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

class PiwiStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private var statusBar: StatusBar? = null

    override fun ID() = PiwiStatusBarWidgetFactory.ID

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        val service = project.service<PiwiProjectService>()
        service.onChange(this) {
            statusBar.updateWidget(ID())
            if (!service.status?.contexts.orEmpty().none { it.connected }) CopyMcpConfigurationAction.offer(project)
        }
        service.refreshStatus()
        project.service<PiwiRecordings>().onChange(this) { statusBar.updateWidget(ID()) }
    }

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    private fun view() = project.service<PiwiProjectService>().let {
        Glue.statusView(it.status, it.runs, it.local().desktop, startProblem = it.startProblem)
    }

    private fun recording() = project.getServiceIfCreated(PiwiRecordings::class.java)?.current()

    override fun getText(): String = recording()?.let { Glue.recordingStatus(it.state, it.steps, it.edited, it.stopping) }
        ?: if (project.service<PiwiProjectService>().refreshing) Glue.REFRESHING else view().text

    override fun getAlignment(): Float = Component.LEFT_ALIGNMENT

    override fun getTooltipText(): String =
        Glue.htmlTooltip(recording()?.let { "${it.view.text}\nClick to go to the recorded lines." } ?: view().tooltip)

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { event ->
        val recording = recording()
        if (recording != null) {
            OpenFileDescriptor(project, recording.file, recording.blockStart() ?: 0).navigate(true)
            return@Consumer
        }
        val view = view()
        val action = when (view.action) {
            Glue.StatusAction.REFRESH -> {
                project.service<PiwiProjectService>().refreshRun()
                statusBar?.updateWidget(ID())
                null
            }
            Glue.StatusAction.RETRY -> "Piwi.Refresh"
            Glue.StatusAction.CONNECT -> "Piwi.Connect"
            Glue.StatusAction.NODE_SETTINGS -> {
                project.service<PiwiProjectService>().openNodeSettings()
                null
            }
            Glue.StatusAction.SETTINGS -> "Piwi.OpenSettings"
            Glue.StatusAction.NONE -> null
        }
        action?.let { ActionManager.getInstance().getAction(it) }?.let {
            ActionManager.getInstance().tryToExecute(it, event, event.component, ActionPlaces.STATUS_BAR_PLACE, true)
        }
    }

    override fun dispose() {
        statusBar = null
    }
}

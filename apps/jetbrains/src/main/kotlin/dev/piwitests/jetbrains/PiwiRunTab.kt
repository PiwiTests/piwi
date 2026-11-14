package dev.piwitests.jetbrains

import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.filters.Filter
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.execution.ui.RunContentManager
import com.intellij.execution.ui.actions.CloseAction
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import java.awt.BorderLayout
import javax.swing.JPanel

/**
 * The Run tab of a run Piwi starts in the console, as the platform's `RunContentExecutor` builds one, with the run's
 * controls in its toolbar (`Piwi.RunControl`: Pause, Resume, Step, Run to the caret, Finish, End the test, the paused
 * page, the code at a stop and the rest) between Rerun and Stop and Close, where the debugger keeps its own.
 */
object PiwiRunTab {
    /** The process's tab, titled `title`, its output read through `filter`, `rerun` run by Rerun. On the event thread. */
    fun show(project: Project, handler: ProcessHandler, title: String, filter: Filter, rerun: () -> Unit) {
        val console = TextConsoleBuilderFactory.getInstance().createBuilder(project).filters(listOf(filter)).console
        console.attachToProcess(handler)
        val panel = JPanel(BorderLayout())
        panel.add(console.component, BorderLayout.CENTER)
        val descriptor = RunContentDescriptor(console, handler, panel, title)
        descriptor.isActivateToolWindowWhenAdded = true
        descriptor.isAutoFocusContent = false
        val executor = DefaultRunExecutor.getRunExecutorInstance()
        val actions = DefaultActionGroup()
        actions.add(Rerun(rerun))
        actions.add(Stop(handler))
        actions.addSeparator()
        ActionManager.getInstance().getAction("Piwi.RunControl")?.let { actions.add(it) }
        actions.addSeparator()
        actions.add(CloseAction(executor, descriptor, project))
        val toolbar = ActionManager.getInstance().createActionToolbar("PiwiRunTab", actions, false)
        toolbar.targetComponent = console.component
        panel.add(toolbar.component, BorderLayout.WEST)
        Disposer.register(descriptor, console)
        RunContentManager.getInstance(project).showRunContent(executor, descriptor)
        handler.startNotify()
    }

    /** Rerun: the same command again, once this one ended, the files saved first. */
    private class Rerun(private val rerun: () -> Unit) : DumbAwareAction("Rerun", "Run the same tests again", AllIcons.Actions.Restart) {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun actionPerformed(e: AnActionEvent) {
            FileDocumentManager.getInstance().saveAllDocuments()
            rerun()
        }
    }

    /** Stop: the run's process ends, while it runs. */
    private class Stop(private val handler: ProcessHandler) : DumbAwareAction("Stop", "Stop the run's process", AllIcons.Actions.Suspend) {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabled = !handler.isProcessTerminated
        }

        override fun actionPerformed(e: AnActionEvent) = handler.destroyProcess()
    }
}

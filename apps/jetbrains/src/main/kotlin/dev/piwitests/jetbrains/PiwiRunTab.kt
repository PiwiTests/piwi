package dev.piwitests.jetbrains

import com.intellij.execution.Executor
import com.intellij.execution.KillableProcess
import com.intellij.execution.configurations.RunProfile
import com.intellij.execution.configurations.RunProfileState
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.filters.Filter
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessOutputType
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.testframework.sm.FileUrlProvider
import com.intellij.execution.testframework.sm.SMTestRunnerConnectionUtil
import com.intellij.execution.testframework.sm.runner.SMTRunnerConsoleProperties
import com.intellij.execution.testframework.sm.runner.SMTestLocator
import com.intellij.execution.testframework.ui.BaseTestsOutputConsoleView
import com.intellij.execution.ui.ExecutionConsole
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.execution.ui.RunContentManager
import com.intellij.execution.ui.actions.CloseAction
import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonShortcuts
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import java.awt.BorderLayout
import java.awt.datatransfer.StringSelection
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import javax.swing.JPanel

/**
 * The Run tab of a run Piwi starts in the console, as the platform's `RunContentExecutor` builds one, with the run's
 * controls in its toolbar (`Piwi.RunControl` but its Stop: Pause, Resume, Step, Run to the caret, Finish, End the test,
 * the paused page, the code at a stop and the rest), each acting on the tab's run, after Rerun and Stop, where the
 * debugger keeps its own. A test run (one with a ref, and its `TestTreeRelay`) shows the platform's test tree beside its
 * output, its tests as the run's workers begin and end them (`PiwiRunTestTrees`); any other command, its output alone.
 */
object PiwiRunTab {
    /**
     * The process's tab, titled `title`, its output read through `filter` (through `relay` with the test tree, for a
     * test run), `rerun` run by Rerun, the controls of the run `ref` names in its toolbar. On the event thread.
     */
    fun show(
        project: Project,
        handler: ProcessHandler,
        relay: TestTreeRelay?,
        title: String,
        filter: Filter,
        ref: String?,
        rerun: () -> Unit,
    ) {
        val executor = DefaultRunExecutor.getRunExecutorInstance()
        val console: ExecutionConsole = if (relay != null) {
            testConsole(project, relay, title, filter)
        } else {
            TextConsoleBuilderFactory.getInstance().createBuilder(project).filters(listOf(filter)).console.also { it.attachToProcess(handler) }
        }
        val panel = JPanel(BorderLayout())
        panel.add(console.component, BorderLayout.CENTER)
        val descriptor = RunContentDescriptor(console, handler, panel, title)
        descriptor.isActivateToolWindowWhenAdded = true
        descriptor.isAutoFocusContent = true
        val actions = DefaultActionGroup()
        actions.add(Rerun(rerun).also { it.registerCustomShortcutSet(CommonShortcuts.getRerun(), panel) })
        actions.add(Stop(handler))
        if (ref != null) {
            actions.addSeparator()
            controls(ref).forEach(actions::add)
            actions.add(SharedPage(project, ref, copy = false))
            actions.add(SharedPage(project, ref, copy = true))
        }
        actions.addSeparator()
        actions.add(CloseAction(executor, descriptor, project))
        val toolbar = ActionManager.getInstance().createActionToolbar("PiwiRunTab", actions, false)
        toolbar.targetComponent = console.component
        panel.add(toolbar.component, BorderLayout.WEST)
        Disposer.register(descriptor, console)
        RunContentManager.getInstance(project).showRunContent(executor, descriptor)
        relay?.startNotify()
        handler.startNotify()
    }

    /** The test tree's console of a run, reading it through its relay, which starts before the run's process. */
    internal fun testConsole(project: Project, relay: TestTreeRelay, title: String, filter: Filter): BaseTestsOutputConsoleView {
        val executor = DefaultRunExecutor.getRunExecutorInstance()
        val properties = object : SMTRunnerConsoleProperties(project, PiwiRunProfile(title), "Piwi", executor) {
            override fun getTestLocator(): SMTestLocator = FileUrlProvider.INSTANCE
        }
        properties.isIdBasedTestTree = true
        val console = SMTestRunnerConnectionUtil.createAndAttachConsole("Piwi", relay, properties)
        console.addMessageFilter(filter)
        return console
    }

    /** The run profile the test tree's console names: the tab's title, nothing to run of its own. */
    private class PiwiRunProfile(private val title: String) : RunProfile {
        override fun getState(executor: Executor, environment: ExecutionEnvironment): RunProfileState? = null

        override fun getName(): String = title

        override fun getIcon() = null
    }

    /** `Piwi.RunControl`'s actions but its Stop, the tab's own, each acting on the run `ref` names. */
    private fun controls(ref: String): List<AnAction> {
        val manager = ActionManager.getInstance()
        val group = manager.getAction("Piwi.RunControl") as? DefaultActionGroup ?: return emptyList()
        return group.childActionsOrStubs.mapNotNull { manager.getId(it) }.filter { it != "Piwi.StopRun" }.mapNotNull { id ->
            registeredWith(id) { it.add(PiwiRunSessions.RUN, ref) }
        }
    }

    /**
     * Open the run page, or copy its link, while the run of `ref` is shared live and its page known, as the status
     * popup's entries on a share do (`Glue.liveMenu`); `Piwi.StopSharingRun` among the controls stops it.
     */
    private class SharedPage(private val project: Project, private val ref: String, private val copy: Boolean) : DumbAwareAction(
        if (copy) "Copy the run page's link" else "Open the run page",
        null,
        if (copy) AllIcons.Actions.Copy else AllIcons.General.Web,
    ) {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT

        private fun page(): String? {
            val runs = project.getServiceIfCreated(PiwiRunSessions::class.java) ?: return null
            val kind = if (copy) Glue.LiveEntryKind.COPY_LINK else Glue.LiveEntryKind.OPEN_PAGE
            return Glue.liveMenu(runs.sessions, runs.windowShared).firstOrNull { it.ref == ref && it.kind == kind }?.url
        }

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabledAndVisible = page() != null
        }

        override fun actionPerformed(e: AnActionEvent) {
            val url = page() ?: return
            if (copy) CopyPasteManager.getInstance().setContents(StringSelection(url)) else BrowserUtil.browse(url)
        }
    }

    /** Rerun: the same command again, once this one ended, the files saved first. */
    private class Rerun(private val rerun: () -> Unit) : DumbAwareAction("Rerun", "Run the same tests again", AllIcons.Actions.Restart) {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun actionPerformed(e: AnActionEvent) {
            FileDocumentManager.getInstance().saveAllDocuments()
            rerun()
        }
    }

    /** Stop: the run's process ends, while it runs; clicked again while it ends, it is killed. */
    private class Stop(private val handler: ProcessHandler) : DumbAwareAction("Stop", "Stop the run's process", AllIcons.Actions.Suspend) {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabled = !handler.isProcessTerminated
            e.presentation.icon = if (killable()) AllIcons.Debugger.KillProcess else AllIcons.Actions.Suspend
        }

        override fun actionPerformed(e: AnActionEvent) {
            if (killable()) (handler as KillableProcess).killProcess() else handler.destroyProcess()
        }

        private fun killable() = handler.isProcessTerminating && handler is KillableProcess && handler.canKillProcess()
    }
}

/**
 * The process the test tree's console reads: the run's output as the run's process writes it, and the service messages
 * of its tests (`Glue.RunTestTree`) between its lines, a message written mid-line starting on a line of its own. The
 * events heard before it starts are written as it starts, after the message that says the run reports its tests. It
 * ends once the run's process ended, its suites ended first; stopping it stops the run's process.
 */
class TestTreeRelay(private val source: ProcessHandler) : ProcessHandler() {
    private val tree = Glue.RunTestTree()
    private val lock = Any()
    private var lineStart = true
    private var started = false
    private val pending = mutableListOf<String>()

    init {
        source.addProcessListener(object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                synchronized(lock) {
                    if (ProcessOutputType.isStdout(outputType)) lineStart = event.text.endsWith("\n")
                    notifyTextAvailable(event.text, outputType)
                }
            }

            override fun processTerminated(event: ProcessEvent) {
                synchronized(lock) { write(tree.finish()) }
                notifyProcessTerminated(event.exitCode)
            }
        })
    }

    override fun startNotify() {
        super.startNotify()
        synchronized(lock) {
            started = true
            write(tree.start() + pending)
            pending.clear()
        }
    }

    /** A test of the run began or ended: its messages, on the event's own lines, or kept until the relay starts. */
    fun heard(event: RunTestEvent) = synchronized(lock) {
        val lines = tree.lines(event)
        if (started) write(lines) else pending += lines
    }

    private fun write(lines: List<String>) {
        if (lines.isEmpty() || isProcessTerminated) return
        val text = lines.joinToString("\n", prefix = if (lineStart) "" else "\n", postfix = "\n")
        lineStart = true
        notifyTextAvailable(text, ProcessOutputTypes.STDOUT)
    }

    override fun destroyProcessImpl() = source.destroyProcess()

    override fun detachProcessImpl() = notifyProcessDetached()

    override fun detachIsDefault() = false

    override fun getProcessInput(): OutputStream? = null
}

/** Each run's test tree, by its ref, the latest tab of a ref taking its events; dropped once its run's process ended. */
@Service(Service.Level.PROJECT)
class PiwiRunTestTrees {
    private val relays = ConcurrentHashMap<String, TestTreeRelay>()

    /** A test run's relay, made as its process starts, which takes the events of its ref from then on. */
    fun follow(ref: String, relay: TestTreeRelay) {
        relays[ref] = relay
        relay.addProcessListener(object : ProcessListener {
            override fun processTerminated(event: ProcessEvent) {
                relays.remove(ref, relay)
            }
        })
    }

    /** A test of a run began or ended (`piwi/runTest`). */
    fun heard(event: RunTestEvent) {
        val ref = event.ref ?: return
        relays[ref]?.heard(event)
    }
}

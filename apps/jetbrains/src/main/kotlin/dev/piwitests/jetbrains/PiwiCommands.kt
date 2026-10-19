package dev.piwitests.jetbrains

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.intellij.execution.ExecutionException
import com.intellij.execution.RunContentExecutor
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.filters.Filter
import com.intellij.execution.filters.OpenFileHyperlinkInfo
import com.intellij.execution.process.KillableColoredProcessHandler
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessListener
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindowManager
import org.jetbrains.ide.BuiltInServerManager
import java.awt.datatransfer.StringSelection
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

/**
 * The client commands the editor service names in summary lines and code
 * actions (`piwi.openInDashboard`, `piwi.runTests`, `piwi.openTrace`,
 * `piwi.openScreenshot`, `piwi.runCommand`, `piwi.copyAgentContext`, `piwi.copyText`, `piwi.desktopJob`).
 */
object PiwiCommands {
    private val gson = Gson()

    private const val NOT_RUNNING = "The editor service is not running."

    /** How long a failure's trace or screenshot may take to download: a trace can weigh tens of megabytes. */
    private const val DOWNLOAD_TIMEOUT_MILLIS = 5 * 60_000L

    private inline fun <reified T> arg(value: Any?): T? = when (value) {
        is JsonElement -> gson.fromJson(value, T::class.java)
        null -> null
        else -> gson.fromJson(gson.toJsonTree(value), T::class.java)
    }

    fun execute(project: Project, command: String?, arguments: List<Any?>) {
        when (command) {
            "piwi.openInDashboard" -> arg<String>(arguments.firstOrNull())?.let { BrowserUtil.browse(it) }
            "piwi.runTests" -> arg<RunTestsArgs>(arguments.firstOrNull())?.let { runTests(project, it) }
            "piwi.openTrace" -> arg<TraceParams>(arguments.firstOrNull())?.let { openTrace(project, it) }
            "piwi.openScreenshot" -> arg<TraceParams>(arguments.firstOrNull())?.let { openScreenshot(project, it) }
            "piwi.runCommand" -> arg<RunCommandArgs>(arguments.firstOrNull())?.let { run(project, it.cwd, it.command, it.env) }
            "piwi.copyAgentContext" -> arg<TraceParams>(arguments.firstOrNull())?.let { copyAgentContext(project, it) }
            "piwi.copyText" -> arg<String>(arguments.firstOrNull())?.let {
                CopyPasteManager.getInstance().setContents(StringSelection(it))
                notify(project, "Copied. Paste it to your agent.")
            }
            "piwi.desktopJob" -> arg<DesktopJobParams>(arguments.firstOrNull())?.let { desktopJob(project, it) }
        }
    }

    /**
     * Pass a failure or a flaky test from the team instance to the desktop app, which waits for the developer to start
     * it.
     */
    fun desktopJob(project: Project, params: DesktopJobParams) {
        background(project, "Piwi: passing the job to the desktop app") {
            val result = project.service<PiwiProjectService>().server()?.desktopJob(params)?.orNull()
            notify(
                project,
                result?.message ?: "The editor service is not running.",
                if (result?.ok == true) NotificationType.INFORMATION else NotificationType.WARNING,
            )
        }
    }

    /** Show a job's update, with the button that shares its verdict on the instance when it has one. */
    fun desktopJobChanged(project: Project, update: DesktopJobUpdate) {
        val notice = Glue.desktopJobNotice(update)
        val notification = NotificationGroupManager.getInstance().getNotificationGroup("Piwi")
            .createNotification(notice.text, if (notice.warning) NotificationType.WARNING else NotificationType.INFORMATION)
        val jobId = update.jobId
        if (jobId != null) {
            for (label in notice.actions) {
                notification.addAction(NotificationAction.createSimpleExpiring(label) { shareDesktopJob(project, jobId) })
            }
        }
        notification.notify(project)
    }

    private fun shareDesktopJob(project: Project, jobId: String) {
        background(project, "Piwi: sharing the verdict") {
            val result = project.service<PiwiProjectService>().server()?.shareDesktopJob(ShareDesktopJobParams(jobId))?.orNull()
            val notification = NotificationGroupManager.getInstance().getNotificationGroup("Piwi").createNotification(
                result?.message ?: "The editor service is not running.",
                if (result?.ok == true) NotificationType.INFORMATION else NotificationType.WARNING,
            )
            result?.url?.let { url ->
                notification.addAction(NotificationAction.createSimpleExpiring("Open in the dashboard") { BrowserUtil.browse(url) })
            }
            notification.notify(project)
        }
    }

    /** Run every test still failing or edited since its run, as `piwi/failures` lists them. */
    fun rerunFailing(project: Project) {
        background(project, "Piwi: resolving the failing tests") {
            val failures = project.service<PiwiProjectService>().server()?.failures()?.orNull()
            val runs = Glue.rerunFailingArgs(failures)
            if (runs.isEmpty()) notify(project, "No failing test to re-run.") else runs.forEach { runTests(project, it) }
        }
    }

    /** Copy one block about a failure for a coding agent: the failure, its healing and its cluster's fix plan. */
    fun copyAgentContext(project: Project, params: TraceParams) {
        background(project, "Piwi: gathering the failure's context") {
            val text = project.service<PiwiProjectService>().server()?.agentContext(params)?.orNull()?.text
            if (text == null) {
                notify(project, "This failure is no longer in the latest run.", NotificationType.WARNING)
            } else {
                CopyPasteManager.getInstance().setContents(StringSelection(text))
                notify(project, "Copied. Paste it to your agent.")
            }
        }
    }

    /**
     * Say what a run started from the IDE changed, as **Settings → Tools → Piwi** allows, with the failures, the run's
     * page and **Re-run Failing** one click away.
     */
    fun runEnded(project: Project, ended: RunEnded) {
        val setting = project.service<PiwiProjectService>().local().runNotifications
        val verdict = Glue.runVerdict(ended, setting) ?: return
        val notification = NotificationGroupManager.getInstance().getNotificationGroup("Piwi")
            .createNotification(verdict.text, if (verdict.warning) NotificationType.WARNING else NotificationType.INFORMATION)
        for (label in verdict.actions) {
            notification.addAction(
                NotificationAction.createSimpleExpiring(label) {
                    when (label) {
                        Glue.OPEN_FAILURES -> ToolWindowManager.getInstance(project)
                            .getToolWindow(PiwiFailuresToolWindowFactory.ID)?.activate(null)
                        Glue.OPEN_IN_DASHBOARD -> ended.url?.let { BrowserUtil.browse(it) }
                        Glue.RERUN_FAILING -> rerunFailing(project)
                    }
                },
            )
        }
        notification.notify(project)
    }

    /** Run tests in the Run tool window, pausing at the IDE's breakpoints as **Settings → Tools → Piwi** allows. */
    fun runTests(project: Project, args: RunTestsArgs) {
        background(project, "Piwi: resolving the tests") {
            val service = project.service<PiwiProjectService>()
            val breakpoints = service.breakpoints()
            val withBreakpoints = if (breakpoints.isEmpty()) args else args.copy(breakpoints = breakpoints)
            val command = service.server()?.runArgs(withBreakpoints)?.orNull()
            if (command?.command.isNullOrBlank() || command?.cwd == null) {
                notify(project, "No command to run these tests (not connected?).", NotificationType.WARNING)
            } else {
                startRun(project, command)
            }
        }
    }

    /** The notices of `RunCommand.notice` already shown: each is shown once. */
    private val noticesShown: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /**
     * Run a test command of the service: its notice shown once, and, with breakpoints (`PIWI_PAUSE_AT`), the Send to
     * editor pairing a locator picked while paused is posted to (`PIWI_EDITOR_SEND`). Call it off the event thread.
     */
    fun startRun(project: Project, command: RunCommand) {
        val cwd = command.cwd ?: return
        val line = command.command?.takeIf { it.isNotBlank() } ?: return
        if (!project.service<PiwiProjectService>().trusted()) return notify(project, Glue.UNTRUSTED, NotificationType.WARNING)
        command.notice?.let { if (noticesShown.add(it)) notify(project, it, NotificationType.WARNING) }
        val base = command.env
        val address = if (base != null && base.containsKey("PIWI_PAUSE_AT")) {
            runCatching {
                val port = BuiltInServerManager.getInstance().waitForStart().port
                "http://127.0.0.1:$port${PiwiSendHandler.PATH}#${PiwiSendToken.ensure()}"
            }.getOrNull()
        } else {
            null
        }
        val env = if (base != null && address != null) base + ("PIWI_EDITOR_SEND" to address) else base
        val args = Glue.playwrightTestArgs(line)
        if (args != null && project.service<PiwiProjectService>().local().playwrightRunner && PlaywrightRunnerGate.available()) {
            val ref = command.ref
            ApplicationManager.getApplication().invokeLater({
                // The console runs what the IDE's runner does not take.
                val started = runCatching {
                    PlaywrightRunnerLauncher.start(project, cwd, args, env.orEmpty()) { exitCode ->
                        if (ref != null) commandEnded(project, CommandEndedParams(ref, exitCode))
                    }
                }.getOrDefault(false)
                if (!started) run(project, cwd, line, env, ref)
            }, project.disposed)
            return
        }
        run(project, cwd, line, env, command.ref)
    }

    /** Tell the service a command it gave ended (`piwi/commandEnded`), off the event thread. */
    private fun commandEnded(project: Project, ended: CommandEndedParams) {
        ApplicationManager.getApplication().executeOnPooledThread {
            // The plugin may have been unloaded since the run started: its service is then gone.
            if (!project.isDisposed) project.getServiceIfCreated(PiwiProjectService::class.java)?.server()?.commandEnded(ended)
        }
    }

    /** Download a failure's trace, for as long as [DOWNLOAD_TIMEOUT_MILLIS] or until Cancel, and open it in the trace viewer. */
    fun openTrace(project: Project, params: TraceParams) {
        background(project, "Piwi: downloading the trace") {
            val request = project.service<PiwiProjectService>().server()?.trace(params)
            val trace = request?.awaitCancellably(DOWNLOAD_TIMEOUT_MILLIS)
            when {
                trace?.command != null && trace.cwd != null -> run(project, trace.cwd, trace.command)
                request == null -> notify(project, NOT_RUNNING, NotificationType.WARNING)
                !request.isDone -> notify(project, "The trace did not download within ${DOWNLOAD_TIMEOUT_MILLIS / 60_000} minutes.", NotificationType.WARNING)
                else -> notify(project, "This failure has no trace to open.", NotificationType.WARNING)
            }
        }
    }

    /** Download a failure's screenshot and open it in an editor tab. */
    fun openScreenshot(project: Project, params: TraceParams) {
        background(project, "Piwi: downloading the screenshot") {
            val request = project.service<PiwiProjectService>().server()?.screenshot(params)
            val path = request?.awaitCancellably(DOWNLOAD_TIMEOUT_MILLIS)?.path
            val file = path?.let { LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(it)) }
            when {
                file != null -> ApplicationManager.getApplication().invokeLater({
                    FileEditorManager.getInstance(project).openFile(file, true)
                }, project.disposed)
                request == null -> notify(project, NOT_RUNNING, NotificationType.WARNING)
                !request.isDone -> notify(project, "The screenshot did not download within ${DOWNLOAD_TIMEOUT_MILLIS / 60_000} minutes.", NotificationType.WARNING)
                else -> notify(project, "This failure has no screenshot to open.", NotificationType.WARNING)
            }
        }
    }

    /**
     * Run a command line in the Run tool window, in `cwd`, with `env` added to its environment: the process starts off
     * the event thread. With `ref`, the ref of the run it starts, the service hears when it ends
     * (`piwi/commandEnded`). The tool window's Rerun stops it if it runs, and starts the same command, ref included.
     */
    fun run(project: Project, cwd: String, command: String, env: Map<String, String>? = null, ref: String? = null) {
        val parts = Glue.splitCommand(command).toMutableList()
        if (parts.isEmpty()) return
        if (!project.service<PiwiProjectService>().trusted()) return notify(project, Glue.UNTRUSTED, NotificationType.WARNING)
        if (SystemInfo.isWindows && parts[0] in setOf("npx", "npm", "node")) {
            if (parts[0] != "node") parts[0] = "${parts[0]}.cmd"
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val handler = try {
                val commandLine = GeneralCommandLine(parts).withWorkDirectory(cwd).withCharset(Charsets.UTF_8)
                if (!env.isNullOrEmpty()) commandLine.withEnvironment(env)
                KillableColoredProcessHandler(commandLine)
            } catch (e: ExecutionException) {
                notify(project, "Could not run ${parts[0]}: ${e.message}", NotificationType.ERROR)
                return@executeOnPooledThread
            }
            if (ref != null) {
                handler.addProcessListener(object : ProcessListener {
                    override fun processTerminated(event: ProcessEvent) = commandEnded(project, CommandEndedParams(ref, event.exitCode))
                })
            }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) {
                    handler.destroyProcess()
                } else {
                    RunContentExecutor(project, handler)
                        .withTitle("Piwi")
                        .withFilter(RunOutputLinks(project, cwd))
                        .withActivateToolWindow(true)
                        .withRerun {
                            handler.destroyProcess()
                            run(project, cwd, command, env, ref)
                        }
                        .run()
                }
            }
        }
    }

    fun notify(project: Project, message: String, type: NotificationType = NotificationType.INFORMATION) {
        NotificationGroupManager.getInstance().getNotificationGroup("Piwi").createNotification(message, type).notify(project)
    }

    private fun background(project: Project, title: String, body: () -> Unit) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, true) {
            override fun run(indicator: ProgressIndicator) = body()
        })
    }
}

/**
 * Links the script files a run's output names relative to the run's folder (`[chromium] › tests/login.spec.ts:12:5`) to
 * their line; the IDE's console links absolute paths already.
 */
private class RunOutputLinks(private val project: Project, private val cwd: String) : Filter, DumbAware {
    override fun applyFilter(line: String, entireLength: Int): Filter.Result? {
        val links = Glue.fileLinks(line)
        if (links.isEmpty()) return null
        val start = entireLength - line.length
        val items = links.mapNotNull { link ->
            val file = runCatching { LocalFileSystem.getInstance().findFileByNioFile(Path.of(cwd).resolve(link.path)) }.getOrNull()
                ?: return@mapNotNull null
            Filter.ResultItem(start + link.start, start + link.end, OpenFileHyperlinkInfo(project, file, link.line - 1, (link.column ?: 1) - 1))
        }
        return if (items.isEmpty()) null else Filter.Result(items)
    }
}

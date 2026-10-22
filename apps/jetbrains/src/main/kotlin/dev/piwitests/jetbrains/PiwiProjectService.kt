package dev.piwitests.jetbrains

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.impl.isTrusted
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.options.SearchableConfigurable
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.BaseProjectDirectories.Companion.getBaseDirectories
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.Computable
import com.intellij.openapi.util.Condition
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileCopyEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.impl.status.widget.StatusBarWidgetsManager
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.psi.PsiManager
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.breakpoints.XLineBreakpoint
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The instance and project this project reports to, when the environment and `.env` name
 * none: **Settings → Tools → Piwi**, kept in `.idea/piwi.xml`. The key is not here but in the
 * password safe, per instance.
 */
@Service(Service.Level.PROJECT)
@State(name = "PiwiSettings", storages = [Storage("piwi.xml")])
class PiwiSettings : PersistentStateComponent<PiwiSettings.State> {
    data class State(var serverUrl: String = "", var project: String = "")

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }
}

/**
 * What this machine keeps for the project, in `.idea/workspace.xml`, never in a file the
 * team shares: the desktop app chosen with Connect, its project, and whether it was offered;
 * a recording's choices: the Playwright project, the start page, and the last page
 * expression typed that was not among those offered; how the failures tool window groups
 * the failures (`file`, `cluster`, `owner` or `flat`); whether the runs Piwi starts pause
 * at the IDE's breakpoints, and whether they run in the IDE's Playwright runner; when a run started from the IDE says what it changed (`always`,
 * `failures`, `never`); the baseline chosen with **Compare With…** for each Playwright
 * config folder (`Glue.encodeBaseline`; the ladder is no entry); whether the coverage marks are shown; and the severity
 * of a failure's diagnostic (`Glue.FAILURE_SEVERITIES`).
 */
@Service(Service.Level.PROJECT)
@State(name = "PiwiLocalSettings", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class PiwiLocalSettings : PersistentStateComponent<PiwiLocalSettings.State> {
    data class State(
        var desktop: Boolean = false,
        var desktopProject: String = "",
        var desktopOffered: Boolean = false,
        var recordProject: String = "",
        var recordStartUrl: String = "",
        var recordPage: String = "",
        var failuresGrouping: String = "file",
        var breakpoints: Boolean = true,
        var playwrightRunner: Boolean = false,
        var runNotifications: String = "always",
        var baselines: MutableMap<String, String> = mutableMapOf(),
        var coverageMarks: Boolean = true,
        var failureSeverity: String = "error",
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }
}

/**
 * The plugin's state for one project: the connection it hands the editor
 * service, and the service's last answers on the run, which the status bar
 * and the failures tool window render. The service pushes each answer when it
 * changes (`piwi/statusChanged`, `piwi/runStatusChanged`, `piwi/failuresChanged`):
 * they are kept as they come, and read whole only when the plugin starts and
 * when it asks the service for something new (Refresh, the credentials).
 */
@Service(Service.Level.PROJECT)
class PiwiProjectService(private val project: Project) : Disposable {
    @Volatile var status: StatusResult? = null
        private set

    @Volatile var runs: RunStatusResult? = null
        private set

    @Volatile var failures: List<WorkspaceFailure> = emptyList()
        private set

    /** The last `piwi/failures` answer: the failures, with the run they belong to and the runs laid over it. */
    @Volatile var failuresResult: FailuresResult? = null
        private set

    /** Whether a click on the status bar item is reading the latest run again. */
    @Volatile var refreshing = false
        private set

    /** Whether the service was disposed: with its project, or with the plugin unloaded while the project stays open. */
    @Volatile private var disposed = false

    /** What ends the work queued for later: this service disposed, or its project. */
    private val gone = Condition<Any?> { disposed || project.isDisposed }

    /** Why the editor service could not start (`Glue.nodeProblem`); null once it starts. */
    @Volatile var startProblem: String? = null
        private set

    /** Whether the project's wait for trust was said already. */
    private val trustAsked = AtomicBoolean()

    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    /** Guards the answers and how many of each the service pushed: a read started before a push keeps the pushed one. */
    private val lock = Any()
    private var statusPushes = 0L
    private var runsPushes = 0L
    private var failuresPushes = 0L

    /** Whether a whole read runs, and whether another was asked for meanwhile: it follows once the first ends. */
    private val reading = AtomicBoolean()
    private val readAgain = AtomicBoolean()

    /** Whether the listeners are told already: once on the event thread for the changes made meanwhile. */
    private val changeQueued = AtomicBoolean()

    /** The runs the open files were last drawn with (`Glue.redraw`); on the event thread. */
    private var drawn: RunStatusResult? = null

    /** When the files were last drawn again for the tests of a run in progress, and whether a draw waits for its turn. */
    private var testsDrawnAt = 0L
    private val drawQueued = AtomicBoolean()

    /** The URLs of the open files whose tests show a result in the gutter: a run in progress draws only them again. */
    private val filesWithTests: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** `piwi/fileSummary` by file, for one state of its text: the gutter and Code Vision share one request per pass. */
    private val summaries = Glue.SummaryCache(SUMMARY_TTL_MILLIS, MAX_SUMMARIES)

    /** Counts the changes the service pushed: a summary asked for before the latest one is asked for again. */
    private val pushed = AtomicLong()

    /** Whether a search for Playwright configs is due, after a config was created, removed or renamed. */
    private val searchQueued = AtomicBoolean()

    /** The project's Playwright configs; null until the first search ends. */
    @Volatile private var playwright: Glue.PlaywrightSearch? = null

    /** The addresses whose pages may open this project's files, as [readKnownAddresses] read them last. */
    @Volatile private var addresses: ProjectAddresses = ProjectAddresses.NONE

    /** Called on the event thread after each refresh of the status. */
    fun onChange(parent: Disposable, listener: () -> Unit) {
        listeners += listener
        com.intellij.openapi.util.Disposer.register(parent) { listeners -= listener }
    }

    /**
     * Whether the project is trusted. In a project opened in safe mode Piwi starts no editor service, runs no command
     * and reads no `.env`: each of them runs what the repository says.
     */
    fun trusted(): Boolean = project.isTrusted()

    /** Say once that the editor service starts once the project is trusted. */
    fun waitForTrust() {
        if (!trustAsked.compareAndSet(false, true)) return
        NotificationGroupManager.getInstance().getNotificationGroup("Piwi")
            .createNotification(Glue.UNTRUSTED, NotificationType.INFORMATION)
            .notify(project)
    }

    /** Whether a Playwright config sits in the project; false until the search started with the project ends. */
    fun hasPlaywrightConfig(): Boolean = playwright?.configDirs.orEmpty().isNotEmpty()

    /** The directories holding a Playwright config: where a run's file paths start. */
    fun playwrightConfigDirs(): List<Path> = playwright?.configDirs.orEmpty()

    /** The folders searched for Playwright configs: the editor service's workspace. */
    fun searchRoots(): List<Path> = playwright?.roots.orEmpty()

    /**
     * Search the project's folders for Playwright configs, on the calling thread, and keep the answer:
     * the project folder (above `.idea` in Rider), the folder the IDE guesses and its base directories.
     */
    fun searchPlaywright(): Glue.PlaywrightSearch {
        val folders = ApplicationManager.getApplication().runReadAction(Computable {
            buildList {
                project.basePath?.let { add(Glue.projectFolder(it)) }
                project.guessProjectDir()?.takeIf { it.isInLocalFileSystem }?.let { add(it.path) }
                project.getBaseDirectories().filter { it.isInLocalFileSystem }.mapTo(this) { it.path }
            }
        })
        val home = System.getProperty("user.home")?.let { runCatching { Path.of(it) }.getOrNull() }
        return Glue.findPlaywright(folders.mapNotNull { runCatching { Path.of(it) }.getOrNull() }, home).also { playwright = it }
    }

    /**
     * Search for Playwright configs off the event thread; when the answer changes, show or hide the
     * tool window and the status bar item, and start the editor service on the folders found, or
     * restart it there.
     */
    fun findPlaywright() {
        ApplicationManager.getApplication().executeOnPooledThread {
            if (gone.value(null)) return@executeOnPooledThread
            val before = playwright
            val found = searchPlaywright()
            readKnownAddresses()
            if (found == before) return@executeOnPooledThread
            // Once the tool windows are registered.
            val tools = ToolWindowManager.getInstance(project)
            tools.invokeLater {
                if (gone.value(null)) return@invokeLater
                tools.getToolWindow(PiwiFailuresToolWindowFactory.ID)?.isAvailable = found.configDirs.isNotEmpty()
                project.service<StatusBarWidgetsManager>().updateWidget(PiwiStatusBarWidgetFactory::class.java)
            }
            restartServer(runningOnly = found.configDirs.isEmpty())
        }
    }

    /** Start the editor service again, or, unless `runningOnly`, start it for the open files when it does not run. */
    fun restartServer(runningOnly: Boolean = false) {
        val manager = LspServerManager.getInstance(project)
        when {
            manager.getServersForProvider(PiwiLspServerSupportProvider::class.java).isNotEmpty() ->
                manager.stopAndRestartIfNeeded(PiwiLspServerSupportProvider::class.java)
            !runningOnly -> manager.startServersIfNeeded(PiwiLspServerSupportProvider::class.java)
        }
    }

    /**
     * Keep why the service could not start, or that it started (null), and say a new reason once, with the Node.js
     * settings one click away.
     */
    fun startFailed(problem: String?) {
        val before = startProblem
        startProblem = problem
        if (problem == before) return
        changed()
        if (problem == null) return
        NotificationGroupManager.getInstance().getNotificationGroup("Piwi")
            .createNotification(problem, NotificationType.WARNING)
            .addAction(NotificationAction.createSimpleExpiring("Open the Node.js Settings") { openNodeSettings() })
            .notify(project)
    }

    /** The Node.js settings, then the service started again with the interpreter chosen there. */
    fun openNodeSettings() {
        ShowSettingsUtil.getInstance().showSettingsDialog(
            project,
            { (it as? SearchableConfigurable)?.id == NODE_SETTINGS_ID },
            null,
        )
        ApplicationManager.getApplication().executeOnPooledThread { restartServer() }
    }

    /**
     * Search for Playwright configs again a second after one is created, removed, renamed or moved, or a folder that may
     * hold one (a branch checked out): a project gains or loses the tool window, the status bar item and the service
     * without **Refresh**.
     */
    fun watchConfigs() {
        project.messageBus.connect(this).subscribe(
            VirtualFileManager.VFS_CHANGES,
            object : BulkFileListener {
                override fun after(events: List<VFileEvent>) {
                    if (events.none { touchesConfig(it) } || !searchQueued.compareAndSet(false, true)) return
                    AppExecutorUtil.getAppScheduledExecutorService().schedule(
                        {
                            searchQueued.set(false)
                            if (!gone.value(null)) findPlaywright()
                        },
                        1,
                        TimeUnit.SECONDS,
                    )
                }
            },
        )
    }

    /**
     * Whether a change may add or remove a Playwright config: a config's own, or one of a folder where configs are
     * searched, which the IDE reports without the files in it.
     */
    private fun touchesConfig(event: VFileEvent): Boolean {
        val roots = searchRoots()
        fun changed(path: String?, directory: Boolean) =
            if (directory) Glue.mayHoldConfigs(path, roots) else Glue.isPlaywrightConfig(path)
        return when (event) {
            is VFilePropertyChangeEvent -> event.propertyName == VirtualFile.PROP_NAME && (event.file.parent?.path).let { parent ->
                changed("$parent/${event.oldValue}", event.file.isDirectory) || changed("$parent/${event.newValue}", event.file.isDirectory)
            }
            is VFileMoveEvent -> changed(event.oldPath, event.file.isDirectory) || changed(event.newPath, event.file.isDirectory)
            is VFileCreateEvent -> changed(event.path, event.isDirectory)
            is VFileDeleteEvent -> changed(event.path, event.file.isDirectory)
            is VFileCopyEvent -> changed(event.path, event.file.isDirectory)
            else -> false
        }
    }

    fun settings(): PiwiSettings.State = project.getService(PiwiSettings::class.java).state

    fun local(): PiwiLocalSettings.State = project.getService(PiwiLocalSettings::class.java).state

    /**
     * The IDE's enabled line breakpoints in JavaScript or TypeScript files under a Playwright config's folder, which a
     * run started from Piwi pauses at; none when **Settings → Tools → Piwi** turns them off. Reads the breakpoints in a
     * read action: call it off the event thread.
     */
    fun breakpoints(): List<EditorBreakpoint> {
        if (!local().breakpoints) return emptyList()
        val roots = status?.contexts.orEmpty().mapNotNull { it.root }
        if (roots.isEmpty()) return emptyList()
        val found = ApplicationManager.getApplication().runReadAction(
            Computable {
                XDebuggerManager.getInstance(project).breakpointManager.allBreakpoints.mapNotNull { breakpoint ->
                    val line = breakpoint as? XLineBreakpoint<*> ?: return@mapNotNull null
                    val url = line.fileUrl
                    if (!line.isEnabled || !url.startsWith("file://")) null else Glue.BreakpointAt(VfsUtilCore.urlToPath(url), line.line)
                }
            },
        )
        return Glue.runBreakpoints(found, roots)
    }

    /**
     * The connection saved in the IDE: this project's instance and project, that instance's key,
     * and whether this machine reads the desktop app first.
     */
    fun credentials(): EditorCredentials {
        forgetSharedKey()
        val settings = settings()
        val local = local()
        val url = settings.serverUrl.ifBlank { null }
        return EditorCredentials(
            serverUrl = url,
            project = settings.project.ifBlank { null },
            apiKey = url?.let { PasswordSafe.instance.getPassword(credentialAttributes(it)) },
            desktop = local.desktop,
            desktopProject = local.desktopProject.ifBlank { null },
            baselines = local.baselines.mapNotNull { (root, text) -> Glue.decodeBaseline(text)?.let { root to it } }.toMap(),
            failureSeverity = local.failureSeverity.takeIf { it in Glue.FAILURE_SEVERITIES },
        )
    }

    /**
     * Compare the context at `root` with `choice` (**Compare With…**): kept in `PiwiLocalSettings` and sent to the
     * service (`piwi/setBaseline`), which reads it at once and says so in `piwi/runStatusChanged`. Sends over the
     * network: never on the event thread.
     */
    fun setBaseline(root: String, choice: BaselineChoice) {
        val baselines = local().baselines
        val kept = Glue.encodeBaseline(choice)
        if (kept == null) baselines.remove(root) else baselines[root] = kept
        server()?.setBaseline(SetBaselineParams(root, choice))
    }

    /** Whether the password safe holds a key for the instance. */
    fun hasApiKey(serverUrl: String): Boolean =
        serverUrl.isNotBlank() && !PasswordSafe.instance.getPassword(credentialAttributes(serverUrl)).isNullOrEmpty()

    /**
     * Save the instance and project, and hand them to the service; a null key forgets the
     * instance's key. The instance is read rather than the desktop app from then on.
     */
    fun saveCredentials(serverUrl: String, projectName: String, apiKey: String?) {
        val url = Glue.normalizeServerUrl(serverUrl) ?: serverUrl.trim()
        val settings = settings()
        settings.serverUrl = url
        settings.project = projectName.trim()
        if (url.isNotBlank()) PasswordSafe.instance.setPassword(credentialAttributes(url), apiKey?.trim()?.ifBlank { null })
        local().desktop = false
        sendCredentials()
    }

    /**
     * Read the desktop app first while it runs, on `projectName`, or with none on the project
     * linked there to the folder. The saved instance stays, for when the app does not run.
     */
    fun useDesktop(projectName: String?) {
        val local = local()
        local.desktop = true
        local.desktopProject = projectName?.trim().orEmpty()
        local.desktopOffered = true
        sendCredentials()
    }

    /** Read the instance the environment, the `.env` or the settings name again, rather than the desktop app. */
    fun useInstance() {
        local().desktop = false
        sendCredentials()
    }

    /** Forget this project's instance and project, that instance's key, and the choice of the desktop app. */
    fun disconnect() {
        val settings = settings()
        if (settings.serverUrl.isNotBlank()) PasswordSafe.instance.setPassword(credentialAttributes(settings.serverUrl), null)
        settings.serverUrl = ""
        settings.project = ""
        local().desktop = false
        local().desktopProject = ""
        sendCredentials()
    }

    /**
     * The desktop app running on this machine, as the service's `piwi/desktop` answers it; read
     * here from its discovery file while the service has not started (it starts with the first
     * file opened). Blocks on the network: never on the event thread.
     */
    fun desktop(): DesktopResult {
        server()?.desktop()?.awaitCancellably(TIMEOUT_SECONDS * 1000)?.let { return it }
        val discovery = readDesktopDiscovery() ?: return DesktopResult()
        val projects = runCatching { PiwiInstance.projects(discovery.url, discovery.token) }.getOrDefault(emptyList())
            .map { ProjectRef(it.id, it.name) }
        val linked = Glue.linkedDesktopProject(discovery.links, playwrightConfigDirs().firstOrNull())
        return DesktopResult(discovery.url, projects, projects.firstOrNull { it.id == linked })
    }

    /** The desktop app's address while it runs, from the service's status or its discovery file; reads the disk. */
    fun desktopUrl(): String? = status?.desktopUrl ?: readDesktopDiscovery()?.url

    private fun readDesktopDiscovery(): Glue.DesktopDiscovery? {
        val file = Glue.desktopConfigPath(System.getenv(), System.getProperty("user.home")) ?: return null
        return Glue.parseDesktopDiscovery(runCatching { Files.readString(file) }.getOrNull())
    }

    /** The addresses whose pages may open this project's files, as read last (`PiwiOpenHandler`): nothing from the disk. */
    fun knownAddresses(): ProjectAddresses = addresses

    /**
     * Read the addresses whose pages may open this project's files, and keep them: the desktop app's, from the status
     * and its discovery file, for every open project; this project's instance from its settings, the status's
     * contexts and, in a trusted project, `PIWI_DASHBOARD_URL` in the `.env` of each Playwright config folder. Reads
     * the disk, on the calling thread: once the configs are found, with each status, and when the settings are saved.
     */
    fun readKnownAddresses(): ProjectAddresses {
        val status = status
        val everywhere = listOf(status?.desktopUrl, readDesktopDiscovery()?.url)
        val own = buildList {
            add(settings().serverUrl)
            for (context in status?.contexts.orEmpty()) {
                add(context.serverUrl)
                add(context.instance?.serverUrl)
            }
            if (trusted()) {
                for (dir in playwrightConfigDirs()) {
                    val dotEnv = dir.resolve(".env")
                    if (Files.isRegularFile(dotEnv)) add(OpenOrigins.dashboardUrlFromDotEnv(runCatching { Files.readString(dotEnv) }.getOrNull()))
                }
            }
        }
        return ProjectAddresses(everywhere, own).also { addresses = it }
    }

    /** [readKnownAddresses] on a pooled thread. */
    private fun refreshKnownAddresses() {
        ApplicationManager.getApplication().executeOnPooledThread { if (!gone.value(null)) readKnownAddresses() }
    }

    /**
     * Hand the connection to the running service (`piwi/setCredentials`), which reads everything again with it and
     * pushes what changed; without a service, start it for the open files.
     */
    fun sendCredentials() {
        ApplicationManager.getApplication().executeOnPooledThread {
            readKnownAddresses()
            val manager = LspServerManager.getInstance(project)
            val lsp = manager.getServersForProvider(PiwiLspServerSupportProvider::class.java)
            if (lsp.isEmpty()) {
                manager.startServersIfNeeded(PiwiLspServerSupportProvider::class.java)
            } else {
                val credentials = credentials()
                lsp.forEach { it.piwiServer()?.setCredentials(credentials) }
            }
            refreshStatus()
        }
    }

    /** The running editor service, if any. */
    fun server(): PiwiLanguageServer? =
        LspServerManager.getInstance(project).getServersForProvider(PiwiLspServerSupportProvider::class.java)
            .firstOrNull()?.piwiServer()

    /**
     * Read the latest run and its failures again, not the indexes **Refresh** fetches (`piwi/refreshRun`), then the
     * status, on a pooled thread: the status bar item's click. `refreshing` is set meanwhile.
     */
    fun refreshRun() {
        if (refreshing) return
        refreshing = true
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                server()?.refreshRun()?.orNull()
            } finally {
                refreshing = false
            }
            refreshStatus()
        }
    }

    /**
     * The status `piwi/statusChanged` carries: the connection of each context, and the desktop app. The open files'
     * coverage is asked again, from the service as it is now connected.
     */
    fun statusChanged(result: StatusResult) {
        synchronized(lock) {
            status = result
            statusPushes++
        }
        changed()
        refreshKnownAddresses()
        offerDesktop(result)
        project.getServiceIfCreated(PiwiCoverageMarks::class.java)?.askOpen()
    }

    /** A file's coverage changed (`piwi/coverageChanged`): its Code Vision lines are asked again. On any thread. */
    fun coverageChanged(file: VirtualFile) {
        pushed.incrementAndGet()
        ApplicationManager.getApplication().invokeLater({
            ApplicationManager.getApplication().runReadAction {
                PsiManager.getInstance(project).findFile(file)?.let { DaemonCodeAnalyzer.getInstance(project).restart(it) }
            }
        }, gone)
    }

    /** The runs `piwi/runStatusChanged` carries: the latest run of each context, and the run in progress. */
    fun runStatusChanged(result: RunStatusResult) {
        synchronized(lock) {
            runs = result
            runsPushes++
        }
        changed()
    }

    /** The failures `piwi/failuresChanged` carries, such as a line an edit moved. */
    fun failuresChanged(result: FailuresResult) {
        synchronized(lock) {
            failuresResult = result
            failures = result.items.orEmpty()
            failuresPushes++
        }
        changed()
    }

    /**
     * Read the failures grouped as the tool window groups them now, which the service keeps for what it pushes after,
     * then tell the listeners. The answer is taken as a push is, where it comes among them.
     */
    fun regroup() {
        ApplicationManager.getApplication().executeOnPooledThread {
            server()?.failures(FailuresParams(local().failuresGrouping))?.thenAccept { read ->
                if (read != null && !gone.value(null)) failuresChanged(read)
            }
        }
    }

    /**
     * Read the status, the latest run and its failures again, on a pooled thread, then tell the listeners. A read asked
     * for while one runs follows it, once.
     */
    fun refreshStatus() {
        readAgain.set(true)
        if (!reading.compareAndSet(false, true)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                while (readAgain.getAndSet(false) && !gone.value(null)) read()
            } finally {
                reading.set(false)
            }
            // Asked for between the last check and the end of the loop.
            if (readAgain.get()) refreshStatus()
        }
    }

    private fun read() {
        val server = server()
        val pushes = synchronized(lock) { Triple(statusPushes, runsPushes, failuresPushes) }
        val readStatus = server?.status()?.orNull()
        val readRuns = server?.runStatus()?.orNull()
        val readFailures = server?.failures(FailuresParams(local().failuresGrouping))?.orNull()
        synchronized(lock) {
            if (statusPushes == pushes.first) status = readStatus
            if (runsPushes == pushes.second) runs = readRuns
            if (failuresPushes == pushes.third) {
                failuresResult = readFailures
                failures = readFailures?.items.orEmpty()
            }
        }
        readKnownAddresses()
        changed()
        offerDesktop(status)
    }

    /**
     * Tell the listeners on the event thread, once for every change made until then, and draw the open files again as
     * far as the runs they show changed ([draw]).
     */
    private fun changed() {
        pushed.incrementAndGet()
        if (!changeQueued.compareAndSet(false, true)) return
        ApplicationManager.getApplication().invokeLater({
            changeQueued.set(false)
            listeners.forEach { it() }
            draw()
        }, gone)
    }

    /**
     * Draw the open files again as far as the runs they show changed (`Glue.redraw`): at once for another run, at most
     * every [LIVE_TESTS_DRAW_MILLIS] for the tests a run in progress begins and ends. On the event thread.
     */
    private fun draw() {
        val shown = runs
        val redraw = Glue.redraw(drawn, shown)
        if (redraw == Glue.Redraw.TESTS) {
            val wait = testsDrawnAt + LIVE_TESTS_DRAW_MILLIS - System.currentTimeMillis()
            if (wait > 0) {
                if (drawQueued.compareAndSet(false, true)) {
                    AppExecutorUtil.getAppScheduledExecutorService().schedule(
                        {
                            drawQueued.set(false)
                            ApplicationManager.getApplication().invokeLater({ draw() }, gone)
                        },
                        wait,
                        TimeUnit.MILLISECONDS,
                    )
                }
                return
            }
            testsDrawnAt = System.currentTimeMillis()
        }
        drawn = shown
        drawAgain(redraw)
    }

    /**
     * Draw the open files Piwi reads again, or only those whose tests show a result: their gutter, their backgrounds and
     * Code Vision. Other files, and other languages, keep their highlighting.
     */
    private fun drawAgain(kind: Glue.Redraw) {
        if (kind == Glue.Redraw.NONE) return
        val open = FileEditorManager.getInstance(project).openFiles.filter { PiwiLspServerSupportProvider.isSupported(it) }
        filesWithTests.retainAll(open.mapTo(HashSet()) { it.url })
        val files = if (kind == Glue.Redraw.ALL) open else open.filter { it.url in filesWithTests }
        if (files.isEmpty()) return
        val analyzer = DaemonCodeAnalyzer.getInstance(project)
        ApplicationManager.getApplication().runReadAction {
            val psi = PsiManager.getInstance(project)
            for (file in files) psi.findFile(file)?.let { analyzer.restart(it) }
        }
    }

    /** Whether a file shows its tests' results in the gutter, as `PiwiTestAnnotator` last drew it. */
    fun showsTests(file: VirtualFile, shows: Boolean) {
        if (shows) filesWithTests += file.url else filesWithTests -= file.url
    }

    /**
     * `piwi/fileSummary` for `file` when its text is at `stamp` (its document's modification stamp): asked once, for the
     * gutter and Code Vision of one highlighting pass, and asked again once the text or anything the service pushes
     * changed, or after [SUMMARY_TTL_MILLIS]. Null while the service does not run, and for a file that is not on disk.
     */
    fun fileSummary(file: VirtualFile, stamp: Long): CompletableFuture<FileSummary?>? {
        val server = server() ?: return null
        val uri = runCatching { file.toNioPath().toUri().toString() }.getOrNull() ?: return null
        // Read before the request: a change pushed while it is sent makes the next pass ask again.
        return summaries.get(uri, stamp, pushed.get(), System.currentTimeMillis()) { server.fileSummary(UriParams(uri)) }
    }

    /**
     * Once per project: when the desktop app runs while another instance is in use, offer to read
     * the project from the app. The other instance stays saved, one Connect away.
     */
    @Synchronized
    private fun offerDesktop(status: StatusResult?) {
        val local = local()
        if (status?.desktopUrl == null || local.desktopOffered) return
        val contexts = status.contexts.orEmpty()
        val current = contexts.firstOrNull { it.connected } ?: contexts.firstOrNull() ?: return
        if (current.source == "desktop" || current.serverUrl == null) return
        local.desktopOffered = true
        NotificationGroupManager.getInstance().getNotificationGroup("Piwi")
            .createNotification(
                "The Piwi desktop app runs on this machine. Read this project from it rather than ${current.serverUrl}? " +
                    "Connect switches back.",
                NotificationType.INFORMATION,
            )
            .addAction(NotificationAction.createSimpleExpiring("Use the Desktop App") { PiwiConnectFlow.useDesktop(project) })
            .notify(project)
    }

    override fun dispose() {
        disposed = true
        listeners.clear()
        summaries.clear()
        filesWithTests.clear()
    }

    private fun credentialAttributes(serverUrl: String) =
        PiwiCredentials.attributes(generateServiceName("Piwi", Glue.apiKeyEntry(serverUrl)))

    /**
     * Deletes the key shared by every instance, once: a project naming another
     * instance would send it there. Connect again to save a key per instance.
     */
    private fun forgetSharedKey() {
        val properties = com.intellij.ide.util.PropertiesComponent.getInstance()
        if (properties.getBoolean(SHARED_KEY_FORGOTTEN)) return
        properties.setValue(SHARED_KEY_FORGOTTEN, true)
        PasswordSafe.instance.setPassword(PiwiCredentials.attributes(generateServiceName("Piwi", "apiKey")), null)
    }

    companion object {
        const val TIMEOUT_SECONDS = 20L
        private const val SHARED_KEY_FORGOTTEN = "piwi.sharedKeyForgotten"

        /** How long a file's summary answers for the same text: the indexes the service reads again push nothing. */
        const val SUMMARY_TTL_MILLIS = 5_000L

        /** How often, at most, the files are drawn again for the tests a run in progress begins and ends. */
        const val LIVE_TESTS_DRAW_MILLIS = 1_000L

        private const val MAX_SUMMARIES = 64

        /** The id of **Settings → Languages & Frameworks → Node.js**. */
        private const val NODE_SETTINGS_ID = "settings.nodejs"
    }
}

/** Searches the project for Playwright configs once it is open, off the event thread, then whenever one comes or goes. */
class PiwiStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        val service = project.service<PiwiProjectService>()
        service.findPlaywright()
        service.watchConfigs()
        project.service<PiwiCoverageMarks>().start()
    }
}

/**
 * The answer of a service request, or null when it failed or took too long. A task with progress stops waiting at its
 * Cancel button.
 */
fun <T> CompletableFuture<T>.orNull(): T? = awaitCancellably(TimeUnit.SECONDS.toMillis(PiwiProjectService.TIMEOUT_SECONDS))

/**
 * The answer of a service request, or null when it failed or took longer than `timeoutMillis`.
 * The wait ends as soon as the platform cancels the caller: a read action gives way to a write
 * action, such as typing, and a task with progress stops at its Cancel button.
 */
fun <T> CompletableFuture<T>.awaitCancellably(timeoutMillis: Long): T? {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
    while (true) {
        ProgressManager.checkCanceled()
        try {
            return get(10, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            if (System.nanoTime() >= deadline) return null
        } catch (_: Exception) {
            return null
        }
    }
}

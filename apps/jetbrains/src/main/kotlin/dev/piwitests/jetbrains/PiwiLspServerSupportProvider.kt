package dev.piwitests.jetbrains

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.util.ExecUtil
import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.Lsp4jClient
import com.intellij.platform.lsp.api.LspServer
import com.intellij.platform.lsp.api.LspServerNotificationsHandler
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import com.intellij.platform.lsp.api.customization.LspCommandsSupport
import com.intellij.platform.lsp.api.lsWidget.LspServerWidgetItem
import org.eclipse.lsp4j.Command
import org.eclipse.lsp4j.InitializeParams
import org.eclipse.lsp4j.WorkspaceFolder
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.services.LanguageServer
import java.lang.ref.WeakReference
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.CompletableFuture

/**
 * Starts the editor service for projects that hold a Playwright config, on the files it reads.
 * Until the search for configs started with the project ends, it starts nothing: the search
 * starts the service for the files already open.
 */
class PiwiLspServerSupportProvider : LspServerSupportProvider {
    override fun fileOpened(project: Project, file: VirtualFile, serverStarter: LspServerSupportProvider.LspServerStarter) {
        val service = project.service<PiwiProjectService>()
        if (!isSupported(file) || !service.hasPlaywrightConfig()) return
        if (!service.trusted()) return service.waitForTrust()
        serverStarter.ensureServerStarted(PiwiLspServerDescriptor(project))
    }

    /** The service's entry in the Language Services widget: Piwi's icon, and the gear that opens **Settings → Tools → Piwi**. */
    override fun createLspServerWidgetItem(lspServer: LspServer, currentFile: VirtualFile?): LspServerWidgetItem =
        LspServerWidgetItem(lspServer, currentFile, ICON, PiwiConfigurable::class.java)

    companion object {
        private val ICON = IconLoader.getIcon("/icons/piwi.svg", PiwiLspServerSupportProvider::class.java)

        fun isSupported(file: VirtualFile): Boolean =
            file.isInLocalFileSystem && (file.extension?.lowercase() ?: "") in Glue.SUPPORTED_EXTENSIONS
    }
}

/** How long `node --version` may take before the interpreter counts as not running. */
private const val NODE_VERSION_TIMEOUT_MILLIS = 10_000

/** A public https address: the proxy the IDE would use for it is the one for an instance off this machine. */
private const val REPRESENTATIVE_INSTANCE = "https://piwitests.dev"

class PiwiLspServerDescriptor(project: Project) : ProjectWideLspServerDescriptor(project, "Piwi") {
    override fun isSupportedFile(file: VirtualFile): Boolean = PiwiLspServerSupportProvider.isSupported(file)

    override fun createCommandLine(): GeneralCommandLine {
        val server = serverBundle()
        if (!Files.isRegularFile(server)) throw ExecutionException("The Piwi editor service is missing: $server")
        val interpreter = NodeJsInterpreterManager.getInstance(project).interpreter
        val node = (interpreter as? NodeJsLocalInterpreter)?.interpreterSystemDependentPath ?: "node"
        val problem = Glue.nodeProblem(node, nodeVersion(node))
        project.service<PiwiProjectService>().startFailed(problem)
        if (problem != null) throw ExecutionException(problem)
        val folder = project.service<PiwiProjectService>().searchRoots().firstOrNull()?.toString() ?: project.basePath
        // The service exits within seconds of the IDE's end, however it ends: the platform does not pass its process id.
        return GeneralCommandLine(node, server.toString(), "--stdio", "--clientProcessId=${ProcessHandle.current().pid()}")
            .withWorkDirectory(folder)
            .withCharset(Charsets.UTF_8)
            .withEnvironment(proxyEnvironment())
    }

    /**
     * The IDE's HTTP proxy for the instance the project names ([REPRESENTATIVE_INSTANCE] stands in while none is saved),
     * as the variables the service's Node.js reads (`Glue.proxyEnvironment`); none when the IDE reaches it directly. The
     * IDE's proxy settings, auto-detected ones included, are the default [ProxySelector], which exposes no exceptions:
     * `NO_PROXY` keeps this machine's addresses direct.
     */
    internal fun proxyEnvironment(selector: ProxySelector? = ProxySelector.getDefault()): Map<String, String> {
        val instance = project.service<PiwiProjectService>().settings().serverUrl.ifBlank { null } ?: REPRESENTATIVE_INSTANCE
        val uri = runCatching { URI(instance) }.getOrNull() ?: return emptyMap()
        val proxies = runCatching { selector?.select(uri) }.getOrNull().orEmpty()
        val address = proxies.firstOrNull { it.type() == Proxy.Type.HTTP }?.address() as? InetSocketAddress ?: return emptyMap()
        return Glue.proxyEnvironment(address.hostString, address.port, emptyList())
    }

    /** What `node --version` prints, or null when it does not run, or not within 10 s. */
    private fun nodeVersion(node: String): String? = runCatching {
        val output = ExecUtil.execAndGetOutput(GeneralCommandLine(node, "--version"), NODE_VERSION_TIMEOUT_MILLIS)
        output.stdout.takeIf { output.exitCode == 0 && !output.isTimeout }
    }.getOrNull()

    /** The workspace is the folders the plugin searched for Playwright configs: the service searches them again. */
    override fun createInitializeParams(): InitializeParams = super.createInitializeParams().apply {
        val roots = project.service<PiwiProjectService>().searchRoots()
        if (roots.isEmpty()) return@apply
        val files = LocalFileSystem.getInstance()
        workspaceFolders = roots.map { root ->
            val uri = files.findFileByNioFile(root)?.let { getFileUri(it) } ?: root.toUri().toString()
            WorkspaceFolder(uri, root.fileName?.toString() ?: root.toString())
        }
    }

    /**
     * The service bundle: `server/` beside the plugin's `lib/`, or the path the
     * `piwi.editor.server` system property names (the tests set it).
     */
    private fun serverBundle(): Path {
        System.getProperty("piwi.editor.server")?.let { return Path.of(it) }
        val jar = PathManager.getJarPathForClass(PiwiLspServerDescriptor::class.java)
            ?: throw ExecutionException("The Piwi plugin's location is unknown")
        return Path.of(jar).parent.parent.resolve("server").resolve("piwi-language-server.cjs")
    }

    override fun createInitializationOptions(): Any =
        mapOf("credentials" to project.service<PiwiProjectService>().credentials())

    override val lsp4jServerClass: Class<out org.eclipse.lsp4j.services.LanguageServer> = PiwiLanguageServer::class.java

    override fun createLsp4jClient(handler: LspServerNotificationsHandler): Lsp4jClient = PiwiLsp4jClient(handler, project)

    override val lspCommandsSupport: LspCommandsSupport = object : LspCommandsSupport() {
        override fun executeCommand(server: LspServer, contextFile: VirtualFile, command: Command) {
            PiwiCommands.execute(project, command.command, command.arguments.orEmpty())
        }
    }
}

/** The lsp4j proxy of a running service, with the service's own requests; null until it runs. */
fun LspServer.piwiServer(): PiwiLanguageServer? = Lsp4jAccess.server(this) as? PiwiLanguageServer

/**
 * The lsp4j proxy of a running service. The platform hands it only to a request's sender, so it
 * is taken from a `sendRequestSync` that sends nothing: the platform runs the sender while the
 * service runs, and waits for it. Kept per server.
 */
object Lsp4jAccess {
    private val found = Collections.synchronizedMap(WeakHashMap<LspServer, WeakReference<LanguageServer>>())

    fun server(server: LspServer): LanguageServer? {
        found[server]?.get()?.let { return it }
        var captured: LanguageServer? = null
        server.sendRequestSync<Any?>(1_000) { lsp4j ->
            captured = lsp4j
            CompletableFuture.completedFuture(null)
        }
        return captured?.also { found[server] = WeakReference(it) }
    }
}

/** Receives the service's notifications beside the protocol's. */
class PiwiLsp4jClient(handler: LspServerNotificationsHandler, private val project: Project) : Lsp4jClient(handler) {
    /** The latest run or the run in progress moved: the status bar, the tool window and, as far as they show it, the files. */
    @JsonNotification("piwi/runStatusChanged")
    fun runStatusChanged(status: RunStatusResult) {
        project.service<PiwiProjectService>().runStatusChanged(status)
    }

    /** A context connected or lost its connection, or the desktop app started or quit. */
    @JsonNotification("piwi/statusChanged")
    fun statusChanged(status: StatusResult) {
        project.service<PiwiProjectService>().statusChanged(status)
    }

    /** A failure moved with an edit, or its line changed since the run: the tool window's list. */
    @JsonNotification("piwi/failuresChanged")
    fun failuresChanged(failures: FailuresResult) {
        project.service<PiwiProjectService>().failuresChanged(failures)
    }

    /** A file's coverage marks moved with an edit, or its coverage was read again: the marks, and its Code Vision lines. */
    @JsonNotification("piwi/coverageChanged")
    fun coverageChanged(result: CoverageResult) {
        val file = project.service<PiwiCoverageMarks>().arrived(result) ?: return
        project.service<PiwiProjectService>().coverageChanged(file)
    }

    @JsonNotification("piwi/desktopJobChanged")
    fun desktopJobChanged(update: DesktopJobUpdate) {
        PiwiCommands.desktopJobChanged(project, update)
    }

    @JsonNotification("piwi/recordingChanged")
    fun recordingChanged(update: RecordingUpdate) {
        project.service<PiwiRecordings>().changed(update)
    }

    /** A run the editor started ended: what it changed, as a balloon. */
    @JsonNotification("piwi/runEnded")
    fun runEnded(ended: RunEnded) {
        PiwiCommands.runEnded(project, ended)
    }

    /** A sentence on a run the editor started, such as one that never reached the instance: a balloon, once. */
    @JsonNotification("piwi/notice")
    fun notice(notice: NoticeParams) {
        val message = notice.message ?: return
        val type = if (notice.severity == "warning") NotificationType.WARNING else NotificationType.INFORMATION
        PiwiCommands.notify(project, message, type)
    }
}

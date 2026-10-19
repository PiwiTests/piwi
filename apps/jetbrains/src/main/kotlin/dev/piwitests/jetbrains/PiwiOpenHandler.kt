package dev.piwitests.jetbrains

import com.google.gson.Gson
import com.intellij.ide.impl.ProjectUtil
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationNamesInfo
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.util.Computable
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.IdeFocusManager
import io.netty.buffer.Unpooled
import io.netty.channel.ChannelFutureListener
import io.netty.channel.ChannelHandlerContext
import io.netty.handler.codec.http.DefaultFullHttpResponse
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpHeaderNames
import io.netty.handler.codec.http.HttpRequest
import io.netty.handler.codec.http.HttpResponseStatus
import io.netty.handler.codec.http.HttpVersion
import io.netty.handler.codec.http.QueryStringDecoder
import org.jetbrains.ide.RestService
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean

/**
 * `GET /api/piwi/open?file=<path>&line=<n>&column=<n>` on the IDE's built-in server: the
 * dashboard's Open in IDE. It finds the file in the projects open in this IDE (a path relative
 * to the run's working directory is looked up under each Playwright config's directory, the
 * project directory and the content roots, so a Rider solution in a subfolder or a Playwright
 * project inside a monorepo resolves without any setting), opens it at the 1-based line and
 * column, and brings the project window to the front. With `check`, it only says whether it
 * would. It answers JSON the dashboard can read, so the dashboard knows the file opened, and in
 * which IDE, where a `jetbrains://` link or the platform's `/api/file` cannot tell.
 *
 * Only a page of a Piwi instance a project open here reports to, or of the Piwi desktop app,
 * gets an answer ([OpenOrigins]): its `Origin` must be one of theirs, and an instance's page finds
 * files in the projects connected to it only. Any other request for this path gets a 403 from
 * this handler. The platform's own rules, which trust any page on this
 * machine and every page once the built-in server allows unsigned requests, do not apply. The
 * platform still refuses a request whose `Host` is not this machine.
 */
class PiwiOpenHandler : RestService() {
    override fun getServiceName(): String = SERVICE

    /**
     * Every origin: this handler answers every request for its path whose `Host` is this machine, so none reaches
     * another handler of the built-in server, and [isHostTrusted] decides which ones get more than a 403.
     */
    override fun isOriginAllowed(request: HttpRequest): OriginCheckResult = OriginCheckResult.ALLOW

    override fun isHostTrusted(request: FullHttpRequest, urlDecoder: QueryStringDecoder): Boolean {
        val origin = request.headers().get(HttpHeaderNames.ORIGIN)
        if (trusts(origin)) return true
        OpenOrigins.originOf(origin)?.let { refused(it) }
        return false
    }

    /** Whether a request with this `Origin` may open files: it is the desktop app's, or an open project's instance. */
    fun trusts(origin: String?): Boolean {
        val known = knownAddresses()
        return OpenOrigins.isAllowed(origin, OpenOrigins.allowed(known.everywhere)) ||
            OpenOrigins.projectsFor(origin, emptyList(), known.byProject).isNotEmpty()
    }

    /** The open projects a page with this `Origin` may open files in ([OpenOrigins.projectsFor]). */
    fun projectsFor(origin: String?): List<Project> {
        val known = knownAddresses()
        return OpenOrigins.projectsFor(origin, known.everywhere, known.byProject)
    }

    /** The addresses whose pages may open files in every open project, and those of each project alone. */
    private class KnownAddresses(val everywhere: List<String?>, val byProject: Map<Project, List<String?>>)

    /**
     * The desktop app, as its discovery file and the editor service name it, and the instance in the environment, for
     * every project; for each open project, its instance wherever else it is named (the workspace `.env`, the
     * settings, what the editor service reads).
     */
    private fun knownAddresses(): KnownAddresses {
        val everywhere = mutableListOf(System.getenv("PIWI_DASHBOARD_URL"), desktopDiscoveryUrl())
        val byProject = LinkedHashMap<Project, List<String?>>()
        for (project in ProjectManager.getInstance().openProjects) {
            if (project.isDefault || project.isDisposed) continue
            val service = project.service<PiwiProjectService>()
            everywhere += service.status?.desktopUrl
            byProject[project] = buildList {
                add(service.settings().serverUrl)
                service.status?.contexts.orEmpty().forEach { context ->
                    add(context.serverUrl)
                    add(context.instance?.serverUrl)
                }
                for (dir in if (service.trusted()) service.playwrightConfigDirs() else emptyList()) {
                    val dotEnv = dir.resolve(".env")
                    if (Files.isRegularFile(dotEnv)) add(OpenOrigins.dashboardUrlFromDotEnv(runCatching { Files.readString(dotEnv) }.getOrNull()))
                }
            }
        }
        return KnownAddresses(everywhere, byProject)
    }

    /** The desktop app's address in its discovery file ([Glue.desktopConfigPath]), while it runs. */
    private fun desktopDiscoveryUrl(): String? {
        val file = Glue.desktopConfigPath(System.getenv(), System.getProperty("user.home")) ?: return null
        return Glue.parseDesktopDiscovery(runCatching { Files.readString(file) }.getOrNull())?.url
    }

    /** Names the first page refused in this IDE session in a notification; later refusals are silent. */
    private fun refused(origin: String) {
        val project = IdeFocusManager.getGlobalInstance().lastFocusedFrame?.project
            ?: ProjectManager.getInstance().openProjects.firstOrNull { !it.isDefault }
            ?: return
        if (!NOTIFIED.compareAndSet(false, true)) return
        PiwiCommands.notify(
            project,
            "Piwi refused to open a file for $origin: only the Piwi instance an open project is connected to " +
                "(Settings → Tools → Piwi) and the desktop app can open files.",
            NotificationType.WARNING,
        )
    }

    override fun execute(urlDecoder: QueryStringDecoder, request: FullHttpRequest, context: ChannelHandlerContext): String? {
        val origin = request.headers().get(HttpHeaderNames.ORIGIN)
        when (val parsed = Glue.parseOpenRequest(urlDecoder.parameters())) {
            is Glue.OpenRequest.Refused -> respond(context, origin, HttpResponseStatus.BAD_REQUEST, mapOf("error" to parsed.error))
            is Glue.OpenRequest.File -> ApplicationManager.getApplication().executeOnPooledThread {
                val (status, body) = try {
                    answer(parsed, projectsFor(origin))
                } catch (e: Exception) {
                    HttpResponseStatus.INTERNAL_SERVER_ERROR to mapOf("error" to (e.message ?: e.javaClass.simpleName))
                }
                respond(context, origin, status, body)
            }
        }
        return null
    }

    /** The answer to a request whose page may open files in [allowed], the open projects its origin reaches. */
    private fun answer(request: Glue.OpenRequest.File, allowed: List<Project>): Pair<HttpResponseStatus, Map<String, Any?>> {
        val ide = ApplicationNamesInfo.getInstance().fullProductName
        val projects = rankedProjects(request.piwiProject, allowed)
        val found = projects.firstNotNullOfOrNull { project -> locate(project, request.path, request.root)?.let { project to it } }
            ?: return HttpResponseStatus.NOT_FOUND to mapOf(
                "found" to false,
                "ide" to ide,
                "projects" to projects.map { it.name },
                "error" to if (projects.isEmpty()) "no project is open in $ide" else "no project open in $ide holds ${request.path}",
            )
        val (project, file) = found
        if (!request.check) open(project, file, request.line, request.column)
        return HttpResponseStatus.OK to mapOf(
            "found" to true,
            "opened" to !request.check,
            "ide" to ide,
            "project" to project.name,
            "file" to file.path,
        )
    }

    /** The [allowed] projects still open: the ones connected to the Piwi project first, then the last focused one. */
    private fun rankedProjects(piwiProject: String?, allowed: List<Project>): List<Project> {
        val open = allowed.filter { !it.isDefault && !it.isDisposed }
        val focused = IdeFocusManager.getGlobalInstance().lastFocusedFrame?.project
        return open.sortedWith(
            compareByDescending<Project> { piwiProject != null && reportsTo(it, piwiProject) }.thenByDescending { it == focused },
        )
    }

    private fun reportsTo(project: Project, piwiProject: String): Boolean {
        val service = project.service<PiwiProjectService>()
        return service.settings().project == piwiProject || service.status?.contexts.orEmpty().any { it.projectName == piwiProject }
    }

    /**
     * The file in the project: under the dashboard's root, then under a directory a run's paths start from, or an
     * absolute path. Wherever it was found, it must be inside the project.
     */
    private fun locate(project: Project, path: String, root: String?): VirtualFile? {
        val service = project.service<PiwiProjectService>()
        val roots = ApplicationManager.getApplication().runReadAction(Computable {
            buildList {
                service.status?.contexts.orEmpty().mapNotNullTo(this) { it.root }
                service.playwrightConfigDirs().mapTo(this) { it.toString() }
                service.searchRoots().mapTo(this) { it.toString() }
                project.basePath?.let { add(it) }
                ProjectRootManager.getInstance(project).contentRoots.mapTo(this) { it.path }
            }
        })
        for (candidate in Glue.candidatePaths(path, listOfNotNull(root) + roots)) {
            val io = File(candidate)
            if (!io.isFile) continue
            // Refreshed, so a spec file created since the IDE last scanned the disk is found too.
            val file = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(io) ?: continue
            val inProject = ApplicationManager.getApplication().runReadAction(Computable {
                ProjectFileIndex.getInstance(project).isInContent(file) || roots.any { FileUtil.isAncestor(it, file.path, false) }
            })
            if (inProject) return file
        }
        return null
    }

    private fun open(project: Project, file: VirtualFile, line: Int?, column: Int?) {
        ApplicationManager.getApplication().invokeLater({
            // The descriptor's line and column are 0-based.
            val descriptor = if (line == null) OpenFileDescriptor(project, file) else OpenFileDescriptor(project, file, line - 1, (column ?: 1) - 1)
            descriptor.navigate(true)
            ProjectUtil.focusProjectWindow(project, true)
        }, project.disposed)
    }

    private fun respond(context: ChannelHandlerContext, origin: String?, status: HttpResponseStatus, body: Map<String, Any?>) {
        val bytes = Gson().toJson(body).toByteArray()
        val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.wrappedBuffer(bytes))
        val headers = response.headers()
        headers.set(HttpHeaderNames.CONTENT_TYPE, "application/json")
        headers.set(HttpHeaderNames.CONTENT_LENGTH, bytes.size)
        headers.set(HttpHeaderNames.CACHE_CONTROL, "no-store")
        // The request passed the origin check, so the page that sent it may read the answer.
        if (origin != null) {
            headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            headers.set(HttpHeaderNames.VARY, "Origin")
        }
        context.channel().writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
    }

    companion object {
        /** Served at `/api/piwi/open`. */
        const val SERVICE = "piwi/open"
        const val PATH = "/api/$SERVICE"

        /** Whether a refused page was already named in a notification this session. */
        private val NOTIFIED = AtomicBoolean()
    }
}

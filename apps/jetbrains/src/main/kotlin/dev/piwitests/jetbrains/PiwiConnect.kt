package dev.piwitests.jetbrains

import com.google.gson.Gson
import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationNamesInfo
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.SystemInfo
import com.intellij.ui.components.JBRadioButton
import com.intellij.ui.dsl.builder.panel
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import javax.swing.JComponent

/** The instance's side of Connect: its projects, and the browser sign-in (an RFC 8628 device authorization). */
object PiwiInstance {
    private val gson = Gson()
    // HTTP/1.1: over plain http, the default HTTP/2 asks the server to upgrade (`Upgrade: h2c`), and a
    // Node server that takes upgrades for its WebSockets, such as `nuxt dev`, drops the request.
    private val http: HttpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build()

    /** For an instance on this machine: the IDE's proxy settings never apply to it. */
    private val loopback: HttpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .proxy(HttpClient.Builder.NO_PROXY)
        .build()

    class HttpStatus(val status: Int) : Exception("the instance answered $status")

    /** No address of the instance answered. */
    class Unreachable(tried: List<String>) : Exception(
        "nothing answers at ${tried.first()}" +
            (if (tried.size > 1) " (nor at ${tried.drop(1).joinToString(" or ")})" else "") +
            ". Is the instance running, on that port?",
    )

    /** Where the instance answered, and whether it asks for a key. */
    data class Reached(val url: String, val needsKey: Boolean)

    data class ProjectItem(val id: Int = 0, val name: String = "")
    private data class Menu(val items: List<ProjectItem>? = null)

    data class SignIn(
        val deviceCode: String = "",
        val userCode: String = "",
        val verificationUrl: String = "",
        val interval: Int = 5,
        val expiresIn: Int = 600,
    )

    data class SignInAnswer(val status: String = "", val interval: Int? = null, val apiKey: String? = null)

    fun projects(url: String, key: String?): List<ProjectItem> =
        gson.fromJson(send(url, "/api/projects/menu", key, null), Menu::class.java)?.items.orEmpty()

    /**
     * The instance's address and whether it asks for a key: it lists its projects to anyone when
     * authentication is off. An instance on this machine is tried on every loopback address
     * (`Glue.loopbackAlternatives`): a server started on `localhost` may listen on one of them only,
     * `::1` on Windows, while Java connects to the first address the name resolves to.
     */
    fun reach(url: String): Reached {
        val tried = Glue.loopbackAlternatives(url)
        for (base in tried) {
            try {
                projects(base, null)
                return Reached(base, false)
            } catch (e: HttpStatus) {
                if (e.status == 401 || e.status == 403) return Reached(base, true) else throw e
            } catch (e: java.io.IOException) {
                // Only an address nothing listens on moves to the next one; any other failure is the instance's.
                val notListening = e is java.net.SocketException || e is java.net.http.HttpConnectTimeoutException
                if (tried.size == 1 || !notListening) throw e
            }
        }
        throw Unreachable(tried)
    }

    fun startSignIn(url: String, editor: String, os: String): SignIn =
        gson.fromJson(send(url, "/api/extension/connect", null, gson.toJson(mapOf("editor" to editor, "os" to os))), SignIn::class.java)

    fun pollSignIn(url: String, deviceCode: String): SignInAnswer =
        gson.fromJson(send(url, "/api/extension/connect/token", null, gson.toJson(mapOf("deviceCode" to deviceCode))), SignInAnswer::class.java)

    private fun send(url: String, path: String, key: String?, json: String?): String {
        val request = HttpRequest.newBuilder(URI("$url$path")).timeout(Duration.ofSeconds(15))
        if (json == null) request.GET() else request.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(json))
        if (!key.isNullOrEmpty()) request.header("X-API-Key", key)
        val client = if (Glue.isLoopback(url)) loopback else http
        val response = client.send(request.build(), HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) throw HttpStatus(response.statusCode())
        return response.body()
    }
}

/**
 * Piwi: Connect — the instance, a key for it (signed in with the browser, or pasted), and the
 * project. Runs on the event thread with modal progress for each request, so it works from the
 * settings page too. Returns whether it saved a connection.
 */
object PiwiConnectFlow {
    private const val TITLE = "Piwi: Connect"

    fun run(project: Project, presetUrl: String? = null): Boolean {
        val service = project.service<PiwiProjectService>()
        service.local().desktopOffered = true
        // The desktop app running on this machine needs no address or sign-in: offer it first,
        // beside the instance the project names, so either is one choice away.
        val desktop = request(project, "Looking for the Piwi desktop app…") { service.desktop() }?.takeIf { it.url != null }
        val preset = Glue.normalizeServerUrl(presetUrl)
        if (desktop != null && (preset == null || preset == desktop.url)) {
            if (preset == desktop.url) return useDesktop(project, desktop)
            val dialog = ChooseConnectionDialog(project, Glue.connectChoices(service.status, desktop, service.settings().serverUrl))
            if (!dialog.showAndGet()) return false
            val choice = dialog.picked() ?: return false
            when (choice.target) {
                Glue.ConnectTarget.DESKTOP -> return useDesktop(project, desktop)
                Glue.ConnectTarget.INSTANCE -> {
                    service.useInstance()
                    PiwiCommands.notify(project, "Connected to ${choice.serverUrl}.")
                    return true
                }
                Glue.ConnectTarget.OTHER -> Unit
            }
        }
        val typed = preset ?: askUrl(project, service.settings().serverUrl) ?: return false
        if (desktop != null && typed == desktop.url) return useDesktop(project, desktop)
        val reached = request(project, "Reaching $typed…") { PiwiInstance.reach(typed) } ?: return false
        // The address that answered: on this machine, it may be another loopback address than the one typed.
        val url = reached.url
        if (desktop != null && url == desktop.url) return useDesktop(project, desktop)
        val key = if (reached.needsKey) askKey(project, url) ?: return false else null
        val projects = request(project, "Listing the projects of $url…") { PiwiInstance.projects(url, key.orEmpty()) } ?: return false
        if (projects.isEmpty()) {
            service.saveCredentials(url, "", key)
            Messages.showInfoMessage(
                project,
                "$url has no project yet. Send a run with the Piwi reporter, then pick the project in Settings → Tools → Piwi.",
                TITLE,
            )
            return true
        }
        val names = projects.map { it.name }
        val dialog = ChooseProjectDialog(project, names, service.settings().project.takeIf { it in names } ?: names.first())
        if (!dialog.showAndGet()) return false
        val picked = dialog.picked() ?: return false
        service.saveCredentials(url, picked, key)
        // The environment and a `.env` come before these settings.
        val first = service.status?.contexts.orEmpty().firstOrNull {
            (it.source == "environment" || it.source == "dotenv") && it.serverUrl != url
        }
        if (first != null) {
            PiwiCommands.notify(
                project,
                "Saved, but ${Glue.sourceLabel(first.source)} names ${first.serverUrl}, which comes before these settings.",
                NotificationType.WARNING,
            )
        } else {
            PiwiCommands.notify(project, "Connected to $picked on $url.")
        }
        return true
    }

    /** Use the desktop app, once it is found running: the offer's action, from the event thread. */
    fun useDesktop(project: Project): Boolean {
        val service = project.service<PiwiProjectService>()
        val desktop = request(project, "Looking for the Piwi desktop app…") { service.desktop() }?.takeIf { it.url != null }
        if (desktop == null) {
            Messages.showInfoMessage(project, "The Piwi desktop app is not running.", TITLE)
            return false
        }
        return useDesktop(project, desktop)
    }

    /**
     * Use the desktop app: it comes first while it runs, with its own address and token, and the
     * instance the project names stays saved for when it does not. The project is the one linked
     * there to this folder, else the one picked here.
     */
    private fun useDesktop(project: Project, desktop: DesktopResult): Boolean {
        val service = project.service<PiwiProjectService>()
        val linked = desktop.linked
        if (linked != null) {
            service.useDesktop(null)
            PiwiCommands.notify(project, "Connected to the desktop app, project ${linked.name} (linked to this folder).")
            return true
        }
        val names = desktop.projects.orEmpty().map { it.name }
        if (names.isEmpty()) {
            service.useDesktop(null)
            Messages.showInfoMessage(
                project,
                "The desktop app has no project yet. Import or send a run to it, then link this folder on the project's page there.",
                TITLE,
            )
            return true
        }
        val dialog = ChooseProjectDialog(project, names, service.local().desktopProject.takeIf { it in names } ?: names.first())
        if (!dialog.showAndGet()) return false
        val picked = dialog.picked() ?: return false
        service.useDesktop(picked)
        PiwiCommands.notify(
            project,
            "Connected to the desktop app, project $picked. Link this folder on the project's page there to skip this step.",
        )
        return true
    }

    /** Forget the saved connection after asking; returns whether it did. */
    fun disconnect(project: Project): Boolean {
        val service = project.service<PiwiProjectService>()
        val settings = service.settings()
        val question = Glue.disconnectQuestion(settings.serverUrl, settings.project, service.local().desktop) ?: return false
        if (Messages.showYesNoDialog(project, question, "Piwi: Disconnect", null) != Messages.YES) return false
        service.disconnect()
        return true
    }

    private fun askUrl(project: Project, saved: String): String? {
        val input = Messages.showInputDialog(
            project,
            "The Piwi instance's address",
            TITLE,
            null,
            saved.ifBlank { "http://localhost:3000" },
            null,
        ) ?: return null
        return Glue.normalizeServerUrl(input) ?: run {
            Messages.showErrorDialog(project, "An http(s) URL, such as https://piwi.example.com", TITLE)
            null
        }
    }

    /** A key for the instance, or null when the user cancelled or the sign-in failed. */
    private fun askKey(project: Project, url: String): String? {
        val choice = Messages.showDialog(
            project,
            "$url asks for an API key. Sign in with the browser to create one for this IDE, " +
                "or paste one from the dashboard's Settings → API keys.",
            TITLE,
            arrayOf("Sign In with the Browser", "Paste an API Key", Messages.getCancelButton()),
            0,
            AllIcons.General.User,
        )
        return when (choice) {
            0 -> signIn(project, url)
            1 -> pasteKey(project)
            else -> null
        }
    }

    private fun pasteKey(project: Project): String? =
        Messages.showPasswordDialog(project, "An API key (pd_…), from the dashboard's Settings → API keys", TITLE, null)
            ?.trim()?.ifBlank { null }

    private fun signIn(project: Project, url: String): String? {
        val started = try {
            ProgressManager.getInstance().run(
                task(project, "Starting the sign-in…") { PiwiInstance.startSignIn(url, editorName(), osName()) },
            )
        } catch (e: PiwiInstance.HttpStatus) {
            if (e.status != 404) return failed(project, url, e)
            Messages.showInfoMessage(project, "This instance predates the browser sign-in: paste an API key instead.", TITLE)
            return pasteKey(project)
        } catch (_: ProcessCanceledException) {
            return null
        } catch (e: Exception) {
            return failed(project, url, e)
        }
        if (Glue.normalizeServerUrl(started.verificationUrl) == null) {
            Messages.showErrorDialog(project, "$url answered an unexpected sign-in page: ${started.verificationUrl}", TITLE)
            return null
        }
        BrowserUtil.browse(started.verificationUrl)
        val answer = request(project, "Sign in with the browser") { indicator ->
            indicator.text = "Allow the request in your browser. It shows the code ${started.userCode}."
            indicator.text2 = "No browser opened? Go to ${started.verificationUrl}"
            var interval = started.interval.coerceIn(1, 60)
            val deadline = System.currentTimeMillis() + started.expiresIn * 1000L
            var decided: PiwiInstance.SignInAnswer? = null
            while (decided == null && System.currentTimeMillis() < deadline) {
                val wakeAt = System.currentTimeMillis() + interval * 1000L
                while (System.currentTimeMillis() < wakeAt) {
                    indicator.checkCanceled()
                    Thread.sleep(100)
                }
                val polled = PiwiInstance.pollSignIn(url, started.deviceCode)
                when (polled.status) {
                    "pending" -> Unit
                    "slow_down" -> interval = (polled.interval ?: (interval + 5)).coerceIn(1, 60)
                    else -> decided = polled
                }
            }
            decided ?: PiwiInstance.SignInAnswer("expired")
        } ?: return null
        return when (answer.status) {
            "approved" -> answer.apiKey?.ifBlank { null } ?: run {
                Messages.showErrorDialog(project, "$url allowed the request but sent no key.", TITLE)
                null
            }
            "denied" -> {
                Messages.showInfoMessage(project, "The request was denied in the browser.", TITLE)
                null
            }
            else -> {
                Messages.showInfoMessage(project, "The request expired. Run Connect again.", TITLE)
                null
            }
        }
    }

    /** Run one request with modal progress; null when it was cancelled or failed, after saying why. */
    private fun <T> request(project: Project, title: String, work: (ProgressIndicator) -> T): T? =
        try {
            ProgressManager.getInstance().run(task(project, title, work))
        } catch (_: ProcessCanceledException) {
            null
        } catch (e: Exception) {
            failed(project, null, e)
        }

    private fun <T> task(project: Project, title: String, work: (ProgressIndicator) -> T) =
        object : Task.WithResult<T, Exception>(project, title, true) {
            override fun compute(indicator: ProgressIndicator): T = work(indicator)
        }

    private fun <T> failed(project: Project, url: String?, e: Exception): T? {
        val reason = when {
            e is PiwiInstance.HttpStatus && (e.status == 401 || e.status == 403) -> "the instance refused the key (${e.status})"
            e is java.net.ConnectException -> "nothing answers there. Is the instance running, on that port?"
            e is java.net.http.HttpConnectTimeoutException -> "no answer within 10 seconds"
            e is java.net.UnknownHostException -> "unknown host ${e.message ?: ""}".trim()
            else -> e.message ?: e.javaClass.simpleName
        }
        Messages.showErrorDialog(project, "Could not connect${url?.let { " to $it" } ?: ""}: $reason", TITLE)
        return null
    }

    /**
     * The connections Connect offers when the desktop app runs, one radio button each. The UI DSL
     * accepts a radio button only inside a `buttonsGroup`, which groups them.
     */
    internal class ChooseConnectionDialog(project: Project, private val choices: List<Glue.ConnectChoice>) : DialogWrapper(project) {
        internal val buttons = choices.map { JBRadioButton(if (it.inUse) "${it.label} (in use)" else it.label) }

        init {
            title = TITLE
            // The one not in use: Connect is run to change something.
            (buttons.getOrNull(choices.indexOfFirst { !it.inUse }) ?: buttons.firstOrNull())?.isSelected = true
            init()
        }

        fun picked(): Glue.ConnectChoice? = choices.getOrNull(buttons.indexOfFirst { it.isSelected })

        override fun createCenterPanel(): JComponent = panel {
            buttonsGroup("Read this project from:") {
                buttons.forEachIndexed { i, button -> row { cell(button).comment(choices[i].detail) } }
            }
        }
    }

    private class ChooseProjectDialog(project: Project, names: List<String>, current: String) : DialogWrapper(project) {
        private val combo = ComboBox(names.toTypedArray()).apply { selectedItem = current }

        init {
            title = TITLE
            init()
        }

        fun picked(): String? = combo.selectedItem as? String

        override fun createCenterPanel(): JComponent = panel {
            row("Project:") { cell(combo).comment("The project this workspace reports to") }
        }
    }

    /** "WebStorm", "IntelliJ IDEA", "Rider": the name the sign-in page shows and the created key carries. */
    private fun editorName(): String = ApplicationNamesInfo.getInstance().fullProductName

    private fun osName(): String = when {
        SystemInfo.isMac -> "macOS"
        SystemInfo.isWindows -> "Windows"
        SystemInfo.isLinux -> "Linux"
        else -> SystemInfo.OS_NAME
    }
}

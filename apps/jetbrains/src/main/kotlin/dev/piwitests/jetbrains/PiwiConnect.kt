package dev.piwitests.jetbrains

import com.google.gson.Gson
import com.intellij.notification.NotificationType
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
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
        .connectTimeout(Duration.ofSeconds(Glue.CONNECT_TIMEOUT_S.toLong()))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build()

    /** For an instance on this machine: the IDE's proxy settings never apply to it. */
    private val loopback: HttpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(Glue.CONNECT_TIMEOUT_S.toLong()))
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

    /**
     * Wait for the browser's answer to a sign-in, asking at the interval the instance names, until it decides, the
     * request expires (`expired`) or `cancelled` says so (`cancelled`). Blocks: never on the event thread.
     */
    fun awaitSignIn(url: String, started: SignIn, cancelled: () -> Boolean): SignInAnswer {
        var interval = started.interval.coerceIn(1, 60)
        val deadline = System.currentTimeMillis() + started.expiresIn * 1000L
        while (System.currentTimeMillis() < deadline) {
            val wakeAt = System.currentTimeMillis() + interval * 1000L
            while (System.currentTimeMillis() < wakeAt) {
                if (cancelled()) return SignInAnswer("cancelled")
                Thread.sleep(100)
            }
            val polled = pollSignIn(url, started.deviceCode)
            when (polled.status) {
                "pending" -> Unit
                "slow_down" -> interval = (polled.interval ?: (interval + 5)).coerceIn(1, 60)
                else -> return polled
            }
        }
        return SignInAnswer("expired")
    }

    private fun send(url: String, path: String, key: String?, json: String?): String {
        val request = HttpRequest.newBuilder(URI("$url$path")).timeout(Duration.ofSeconds(Glue.ANSWER_TIMEOUT_S.toLong()))
        if (json == null) request.GET() else request.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(json))
        if (!key.isNullOrEmpty()) request.header("X-API-Key", key)
        val client = if (Glue.isLoopback(url)) loopback else http
        val response = client.send(request.build(), HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) throw HttpStatus(response.statusCode())
        return response.body()
    }
}

/**
 * Piwi: Connect — the Connect panel ([PiwiConnectPanel]) as one dialog: the desktop app or the instance, its key and its
 * project, saved on OK. Runs on the event thread, from the settings page too. Returns whether it saved a connection.
 */
object PiwiConnectFlow {
    private const val TITLE = "Piwi: Connect"

    fun run(project: Project, presetUrl: String? = null): Boolean {
        val service = project.service<PiwiProjectService>()
        service.local().desktopOffered = true
        if (!ConnectDialog(project, presetUrl).showAndGet()) return false
        confirm(project)
        return true
    }

    /**
     * Use the desktop app, the offer's action: the Connect dialog with the desktop app chosen, its project to confirm or
     * pick. The instance the project names stays saved, for when the app does not run.
     */
    fun useDesktop(project: Project): Boolean {
        val service = project.service<PiwiProjectService>()
        val local = service.local()
        val dialog = ConnectDialog(project, null)
        dialog.panel.desktopRadio.isSelected = true
        if (!dialog.showAndGet()) return false
        if (local.desktop) PiwiNotifier.confirm(project, Glue.desktopConnectedText(local.desktopProject))
        else confirm(project)
        return true
    }

    /** What Connect says once saved: the connection, or the environment or a `.env` naming another instance first. */
    private fun confirm(project: Project) {
        val service = project.service<PiwiProjectService>()
        val settings = service.settings()
        val local = service.local()
        if (local.desktop) return PiwiNotifier.confirm(project, Glue.desktopConnectedText(local.desktopProject))
        val url = settings.serverUrl
        if (url.isBlank()) return
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
            PiwiNotifier.confirm(project, settings.project.ifBlank { null }?.let { "Connected to $it on $url." } ?: "Saved $url: pick its project in Settings → Tools → Piwi.")
        }
    }

    /** Forget the saved connection after asking; returns whether it did. */
    fun disconnect(project: Project): Boolean {
        val service = project.service<PiwiProjectService>()
        val settings = service.settings()
        val question = Glue.disconnectQuestion(settings.serverUrl, settings.project, service.local().desktop) ?: run {
            Messages.showInfoMessage(project, Glue.NOTHING_SAVED, "Piwi: Disconnect")
            return false
        }
        if (Messages.showYesNoDialog(project, question, "Piwi: Disconnect", null) != Messages.YES) return false
        service.disconnect()
        return true
    }

    /** The Connect panel as one dialog, `presetUrl` in its address field; OK saves it. */
    internal class ConnectDialog(project: Project, presetUrl: String?) : DialogWrapper(project) {
        internal val panel = PiwiConnectPanel(project, disposable, presetUrl)

        init {
            title = TITLE
            setOKButtonText("Connect")
            init()
        }

        override fun createCenterPanel(): JComponent = panel.component

        override fun doOKAction() {
            try {
                panel.apply()
            } catch (e: com.intellij.openapi.options.ConfigurationException) {
                Messages.showErrorDialog(panel.component, e.messageHtml.toString(), TITLE)
                return
            }
            super.doOKAction()
        }
    }
}

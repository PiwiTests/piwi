package dev.piwitests.jetbrains

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationNamesInfo
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.service
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogPanel
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.SystemInfo
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBRadioButton
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.ui.JBUI
import java.awt.datatransfer.StringSelection
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.JEditorPane
import javax.swing.JList
import javax.swing.event.DocumentEvent

/**
 * The Connect panel: where this project reads its runs from, in one place, on the settings page and as Connect's one
 * dialog. The desktop app while it runs, with its projects; the instance, with Test connection, its key (Sign in…,
 * Paste key…, Remove) and a project from the instance's list. The browser sign-in shows in the panel, its code and link
 * copyable, while the browser is open. Nothing is saved before [apply]; the instance is asked only for what the panel
 * shows, off the event thread.
 */
class PiwiConnectPanel(private val project: Project, parent: Disposable, private val presetUrl: String? = null) {
    private val service get() = project.service<PiwiProjectService>()
    private val disposable = Disposer.newDisposable(parent, "Piwi Connect panel")
    private val gone = AtomicBoolean(false)

    internal val desktopRadio = JBRadioButton("The Piwi desktop app, while it runs")
    internal val instanceRadio = JBRadioButton("An instance")
    internal val desktopProject = ComboBox<String>()
    internal val urlField = JBTextField()
    internal val projectCombo = ComboBox<String>().apply { isEditable = true }
    private lateinit var desktopState: JEditorPane
    private lateinit var tested: JEditorPane
    private lateinit var keyState: JEditorPane
    private lateinit var projectsState: JEditorPane
    private lateinit var signInCode: JBTextField
    private lateinit var signInState: JEditorPane

    /** What Apply does to the key of the address in the field. */
    internal var key: PiwiProjectService.KeyChange = PiwiProjectService.KeyChange.Keep
        private set

    /** The linked project's name when the desktop app links this folder to one, the first choice of its list. */
    private var linkedName: String? = null

    /** The sign-in running in the panel, cancelled by Cancel or by the panel going. */
    private var signingIn: AtomicBoolean? = null
    private var signInLink: String? = null

    /** The sign-in in progress: its code, Copy code, Copy link, Open browser again and Cancel; hidden otherwise. */
    private val signInPanel: DialogPanel = panel {
        row("Code:") {
            signInCode = textField().applyToComponent {
                isEditable = false
                font = JBUI.Fonts.label(16f).asBold()
            }.component
            button("Copy code") { copy(signInCode.text) }
            button("Copy link") { signInLink?.let(::copy) }
            button("Open browser again") { signInLink?.let { BrowserUtil.browse(it) } }
            button("Cancel") { cancelSignIn(Glue.SIGN_IN_CANCELLED) }
        }
    }.apply { isVisible = false }

    val component: DialogPanel = panel {
        buttonsGroup("Read this project from:") {
            row { cell(desktopRadio) }
            indent {
                row { desktopState = comment("").component }
                row("Desktop app project:") {
                    cell(desktopProject).align(AlignX.FILL).comment("The project's name in the desktop app")
                }
            }
            row { cell(instanceRadio) }
            indent {
                row("Server URL:") {
                    cell(urlField).columns(COLUMNS_LARGE)
                    button("Test connection") { testConnection() }
                }
                row { tested = comment("").component }
                row("API key:") {
                    keyState = text("").component
                }
                row {
                    button("Sign in…") { startSignIn() }
                    button("Paste key…") { pasteKey() }
                    button("Remove") { removeKey() }
                }
                row { cell(signInPanel) }
                row { signInState = comment("").component }
                row("Project:") {
                    cell(projectCombo).align(AlignX.FILL).comment("The project's name on the instance")
                    link("Refresh") { loadProjects() }
                }
                row { projectsState = comment("").component }
            }
        }
    }

    init {
        desktopProject.renderer = object : SimpleListCellRenderer<String>() {
            override fun customize(list: JList<out String>, value: String?, index: Int, selected: Boolean, hasFocus: Boolean) {
                text = if (value.isNullOrEmpty()) Glue.linkedProjectLabel(linkedName) else value
            }
        }
        urlField.document.addDocumentListener(object : DocumentAdapter() {
            override fun textChanged(e: DocumentEvent) {
                tested.text = ""
                showKey()
            }
        })
        Disposer.register(disposable) {
            gone.set(true)
            signingIn?.set(true)
        }
        reset()
    }

    /** The panel as the settings stand, or the address Connect was given. */
    fun reset() {
        cancelSignIn(null)
        val settings = service.settings()
        val local = service.local()
        val preset = Glue.normalizeServerUrl(presetUrl)
        desktopRadio.isSelected = local.desktop && preset == null
        instanceRadio.isSelected = !desktopRadio.isSelected
        urlField.text = preset ?: settings.serverUrl
        projectCombo.removeAllItems()
        projectCombo.editor.item = settings.project.takeIf { preset == null || preset == settings.serverUrl } ?: ""
        desktopProject.removeAllItems()
        desktopProject.addItem("")
        if (local.desktopProject.isNotBlank()) desktopProject.addItem(local.desktopProject)
        desktopProject.selectedItem = local.desktopProject
        key = PiwiProjectService.KeyChange.Keep
        tested.text = ""
        projectsState.text = ""
        showKey()
        loadDesktop()
        loadProjects()
    }

    /** Whether Apply would change what the settings hold. */
    fun isModified(): Boolean {
        val settings = service.settings()
        val local = service.local()
        return desktopRadio.isSelected != local.desktop ||
            (desktopProject.selectedItem as? String).orEmpty() != local.desktopProject ||
            url() != settings.serverUrl ||
            project() != settings.project ||
            key != PiwiProjectService.KeyChange.Keep
    }

    /** Save the panel: the source, the instance, its project, the key's change and the desktop app's project. */
    fun apply() {
        val typed = urlField.text.trim()
        if (typed.isNotEmpty() && Glue.normalizeServerUrl(typed) == null) throw ConfigurationException(Glue.TEST_CONNECTION_NO_URL)
        service.saveConnection(url(), project(), key, desktopRadio.isSelected, (desktopProject.selectedItem as? String).orEmpty())
        key = PiwiProjectService.KeyChange.Keep
        showKey()
    }

    fun dispose() = Disposer.dispose(disposable)

    private fun url(): String = Glue.normalizeServerUrl(urlField.text) ?: urlField.text.trim()

    private fun project(): String = (projectCombo.editor.item as? String ?: projectCombo.selectedItem as? String).orEmpty().trim()

    /** On the event thread, whatever dialog shows, unless the panel went. */
    private fun later(work: () -> Unit) =
        ApplicationManager.getApplication().invokeLater({ if (!gone.get()) work() }, ModalityState.any())

    private fun pooled(work: () -> Unit) = ApplicationManager.getApplication().executeOnPooledThread { if (!gone.get()) work() }

    /** The desktop app: whether it runs, its projects and the one linked to this folder. */
    private fun loadDesktop() {
        desktopState.text = "Looking for the desktop app…"
        pooled {
            val desktop = runCatching { service.desktop() }.getOrNull()
            later {
                val running = desktop?.url != null
                linkedName = desktop?.linked?.name
                desktopState.text = Glue.escapeHtml(Glue.desktopStateText(desktop?.url, linkedName))
                val chosen = desktopProject.selectedItem as? String
                desktopProject.removeAllItems()
                desktopProject.addItem("")
                for (name in desktop?.projects.orEmpty().map { it.name }) desktopProject.addItem(name)
                if (!chosen.isNullOrEmpty() && (0 until desktopProject.itemCount).none { desktopProject.getItemAt(it) == chosen }) {
                    desktopProject.addItem(chosen)
                }
                desktopProject.selectedItem = chosen.orEmpty()
                desktopRadio.isEnabled = running || desktopRadio.isSelected
            }
        }
    }

    /** What the key row says for the address in the field: a key saved for it, a new one to save, or none. */
    private fun showKey() {
        val url = Glue.normalizeServerUrl(urlField.text)
        val change = key
        if (url == null) {
            keyState.text = "None: type the instance's address first"
            return
        }
        pooled {
            val saved = service.hasApiKey(url)
            later { if (Glue.normalizeServerUrl(urlField.text) == url) keyState.text = Glue.escapeHtml(Glue.keyStateText(url, saved, Glue.keyChangeKind(change))) }
        }
    }

    /** The instance's projects, with the key Apply would save, in the project list; the typed name stays. */
    private fun loadProjects() {
        val url = Glue.normalizeServerUrl(urlField.text) ?: return
        val change = key
        projectsState.text = "Listing the projects of $url…"
        pooled {
            val key = when (change) {
                is PiwiProjectService.KeyChange.Set -> change.key
                PiwiProjectService.KeyChange.Remove -> null
                PiwiProjectService.KeyChange.Keep -> service.apiKey(url)
            }
            val answer = runCatching { PiwiInstance.projects(url, key) }
            later {
                if (Glue.normalizeServerUrl(urlField.text) != url) return@later
                val typed = project()
                answer.onSuccess { projects ->
                    projectCombo.removeAllItems()
                    for (item in projects) projectCombo.addItem(item.name)
                    projectCombo.editor.item = typed.ifEmpty { projects.firstOrNull()?.name.orEmpty() }
                    projectsState.text = Glue.escapeHtml(Glue.projectsStateText(url, projects.size))
                }.onFailure { e ->
                    projectsState.text = Glue.escapeHtml(
                        Glue.testConnectionFailure(url, Glue.connectFailure(e, (e as? PiwiInstance.HttpStatus)?.status, url)),
                    )
                }
            }
        }
    }

    /** Test connection: whether the address typed answers and asks for a key, said under the field; then its projects. */
    private fun testConnection() {
        val url = Glue.normalizeServerUrl(urlField.text)
        if (url == null) {
            tested.text = Glue.escapeHtml(Glue.TEST_CONNECTION_NO_URL)
            return
        }
        tested.text = "Reaching $url…"
        pooled {
            val reached = runCatching { PiwiInstance.reach(url) }
            later {
                if (Glue.normalizeServerUrl(urlField.text) != url) return@later
                reached.onSuccess {
                    // The address that answered: on this machine, it may be another loopback address than the one typed.
                    if (it.url != url) urlField.text = it.url
                    tested.text = Glue.escapeHtml(Glue.testConnectionText(it.url, it.needsKey))
                    loadProjects()
                }.onFailure { e ->
                    tested.text = Glue.escapeHtml(Glue.testConnectionFailure(url, Glue.connectFailure(e, (e as? PiwiInstance.HttpStatus)?.status, url)))
                }
            }
        }
    }

    private fun pasteKey() {
        val pasted = Messages.showPasswordDialog(project, "An API key (pd_…), from the dashboard's Settings → API keys", "Piwi: Paste key", null)
            ?.trim()?.ifBlank { null } ?: return
        changeKey(PiwiProjectService.KeyChange.Set(pasted))
    }

    private fun removeKey() = changeKey(PiwiProjectService.KeyChange.Remove)

    private fun changeKey(change: PiwiProjectService.KeyChange) {
        key = change
        showKey()
        loadProjects()
    }

    /**
     * Sign in with the browser, in the panel: the instance's page opens, its code and link show with Copy code, Copy
     * link and Open browser again, and the key the browser allows becomes the key Apply saves.
     */
    private fun startSignIn() {
        val url = Glue.normalizeServerUrl(urlField.text) ?: run {
            signInState.text = Glue.escapeHtml(Glue.TEST_CONNECTION_NO_URL)
            return
        }
        cancelSignIn(null)
        val cancelled = AtomicBoolean(false)
        signingIn = cancelled
        signInState.text = "Starting the sign-in…"
        pooled {
            val started = runCatching { PiwiInstance.startSignIn(url, editorName(), osName()) }
            later {
                if (cancelled.get()) return@later
                started.onFailure { e ->
                    signingIn = null
                    if ((e as? PiwiInstance.HttpStatus)?.status == 404) {
                        signInState.text = Glue.escapeHtml(Glue.SIGN_IN_TOO_OLD)
                        pasteKey()
                    } else {
                        signInState.text = Glue.escapeHtml(Glue.testConnectionFailure(url, Glue.connectFailure(e, (e as? PiwiInstance.HttpStatus)?.status, url)))
                    }
                }.onSuccess { signIn -> waitForSignIn(url, signIn, cancelled) }
            }
        }
    }

    private fun waitForSignIn(url: String, signIn: PiwiInstance.SignIn, cancelled: AtomicBoolean) {
        if (Glue.normalizeServerUrl(signIn.verificationUrl) == null) {
            signingIn = null
            signInState.text = Glue.escapeHtml("$url answered an unexpected sign-in page: ${signIn.verificationUrl}")
            return
        }
        signInLink = signIn.verificationUrl
        signInCode.text = signIn.userCode
        signInPanel.isVisible = true
        signInState.text = Glue.escapeHtml(Glue.SIGN_IN_WAITING)
        BrowserUtil.browse(signIn.verificationUrl)
        pooled {
            val answer = runCatching { PiwiInstance.awaitSignIn(url, signIn) { cancelled.get() || gone.get() } }
            later {
                if (cancelled.get()) return@later
                signingIn = null
                signInPanel.isVisible = false
                answer.onSuccess {
                    val apiKey = it.apiKey?.ifBlank { null }
                    signInState.text = Glue.escapeHtml(Glue.signInAnswerText(url, it.status, apiKey != null))
                    if (it.status == "approved" && apiKey != null) changeKey(PiwiProjectService.KeyChange.Set(apiKey))
                }.onFailure { e ->
                    signInState.text = Glue.escapeHtml(Glue.testConnectionFailure(url, Glue.connectFailure(e, (e as? PiwiInstance.HttpStatus)?.status, url)))
                }
            }
        }
    }

    /** End the sign-in in progress, saying `why`, or quietly. */
    private fun cancelSignIn(why: String?) {
        signingIn?.set(true)
        signingIn = null
        signInPanel.isVisible = false
        if (::signInState.isInitialized) signInState.text = why?.let(Glue::escapeHtml).orEmpty()
    }

    private fun copy(text: String) = CopyPasteManager.getInstance().setContents(StringSelection(text))

    /** "WebStorm", "IntelliJ IDEA", "Rider": the name the sign-in page shows and the created key carries. */
    private fun editorName(): String = ApplicationNamesInfo.getInstance().fullProductName

    private fun osName(): String = when {
        SystemInfo.isMac -> "macOS"
        SystemInfo.isWindows -> "Windows"
        SystemInfo.isLinux -> "Linux"
        else -> SystemInfo.OS_NAME
    }
}

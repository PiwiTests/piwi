package dev.piwitests.jetbrains

import com.intellij.ide.ui.search.SearchableOptionContributor
import com.intellij.ide.ui.search.SearchableOptionProcessor
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.openapi.ui.Messages
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.LabelPosition
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import javax.swing.JButton
import javax.swing.JEditorPane
import javax.swing.JList

/**
 * **Settings → Tools → Piwi**: the desktop app and whether this machine reads it first, the
 * instance and project saved for this project, whether a key is saved for that instance, when
 * a run started from the IDE says what it changed, whether the runs it starts pause at the IDE's
 * breakpoints, whether they run headed and hold their failures from their start, what the editor shows, how the agent signs in to Piwi's MCP
 * server, and the connection the service actually uses. Each group says where its options are kept, by the settings
 * registry's scope, and links its section of the docs' Editor settings page.
 */
class PiwiConfigurable(private val project: Project) : BoundConfigurable("Piwi", PiwiHelp.SETTINGS_TOPIC) {
    private val service get() = project.service<PiwiProjectService>()

    /** The person's own options as the IDE holds them now: a reload of its settings replaces the object. */
    private val user: PiwiUserSettings.State get() = service.user()
    private lateinit var key: JEditorPane
    private lateinit var inUse: JEditorPane
    private lateinit var desktopState: JEditorPane
    private lateinit var desktopCheck: JBCheckBox
    private lateinit var desktopProjectField: JBTextField
    private lateinit var urlField: JBTextField
    private lateinit var projectField: JBTextField
    private lateinit var disconnectButton: JButton
    private lateinit var nodeButton: JButton
    private lateinit var overridden: JEditorPane
    private lateinit var tested: JEditorPane

    override fun createPanel(): DialogPanel {
        val settings = service.settings()
        val local = service.local()
        val files = Glue.storeFiles(project.projectFilePath)
        val content = panel {
            row {
                text(
                    "Where this project reads its test history from. PIWI_DASHBOARD_URL in the environment or the " +
                        "workspace .env comes first; then the instance below; then the Piwi desktop app while it runs. " +
                        "Choose the desktop app to read it first while it runs: the instance stays for when it does not.",
                    maxLineLength = 90,
                )
            }
            group("In use") {
                row {
                    inUse = text("", maxLineLength = 90).align(AlignX.FILL).component
                }
                row {
                    button("Reconnect") { service.sendCredentials() }
                        .comment("Hand the connection to the editor service again, which reads everything with it")
                    nodeButton = button("Node.js settings…") { openNodeSettings(it.source as? java.awt.Component) }.component
                }
            }
            group(SettingsWords.GROUPS.getValue("connection")) {
                kept("Kept in ${files.shared}, which the team can share; the API key in the IDE's password safe, for its instance alone.", "connection")
                row {
                    overridden = text("", maxLineLength = 90).align(AlignX.FILL).component
                }
                row("Server URL:") {
                    urlField = textField()
                        .bindText({ settings.serverUrl }, { settings.serverUrl = Glue.normalizeServerUrl(it) ?: it.trim() })
                        .columns(COLUMNS_LARGE)
                        .validationOnApply {
                            if (it.text.isBlank() || Glue.normalizeServerUrl(it.text) != null) null
                            else error("An http(s) URL, such as https://piwi.example.com")
                        }
                        .component
                    button("Test connection") { testConnection() }
                }
                row {
                    tested = text("", maxLineLength = 90).align(AlignX.FILL).component
                }
                // What Test connection said is of the address it tried: an edit of the field takes it away.
                urlField.document.addDocumentListener(object : com.intellij.ui.DocumentAdapter() {
                    override fun textChanged(e: javax.swing.event.DocumentEvent) {
                        tested.text = ""
                    }
                })
                row("Project:") {
                    projectField = textField()
                        .bindText({ settings.project }, { settings.project = it.trim() })
                        .columns(COLUMNS_LARGE)
                        .comment("The project's name on the instance")
                        .component
                }
                row("API key:") {
                    key = text("").component
                }
                row {
                    button("Connect…") { connect() }
                        .comment("Sign in with the browser, or paste a key, then pick the project")
                    disconnectButton = button("Disconnect") { disconnect() }.component
                }
            }
            group("Piwi desktop app") {
                kept("Kept for you only, in ${files.workspace}.", "connection")
                row {
                    desktopState = text("").component
                }
                row {
                    desktopCheck = checkBox("Read this project from the desktop app while it runs")
                        .bindSelected({ local.desktop }, { local.desktop = it })
                        .comment("Before the environment, the .env and the instance below")
                        .component
                }
                row("Desktop app project:") {
                    desktopProjectField = textField()
                        .bindText({ local.desktopProject }, { local.desktopProject = it.trim() })
                        .columns(COLUMNS_LARGE)
                        .comment("The project's name in the desktop app; empty uses the one linked there to this folder")
                        .component
                }
            }
            group(SettingsWords.GROUPS.getValue("runs")) {
                kept(YOURS, "runs")
                row {
                    comboBox(Glue.RUN_NOTIFICATIONS, ChoiceRenderer("runNotifications"))
                        .label("When a run started here ends:", LabelPosition.TOP)
                        .bindItem({ user.runNotifications }, { user.runNotifications = it ?: "failures" })
                        .comment(
                            "A balloon says what the run changed: the failures it fixed, those still failing, its new ones",
                        )
                }
                row {
                    comboBox(Glue.RUN_NOTIFICATION_SCOPES, ChoiceRenderer("runNotificationsScope"))
                        .label("The runs it says it for:", LabelPosition.TOP)
                        .bindItem({ user.runNotificationsScope }, { user.runNotificationsScope = it ?: "mineAndCi" })
                        .comment("A CI run of the branch says what it fixed and its new failures against the run it replaced")
                }
                row {
                    comboBox(Glue.STATUS_BAR_ALERTS, ChoiceRenderer("statusBarAlert"))
                        .label("The status bar item's text turns red:", LabelPosition.TOP)
                        .bindItem({ user.statusBarAlert }, { user.statusBarAlert = it ?: "new" })
                        .comment("A CI failure or a teammate's never turns it red unless you choose any")
                }
                row {
                    checkBox("Pause the runs Piwi starts at the editor's breakpoints, with the picker")
                        .bindSelected({ user.breakpoints }, { user.breakpoints = it })
                        .comment(
                            "A run with a breakpoint in a test or page object pauses before the action on that line, " +
                                "headless unless the runs start headed: its page shows in the Paused page tab. Needs " +
                                "@piwitests/reporter 0.48.0 or later, and 0.62.0 or later to stop headless: with an " +
                                "older reporter, or one whose version Piwi cannot read, the run starts headed",
                        )
                }
                row {
                    checkBox("Run every test Piwi starts headed, with its browser window shown")
                        .bindSelected({ user.runHeaded }, { user.runHeaded = it })
                        .comment(
                            "A verification too. Otherwise a run is headless but for a spec with a page.pause(), and " +
                                "for a run with breakpoints when @piwitests/reporter is older than 0.62.0. " +
                                "Tools → Piwi → Turn headed runs on or off",
                        )
                }
                row {
                    comboBox(Glue.HOLD_FAILURES_CHOICES, HoldFailuresRenderer())
                        .label("Hold failures, from each run's start:", LabelPosition.TOP)
                        .bindItem(
                            { user.runHoldFailures.takeIf { it in Glue.HOLD_FAILURES_CHOICES } ?: "auto" },
                            { user.runHoldFailures = it ?: "auto" },
                        )
                        .comment(
                            "Whether a failed test waits at its line for an answer in the run; the run's own Hold failures " +
                                "still turns it on or off while it runs",
                        )
                }
                row {
                    checkBox("Run the tests in the IDE's Playwright runner: a test tree, Debug, Rerun Failed Tests")
                        .bindSelected({ user.playwrightRunner }, { user.playwrightRunner = it })
                        .enabled(PlaywrightRunnerGate.available())
                        .comment(
                            if (PlaywrightRunnerGate.available()) {
                                "Otherwise in the Run tool window's console, as a command other than npx playwright test is " +
                                    "(a selection's own)"
                            } else {
                                Glue.NO_PLAYWRIGHT_RUNNER
                            },
                        )
                }
            }
            group(SettingsWords.GROUPS.getValue("editor")) {
                kept("$YOURS_EXCEPT A failing test's line is this project's, kept for you only in ${files.workspace}.", "editor")
                row {
                    comboBox(Glue.CODE_LENS_CHOICES, ChoiceRenderer("codeLens"))
                        .label("The lines Piwi writes above the code:", LabelPosition.TOP)
                        .bindItem({ user.codeLens.takeIf { it in Glue.CODE_LENS_CHOICES } ?: "all" }, { user.codeLens = it ?: "all" })
                        .comment("A test's mark in the gutter stays: Editor → General → Gutter Icons → Piwi test results hides it")
                }
                row {
                    checkBox("Show the coverage marks at the left of the lines a run reached, did not reach, or changed since")
                        .bindSelected({ user.coverageMarks }, { user.coverageMarks = it })
                        .comment("Tools → Piwi → Show or hide the coverage marks")
                }
                row {
                    comboBox(Glue.FAILURE_SEVERITIES, ChoiceRenderer("failureSeverity"))
                        .label("A failing test's line in the editor:", LabelPosition.TOP)
                        .bindItem({ local.failureSeverity }, { local.failureSeverity = it ?: "error" })
                        .comment(
                            "A failure of a run on another branch is a warning at most; one whose line changed since its run, " +
                                "a weak warning. Off leaves the failures to the Piwi tool window and the gutter",
                        )
                }
                row {
                    checkBox("Warn at a brittle locator, with its stable alternative as a quick fix")
                        .bindSelected({ user.locatorWarnings }, { user.locatorWarnings = it })
                }
                row {
                    checkBox("Tint a failing test and the line it failed at")
                        .bindSelected({ user.failingTestTint }, { user.failingTestTint = it })
                        .comment("The gutter still marks them; the colors are under Editor → Color Scheme → Piwi")
                }
                row {
                    checkBox("Show where a CI run of the branch stands, at the end of each line it runs")
                        .bindSelected({ user.ciPositions }, { user.ciPositions = it })
                }
            }
            group(SettingsWords.GROUPS.getValue("agents")) {
                kept("$YOURS_EXCEPT Serving the runs to agents is this project's, kept for you only in ${files.workspace}.", "agents")
                row {
                    comboBox(Glue.MCP_AUTHORIZATIONS, ChoiceRenderer("mcpAuthorization"))
                        .label("Piwi's MCP server signs the agent in with:", LabelPosition.TOP)
                        .bindItem({ user.mcpAuthorization }, { user.mcpAuthorization = it ?: "key" })
                        .comment(
                            "As Copy the MCP server configuration writes it. The browser gives the agent a token of its own, " +
                                "which Settings → Account → API keys on the instance lists and revokes; the desktop app takes " +
                                "its own token either way",
                        )
                }
                row {
                    checkBox("Serve the test runs this project starts to the agents of this machine")
                        .bindSelected({ local.serveRunsToAgents }, { local.serveRunsToAgents = it })
                        .comment(
                            "An MCP server on 127.0.0.1, behind a token: an agent follows a run, stops it, reads and acts on " +
                                "the stopped page, and has Piwi write the code there. Tools → Piwi copies its configuration for " +
                                "your agent, or for Claude Code or Cursor, and resets its token",
                        )
                }
            }
            onReset { show() }
        }
        service.onChangeInDialogs(disposable!!) { show() }
        return content
    }

    /** Whether **Node.js settings…** went to the Node.js page of this dialog: the service starts again as it closes. */
    private var nodeSettingsShown = false

    /** The Node.js page in this Settings dialog, else in a dialog of its own. */
    private fun openNodeSettings(source: java.awt.Component?) {
        val dialog = source?.let { com.intellij.openapi.options.ex.Settings.KEY.getData(com.intellij.ide.DataManager.getInstance().getDataContext(it)) }
        val node = dialog?.find(service.nodeSettingsId)
        if (dialog == null || node == null) return service.openNodeSettings()
        nodeSettingsShown = true
        dialog.select(node)
    }

    override fun disposeUIResources() {
        super.disposeUIResources()
        if (nodeSettingsShown) ApplicationManager.getApplication().executeOnPooledThread { service.restartServer() }
    }

    override fun apply() {
        val before = connection()
        val agents = service.local().serveRunsToAgents
        val own = user.copy()
        super.apply()
        // The service serves the runs to agents, or stops, at once.
        if (service.local().serveRunsToAgents != agents) {
            ApplicationManager.getApplication().executeOnPooledThread { service.agentsChanged() }
        }
        if (connection() != before) service.sendCredentials()
        // A person's own options hold in every open project, each handed and drawn again; this one handed them above.
        PiwiUserSettings.changed(own, handedIn = project)
        show()
    }

    /**
     * What this page changes of what the service is handed: the key is saved by Connect, never here.
     */
    private fun connection(): List<Any> {
        val settings = service.settings()
        val local = service.local()
        return listOf(settings.serverUrl, settings.project, local.desktop, local.desktopProject, local.failureSeverity) +
            PiwiUserSettings.handed(user)
    }

    private fun show() {
        val url = service.settings().serverUrl
        disconnectButton.isEnabled = Glue.disconnectQuestion(url, service.settings().project, service.local().desktop) != null
        if (url.isBlank()) key.text = "None: no instance saved"
        inUse.text = Glue.escapeHtml(Glue.connectionSummary(service.status, service.local().desktop, service.startProblem, service.trusted(), service.serviceStopped))
        nodeButton.isVisible = service.startProblem != null
        // The instance the environment or a .env names comes first: the page shows it, its own fields left as saved.
        val over = Glue.overriding(service.status, url)
        overridden.text = over?.let { Glue.escapeHtml(Glue.overriddenText(it)) } ?: ""
        overridden.isVisible = over != null
        urlField.emptyText.text = over?.serverUrl ?: ""
        projectField.emptyText.text = over?.project ?: ""
        // The password safe and the discovery file: read off the event thread.
        val keyLabel = key
        val label = desktopState
        ApplicationManager.getApplication().executeOnPooledThread {
            val saved = url.isNotBlank() && service.hasApiKey(url)
            val running = service.desktopUrl()
            ApplicationManager.getApplication().invokeLater(
                {
                    if (url.isNotBlank()) keyLabel.text = if (saved) "Saved for $url in the IDE's password safe" else "None saved for $url"
                    label.text = running?.let { "Running on this machine at $it." } ?: "Not running on this machine."
                },
                ModalityState.any(),
            )
        }
    }

    /**
     * Test connection: whether the address typed in the field answers, before it is saved, said in Connect's words under
     * the field. The request runs with modal progress, as Connect's do from this page.
     */
    private fun testConnection() {
        val url = Glue.normalizeServerUrl(urlField.text)
        if (url == null) {
            tested.text = Glue.escapeHtml(Glue.TEST_CONNECTION_NO_URL)
            return
        }
        tested.text = try {
            val reached = com.intellij.openapi.progress.ProgressManager.getInstance().runProcessWithProgressSynchronously<PiwiInstance.Reached, Exception>(
                { PiwiInstance.reach(url) }, "Piwi: Test connection", true, project,
            )
            reached?.let { Glue.escapeHtml(Glue.testConnectionText(it.url, it.needsKey)) } ?: return
        } catch (_: com.intellij.openapi.progress.ProcessCanceledException) {
            return
        } catch (e: Exception) {
            Glue.escapeHtml(Glue.testConnectionFailure(url, Glue.connectFailure(e, (e as? PiwiInstance.HttpStatus)?.status, url)))
        }
    }

    /** Connect with the URL typed on this page, Apply or not; the page's other edits stay pending. */
    private fun connect() {
        val typed = urlField.text
        val url = Glue.normalizeServerUrl(typed)
        if (typed.isNotBlank() && url == null) {
            Messages.showErrorDialog(project, "An http(s) URL, such as https://piwi.example.com", "Piwi")
            return
        }
        if (PiwiConnectFlow.run(project, url)) showConnection()
    }

    private fun disconnect() {
        if (PiwiConnectFlow.disconnect(project)) showConnection()
    }

    /** The connection rows as Connect or Disconnect saved them, the page's other edits left pending. */
    private fun showConnection() {
        val settings = service.settings()
        val local = service.local()
        urlField.text = settings.serverUrl
        projectField.text = settings.project
        desktopCheck.isSelected = local.desktop
        desktopProjectField.text = local.desktopProject
        show()
    }
}

/** A group's first row: where its options are kept, and a link to its section of the docs' Editor settings page. */
private fun com.intellij.ui.dsl.builder.Panel.kept(text: String, group: String) {
    row {
        comment("${Glue.escapeHtml(text)} <a href=\"${SettingsWords.docsUrl(group)}\">Documentation</a>", maxLineLength = 90)
    }
}

/** Where a group of a person's own options is kept. */
private const val YOURS = "Yours in every project, kept in the IDE's own settings (options/piwi.xml)."

/** The same, for a group that holds one option of the project's. */
private const val YOURS_EXCEPT = "Yours in every project, kept in the IDE's own settings (options/piwi.xml), but one:"

/**
 * **Settings → Tools → Piwi**'s help button: the docs' Editor settings page, whose sections each group's
 * **Documentation** link opens.
 */
class PiwiHelp : com.intellij.openapi.help.WebHelpProvider() {
    override fun getHelpPageUrl(helpTopicId: String): String? = if (helpTopicId == SETTINGS_TOPIC) SettingsWords.DOCS_URL else null

    companion object {
        /** The settings page's help topic: the plugin's id, which the platform asks this provider for, and `settings`. */
        const val SETTINGS_TOPIC = "dev.piwitests.piwi.settings"
    }
}

/**
 * The words Settings search finds **Settings → Tools → Piwi** by beyond its labels, which the release's searchable
 * options index holds: what a developer looking for the page types.
 */
class PiwiSearchableOptions : SearchableOptionContributor() {
    override fun processOptions(processor: SearchableOptionProcessor) {
        for (word in KEYWORDS) processor.addOptions(word, null, word, CONFIGURABLE_ID, "Piwi", true)
    }

    companion object {
        /** The id of the settings page, as `plugin.xml` registers it. */
        const val CONFIGURABLE_ID = "dev.piwitests.piwi"

        val KEYWORDS = listOf(
            "Playwright", "dashboard", "test results", "flaky", "failures", "coverage", "reporter", "breakpoints",
            "picker", "API key", "token", "MCP", "agent", "desktop app", "instance", "Node.js", "headed", "hold failures",
        )
    }
}

/** A choice of the option `field`, in the settings registry's words (`SettingsWords`). */
private class ChoiceRenderer(private val field: String) : SimpleListCellRenderer<String>() {
    override fun customize(list: JList<out String>, value: String?, index: Int, selected: Boolean, hasFocus: Boolean) {
        text = SettingsWords.choice(field, value)
    }
}

/** A choice of `PiwiUserSettings.runHoldFailures`, whole, in the editors' words: the short label says too little alone. */
private class HoldFailuresRenderer : SimpleListCellRenderer<String>() {
    override fun customize(list: JList<out String>, value: String?, index: Int, selected: Boolean, hasFocus: Boolean) {
        text = Glue.holdFailuresLabel(value ?: "auto")
    }
}

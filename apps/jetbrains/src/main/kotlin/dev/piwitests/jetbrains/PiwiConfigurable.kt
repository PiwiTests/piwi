package dev.piwitests.jetbrains

import com.intellij.ide.ui.search.SearchableOptionContributor
import com.intellij.ide.ui.search.SearchableOptionProcessor
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.LabelPosition
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
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
    private lateinit var inUse: JEditorPane
    private lateinit var connect: PiwiConnectPanel
    private lateinit var disconnectButton: JButton
    private lateinit var nodeButton: JButton
    private lateinit var overridden: JEditorPane

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
                kept(
                    "The instance is kept in ${files.shared}, which the team can share; its API key in the IDE's password " +
                        "safe, for that instance alone; the desktop app's choice for you only, in ${files.workspace}.",
                    "connection",
                )
                row {
                    overridden = text("", maxLineLength = 90).align(AlignX.FILL).component
                }
                connect = PiwiConnectPanel(project, disposable!!)
                row { cell(connect.component).align(AlignX.FILL) }
                onApply { connect.apply() }
                onReset { connect.reset() }
                onIsModified { connect.isModified() }
                row {
                    disconnectButton = button("Disconnect") { disconnect() }
                        .comment("Forget the instance, its project and key, and the choice of the desktop app")
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
                    comboBox(Glue.BREAKPOINTS_CHOICES, ChoiceRenderer("breakpoints"))
                        .label("The runs that pause at the editor's breakpoints, with the picker:", LabelPosition.TOP)
                        .bindItem({ Glue.breakpointsMode(user.breakpoints) }, { user.breakpoints = it ?: "debug" })
                        .comment(
                            "Debug with Piwi alone by default, as the IDE's own Run and Debug. A run with a breakpoint in " +
                                "a test or page object pauses before the action on that line, headless unless the runs " +
                                "start headed: its page shows in the Paused page tab. Needs @piwitests/reporter 0.48.0 or " +
                                "later, and 0.62.0 or later to stop headless: with an older reporter, or one whose version " +
                                "Piwi cannot read, the run starts headed",
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
                row {
                    comboBox(Glue.RUNNING_LINES_CHOICES, ChoiceRenderer("runningLines"))
                        .label("The line each running test of your run is at:", LabelPosition.TOP)
                        .bindItem(
                            { user.runningLines.takeIf { it in Glue.RUNNING_LINES_CHOICES } ?: "all" },
                            { user.runningLines = it ?: "all" },
                        )
                        .comment("Marked with an inlay naming the worker; a worker of an older reporter only while the Worker tab watches it")
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
                                "the stopped page, and has Piwi write the code there",
                        )
                }
                for (id in AGENT_ACTIONS) row { actionButton(id) { isModified } }
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
     * What this page changes of what the service is handed, beside the Connect panel, which hands what it saves itself.
     */
    private fun connection(): List<Any> = listOf(service.local().failureSeverity) + PiwiUserSettings.handed(user)

    private fun show() {
        val url = service.settings().serverUrl
        disconnectButton.isEnabled = Glue.disconnectQuestion(url, service.settings().project, service.local().desktop) != null
        inUse.text = Glue.escapeHtml(Glue.connectionSummary(service.status, service.local().desktop, service.startProblem, service.trusted(), service.serviceStopped))
        nodeButton.isVisible = service.startProblem != null
        // The instance the environment or a .env names comes first: the page shows it, the panel's fields left as saved.
        val over = Glue.overriding(service.status, url)
        overridden.text = over?.let { Glue.escapeHtml(Glue.overriddenText(it)) } ?: ""
        overridden.isVisible = over != null
        connect.urlField.emptyText.text = over?.serverUrl ?: ""
    }

    /** Disconnect after asking; the panel then shows what is saved, the page's other edits left pending. */
    private fun disconnect() {
        if (!PiwiConnectFlow.disconnect(project)) return
        connect.reset()
        show()
    }
}

/** A group's first row: where its options are kept, and a link to its section of the docs' Editor settings page. */
private fun com.intellij.ui.dsl.builder.Panel.kept(text: String, group: String) {
    row {
        comment("${Glue.escapeHtml(text)} <a href=\"${SettingsWords.docsUrl(group)}\">Documentation</a>", maxLineLength = 90)
    }
}

/** The actions that give an agent Piwi's MCP servers, as buttons of the Agents (MCP) group. */
private val AGENT_ACTIONS = listOf(
    "Piwi.CopyMcpConfiguration",
    "Piwi.CopyRunsMcpConfiguration",
    "Piwi.CopyRunsMcpHttpConfiguration",
    "Piwi.ResetRunsMcpToken",
)

/**
 * A button that runs the registered action `id`, with its text, from the settings page. The action reads the saved
 * settings: while the page holds changes not applied (`pending`), it says to apply them first and runs nothing.
 */
private fun com.intellij.ui.dsl.builder.Row.actionButton(id: String, pending: () -> Boolean) {
    val action = com.intellij.openapi.actionSystem.ActionManager.getInstance().getAction(id) ?: return
    button(action.templatePresentation.text ?: id) { e ->
        if (pending()) {
            com.intellij.openapi.ui.Messages.showInfoMessage(e.source as java.awt.Component, Glue.APPLY_FIRST, "Piwi")
            return@button
        }
        com.intellij.openapi.actionSystem.ActionManager.getInstance()
            .tryToExecute(action, null, e.source as? java.awt.Component, "PiwiSettings", true)
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

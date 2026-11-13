package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.InputValidator
import com.intellij.openapi.ui.MessageDialogBuilder
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.SimpleListCellRenderer
import java.awt.datatransfer.StringSelection
import javax.swing.JList

/** The file's URI, or null for a file that is not on disk. */
private fun fileUri(file: VirtualFile): String? =
    if (file.isInLocalFileSystem) runCatching { file.toNioPath().toUri().toString() }.getOrNull() else null

/** Piwi: Connect — the instance, a key for it (browser sign-in or pasted) and the project. */
class ConnectAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    /** In the status bar item's popup, only while a Playwright config is not connected; everywhere else, always. */
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.place != ActionPlaces.STATUS_BAR_PLACE || !piwiAllConnected(e.project)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        PiwiConnectFlow.run(project)
    }
}

/**
 * Piwi: Disconnect — forget this project's saved instance and project, the key saved for that
 * instance, and the choice of the desktop app.
 */
class DisconnectAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val service = e.project?.service<PiwiProjectService>()
        val settings = service?.settings()
        e.presentation.isEnabled = settings != null &&
            Glue.disconnectQuestion(settings.serverUrl, settings.project, service.local().desktop) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        PiwiConnectFlow.disconnect(e.project ?: return)
    }
}

/** Piwi: Settings… — **Settings → Tools → Piwi**. */
class OpenSettingsAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ShowSettingsUtil.getInstance().showSettingsDialog(project, PiwiConfigurable::class.java)
    }
}

class RefreshAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val service = project.service<PiwiProjectService>()
            // A service that could not start, such as without Node.js, is started again.
            val server = service.server() ?: return@executeOnPooledThread service.restartServer()
            server.refresh().orNull()
            service.refreshStatus()
        }
        // A Playwright config added since the project opened shows the tool window and starts the service.
        project.service<PiwiProjectService>().findPlaywright()
    }
}

/**
 * Restart the Editor Service: the service stopped and started again, or started for the open files when it does not run
 * (`PiwiProjectService.restartServer`). In a trusted project that holds a Playwright config.
 */
class RestartServiceAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val service = e.project?.service<PiwiProjectService>()
        e.presentation.isEnabled = service != null && service.trusted() && service.hasPlaywrightConfig()
    }

    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<PiwiProjectService>()?.restartService()
    }
}

/** Open Log: the Piwi tool window's Log tab, the editor service's log ([PiwiLog]). While the tool window shows. */
class OpenLogAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project?.service<PiwiProjectService>()?.hasPlaywrightConfig() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<PiwiLog>()?.show()
    }
}

/**
 * Piwi: Refresh the Latest Run — the latest run and its failures read again, not the indexes **Refresh** fetches
 * (`PiwiProjectService.refreshRun`). Enabled while connected.
 */
class RefreshRunAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = piwiConnected(e.project)
    }

    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<PiwiProjectService>()?.refreshRun()
    }
}

/** Piwi: Run the tests that reach this file. */
class RunTestsForFileAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    /** Only in a project with a Playwright config: the editor's menu of any other project does without it. */
    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val project = e.project
        e.presentation.isEnabledAndVisible = project != null && file != null && PiwiLspServerSupportProvider.isSupported(file) &&
            project.service<PiwiProjectService>().hasPlaywrightConfig()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val uri = fileUri(file) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val tests = project.service<PiwiProjectService>().server()?.testsForFile(UriParams(uri))?.orNull()?.tests.orEmpty()
            if (tests.isEmpty()) PiwiCommands.notify(project, "No test reaches this file yet.")
            else PiwiCommands.runTests(project, RunTestsArgs(uri, tests.map { it.id }))
        }
    }
}

/**
 * Piwi: Run the Test at the Caret (`wholeSpec` false), Verify the Test at the Caret ×3 (`repeat`) or Run This Spec,
 * through `piwi/testAt`, in the Run tool window with the IDE's breakpoints, which a verification leaves out. Offered in
 * a spec file of a project with a Playwright config.
 */
abstract class RunInSpecAction(private val wholeSpec: Boolean, private val repeat: Int? = null) : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val project = e.project
        e.presentation.isEnabledAndVisible = project != null && file != null && Glue.isSpecFile(file.name) &&
            (wholeSpec || e.getData(CommonDataKeys.EDITOR) != null) &&
            project.service<PiwiProjectService>().hasPlaywrightConfig()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val uri = e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { fileUri(it) } ?: return
        val caret = e.getData(CommonDataKeys.EDITOR)?.caretModel?.logicalPosition
        PiwiCommands.runTestAt(project, uri, caret?.line ?: 0, caret?.column ?: 0, wholeSpec, repeat)
    }
}

class RunTestAtCursorAction : RunInSpecAction(wholeSpec = false)

class VerifyTestAtCursorAction : RunInSpecAction(wholeSpec = false, repeat = Glue.VERIFY_REPEAT)

class RunSpecAction : RunInSpecAction(wholeSpec = true)

/** The dashboard page of what the Piwi tool window has selected: a failure's test, or a run. */
val DASHBOARD_URL: DataKey<String> = DataKey.create("piwi.dashboardUrl")

/** Whether a context of the project reads an instance: the actions that read it are enabled only then. */
fun piwiConnected(project: Project?): Boolean =
    project?.getServiceIfCreated(PiwiProjectService::class.java)?.status?.contexts.orEmpty().any { it.connected }

/** Whether every Playwright config of the project is connected, and there is at least one. */
fun piwiAllConnected(project: Project?): Boolean =
    project?.getServiceIfCreated(PiwiProjectService::class.java)?.status?.contexts.orEmpty().let { contexts ->
        contexts.isNotEmpty() && contexts.all { it.connected }
    }

/**
 * Piwi: Open in dashboard — the page of what the Piwi tool window has selected, else this file's test, else the latest
 * run.
 */
class OpenInDashboardAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.getData(DASHBOARD_URL) != null || piwiConnected(e.project)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        e.getData(DASHBOARD_URL)?.let { return BrowserUtil.browse(it) }
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        ApplicationManager.getApplication().executeOnPooledThread {
            val service = project.service<PiwiProjectService>()
            val tests = file?.let { fileUri(it) }?.let { service.server()?.testsForFile(UriParams(it))?.orNull()?.tests }.orEmpty()
            ApplicationManager.getApplication().invokeLater {
                when {
                    tests.size == 1 -> tests[0].url?.let { BrowserUtil.browse(it) }
                    tests.size > 1 -> JBPopupFactory.getInstance()
                        .createPopupChooserBuilder(tests)
                        .setRenderer(textRenderer<EditorTest> { "${it.title} · ${it.file}" })
                        .setTitle("Open which test in the dashboard?")
                        .setItemChosenCallback { t -> t.url?.let { BrowserUtil.browse(it) } }
                        .createPopup()
                        .showCenteredInCurrentWindow(project)
                    else -> Glue.statusView(service.status, service.runs, file = file?.path ?: PiwiStatusBarWidget.shownFile(project))
                        .url?.let { BrowserUtil.browse(it) }
                }
            }
        }
    }
}

/** Piwi: Open the Latest Run in the Dashboard — the run the status bar shows. */
class OpenLatestRunAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val live = e.project?.let { liveRun(it) }
        e.presentation.isEnabled = e.project?.let { url(it) } != null
        e.presentation.text = live?.let { "Open Run #${it.runId} (Running)" } ?: "Open the Latest Run in the Dashboard"
    }

    override fun actionPerformed(e: AnActionEvent) {
        e.project?.let { url(it) }?.let { BrowserUtil.browse(it) }
    }

    /** The run in progress the status bar counts, with its page, for the context of the selected editor's file. */
    private fun liveRun(project: Project): LiveRun? = project.service<PiwiProjectService>().let {
        Glue.liveRun(it.status, it.runs, PiwiStatusBarWidget.shownFile(project))?.takeIf { live -> live.url != null }
    }

    /** The page of the run in progress the status bar counts, else of the run it shows. */
    private fun url(project: Project): String? = liveRun(project)?.url ?: project.service<PiwiProjectService>().let {
        Glue.statusView(it.status, it.runs, file = PiwiStatusBarWidget.shownFile(project)).url
    }
}

/** Opens the page of a run started or followed here, on the instance it reports to: `Open Run #78`. */
class OpenRunPageAction(private val page: RunPage) : AnAction("Open Run #${page.id}", null, AllIcons.General.Web), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        BrowserUtil.browse(page.url)
    }
}

/**
 * Piwi: Compare With… — the baseline the failures are read against for the Playwright config of the file at hand (or
 * the one connected): the ladder, a branch, a run by its id or your local runs only, kept on this machine.
 */
class CompareWithAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val service = e.project?.service<PiwiProjectService>()
        e.presentation.isEnabled = service?.runs?.contexts.orEmpty().isNotEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val uri = e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { fileUri(it) }
        choose(project, Glue.contextRootOf(project.service<PiwiProjectService>().status, uri))
    }

    companion object {
        /**
         * Offer the baselines of the context at `root` (the first one when no context is there), from the action or a
         * Playwright config's node of the tool window, and keep the one chosen.
         */
        fun choose(project: Project, root: String?) {
            val service = project.service<PiwiProjectService>()
            val contexts = service.runs?.contexts.orEmpty()
            val run = contexts.firstOrNull { it.root == root } ?: contexts.firstOrNull() ?: return
            val target = run.root ?: return
            JBPopupFactory.getInstance()
                .createPopupChooserBuilder(Glue.baselineEntries(run))
                .setRenderer(textRenderer<Glue.BaselineEntry> { if (it.current) "${it.label} · current" else it.label })
                .setTitle("Compare With… (now: ${run.baseline?.label?.ifBlank { null } ?: "the latest run"})")
                .setItemChosenCallback { entry ->
                    val chosen = entry.choice
                    // A run by id: the service reads the id typed, and a text that is not one is said so.
                    val typed = if (chosen != null) "" else Messages.showInputDialog(
                        project,
                        "The id of the run to compare with (its page in the dashboard shows it):",
                        "Compare With a Run",
                        null,
                        null,
                        object : InputValidator {
                            override fun checkInput(inputString: String?) = !inputString.isNullOrBlank()
                            override fun canClose(inputString: String?) = checkInput(inputString)
                        },
                    ) ?: return@setItemChosenCallback
                    ApplicationManager.getApplication().executeOnPooledThread {
                        val choice = chosen ?: service.server()?.runId(RunIdParams(typed))?.orNull()?.runId
                            ?.let { BaselineChoice("run", runId = it) }
                        if (choice == null) {
                            PiwiCommands.notify(project, "Not a run id: give a positive number, such as 118.", NotificationType.WARNING)
                        } else {
                            service.setBaseline(target, choice)
                        }
                    }
                }
                .createPopup()
                .showCenteredInCurrentWindow(project)
        }
    }
}

/** Piwi: Re-run the Failing Tests — every test still failing, or edited since its run, in the Run tool window. */
class RerunFailingAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    /**
     * Enabled while a listed test still fails (`FailuresResult.failing`, which leaves out those fixed locally), from a
     * run read before the instance stopped answering too.
     */
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled =
            (e.project?.getServiceIfCreated(PiwiProjectService::class.java)?.failuresResult?.failing ?: 0) > 0
    }

    override fun actionPerformed(e: AnActionEvent) {
        PiwiCommands.rerunFailing(e.project ?: return)
    }
}

/** Piwi: Run selection… — one of the project's saved selections, in the Run tool window. */
class RunSelectionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = piwiConnected(e.project)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val uri = e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { fileUri(it) }
            ?: project.service<PiwiProjectService>().searchRoots().firstOrNull()?.toUri()?.toString()
            ?: ""
        ApplicationManager.getApplication().executeOnPooledThread {
            val server = project.service<PiwiProjectService>().server()
            val items = server?.selections(SelectionsParams(uri))?.orNull()?.items.orEmpty()
            if (items.isEmpty()) {
                PiwiCommands.notify(project, "This project has no selection yet.")
                return@executeOnPooledThread
            }
            ApplicationManager.getApplication().invokeLater {
                JBPopupFactory.getInstance()
                    .createPopupChooserBuilder(items)
                    .setRenderer(
                        textRenderer<SelectionItem> {
                            "${it.name ?: it.key} · ${it.count} tests" + if (it.includesFile) " · includes this file" else ""
                        },
                    )
                    .setTitle("Run which selection?")
                    .setItemChosenCallback { picked ->
                        ApplicationManager.getApplication().executeOnPooledThread {
                            val service = project.service<PiwiProjectService>()
                            val breakpoints = service.breakpoints()
                            val places = breakpoints.map { it.place }.ifEmpty { null }
                            val local = service.local()
                            val params = Glue.withRunStart(
                                RunSelectionParams(uri, picked.key, places),
                                local.runHeaded,
                                local.runHoldFailures,
                            )
                            val command = server?.runSelection(params)?.orNull()
                            if (command != null) PiwiCommands.startRun(project, command, breakpoints)
                        }
                    }
                    .createPopup()
                    .showCenteredInCurrentWindow(project)
            }
        }
    }
}

/**
 * Piwi: Run Headed — every run Piwi starts in this project runs headed (`RunTestsArgs.headed`), a verification's too;
 * kept on this machine, as **Settings → Tools → Piwi** shows it.
 */
class RunHeadedAction : ToggleAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun isSelected(e: AnActionEvent): Boolean = e.project?.service<PiwiProjectService>()?.local()?.runHeaded ?: false

    override fun setSelected(e: AnActionEvent, state: Boolean) {
        e.project?.service<PiwiProjectService>()?.local()?.runHeaded = state
    }
}

/**
 * Piwi: Hold Failures from Each Run's Start… — Auto, On or Off for every run Piwi starts in this project
 * (`Glue.HOLD_FAILURES_CHOICES`), kept on this machine, as **Settings → Tools → Piwi** shows it.
 */
class RunHoldFailuresAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val local = project.service<PiwiProjectService>().local()
        val current = local.runHoldFailures
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(Glue.HOLD_FAILURES_CHOICES)
            .setRenderer(textRenderer<String> { Glue.holdFailuresLabel(it) + if (it == current) " · current" else "" })
            .setSelectedValue(current, true)
            .setTitle("Hold Failures from Each Run's Start")
            .setItemChosenCallback { local.runHoldFailures = it }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }
}

/** Piwi: Copy the MCP server configuration — for the AI Assistant's MCP settings and other agents. */
class CopyMcpConfigurationAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        copyMcpConfiguration(project)
    }

    companion object {
        fun copyMcpConfiguration(project: Project) {
            ApplicationManager.getApplication().executeOnPooledThread {
                val servers = project.service<PiwiProjectService>().server()?.mcp()?.orNull()?.servers.orEmpty()
                if (servers.isEmpty()) {
                    PiwiCommands.notify(project, "Connect to an instance first.", NotificationType.WARNING)
                    return@executeOnPooledThread
                }
                CopyPasteManager.getInstance().setContents(StringSelection(Glue.mcpConfiguration(servers)))
                PiwiCommands.notify(
                    project,
                    ("The MCP configuration is on the clipboard: paste it in Settings → Tools → AI Assistant → Model " +
                        "Context Protocol (or your agent's MCP settings). ${Glue.mcpAuthorizationNote(servers)}").trimEnd(),
                )
            }
        }

        /** Once per installation: offer Piwi's MCP server to the IDE's agent. */
        fun offer(project: Project) {
            val properties = com.intellij.ide.util.PropertiesComponent.getInstance()
            if (properties.getBoolean(OFFERED)) return
            properties.setValue(OFFERED, true)
            PiwiNotifier.create(
                PiwiNotice.OFFER,
                "Add Piwi's MCP server to your AI assistant? It can read your suite's failures, flaky tests and healings.",
            )
                .addAction(NotificationAction.createSimpleExpiring("Copy the configuration") { copyMcpConfiguration(project) })
                .notify(project)
        }

        private const val OFFERED = "piwi.mcpOffered"
    }
}

/**
 * Piwi: Copy the runs' MCP server configuration — for an agent of this machine to follow, stop and act on the test
 * runs this project starts (the editor service's own MCP server, `piwi/agents`), bridged through `mcp-remote` for an
 * agent that starts only commands (the AI Assistant's settings). The platform has no public way to register an MCP
 * server for the AI Assistant, so the person pastes it.
 */
class CopyRunsMcpConfigurationAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        copyRunsMcp(project, "Settings → Tools → AI Assistant → Model Context Protocol, or your agent's MCP settings", Glue::runsMcpConfiguration)
    }

    companion object {
        /** The runs' MCP server's configuration, as `render` writes it, on the clipboard; why not otherwise. */
        fun copyRunsMcp(project: Project, where: String, render: (String, String) -> String) {
            ApplicationManager.getApplication().executeOnPooledThread {
                val service = project.service<PiwiProjectService>()
                if (!service.local().serveRunsToAgents) {
                    return@executeOnPooledThread PiwiCommands.notify(
                        project,
                        "This project's runs are not served to agents: turn it on in Settings → Tools → Piwi.",
                        NotificationType.WARNING,
                    )
                }
                val served = service.agentsChanged()
                val url = served?.url
                val token = served?.token
                if (url == null || token == null) {
                    return@executeOnPooledThread PiwiCommands.notify(
                        project,
                        served?.message ?: Glue.SERVICE_NOT_RUNNING,
                        NotificationType.WARNING,
                    )
                }
                CopyPasteManager.getInstance().setContents(StringSelection(render(url, token)))
                PiwiCommands.notify(
                    project,
                    "The runs' MCP configuration is on the clipboard: paste it in $where. It holds this project's token: " +
                        "keep it in your user settings, never in a file of the repository such as a project's .mcp.json. " +
                        "It serves while this project is open.",
                )
            }
        }
    }
}

/**
 * Piwi: Copy the runs' MCP server configuration for Claude Code or Cursor — the `mcpServers` entry of type `http` they
 * read, with no bridge, the token as a bearer header.
 */
class CopyRunsMcpHttpConfigurationAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        CopyRunsMcpConfigurationAction.copyRunsMcp(
            project,
            "your agent's user settings (claude mcp add-json, ~/.cursor/mcp.json)",
            Glue::runsMcpHttpConfiguration,
        )
    }
}

/**
 * Piwi: Reset the runs' MCP server token — after the person said yes, the service takes a new token, the one before
 * refused from then on, and the project keeps it; every agent given the configuration needs it copied again.
 */
class ResetRunsMcpTokenAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val yes = MessageDialogBuilder.yesNo("Reset the Runs' MCP Server Token?", RESET_WARNING)
            .yesText("Reset the Token")
            .noText("Cancel")
            .ask(project)
        if (!yes) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val answer = project.service<PiwiProjectService>().agentsChanged(newToken = true)
            PiwiCommands.notify(
                project,
                if (answer?.token != null) {
                    "The runs' MCP server has a new token: copy the runs' MCP server configuration again for each agent."
                } else {
                    "The runs' MCP server takes a new token from its next start."
                },
            )
        }
    }

    companion object {
        const val RESET_WARNING =
            "Every agent you copied the runs' MCP server configuration to is refused until you copy it again."
    }
}

/** A popup list's cell: the text `label` gives its item. */
private fun <T> textRenderer(label: (T) -> String): SimpleListCellRenderer<T> = object : SimpleListCellRenderer<T>() {
    override fun customize(list: JList<out T>, value: T?, index: Int, selected: Boolean, hasFocus: Boolean) {
        text = value?.let(label) ?: ""
    }
}

/**
 * The editor's context menu's Piwi submenu (`Piwi.EditorPopup`): compact, so an entry that does not apply is left out
 * rather than grayed, and gone when none applies, as on a file Piwi has nothing for.
 */
class PiwiEditorPopupGroup : com.intellij.openapi.actionSystem.DefaultCompactActionGroup(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isHideGroupIfEmpty = true
    }
}

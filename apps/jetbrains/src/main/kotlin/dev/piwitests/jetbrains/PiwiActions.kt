package dev.piwitests.jetbrains

import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.InputValidator
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

/** Piwi: Open in dashboard — this file's test, or the latest run. */
class OpenInDashboardAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
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
                    else -> Glue.statusView(service.status, service.runs).url?.let { BrowserUtil.browse(it) }
                }
            }
        }
    }
}

/** Piwi: Open the Latest Run in the Dashboard — the run the status bar shows. */
class OpenLatestRunAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val service = e.project?.service<PiwiProjectService>()
        e.presentation.isEnabled = service != null && Glue.statusView(service.status, service.runs).url != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val service = e.project?.service<PiwiProjectService>() ?: return
        Glue.statusView(service.status, service.runs).url?.let { BrowserUtil.browse(it) }
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
        val service = project.service<PiwiProjectService>()
        val uri = e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { fileUri(it) }
        val contexts = service.runs?.contexts.orEmpty()
        val root = Glue.contextRootOf(service.status, uri)
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

/** Piwi: Re-run the Failing Tests — every test still failing, or edited since its run, in the Run tool window. */
class RerunFailingAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        PiwiCommands.rerunFailing(e.project ?: return)
    }
}

/** Piwi: Run selection… — one of the project's saved selections, in the Run tool window. */
class RunSelectionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

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
                            val breakpoints = project.service<PiwiProjectService>().breakpoints().ifEmpty { null }
                            val command = server?.runSelection(RunSelectionParams(uri, picked.key, breakpoints))?.orNull()
                            if (command != null) PiwiCommands.startRun(project, command)
                        }
                    }
                    .createPopup()
                    .showCenteredInCurrentWindow(project)
            }
        }
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
                    "The MCP configuration is on the clipboard: paste it in Settings → Tools → AI Assistant → Model " +
                        "Context Protocol (or your agent's MCP settings). It holds your API key: keep it out of the repository.",
                )
            }
        }

        /** Once per installation: offer Piwi's MCP server to the IDE's agent. */
        fun offer(project: Project) {
            val properties = com.intellij.ide.util.PropertiesComponent.getInstance()
            if (properties.getBoolean(OFFERED)) return
            properties.setValue(OFFERED, true)
            NotificationGroupManager.getInstance().getNotificationGroup("Piwi")
                .createNotification(
                    "Add Piwi's MCP server to your AI assistant? It can read your suite's failures, flaky tests and healings.",
                    NotificationType.INFORMATION,
                )
                .addAction(NotificationAction.createSimpleExpiring("Copy the configuration") { copyMcpConfiguration(project) })
                .notify(project)
        }

        private const val OFFERED = "piwi.mcpOffered"
    }
}

/** A popup list's cell: the text `label` gives its item. */
private fun <T> textRenderer(label: (T) -> String): SimpleListCellRenderer<T> = object : SimpleListCellRenderer<T>() {
    override fun customize(list: JList<out T>, value: T?, index: Int, selected: Boolean, hasFocus: Boolean) {
        text = value?.let(label) ?: ""
    }
}

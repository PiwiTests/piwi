package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.components.Service
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import java.awt.Component
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.DefaultListModel
import javax.swing.JList

/**
 * The **Runs** tab of the Piwi tool window, added while a run is in progress, as VS Code's Runs view: each run with how
 * far it is, each of its workers with its test and whether it stands stopped, and its page on the dashboard
 * (`Glue.runRows`, tested by `GlueTest`). A row opens its stop's line, its test's or the page on a double click or
 * Enter; its right-click offers the registered run actions that act on it (Watch, Pause and watch, Resume, Step, Stop
 * the run, Hold failures), each where it applies. Drawn by `PiwiRunSessions` on the event thread.
 */
@Service(Service.Level.PROJECT)
class PiwiRunsTab(private val project: Project) : Disposable {
    private var tab: Content? = null
    private var rowsList: JBList<Glue.RunRow>? = null

    /** The runs listed when the person closed the tab: it opens again for another run only. */
    private var closedWith: Set<String> = emptySet()

    /** The runs the tab lists now, which its closing keeps in `closedWith`. */
    private var listed: Set<String> = emptySet()

    /** The sessions changed: the tab is added, drawn again or removed. On the event thread. */
    fun changed(sessions: Map<String, RunSession>) {
        val window = ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID) ?: return
        val live = tab?.takeIf { window.contentManager.getIndexOfContent(it) >= 0 }
        val rows = Glue.runRows(sessions)
        val runs = rows.filter { it.kind.startsWith("run") }.map { it.key }.toSet()
        listed = runs
        if (runs.isEmpty()) {
            live?.let { window.contentManager.removeContent(it, true) }
            tab = null
            closedWith = emptySet()
            return
        }
        if (live != null) {
            rowsList?.let { fill(it, rows) }
            live.displayName = tabName(runs.size)
            return
        }
        if (tab != null && runs.all { it in closedWith }) return
        val shown = list(rows)
        val content = ContentFactory.getInstance().createContent(JBScrollPane(shown), tabName(runs.size), false).apply {
            isCloseable = true
            setDisposer {
                if (tab === this) closedWith = listed
                if (rowsList === shown) rowsList = null
            }
        }
        rowsList = shown
        window.contentManager.addContent(content)
        tab = content
    }

    private fun tabName(runs: Int): String = if (runs == 1) "Runs" else "Runs ($runs)"

    /** The rows as the sessions stand: none changed, nothing is drawn; else the selected row stays selected by its key. */
    private fun fill(list: JBList<Glue.RunRow>, rows: List<Glue.RunRow>) {
        val model = list.model as DefaultListModel<Glue.RunRow>
        if (model.size() == rows.size && rows.indices.all { model[it] == rows[it] }) return
        val selected = list.selectedValue?.key
        model.clear()
        model.addAll(rows)
        val index = if (selected == null) -1 else rows.indexOfFirst { it.key == selected }
        if (index >= 0) list.selectedIndex = index
    }

    private fun list(rows: List<Glue.RunRow>): JBList<Glue.RunRow> {
        val list = JBList(DefaultListModel<Glue.RunRow>().apply { addAll(rows) })
        list.cellRenderer = RunRowRenderer()
        list.emptyText.text = "No run is in progress."
        list.addMouseListener(
            object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (e.clickCount == 2) list.selectedValue?.let(::open)
                }
            },
        )
        list.addKeyListener(
            object : KeyAdapter() {
                override fun keyPressed(e: KeyEvent) {
                    if (e.keyCode == KeyEvent.VK_ENTER) list.selectedValue?.let(::open)
                }
            },
        )
        list.addMouseListener(
            object : PopupHandler() {
                override fun invokePopup(comp: Component, x: Int, y: Int) {
                    val index = list.locationToIndex(java.awt.Point(x, y)).takeIf { it >= 0 } ?: return
                    list.selectedIndex = index
                    val row = list.model.getElementAt(index)
                    val actions = actionsOf(row)
                    if (actions.childrenCount == 0) return
                    val data = SimpleDataContext.builder().add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project).build()
                    JBPopupFactory.getInstance()
                        .createActionGroupPopup(null, actions, data, JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, true)
                        .show(RelativePoint(comp, java.awt.Point(x, y)))
                }
            },
        )
        return list
    }

    /** The registered run actions that act on `row`, each wrapped to name it. */
    private fun actionsOf(row: Glue.RunRow): DefaultActionGroup = DefaultActionGroup().apply {
        val worker = row.worker
        val stop = row.stop
        when (row.kind) {
            "worker-watchable", "worker-watch-only" -> if (worker != null) {
                registeredWith("Piwi.WatchWorker") { it.add(PiwiRunSessions.WORKER, worker) }?.let(::add)
                if (row.kind == "worker-watchable") {
                    registeredWith("Piwi.PauseAndWatch") { it.add(PiwiRunSessions.WORKER, worker) }?.let(::add)
                }
            }
            "worker-stopped", "worker-held" -> if (stop != null) {
                registeredWith("Piwi.ResumeRun") { it.add(PiwiRunSessions.STOP, stop) }?.let(::add)
                if (row.kind == "worker-stopped") {
                    registeredWith("Piwi.StepRun") { it.add(PiwiRunSessions.STOP, stop) }?.let(::add)
                }
            }
            "run", "run-elsewhere" -> {
                if (row.kind == "run") registeredWith("Piwi.StopRun") { it.add(PiwiRunSessions.RUN, row.ref) }?.let(::add)
                if (row.hold != null) registeredWith("Piwi.HoldFailures") { it.add(PiwiRunSessions.RUN, row.ref) }?.let(::add)
            }
        }
    }

    private fun open(row: Glue.RunRow) {
        row.url?.let { return BrowserUtil.browse(it) }
        val file = fileOfUri(row.uri) ?: return
        OpenFileDescriptor(project, file, row.line, 0).navigate(true)
    }

    override fun dispose() {
        tab = null
        rowsList = null
    }
}

private class RunRowRenderer : ColoredListCellRenderer<Glue.RunRow>() {
    override fun customizeCellRenderer(list: JList<out Glue.RunRow>, value: Glue.RunRow?, index: Int, selected: Boolean, hasFocus: Boolean) {
        value ?: return
        when (value.kind) {
            "run", "run-elsewhere" -> {
                icon = PiwiIcons.RUNNING
                append(value.text, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
            }
            "page" -> {
                icon = AllIcons.General.Web
                append(value.text, SimpleTextAttributes.LINK_ATTRIBUTES)
            }
            else -> {
                icon = when (value.kind) {
                    "worker-held" -> AllIcons.General.Error
                    "worker-stopped" -> AllIcons.Actions.Pause
                    "worker-between" -> AllIcons.RunConfigurations.TestNotRan
                    else -> AllIcons.Actions.Execute
                }
                append(value.text)
            }
        }
        if (value.detail.isNotEmpty()) append("   ${value.detail}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
        // A run's workers and page are indented under its name.
        ipad.left = if (value.kind.startsWith("run")) 0 else 18
    }
}

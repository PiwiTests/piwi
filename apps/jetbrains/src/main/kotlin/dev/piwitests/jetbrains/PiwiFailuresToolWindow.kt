package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.ide.CommonActionsManager
import com.intellij.ide.DefaultTreeExpander
import com.intellij.ide.OccurenceNavigator
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.DoubleClickListener
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.TreeSpeedSearch
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Icon
import javax.swing.JPanel
import javax.swing.JTree
import javax.swing.SwingUtilities
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath

/**
 * The failures of the latest run on the checked-out branch, as a tree (`Glue.failureTree`): the LSP client of the
 * JetBrains IDEs highlights open files only. The run comes first, with the runs laid over it, then the failures
 * grouped by file, cluster or owner, or flat (the toggles of the toolbar, kept in `PiwiLocalSettings`): a failure of a
 * local run says so, a failure whose line changed since its run is marked edited, and the failures a later run passed
 * follow, marked fixed. Each is at its line as the edits since the run left it, and the tree follows the edits
 * (`piwi/failuresChanged`), keeping the expanded and selected nodes. Double-click or Enter opens a failure's line, where
 * the highlight carries the quick fixes, or a run's page; the right-click menu holds the failure's actions; Next and
 * Previous Occurrence go from failure to failure. Above it, the connection and the run, and Connect, Refresh, Re-run
 * the Failing Tests, the dashboard links, the previous and next failure, expand and collapse all, the groupings and the
 * settings in the toolbar.
 */
class PiwiFailuresToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun shouldBeAvailable(project: Project) = project.service<PiwiProjectService>().hasPlaywrightConfig()

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val service = project.service<PiwiProjectService>()
        val root = DefaultMutableTreeNode()
        val model = DefaultTreeModel(root)
        val tree = Tree(model).apply {
            isRootVisible = false
            showsRootHandles = true
            cellRenderer = FailureRenderer()
        }
        TreeSpeedSearch.installOn(tree, true) { path -> nodeOf(path.lastPathComponent)?.label ?: "" }
        val selected = { nodeOf(tree.lastSelectedPathComponent) }
        object : DoubleClickListener() {
            override fun onDoubleClick(event: MouseEvent): Boolean = open(project, selected())
        }.installOn(tree)
        tree.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && open(project, selected())) e.consume()
            }
        })
        // The right-click menu acts on the row under the pointer.
        tree.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) {
                if (!SwingUtilities.isRightMouseButton(e)) return
                val row = tree.getClosestRowForLocation(e.x, e.y)
                if (row >= 0 && !tree.isRowSelected(row)) tree.setSelectionRow(row)
            }
        })
        PopupHandler.installPopupMenu(tree, failureMenu(project, selected), "PiwiFailuresPopup")

        val header = JBLabel().apply {
            border = JBUI.Borders.empty(4, 8)
            componentStyle = UIUtil.ComponentStyle.SMALL
            foreground = UIUtil.getContextHelpForeground()
        }
        /** The keys of the nodes shown last, and of those expanded: a refresh keeps both. */
        val known = mutableSetOf<String>()
        val expanded = mutableSetOf<String>()
        var shown: List<Glue.FailureNode>? = null
        val render: () -> Unit = {
            val local = service.local()
            val result = service.failuresResult
            val live = service.runs?.contexts.orEmpty().firstNotNullOfOrNull { it.live?.takeIf { live -> live.own } }
            val nodes = Glue.failureTree(result, local.failuresGrouping, live = live)
            val before = shown
            if (before != null && nodes != before && Glue.sameShape(before, nodes)) {
                // Only what the nodes say changed, such as a run in progress counting its tests: each row is redrawn in
                // place, and the tree keeps its expanded rows, its selection and its scroll.
                shown = nodes
                fun update(parent: DefaultMutableTreeNode, values: List<Glue.FailureNode>) {
                    values.forEachIndexed { i, value ->
                        val node = parent.getChildAt(i) as DefaultMutableTreeNode
                        if (node.userObject != value) {
                            node.userObject = value
                            model.nodeChanged(node)
                        }
                        update(node, value.children)
                    }
                }
                update(root, nodes)
            } else if (nodes != before) {
                shown = nodes
                expanded.clear()
                expanded += expandedKeys(tree)
                val selection = selected()?.key
                root.removeAllChildren()
                fun add(parent: DefaultMutableTreeNode, children: List<Glue.FailureNode>) {
                    for (child in children) {
                        val node = DefaultMutableTreeNode(child)
                        parent.add(node)
                        add(node, child.children)
                    }
                }
                add(root, nodes)
                model.reload()
                fun restore(node: DefaultMutableTreeNode) {
                    for (child in node.children().toList().filterIsInstance<DefaultMutableTreeNode>()) {
                        val value = child.userObject as Glue.FailureNode
                        val path = TreePath(child.path)
                        if (if (value.key in known) value.key in expanded else value.expanded) tree.expandPath(path)
                        if (value.key == selection) tree.selectionPath = path
                        restore(child)
                    }
                }
                restore(root)
                // A node that leaves the tree and comes back later opens as a new one would.
                known.clear()
                fun remember(children: List<Glue.FailureNode>) {
                    for (child in children) {
                        known += child.key
                        remember(child.children)
                    }
                }
                remember(nodes)
            }
            val failing = Glue.failingCount(result)
            toolWindow.stripeTitle = if (failing == 0) "Piwi" else "Piwi ($failing)"
            val connection = Glue.connectionSummary(service.status, local.desktop)
            val run = Glue.runHeader(result)
            header.text = if (run == null) connection else "<html>${escape(connection)}<br>${escape(run)}</html>"
            val connected = service.status?.contexts.orEmpty().any { it.connected }
            // A baseline chosen that found no run says so.
            val noRun = Glue.baselineLine(result?.baseline?.label)?.takeIf { result?.run == null && it.endsWith("(no run)") }
            tree.emptyText.clear()
            when {
                service.status == null -> tree.emptyText.appendText(Glue.NOT_STARTED)
                !connected -> {
                    tree.emptyText.appendText("Not connected to a Piwi instance")
                    tree.emptyText.appendSecondaryText("Connect…", SimpleTextAttributes.LINK_PLAIN_ATTRIBUTES) {
                        PiwiConnectFlow.run(project)
                    }
                }
                noRun != null -> tree.emptyText.appendText(noRun)
                result?.run != null -> tree.emptyText.appendText("No failure in run #${result.run.id}")
                else -> tree.emptyText.appendText("No failure in the latest run")
            }
        }
        val actions = ActionManager.getInstance()
        val panel = FailuresPanel(project, tree)
        val common = CommonActionsManager.getInstance()
        val expander = DefaultTreeExpander(tree)
        val group = DefaultActionGroup(
            listOfNotNull(
                actions.getAction("Piwi.Connect"),
                actions.getAction("Piwi.Refresh"),
                actions.getAction("Piwi.RerunFailing"),
                actions.getAction("Piwi.OpenInDashboard"),
                actions.getAction("Piwi.OpenLatestRun"),
                actions.getAction("Piwi.CompareWith"),
                Separator.getInstance(),
                common.createPrevOccurenceAction(panel),
                common.createNextOccurenceAction(panel),
                common.createExpandAllAction(expander, tree),
                common.createCollapseAllAction(expander, tree),
                Separator.getInstance(),
                GroupFailuresAction(service, "file", "Group by File", AllIcons.Actions.GroupByFile, render),
                GroupFailuresAction(service, "cluster", "Group by Cluster", AllIcons.Actions.GroupBy, render),
                GroupFailuresAction(service, "owner", "Group by Owner", AllIcons.General.User, render),
                GroupFailuresAction(service, "flat", "Flat", AllIcons.Actions.ListFiles, render),
                Separator.getInstance(),
                actions.getAction("Piwi.OpenSettings"),
            ),
        )
        val toolbar = actions.createActionToolbar("PiwiToolWindow", group, true)
        toolbar.targetComponent = panel
        panel.toolbar = toolbar.component
        panel.setContent(
            JPanel(BorderLayout()).apply {
                add(header, BorderLayout.NORTH)
                add(JBScrollPane(tree), BorderLayout.CENTER)
            },
        )
        val content = ContentFactory.getInstance().createContent(panel, "Latest run", false)
        toolWindow.contentManager.addContent(content)
        service.onChange(content, render)
        render()
        service.refreshStatus()
    }

    /**
     * The tool window's panel. Its failures are the occurrences of Next and Previous Occurrence, and of the toolbar's
     * arrows, in the tree's order, collapsed groups included: each is selected and its line opened.
     */
    private class FailuresPanel(private val project: Project, private val tree: JTree) :
        SimpleToolWindowPanel(true, true), OccurenceNavigator {
        private fun failurePaths(): List<TreePath> {
            val paths = mutableListOf<TreePath>()
            fun walk(node: DefaultMutableTreeNode) {
                for (child in node.children().toList().filterIsInstance<DefaultMutableTreeNode>()) {
                    if (nodeOf(child)?.failure?.uri != null) paths += TreePath(child.path)
                    walk(child)
                }
            }
            (tree.model.root as? DefaultMutableTreeNode)?.let { walk(it) }
            return paths
        }

        private fun go(step: Int): OccurenceNavigator.OccurenceInfo? {
            val paths = failurePaths()
            val at = paths.indexOf(tree.selectionPath)
            val index = if (at < 0) (if (step > 0) 0 else paths.lastIndex) else at + step
            val path = paths.getOrNull(index) ?: return null
            tree.selectionPath = path
            tree.scrollPathToVisible(path)
            val failure = nodeOf(path.lastPathComponent)?.failure ?: return null
            val file = failure.uri?.let { VirtualFileManager.getInstance().findFileByUrl(it) } ?: return null
            return OccurenceNavigator.OccurenceInfo(OpenFileDescriptor(project, file, failure.line, 0), index + 1, paths.size)
        }

        override fun hasNextOccurence(): Boolean = failurePaths().let { it.isNotEmpty() && it.indexOf(tree.selectionPath) < it.lastIndex }

        override fun hasPreviousOccurence(): Boolean = failurePaths().let { it.isNotEmpty() && it.indexOf(tree.selectionPath) != 0 }

        override fun goNextOccurence(): OccurenceNavigator.OccurenceInfo? = go(1)

        override fun goPreviousOccurence(): OccurenceNavigator.OccurenceInfo? = go(-1)

        override fun getNextOccurenceActionName(): String = "Next Failure"

        override fun getPreviousOccurenceActionName(): String = "Previous Failure"

        override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
    }

    /** One way to group the failures, among the toolbar's toggles: selecting it keeps it for this project. */
    private class GroupFailuresAction(
        private val service: PiwiProjectService,
        private val grouping: String,
        text: String,
        icon: Icon,
        private val render: () -> Unit,
    ) : ToggleAction(text, null, icon), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun isSelected(e: AnActionEvent): Boolean = service.local().failuresGrouping == grouping

        override fun setSelected(e: AnActionEvent, state: Boolean) {
            if (!state) return
            service.local().failuresGrouping = grouping
            render()
        }
    }

    /** An action of the right-click menu on a failure, shown when it applies to the selected one. */
    private class FailureAction(
        text: String,
        icon: Icon?,
        private val selected: () -> Glue.FailureNode?,
        private val applies: (WorkspaceFailure) -> Boolean,
        private val perform: (WorkspaceFailure) -> Unit,
    ) : AnAction(text, null, icon), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabledAndVisible = selected()?.failure?.let(applies) == true
        }

        override fun actionPerformed(e: AnActionEvent) {
            selected()?.failure?.let(perform)
        }
    }

    private fun failureMenu(project: Project, selected: () -> Glue.FailureNode?): DefaultActionGroup {
        val service = project.service<PiwiProjectService>()
        val evidence = { f: WorkspaceFailure -> TraceParams(f.uri ?: "", f.executionId) }
        val failing = { f: WorkspaceFailure -> !Glue.isFixedLocally(f) }
        val desktop = { f: WorkspaceFailure -> failing(f) && f.source == "ci" && service.status?.desktopUrl != null }
        val job = { f: WorkspaceFailure, kind: String ->
            Glue.contextRootOf(service.status, f.uri)?.let {
                PiwiCommands.desktopJob(project, DesktopJobParams(root = it, executionId = f.executionId, kind = kind))
            }
            Unit
        }
        return DefaultActionGroup(
            FailureAction("Run This Test", AllIcons.Actions.Execute, selected, { it.testCaseId != null && it.uri != null }) {
                PiwiCommands.runTests(project, RunTestsArgs(it.uri!!, listOf(it.testCaseId!!)))
            },
            Separator.getInstance(),
            FailureAction("Open the Trace", null, selected, { it.hasTrace }) { PiwiCommands.openTrace(project, evidence(it)) },
            FailureAction("Open the Screenshot", null, selected, { it.hasScreenshot == true }) {
                PiwiCommands.openScreenshot(project, evidence(it))
            },
            FailureAction("Open in Dashboard", AllIcons.General.Web, selected, { it.url != null }) { f ->
                f.url?.let { BrowserUtil.browse(it) }
            },
            Separator.getInstance(),
            FailureAction("Copy Context for Agent", AllIcons.Actions.Copy, selected, failing) {
                PiwiCommands.copyAgentContext(project, evidence(it))
            },
            Separator.getInstance(),
            FailureAction("Reproduce in the Desktop App", null, selected, desktop) { job(it, "reproduce") },
            FailureAction("Find the Breaking Commit in the Desktop App", null, selected, desktop) { job(it, "bisect") },
        )
    }

    /** A failure's line, or a run's page; false for a node that opens nothing. */
    private fun open(project: Project, node: Glue.FailureNode?): Boolean {
        val failure = node?.failure
        if (failure != null) {
            val file = failure.uri?.let { VirtualFileManager.getInstance().findFileByUrl(it) } ?: return false
            OpenFileDescriptor(project, file, failure.line, 0).navigate(true)
            return true
        }
        val url = node?.url?.takeIf { node.kind == "overlay" || node.kind == "run" } ?: return false
        BrowserUtil.browse(url)
        return true
    }

    /** A failure: its title, why it failed, its run, and where; a group or a run: its label and its counts. */
    private class FailureRenderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree,
            value: Any?,
            selected: Boolean,
            expanded: Boolean,
            leaf: Boolean,
            row: Int,
            hasFocus: Boolean,
        ) {
            val node = nodeOf(value) ?: return
            icon = when (node.icon) {
                "fixed" -> AllIcons.RunConfigurations.TestPassed
                "edited" -> AllIcons.General.Information
                "error" -> AllIcons.General.Error
                "folder" -> AllIcons.Nodes.Folder
                "history" -> AllIcons.Vcs.History
                else -> AllIcons.RunConfigurations.TestState.Run
            }
            append(node.label)
            val failure = node.failure
            if (failure == null) {
                if (node.description.isNotEmpty()) append("  ${node.description}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                return
            }
            if (!Glue.isFixedLocally(failure) && !failure.headline.isNullOrBlank()) {
                append("  ${failure.headline}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
            Glue.failureRunNote(failure)?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
            append("  ${node.description}", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        }
    }

    companion object {
        const val ID = "Piwi"

        private fun nodeOf(value: Any?): Glue.FailureNode? = (value as? DefaultMutableTreeNode)?.userObject as? Glue.FailureNode

        /** The keys of the expanded nodes of the tree. */
        private fun expandedKeys(tree: JTree): Set<String> {
            val keys = mutableSetOf<String>()
            for (row in 0 until tree.rowCount) {
                val path = tree.getPathForRow(row) ?: continue
                if (tree.isExpanded(path)) nodeOf(path.lastPathComponent)?.let { keys += it.key }
            }
            return keys
        }

        private fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    }
}

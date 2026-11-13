package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.ide.CommonActionsManager
import com.intellij.ide.DefaultTreeExpander
import com.intellij.ide.OccurenceNavigator
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
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
import com.intellij.openapi.util.IconLoader
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
import javax.swing.ToolTipManager
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath

/**
 * The failures of the latest run on the checked-out branch, as the tree the service groups (`Glue.failureNodes`): the LSP client of the
 * JetBrains IDEs highlights open files only. The run comes first, with the runs laid over it, then the failures
 * grouped by file, cluster or owner, or flat (the toggles of the toolbar, kept in `PiwiLocalSettings`): a failure of a
 * local run says so, a failure whose line changed since its run is marked edited, and the failures a later run passed
 * follow, marked fixed. When several Playwright configs have something to show, each has a node of its own over its
 * run. Each failure is at its line as the edits since the run left it, and the tree follows the edits
 * (`piwi/failuresChanged`), keeping the expanded and selected nodes. Double-click or Enter opens a failure's line, where
 * the highlight carries the quick fixes, or a run's page; the right-click menu holds the failure's actions, and a
 * config's (Re-run the Failing Tests, Compare With…, Open in Dashboard, for that config); Next and Previous Occurrence
 * go from failure to failure, and each node's hover says what the service says of it. Above it, the connection and the
 * run, and in the toolbar Refresh the Latest Run, Re-run the Failing Tests, Open in Dashboard, Compare With…, the Group
 * By menu, the previous and next failure, and expand and collapse all; Connect, Piwi Picker's pairing, the MCP
 * configurations, Refresh and the settings are in the gear menu. The tab is Failures, and the tool window's icon has a
 * red dot while tests fail.
 */
class PiwiFailuresToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun shouldBeAvailable(project: Project) = project.service<PiwiProjectService>().hasPlaywrightConfig()

    /**
     * The stripe button, from the start and whether or not the tool window was opened: its title counts the failing tests
     * (`Piwi (2)`), and its icon carries a red dot while tests fail.
     */
    override fun init(toolWindow: ToolWindow) {
        val service = toolWindow.project.service<PiwiProjectService>()
        val draw = {
            val failing = service.failuresResult?.failing ?: 0
            toolWindow.stripeTitle = if (failing == 0) "Piwi" else "Piwi ($failing)"
            toolWindow.setIcon(if (failing == 0) PIWI_ICON else FAILING_ICON)
        }
        service.onChange(toolWindow.disposable, draw)
        draw()
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val service = project.service<PiwiProjectService>()
        val root = DefaultMutableTreeNode()
        val model = DefaultTreeModel(root)
        val tree = Tree(model).apply {
            isRootVisible = false
            showsRootHandles = true
            cellRenderer = FailureRenderer()
        }
        // Each node's hover text, the service's (`FailureTreeNode.tooltip`), as VS Code shows it.
        ToolTipManager.sharedInstance().registerComponent(tree)
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
            val own = Glue.ownRunInProgress(
                service.runs?.contexts.orEmpty(),
                project.getServiceIfCreated(PiwiRunSessions::class.java)?.sessions.orEmpty(),
            )
            val nodes = Glue.failureNodes(result, live = own?.first, liveRoot = own?.second)
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
            val connection = Glue.connectionSummary(service.status, local.desktop, service.startProblem, service.trusted(), service.serviceStopped)
            val run = Glue.runHeader(result)
            header.text = if (run == null) connection else "<html>${escape(connection)}<br>${escape(run)}</html>"
            // A baseline chosen that found no run says so.
            val noRun = Glue.baselineLine(result?.baseline?.label)?.takeIf { result?.run == null && it.endsWith("(no run)") }
            tree.emptyText.clear()
            val empty = if (service.status == null) {
                Glue.serviceDownText(service.trusted(), service.startProblem, service.serviceStopped)
            } else {
                Glue.failuresEmpty(result?.view, noRun, result?.run?.id)
            }
            tree.emptyText.appendText(empty.text)
            // A service that cannot start: the Node.js settings one click away, which start it again once closed.
            val nodeSettings = service.status == null && service.trusted() && service.startProblem != null
            if (nodeSettings) {
                tree.emptyText.appendSecondaryText(Glue.NODE_SETTINGS_LINK, SimpleTextAttributes.LINK_PLAIN_ATTRIBUTES) {
                    service.openNodeSettings()
                }
            }
            for ((i, link) in empty.links.withIndex()) {
                if (i > 0 || nodeSettings) tree.emptyText.appendSecondaryText("   ", SimpleTextAttributes.REGULAR_ATTRIBUTES, null)
                tree.emptyText.appendSecondaryText(link.label, SimpleTextAttributes.LINK_PLAIN_ATTRIBUTES) {
                    val actions = ActionManager.getInstance()
                    actions.getAction(link.actionId)?.let { actions.tryToExecute(it, null, tree, ActionPlaces.UNKNOWN, true) }
                }
            }
        }
        val actions = ActionManager.getInstance()
        val panel = FailuresPanel(project, tree)
        val common = CommonActionsManager.getInstance()
        val expander = DefaultTreeExpander(tree)
        val group = DefaultActionGroup(
            listOfNotNull(
                actions.getAction("Piwi.RefreshRun"),
                actions.getAction("Piwi.RerunFailing"),
                actions.getAction("Piwi.OpenInDashboard"),
                actions.getAction("Piwi.CompareWith"),
                groupByMenu(service),
                Separator.getInstance(),
                common.createPrevOccurenceAction(panel),
                common.createNextOccurenceAction(panel),
                common.createExpandAllAction(expander, tree),
                common.createCollapseAllAction(expander, tree),
            ),
        )
        toolWindow.setAdditionalGearActions(gearActions())
        val toolbar = actions.createActionToolbar("PiwiToolWindow", group, true)
        toolbar.targetComponent = panel
        panel.toolbar = toolbar.component
        panel.setContent(
            JPanel(BorderLayout()).apply {
                add(header, BorderLayout.NORTH)
                add(JBScrollPane(tree), BorderLayout.CENTER)
            },
        )
        val content = ContentFactory.getInstance().createContent(panel, TAB_NAME, false).apply { isCloseable = false }
        toolWindow.contentManager.addContent(content)
        service.onChange(content, render)
        // The editor's own run counts as its process tells the hub.
        project.service<PiwiRunSessions>().onChange(content, render)
        render()
        service.refreshStatus()
    }

    /**
     * The tool window's panel. Its failures are the occurrences of Next and Previous Occurrence, and of the toolbar's
     * arrows, in the tree's order, collapsed groups included: each is selected and its line opened.
     */
    private class FailuresPanel(private val project: Project, private val tree: JTree) :
        SimpleToolWindowPanel(true, true), OccurenceNavigator {
        /** The selected node's dashboard page, for Open in Dashboard. */
        override fun getData(dataId: String): Any? =
            if (DASHBOARD_URL.`is`(dataId)) nodeOf(tree.lastSelectedPathComponent)?.url else super.getData(dataId)

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

    /** **Group By**: the toolbar's one drop-down of the groupings, one of them checked. */
    private fun groupByMenu(service: PiwiProjectService): DefaultActionGroup =
        DefaultActionGroup("Group By", true).apply {
            templatePresentation.icon = AllIcons.Actions.ShowAsTree
            templatePresentation.description = "Group the failures by file, cluster or owner, or list them flat"
            add(GroupFailuresAction(service, "file", "File"))
            add(GroupFailuresAction(service, "cluster", "Cluster"))
            add(GroupFailuresAction(service, "owner", "Owner"))
            add(GroupFailuresAction(service, "flat", "Flat"))
        }

    /**
     * The tool window's gear menu: the connection, Piwi Picker's pairing, the MCP configurations, and the reading, the
     * editor service, its log and the settings of Piwi itself.
     */
    private fun gearActions(): DefaultActionGroup {
        val actions = ActionManager.getInstance()
        fun registered(vararg ids: String) = ids.mapNotNull { actions.getAction(it) }
        return DefaultActionGroup().apply {
            addAll(registered("Piwi.Connect", "Piwi.Disconnect"))
            addSeparator()
            addAll(registered("Piwi.PairPicker", "Piwi.CopyMcpConfiguration", "Piwi.CopyRunsMcpConfiguration", "Piwi.CopyRunsMcpHttpConfiguration"))
            addSeparator()
            addAll(registered("Piwi.Refresh", "Piwi.RestartService", "Piwi.OpenLog", "Piwi.OpenSettings"))
        }
    }

    /** One way to group the failures, in the Group By menu: selecting it keeps it for this project and reads them so grouped. */
    private class GroupFailuresAction(
        private val service: PiwiProjectService,
        private val grouping: String,
        text: String,
    ) : ToggleAction(text), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun isSelected(e: AnActionEvent): Boolean = service.local().failuresGrouping == grouping

        override fun setSelected(e: AnActionEvent, state: Boolean) {
            if (!state) return
            service.local().failuresGrouping = grouping
            service.regroup()
        }
    }

    /** An action of the right-click menu on a Playwright config's node or a run's, shown when it applies to the selected one. */
    private class ConfigAction(
        text: String,
        icon: Icon?,
        private val selected: () -> Glue.FailureNode?,
        private val applies: (Glue.FailureNode) -> Boolean,
        private val perform: (Glue.FailureNode) -> Unit,
    ) : AnAction(text, null, icon), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabledAndVisible = selected()?.takeIf { it.kind == "context" || it.kind == "run" }?.let(applies) == true
        }

        override fun actionPerformed(e: AnActionEvent) {
            selected()?.let(perform)
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
            (f.root ?: Glue.contextRootOf(service.status, f.uri))?.let {
                PiwiCommands.desktopJob(project, DesktopJobParams(root = it, executionId = f.executionId, kind = kind))
            }
            Unit
        }
        val failingIn = { n: Glue.FailureNode -> n.kind == "context" && n.root != null && Glue.failingRuns(service.failuresResult, n.root).isNotEmpty() }
        return DefaultActionGroup(
            ConfigAction("Re-run the Failing Tests", AllIcons.RunConfigurations.RerunFailedTests, selected, failingIn) {
                PiwiCommands.rerunFailing(project, it.root)
            },
            ConfigAction("Compare With…", AllIcons.Actions.Diff, selected, { it.root != null }) { CompareWithAction.choose(project, it.root) },
            ConfigAction("Open in Dashboard", PiwiIcons.OPEN_IN_DASHBOARD, selected, { it.url != null }) { n -> n.url?.let { BrowserUtil.browse(it) } },
            Separator.getInstance(),
            FailureAction("Run This Test", AllIcons.Actions.Execute, selected, { Glue.failureRunArgs(it) != null }) {
                Glue.failureRunArgs(it)?.let { args -> PiwiCommands.runTests(project, args) }
            },
            Separator.getInstance(),
            FailureAction("Open the Trace", PiwiIcons.TRACE, selected, { it.hasTrace }) { PiwiCommands.openTrace(project, evidence(it)) },
            FailureAction("Open the Screenshot", PiwiIcons.SCREENSHOT, selected, { it.hasScreenshot == true }) {
                PiwiCommands.openScreenshot(project, evidence(it))
            },
            FailureAction("Open in Dashboard", PiwiIcons.OPEN_IN_DASHBOARD, selected, { it.url != null }) { f ->
                f.url?.let { BrowserUtil.browse(it) }
            },
            Separator.getInstance(),
            FailureAction("Copy Context for Agent", AllIcons.Actions.Copy, selected, failing) {
                PiwiCommands.copyAgentContext(project, evidence(it))
            },
            Separator.getInstance(),
            FailureAction("Reproduce in the Desktop App", PiwiIcons.REPRODUCE, selected, desktop) { job(it, "reproduce") },
            FailureAction("Find the Breaking Commit in the Desktop App", PiwiIcons.BISECT, selected, desktop) { job(it, "bisect") },
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
            toolTipText = node.tooltip.takeIf { it.isNotEmpty() }?.let { Glue.htmlTooltip(it.joinToString("\n")) }
            icon = when (node.icon) {
                "context" -> AllIcons.Nodes.Module
                "fixed", "passed" -> AllIcons.RunConfigurations.TestPassed
                "edited" -> AllIcons.General.Information
                "failing", "failed" -> PiwiIcons.FAILED
                "file", "cluster", "owner" -> AllIcons.Nodes.Folder
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
            node.note?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
            append("  ${node.description}", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        }
    }

    companion object {
        const val ID = "Piwi"

        /** The tool window's tab, named as the status bar's Open the Failures and a run's notification name it. */
        const val TAB_NAME = "Failures"

        private val PIWI_ICON: Icon = IconLoader.getIcon("/icons/piwi.svg", PiwiFailuresToolWindowFactory::class.java)

        /** The tool window's icon while tests fail: the Piwi mark with a red dot. */
        private val FAILING_ICON: Icon = IconLoader.getIcon("/icons/piwi_failing.svg", PiwiFailuresToolWindowFactory::class.java)

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

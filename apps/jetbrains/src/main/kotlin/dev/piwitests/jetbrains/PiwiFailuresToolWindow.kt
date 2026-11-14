package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.ide.CommonActionsManager
import com.intellij.ide.DefaultTreeExpander
import com.intellij.ide.OccurenceNavigator
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.DumbAwareAction
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
import com.intellij.ui.components.ActionLink
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
 * The failures of the latest run on the checked-out branch, as the tree the service groups (`Glue.failureNodes`): the
 * LSP client of the JetBrains IDEs highlights open files only. The run comes first, with the runs laid over it, then
 * the failures grouped by file, cluster or owner, or flat (the toggles of the toolbar, kept in `PiwiLocalSettings`): a
 * failure of a local run says so, a failure whose line changed since its run is marked edited, and the failures a later
 * run passed follow, marked fixed. When several Playwright configs have something to show, each has a node of its own
 * over its run. Each failure is at its line as the edits since the run left it, and the tree follows the edits
 * (`piwi/failuresChanged`), keeping the expanded and selected nodes. Double-click or Enter opens a failure's line,
 * where the highlight carries the quick fixes, or a run's page; the right-click menu holds the failure's actions, and a
 * config's (Re-run the failing tests, Compare with…, Open in dashboard, for that config); Next and Previous Occurrence
 * go from failure to failure, and each node's hover says what the service says of it. Above it, the connection and the
 * run, and in the toolbar Refresh the latest run, Re-run the failing tests, Open in dashboard, Compare with…, the Group
 * by menu, the previous and next failure, and expand and collapse all; Connect, Piwi Picker's pairing, the MCP
 * configurations, Reload Piwi, the settings and Documentation are in the gear menu. The tab is Failures, and the tool
 * window's icon has a red dot while tests fail.
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
            toolWindow.setIcon(if (failing == 0) PiwiIcons.PIWI else PiwiIcons.PIWI_FAILING)
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

        // One line in the small font: the connection, a link to the settings that shortens with an ellipsis, and the
        // baseline, a link to Compare with… that always shows.
        fun headerLink(actionId: String) = ActionLink("") { e ->
            val actions = ActionManager.getInstance()
            actions.getAction(actionId)?.let { actions.tryToExecute(it, null, e.source as java.awt.Component, "PiwiToolWindow", true) }
        }.apply {
            putClientProperty("html.disable", true)
            font = JBUI.Fonts.smallFont()
            horizontalAlignment = javax.swing.SwingConstants.LEFT
        }
        val connectionLink = headerLink("Piwi.OpenSettings")
        val baselineDot = JBLabel(" · ").apply {
            componentStyle = UIUtil.ComponentStyle.SMALL
            foreground = UIUtil.getContextHelpForeground()
        }
        val baselineLink = headerLink("Piwi.CompareWith")
        val header = JPanel().apply {
            layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.X_AXIS)
            border = JBUI.Borders.empty(4, 8)
            isOpaque = false
            add(connectionLink)
            add(baselineDot)
            add(baselineLink)
            add(javax.swing.Box.createHorizontalGlue())
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
            val line = Glue.toolWindowHeader(service.status, result, local.desktop, service.startProblem, service.trusted(), service.serviceStopped)
            connectionLink.text = line.connection
            connectionLink.toolTipText = Glue.htmlTooltip(line.tooltip)
            baselineLink.text = line.baseline ?: ""
            baselineDot.isVisible = line.baseline != null
            baselineLink.isVisible = line.baseline != null
            // The connection gives way to the baseline in a narrow window, shortened with an ellipsis.
            connectionLink.minimumSize = java.awt.Dimension(0, connectionLink.preferredSize.height)
            baselineLink.minimumSize = baselineLink.preferredSize
            header.revalidate()
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
        /** The selected node's dashboard page, for Open in dashboard, and the node, for the `Piwi.Failure.*` actions. */
        override fun getData(dataId: String): Any? = when {
            DASHBOARD_URL.`is`(dataId) -> nodeOf(tree.lastSelectedPathComponent)?.url
            FAILURE_NODE.`is`(dataId) -> nodeOf(tree.lastSelectedPathComponent)
            else -> super.getData(dataId)
        }

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

        override fun getNextOccurenceActionName(): String = "Next failure"

        override fun getPreviousOccurenceActionName(): String = "Previous failure"

        override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
    }

    /** **Group by**: the toolbar's one drop-down of the groupings, one of them checked. */
    private fun groupByMenu(service: PiwiProjectService): DefaultActionGroup =
        DefaultActionGroup("Group by", true).apply {
            templatePresentation.icon = AllIcons.Actions.ShowAsTree
            templatePresentation.description = "Group the failures by file, cluster or owner, or list them flat"
            add(GroupFailuresAction(service, "file", "File"))
            add(GroupFailuresAction(service, "cluster", "Cluster"))
            add(GroupFailuresAction(service, "owner", "Owner"))
            add(GroupFailuresAction(service, "flat", "Flat"))
        }

    /**
     * The tool window's gear menu: the connection, Piwi Picker's pairing, the MCP configurations, and the reading, the
     * editor service, its log, the settings of Piwi itself and its documentation.
     */
    private fun gearActions(): DefaultActionGroup {
        val actions = ActionManager.getInstance()
        fun registered(vararg ids: String) = ids.mapNotNull { actions.getAction(it) }
        return DefaultActionGroup().apply {
            addAll(registered("Piwi.Connect", "Piwi.Disconnect"))
            addSeparator()
            addAll(registered("Piwi.PairPicker", "Piwi.CopyMcpConfiguration", "Piwi.CopyRunsMcpConfiguration", "Piwi.CopyRunsMcpHttpConfiguration"))
            addSeparator()
            addAll(registered("Piwi.Refresh", "Piwi.RestartService", "Piwi.OpenLog", "Piwi.OpenSettings", "Piwi.OpenDocumentation"))
        }
    }

    /** One way to group the failures, in the Group by menu: selecting it keeps it for this project and reads them so grouped. */
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

    /**
     * A flaky test's actions, as the service lists them: its Flakiness tab, then the Flake Lab commands it can run, each
     * with the glyph of what it does (the page, the desktop app's job, a command).
     */
    private class FlakeActions(private val project: Project, private val selected: () -> Glue.FailureNode?) : ActionGroup(), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun getChildren(e: AnActionEvent?): Array<AnAction> =
            selected()?.takeIf { it.kind == "flaky" }?.actions.orEmpty().map { command ->
                val icon = when (command.command) {
                    "piwi.openInDashboard" -> PiwiIcons.OPEN_IN_DASHBOARD
                    "piwi.desktopJob" -> PiwiIcons.REPRODUCE
                    else -> AllIcons.Actions.Execute
                }
                DumbAwareAction.create(command.title.orEmpty(), icon) { PiwiCommands.execute(project, command.command, command.arguments.orEmpty()) }
            }.toTypedArray()
    }

    /**
     * The tree's right-click menu: the selected config's actions, then the registered `Piwi.Failure.*` actions, which act
     * on the selected failure (`FAILURE_NODE`), their keys shown and Find Action reaching them.
     */
    private fun failureMenu(project: Project, selected: () -> Glue.FailureNode?): DefaultActionGroup {
        val service = project.service<PiwiProjectService>()
        val actions = com.intellij.openapi.actionSystem.ActionManager.getInstance()
        fun registered(vararg ids: String): Array<AnAction> = ids.mapNotNull { actions.getAction(it) }.toTypedArray()
        val failingIn = { n: Glue.FailureNode -> n.kind == "context" && n.root != null && Glue.failingRuns(service.failuresResult, n.root).isNotEmpty() }
        return DefaultActionGroup(
            ConfigAction("Re-run the failing tests", AllIcons.RunConfigurations.RerunFailedTests, selected, failingIn) {
                PiwiCommands.rerunFailing(project, it.root)
            },
            ConfigAction("Compare with…", AllIcons.Actions.Diff, selected, { it.root != null }) { CompareWithAction.choose(project, it.root) },
            // The selected node's page, a run's or a failure's (`DASHBOARD_URL`).
            *registered("Piwi.OpenInDashboard"),
            FlakeActions(project, selected),
            Separator.getInstance(),
            *registered("Piwi.Failure.RunTest", "Piwi.Failure.Debug"),
            Separator.getInstance(),
            *registered("Piwi.Failure.OpenTrace", "Piwi.Failure.OpenScreenshot"),
            Separator.getInstance(),
            *registered("Piwi.Failure.CopyContext"),
            Separator.getInstance(),
            *registered("Piwi.Failure.Reproduce", "Piwi.Failure.FindBreakingCommit"),
        )
    }

    /** A failure's line, a flaky test's `test(…)` line, or a run's page; false for a node that opens nothing. */
    private fun open(project: Project, node: Glue.FailureNode?): Boolean {
        val failure = node?.failure
        if (failure != null) {
            val file = failure.uri?.let { VirtualFileManager.getInstance().findFileByUrl(it) } ?: return false
            OpenFileDescriptor(project, file, failure.line, 0).navigate(true)
            return true
        }
        if (node?.uri != null && node.line != null) {
            val file = VirtualFileManager.getInstance().findFileByUrl(node.uri) ?: return false
            OpenFileDescriptor(project, file, node.line, 0).navigate(true)
            return true
        }
        val url = node?.url?.takeIf { node.kind == "overlay" || node.kind == "run" } ?: return false
        BrowserUtil.browse(url)
        return true
    }

    /**
     * A failure: its title, its run and where, and why it failed in its hover, as the service places it; a group or a
     * run: its label and its counts.
     */
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
            icon = PiwiIcons.FAILURE_NODES[node.icon]
            append(node.label)
            val failure = node.failure
            if (failure == null) {
                if (node.description.isNotEmpty()) append("  ${node.description}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                return
            }
            node.note?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
            append("  ${node.description}", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        }
    }

    companion object {
        const val ID = "Piwi"

        /** The tool window's tab, named as the status bar's Open the failures and a run's notification name it. */
        const val TAB_NAME = "Failures"

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

    }
}

/** The failure node the Piwi tool window has selected, which the `Piwi.Failure.*` actions act on. */
val FAILURE_NODE: DataKey<Glue.FailureNode> = DataKey.create("piwi.failureNode")

/**
 * An action on the failure the Piwi tool window has selected (`FAILURE_NODE`), shown and enabled only where it applies;
 * its words are `plugin.xml`'s.
 */
abstract class FailureNodeAction(icon: Icon) : AnAction(null, null, icon), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.EDT

    abstract fun applies(project: Project, failure: WorkspaceFailure): Boolean

    abstract fun perform(project: Project, failure: WorkspaceFailure)

    override fun update(e: AnActionEvent) {
        val project = e.project
        val failure = e.getData(FAILURE_NODE)?.failure
        e.presentation.isEnabledAndVisible = project != null && failure != null && applies(project, failure)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        e.getData(FAILURE_NODE)?.failure?.let { perform(project, it) }
    }

    protected fun evidence(f: WorkspaceFailure) = TraceParams(f.uri ?: "", f.executionId)

    /** Whether a desktop job applies: a CI failure not fixed here, while the desktop app runs. */
    protected fun desktop(project: Project, f: WorkspaceFailure) =
        !Glue.isFixedLocally(f) && f.source == "ci" && project.service<PiwiProjectService>().status?.desktopUrl != null

    protected fun job(project: Project, f: WorkspaceFailure, kind: String) {
        val service = project.service<PiwiProjectService>()
        (f.root ?: Glue.contextRootOf(service.status, f.uri))?.let {
            PiwiCommands.desktopJob(project, DesktopJobParams(root = it, executionId = f.executionId, kind = kind))
        }
    }
}

/** **Run this test**: the selected failure's test, as Piwi runs it. */
class RunFailureTestAction : FailureNodeAction(AllIcons.Actions.Execute) {
    override fun applies(project: Project, failure: WorkspaceFailure) = Glue.failureRunArgs(failure) != null

    override fun perform(project: Project, failure: WorkspaceFailure) {
        Glue.failureRunArgs(failure)?.let { PiwiCommands.runTests(project, it) }
    }
}

/**
 * **Debug this failure**: the run the service built for it (`WorkspaceFailure.debug`), stopping once at the line it
 * failed through, once the files are saved.
 */
class DebugFailureAction : FailureNodeAction(AllIcons.Actions.StartDebugger) {
    override fun applies(project: Project, failure: WorkspaceFailure) = failure.debug != null

    override fun perform(project: Project, failure: WorkspaceFailure) {
        val debug = failure.debug ?: return
        FileDocumentManager.getInstance().saveAllDocuments()
        // Quietly: the service says itself why it refuses a debug run.
        PiwiCommands.runTests(project, debug, quiet = true)
    }
}

/** **Open the trace** of the selected failure. */
class OpenFailureTraceAction : FailureNodeAction(PiwiIcons.TRACE) {
    override fun applies(project: Project, failure: WorkspaceFailure) = failure.hasTrace

    override fun perform(project: Project, failure: WorkspaceFailure) = PiwiCommands.openTrace(project, evidence(failure))
}

/** **Open the screenshot** of the selected failure. */
class OpenFailureScreenshotAction : FailureNodeAction(PiwiIcons.SCREENSHOT) {
    override fun applies(project: Project, failure: WorkspaceFailure) = failure.hasScreenshot == true

    override fun perform(project: Project, failure: WorkspaceFailure) = PiwiCommands.openScreenshot(project, evidence(failure))
}

/** **Copy context for agent**: the selected failure, as an agent reads it. */
class CopyFailureContextAction : FailureNodeAction(AllIcons.Actions.Copy) {
    override fun applies(project: Project, failure: WorkspaceFailure) = !Glue.isFixedLocally(failure)

    override fun perform(project: Project, failure: WorkspaceFailure) = PiwiCommands.copyAgentContext(project, evidence(failure))
}

/** **Reproduce in the desktop app**: the selected CI failure, reproduced on this machine. */
class ReproduceFailureAction : FailureNodeAction(PiwiIcons.REPRODUCE) {
    override fun applies(project: Project, failure: WorkspaceFailure) = desktop(project, failure)

    override fun perform(project: Project, failure: WorkspaceFailure) = job(project, failure, "reproduce")
}

/** **Find the breaking commit in the desktop app**: the commit that broke the selected CI failure's test. */
class FindBreakingCommitAction : FailureNodeAction(PiwiIcons.BISECT) {
    override fun applies(project: Project, failure: WorkspaceFailure) = desktop(project, failure)

    override fun perform(project: Project, failure: WorkspaceFailure) = job(project, failure, "bisect")
}

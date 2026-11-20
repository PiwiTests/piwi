package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.ide.CommonActionsManager
import com.intellij.ide.DefaultTreeExpander
import com.intellij.ide.TreeExpander
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.wm.ToolWindow
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.DoubleClickListener
import com.intellij.ui.PopupHandler
import com.intellij.ui.SearchTextField
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.TreeSpeedSearch
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.content.ContentManagerEvent
import com.intellij.ui.content.ContentManagerListener
import com.intellij.ui.treeStructure.Tree
import java.awt.BorderLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseEvent
import javax.swing.Icon
import javax.swing.JPanel
import javax.swing.JTree
import javax.swing.event.DocumentEvent
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath

/** The nodes selected in the Tests tab, and whether its filter is on, for the `Piwi.Tests.*` actions. */
data class TestsSelection(val nodes: List<Glue.TestsNode>, val filtered: Boolean)

val TESTS_SELECTION: DataKey<TestsSelection> = DataKey.create("piwi.testsSelection")

/**
 * The **Tests** tab of the Piwi tool window: every test the editor service lists for the project's Playwright configs
 * (`piwi/testItems`), under their folders, specs and describe blocks, a test of several Playwright projects with a
 * node per project, and the tests only the instance knows in the **Not in this checkout** group (`Glue.testsTree`).
 * The service lists the configs once the tab is first shown, and pushes the tree a listing changes; the toolbar's
 * **Read the instance and the configs again** lists them again. A node opens its
 * line on a double click or Enter, a test of Not in this checkout its dashboard page; the toolbar and the right-click
 * run the selected nodes (`Piwi.Tests.*`, through `piwi/testRuns`). The filter field keeps the tests whose title, tag,
 * owner or result holds its words, and a run then takes what the tab shows.
 */
@Service(Service.Level.PROJECT)
class PiwiTestsTab(private val project: Project) : Disposable {
    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree = Tree(model).apply {
        isRootVisible = false
        showsRootHandles = true
        cellRenderer = TestsRenderer()
    }
    private val filterField = SearchTextField(false)

    /** The nodes drawn, which a draw compares with: the tree is built again only when they change. */
    private var drawn: List<Glue.TestsNode>? = null

    /** Add the tab to the tool window, after Failures; the tests are read once it is first selected. */
    fun install(toolWindow: ToolWindow) {
        val service = project.service<PiwiProjectService>()
        TreeSpeedSearch.installOn(tree, true) { path -> nodeOf(path.lastPathComponent)?.label ?: "" }
        object : DoubleClickListener() {
            override fun onDoubleClick(event: MouseEvent): Boolean = open(nodeOf(tree.lastSelectedPathComponent))
        }.installOn(tree)
        tree.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && open(nodeOf(tree.lastSelectedPathComponent))) e.consume()
            }
        })
        val actions = ActionManager.getInstance()
        fun registered(vararg ids: String) = ids.mapNotNull { actions.getAction(it) }
        PopupHandler.installPopupMenu(
            tree,
            DefaultActionGroup(
                registered("Piwi.Tests.Run", "Piwi.Tests.Debug", "Piwi.Tests.Verify") +
                    listOf(Separator.getInstance()) + registered("Piwi.OpenInDashboard"),
            ),
            "PiwiTestsTab",
        )
        filterField.textEditor.emptyText.text = "Filter by title, tag, owner or result"
        filterField.addDocumentListener(object : DocumentAdapter() {
            override fun textChanged(e: DocumentEvent) = render()
        })
        val expander = DefaultTreeExpander(tree)
        val panel = TestsPanel(tree, expander) { TestsSelection(selected(), filtered()) }
        val common = CommonActionsManager.getInstance()
        val toolbar = actions.createActionToolbar(
            "PiwiTestsTab",
            DefaultActionGroup(
                registered("Piwi.Tests.Run", "Piwi.Tests.Debug", "Piwi.Tests.Verify") +
                    listOf(Separator.getInstance()) + registered("Piwi.Refresh") +
                    listOf(
                        common.createExpandAllAction(expander, tree),
                        common.createCollapseAllAction(expander, tree),
                    ),
            ),
            true,
        )
        toolbar.targetComponent = panel
        panel.toolbar = toolbar.component
        panel.setContent(
            JPanel(BorderLayout()).apply {
                add(filterField, BorderLayout.NORTH)
                add(JBScrollPane(tree), BorderLayout.CENTER)
            },
        )
        val content = ContentFactory.getInstance().createContent(panel, TAB_NAME, false).apply {
            isCloseable = false
            preferredFocusableComponent = tree
        }
        toolWindow.contentManager.addContent(content)
        toolWindow.contentManager.addContentManagerListener(object : ContentManagerListener {
            override fun selectionChanged(event: ContentManagerEvent) {
                if (event.content === content && event.operation == ContentManagerEvent.ContentOperation.add) {
                    service.readTestItems()
                }
            }
        })
        service.onChange(content, ::render)
        render()
    }

    private fun filtered() = filterField.text.isNotBlank()

    private fun selected(): List<Glue.TestsNode> = tree.selectionPaths.orEmpty().mapNotNull { nodeOf(it.lastPathComponent) }

    /** Draw the tree as the service last gave it and the filter shows it, keeping what was expanded and selected. */
    private fun render() {
        val service = project.service<PiwiProjectService>()
        val result = service.testItems
        val nodes = Glue.testsFiltered(Glue.testsTree(result), filterField.text)
        if (result == null && service.status == null) {
            showServiceDown(tree, service)
        } else {
            tree.emptyText.text = Glue.testsEmptyText(result, filtered())
        }
        if (nodes == drawn) {
            tree.repaint()
            return
        }
        val first = drawn == null || drawn!!.isEmpty()
        val expanded = mutableSetOf<String>()
        tree.getExpandedDescendants(TreePath(root))?.toList()?.forEach { path ->
            nodeOf(path.lastPathComponent)?.let { expanded += it.id }
        }
        val selectedIds = selected().map { it.id }.toSet()
        drawn = nodes
        root.removeAllChildren()
        fun add(parent: DefaultMutableTreeNode, n: Glue.TestsNode) {
            val child = DefaultMutableTreeNode(n)
            parent.add(child)
            n.children.forEach { add(child, it) }
        }
        nodes.forEach { add(root, it) }
        model.reload()
        val paths = mutableListOf<TreePath>()
        fun walk(parent: DefaultMutableTreeNode, depth: Int) {
            for (child in parent.children().toList().filterIsInstance<DefaultMutableTreeNode>()) {
                val n = nodeOf(child) ?: continue
                val path = TreePath(child.path)
                // The first draw opens the top nodes; a filter opens every node above a test it keeps.
                if (n.id in expanded || (first && depth == 0) || (filtered() && n.test == null)) tree.expandPath(path)
                if (n.id in selectedIds) paths += path
                walk(child, depth + 1)
            }
        }
        walk(root, 0)
        if (paths.isNotEmpty()) tree.selectionPaths = paths.toTypedArray()
    }

    /** A node's line in its spec, or the dashboard's page of a test the checkout does not hold; false when it opens nothing. */
    private fun open(node: Glue.TestsNode?): Boolean {
        node ?: return false
        val uri = node.uri
        if (uri != null && node.line != null) {
            val file = fileOfUri(uri) ?: return false
            OpenFileDescriptor(project, file, node.line, 0).navigate(true)
            return true
        }
        val url = node.test?.url?.takeIf { node.test.uri.isNullOrEmpty() } ?: return false
        BrowserUtil.browse(url)
        return true
    }

    override fun dispose() {}

    /**
     * The panel: the selected nodes for the `Piwi.Tests.*` actions, a selected test's page for Open in dashboard, and the
     * tree's expander for the IDE's Expand All and Collapse All keys.
     */
    private class TestsPanel(
        private val tree: JTree,
        private val expander: TreeExpander,
        private val selection: () -> TestsSelection,
    ) : SimpleToolWindowPanel(true, true) {
        override fun getData(dataId: String): Any? = when {
            TESTS_SELECTION.`is`(dataId) -> selection()
            DASHBOARD_URL.`is`(dataId) -> nodeOf(tree.lastSelectedPathComponent)?.test?.url
            PlatformDataKeys.TREE_EXPANDER.`is`(dataId) -> expander
            else -> super.getData(dataId)
        }
    }

    /** A node: its result's icon, its name, and a test's duration, dimmed in Not in this checkout; a config's error in red. */
    private class TestsRenderer : ColoredTreeCellRenderer() {
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
            val missing = node.kind == "notInCheckout" || (node.test != null && node.test.uri.isNullOrEmpty())
            icon = when {
                node.error != null -> AllIcons.General.Error
                node.kind == "notInCheckout" -> AllIcons.General.Information
                else -> PiwiIcons.outcome(Glue.testsStatus(node), turning = false)
            }
            append(node.label, if (missing) SimpleTextAttributes.GRAYED_ATTRIBUTES else SimpleTextAttributes.REGULAR_ATTRIBUTES)
            Glue.testsDuration(node.test?.resultDurationMs)?.let { append("  $it", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES) }
            node.error?.let {
                append("  $it", SimpleTextAttributes.ERROR_ATTRIBUTES)
                toolTipText = Glue.htmlTooltip(it)
            }
        }
    }

    companion object {
        const val TAB_NAME = "Tests"

        private fun nodeOf(value: Any?): Glue.TestsNode? = (value as? DefaultMutableTreeNode)?.userObject as? Glue.TestsNode
    }
}

/**
 * A run of the nodes selected in the Tests tab (`TESTS_SELECTION`), as the service builds it (`piwi/testRuns`): each
 * node by the narrowest filter Playwright takes for it, the files saved first. With the filter on, the tests it shows.
 */
abstract class TestsNodesAction(icon: Icon, private val repeat: Int?, private val debug: Boolean) : AnAction(icon), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val selection = e.getData(TESTS_SELECTION)
        e.presentation.isVisible = selection != null
        e.presentation.isEnabled = selection != null && Glue.testsRunIds(selection.nodes, selection.filtered).isNotEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val selection = e.getData(TESTS_SELECTION) ?: return
        val ids = Glue.testsRunIds(selection.nodes, selection.filtered)
        if (ids.isNotEmpty()) PiwiCommands.runTestNodes(project, ids, repeat, debug)
    }
}

/** **Run with Piwi**: the selected nodes. */
class RunTestsNodesAction : TestsNodesAction(AllIcons.Actions.Execute, null, false)

/** **Debug with Piwi**: the selected nodes, headed, at the IDE's breakpoints, holding each failure. */
class DebugTestsNodesAction : TestsNodesAction(AllIcons.Actions.StartDebugger, null, true)

/** **Verify ×3 with Piwi**: the selected nodes, three times without retries. */
class VerifyTestsNodesAction : TestsNodesAction(AllIcons.Actions.Rerun, Glue.VERIFY_REPEAT, false)

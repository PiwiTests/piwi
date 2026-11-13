package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.openapi.util.IconLoader
import javax.swing.Icon

/**
 * The glyphs of a concept the plugin draws outside `plugin.xml`, one per concept as the VS Code extension's are: the
 * failed mark on every surface, Connect, Open in dashboard, a CI run, the stop's code actions in its popups (the same as
 * their registered actions') and the hand-offs from a failure. Each is a platform icon with a New UI glyph on 2024.1 and
 * on the latest release, or a glyph Piwi draws in `icons/` (a `_dark` copy beside it) where no platform icon says the
 * concept; the outcome marks Piwi draws (flaky, running) take the dashboard's outcome palette in both themes.
 */
object PiwiIcons {
    /** A failed test or run: the result icon, the status item, the tool window's nodes and a held failure. */
    val FAILED: Icon = AllIcons.RunConfigurations.TestError

    /**
     * A flaky test: the dashboard's shuffle on the outcome palette's flaky color (`STATUS_COLORS.flaky`), drawn by Piwi
     * as no platform icon says flaky; `status-mark-colors.test.ts` holds its colors.
     */
    val FLAKY: Icon = IconLoader.getIcon("/icons/testFlaky.svg", PiwiIcons::class.java)

    /**
     * A running test: a ring on the outcome palette's running color, as VS Code's mark, apart from the IDE's run
     * triangle that starts a test.
     */
    val RUNNING: Icon = IconLoader.getIcon("/icons/testRunning.svg", PiwiIcons::class.java)

    /** A failure cluster, as the dashboard and VS Code draw one: Lucide's `layers`. */
    val CLUSTER: Icon = IconLoader.getIcon("/icons/layers.svg", PiwiIcons::class.java)

    /**
     * The glyph of each icon key of the failures tree (`FailureTreeIcon` in the editor service's protocol), as VS Code's
     * `FAILURE_ICONS` draws the same nodes; `PiwiPluginTest` holds it to the protocol's keys.
     */
    val FAILURE_NODES: Map<String, Icon> = mapOf(
        "context" to AllIcons.Nodes.Module,
        "run" to AllIcons.RunConfigurations.TestState.Run,
        "history" to AllIcons.Vcs.History,
        "failed" to FAILED,
        "failing" to FAILED,
        "passed" to AllIcons.RunConfigurations.TestPassed,
        "fixed" to AllIcons.RunConfigurations.TestPassed,
        "edited" to AllIcons.Actions.Edit,
        "file" to AllIcons.FileTypes.Any_type,
        "cluster" to CLUSTER,
        "owner" to AllIcons.General.User,
        "flaky" to FLAKY,
    )

    /** A test's outcome as its line's result icon draws it, which the CI run tab draws too. */
    fun outcome(status: String?): Icon = when (status) {
        "failed" -> FAILED
        "flaky" -> FLAKY
        "passed" -> AllIcons.RunConfigurations.TestPassed
        "skipped" -> AllIcons.RunConfigurations.TestIgnored
        "running" -> RUNNING
        else -> AllIcons.RunConfigurations.TestNotRan
    }

    /** Connect, a plug as in Piwi Picker and the dashboard: the action and the status item's "Piwi: connect". */
    val CONNECT: Icon = piwi("connect")

    /** A run shared live, as `Piwi.ShareRunLive` draws it: the status item while one is, apart from Watch's eye. */
    val LIVE: Icon = piwi("live")

    /** Stop sharing a run live, as `Piwi.StopSharingRun` draws it. */
    val STOP_LIVE: Icon = piwi("stopLive")

    /** A CI run of the branch, in the CI Runs tab. */
    val CI_RUN: Icon = piwi("ciRun")

    /** Open in dashboard, on a file, a node or a failure. */
    val OPEN_IN_DASHBOARD: Icon = AllIcons.Ide.External_link_arrow

    val TRACE: Icon = AllIcons.FileTypes.Archive
    val SCREENSHOT: Icon = AllIcons.FileTypes.Image
    val REPRODUCE: Icon = AllIcons.Nodes.Desktop
    val BISECT: Icon = AllIcons.Vcs.Branch

    /** A stop's code actions, as `plugin.xml` draws `Piwi.PickAtStop` and the others. */
    fun stopAction(action: Glue.StopAction): Icon = when (action) {
        Glue.StopAction.PICK -> AllIcons.General.Locate
        Glue.StopAction.RECORD -> AllIcons.Ide.Macro.Recording_1
        Glue.StopAction.ASSERT -> AllIcons.General.InspectionsOK
        Glue.StopAction.ASSERT_REGION -> piwi("region")
        Glue.StopAction.MOCK -> piwi("mock")
    }

    private fun piwi(name: String): Icon = IconLoader.getIcon("/icons/$name.svg", PiwiIcons::class.java)
}

package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import javax.swing.Icon

/**
 * The glyphs of a concept the plugin draws outside `plugin.xml`, one per concept as the VS Code extension's are: the
 * failed mark on every surface, Open in dashboard, the stop's code actions in its popups (the same as their registered
 * actions') and the hand-offs from a failure. Each is a platform icon with a New UI glyph on 2024.1 and on the latest
 * release, but Record's, the recording icon Record here draws; a concept with none has no icon until Piwi draws its own.
 */
object PiwiIcons {
    /** A failed test or run: the result icon, the status item, the tool window's nodes and a held failure. */
    val FAILED: Icon = AllIcons.RunConfigurations.TestError

    /**
     * A flaky test: the dashboard's shuffle on the outcome palette's flaky color (`STATUS_COLORS.flaky`), drawn by Piwi
     * as no platform icon says flaky; `status-mark-colors.test.ts` holds its colors.
     */
    val FLAKY: Icon = com.intellij.openapi.util.IconLoader.getIcon("/icons/testFlaky.svg", PiwiIcons::class.java)

    /** Open in dashboard, on a file, a node or a failure. */
    val OPEN_IN_DASHBOARD: Icon = AllIcons.Ide.External_link_arrow

    val TRACE: Icon = AllIcons.FileTypes.Archive
    val SCREENSHOT: Icon = AllIcons.FileTypes.Image
    val REPRODUCE: Icon = AllIcons.Nodes.Desktop
    val BISECT: Icon = AllIcons.Vcs.Branch

    /** A stop's code actions, as `plugin.xml` draws `Piwi.PickAtStop` and the others; null where Piwi draws none yet. */
    fun stopAction(action: Glue.StopAction): Icon? = when (action) {
        Glue.StopAction.PICK -> AllIcons.General.Locate
        Glue.StopAction.RECORD -> AllIcons.Ide.Macro.Recording_1
        Glue.StopAction.ASSERT -> AllIcons.General.InspectionsOK
        Glue.StopAction.ASSERT_REGION, Glue.StopAction.MOCK -> null
    }
}

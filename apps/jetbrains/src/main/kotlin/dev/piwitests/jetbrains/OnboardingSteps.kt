package dev.piwitests.jetbrains

/**
 * The onboarding script, restating the editor service's `onboarding.json` in this editor's words (the caret for the
 * cursor, the project for the window), which `GlueTest` holds this copy to: the steps the Get Started tab plays, each
 * with its button's label and action, and the docs screenshot it shows, bundled under `onboarding/`.
 */
object OnboardingSteps {
    data class Step(val id: String, val title: String, val text: String, val label: String, val actionId: String, val image: String?)

    const val TITLE = "Get started with Piwi"

    const val DESCRIPTION = "Connect, then run, stop and record your tests."

    val STEPS: List<Step> = listOf(
        Step(
            id = "connect",
            title = "Connect to your Piwi instance",
            text = "Piwi reads your suite's runs from your team's instance, or from the desktop app on this machine. A workspace set up for the reporter is connected already, and recording needs no instance.",
            label = "Connect…",
            actionId = "Piwi.Connect",
            image = null,
        ),
        Step(
            id = "failures",
            title = "See the failures of the latest CI run",
            text = "The Piwi tool window lists the failures of the latest CI run on your branch, with your local runs since. Each one is also marked in the editor, at the line that failed.",
            label = "Open the failures",
            actionId = "Piwi.OpenFailures",
            image = "jetbrains-failures.png",
        ),
        Step(
            id = "run",
            title = "Run the failing tests",
            text = "Re-run every test still failing, or, in a spec, run the test at the caret with the key Settings → Keymap gives it under Piwi. When the run ends, the failures show what it fixed.",
            label = "Re-run the failing tests",
            actionId = "Piwi.RerunFailing",
            image = null,
        ),
        Step(
            id = "breakpoint",
            title = "Stop at a breakpoint, and write code there",
            text = "Set a breakpoint on a line of a test or a page object, then debug the test at the caret: the run stops before that line's action, its page shows beside the editor, and picking a locator, recording or asserting writes the code at the stop.",
            label = "Debug the test at the caret",
            actionId = "Piwi.DebugTestAtCursor",
            image = null,
        ),
        Step(
            id = "record",
            title = "Record a test",
            text = "Piwi opens a browser with your project's Playwright and writes what you do there into a new spec. In a spec, Record here… records at the caret, from the editor's menu or Alt+Enter. No instance needed.",
            label = "Record a new test file…",
            actionId = "Piwi.RecordNewFile",
            image = null,
        ),
        Step(
            id = "pair",
            title = "Pair Piwi Picker",
            text = "Piwi Picker, the browser extension, sends a locator you pick on any page to the caret, and follows the runs this project starts. Click Pair under Editor in its settings, then allow the request here.",
            label = "Pair with Piwi Picker",
            actionId = "Piwi.PairPicker",
            image = null,
        ),
        Step(
            id = "mcp",
            title = "Give your agent Piwi's MCP server",
            text = "Your agent can read the suite's failures, flaky tests and healings: copy the server's configuration into its MCP settings, never into a file of the repository.",
            label = "Copy the MCP server configuration",
            actionId = "Piwi.CopyMcpConfiguration",
            image = null,
        ),
        Step(
            id = "settings",
            title = "Open the settings",
            text = "Choose the lines Piwi writes above the code, how a failure shows at its line, when a run says what it changed, and whether runs pause at your breakpoints.",
            label = "Open settings",
            actionId = "Piwi.OpenSettings",
            image = null,
        ),
    )
}

package dev.piwitests.jetbrains

/**
 * The settings registry's words, restating the editor service's `settings.json`, which `GlueTest` holds this copy to:
 * the groups of the settings page, by their id, and the labels of each option's choices, by its field in
 * `PiwiLocalSettings`.
 */
object SettingsWords {
    val GROUPS: Map<String, String> = linkedMapOf(
        "connection" to "Connection",
        "runs" to "Runs",
        "editor" to "In the editor",
        "agents" to "Agents (MCP)",
        "advanced" to "Advanced",
    )

    val CHOICES: Map<String, Map<String, String>> = linkedMapOf(
        "runNotifications" to linkedMapOf("always" to "Say what it changed", "failures" to "Say what it changed when something fails", "never" to "Say nothing"),
        "runNotificationsScope" to linkedMapOf("mine" to "The runs started here", "mineAndCi" to "The runs started here and the branch's CI runs"),
        "statusBarAlert" to linkedMapOf("new" to "For a new failure a run started here caused", "any" to "For any failing test", "never" to "Never"),
        "runHoldFailures" to linkedMapOf("auto" to "Auto", "on" to "On", "off" to "Off"),
        "codeLens" to linkedMapOf("all" to "Every line", "problems" to "A failure's and an uncovered change's alone", "off" to "None"),
        "failureSeverity" to linkedMapOf("error" to "An error", "warning" to "A warning", "information" to "A weak warning", "off" to "Nothing in the editor's problems"),
        "mcpAuthorization" to linkedMapOf("key" to "The IDE's API key", "sign-in" to "A sign-in in the browser"),
    )

    /** The docs' Editor settings page, which lists every option of both editors by group. */
    const val DOCS_URL = "https://piwitests.dev/reference/editor-settings"

    /**
     * The address of a group's section on the Editor settings page: its heading's anchor as the docs site writes it, as
     * the editor service's `settingsDocsUrl` gives it to VS Code.
     */
    fun docsUrl(group: String): String =
        DOCS_URL + "#" + (GROUPS[group] ?: group).lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')

    /** The label of `value`, a choice of the option `field`; the value itself when the registry names none. */
    fun choice(field: String, value: String?): String = value?.let { CHOICES[field]?.get(it) ?: it } ?: ""
}

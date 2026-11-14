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
        "runHoldFailures" to linkedMapOf("auto" to "Auto", "on" to "On", "off" to "Off"),
        "codeLens" to linkedMapOf("all" to "Every line", "problems" to "A failure's and an uncovered change's alone", "off" to "None"),
        "failureSeverity" to linkedMapOf("error" to "An error", "warning" to "A warning", "information" to "A weak warning", "off" to "Nothing in the editor's problems"),
        "statusBarAlert" to linkedMapOf("new" to "For a new failure a run started here caused", "any" to "For any failing test", "never" to "Never"),
        "mcpAuthorization" to linkedMapOf("key" to "The IDE's API key", "sign-in" to "A sign-in in the browser"),
    )

    /** The label of `value`, a choice of the option `field`; the value itself when the registry names none. */
    fun choice(field: String, value: String?): String = value?.let { CHOICES[field]?.get(it) ?: it } ?: ""
}

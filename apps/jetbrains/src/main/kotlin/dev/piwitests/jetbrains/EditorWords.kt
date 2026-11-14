package dev.piwitests.jetbrains

/**
 * The words both editors write themselves, restating the editor service's `words.json`, which the VS Code extension
 * reads and `GlueTest` holds this copy to: a stop's controls and code actions with their short labels, a recording's
 * states, controls and edited block's message, a worker's and a CI lane's name, and Hold failures' choices and a run's
 * state. `{cursor}` is the caret here.
 */
object EditorWords {
    val WORDS: Map<String, String> = linkedMapOf(
        "stop.resume" to "Resume",
        "stop.step" to "Step",
        "stop.run-to" to "Run to the {cursor}",
        "stop.finish" to "Finish",
        "stop.end" to "End the test",
        "stop.write-code" to "Write code…",
        "action.pick" to "Pick a locator",
        "action.pick.short" to "Pick",
        "action.record" to "Record",
        "action.record.short" to "Record",
        "action.assert" to "Assert",
        "action.assert.short" to "Assert",
        "action.assert-region" to "Assert a region",
        "action.assert-region.short" to "Assert region",
        "action.mock" to "Mock a request",
        "action.mock.short" to "Mock",
        "recording.status.starting" to "Piwi: opening the browser",
        "recording.status.recording" to "Piwi: recording · {steps}",
        "recording.status.paused" to "Piwi: recording paused · {steps}",
        "recording.status.stopping" to "Piwi: stopping the recording",
        "recording.block.starting" to "Opening the browser",
        "recording.block.recording" to "Recording · {steps}",
        "recording.block.paused" to "Paused · {steps}",
        "recording.block.edited" to "Paused while you edit · {steps}",
        "recording.stop" to "Stop",
        "recording.pause" to "Pause",
        "recording.resume" to "Resume",
        "recording.keep-edits" to "Keep my edits",
        "recording.edited" to "Piwi: you edited the recorded block, so the recording is paused. Resume writes the block again from the recorded steps; Keep my edits stops the recording and keeps the code as it is.",
        "worker" to "Worker {n}",
        "worker.title" to "Piwi: worker {n}",
        "ci-lane" to "worker {lane}",
        "ci-lane.shard" to "shard {shard}, worker {lane}",
        "hold.auto" to "Piwi decides: on with a breakpoint it can stop at or a page.pause(), off otherwise",
        "hold.auto.short" to "Auto",
        "hold.on" to "On from each run's start: a failed test waits at its line for an answer",
        "hold.on.short" to "On",
        "hold.off" to "Off from each run's start: a failed test fails as it would without Piwi",
        "hold.off.short" to "Off",
        "hold.run.on" to "Hold failures on: a failed test waits at its line{by}",
        "hold.run.off" to "Hold failures off{by}",
        "hold.run.by-agent" to ", as an agent set it",
    )

    /** The words of `key`, each `{name}` replaced by its value in `values`; `{cursor}` is the caret. */
    fun words(key: String, vararg values: Pair<String, Any>): String {
        val filled = mapOf("cursor" to "caret") + values.associate { (name, value) -> name to value.toString() }
        return WORDS.getValue(key).replace(Regex("\\{(\\w+)\\}")) { filled[it.groupValues[1]] ?: it.value }
    }
}

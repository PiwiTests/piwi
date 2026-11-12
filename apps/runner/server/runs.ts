/**
 * What the hub of the runs Piwi Runner's shell starts says of Runner (`ShellRuns` of `@piwitests/editor`): the runs a
 * team instance requested, watched and steered in Runner's window. Runner has no editor and no agent tools, and names no
 * other hub of this machine.
 */
import type { ShellRunsWords } from '@piwitests/editor/shell-runs';

/** What the run channel's socket folder is named from, in the temporary directory: Runner's alone. */
export const RUNNER_RUN_CHANNEL_PREFIX = 'piwi-runner-run-';

export const RUNNER_RUNS_WORDS: ShellRunsWords = {
  host: 'Piwi Runner',
  surfaces: "Piwi Runner's window",
  client: 'Piwi Runner',
  presence: { kind: 'desktop', name: 'Piwi Runner' },
  declined: {
    pick:
      "Pick a locator in the test's window sends the locator to an editor, and Piwi Runner has none: pick on the " +
      'image of the stop instead, which answers with the locator.',
    record:
      'Record here records into an editor, and Piwi Runner has none: run the test from VS Code or a JetBrains IDE ' +
      'to record from its stop.',
    assert:
      "Assert makes its check with an editor's recorder, and Piwi Runner has none: assert a region instead, or run " +
      'the test from VS Code or a JetBrains IDE.',
  },
  picked: (locator) => `${locator}: copy it in Piwi Runner's window.`,
  codeSent: (what, at) => `Piwi made ${what} to write ${at}: copy it in Piwi Runner's window.`,
  outside: (file) =>
    `${file} is not in a folder linked to a project: Piwi makes code for the linked folders' files alone.`,
  noWindowToStop: "Piwi Runner's window is closed: open it from the tray to stop the run.",
  stopping: 'Piwi Runner stops the run.',
  closing: 'Piwi Runner stopped.',
  log: '[runner-runs]',
};

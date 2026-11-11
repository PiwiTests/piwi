/**
 * The words of the run model. Each key the model's functions return or use is a key of Piwi Picker's catalogs
 * (`apps/extension/public/_locales/<code>/messages.json`), and a surface says it through its own `RunSpeaker`: the
 * Runs window through its catalogs, in the interface language, and an English surface through `englishRunSpeaker`.
 * `RUN_WORDS_EN` holds the English catalog's message of each key, with its `$name$` placeholders; the extension's
 * `run-words.test.ts` holds it to the catalogs.
 */
export const RUN_WORDS_EN = {
  // Who is present on a run, a worker's page and a stop.
  runs_presencePicker: 'Piwi Picker',
  runs_presenceDesktop: 'the desktop app',
  runs_presenceAgent: 'an agent',
  runs_presenceOpen: 'Also open in $tools$',
  runs_presenceAgentFollows: 'An agent follows this run',
  runs_watcherYou: 'you',
  runs_watchedBy: 'Watched by $who$',
  runs_driverYou: 'You drive this stop',
  runs_driverAgent: 'An agent drives this stop',
  runs_driverDesktop: 'The desktop app drives this stop',
  runs_driverTool: '$tool$ drives this stop',
  // Where a worker stands.
  runs_failedAt: 'Failed at $place$',
  runs_stateFailed: 'Failed, held at its line',
  runs_stoppedBreakpoint: 'Stopped at a breakpoint',
  runs_stoppedStep: 'Stopped after a step',
  runs_stoppedPause: 'Paused',
  runs_stoppedRunTo: 'Stopped at the line it ran to',
  runs_stoppedPagePause: 'Stopped at page.pause()',
  runs_stoppedOther: 'Stopped',
  runs_stoppedByAgent: 'Paused by the agent',
  runs_stoppedByAgentStep: 'Stopped after the agent’s step',
  runs_stoppedByAgentRunTo: 'Stopped at the line the agent ran it to',
  runs_statePausingIn: 'Pausing: waits in $call$',
  runs_statePausing: 'Pausing…',
  runs_stateRunning: 'Running',
  runs_stateBetween: 'Between tests',
  // The controls: each one's label, then its title.
  runs_resume: 'Resume',
  runs_resumeTitle: 'Run on to the next breakpoint',
  runs_resumeFailureTitle: 'Let the test end as it failed',
  runs_step: 'Step',
  runs_stepTitle: 'Run this call, and stop before the next one',
  runs_finish: 'Finish',
  runs_finishTitle: 'Run the test on without stopping at a breakpoint again in this attempt',
  runs_end: 'End the test',
  runs_endTitle: 'End the test here: the rest of it is skipped',
  runs_giveUpTitle:
    'End the test now: the call it waits in is given up where it can be, and the rest of the test is skipped',
  runs_front: 'Show the browser',
  runs_frontTitle: 'Bring the test’s browser window to the front',
  runs_pick: 'Pick',
  runs_pickTitle: 'Pick a locator in the test’s window: it replaces the one on this line',
  runs_record: 'Record',
  runs_recordTitle: 'Record steps in the test’s window: they go to the editor, which writes them above this line',
  runs_assert: 'Assert',
  runs_assertTitle:
    'Check an element in the test’s window: the check goes to the editor, which writes it above this line',
  runs_assertRegion: 'Assert a region',
  runs_assertRegionTitle:
    'Pick a region in the test’s window: its ARIA snapshot goes to the editor, which writes it above this line',
  runs_mock: 'Mock a request',
  runs_mockTitle:
    'Choose a request the page made: a page.route() answering it as the server did goes to the editor, which writes it above this line',
  runs_pause: 'Pause',
  runs_pauseTitle: 'Stop the test before its next call',
} as const;

/** A key of the catalogs that the run model's functions return or use. */
export type RunWordKey = keyof typeof RUN_WORDS_EN;

/** The values of a message's placeholders, by name. */
export type RunWordArgs = Readonly<Record<string, string>>;

/** A message a function of the run model returns: its key, and its placeholders' values. */
export interface RunMessage {
  key: RunWordKey;
  args?: RunWordArgs;
}

/** How a surface says the run model's words: a message by its key, and names listed in a sentence. */
export interface RunSpeaker {
  say(key: RunWordKey, args?: RunWordArgs): string;
  /** `A`, `A and B`, `A, B, and C`, as the surface's language lists names. */
  list(items: readonly string[]): string;
}

const englishList = new Intl.ListFormat('en', { type: 'conjunction' });

/** The words in English, from `RUN_WORDS_EN`: each `$name$` takes the value of `name`, and an absent one is empty. */
export const englishRunSpeaker: RunSpeaker = {
  say(key, args = {}) {
    const values = new Map(Object.entries(args).map(([name, value]) => [name.toLowerCase(), value]));
    return RUN_WORDS_EN[key].replace(
      /\$([A-Za-z0-9_@]+)\$/g,
      (_whole, name: string) => values.get(name.toLowerCase()) ?? '',
    );
  },
  list: (items) => englishList.format(items),
};

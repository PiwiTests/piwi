/**
 * The words of the run model: those its functions return or use, and the words of the interface the surfaces share
 * (a stop's card, its page, its controls). Each key is a key of Piwi Picker's catalogs
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
  runs_openTrace: 'Open the trace so far',
  runs_openTraceTitle: 'Open this test’s trace up to now in Playwright’s trace viewer, on the machine the run runs on',
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
  // A run of several workers: its own controls, and a tab for each worker.
  runs_runControls: 'Run controls',
  runs_pauseAll: 'Pause all',
  runs_pauseAllTitle: 'Pause every worker of this run before its next call',
  runs_resumeAll: 'Resume all',
  runs_resumeAllTitle: 'Let every stopped test of this run go on',
  runs_workerTabs: 'Workers',
  runs_worker: 'worker $number$',
  // A worker: its test, where it stands, and the code a stop can write.
  runs_attempt: 'attempt $attempt$',
  runs_nextLabel: 'Next',
  runs_whereLabel: 'At',
  runs_waitedFor: 'for $time$',
  runs_codeLabel: 'Code',
  runs_codeActions: 'Code from this stop',
  runs_codeWarnings: 'What to review in this code',
  runs_requestsTitle: 'Choose the request to mock',
  runs_requestsClose: 'Close the list',
  runs_requestsFilter: 'Filter by address, method or status',
  runs_requestsNone: 'The test kept no response yet: Piwi keeps the text answers of its fetch and XHR requests.',
  runs_requestsNoMatch: 'No request matches the filter.',
  runs_requestNoSize: 'size unknown',
  runs_requestAt: 'at $time$',
  runs_run: 'Run',
  runs_announceStopped: '$test$ stopped at $place$.',
  runs_announceFailed: '$test$ failed at $place$.',
  // The test's page: its card, its tools, its image and its live view.
  runs_pageCaption: 'The test’s page',
  runs_watch: 'Watch',
  runs_watchTitle:
    'Show the test’s page as it runs, through its stops and its next tests: at a stop, Interact sends your clicks and keys to it',
  runs_watchOutdated: 'Update the reporter to watch a running test',
  runs_watchToUse: 'Watch to use',
  runs_interact: 'Interact',
  runs_interactTitle: 'Send your clicks, scrolling and keys to the test’s page, driving this stop: Esc gives it back',
  runs_pickAt: 'Pick on the image',
  runs_liveBadge: 'Live',
  runs_laneRunning: 'Running…',
  runs_liveAlt: 'Live view of the test’s page',
  runs_liveAltInput: 'Live view of the test’s page: keys and clicks go to the page',
  runs_laneAltLast: 'The test’s page, as last seen',
  runs_imageAlt: 'The test’s page, stopped before: $call$',
  runs_imageAltFailure: 'The test’s page where it failed: $error$',
  runs_imageNone: 'No image of the page.',
  runs_imageLoading: 'Taking an image of the page…',
  runs_liveStarting: 'Starting the live view…',
  runs_liveHint:
    'Your clicks, the wheel and your keys on the view go to the test’s page. Esc turns Interact off and gives the stop back, but goes to the page while a pick or a check runs there; Shift+click picks a locator.',
  // A watched lane's layers under its page: why its call waits, its page's events, its text and its filmstrip.
  runs_layerCalls: 'Why it waits',
  runs_callNone: 'No call yet: the call the test runs shows here, with what Playwright waits for.',
  runs_callRunning: 'Running for $time$',
  runs_callPassed: 'Done in $time$',
  runs_callFailed: 'Failed after $time$',
  runs_targetNone: 'No element matches its locator yet',
  runs_targetMatches_one: '$count$ element matches its locator',
  runs_targetMatches_other: '$count$ elements match its locator',
  runs_targetDisabled: 'Its element is not enabled',
  runs_layerEvents: 'Events',
  runs_eventsNone: 'Nothing yet: console errors, failed or slow requests and the backend’s errors show here.',
  runs_eventConsole: 'Console error',
  runs_eventPageError: 'Uncaught error',
  runs_eventFailed: 'Failed request',
  runs_eventPending: 'Pending request',
  runs_eventSlow: 'Slow request',
  runs_eventBackendError: 'Backend error',
  runs_eventBackendWarning: 'Backend warning',
  runs_eventApi: 'API call',
  runs_eventDropped_one: '$count$ more event left out',
  runs_eventDropped_other: '$count$ more events left out',
  runs_requestAnswered: '$request$ answered $status$',
  runs_requestAnsweredIn: '$request$ answered $status$ in $time$',
  runs_requestAnsweredAfter: '$request$ answered after $time$',
  runs_requestPending: '$request$ pending for $time$',
  runs_requestFailed: '$request$ failed: $failure$',
  runs_requestUnanswered: '$request$ got no answer',
  runs_requestLogged: '$request$: $text$',
  runs_layerText: 'Text',
  runs_textShow: 'Show the page’s text',
  runs_textShowTitle:
    'Show the page as roles and names, its secret fields hidden: taken now, then followed as the test’s trace writes it',
  runs_textAgain: 'Take it again',
  runs_textHide: 'Hide the text',
  runs_textWaiting: 'Reading the page…',
  runs_textTrace: 'From the test’s trace',
  runs_textSnapshot: 'Taken as you asked',
  runs_textCut: 'Cut short: the page’s text is longer',
  runs_textLabel: 'The page’s text, its secret fields hidden',
  runs_layerFilmstrip: 'Filmstrip',
  runs_filmstripNone: 'Each call’s page shows here once the call ends.',
  runs_filmstripAlt: 'The page after $call$',
  runs_filmstripClose: 'Close',
  // How a run came out, beyond its status: one key per plural form, said through `RunSpeaker.count`.
  runs_progressEndedAtStop_one: '$count$ ended at a stop',
  runs_progressEndedAtStop_other: '$count$ ended at a stop',
  // The CI runs of a project in progress, listed read-only.
  runs_ciHeading: 'CI runs in progress',
  runs_ciRun: 'CI run #$id$',
  runs_ciWhere: 'on $branch$',
  runs_ciWhereProject: '$project$, on $branch$',
  runs_ciProject: '$project$',
  runs_ciReadOnly:
    'Read-only: these run on CI, so nothing here pauses or steers them. Watch shows a running test’s page here.',
  // Who drives a stop, taken or given back.
  runs_takeControl: 'Take control',
  runs_takeControlTitle: 'Drive this stop yourself: an agent’s actions here wait until you give it back',
  runs_giveBack: 'Give back',
  runs_giveBackTitle: 'Give this stop back: an agent may act on it again',
} as const;

/** A key of the catalogs that the run model's functions return or use, or a word of the interface the surfaces share. */
export type RunWordKey = keyof typeof RUN_WORDS_EN;

/** A key without its plural form, of a key that has one. */
type CountBase<K> = K extends `${infer Base}_other` ? Base : never;

/** A message that counts (`$count$`): its key without the plural form, whose `_one` and `_other` are run words. */
export type RunCountKey = CountBase<RunWordKey>;

/** The values of a message's placeholders, by name. */
export type RunWordArgs = Readonly<Record<string, string>>;

/** A message a function of the run model returns: its key, and its placeholders' values. */
export interface RunMessage {
  key: RunWordKey;
  args?: RunWordArgs;
}

/** How a surface says the run model's words: a message by its key, a message that counts, and names listed in a sentence. */
export interface RunSpeaker {
  say(key: RunWordKey, args?: RunWordArgs): string;
  /** The message of `key` in the plural form the surface's language gives `count`, its `$count$` the number formatted. */
  count(key: RunCountKey, count: number): string;
  /** `A`, `A and B`, `A, B, and C`, as the surface's language lists names. */
  list(items: readonly string[]): string;
}

const englishList = new Intl.ListFormat('en', { type: 'conjunction' });
const englishPlural = new Intl.PluralRules('en');
const englishNumber = new Intl.NumberFormat('en');

/** The words in English, from `RUN_WORDS_EN`: each `$name$` takes the value of `name`, and an absent one is empty. */
export const englishRunSpeaker: RunSpeaker = {
  say(key, args = {}) {
    const values = new Map(Object.entries(args).map(([name, value]) => [name.toLowerCase(), value]));
    return RUN_WORDS_EN[key].replace(
      /\$([A-Za-z0-9_@]+)\$/g,
      (_whole, name: string) => values.get(name.toLowerCase()) ?? '',
    );
  },
  count(key, count) {
    const form = englishPlural.select(count) === 'one' ? 'one' : 'other';
    return englishRunSpeaker.say(`${key}_${form}` as RunWordKey, { count: englishNumber.format(count) });
  },
  list: (items) => englishList.format(items),
};

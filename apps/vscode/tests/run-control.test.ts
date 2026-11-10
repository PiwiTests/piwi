import { describe, expect, test, vi } from 'vitest';
import type {
  LocatorAtCaretResult,
  RunPresence,
  RunSession,
  RunStop,
  RunTake,
  RunTest,
  RunWorker,
  StopCode,
} from '@piwitests/editor/protocol';
import {
  CARET_REFUSAL_MS,
  CARET_WAIT_MS,
  CaretCounts,
  EditLog,
  MAX_IMAGE_DATA,
  RESERVED_MS,
  RESUMED_KEY_MS,
  StopsShown,
  actsOnPage,
  asideColumn,
  breakpointUpdates,
  canEnd,
  canShare,
  caretText,
  controlItems,
  controlState,
  heardSession,
  imageClickOf,
  lineEditOf,
  linesAbove,
  liveInstance,
  liveItem,
  progressItem,
  holdTarget,
  holdText,
  runLabel,
  runName,
  runPageTarget,
  frameIsCurrent,
  waitedFor,
  waitingWorkers,
  endChoice,
  laneShown,
  watchTargetsFor,
  watchableWorkers,
  liveTarget,
  liveText,
  PICK_HINT,
  RUN_COMMANDS,
  pagePoint,
  pausedPageHtml,
  pausedPageViewChange,
  picksOnImage,
  pausedText,
  presenceText,
  driverText,
  watchersText,
  stopCaption,
  stopPresence,
  remember,
  requestPicks,
  runStarted,
  runTargetArg,
  shareLiveWarning,
  sharedText,
  sizeText,
  spelledSession,
  stopActions,
  stopCodeNotice,
  stopControls,
  stopIcon,
  stopKey,
  stopPick,
  stopsFor,
  stopsOf,
  targetStop,
  timeText,
  withSession,
  writtenLines,
  type CaretQuery,
  type CaretShown,
  type RunBreakpoint,
  type RunBreakpoints,
  type ShownStop,
  type TextChange,
} from '../src/run-control';

const spec = 'file:///work/shop/tests/checkout.spec.ts';
const pageObject = 'file:///work/shop/tests/pages/checkout.page.ts';

const runTest = (retry = 0, cannotPause: string | null = null): RunTest => ({
  id: 't1',
  title: ['checkout', 'pays'],
  uri: spec,
  line: 2,
  project: 'chromium',
  retry,
  cannotPause,
});

const stopAt = (uri: string, line: number, bar = true): RunStop => ({
  reason: 'breakpoint',
  title: 'Fill "WELCOME10" getByLabel(\'Coupon\')',
  uri,
  line,
  character: 4,
  locator: "getByLabel('Coupon')",
  bar,
  since: `2026-10-25T10:00:0${line}.000Z`,
});

const worker = (index: number, state: RunWorker['state'], extra: Partial<RunWorker> = {}): RunWorker => ({
  worker: index,
  parallelIndex: index,
  state,
  test: state === 'between' ? null : runTest(),
  stop: null,
  pausing: false,
  waiting: null,
  takes: [],
  watchable: false,
  ...extra,
});

const session = (ref: string, workers: RunWorker[], ended = false): RunSession => ({
  ref,
  root: '/work/shop',
  workers,
  ended,
});

const sessionsOf = (...list: RunSession[]) => list.reduce((map, s) => withSession(map, s), new Map());

describe('the sessions kept', () => {
  test('are the latest of each run, one that ended dropped', () => {
    const first = session('ed-1', [worker(0, 'running')]);
    const stopped = session('ed-1', [worker(0, 'stopped', { stop: stopAt(spec, 5) })]);
    const other = session('ed-2', [worker(0, 'between')]);
    let kept = sessionsOf(first, other, stopped);
    expect([...kept.keys()]).toEqual(['ed-1', 'ed-2']);
    expect(kept.get('ed-1')).toBe(stopped);
    kept = withSession(kept, session('ed-1', [], true));
    expect([...kept.keys()]).toEqual(['ed-2']);
  });

  test('map a rerun’s lines from when it is first heard, the run of its ref having ended, its edits left behind', () => {
    const log = new EditLog();
    const runs = new Map<string, RunBreakpoints>();
    // A run started here, under its ref: its lines map from its start.
    remember(runs, 'ed-1', runStarted(log.now(), null));
    let kept: Map<string, RunSession> = new Map();
    ({ sessions: kept } = heardSession(kept, runs, session('ed-1', [worker(0, 'running')]), log.now()));
    ({ sessions: kept } = heardSession(kept, runs, session('ed-1', [], true), log.now()));
    expect(runs.has('ed-1')).toBe(false);
    // Three lines written above the stopped line between the runs, and saved: the rerun runs them.
    log.add(spec, lineEditOf(change([1, 0], [1, 0], '  // one\n  // two\n  // three\n'))!);
    const rerun = heardSession(
      kept,
      runs,
      session('ed-1', [worker(0, 'stopped', { stop: stopAt(spec, 7) })]),
      log.now(),
    );
    expect(rerun.fresh).toBe(true);
    expect(log.forward(spec, 7, runs.get('ed-1')!.since)).toBe(7);
    // The same run heard again keeps where it maps from.
    log.add(spec, lineEditOf(change([1, 0], [1, 0], '  // four\n'))!);
    expect(heardSession(rerun.sessions, runs, session('ed-1', [worker(0, 'running')]), log.now()).fresh).toBe(false);
    expect(log.forward(spec, 7, runs.get('ed-1')!.since)).toBe(8);
  });

  test('name their files as the editor spells them', () => {
    const spelled = spelledSession(
      session('ed-1', [worker(0, 'stopped', { stop: stopAt('file:///C:/shop/a.spec.ts', 1) })]),
      (uri) => uri.replace('file:///C:', 'file:///c%3A'),
    );
    expect(spelled.workers[0]!.stop!.uri).toBe('file:///c%3A/shop/a.spec.ts');
    expect(spelled.workers[0]!.test!.uri).toBe(spec);
  });
});

describe('what the controls offer', () => {
  test('nothing without a run', () => {
    expect(controlState(new Map())).toEqual({
      active: false,
      stoppable: false,
      pausable: false,
      pausing: false,
      stopped: false,
      endable: false,
      actions: [],
      shareable: false,
      liveShared: false,
      holdable: false,
      watchable: false,
      waiting: null,
    });
    expect(controlItems(controlState(new Map()))).toEqual([]);
    expect(liveItem(new Map())).toBeNull();
  });

  test('sharing with Playwright tools at a stop whose reporter takes it alone', () => {
    const at = (takes: RunTake[]) =>
      sessionsOf(session('ed-1', [worker(0, 'stopped', { stop: stopAt(spec, 5), takes })]));
    expect(controlState(at(['bind'])).shareable).toBe(true);
    expect(controlState(at(['pick'])).shareable).toBe(false);
    expect(canShare(stopsOf(at(['bind']))[0]!)).toBe(true);
    expect(
      sharedText({
        ok: true,
        message: 'Shared.',
        name: 'piwi-ed-1-w0',
        command: 'npx playwright cli attach piwi-ed-1-w0',
      }),
    ).toBe('Shared. Join it with: npx playwright cli attach piwi-ed-1-w0');
    expect(sharedText({ ok: false, message: 'The test went on.', name: null, command: null })).toBe(
      'The test went on.',
    );
  });

  test('Pause and Stop while a test runs or a worker is between tests', () => {
    for (const state of ['running', 'between'] as const) {
      const shown = controlState(sessionsOf(session('ed-1', [worker(0, state)])));
      expect(shown).toEqual({
        active: true,
        stoppable: true,
        pausable: true,
        pausing: false,
        stopped: false,
        endable: false,
        actions: [],
        shareable: false,
        liveShared: false,
        holdable: false,
        watchable: false,
        waiting: null,
      });
      expect(controlItems(shown).map((i) => i.command)).toEqual(['piwi.pauseRun', 'piwi.stopRun']);
    }
  });

  test('Pausing… once a Pause reached the worker, and Stop alone while its test cannot stop', () => {
    const pausing = controlState(sessionsOf(session('ed-1', [worker(0, 'running', { pausing: true })])));
    expect(pausing).toEqual({
      active: true,
      stoppable: true,
      pausable: false,
      pausing: true,
      stopped: false,
      endable: false,
      actions: [],
      shareable: false,
      liveShared: false,
      holdable: false,
      watchable: false,
      waiting: null,
    });
    expect(controlItems(pausing).map((i) => [i.text, i.command])).toEqual([
      ['$(loading~spin) Pausing…', null],
      ['$(debug-stop)', 'piwi.stopRun'],
    ]);
    // While it waits in a call it can end at: how long it has waited, and End the test.
    const waiting = {
      title: "Click getByRole('button', { name: 'Pay' })",
      uri: spec,
      line: 4,
      since: '2026-10-25T10:00:00.000Z',
      endable: true,
    };
    const waits = controlState(sessionsOf(session('ed-1', [worker(0, 'running', { pausing: true, waiting })])));
    expect(waits.waiting).toEqual({ ref: 'ed-1', worker: 0, slot: 0, waiting });
    expect(controlItems(waits, Date.parse('2026-10-25T10:01:05.000Z'))).toEqual([
      {
        text: '$(loading~spin) Pausing… 1 min 5 s',
        tooltip:
          "Piwi: the test waits in Click getByRole('button', { name: 'Pay' }) for 1 min 5 s, and stops once it returns",
        command: null,
      },
      {
        key: 'give-up',
        text: '$(circle-slash)',
        tooltip:
          "Piwi: End the test now: Click getByRole('button', { name: 'Pay' }) is given up, and the rest of the test skipped",
        command: 'piwi.endTest',
      },
      { text: '$(debug-stop)', tooltip: 'Piwi: Stop the run (Shift+F5)', command: 'piwi.stopRun' },
    ]);
    const unknown = controlState(
      sessionsOf(
        session('ed-1', [
          worker(0, 'running', { pausing: true, waiting: { ...waiting, since: null, endable: false } }),
        ]),
      ),
    );
    expect(controlItems(unknown).map((i) => i.tooltip)).toEqual([
      "Piwi: the test waits in Click getByRole('button', { name: 'Pay' }), and stops once it returns",
      "Piwi: End the test as Click getByRole('button', { name: 'Pay' }) returns: the rest of it is skipped",
      'Piwi: Stop the run (Shift+F5)',
    ]);
    // Beside Pause for another worker, and in place of End at a stop that cannot end.
    const keys = (sessions: ReturnType<typeof sessionsOf>) =>
      controlItems(controlState(sessions)).map((i) => i.key ?? i.command);
    expect(
      keys(sessionsOf(session('ed-1', [worker(0, 'running', { pausing: true, waiting }), worker(1, 'running')]))),
    ).toEqual(['piwi.pauseRun', null, 'give-up', 'piwi.stopRun']);
    const failed = worker(1, 'stopped', { stop: { ...stopAt(spec, 5), reason: 'failure' } });
    expect(keys(sessionsOf(session('ed-1', [worker(0, 'running', { pausing: true, waiting }), failed])))).toContain(
      'give-up',
    );
    const waitingSessions = sessionsOf(session('ed-1', [worker(0, 'running', { pausing: true, waiting })]));
    expect(waitingWorkers(waitingSessions, { ref: 'ed-1', worker: 0 })).toHaveLength(1);
    // A worker Playwright started again in its slot is named by the slot, as the worker views name it.
    const restarted = sessionsOf(session('ed-1', [worker(2, 'running', { pausing: true, waiting, parallelIndex: 0 })]));
    expect(waitingWorkers(restarted)).toEqual([{ ref: 'ed-1', worker: 2, slot: 0, waiting }]);
    expect(waitingWorkers(waitingSessions, { ref: 'ed-2' })).toEqual([]);
    // End the test answers a stop a lens or a hover names, even one that went on, and never a waiting test then.
    expect(endChoice(waitingSessions, false, { ref: 'ed-1', worker: 1, since: 's1' })).toBe('stop');
    expect(endChoice(waitingSessions, true, null)).toBe('stop');
    expect(endChoice(waitingSessions, false, null)).toEqual([{ ref: 'ed-1', worker: 0, slot: 0, waiting }]);
    expect(endChoice(waitingSessions, false, { ref: 'ed-1', worker: 1 })).toEqual([]);
    expect(waitedFor(null, 0)).toBeNull();
    expect(waitedFor('2026-10-25T10:00:00.000Z', Date.parse('2026-10-25T10:00:12.900Z'))).toBe('12 s');
    expect(laneShown(session('ed-1', [worker(0, 'running', { pausing: true, waiting })]), 0, []).caption).toBe(
      "Worker 1 · Pausing · waits in Click getByRole('button', { name: 'Pay' }) · checkout › pays",
    );
    const ci = controlState(
      sessionsOf(session('ed-1', [worker(0, 'running', { test: runTest(0, 'running under CI') })])),
    );
    expect(ci.pausable).toBe(false);
    expect(controlItems(ci).map((i) => i.command)).toEqual(['piwi.stopRun']);
  });

  test('Resume, Step, Finish and Stop while a worker is stopped, with their keys', () => {
    const shown = controlState(
      sessionsOf(session('ed-1', [worker(0, 'stopped', { stop: stopAt(spec, 5) }), worker(1, 'running')])),
    );
    expect(shown).toEqual({
      active: true,
      stoppable: true,
      pausable: true,
      pausing: false,
      stopped: true,
      endable: false,
      actions: [],
      shareable: false,
      liveShared: false,
      holdable: false,
      watchable: false,
      waiting: null,
    });
    expect(controlItems(shown).map((i) => [i.command, i.tooltip])).toEqual([
      ['piwi.resumeRun', 'Piwi: Resume (F5)'],
      ['piwi.stepRun', 'Piwi: Step to the next call (F10)'],
      ['piwi.finishRun', 'Piwi: Finish the test without stopping at a breakpoint again (Shift+F11)'],
      ['piwi.stopRun', 'Piwi: Stop the run (Shift+F5)'],
    ]);
  });

  test('End the test at a stop whose reporter takes it, never at a failure, with no key', () => {
    const at = (stop: RunStop, takes: RunTake[] = ['end']) =>
      sessionsOf(session('ed-1', [worker(0, 'stopped', { stop, takes })]));
    const ending = controlState(at(stopAt(spec, 5)));
    expect(ending.endable).toBe(true);
    expect(controlItems(ending).map((i) => [i.command, i.tooltip])).toContainEqual([
      'piwi.endTest',
      'Piwi: End the test here: the rest of it is skipped',
    ]);
    const [stop] = stopsOf(at(stopAt(spec, 5)));
    expect(canEnd(stop!)).toBe(true);
    expect(stopControls(stop!).map((c) => c.title)).toEqual(['Resume', 'Step', 'Run to cursor', 'Finish', 'End test']);
    expect(controlState(at(stopAt(spec, 5), [])).endable).toBe(false);
    expect(controlState(at({ ...stopAt(spec, 5), reason: 'failure' })).endable).toBe(false);
  });

  test('no Stop for a run started in a terminal, which says so where it stops', () => {
    const terminal = { ...session('terminal-41-1', [worker(0, 'stopped', { stop: stopAt(spec, 5) })]), terminal: true };
    const state = controlState(sessionsOf(terminal));
    expect(state.stoppable).toBe(false);
    expect(controlItems(state).map((i) => i.command)).not.toContain('piwi.stopRun');
    const [stop] = stopsOf(sessionsOf(terminal));
    expect(stop!.terminal).toBe(true);
    expect(pausedText(stop!.stop, stop!.test, stop!.terminal)).toBe(
      'Stopped at a breakpoint · Fill "WELCOME10" getByLabel(\'Coupon\') · run in a terminal',
    );
    expect(stopPick(stop!).label).toContain('· run in a terminal');
    // A run of this window's beside it can be stopped.
    const both = controlState(sessionsOf(terminal, session('ed-1', [worker(0, 'running')])));
    expect(controlItems(both).map((i) => i.command)).toContain('piwi.stopRun');
  });

  test('no Stop for a run the editor’s own test runner started, which says so where it stops', () => {
    const stopped = [worker(0, 'stopped', { stop: stopAt(spec, 5) })];
    const runner = { ...session('terminal-42-1', stopped), terminal: true, runner: true };
    expect(controlState(sessionsOf(runner)).stoppable).toBe(false);
    const [stop] = stopsOf(sessionsOf(runner));
    expect(stop).toMatchObject({ terminal: true, runner: true });
    expect(pausedText(stop!.stop, stop!.test, stop!.terminal, stop!.runner)).toBe(
      "Stopped at a breakpoint · Fill \"WELCOME10\" getByLabel('Coupon') · run by the editor's test runner",
    );
    expect(stopPick(stop!).label).toContain("· run by the editor's test runner");
    // Said of a run the editor started, it says nothing.
    const [own] = stopsOf(sessionsOf({ ...session('ed-1', stopped), runner: true }));
    expect(own).not.toHaveProperty('runner');
  });
});

describe('Hold failures', () => {
  const held = (ref: string, on: boolean, by: 'start' | 'person' | 'agent' = 'start'): RunSession => ({
    ...session(ref, [worker(0, 'running')]),
    hold: { on, by },
    progress: { total: 9, done: 3, failed: 0, flaky: 0, skipped: 0, status: 'running', failure: null },
  });

  test('turns over the only live run’s, or the one a command names, and asks among several', () => {
    expect(holdTarget(sessionsOf(), undefined)).toEqual({ none: 'no run of this window can hold its failures now.' });
    expect(holdTarget(sessionsOf(held('ed-1', false)), undefined)).toEqual({ ref: 'ed-1', on: true });
    expect(holdTarget(sessionsOf(held('ed-1', true)), undefined)).toEqual({ ref: 'ed-1', on: false });
    const two = sessionsOf(held('ed-1', false), held('ed-2', true));
    expect(holdTarget(two, undefined)).toEqual({ candidates: ['ed-1', 'ed-2'] });
    expect(holdTarget(two, { ref: 'ed-2', on: true })).toEqual({ ref: 'ed-2', on: true });
    expect(holdTarget(two, { ref: 'ed-2' })).toEqual({ ref: 'ed-2', on: false });
    // A run nobody attends has none, and an ended run is not turned over.
    expect(holdTarget(sessionsOf(session('lab-1', [worker(0, 'running')])), { ref: 'lab-1' })).toEqual({
      none: 'that run holds no failure: nobody attends it.',
    });
    expect(holdTarget(sessionsOf({ ...held('ed-1', true), ended: true }), undefined)).toMatchObject({
      none: expect.any(String),
    });
    expect(holdTarget(sessionsOf({ ...held('ed-1', true), ended: true }), { ref: 'ed-1', on: false })).toEqual({
      none: 'that run has ended.',
    });
    expect(controlState(sessionsOf(held('ed-1', false))).holdable).toBe(true);
    expect(controlState(sessionsOf(session('lab-1', [worker(0, 'running')]))).holdable).toBe(false);
  });

  test('names each run in the tooltip once more than one has a Hold failures, page or none', () => {
    const paged = { ...held('ed-1', true), page: { id: 42, url: 'https://piwi.example/runs/42' } };
    const unpaged = { ...held('term-2', false), root: '/work/shop' };
    const tooltip = progressItem(sessionsOf(paged, unpaged))!.tooltip;
    expect(tooltip).toContain('Run #42: Hold failures on');
    expect(tooltip).toContain('Run in shop (term-2): Hold failures off');
    expect(runLabel(held('ed-3', false))).toBe('Run in shop (ed-3)');
    expect(runLabel({ ...held('ed-3', false), root: null })).toBe('Run ed-3');
  });

  test('says in the run’s tooltip whether its failures wait, who set it when an agent did, with the link to turn it over', () => {
    expect(holdText({ on: true, by: 'start' })).toBe('Hold failures on: a failed test waits at its line');
    expect(holdText({ on: false, by: 'person' })).toBe('Hold failures off');
    expect(holdText({ on: true, by: 'agent' })).toBe(
      'Hold failures on: a failed test waits at its line, as an agent set it',
    );
    const item = progressItem(sessionsOf(held('ed-1', false)))!;
    const arg = encodeURIComponent(JSON.stringify([{ ref: 'ed-1', on: true }]));
    expect(item.tooltip).toContain(`Hold failures off · [Turn on](command:piwi.holdFailures?${arg})`);
  });
});

describe('Share live', () => {
  const page = 'https://piwi.example.com/test-runs/42';
  const live = (ref: string, extra: Partial<NonNullable<RunSession['live']>> = {}): RunSession => ({
    ...session(ref, [worker(0, 'running', { takes: ['share'] })]),
    live: { shared: false, refused: null, stopped: null, page, viewers: 0, ...extra },
  });

  test('says what it sends and to whom before the first share, naming the instance', () => {
    expect(liveInstance({ page })).toBe('piwi.example.com');
    expect(liveInstance({ page: null })).toBeNull();
    const warning = shareLiveWarning({ page });
    expect(warning).toMatch(/^Share this run live on piwi\.example\.com\? /);
    // Its stops show to whoever has the run page open, watched or not; the images only while someone watches.
    expect(warning).toContain("each stop of its tests: the call, its file and line, and the test's title, even while");
    expect(warning).toContain("images of its test's page go there too, each with its call and the test's title");
    expect(warning).toContain('on an instance with authentication off, anyone who can reach it');
    expect(warning).toMatch(/Stop sharing ends it within seconds\.$/);
    expect(shareLiveWarning({ page: null })).toContain('the Piwi instance it reports to');
    // A run whose workers have not said yet how it stands is warned of too.
    expect(shareLiveWarning(undefined)).toBe(shareLiveWarning({ page: null }));
  });

  test('counts in the status bar the tests the runs ran, as their own processes say, and their failures', () => {
    expect(progressItem(sessionsOf(session('ed-1', [worker(0, 'running')])))).toBeNull();
    const counted = (ref: string, done: number, total: number, failed = 0, flaky = 0): RunSession => ({
      ...session(ref, [worker(0, 'running')]),
      progress: { total, done, failed, flaky, skipped: 0, status: 'running', failure: null },
    });
    expect(progressItem(sessionsOf(counted('ed-1', 3, 9)))).toEqual({
      text: '$(beaker) 3 of 9',
      tooltip: 'Piwi: the run ran 3 of 9 tests.',
      markdown: true,
      command: null,
    });
    expect(progressItem(sessionsOf(counted('ed-1', 3, 9, 1), counted('ed-2', 1, 1, 0, 1)))).toEqual({
      text: '$(beaker) 4 of 10 · $(error) 1',
      tooltip: 'Piwi: 2 runs ran 4 of 10 tests: 1 failed, 1 flaky.',
      markdown: true,
      command: null,
    });
    // A worker whose reporter shows its running test: a click watches it, and the tooltip says so.
    const watched = { ...counted('ed-1', 3, 9), workers: [worker(0, 'running', { watchable: true })] };
    expect(progressItem(sessionsOf(watched))).toEqual({
      text: '$(beaker) 3 of 9',
      tooltip: "Piwi: the run ran 3 of 9 tests.\n\n[Watch a worker's test](command:piwi.watchWorker)",
      markdown: true,
      command: RUN_COMMANDS.watch,
    });
    // A run whose own process named its page: its number, and its page opens from the item and its tooltip.
    const named = { ...counted('ed-1', 3, 9), page: { id: 78, url: 'https://piwi.example.com/test-runs/78' } };
    const link = `[Open run #78](command:piwi.openRunPage?${encodeURIComponent(JSON.stringify([{ ref: 'ed-1' }]))})`;
    expect(progressItem(sessionsOf(named))).toEqual({
      text: '$(beaker) #78 · 3 of 9',
      tooltip: `Piwi: run #78 ran 3 of 9 tests.\n\n${link}`,
      markdown: true,
      command: RUN_COMMANDS.openPage,
    });
    expect(runPageTarget(sessionsOf(named), undefined)).toEqual({
      ref: 'ed-1',
      id: 78,
      url: 'https://piwi.example.com/test-runs/78',
    });
    expect(runPageTarget(sessionsOf(named, counted('ed-2', 1, 1)), { ref: 'ed-2' })).toBeNull();
    const twice = sessionsOf(named, {
      ...counted('ed-2', 1, 1),
      page: { id: 79, url: 'https://piwi.example.com/test-runs/79' },
    });
    expect(runPageTarget(twice, undefined)).toBeNull();
    expect(runPageTarget(twice, { ref: 'ed-2' })?.id).toBe(79);
    expect(runName({ id: 79 })).toBe('Run #79');
  });

  test('lists the workers a panel can watch, and those Pause and watch can pause', () => {
    const sessions = sessionsOf(
      session('ed-1', [
        worker(0, 'running', { watchable: true }),
        worker(1, 'stopped', { watchable: true, parallelIndex: 1 }),
        worker(2, 'running', { parallelIndex: 2 }),
        worker(3, 'between', { watchable: true, parallelIndex: 3 }),
      ]),
    );
    expect(watchableWorkers(sessions)).toEqual([
      { ref: 'ed-1', worker: 0, lane: 0, label: 'Worker 1', description: 'running checkout › pays' },
      { ref: 'ed-1', worker: 1, lane: 1, label: 'Worker 2', description: 'stopped in checkout › pays' },
      { ref: 'ed-1', worker: 3, lane: 3, label: 'Worker 4', description: 'between tests' },
    ]);
    expect(watchableWorkers(sessions, true).map((t) => t.worker)).toEqual([0, 3]);
    expect(controlState(sessions).watchable).toBe(true);
    const all = watchableWorkers(sessions);
    expect(watchTargetsFor(all, null)).toHaveLength(3);
    expect(watchTargetsFor(all, { ref: 'ed-1', worker: 1 }).map((t) => t.lane)).toEqual([1]);
    expect(watchTargetsFor(all, { ref: 'ed-2' })).toEqual([]);
  });

  test('says what the worker panel’s slot does, and whether its image is of now', () => {
    const uri = 'file:///work/shop/tests/cart.spec.ts';
    const running = worker(5, 'running', { parallelIndex: 1 });
    const stopped = worker(5, 'stopped', { parallelIndex: 1, stop: stopAt(uri, 7, false), takes: ['input'] });
    expect(laneShown(undefined, 1, []).caption).toBe('Worker 2 · the run ended.');
    expect(laneShown(session('ed-1', []), 1, []).caption).toBe('Worker 2 · starting…');
    expect(laneShown(session('ed-1', [worker(5, 'between', { parallelIndex: 1 })]), 1, []).caption).toBe(
      'Worker 2 · between tests',
    );
    expect(laneShown(session('ed-1', [running]), 1, []).caption).toBe('Worker 2 · Running · checkout › pays');
    expect(laneShown(session('ed-1', [{ ...running, pausing: true }]), 1, []).caption).toBe(
      'Worker 2 · Pausing · checkout › pays',
    );
    const at = stopsOf(sessionsOf(session('ed-1', [stopped])));
    const shown = laneShown(session('ed-1', [stopped]), 1, at);
    expect(shown.stop).toEqual(at[0]);
    expect(shown.caption).toBe(
      'Worker 2 · Stopped at a breakpoint · Fill "WELCOME10" getByLabel(\'Coupon\') · cart.spec.ts:8',
    );
    const test = running.test!.id;
    expect(frameIsCurrent({ worker: 5, test, since: null }, running)).toBe(true);
    expect(frameIsCurrent({ worker: 5, test, since: null }, stopped)).toBe(false);
    expect(frameIsCurrent({ worker: 5, test, since: stopped.stop!.since }, stopped)).toBe(true);
    expect(frameIsCurrent({ worker: 4, test, since: null }, running)).toBe(false);
    expect(frameIsCurrent({ worker: 5, test: 'other', since: null }, running)).toBe(false);
    expect(frameIsCurrent({ worker: 5, test, since: null }, null)).toBe(false);
  });

  test('offers a run that can be shared in the status bar, and none that cannot, whose command says why', () => {
    expect(liveItem(sessionsOf(live('ed-1')))).toEqual({
      text: '$(broadcast)',
      tooltip: 'Piwi: Share the run live on piwi.example.com, for a teammate to watch from its page',
      command: 'piwi.shareRunLive',
    });
    const refused = live('ed-2', { refused: "This run cannot be shared live: its project's live view is off." });
    expect(liveItem(sessionsOf(refused))).toBeNull();
    expect(liveItem(sessionsOf(session('ed-3', [worker(0, 'running')])))).toBeNull();
    // The command asks the service anyway, which says why.
    expect(liveTarget(sessionsOf(refused), true)).toEqual({ ref: 'ed-2' });
    expect(liveTarget(new Map(), true)).toEqual({ none: 'no run started from the editor is running.' });
    // A run whose sharing stopped though nobody asked is offered again, saying why it stopped.
    const lost = 'Sharing stopped: the instance did not answer. Share the run again to try once more.';
    expect(liveItem(sessionsOf(live('ed-1', { stopped: lost })))).toEqual({
      text: '$(broadcast)',
      tooltip: `Piwi: ${lost} Share the run live on piwi.example.com, for a teammate to watch from its page.`,
      command: 'piwi.shareRunLive',
    });
  });

  test('says how a shared run stands, and stops sharing it from the status bar', () => {
    const shared = sessionsOf(live('ed-1', { shared: true, viewers: 2 }));
    expect(controlState(shared).liveShared).toBe(true);
    expect(liveItem(shared)).toEqual({
      text: '$(broadcast) Live · 2 views',
      tooltip: 'Piwi: Shared live on piwi.example.com: 2 views open. Click to stop sharing the run.',
      command: 'piwi.stopSharingRun',
    });
    // Two runs shared: the views open of both, as JetBrains counts them.
    expect(
      liveItem(sessionsOf(live('ed-1', { shared: true, viewers: 2 }), live('ed-2', { shared: true, viewers: 1 }))),
    ).toEqual({
      text: '$(broadcast) Live · 3 views',
      tooltip: 'Piwi: 2 runs shared live: 3 views open. Click to stop sharing one.',
      command: 'piwi.stopSharingRun',
    });
    expect(liveText({ shared: true, refused: null, stopped: null, page, viewers: 0 })).toBe(
      'Shared live on piwi.example.com: nobody watches yet',
    );
    expect(liveText({ shared: true, refused: null, stopped: null, page: null, viewers: 1 })).toBe(
      'Shared live: 1 view open',
    );
    expect(liveTarget(shared, false)).toEqual({ ref: 'ed-1' });
    expect(liveTarget(sessionsOf(live('ed-1')), false)).toEqual({ none: 'no run is shared live.' });
    // Two runs that can be shared: the person chooses.
    expect(liveTarget(sessionsOf(live('ed-1'), live('ed-2')), true)).toEqual({ candidates: ['ed-1', 'ed-2'] });
  });
});

describe('a stop', () => {
  test('says what is about to run, and the attempt after the first', () => {
    expect(pausedText(stopAt(spec, 5), runTest())).toBe(
      'Stopped at a breakpoint · Fill "WELCOME10" getByLabel(\'Coupon\')',
    );
    expect(pausedText(stopAt(spec, 5), runTest(1))).toBe(
      'Stopped at a breakpoint · Fill "WELCOME10" getByLabel(\'Coupon\') · attempt 2',
    );
    expect(pausedText(stopAt(spec, 5), null)).toBe('Stopped at a breakpoint · Fill "WELCOME10" getByLabel(\'Coupon\')');
    // A stop an agent asked for says so.
    expect(pausedText({ ...stopAt(spec, 5), by: 'agent' }, null)).toBe(
      'Paused by the agent · Fill "WELCOME10" getByLabel(\'Coupon\')',
    );
  });

  test('is each stopped worker of each run, told apart by its run, worker and time', () => {
    const a = stopAt(spec, 5);
    const b = stopAt(pageObject, 8);
    const stops = stopsOf(
      sessionsOf(
        session('ed-1', [worker(0, 'stopped', { stop: a }), worker(1, 'running')]),
        session('ed-2', [worker(3, 'stopped', { stop: b, parallelIndex: 1 })]),
      ),
    );
    expect(stops.map((s) => [s.ref, s.worker, s.stop.line])).toEqual([
      ['ed-1', 0, 5],
      ['ed-2', 3, 8],
    ]);
    expect(new Set(stops.map(stopKey)).size).toBe(2);
    expect(stopPick(stops[1]!)).toEqual({
      label: '$(debug-pause) Stopped at a breakpoint · Fill "WELCOME10" getByLabel(\'Coupon\')',
      description: 'checkout › pays · checkout.page.ts:9 · Worker 2',
    });
  });
});

describe('who else is there', () => {
  const picker: RunPresence = { kind: 'picker', name: 'Piwi Picker' };
  const desktop: RunPresence = { kind: 'desktop', name: 'the desktop app' };
  const agent: RunPresence = { kind: 'agent', name: 'an agent' };
  const me: RunPresence = { kind: 'editor', name: 'Visual Studio Code', self: true };

  test('shows a run’s folder and the tools’ names as text in the progress tooltip, never as a link', () => {
    const named = (ref: string, root: string): RunSession => ({
      ...session(ref, [worker(0, 'running')]),
      root,
      hold: { on: false, by: 'start' },
      presence: [{ kind: 'picker', name: 'Piwi Picker' }],
      progress: { total: 9, done: 3, failed: 0, flaky: 0, skipped: 0, status: 'running', failure: null },
    });
    const tooltip = progressItem(
      sessionsOf(named('ed-1', '/w/[x](command:piwi.holdFailures)'), named('ed-2', '/w/my_shop_app')),
    )!.tooltip;
    expect(tooltip).not.toContain('[x](command:');
    expect(tooltip).toContain('Run in \\[x\\](command:piwi.holdFailures) (ed-1): Also open in Piwi Picker');
    expect(tooltip).toContain('Run in my\\_shop\\_app (ed-2): Hold failures off');
  });

  test('names the tools that have a run open, leaving this editor out', () => {
    const run = session('ed-1', [worker(0, 'running')]);
    expect(presenceText(run)).toBeNull();
    expect(presenceText({ ...run, presence: [me] })).toBeNull();
    expect(presenceText({ ...run, presence: [picker] })).toBe('Also open in Piwi Picker');
    expect(presenceText({ ...run, presence: [picker, picker, desktop, agent, me] })).toBe(
      'Also open in Piwi Picker and the desktop app · An agent follows this run',
    );
    expect(presenceText({ ...run, presence: [agent] })).toBe('An agent follows this run');
    const tooltip = progressItem(
      sessionsOf({
        ...run,
        presence: [picker, agent],
        progress: { total: 9, done: 3, failed: 0, flaky: 0, skipped: 0, status: 'running', failure: null },
      }),
    )!.tooltip;
    expect(tooltip).toContain('\n\nAlso open in Piwi Picker · An agent follows this run');
  });

  test('names who watches a worker’s page, this editor last as you, and nothing while it alone does', () => {
    expect(watchersText(undefined)).toBeNull();
    expect(watchersText([me])).toBeNull();
    expect(watchersText([me, picker])).toBe('Watched by Piwi Picker and you');
    expect(watchersText([picker, agent, desktop])).toBe('Watched by Piwi Picker, an agent and the desktop app');
  });

  test('names who drives a stop, and that Interact takes it from the agent', () => {
    const stop = stopAt(spec, 5, false);
    expect(driverText(stop)).toBeNull();
    expect(driverText({ ...stop, driver: me }, true)).toBe('You drive this stop');
    expect(driverText({ ...stop, driver: picker }, true)).toBe('Piwi Picker drives this stop');
    expect(driverText({ ...stop, driver: agent })).toBe('An agent drives this stop');
    expect(driverText({ ...stop, driver: agent }, true)).toBe('An agent drives this stop: Interact takes control');
  });

  test('says who drives the stop and who watches it in the paused page’s and the worker panel’s captions', () => {
    const uri = 'file:///work/shop/tests/cart.spec.ts';
    const stopped = worker(5, 'stopped', {
      parallelIndex: 1,
      stop: { ...stopAt(uri, 7, false), by: 'agent', driver: agent },
      takes: ['input'],
      watchers: [picker, me],
    });
    const sessions = sessionsOf(session('ed-1', [stopped]));
    const at = stopsOf(sessions);
    const said = 'Paused by the agent · Fill "WELCOME10" getByLabel(\'Coupon\') · cart.spec.ts:8';
    const present = 'An agent drives this stop: Interact takes control · Watched by Piwi Picker and you';
    expect(stopPresence(at[0]!, sessions)).toBe(present);
    expect(stopCaption(at[0]!, sessions)).toBe(`${said} · ${present}`);
    expect(laneShown(session('ed-1', [stopped]), 1, at).caption).toBe(`Worker 2 · ${said} · ${present}`);
    // A stop nobody drives and no other tool watches says neither.
    const alone = worker(5, 'stopped', { parallelIndex: 1, stop: stopAt(uri, 7, false), watchers: [me] });
    const quiet = sessionsOf(session('ed-1', [alone]));
    expect(stopPresence(stopsOf(quiet)[0]!, quiet)).toBeNull();
    expect(stopCaption(stopsOf(quiet)[0]!, quiet)).toBe(
      'Stopped at a breakpoint · Fill "WELCOME10" getByLabel(\'Coupon\') · cart.spec.ts:8',
    );
    // A running worker's panel says who else watches it.
    const running = worker(5, 'running', { parallelIndex: 1, watchers: [desktop, me] });
    expect(laneShown(session('ed-1', [running]), 1, []).caption).toBe(
      'Worker 2 · Running · checkout › pays · Watched by the desktop app and you',
    );
  });
});

describe('what the editor shows of the stops', () => {
  /** Worker `index` of `ed-1`, in slot `slot`, stopped headless at `line`. */
  const at = (index: number, line: number, extra: Partial<RunStop> = {}, slot = index) =>
    worker(index, 'stopped', { parallelIndex: slot, stop: { ...stopAt(spec, line, false), ...extra } });
  const running = (index: number) => worker(index, 'running');
  /**
   * The pushes of run `ed-1` as the service sends them, 100 ms apart, through `StopsShown` as the extension takes them:
   * each new stop's file opened in its turn (none for a line in `unopened`), and the page the view opens shown there,
   * while the worker panel watches the slots in `watched`. Each push says which workers' files opened with the focus or
   * without, and the page opened, as `[worker, line]`.
   */
  const editor = (unopened: number[] = []) => {
    const shown = new StopsShown();
    const watched = new Set<number>();
    let now = 0;
    const push = (...workers: RunWorker[]) => {
      now += 100;
      const sessions = sessionsOf(session('ed-1', workers));
      const change = shown.changed(sessions, stopsOf(sessions), { now, watched: (s) => watched.has(s.slot) });
      const opened = change.open
        .filter((stop) => !unopened.includes(stop.stop.line))
        .map((stop) => {
          const focus = shown.focusFor(stop, now);
          shown.opened(stop, focus);
          return [stop.worker, focus];
        });
      if (change.page) shown.view(change.page);
      return { opened, page: change.page && [change.page.worker, change.page.stop.line] };
    };
    const stopOf = (index: number, line: number) => stopsOf(sessionsOf(session('ed-1', [at(index, line)])))[0]!;
    /** A control from the editor answers the stop of worker `index` at `line`, as it is sent. */
    const answer = (action: 'resume' | 'step' | 'run-to', index: number, line: number) =>
      shown.answered(stopOf(index, line), action, now);
    const wait = (ms: number) => {
      now += ms;
    };
    return { shown, watched, push, answer, stopOf, wait, now: () => now };
  };

  test('opens the first stop with the focus, and its page', () => {
    const { push } = editor();
    expect(push(at(0, 3), running(1))).toEqual({ opened: [[0, true]], page: [0, 3] });
  });

  test('opens a second worker’s stop without the focus while the person is on the first, the view keeping its stop', () => {
    const { push } = editor();
    push(at(0, 3), running(1));
    expect(push(at(0, 3), at(1, 5))).toEqual({ opened: [[1, false]], page: null });
    // A failure held for another worker leaves them alone too.
    expect(push(at(0, 3), at(1, 5), at(2, 7, { reason: 'failure' }))).toEqual({ opened: [[2, false]], page: null });
  });

  test('gives the focus and the view to the first stop of a Pause with three workers, in one push or in three', () => {
    const together = editor();
    expect(together.push(running(0), running(1), running(2))).toEqual({ opened: [], page: null });
    expect(together.push(at(0, 3), at(1, 5), at(2, 7))).toEqual({
      opened: [
        [0, true],
        [1, false],
        [2, false],
      ],
      page: [0, 3],
    });
    const apart = editor();
    expect(apart.push(at(0, 3), running(1), running(2))).toEqual({ opened: [[0, true]], page: [0, 3] });
    expect(apart.push(at(0, 3), at(1, 5), running(2))).toEqual({ opened: [[1, false]], page: null });
    expect(apart.push(at(0, 3), at(1, 5), at(2, 7))).toEqual({ opened: [[2, false]], page: null });
  });

  test('waits for the next stop of a worker stepped from the editor, through the push where it runs', () => {
    const { push, answer } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    answer('step', 0, 3);
    expect(push(running(0), at(1, 5))).toEqual({ opened: [], page: null });
    expect(push(at(0, 4), at(1, 5))).toEqual({ opened: [[0, true]], page: [0, 4] });
  });

  test('hands the view to a stop held once the worker it shows is resumed, then follows that one’s Step', () => {
    const { push, answer } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    answer('resume', 0, 3);
    expect(push(running(0), at(1, 5))).toEqual({ opened: [], page: [1, 5] });
    answer('step', 1, 5);
    expect(push(running(0), running(1))).toEqual({ opened: [], page: null });
    expect(push(running(0), at(1, 6))).toEqual({ opened: [[1, true]], page: [1, 6] });
  });

  test('hands the view on after a control from elsewhere, and opens a lone worker’s next stop', () => {
    const { push } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    expect(push(running(0), at(1, 5)).page).toEqual([1, 5]);
    const lone = editor();
    lone.push(at(0, 3));
    expect(lone.push(running(0)).page).toBeNull();
    expect(lone.push(at(0, 4)).page).toEqual([0, 4]);
  });

  test('stops waiting for a stepped worker’s next stop once its worker left the run', () => {
    const { shown, push, answer } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    answer('step', 0, 3);
    expect(push(running(0), at(1, 5)).page).toBeNull();
    expect(push(at(1, 5))).toEqual({ opened: [], page: [1, 5] });
    expect(shown.waitsUntil()).toBeNull();
  });

  test('waits for a stepped worker’s next stop RESERVED_MS at most, saying when to ask again', () => {
    const { shown, push, answer, wait, now } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    expect(shown.waitsUntil()).toBeNull();
    answer('run-to', 0, 3);
    expect(shown.waitsUntil()).toBe(now() + RESERVED_MS);
    expect(push(running(0), at(1, 5)).page).toBeNull();
    // Asked again when the wait is over, with no push since: the stop held takes the view.
    wait(RESERVED_MS);
    expect(push(running(0), at(1, 5)).page).toEqual([1, 5]);
    expect(shown.waitsUntil()).toBeNull();
  });

  test('gives the focus to the next stop of the slot whose stop took it, moved on from elsewhere', () => {
    const { push } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    // Piwi Picker steps worker 0.
    push(running(0), at(1, 5));
    expect(push(at(0, 4), at(1, 5)).opened).toEqual([[0, true]]);
  });

  test('moves the focus to the worker a control answered', () => {
    const { push, answer } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    answer('resume', 1, 5);
    push(at(0, 3), running(1));
    expect(push(at(0, 3), at(1, 6))).toEqual({ opened: [[1, true]], page: null });
  });

  test('keeps the focus on the slot of a worker restarted after a failure', () => {
    const { push, answer } = editor();
    push(at(0, 3, { reason: 'failure' }), at(1, 5));
    answer('resume', 0, 3);
    push(at(1, 5));
    expect(push(at(2, 4, {}, 0), at(1, 5))).toEqual({ opened: [[2, true]], page: null });
  });

  test('counts a stop whose file never opened as none shown', () => {
    const { push } = editor([3]);
    push(at(0, 3), running(1));
    expect(push(at(0, 3), at(1, 5)).opened).toEqual([[1, true]]);
  });

  test('opens no page at a stop with a pause bar, and a new stop’s page in a view that is closed', () => {
    const { shown, push } = editor();
    expect(push(at(0, 3, { bar: true }), running(1)).page).toBeNull();
    expect(push(at(0, 3, { bar: true }), at(1, 5)).page).toEqual([1, 5]);
    shown.view(null);
    expect(push(at(0, 3, { bar: true }), at(1, 5)).page).toBeNull();
    expect(push(at(0, 3, { bar: true }), at(1, 5), at(2, 7)).page).toEqual([2, 7]);
  });

  test('leaves the stops of the slot the worker panel watches to it, a slot no person is on for that', () => {
    const { watched, push, answer } = editor();
    watched.add(1);
    push(at(0, 3), running(1));
    // The panel's stop opens its file without the focus while the person is on worker 0, and takes no page.
    expect(push(at(0, 3), at(1, 5))).toEqual({ opened: [[1, false]], page: null });
    answer('resume', 0, 3);
    expect(push(running(0), at(1, 5))).toEqual({ opened: [], page: null });
    // Out of the panel's sight, the stop held takes the view.
    watched.clear();
    expect(push(running(0), at(1, 5)).page).toEqual([1, 5]);
    // Alone, the panel's stop takes the focus as any first stop does.
    const alone = editor();
    alone.watched.add(0);
    expect(alone.push(at(0, 3))).toEqual({ opened: [[0, true]], page: null });
  });

  test('keeps the focus off another worker’s stop while a stepped worker’s next stop is awaited', () => {
    const { push, answer } = editor();
    push(at(0, 3), running(1));
    answer('step', 0, 3);
    push(running(0), running(1));
    // No other stop's file is open, and worker 1's stop still leaves the caret to worker 0.
    expect(push(running(0), at(1, 5))).toEqual({ opened: [[1, false]], page: null });
    expect(push(at(0, 4), at(1, 5))).toEqual({ opened: [[0, true]], page: [0, 4] });
    // In one push, worker 1's stop first.
    const together = editor();
    together.push(at(0, 3), running(1));
    together.answer('step', 0, 3);
    together.push(running(0), running(1));
    expect(together.push(at(1, 5), at(0, 4))).toEqual({
      opened: [
        [1, false],
        [0, true],
      ],
      page: [0, 4],
    });
  });

  test('ends the wait as the stepped worker’s next stop opens, with the focus or, past its turn, without', () => {
    const { shown, push, answer, stopOf } = editor([4]);
    push(at(0, 3), running(1));
    answer('step', 0, 3);
    push(running(0), running(1));
    push(at(0, 4), running(1));
    expect(shown.waitsUntil()).not.toBeNull();
    shown.opened(stopOf(0, 4), false);
    expect(shown.waitsUntil()).toBeNull();
  });

  test('lets another worker’s stop take the focus once the wait for a stepped worker is over', () => {
    const { push, answer, wait } = editor();
    push(at(0, 3), running(1));
    answer('step', 0, 3);
    push(running(0), running(1));
    wait(RESERVED_MS);
    expect(push(running(0), at(1, 5))).toEqual({ opened: [[1, true]], page: [1, 5] });
  });

  test('makes the slot the person acted on theirs: a code action, input or a pick on a page', () => {
    const { shown, push, answer, stopOf } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    answer('resume', 0, 3);
    expect(push(running(0), at(1, 5)).page).toEqual([1, 5]);
    // The person types on worker 1's page: worker 0's next stop leaves them there.
    shown.acted(stopOf(1, 5));
    expect(push(at(0, 4), at(1, 5)).opened).toEqual([[0, false]]);
    push(at(0, 4), running(1));
    expect(push(at(0, 4), at(1, 6)).opened).toEqual([[1, true]]);
    // Acting on another worker ends the wait for a stepped one.
    answer('step', 0, 4);
    shown.acted(stopOf(1, 6));
    expect(shown.waitsUntil()).toBeNull();
  });

  test('forgets an answer the run refused: no wait, and the slot the person was on', () => {
    const { shown, push, answer } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    shown.taken(answer('resume', 1, 5));
    push(at(0, 3), running(1));
    // A Step on worker 0's stop, which went on meanwhile.
    expect(shown.refused(answer('step', 0, 3))).toBe(true);
    expect(shown.waitsUntil()).toBeNull();
    expect(push(at(0, 3), at(1, 6)).opened).toEqual([[1, true]]);
    // An answer taken, or settled already, undoes nothing.
    const taken = answer('step', 0, 3);
    shown.taken(taken);
    expect(shown.refused(taken)).toBe(false);
    expect(shown.waitsUntil()).not.toBeNull();
  });

  test('undoes each of two refused answers in flight, in either order', () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const { shown, push, answer, stopOf, now } = editor();
      push(at(0, 3), at(1, 5));
      const tokens = [answer('step', 0, 3), answer('step', 1, 5)];
      for (const i of order) shown.refused(tokens[i]!);
      expect(shown.waitsUntil()).toBeNull();
      // Neither answer holds the run keys: the only stop shown is answered.
      expect(shown.choose([stopOf(0, 3)], null, true, now())).toEqual(stopOf(0, 3));
    }
  });

  test('gives a run key the stop at the caret, else none but the one just answered, else the only one shown', () => {
    const { shown, push, answer, stopOf } = editor([5]);
    push(at(0, 3), at(1, 5), at(2, 7));
    const caret = (line: number) => ({ uri: spec, line });
    const [a, b, c] = [stopOf(0, 3), stopOf(1, 5), stopOf(2, 7)];
    expect(shown.choose([a, b, c], caret(5), true)).toEqual(b);
    expect(shown.choose([a, b, c], caret(1), true)).toBe('ask');
    // The only stop left: one whose file never opened is asked for.
    expect(shown.choose([b], caret(1), true)).toBe('ask');
    expect(shown.choose([c], caret(1), true)).toEqual(c);
    // Worker 0 resumed from the caret: a second press before the next stop answers no other stop, but a code action
    // takes the only one shown.
    answer('resume', 0, 3);
    expect(shown.choose([a], caret(9), true, 150)).toEqual(a);
    expect(shown.choose([c], caret(3), true, 150)).toBeNull();
    expect(shown.choose([c], caret(3), false, 150)).toEqual(c);
    expect(shown.choose([c], caret(3), true, 100 + RESUMED_KEY_MS)).toEqual(c);
    // A stop whose page shows is one the person was shown.
    shown.view(b);
    expect(shown.choose([b], caret(3), true, 5_000)).toEqual(b);
    expect(shown.choose([], caret(3), true)).toBeNull();
  });

  test('ends the moments after an answer once no worker of its run holds the slot', () => {
    const shown = new StopsShown();
    const first = sessionsOf(session('ed-1', [at(0, 3)]));
    shown.changed(first, stopsOf(first), { now: 100 });
    const a = stopsOf(first)[0]!;
    shown.opened(a, true);
    shown.answered(a, 'resume', 100);
    // The run ends, and another run's worker stops within the moments after the answer.
    const second = sessionsOf(session('ed-2', [at(0, 5)]));
    shown.changed(second, stopsOf(second), { now: 200 });
    const b = stopsOf(second)[0]!;
    shown.opened(b, true);
    expect(shown.choose([b], { uri: spec, line: 5 }, true, 300)).toEqual(b);
  });

  test('ends the moments after an answer at the next stop', () => {
    const { shown, push, answer, stopOf } = editor();
    push(at(0, 3), at(1, 5));
    answer('step', 0, 3);
    push(running(0), at(1, 5));
    expect(shown.choose([stopOf(1, 5)], null, true, 400)).toBeNull();
    push(at(0, 4), at(1, 5));
    expect(shown.choose([stopOf(1, 5)], null, true, 500)).toEqual(stopOf(1, 5));
  });

  test('keeps a run key on the answered worker until its next stop opens, whatever the caret and other stops say', () => {
    const { shown, push, answer, stopOf } = editor([4]);
    // Two workers stopped at the same line: a key asks which, and the person steps worker 0.
    push(at(0, 3), at(1, 3), running(2));
    const line = (n: number) => ({ uri: spec, line: n });
    expect(shown.choose([stopOf(0, 3), stopOf(1, 3)], line(3), true)).toBe('ask');
    answer('step', 0, 3);
    expect(shown.choose([stopOf(0, 3), stopOf(1, 3)], line(3), true, 150)).toEqual(stopOf(0, 3));
    // Worker 0 runs and worker 2 stops: a key pressed again answers neither worker 1 nor worker 2.
    push(running(0), at(1, 3), at(2, 7));
    expect(shown.choose([stopOf(1, 3)], line(3), true, 250)).toBeNull();
    expect(shown.choose([stopOf(2, 7)], line(7), true, 250)).toBeNull();
    // Worker 0's next stop, heard but its file not open yet, has not moved the caret: the key still waits for it.
    push(at(0, 4), at(1, 3), at(2, 7));
    expect(shown.choose([stopOf(1, 3)], line(3), true, 350)).toBeNull();
    // Its file open, the moments after the answer end.
    shown.opened(stopOf(0, 4), true);
    expect(shown.choose([stopOf(1, 3)], line(3), true, 350)).toEqual(stopOf(1, 3));
  });

  test('offers a held stop the worker panel showed to a closed paused page once the panel no longer shows it', () => {
    const { shown, watched, push } = editor();
    watched.add(1);
    expect(push(running(0), at(1, 5))).toEqual({ opened: [[1, true]], page: null });
    watched.clear();
    expect(push(running(0), at(1, 5)).page).toEqual([1, 5]);
    // Offered once: closed again, the view opens no more.
    shown.view(null);
    expect(push(running(0), at(1, 5)).page).toBeNull();
  });

  test('says when acting ended a wait, for the page to be shown again, as after a refusal', () => {
    const { shown, push, answer, stopOf } = editor();
    push(at(0, 3), running(1));
    push(at(0, 3), at(1, 5));
    answer('step', 0, 3);
    expect(push(running(0), at(1, 5)).page).toBeNull();
    expect(shown.acted(stopOf(1, 5))).toBe(true);
    expect(push(running(0), at(1, 5)).page).toEqual([1, 5]);
    expect(shown.acted(stopOf(1, 5))).toBe(false);
    // A refused Step says it ended the wait: the page shown again opens the stop held.
    const refused = editor();
    refused.push(at(0, 3), running(1));
    refused.push(at(0, 3), at(1, 5));
    const step = refused.answer('step', 0, 3);
    expect(refused.push(running(0), at(1, 5)).page).toBeNull();
    expect(refused.shown.refused(step)).toBe(true);
    expect(refused.push(running(0), at(1, 5)).page).toEqual([1, 5]);
  });

  test('undoes of a refused answer only what nothing changed since', () => {
    const { shown, push, answer, stopOf } = editor();
    push(at(0, 3), at(1, 5));
    const step = answer('step', 0, 3);
    // The person types on worker 1's page before the refusal comes.
    shown.acted(stopOf(1, 5));
    shown.refused(step);
    push(at(0, 3), running(1));
    expect(push(at(0, 3), at(1, 6)).opened).toEqual([[1, true]]);
    // Worker 1 answered, then worker 0 stepped and typed on: the slot the person is on stays worker 0's.
    const again = editor();
    again.push(at(0, 3), at(1, 5));
    again.shown.taken(again.answer('resume', 1, 5));
    again.push(at(0, 3), running(1));
    const stepped = again.answer('step', 0, 3);
    again.shown.acted(again.stopOf(0, 3));
    again.shown.refused(stepped);
    expect(again.push(at(0, 3), at(1, 6)).opened).toEqual([[1, false]]);
  });

  test('keeps waiting when the stepped stop’s own file opens after the Step', () => {
    const { shown, push, answer, stopOf } = editor([3]);
    push(at(0, 3), running(1));
    answer('step', 0, 3);
    shown.opened(stopOf(0, 3), false);
    expect(shown.waitsUntil()).not.toBeNull();
  });

  test('counts a press, a click, a key, text or the wheel on a page as acting, not a pointer moving or a release', () => {
    const at = { x: 1, y: 2 };
    expect(actsOnPage([{ type: 'mouse', action: 'move', ...at }])).toBe(false);
    expect(actsOnPage([{ type: 'mouse', action: 'up', ...at, button: 'left' }])).toBe(false);
    expect(actsOnPage([{ type: 'key', action: 'up', key: 'a' }])).toBe(false);
    expect(actsOnPage([])).toBe(false);
    expect(actsOnPage([{ type: 'mouse', action: 'down', ...at, button: 'left' }])).toBe(true);
    expect(actsOnPage([{ type: 'mouse', action: 'click', ...at, button: 'left', clickCount: 1 }])).toBe(true);
    expect(actsOnPage([{ type: 'key', action: 'press', key: 'Enter' }])).toBe(true);
    expect(actsOnPage([{ type: 'key', action: 'down', key: 'a' }])).toBe(true);
    expect(actsOnPage([{ type: 'text', text: 'MORNING10' }])).toBe(true);
    expect(actsOnPage([{ type: 'wheel', ...at, deltaX: 0, deltaY: 40 }])).toBe(true);
    expect(
      actsOnPage([
        { type: 'mouse', action: 'move', ...at },
        { type: 'key', action: 'press', key: 'Tab' },
      ]),
    ).toBe(true);
  });

  test('opens a file aside in a group neither active nor a panel’s, else in a new one at the right', () => {
    const groups = (active: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ viewColumn: i + 1, isActive: i + 1 === active }));
    expect(asideColumn(groups(1, 1))).toBe(2);
    expect(asideColumn(groups(1, 2), [2])).toBe(3);
    expect(asideColumn(groups(1, 3), [2])).toBe(3);
    expect(asideColumn(groups(1, 3), [2, 3])).toBe(4);
    expect(asideColumn(groups(2, 2), [2])).toBe(1);
    expect(asideColumn(groups(9, 9), [8])).toBe(1);
    expect(asideColumn([{ viewColumn: 9, isActive: true }])).toBe(9);
  });
});

describe('the stop a control acts on', () => {
  const one: ShownStop = { ref: 'ed-1', worker: 0, slot: 0, stop: stopAt(spec, 5), test: runTest(), takes: [] };
  const two: ShownStop = { ref: 'ed-1', worker: 1, slot: 1, stop: stopAt(pageObject, 8), test: runTest(), takes: [] };

  test('is the only one, wherever the caret is', () => {
    expect(stopsFor([one], { uri: pageObject, line: 1 })).toEqual([one]);
    expect(stopsFor([], null)).toEqual([]);
  });

  test('is the one at the caret’s line among several, else any of them to choose from', () => {
    expect(stopsFor([one, two], { uri: pageObject, line: 8 })).toEqual([two]);
    expect(stopsFor([one, two], { uri: pageObject, line: 7 })).toEqual([one, two]);
    expect(stopsFor([one, two], null)).toEqual([one, two]);
  });

  test('is named by a command’s argument', () => {
    expect(runTargetArg({ ref: 'ed-1', worker: 2 })).toEqual({ ref: 'ed-1', worker: 2 });
    expect(runTargetArg({ ref: 'ed-1', worker: 2, since: 's' })).toEqual({ ref: 'ed-1', worker: 2, since: 's' });
    expect(runTargetArg({ ref: 'ed-1' })).toEqual({ ref: 'ed-1' });
    expect(runTargetArg({ worker: 2 })).toBeNull();
    expect(runTargetArg(undefined)).toBeNull();
  });

  test('named by a lens, is the stop it was drawn for, none once the test went on', () => {
    expect(targetStop([one, two], { ref: 'ed-1', worker: 1, since: two.stop.since })).toBe(two);
    expect(targetStop([one, two], { ref: 'ed-1', worker: 1 })).toBe(two);
    expect(targetStop([one, two], { ref: 'ed-1', worker: 1, since: one.stop.since })).toBeNull();
    expect(targetStop([one], { ref: 'ed-2' })).toBeNull();
  });
});

/** A change replacing the range from `from` to `to` (`[line, character]`) with `text`. */
const change = (from: [number, number], to: [number, number], text: string): TextChange => ({
  range: { start: { line: from[0], character: from[1] }, end: { line: to[0], character: to[1] } },
  text,
});

/** Apply a change to lines of text, as the editor does, and log the lines it moved. */
function edit(lines: string[], log: EditLog, uri: string, c: TextChange): string[] {
  const text = lines.join('\n');
  const offset = (line: number, character: number) =>
    lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + character;
  const start = offset(c.range.start.line, c.range.start.character);
  const end = offset(c.range.end.line, c.range.end.character);
  const after = (text.slice(0, start) + c.text + text.slice(end)).split('\n');
  const moved = lineEditOf(c, (line) => after[line]);
  if (moved) log.add(uri, moved);
  return after;
}

describe('the edits since a run started', () => {
  const code = ["test('pays', async ({ page }) => {", "  await page.goto('/');", '  await pay(page);', '});'];

  test('move nothing within a line', () => {
    expect(lineEditOf(change([1, 2], [1, 7], 'await '), () => '')).toBeNull();
  });

  test('bring a line of the run’s code to where it stands, and the line under the cursor back', () => {
    const log = new EditLog();
    const since = log.now();
    // Two lines inserted above the call, then a line split after its statement.
    let lines = edit(code, log, spec, change([1, 0], [1, 0], '  // one\n  // two\n'));
    lines = edit(lines, log, spec, change([4, 18], [4, 18], '\n  '));
    expect(lines[4]).toBe('  await pay(page);');
    expect(log.forward(spec, 2, since)).toBe(4);
    expect(log.forward(spec, 1, since)).toBe(3);
    expect(log.forward(spec, 0, since)).toBe(0);
    expect(log.back(spec, 4, since)).toBe(2);
    expect(log.back(spec, 3, since)).toBe(1);
    // The lines written since are none of the run's.
    expect(log.back(spec, 1, since)).toBeNull();
    expect(log.back(spec, 5, since)).toBeNull();
    expect(log.back(spec, 6, since)).toBe(3);
    // Another file, and a run started after the edits, move nothing.
    expect(log.forward(pageObject, 2, since)).toBe(2);
    expect(log.back(spec, 4, log.now())).toBe(4);
  });

  test('follow a line split before its statement and lines joined again', () => {
    const log = new EditLog();
    const since = log.now();
    let lines = edit(code, log, spec, change([2, 2], [2, 2], '\n  '));
    expect(lines[3]).toBe('  await pay(page);');
    expect(log.forward(spec, 2, since)).toBe(3);
    expect(log.back(spec, 3, since)).toBe(2);
    expect(log.back(spec, 2, since)).toBeNull();
    // Undone: the lines join again.
    lines = edit(lines, log, spec, change([2, 2], [3, 2], ''));
    expect(lines).toEqual(code);
    expect(log.forward(spec, 2, since)).toBe(2);
    expect(log.back(spec, 2, since)).toBe(2);
  });

  test('of an event of several, read each change below the lines those above it add, unless one shares its lines', () => {
    const imports = change([1, 0], [1, 0], "import { expect } from '@playwright/test';\n");
    const block = change([4, 0], [4, 0], '  await expect(x).toBeVisible();\n');
    expect(linesAbove(block, [block, imports])).toBe(1);
    expect(linesAbove(imports, [block, imports])).toBe(0);
    const removed = change([6, 0], [8, 0], '');
    expect(linesAbove(removed, [removed, block, imports])).toBe(2);
    expect(linesAbove(block, [block, change([4, 9], [4, 9], 'x')])).toBeNull();
    // The stopped statement on line 4 goes down with the block written above it, and with the import line.
    const after = [
      "import { test } from '@playwright/test';",
      "import { expect } from '@playwright/test';",
      '',
      "test('pays', async ({ page }) => {",
      "  await page.goto('/');",
      '  await expect(x).toBeVisible();',
      '  await pay(page);',
    ];
    const log = new EditLog();
    const since = log.now();
    for (const c of [block, imports]) {
      const shift = linesAbove(c, [block, imports])!;
      log.add(
        spec,
        lineEditOf(c, (line) => after[line + shift])!,
      );
    }
    expect(log.forward(spec, 4, since)).toBe(6);
  });

  test('lose a line a change of several lines touched, when the change came with others', () => {
    const log = new EditLog();
    const since = log.now();
    const moved = lineEditOf(change([1, 0], [2, 0], 'x\ny\nz\n'));
    log.add(spec, moved!);
    expect(log.back(spec, 1, since)).toBeNull();
    expect(log.back(spec, 4, since)).toBeNull();
    expect(log.back(spec, 5, since)).toBe(3);
    log.forget(log.now());
    expect(log.back(spec, 1, since)).toBe(1);
  });
});

describe('the breakpoints sent to a run', () => {
  const at = (id: string, line: number, uri = spec): RunBreakpoint => ({ id, uri, line });
  const places = [{ uri: spec, line: 4 }];

  test('go to each live run whose breakpoints differ, once', () => {
    const edits = new EditLog();
    const runs = new Map<string, RunBreakpoints>();
    const live = sessionsOf(session('ed-1', [worker(0, 'running')]), session('ed-2', [worker(0, 'running')]));
    remember(runs, 'ed-2', runStarted(edits.now(), [at('b1', 4)]));
    expect(breakpointUpdates(live, [at('b1', 4)], runs, edits)).toEqual([{ ref: 'ed-1', places }]);
    expect(breakpointUpdates(live, [at('b1', 4)], runs, edits)).toEqual([]);
    expect(breakpointUpdates(live, [], runs, edits)).toEqual([
      { ref: 'ed-1', places: [] },
      { ref: 'ed-2', places: [] },
    ]);
  });

  test('keep the line a run has for a breakpoint that moved with an edit, and map a new one back', () => {
    const edits = new EditLog();
    const runs = new Map<string, RunBreakpoints>();
    const live = sessionsOf(session('ed-1', [worker(0, 'running')]));
    remember(runs, 'ed-1', runStarted(edits.now(), [at('b1', 4), at('b2', 9, pageObject)]));
    // Two lines inserted above: the editor moves the breakpoint to line 6; the run's code did not move.
    edits.add(spec, { start: 1, oldEnd: 1, newEnd: 3, first: false, last: true });
    expect(breakpointUpdates(live, [at('b1', 6), at('b2', 9, pageObject)], runs, edits)).toEqual([]);
    // One set since, at line 8 of the edited spec, is line 6 of the run's; one on a line written since is left out.
    expect(breakpointUpdates(live, [at('b1', 6), at('b3', 8), at('b4', 1)], runs, edits)).toEqual([
      {
        ref: 'ed-1',
        places: [
          { uri: spec, line: 4 },
          { uri: spec, line: 6 },
        ],
      },
    ]);
    // Removed, then put back: its line is the run's again.
    expect(breakpointUpdates(live, [at('b3', 8)], runs, edits)).toEqual([
      { ref: 'ed-1', places: [{ uri: spec, line: 6 }] },
    ]);
    // Moved otherwise than by the edits (to line 10 of the spec as it stands): mapped back from there.
    expect(breakpointUpdates(live, [at('b3', 10)], runs, edits)).toEqual([
      { ref: 'ed-1', places: [{ uri: spec, line: 8 }] },
    ]);
  });

  test('are remembered for the 50 latest runs', () => {
    const runs = new Map<string, RunBreakpoints>();
    for (let i = 0; i < 60; i++) remember(runs, `ed-${i}`, runStarted(0, []));
    expect(runs.size).toBe(50);
    expect(runs.has('ed-9')).toBe(false);
    expect(runs.has('ed-59')).toBe(true);
  });
});

describe('the paused page view', () => {
  test('ends its watch as it hides and starts it again as it shows, and a focus change does neither', () => {
    // A focus change fires the view state change with the panel visible before and after.
    expect(pausedPageViewChange(true, true, true)).toBe('none');
    expect(pausedPageViewChange(false, false, true)).toBe('none');
    expect(pausedPageViewChange(true, false, true)).toBe('end');
    expect(pausedPageViewChange(true, false, false)).toBe('end');
    expect(pausedPageViewChange(false, true, true)).toBe('watch');
    expect(pausedPageViewChange(false, true, false)).toBe('none');
  });

  test('shows the JPEG under its caption, with no script and data images only', () => {
    const html = pausedPageHtml({ image: { mime: 'image/jpeg', data: '/9j/4AAQ+w==' }, caption: 'Click <b>' }, 'n0nce');
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-n0nce'">`,
    );
    expect(html).toContain('<style nonce="n0nce">');
    expect(html).toContain('<p>Click &#60;b&#62;</p>');
    expect(html).toContain('<img src="data:image/jpeg;base64,/9j/4AAQ+w==" alt="The page of the paused test">');
    expect(html).not.toContain('<script');
  });

  test('offers live watching only for a capable stop, with interaction disabled and help collapsed', () => {
    const html = pausedPageHtml(
      {
        image: null,
        caption: '<test>',
        live: { shown: 7, on: false, input: true, interacting: false, clickCounts: true },
      },
      'secure',
      'https://webview/paused-page.js?a=1&b=2',
    );
    expect(html).toContain("script-src 'nonce-secure'");
    expect(html).toContain('src="https://webview/paused-page.js?a=1&#38;b=2"');
    expect(html).toContain('data-shown="7"');
    expect(html).toContain('id="interact" type="checkbox" disabled');
    expect(html).toContain('<details><summary>');
    expect(html).not.toContain('<details open');
    expect(html).not.toContain('<test>');
    expect(
      pausedPageHtml({ image: null, caption: 'Still image' }, 'n', 'https://webview/paused-page.js'),
    ).not.toContain('Watch live');
  });

  test('runs one script, by the style’s nonce, only where a click on the image picks', () => {
    const image = { mime: 'image/jpeg' as const, data: '/9j/4AAQ+w==', width: 1280, height: 800 };
    const html = pausedPageHtml({ image, caption: 'Paused', pick: { shown: 3 }, note: 'Picked <x>.' }, 'n0nce');
    expect(html).toContain(
      `content="default-src 'none'; img-src data:; style-src 'nonce-n0nce'; script-src 'nonce-n0nce'"`,
    );
    expect(html).toContain(`<p class="hint">${PICK_HINT}</p>`);
    expect(html).toContain('<p class="note" role="status">Picked &#60;x&#62;.</p>');
    expect(html).toContain('<img class="pick" id="page" src="data:image/jpeg;base64,/9j/4AAQ+w=="');
    expect(html).toContain('img.pick{cursor:crosshair}');
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script nonce="n0nce">']);
    expect(html).toContain("vscode.postMessage({type:'pick',shown:3,x:e.offsetX,y:e.offsetY,");
    // Without the pick, or without an image, no script and no hint.
    for (const view of [
      { image, caption: 'Paused', pick: null },
      { image: null, caption: 'The test went on.', pick: { shown: 3 } },
    ]) {
      const plain = pausedPageHtml(view, 'n');
      expect(plain).not.toContain('<script');
      expect(plain).not.toContain('script-src');
      expect(plain).not.toContain(PICK_HINT);
    }
  });

  test('picks on an image whose worker takes it and that names its viewport', () => {
    const image = { mime: 'image/jpeg' as const, data: 'AAAA', width: 1280, height: 800 };
    expect(picksOnImage(['pick', 'pick-at'], image)).toBe(true);
    expect(picksOnImage(['pick', 'view'], image)).toBe(false);
    expect(picksOnImage(['pick-at'], { mime: 'image/jpeg', data: 'AAAA' })).toBe(false);
    expect(picksOnImage(['pick-at'], null)).toBe(false);
  });

  test('maps a click on the image as shown to CSS pixels of the page, whatever size it is shown at', () => {
    const image = { mime: 'image/jpeg' as const, data: 'AAAA', width: 1280, height: 800 };
    const click = (x: number, y: number, width = 640, height = 400) => ({ shown: 1, x, y, width, height });
    expect(pagePoint(click(320, 100), image)).toEqual({ x: 640, y: 200 });
    // Shown larger than the viewport (an image taken at a device scale factor of 2, shown whole).
    expect(pagePoint(click(1001, 3, 2560, 1600), image)).toEqual({ x: 501, y: 2 });
    expect(pagePoint(click(640, 400), image)).toEqual({ x: 1279, y: 799 });
    expect(pagePoint(click(0, 0), image)).toEqual({ x: 0, y: 0 });
    for (const outside of [click(-1, 5), click(5, 401), click(5, 5, 0, 400)]) {
      expect(pagePoint(outside, image)).toBeNull();
    }
    expect(pagePoint(click(5, 5), { mime: 'image/jpeg', data: 'AAAA' })).toBeNull();
  });

  test('reads the script’s message field by field', () => {
    expect(imageClickOf({ type: 'pick', shown: 2, x: 1.5, y: 3, width: 640, height: 400 })).toEqual({
      shown: 2,
      x: 1.5,
      y: 3,
      width: 640,
      height: 400,
    });
    for (const message of [
      null,
      'pick',
      { type: 'other', shown: 2, x: 1, y: 3, width: 640, height: 400 },
      { type: 'pick', shown: 2, x: '1', y: 3, width: 640, height: 400 },
      { type: 'pick', shown: 2, x: Number.NaN, y: 3, width: 640, height: 400 },
      { type: 'pick', x: 1, y: 3, width: 640, height: 400 },
    ]) {
      expect(imageClickOf(message), JSON.stringify(message)).toBeNull();
    }
  });

  test('shows no image for anything but a JPEG in base64', () => {
    const quote = pausedPageHtml({ image: { mime: 'image/jpeg', data: 'AA"onerror="x' }, caption: 'c' }, 'n');
    expect(quote).not.toContain('<img');
    const png = pausedPageHtml({ image: { mime: 'image/png' as 'image/jpeg', data: 'AAAA' }, caption: 'c' }, 'n');
    expect(png).not.toContain('<img');
    expect(pausedPageHtml({ image: null, caption: 'The run ended.' }, 'n')).toContain('<p>The run ended.</p>');
    const huge = pausedPageHtml(
      { image: { mime: 'image/jpeg', data: 'A'.repeat(MAX_IMAGE_DATA + 4) }, caption: 'c' },
      'n',
    );
    expect(huge).not.toContain('<img');
  });
});

const ALL_TAKES: RunTake[] = ['pick', 'record', 'assert', 'assert-region', 'requests', 'mock', 'locator'];

const shown = (stop: RunStop, takes: RunTake[] = ALL_TAKES, test: RunTest | null = runTest()): ShownStop => ({
  ref: 'ed-1',
  worker: 0,
  slot: 0,
  stop,
  test,
  takes,
});

describe('a failure held for the editor', () => {
  const failed: RunStop = {
    ...stopAt(spec, 5),
    reason: 'failure',
    title: 'Failed: Timed out 5000ms waiting for click',
  };

  test('says how the test failed, with its own icon, and offers Resume alone among the controls', () => {
    expect(pausedText(failed, runTest(1))).toBe('Failed · Timed out 5000ms waiting for click · attempt 2');
    expect(stopIcon(failed)).toBe('$(error)');
    expect(stopIcon(stopAt(spec, 5))).toBe('$(debug-pause)');
    expect(stopControls(shown(failed)).map((c) => c.title)).toEqual(['Resume']);
    expect(stopControls(shown(stopAt(spec, 5))).map((c) => c.title)).toEqual([
      'Resume',
      'Step',
      'Run to cursor',
      'Finish',
    ]);
    expect(stopPick(shown(failed)).label).toBe('$(error) Failed · Timed out 5000ms waiting for click');
  });

  test('offers the code actions as any stop does', () => {
    expect(stopActions(shown(failed)).map((a) => a.title)).toEqual([
      'Pick a locator',
      'Record here',
      'Assert',
      'Assert a region',
      'Mock a request',
    ]);
  });
});

describe('the code actions at a stop', () => {
  test('are those the worker takes, the ones in the test’s window only where the pause bar shows', () => {
    expect(stopActions(shown(stopAt(spec, 5))).map((a) => a.action)).toEqual([
      'pick',
      'record',
      'assert',
      'assert-region',
      'mock',
    ]);
    expect(stopActions(shown(stopAt(spec, 5, false))).map((a) => a.action)).toEqual(['mock']);
    expect(stopActions(shown(stopAt(spec, 5), ['pick', 'record', 'requests'])).map((a) => a.action)).toEqual([
      'pick',
      'record',
    ]);
    expect(stopActions(shown(stopAt(spec, 5), []))).toEqual([]);
  });

  test('set the context keys and the status bar’s menu while a stop offers one', () => {
    const state = controlState(
      sessionsOf(
        session('ed-1', [worker(0, 'stopped', { stop: stopAt(spec, 5, false), takes: ['requests', 'mock'] })]),
      ),
    );
    expect(state.actions).toEqual(['mock']);
    expect(controlItems(state).map((i) => [i.command, i.tooltip])).toContainEqual([
      'piwi.codeAtStop',
      'Piwi: Write code at the stop: Mock a request',
    ]);
    const none = controlState(sessionsOf(session('ed-1', [worker(0, 'stopped', { stop: stopAt(spec, 5) })])));
    expect(controlItems(none).map((i) => i.command)).not.toContain('piwi.codeAtStop');
  });
});

describe('the responses Mock a request lists', () => {
  test('come latest first, by method and URL, with their status, type, size and time', () => {
    const picks = requestPicks([
      {
        id: 1,
        method: 'GET',
        url: 'http://localhost:3000/api/cart',
        status: 200,
        type: 'application/json',
        size: 12,
        time: 840,
      },
      { id: 2, method: 'POST', url: 'http://localhost:3000/api/pay', status: 402, type: '', size: null, time: 12_400 },
    ]);
    expect(picks).toEqual([
      { label: 'POST http://localhost:3000/api/pay', description: '402 · no type · no size · at 12.4 s', id: 2 },
      { label: 'GET http://localhost:3000/api/cart', description: '200 · application/json · 12 B · at 840 ms', id: 1 },
    ]);
  });

  test('name a size in bytes, kilobytes or megabytes', () => {
    expect([sizeText(0), sizeText(1023), sizeText(2048), sizeText(3 * 1024 * 1024), sizeText(null)]).toEqual([
      '0 B',
      '1023 B',
      '2.0 KB',
      '3.0 MB',
      'no size',
    ]);
    expect([timeText(0), timeText(999.6), timeText(1000)]).toEqual(['0 ms', '1000 ms', '1.0 s']);
  });
});

describe('the count of the locator at the cursor', () => {
  const answer = (
    count: number | null,
    ok = true,
    locator: string | null = "getByRole('button')",
  ): LocatorAtCaretResult => ({
    ok,
    message: ok ? `${count} elements match.` : 'The test is stopped on adminPage: page may be another page.',
    locator,
    count,
  });

  test('says the matches, or why it counted none, and nothing on a line holding no locator', () => {
    expect(caretText(answer(3))).toBe('3 matches');
    expect(caretText(answer(1))).toBe('1 match');
    expect(caretText(answer(0))).toBe('no match');
    expect(caretText(answer(null, false))).toBe('The test is stopped on adminPage: page may be another page.');
    expect(caretText(answer(null, false, null))).toBeNull();
  });

  /** A count asking `ask`, its answers given by hand; what it showed last. */
  function counting() {
    vi.useFakeTimers();
    const asked: Array<{ query: CaretQuery; resolve: (a: LocatorAtCaretResult | null) => void }> = [];
    let last: CaretShown | null = null;
    const counts = new CaretCounts(
      (query) => new Promise((resolve) => asked.push({ query, resolve })),
      (shown) => (last = shown),
    );
    const at = (line: number, since = 's1'): CaretQuery => ({ ref: 'ed-1', worker: 0, since, uri: spec, line });
    return { counts, asked, at, shown: () => last };
  }

  test('asks once the cursor settled, one request at a time, and drops an answer the cursor left', async () => {
    const { counts, asked, at, shown } = counting();
    try {
      counts.moved(at(3), 'a');
      counts.moved(at(4), 'b');
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS - 1);
      expect(asked).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(asked.map((a) => a.query.line)).toEqual([4]);
      // The cursor moves while the answer is on its way: nothing more is asked until it comes, and it is dropped.
      counts.moved(at(6), 'c');
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      expect(asked).toHaveLength(1);
      asked[0]!.resolve(answer(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(shown()).toBeNull();
      expect(asked.map((a) => a.query.line)).toEqual([4, 6]);
      asked[1]!.resolve(answer(3));
      await vi.advanceTimersByTimeAsync(0);
      expect(shown()).toEqual({ uri: spec, line: 6, text: '3 matches', brief: false });
      // The same line asks nothing again; an edit of it does.
      counts.moved(at(6), 'c');
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      expect(asked).toHaveLength(2);
      counts.moved(at(6), 'c2');
      expect(shown()).toBeNull();
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      expect(asked).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('asks again when the cursor comes back to a line it left before the count settled', async () => {
    const { counts, asked, at, shown } = counting();
    try {
      counts.moved(at(4), 'a');
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      asked[0]!.resolve(answer(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(shown()?.text).toBe('1 match');
      // Down a line and back, quicker than the count waits: the count shows again.
      counts.moved(at(5), 'b');
      await vi.advanceTimersByTimeAsync(50);
      counts.moved(at(4), 'a');
      expect(shown()).toBeNull();
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      expect(asked.map((a) => a.query.line)).toEqual([4, 4]);
      asked[1]!.resolve(answer(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(shown()).toEqual({ uri: spec, line: 4, text: '1 match', brief: false });
    } finally {
      vi.useRealTimers();
    }
  });

  test('shows a refusal for a moment, takes the outline down outside the stopped file, and stops with the stop', async () => {
    const { counts, asked, at, shown } = counting();
    try {
      counts.moved(at(3), 'a');
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      asked[0]!.resolve(answer(null, false));
      await vi.advanceTimersByTimeAsync(0);
      expect(shown()?.brief).toBe(true);
      await vi.advanceTimersByTimeAsync(CARET_REFUSAL_MS);
      expect(shown()).toBeNull();
      // The cursor left the stopped file: asked once with no line, which shows nothing.
      counts.moved({ ...at(3), uri: null, line: null });
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      expect(asked[1]!.query).toMatchObject({ uri: null, line: null });
      asked[1]!.resolve({ ok: true, message: 'The outline is gone.', locator: null, count: null });
      counts.moved({ ...at(3), uri: null, line: null });
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      expect(asked).toHaveLength(2);
      // Back on a line, then the stop ends: cleared at once, nothing asked.
      counts.moved(at(5), 'e');
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      asked[2]!.resolve(answer(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(shown()?.text).toBe('1 match');
      counts.moved(null);
      expect(shown()).toBeNull();
      await vi.advanceTimersByTimeAsync(CARET_WAIT_MS);
      expect(asked).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the code a stop makes', () => {
  const code = (extra: Partial<StopCode> = {}): StopCode => ({
    ref: 'ed-1',
    worker: 0,
    since: 's1',
    action: 'assert-region',
    uri: spec,
    version: 3,
    line: 4,
    code: "  await expect(page.getByTestId('summary')).toMatchAriaSnapshot(`\n    - text: x\n  `);",
    edits: [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
        newText: "import { expect } from '@playwright/test';\n",
      },
      { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }, newText: 'x\n' },
    ],
    message: "Piwi wrote the region's ARIA snapshot above checkout.spec.ts:5.",
    warnings: [],
    ...extra,
  });

  test('stands below the import lines written above it', () => {
    expect(writtenLines(code())).toEqual({ start: 5, end: 7 });
    expect(writtenLines(code({ edits: code().edits.slice(1), code: '  await x();' }))).toEqual({ start: 4, end: 4 });
  });

  test('says what it wrote, as a warning when its reader should check something', () => {
    expect(stopCodeNotice(code())).toEqual({
      severity: 'information',
      text: "Piwi wrote the region's ARIA snapshot above checkout.spec.ts:5.",
    });
    const mock = stopCodeNotice(
      code({
        message: 'Piwi wrote the mock above checkout.spec.ts:5.',
        warnings: ['2 values named or shaped like credentials are written as <hidden>.'],
      }),
    );
    expect(mock).toEqual({
      severity: 'warning',
      text: 'Piwi wrote the mock above checkout.spec.ts:5. 2 values named or shaped like credentials are written as <hidden>.',
    });
  });
});

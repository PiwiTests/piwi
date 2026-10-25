import { describe, expect, test } from 'vitest';
import type { RunSession, RunStop, RunTest, RunWorker } from '@piwitests/editor/protocol';
import {
  EditLog,
  MAX_IMAGE_DATA,
  breakpointUpdates,
  controlItems,
  controlState,
  lineEditOf,
  pausedPageHtml,
  pausedText,
  remember,
  runStarted,
  runTargetArg,
  spelledSession,
  stopKey,
  stopPick,
  stopsFor,
  stopsOf,
  targetStop,
  withSession,
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
    expect(controlState(new Map())).toEqual({ active: false, pausable: false, pausing: false, stopped: false });
    expect(controlItems(controlState(new Map()))).toEqual([]);
  });

  test('Pause and Stop while a test runs or a worker is between tests', () => {
    for (const state of ['running', 'between'] as const) {
      const shown = controlState(sessionsOf(session('ed-1', [worker(0, state)])));
      expect(shown).toEqual({ active: true, pausable: true, pausing: false, stopped: false });
      expect(controlItems(shown).map((i) => i.command)).toEqual(['piwi.pauseRun', 'piwi.stopRun']);
    }
  });

  test('Pausing… once a Pause reached the worker, and Stop alone while its test cannot stop', () => {
    const pausing = controlState(sessionsOf(session('ed-1', [worker(0, 'running', { pausing: true })])));
    expect(pausing).toEqual({ active: true, pausable: false, pausing: true, stopped: false });
    expect(controlItems(pausing).map((i) => [i.text, i.command])).toEqual([
      ['$(loading~spin) Pausing…', null],
      ['$(debug-stop)', 'piwi.stopRun'],
    ]);
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
    expect(shown).toEqual({ active: true, pausable: true, pausing: false, stopped: true });
    expect(controlItems(shown).map((i) => [i.command, i.tooltip])).toEqual([
      ['piwi.resumeRun', 'Piwi: Resume (F5)'],
      ['piwi.stepRun', 'Piwi: Step to the next call (F10)'],
      ['piwi.finishRun', 'Piwi: Finish the test without stopping again (Shift+F11)'],
      ['piwi.stopRun', 'Piwi: Stop the run (Shift+F5)'],
    ]);
  });
});

describe('a stop', () => {
  test('says what is about to run, and the attempt after the first', () => {
    expect(pausedText(stopAt(spec, 5), runTest())).toBe('⏸ Paused · Fill "WELCOME10" getByLabel(\'Coupon\')');
    expect(pausedText(stopAt(spec, 5), runTest(1))).toBe(
      '⏸ Paused · Fill "WELCOME10" getByLabel(\'Coupon\') · attempt 2',
    );
    expect(pausedText(stopAt(spec, 5), null)).toBe('⏸ Paused · Fill "WELCOME10" getByLabel(\'Coupon\')');
  });

  test('is each stopped worker of each run, told apart by its run, worker and time', () => {
    const a = stopAt(spec, 5);
    const b = stopAt(pageObject, 8);
    const stops = stopsOf(
      sessionsOf(
        session('ed-1', [worker(0, 'stopped', { stop: a }), worker(1, 'running')]),
        session('ed-2', [worker(3, 'stopped', { stop: b })]),
      ),
    );
    expect(stops.map((s) => [s.ref, s.worker, s.stop.line])).toEqual([
      ['ed-1', 0, 5],
      ['ed-2', 3, 8],
    ]);
    expect(new Set(stops.map(stopKey)).size).toBe(2);
    expect(stopPick(stops[1]!)).toEqual({
      label: '⏸ Paused · Fill "WELCOME10" getByLabel(\'Coupon\')',
      description: 'checkout › pays · checkout.page.ts:9 · worker 3',
    });
  });
});

describe('the stop a control acts on', () => {
  const one: ShownStop = { ref: 'ed-1', worker: 0, stop: stopAt(spec, 5), test: runTest() };
  const two: ShownStop = { ref: 'ed-1', worker: 1, stop: stopAt(pageObject, 8), test: runTest() };

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

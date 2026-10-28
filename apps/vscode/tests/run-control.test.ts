import { describe, expect, test, vi } from 'vitest';
import type {
  LocatorAtCaretResult,
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
  breakpointUpdates,
  caretText,
  controlItems,
  controlState,
  heardSession,
  imageClickOf,
  lineEditOf,
  linesAbove,
  PICK_HINT,
  pagePoint,
  pausedPageHtml,
  picksOnImage,
  pausedText,
  remember,
  requestPicks,
  runStarted,
  runTargetArg,
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
  takes: [],
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
      pausable: false,
      pausing: false,
      stopped: false,
      actions: [],
    });
    expect(controlItems(controlState(new Map()))).toEqual([]);
  });

  test('Pause and Stop while a test runs or a worker is between tests', () => {
    for (const state of ['running', 'between'] as const) {
      const shown = controlState(sessionsOf(session('ed-1', [worker(0, state)])));
      expect(shown).toEqual({ active: true, pausable: true, pausing: false, stopped: false, actions: [] });
      expect(controlItems(shown).map((i) => i.command)).toEqual(['piwi.pauseRun', 'piwi.stopRun']);
    }
  });

  test('Pausing… once a Pause reached the worker, and Stop alone while its test cannot stop', () => {
    const pausing = controlState(sessionsOf(session('ed-1', [worker(0, 'running', { pausing: true })])));
    expect(pausing).toEqual({ active: true, pausable: false, pausing: true, stopped: false, actions: [] });
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
    expect(shown).toEqual({ active: true, pausable: true, pausing: false, stopped: true, actions: [] });
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
    expect(pausedText(stopAt(spec, 5), runTest())).toBe('Paused · Fill "WELCOME10" getByLabel(\'Coupon\')');
    expect(pausedText(stopAt(spec, 5), runTest(1))).toBe(
      'Paused · Fill "WELCOME10" getByLabel(\'Coupon\') · attempt 2',
    );
    expect(pausedText(stopAt(spec, 5), null)).toBe('Paused · Fill "WELCOME10" getByLabel(\'Coupon\')');
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
      label: '$(debug-pause) Paused · Fill "WELCOME10" getByLabel(\'Coupon\')',
      description: 'checkout › pays · checkout.page.ts:9 · worker 3',
    });
  });
});

describe('the stop a control acts on', () => {
  const one: ShownStop = { ref: 'ed-1', worker: 0, stop: stopAt(spec, 5), test: runTest(), takes: [] };
  const two: ShownStop = { ref: 'ed-1', worker: 1, stop: stopAt(pageObject, 8), test: runTest(), takes: [] };

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
    expect(stopControls(failed).map((c) => c.title)).toEqual(['Resume']);
    expect(stopControls(stopAt(spec, 5)).map((c) => c.title)).toEqual(['Resume', 'Step', 'Run to cursor', 'Finish']);
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

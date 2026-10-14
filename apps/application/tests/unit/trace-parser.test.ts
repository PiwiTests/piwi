import { describe, test, expect } from 'vitest';
import { formatFailingActionSection, parseTraceEvents } from '../../server/utils/trace-parser';
import { pageActionOf, type ParsedTraceData, type TraceAction } from '../../server/utils/trace-events';
import { buildZip } from '../../server/utils/trace-zip';
import {
  caughtProbeTimeoutTrace,
  caughtProbeTrace,
  sameMessageProbeTrace,
  teardownAfterBodyTrace,
  type TraceFixture,
} from './fixtures/caught-error-traces';

/** Build a slim trace ZIP containing a `trace.trace` file made of the given JSONL lines. */
function buildTraceZip(events: unknown[], extraLines: string[] = []): Buffer {
  const lines = [...events.map((e) => JSON.stringify(e)), ...extraLines];
  return buildZip([{ name: 'trace.trace', data: Buffer.from(lines.join('\n'), 'utf8') }]);
}

/** Build a trace ZIP holding a fixture's runner and page event files, without the events `drop` names. */
function buildFixtureZip(fixture: TraceFixture, drop: string[] = []): Buffer {
  return buildZip(
    Object.entries(fixture).map(([name, events]) => ({
      name,
      data: Buffer.from(
        events
          .filter((e) => !drop.includes(String(e.type)))
          .map((e) => JSON.stringify(e))
          .join('\n'),
        'utf8',
      ),
    })),
  );
}

// Large limits so nothing truncates in these tests.
const MAX_TRACE_ACTIONS = 10;
const TRACE_DOM_CHARS = 6000;

/** Build a minimal TraceAction with only the fields under test. */
function makeAction(overrides: Partial<TraceAction> = {}): TraceAction {
  return {
    callId: 'call@1',
    apiName: 'locator.click',
    startTime: 1000,
    ...overrides,
  };
}

/** Build a ParsedTraceData whose single action is the failing one. */
function makeData(overrides: Partial<ParsedTraceData> = {}): ParsedTraceData {
  const failingAction = overrides.failingAction ?? makeAction();
  return {
    actions: [failingAction],
    consoleEntries: [],
    networkRequests: [],
    frameSnapshots: [],
    failingAction,
    failingActionIndex: 0,
    eventCount: 0,
    timeoutFallback: false,
    traceEndTime: 0,
    ...overrides,
  };
}

describe('formatFailingActionSection — timeout-fallback duration', () => {
  test('renders "ran ≥ Nms" from the trace timebase, with no Date.now artifacts', () => {
    const action = makeAction({ startTime: 1000, endTime: undefined });
    const data = makeData({
      failingAction: action,
      timeoutFallback: true,
      // Same timebase as startTime; last timestamp seen in the trace.
      traceEndTime: 4500,
    });

    const out = formatFailingActionSection(data, MAX_TRACE_ACTIONS, TRACE_DOM_CHARS);
    expect(out).not.toBeNull();

    // N = traceEndTime - startTime = 3500.
    expect(out).toContain('- Duration: ran ≥ 3500ms before the test was killed');

    // The duration comes from trace times, never from Date.now().
    expect(out).not.toContain('timed out after');
    expect(out).not.toContain('ms+');
    // No wall-clock leakage: a Date.now()-based value would be ~1.7e9 seconds.
    expect(out).not.toMatch(/Duration: timed out/);
    expect(out).not.toMatch(/ran ≥ \d{7,}ms/);
  });

  test('rounds the trace-timebase delta to whole milliseconds', () => {
    const action = makeAction({ startTime: 1000.2, endTime: undefined });
    const data = makeData({
      failingAction: action,
      timeoutFallback: true,
      traceEndTime: 4501.9, // delta 3501.7 → rounds to 3502
    });

    const out = formatFailingActionSection(data, MAX_TRACE_ACTIONS, TRACE_DOM_CHARS);
    expect(out).toContain('- Duration: ran ≥ 3502ms before the test was killed');
  });

  test('renders no duration line when traceEndTime <= startTime', () => {
    const action = makeAction({ startTime: 5000, endTime: undefined });

    // Equal timestamps (no later event observed).
    const equal = formatFailingActionSection(
      makeData({ failingAction: action, timeoutFallback: true, traceEndTime: 5000 }),
      MAX_TRACE_ACTIONS,
      TRACE_DOM_CHARS,
    );
    expect(equal).not.toBeNull();
    expect(equal).not.toContain('Duration:');

    // No timestamp found anywhere in the trace (traceEndTime === 0).
    const none = formatFailingActionSection(
      makeData({ failingAction: action, timeoutFallback: true, traceEndTime: 0 }),
      MAX_TRACE_ACTIONS,
      TRACE_DOM_CHARS,
    );
    expect(none).not.toContain('Duration:');
  });
});

describe('formatFailingActionSection — non-fallback duration (unchanged)', () => {
  test('uses endTime - startTime when the action completed', () => {
    const action = makeAction({ startTime: 1000, endTime: 1250 });
    const data = makeData({ failingAction: action, timeoutFallback: false, traceEndTime: 9999 });

    const out = formatFailingActionSection(data, MAX_TRACE_ACTIONS, TRACE_DOM_CHARS);
    // Duration comes from endTime, not traceEndTime.
    expect(out).toContain('- Duration: 250ms');
    expect(out).not.toContain('ran ≥');
  });
});

describe('formatFailingActionSection — additional rendering branches', () => {
  test('renders selector, URL, and values from action params', () => {
    const action = makeAction({ params: { selector: 'button.submit', url: 'https://x.test', values: ['a', 'b'] } });
    const out = formatFailingActionSection(makeData({ failingAction: action }), MAX_TRACE_ACTIONS, TRACE_DOM_CHARS);
    expect(out).toContain('- Selector: `button.submit`');
    expect(out).toContain('- URL: https://x.test');
    expect(out).toContain('- Values: a, b');
  });

  test('renders the error message and truncates the stack to 5 frames', () => {
    const stack = Array.from({ length: 8 }, (_, i) => `    at frame${i} (/app/x.ts:${i}:1)`).join('\n');
    const action = makeAction({ error: { message: 'locator not found', stack } });
    const out = formatFailingActionSection(makeData({ failingAction: action }), MAX_TRACE_ACTIONS, TRACE_DOM_CHARS);
    expect(out).toContain('- Error: locator not found');
    expect(out).toContain('frame0');
    expect(out).toContain('frame4');
    expect(out).not.toContain('frame5');
  });

  test('lists nearby actions with a FAILED marker on the failing one, bounded by maxTraceActions', () => {
    const failing = makeAction({ callId: 'call@3', apiName: 'locator.click' });
    const actions = [
      makeAction({ callId: 'call@1', apiName: 'page.goto' }),
      makeAction({ callId: 'call@2', apiName: 'locator.fill' }),
      failing,
    ];
    const out = formatFailingActionSection(
      makeData({ actions, failingAction: failing, failingActionIndex: 2 }),
      1, // only 1 action of lookback → drops page.goto
      TRACE_DOM_CHARS,
    );
    expect(out).toContain('### Actions Leading to Failure');
    expect(out).not.toContain('page.goto');
    expect(out).toContain('- locator.fill');
    expect(out).toContain('- locator.click ← FAILED');
  });

  test('includes console entries within the failure time window, and drops ones outside it', () => {
    const action = makeAction({ startTime: 10_000, endTime: 10_500 });
    const data = makeData({
      failingAction: action,
      consoleEntries: [
        { type: 'error', text: 'inside window', timestamp: 10_200 },
        { type: 'log', text: 'way before', timestamp: 0 },
      ],
    });
    const out = formatFailingActionSection(data, MAX_TRACE_ACTIONS, TRACE_DOM_CHARS);
    expect(out).toContain('### Console Around Failure');
    expect(out).toContain('[error] inside window');
    expect(out).not.toContain('way before');
  });

  test('includes network requests within the failure time window with status and duration', () => {
    const action = makeAction({ startTime: 10_000, endTime: 10_500 });
    const data = makeData({
      failingAction: action,
      networkRequests: [
        { url: 'https://api.test/x', method: 'GET', statusCode: 500, startTime: 10_100, endTime: 10_300 },
        { url: 'https://api.test/far', method: 'GET', startTime: 0, endTime: 0 },
      ],
    });
    const out = formatFailingActionSection(data, MAX_TRACE_ACTIONS, TRACE_DOM_CHARS);
    expect(out).toContain('### Network Requests Around Failure');
    expect(out).toContain('GET https://api.test/x → 500 (200ms)');
    expect(out).not.toContain('/far');
  });

  test('shows the log tail (not head) for a timeout fallback, truncated per-line by traceDomChars', () => {
    const log = Array.from({ length: 12 }, (_, i) => `entry ${i}`);
    const action = makeAction({ log });
    const out = formatFailingActionSection(
      makeData({ failingAction: action, timeoutFallback: true }),
      MAX_TRACE_ACTIONS,
      4, // cap each log line to 4 chars
    );
    expect(out).toContain('### Action Log — tail (12 entries total)');
    expect(out).toContain('entr…'); // truncated
    expect(out).not.toContain('entry 0\n'); // head entries dropped for tail view
  });
});

describe('parseTraceEvents', () => {
  test('returns null for a non-zip buffer', async () => {
    expect(await parseTraceEvents(Buffer.from('not a zip file'))).toBeNull();
  });

  test('returns null when there is no *.trace entry', async () => {
    const zip = buildZip([{ name: 'resources/other.txt', data: Buffer.from('x') }]);
    expect(await parseTraceEvents(zip)).toBeNull();
  });

  test('aggregates events across a real multi-file @playwright/test trace layout', async () => {
    // The runner trace holds the error-bearing action; the per-context file
    // holds the DOM frame-snapshot. Neither is named `trace.trace`.
    const jsonl = (events: unknown[]) => Buffer.from(events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
    const zip = buildZip([
      {
        name: 'test.trace',
        data: jsonl([
          { type: 'action', callId: 'c1', apiName: 'locator.click', startTime: 1000, error: { message: 'boom' } },
        ]),
      },
      {
        name: '0-trace.trace',
        data: jsonl([
          {
            type: 'frame-snapshot',
            snapshot: {
              snapshotName: 'after@call@1',
              frameId: 'frame@1',
              isMainFrame: true,
              html: ['HTML', {}, ['BODY', {}, 'hi']],
            },
          },
        ]),
      },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data).not.toBeNull();
    // Action came from test.trace…
    expect(data!.failingAction?.apiName).toBe('locator.click');
    // …and the DOM snapshot came from 0-trace.trace.
    expect(data!.frameSnapshots).toHaveLength(1);
    expect(data!.frameSnapshots[0]!.snapshotName).toBe('after@call@1');
  });

  test('orders test.trace before numbered context files regardless of ZIP order', async () => {
    const line = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');
    // Deliberately place context files before the runner file in the ZIP.
    const zip = buildZip([
      { name: '1-trace.trace', data: line({ type: 'action', callId: 'ctx1', apiName: 'page.goto', startTime: 500 }) },
      {
        name: '0-trace.trace',
        data: line({ type: 'action', callId: 'ctx0', apiName: 'locator.fill', startTime: 700 }),
      },
      {
        name: 'test.trace',
        data: line({ type: 'action', callId: 'runner', apiName: 'expect.toBeVisible', startTime: 100 }),
      },
    ]);
    const data = await parseTraceEvents(zip);
    // Sorted: test.trace (runner), then 0-trace.trace, then 1-trace.trace.
    expect(data!.actions.map((a) => a.apiName)).toEqual(['expect.toBeVisible', 'locator.fill', 'page.goto']);
  });

  test('parses action events and skips malformed/blank lines without throwing', async () => {
    const zip = buildTraceZip(
      [
        { type: 'action', callId: 'c1', apiName: 'locator.click', startTime: 1000, endTime: 1100 },
        { type: 'action', callId: 'c2', apiName: 'locator.fill', startTime: 1200, endTime: 1300 },
      ],
      ['{not valid json', ''],
    );
    const data = await parseTraceEvents(zip);
    expect(data).not.toBeNull();
    expect(data!.actions).toHaveLength(2);
    expect(data!.actions[0]!.apiName).toBe('locator.click');
    expect(data!.eventCount).toBe(2);
  });

  test('selects the error-bearing action even when a later action has no error', async () => {
    const zip = buildTraceZip([
      { type: 'action', callId: 'c1', apiName: 'locator.click', startTime: 1000, error: { message: 'boom' } },
      { type: 'action', callId: 'c2', apiName: 'locator.fill', startTime: 1200 },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.timeoutFallback).toBe(false);
    expect(data!.failingAction?.apiName).toBe('locator.click');
    expect(data!.failingAction?.error?.message).toBe('boom');
  });

  test('falls back to the last incomplete, error-free action when nothing errored', async () => {
    const zip = buildTraceZip([
      { type: 'action', callId: 'c1', apiName: 'page.goto', startTime: 1000, endTime: 1100 },
      { type: 'action', callId: 'c2', apiName: 'locator.click', startTime: 1200 }, // no endTime — the killed action
      { type: 'action', callId: 'c3', apiName: 'locator.fill', startTime: 1300, endTime: 1400 },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.timeoutFallback).toBe(true);
    expect(data!.failingAction?.apiName).toBe('locator.click');
  });

  test('tracks traceEndTime as the largest timestamp seen across all events', async () => {
    const zip = buildTraceZip([
      { type: 'action', callId: 'c1', apiName: 'locator.click', startTime: 1000, endTime: 1500 },
      { type: 'event', method: 'console', time: 9999, event: { text: 'late log' } },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.traceEndTime).toBe(9999);
  });

  test('extracts console events and pairs network create/update events into a single request', async () => {
    const zip = buildTraceZip([
      { type: 'event', method: 'console', time: 100, event: { type: 'error', text: 'console boom' } },
      { type: 'event', method: '__create__', time: 200, event: { url: 'https://api.test/y', method: 'POST' } },
      {
        type: 'event',
        method: '__update__',
        time: 300,
        event: { url: 'https://api.test/y', method: 'POST', response: { status: 201 } },
      },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.consoleEntries).toEqual([
      { type: 'error', text: 'console boom', timestamp: 100, location: undefined },
    ]);
    expect(data!.networkRequests).toHaveLength(1);
    expect(data!.networkRequests[0]).toMatchObject({ url: 'https://api.test/y', method: 'POST', statusCode: 201 });
  });
});

describe('parseTraceEvents — modern before/after event pairs', () => {
  test('merges before/after pairs into completed actions with class.method apiName', async () => {
    const zip = buildTraceZip([
      {
        type: 'before',
        callId: 'call@8',
        startTime: 1548.6,
        class: 'Frame',
        method: 'goto',
        params: { url: 'https://x.test/checkout' },
        pageId: 'page@1',
        beforeSnapshot: 'before@call@8',
      },
      { type: 'after', callId: 'call@8', endTime: 1900.2, afterSnapshot: 'after@call@8' },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.actions).toHaveLength(1);
    expect(data!.actions[0]).toMatchObject({
      callId: 'call@8',
      apiName: 'Frame.goto',
      startTime: 1548.6,
      endTime: 1900.2,
      beforeSnapshot: 'before@call@8',
      afterSnapshot: 'after@call@8',
      pageId: 'page@1',
    });
    expect(data!.actions[0]!.params).toEqual({ url: 'https://x.test/checkout' });
  });

  test('prefers an explicit apiName over class.method when present', async () => {
    const zip = buildTraceZip([
      { type: 'before', callId: 'c1', startTime: 1, apiName: 'page.goto', class: 'Frame', method: 'goto' },
      { type: 'after', callId: 'c1', endTime: 2 },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.actions[0]!.apiName).toBe('page.goto');
  });

  test('selects the failing action from an error carried by the after event (flat and nested shapes)', async () => {
    const zip = buildTraceZip([
      { type: 'before', callId: 'c1', startTime: 100, class: 'Frame', method: 'click' },
      { type: 'after', callId: 'c1', endTime: 200 },
      { type: 'before', callId: 'c2', startTime: 300, class: 'Frame', method: 'waitForSelector' },
      {
        type: 'after',
        callId: 'c2',
        endTime: 1800,
        error: {
          message: 'Timeout 1500ms exceeded.',
          stack: 'TimeoutError: Timeout 1500ms exceeded.',
          name: 'TimeoutError',
        },
      },
      { type: 'before', callId: 'c3', startTime: 2000, class: 'Frame', method: 'fill' },
      { type: 'after', callId: 'c3', endTime: 2100, error: { error: { message: 'nested boom' } } },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.timeoutFallback).toBe(false);
    expect(data!.actions[1]!.error?.message).toBe('Timeout 1500ms exceeded.');
    expect(data!.actions[2]!.error?.message).toBe('nested boom');
    // No test-level error names the fatal one: the test went on after c2, so c3 failed it.
    expect(data!.failingAction?.callId).toBe('c3');
  });

  test('appends standalone log events to the open action and keeps the timeout fallback working', async () => {
    const zip = buildTraceZip([
      { type: 'before', callId: 'c1', startTime: 100, class: 'Frame', method: 'goto' },
      { type: 'after', callId: 'c1', endTime: 200 },
      { type: 'before', callId: 'c2', startTime: 300, class: 'Frame', method: 'waitForSelector' },
      { type: 'log', callId: 'c2', time: 350, message: 'waiting for locator("#pay")' },
      { type: 'log', callId: 'c2', time: 400, message: 'still waiting' },
      // No `after` for c2 — the test was killed mid-call.
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.timeoutFallback).toBe(true);
    expect(data!.failingAction?.callId).toBe('c2');
    expect(data!.failingAction?.endTime).toBeUndefined();
    expect(data!.failingAction?.log).toEqual(['waiting for locator("#pay")', 'still waiting']);
  });

  test('folds a self-contained action event into the open action instead of duplicating it', async () => {
    const zip = buildTraceZip([
      { type: 'before', callId: 'c1', startTime: 100, pointers: { beforeSnapshot: 'before@c1' } },
      {
        type: 'action',
        callId: 'c1',
        apiName: 'locator.click',
        startTime: 100,
        endTime: 250,
        pointers: { afterSnapshot: 'after@c1' },
      },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.actions).toHaveLength(1);
    expect(data!.actions[0]).toMatchObject({
      callId: 'c1',
      apiName: 'locator.click',
      endTime: 250,
      beforeSnapshot: 'before@c1',
      afterSnapshot: 'after@c1',
    });
  });

  test('legacy action-only traces parse exactly as before the before/after support', async () => {
    const zip = buildTraceZip([
      { type: 'action', callId: 'c1', apiName: 'locator.click', startTime: 1000, endTime: 1100 },
      { type: 'action', callId: 'c2', apiName: 'locator.fill', startTime: 1200, error: { message: 'boom' } },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.actions).toHaveLength(2);
    expect(data!.failingAction?.callId).toBe('c2');
    expect(data!.timeoutFallback).toBe(false);
  });
});

describe('parseTraceEvents — 1.63 aria/screen snapshot events', () => {
  test('keys before/after aria and screenshot files onto their action', async () => {
    const zip = buildTraceZip([
      { type: 'before', callId: 'call@8', startTime: 100, class: 'Frame', method: 'click', pageId: 'page@1' },
      { type: 'aria-snapshot', callId: 'call@8', phase: 'before', pageId: 'page@1', file: 'aria/call@8-before.json' },
      {
        type: 'screenshot',
        callId: 'call@8',
        phase: 'before',
        pageId: 'page@1',
        file: 'screenshots/call@8-before.png',
      },
      { type: 'aria-snapshot', callId: 'call@8', phase: 'after', pageId: 'page@1', file: 'aria/call@8-after.json' },
      { type: 'screenshot', callId: 'call@8', phase: 'after', pageId: 'page@1', file: 'screenshots/call@8-after.png' },
      { type: 'after', callId: 'call@8', endTime: 200 },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.actions[0]).toMatchObject({
      callId: 'call@8',
      ariaSnapshotBefore: 'aria/call@8-before.json',
      ariaSnapshotAfter: 'aria/call@8-after.json',
      screenshotBefore: 'screenshots/call@8-before.png',
      screenshotAfter: 'screenshots/call@8-after.png',
    });
  });

  test('folds the input-time action phase into after; the real after wins', async () => {
    const zip = buildTraceZip([
      { type: 'before', callId: 'c1', startTime: 100, class: 'Frame', method: 'click' },
      { type: 'aria-snapshot', callId: 'c1', phase: 'action', file: 'aria/c1-action.json' },
      { type: 'aria-snapshot', callId: 'c1', phase: 'after', file: 'aria/c1-after.json' },
      { type: 'screenshot', callId: 'c1', phase: 'action', file: 'screenshots/c1-action.png' },
      // A snapshot for a call that never opened is ignored, not crashed on.
      { type: 'screenshot', callId: 'ghost', phase: 'before', file: 'screenshots/ghost-before.png' },
      { type: 'after', callId: 'c1', endTime: 200 },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.actions).toHaveLength(1);
    // `after` arrives last and wins; the lone action-phase screenshot fills after.
    expect(data!.actions[0]!.ariaSnapshotAfter).toBe('aria/c1-after.json');
    expect(data!.actions[0]!.screenshotAfter).toBe('screenshots/c1-action.png');
    expect(data!.actions[0]!.ariaSnapshotBefore).toBeUndefined();
  });

  test("keys an input event's mouse point onto its action, the last one winning", async () => {
    const zip = buildTraceZip([
      { type: 'before', callId: 'c1', startTime: 100, class: 'Frame', method: 'click' },
      // 1.60–1.62 name the input-time snapshot; 1.63 adds the target's box.
      { type: 'input', callId: 'c1', point: { x: 147.88, y: 225.5 }, inputSnapshot: 'input@c1' },
      { type: 'input', callId: 'c1', point: { x: 147.88, y: 207.5 }, box: { x: 120, y: 200, width: 50, height: 20 } },
      { type: 'after', callId: 'c1', endTime: 200 },
      { type: 'before', callId: 'c2', startTime: 300, class: 'Page', method: 'keyboardPress' },
      { type: 'input', callId: 'c2' },
      { type: 'after', callId: 'c2', endTime: 400 },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.actions[0]!.point).toEqual({ x: 147.88, y: 207.5 });
    expect(data!.actions[1]!.point).toBeUndefined();
  });

  test('a 1.61 trace with no snapshot events leaves the fields unset', async () => {
    const zip = buildTraceZip([
      { type: 'before', callId: 'c1', startTime: 100, class: 'Frame', method: 'click' },
      { type: 'after', callId: 'c1', endTime: 200 },
    ]);
    const data = await parseTraceEvents(zip);
    expect(data!.actions[0]!.ariaSnapshotBefore).toBeUndefined();
    expect(data!.actions[0]!.screenshotAfter).toBeUndefined();
  });
});

describe('parseTraceEvents — a run with several errored actions', () => {
  test('picks the assertion that failed the test, not the probe the test caught before it', async () => {
    const data = (await parseTraceEvents(buildFixtureZip(caughtProbeTrace)))!;
    expect(data.failingAction).toMatchObject({ callId: 'expect@48', apiName: 'Test.expect' });
    expect(data.failingAction?.error?.message).toBe('Error: expect(locator).toBeEnabled() failed');
    expect(data.timeoutFallback).toBe(false);
  });

  test('tells caught probes that read the same error apart by where the test error was thrown', async () => {
    const data = (await parseTraceEvents(buildFixtureZip(sameMessageProbeTrace)))!;
    expect(data.failingAction?.callId).toBe('expect@48');
    expect(data.failingAction?.location).toMatchObject({ line: 39, column: 65 });
  });

  test('stays on the test body when the teardown fails after it', async () => {
    const data = (await parseTraceEvents(buildFixtureZip(teardownAfterBodyTrace)))!;
    expect(data.failingAction?.callId).toBe('expect@45');
    expect(data.failingAction?.location).toMatchObject({ line: 56, column: 62 });
  });

  test('is the action the test timeout interrupted', async () => {
    const data = (await parseTraceEvents(buildFixtureZip(caughtProbeTimeoutTrace)))!;
    expect(data.failingAction).toMatchObject({ callId: 'pw:api@46', apiName: 'Test.pw:api' });
  });

  test('without test-level error events, is the latest errored runner action', async () => {
    const data = (await parseTraceEvents(buildFixtureZip(caughtProbeTrace, ['error'])))!;
    expect(data.failingAction?.callId).toBe('expect@48');
  });

  test('pairs the runner action with the page call it drove', async () => {
    const data = (await parseTraceEvents(buildFixtureZip(caughtProbeTrace)))!;
    expect(pageActionOf(data, data.failingAction)).toMatchObject({ callId: 'call@17', apiName: 'Frame.expect' });
    expect(pageActionOf(data, pageActionOf(data, data.failingAction))).toBeNull();
    const teardown = (await parseTraceEvents(buildFixtureZip(teardownAfterBodyTrace)))!;
    expect(pageActionOf(teardown, teardown.failingAction)?.callId).toBe('call@13');
  });

  test('the AI section ends on the failing assertion and marks the caught probe', async () => {
    const data = (await parseTraceEvents(buildFixtureZip(caughtProbeTrace)))!;
    const out = formatFailingActionSection(data, MAX_TRACE_ACTIONS, TRACE_DOM_CHARS)!;
    expect(out).toContain('- Error: Error: expect(locator).toBeEnabled() failed');
    const leading = out.split('### Actions Leading to Failure\n')[1]!.split('\n\n')[0]!.split('\n');
    expect(leading.slice(-5)).toEqual([
      '- Test.pw:api',
      '- Test.expect (error caught, the test continued)',
      '- Test.pw:api',
      '- Test.test.step',
      '- Test.expect ← FAILED',
    ]);
  });
});

import { describe, test, expect } from 'vitest';
import {
  buildFailureTimeline,
  TIMELINE_WINDOW_LEAD_MS,
  TIMELINE_WINDOW_TRAIL_MS,
  type FailureTimelineInput,
} from '#shared/failure-timeline';

const T0 = 1_700_000_000_000;

/** A failing execution whose steps carry real epoch start times. */
function realTimestampInput(): FailureTimelineInput {
  return {
    startedAt: T0,
    duration: 5_000,
    status: 'failed',
    steps: [
      { title: 'navigate', category: 'action', duration: 1_000, startTime: T0 },
      { title: 'fill email', category: 'action', duration: 500, startTime: T0 + 1_000 },
      {
        title: "click getByRole('button', { name: 'Pay' })",
        category: 'action',
        duration: 3_500,
        startTime: T0 + 1_500,
        error: 'element is not enabled',
      },
    ],
    consoleLogs: [{ type: 'warning', text: 'price quote still pending…', timestamp: T0 + 3_000, location: 'app.js:1' }],
    networkRequests: [
      {
        method: 'GET',
        url: '/api/quote',
        status: 504,
        duration: 1_500,
        startTime: T0 + 2_000,
        serverLogs: [{ timestamp: T0 + 3_400, level: 'error', message: 'quote upstream timed out' }],
      },
    ],
  };
}

describe('buildFailureTimeline', () => {
  test('places steps, console, network and backend on one clock from real timestamps', () => {
    const tl = buildFailureTimeline(realTimestampInput());

    expect(tl.origin).toBe(T0);
    expect(tl.estimated).toBe(false);
    expect(tl.lanes.steps).toHaveLength(3);
    expect(tl.lanes.console).toHaveLength(1);
    expect(tl.lanes.network).toHaveLength(1);
    expect(tl.lanes.backend).toHaveLength(1);

    // Positions are relative to origin.
    expect(tl.lanes.console[0]!.at).toBe(3_000);
    expect(tl.lanes.network[0]!.at).toBe(2_000);
    expect(tl.lanes.network[0]!.duration).toBe(1_500);
    expect(tl.lanes.backend[0]!.at).toBe(3_400);

    // Refs point back at the page section and index.
    expect(tl.lanes.console[0]!.ref).toEqual({ section: 'console', index: 0 });
    expect(tl.lanes.network[0]!.ref).toEqual({ section: 'networkRequests', index: 0 });
    expect(tl.lanes.backend[0]!.ref).toEqual({ section: 'backendLogs', index: 0 });
  });

  test('identifies the failed step (error set) and puts failureAt at its end', () => {
    const tl = buildFailureTimeline(realTimestampInput());
    expect(tl.failedStep).toEqual({
      index: 2,
      label: "click getByRole('button', { name: 'Pay' })",
      at: 1_500,
      duration: 3_500,
    });
    expect(tl.failureAt).toBe(5_000);
    expect(tl.lanes.steps[2]!.failed).toBe(true);
    expect(tl.lanes.steps[0]!.failed).toBeUndefined();
  });

  test('labels a 1.63-shaped step by composing its title and subtitle', () => {
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 2_000,
      status: 'failed',
      steps: [
        {
          title: 'Click',
          subtitle: "getByRole('button', { name: 'Pay' })",
          category: 'action',
          duration: 2_000,
          startTime: T0,
          error: 'element is not enabled',
        },
      ],
    });
    expect(tl.lanes.steps[0]!.label).toBe("Click getByRole('button', { name: 'Pay' })");
    expect(tl.failedStep?.label).toBe("Click getByRole('button', { name: 'Pay' })");
  });

  test('falls back to the last step of a failed execution when nothing is marked', () => {
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 2_000,
      status: 'timedout',
      steps: [
        { title: 'a', category: 'action', duration: 1_000, startTime: T0 },
        { title: 'b', category: 'action', duration: 1_000, startTime: T0 + 1_000 },
      ],
    });
    expect(tl.failedStep?.index).toBe(1);
    expect(tl.failureAt).toBe(2_000);
  });

  test('estimates step positions cumulatively when start times are missing', () => {
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 3_000,
      status: 'failed',
      steps: [
        { title: 'a', category: 'action', duration: 1_000 },
        { title: 'b', category: 'action', duration: 2_000 },
      ],
    });
    expect(tl.estimated).toBe(true);
    expect(tl.lanes.steps[0]!.at).toBe(0);
    expect(tl.lanes.steps[1]!.at).toBe(1_000);
    expect(tl.lanes.steps[1]!.duration).toBe(2_000);
    // Last step of a failed run is the failure; its end is failureAt.
    expect(tl.failureAt).toBe(3_000);
  });

  test('uses the trace anchor end for failureAt when no step failed', () => {
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 4_000,
      status: 'failed',
      steps: [],
      traceAnchor: { failingActionStart: T0 + 2_500, failingActionEnd: T0 + 3_200 },
    });
    expect(tl.failedStep).toBeNull();
    expect(tl.failureAt).toBe(3_200);
  });

  test('falls back to startedAt + duration when there is no failure anchor at all', () => {
    const tl = buildFailureTimeline({ startedAt: T0, duration: 4_000, status: 'failed', steps: [] });
    expect(tl.failedStep).toBeNull();
    expect(tl.failureAt).toBe(4_000);
  });

  test('a console line 20 s before the failure still lands inside the default window', () => {
    const failAt = T0 + 30_000;
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 30_000,
      status: 'failed',
      steps: [{ title: 'long click', category: 'action', duration: 30_000, startTime: T0, error: 'timeout' }],
      consoleLogs: [{ type: 'warning', text: '20s before', timestamp: failAt - 20_000, location: 'x' }],
    });
    // Failed step spans the whole run, so its lead pulls the window start back
    // to (0) and the console line at t+10s is inside [start, end].
    const line = tl.lanes.console[0]!;
    expect(line.at).toBe(10_000);
    expect(line.at).toBeGreaterThanOrEqual(tl.window.start);
    expect(line.at).toBeLessThanOrEqual(tl.window.end);
  });

  test('the default window is the failed step plus lead/trail, clamped to the execution', () => {
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 20_000,
      status: 'failed',
      steps: [
        { title: 'a', category: 'action', duration: 15_000, startTime: T0 },
        { title: 'b', category: 'action', duration: 2_000, startTime: T0 + 15_000, error: 'boom' },
      ],
    });
    // Failed step at 15_000 for 2_000: start = 15000 - lead, end = 17000 + trail.
    expect(tl.window.start).toBe(15_000 - TIMELINE_WINDOW_LEAD_MS);
    expect(tl.window.end).toBe(15_000 + 2_000 + TIMELINE_WINDOW_TRAIL_MS);
    // Trail is clamped to the execution span (20_000), never past it.
    expect(tl.window.end).toBeLessThanOrEqual(tl.end - tl.origin);
  });

  test('the whole execution is the window when no step failed', () => {
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 4_000,
      status: 'passed',
      steps: [{ title: 'a', category: 'action', duration: 4_000, startTime: T0 }],
    });
    expect(tl.window).toEqual({ start: 0, end: 4_000 });
  });

  test('items are ordered within each lane by start time', () => {
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 3_000,
      status: 'failed',
      steps: [],
      consoleLogs: [
        { type: 'log', text: 'second', timestamp: T0 + 2_000, location: 'x' },
        { type: 'log', text: 'first', timestamp: T0 + 500, location: 'x' },
      ],
    });
    // Console entries keep source order; their `at` reflects the timestamps so
    // the merged view (which sorts) can interleave lanes correctly.
    expect(tl.lanes.console.map((c) => c.at)).toEqual([2_000, 500]);
    const merged = [...tl.lanes.console].sort((a, b) => a.at - b.at);
    expect(merged.map((c) => c.label)).toEqual(['first', 'second']);
  });

  test('items with no usable timestamp are listed as unplaced with a reason', () => {
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 2_000,
      status: 'failed',
      steps: [],
      consoleLogs: [{ type: 'log', text: 'no clock', location: 'x' }],
      networkRequests: [
        {
          method: 'GET',
          url: '/legacy',
          status: 200,
          duration: 100,
          serverLogs: [{ level: 'info', message: 'no log clock' }],
        },
      ],
    });
    expect(tl.lanes.console).toHaveLength(0);
    expect(tl.lanes.network).toHaveLength(0);
    expect(tl.unplaced).toContainEqual({ section: 'console', label: 'no clock', reason: 'no timestamp' });
    expect(tl.unplaced).toContainEqual({
      section: 'networkRequests',
      label: 'GET /legacy',
      reason: 'no start time recorded',
    });
    expect(tl.unplaced).toContainEqual({ section: 'backendLogs', label: 'no log clock', reason: 'no timestamp' });
  });

  test('never throws on empty or malformed input', () => {
    expect(() => buildFailureTimeline({})).not.toThrow();
    const empty = buildFailureTimeline({});
    expect(empty.origin).toBe(0);
    expect(empty.lanes).toEqual({ steps: [], console: [], network: [], backend: [], dialogs: [] });
    expect(empty.window).toEqual({ start: 0, end: 0 });

    expect(() =>
      buildFailureTimeline({
        startedAt: 'nope' as unknown as number,
        steps: 'not an array' as unknown,
        consoleLogs: [null, 42] as unknown,
        networkRequests: [{ serverLogs: 'bad' }] as unknown,
      }),
    ).not.toThrow();
  });

  test('no placed item lands before t+0 even when captures predate startedAt', () => {
    const tl = buildFailureTimeline({
      startedAt: T0,
      duration: 2_000,
      status: 'failed',
      steps: [],
      consoleLogs: [{ type: 'log', text: 'early', timestamp: T0 - 500, location: 'x' }],
    });
    expect(tl.origin).toBe(T0 - 500);
    for (const item of tl.lanes.console) expect(item.at).toBeGreaterThanOrEqual(0);
  });

  test("testStart is the test's own start on the timeline's clock", () => {
    expect(buildFailureTimeline(realTimestampInput()).testStart).toBe(0);

    // A backend log 3 s before startedAt moves the origin, and testStart with it.
    const input = realTimestampInput();
    input.networkRequests = [{ method: 'GET', url: '/api/session', status: 200, duration: 100, startTime: T0 - 3_000 }];
    const tl = buildFailureTimeline(input);
    expect(tl.origin).toBe(T0 - 3_000);
    expect(tl.testStart).toBe(3_000);
    expect(tl.lanes.steps[0]!.at).toBe(3_000);

    // Without startedAt, the test starts at the origin.
    expect(buildFailureTimeline({ ...input, startedAt: null }).testStart).toBe(0);
    expect(buildFailureTimeline({}).testStart).toBe(0);
  });

  describe('call-site origin and group', () => {
    test('derives the enclosing method and caller chain from trace frames', () => {
      const tl = buildFailureTimeline({
        startedAt: T0,
        duration: 2_000,
        status: 'failed',
        specFile: 'tests/checkout.spec.ts',
        steps: [
          {
            title: 'click Pay',
            category: 'action',
            duration: 2_000,
            startTime: T0,
            location: 'pages/checkout.ts:42:10',
            error: 'not enabled',
          },
        ],
        traceCallsites: [
          {
            location: 'pages/checkout.ts:42',
            frames: [
              { file: 'pages/checkout.ts', line: 42, function: 'CheckoutPage.pay', inProject: true },
              { file: 'tests/checkout.spec.ts', line: 23, function: 'test body', inProject: true },
              { file: 'node_modules/@playwright/test/index.js', line: 9, function: 'Runner', inProject: false },
            ],
          },
        ],
      });
      const step = tl.lanes.steps[0]!;
      expect(step.origin).toEqual({
        file: 'pages/checkout.ts',
        line: 42,
        function: 'CheckoutPage.pay',
        chain: [{ file: 'tests/checkout.spec.ts', line: 23, function: 'test body' }],
      });
      // With no test.step, the method name is the group.
      expect(step.group).toBe('CheckoutPage.pay');
    });

    test('falls back to the reporter call-site location when there is no trace', () => {
      const tl = buildFailureTimeline({
        startedAt: T0,
        duration: 1_000,
        status: 'failed',
        specFile: 'tests/checkout.spec.ts',
        steps: [
          { title: 'goto', category: 'action', duration: 1_000, startTime: T0, location: 'pages/checkout.ts:12:3' },
        ],
      });
      const step = tl.lanes.steps[0]!;
      expect(step.origin).toEqual({ file: 'pages/checkout.ts', line: 12, function: null, chain: [] });
      // No trace ⇒ no function name ⇒ no method group without a test.step.
      expect(step.group).toBeNull();
    });

    test('groups actions under the enclosing test.step title', () => {
      const tl = buildFailureTimeline({
        startedAt: T0,
        duration: 3_000,
        status: 'failed',
        steps: [
          { title: 'Pay for the order', category: 'test.step', duration: 3_000, startTime: T0 },
          { title: 'fill card', category: 'action', duration: 1_000, startTime: T0, location: 'pages/checkout.ts:8:1' },
          {
            title: 'click Pay',
            category: 'action',
            duration: 2_000,
            startTime: T0 + 1_000,
            location: 'pages/checkout.ts:12:1',
            error: 'boom',
          },
        ],
      });
      expect(tl.lanes.steps[1]!.group).toBe('Pay for the order');
      expect(tl.lanes.steps[2]!.group).toBe('Pay for the order');
      // The test.step entry heads its own group.
      expect(tl.lanes.steps[0]!.group).toBe('Pay for the order');
    });

    test('leaves origin null and group null when there is no call data', () => {
      const tl = buildFailureTimeline({
        startedAt: T0,
        duration: 1_000,
        status: 'failed',
        steps: [{ title: 'a', category: 'action', duration: 1_000, startTime: T0 }],
      });
      expect(tl.lanes.steps[0]!.origin).toBeNull();
      expect(tl.lanes.steps[0]!.group).toBeNull();
    });
  });
});

describe('stops at the pause bar', () => {
  /** A test held 4 s at a breakpoint before its click, which failed after the stop. */
  function pausedInput(): FailureTimelineInput {
    return {
      startedAt: T0,
      duration: 1_600,
      status: 'failed',
      steps: [
        { title: 'navigate', category: 'navigation', duration: 500, startTime: T0 },
        { title: 'click Pay', category: 'action', duration: 4_100, startTime: T0 + 500, error: 'not enabled' },
      ],
      stepEvents: [
        { title: 'Before Hooks', category: 'hook', startedAt: T0, duration: 0, status: 'passed' },
        {
          title: "Click getByRole('button')",
          category: 'pause',
          startedAt: T0 + 520,
          duration: 4_000,
          status: 'breakpoint',
          location: 'tests/pay.spec.ts:12:5',
        },
      ],
      networkRequests: [{ method: 'GET', url: '/api/quote', status: 200, duration: 100, startTime: T0 + 4_550 }],
    };
  }

  test('keeps every timestamp on its clock, and places each stop as a band', () => {
    const tl = buildFailureTimeline(pausedInput());
    expect(tl.pauses).toEqual([
      {
        id: 'pause-1',
        at: 520,
        duration: 4_000,
        label: "Click getByRole('button')",
        reason: 'breakpoint',
        location: 'tests/pay.spec.ts:12:5',
      },
    ]);
    expect(tl.lanes.steps.map((step) => [step.at, step.duration])).toEqual([
      [0, 500],
      [500, 4_100],
    ]);
    expect(tl.lanes.network[0]!.at).toBe(4_550);
    expect(tl.failureAt).toBe(4_600);
  });

  test('says how long each step stood paused, and nothing for the steps that ran outside a stop', () => {
    const [navigate, click] = buildFailureTimeline(pausedInput()).lanes.steps;
    expect(navigate!.paused).toBeUndefined();
    expect(click!.paused).toBe(4_000);
  });

  test('has no band for a test that never stood paused, nor for an old reporter’s run', () => {
    expect(buildFailureTimeline(realTimestampInput()).pauses).toEqual([]);
    const input = pausedInput();
    input.stepEvents = [{ title: 'broken', category: 'pause', startedAt: 'soon', duration: 1 }];
    expect(buildFailureTimeline(input).pauses).toEqual([]);
    expect(buildFailureTimeline({}).pauses).toEqual([]);
  });
});

describe('dialogs lane', () => {
  test('places a dialog by its close time and refs the dialogs section', () => {
    const tl = buildFailureTimeline({
      ...realTimestampInput(),
      dialogs: [{ type: 'confirm', message: 'Stay signed in?', closedAt: T0 + 4_000 }],
    });
    expect(tl.lanes.dialogs).toHaveLength(1);
    expect(tl.lanes.dialogs[0]!.at).toBe(4_000);
    expect(tl.lanes.dialogs[0]!.kind).toBe('dialogs');
    expect(tl.lanes.dialogs[0]!.label).toBe('confirm: Stay signed in?');
    expect(tl.lanes.dialogs[0]!.ref).toEqual({ section: 'dialogs', index: 0 });
  });

  test('a dialog without a timestamp is reported as unplaced', () => {
    const tl = buildFailureTimeline({
      ...realTimestampInput(),
      dialogs: [{ type: 'alert', message: 'No time' }],
    });
    expect(tl.lanes.dialogs).toHaveLength(0);
    expect(tl.unplaced.some((u) => u.section === 'dialogs')).toBe(true);
  });

  test('no dialogs leaves the lane empty', () => {
    expect(buildFailureTimeline(realTimestampInput()).lanes.dialogs).toEqual([]);
  });
});

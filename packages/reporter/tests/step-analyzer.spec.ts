import { describe, it, expect } from 'vitest';
import {
  categorizeStep,
  flattenSteps,
  collectStepMetrics,
  percentile,
  computePerformanceSummary,
  extractTestStepEvents,
  extractWaitEvents,
  stepLabel,
  stepLabelParts,
  orderedStepParams,
  MAX_STEP_PARAM_KEYS,
  MAX_STEP_PARAM_VALUE_CHARS,
  MAX_SECTION_HOOKS,
} from '@piwitests/core/step-analysis';

describe('categorizeStep', () => {
  it('returns "other" for empty title', () => {
    expect(categorizeStep('')).toBe('other');
  });

  it('passes through hook/fixture pwCategory verbatim', () => {
    expect(categorizeStep('Before Hooks', 'hook')).toBe('hook');
    expect(categorizeStep('fixture: browser', 'fixture')).toBe('fixture');
  });

  it('classifies navigation steps', () => {
    expect(categorizeStep('page.goto')).toBe('navigation');
    expect(categorizeStep('Page.goto')).toBe('navigation');
    expect(categorizeStep('page.reload')).toBe('navigation');
    expect(categorizeStep('page.goBack')).toBe('navigation');
    expect(categorizeStep('page.goForward')).toBe('navigation');
  });

  it('classifies action steps', () => {
    expect(categorizeStep('locator.click')).toBe('action');
    expect(categorizeStep('locator.dblclick')).toBe('action');
    expect(categorizeStep('locator.check')).toBe('action');
    expect(categorizeStep('locator.uncheck')).toBe('action');
    expect(categorizeStep('locator.selectOption')).toBe('action');
    expect(categorizeStep('locator.tap')).toBe('action');
  });

  it('classifies input steps', () => {
    expect(categorizeStep('locator.fill')).toBe('input');
    expect(categorizeStep('locator.type')).toBe('input');
    expect(categorizeStep('locator.press')).toBe('input');
    expect(categorizeStep('locator.clear')).toBe('input');
    expect(categorizeStep('locator.setInputFiles')).toBe('input');
  });

  it('classifies assertions', () => {
    expect(categorizeStep('expect.toBeVisible')).toBe('assertion');
    expect(categorizeStep('locator.expect.toBeVisible')).toBe('assertion');
    expect(categorizeStep('page.expect')).toBe('assertion');
  });

  it('classifies wait steps (legacy api-path titles)', () => {
    expect(categorizeStep('locator.waitFor')).toBe('wait');
    expect(categorizeStep('page.waitFor')).toBe('wait');
    expect(categorizeStep('page.waitForLoadState')).toBe('wait');
    expect(categorizeStep('page.waitForURL')).toBe('wait');
    expect(categorizeStep('page.waitForTimeout')).toBe('wait');
    expect(categorizeStep('page.waitForRequest')).toBe('wait');
    expect(categorizeStep('page.waitForResponse')).toBe('wait');
    expect(categorizeStep('page.waitForEvent')).toBe('wait');
    expect(categorizeStep('frame.waitFor')).toBe('wait');
    expect(categorizeStep('frame.waitForTimeout')).toBe('wait');
  });

  it('classifies wait steps (modern human-readable titles)', () => {
    // Playwright >=1.5x emits human-readable step titles instead of api paths.
    expect(categorizeStep('Wait for timeout', 'pw:api')).toBe('wait');
    expect(categorizeStep('Wait for load state', 'pw:api')).toBe('wait');
    expect(categorizeStep('Wait for navigation', 'pw:api')).toBe('wait');
    expect(categorizeStep('Wait for selector', 'pw:api')).toBe('wait');
    expect(categorizeStep('Wait for function', 'pw:api')).toBe('wait');
    expect(categorizeStep('Wait for event', 'pw:api')).toBe('wait');
    expect(categorizeStep('Wait for URL', 'pw:api')).toBe('wait');
  });

  it('classifies modern human-readable navigation/action/input/expect titles', () => {
    expect(categorizeStep('Navigate to "https://example.com"', 'pw:api')).toBe('navigation');
    expect(categorizeStep('Go back', 'pw:api')).toBe('navigation');
    expect(categorizeStep('Reload', 'pw:api')).toBe('navigation');
    expect(categorizeStep('Click', 'pw:api')).toBe('action');
    expect(categorizeStep('Double click', 'pw:api')).toBe('action');
    expect(categorizeStep('Check', 'pw:api')).toBe('action');
    expect(categorizeStep('Fill "value"', 'pw:api')).toBe('input');
    expect(categorizeStep('Press "Enter"', 'pw:api')).toBe('input');
    expect(categorizeStep('Set input files', 'pw:api')).toBe('input');
    // expect steps carry pwCategory 'expect'
    expect(categorizeStep('Expect "toBeVisible"', 'expect')).toBe('assertion');
  });

  it('classifies a bare "Navigate" title (newer Playwright moves the URL to the subtitle)', () => {
    expect(categorizeStep('Navigate', 'pw:api')).toBe('navigation');
  });

  it('prefers a rendered params.url over the title for navigation', () => {
    expect(categorizeStep('Navigate', 'pw:api', { url: 'https://example.com/' })).toBe('navigation');
    // Even a bare verb with a url param resolves to navigation.
    expect(categorizeStep('Go to app', undefined, { url: 'https://example.com/' })).toBe('navigation');
  });

  it('classifies api steps', () => {
    expect(categorizeStep('apiRequestContext.get')).toBe('api');
    expect(categorizeStep('apiResponse')).toBe('api');
  });

  it('classifies hook phrases', () => {
    expect(categorizeStep('Before Hooks')).toBe('hook');
    expect(categorizeStep('After Hooks')).toBe('hook');
    expect(categorizeStep('fixture: browser')).toBe('hook');
  });

  it('returns "other" for unknown titles', () => {
    expect(categorizeStep('someCustomStep')).toBe('other');
  });
});

describe('flattenSteps', () => {
  it('flattens nested step trees depth-first', () => {
    const steps = [
      {
        title: 'page.goto',
        duration: 10,
        category: 'navigation',
        steps: [
          { title: 'locator.click', duration: 5, steps: [] },
          { title: 'expect.toBe', duration: 2, steps: [{ title: 'inner', duration: 1, steps: [] }] },
        ],
      },
      { title: 'outer', duration: 3, steps: [] },
    ];
    const flat = flattenSteps(steps as any);
    expect(flat.length).toBe(5);
    expect(flat.map((s) => s.title)).toEqual(['page.goto', 'locator.click', 'expect.toBe', 'inner', 'outer']);
    expect(flat[0].category).toBe('navigation');
    expect(flat[1].category).toBe('action');
    expect(flat[2].category).toBe('assertion');
    expect(flat[3].category).toBe('other');
  });

  it('handles empty input', () => {
    expect(flattenSteps([])).toEqual([]);
  });

  it('preserves durations', () => {
    const flat = flattenSteps([{ title: 'x', duration: 42, steps: [] }] as any);
    expect(flat[0].duration).toBe(42);
  });

  it('captures the error message and failed flag for failing steps', () => {
    const flat = flattenSteps([
      { title: 'locator.click', duration: 5, error: { message: 'element not found' }, steps: [] },
      { title: 'ok', duration: 1, steps: [] },
    ] as any);
    expect(flat[0].error).toEqual({ message: 'element not found' });
    expect(flat[0].failed).toBe(true);
    expect(flat[1].error).toBeUndefined();
    expect(flat[1].failed).toBeUndefined();
  });

  it('captures location (as file:line:col) and startTime when the raw step provides them', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const flat = flattenSteps([
      {
        title: 'Click',
        category: 'action',
        duration: 5,
        startTime: start,
        location: { file: 'a.spec.ts', line: 7, column: 3 },
        steps: [],
      },
      { title: 'plain', duration: 1, steps: [] },
    ] as any);
    expect(flat[0].location).toBe('a.spec.ts:7:3');
    expect(flat[0].startTime).toBe(start.getTime());
  });

  it('omits location/startTime entirely when the raw step lacks them (no undefined keys)', () => {
    const flat = flattenSteps([{ title: 'plain', duration: 1, steps: [] }] as any);
    expect('location' in flat[0]).toBe(false);
    expect('startTime' in flat[0]).toBe(false);
  });

  it('accepts a numeric startTime (passes through)', () => {
    const flat = flattenSteps([{ title: 'x', duration: 1, startTime: 12345, steps: [] }] as any);
    expect(flat[0].startTime).toBe(12345);
  });
});

describe('collectStepMetrics', () => {
  it('aggregates flat steps, slowest step, and navigation stats', () => {
    const steps = [
      { title: 'page.goto', duration: 100, steps: [] },
      { title: 'locator.click', duration: 50, steps: [] },
      { title: 'page.reload', duration: 80, steps: [] },
    ];
    const m = collectStepMetrics(steps as any);
    expect(m.steps.length).toBe(3);
    expect(m.totalStepDuration).toBe(230);
    expect(m.slowestStep).toEqual({ title: 'page.goto', duration: 100 });
    expect(m.navigationCount).toBe(2);
    expect(m.navigationTotalDuration).toBe(180);
  });

  it('returns null slowestStep when there are no flat steps', () => {
    const m = collectStepMetrics([] as any);
    expect(m.slowestStep).toBe(null);
    expect(m.totalStepDuration).toBe(0);
    expect(m.navigationCount).toBe(0);
    expect(m.waitCount).toBe(0);
    expect(m.waitTotalDuration).toBe(0);
  });

  it('aggregates wait metrics', () => {
    const steps = [
      { title: 'page.waitForTimeout', duration: 5000, steps: [] },
      { title: 'locator.click', duration: 100, steps: [] },
      { title: 'page.waitForLoadState', duration: 3000, steps: [] },
    ];
    const m = collectStepMetrics(steps as any);
    expect(m.waitCount).toBe(2);
    expect(m.waitTotalDuration).toBe(8000);
  });

  it('totalStepDuration sums top-level only (nested not double-counted)', () => {
    const steps = [{ title: 'outer', duration: 100, steps: [{ title: 'inner', duration: 50, steps: [] }] }];
    const m = collectStepMetrics(steps as any);
    expect(m.totalStepDuration).toBe(100); // reduce over top-level only
  });
});

describe('percentile', () => {
  it('returns 0 for empty array', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('computes p50, p90, p95 on a sorted array', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // index = ceil(p/100 * n) - 1
    // p50: ceil(5) - 1 = 4 -> 5
    // p90: ceil(9) - 1 = 8 -> 9
    // p95: ceil(9.5) - 1 = 9 -> 10
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 95)).toBe(10);
  });

  it('clamps index to 0 for low percentiles', () => {
    expect(percentile([42], 10)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });
});

describe('computePerformanceSummary', () => {
  it('returns empty object when no test cases have durations', () => {
    expect(computePerformanceSummary([])).toEqual({});
    expect(computePerformanceSummary([{ duration: null }])).toEqual({});
  });

  it('computes averages, percentiles, and slowest tests', () => {
    const cases = [
      { title: 'a', duration: 100 },
      { title: 'b', duration: 200 },
      { title: 'c', duration: 300 },
    ];
    const s = computePerformanceSummary(cases as any);
    expect(s.avgTestDuration).toBe(200);
    expect(s.p50TestDuration).toBe(200);
    expect(s.p90TestDuration).toBe(300);
    expect(s.p95TestDuration).toBe(300);
    expect(s.slowestTests).toEqual([
      { title: 'c', duration: 300 },
      { title: 'b', duration: 200 },
      { title: 'a', duration: 100 },
    ]);
  });

  it('caps slowest tests at 5', () => {
    const cases = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, duration: i * 10 }));
    const s = computePerformanceSummary(cases as any);
    expect(s.slowestTests?.length).toBe(5);
    expect(s.slowestTests?.[0].title).toBe('t9');
  });

  it('aggregates navigation stats from performanceMetrics', () => {
    const cases = [
      { title: 'a', duration: 100, performanceMetrics: { navigationTotalDuration: 50, navigationCount: 2 } },
      { title: 'b', duration: 200, performanceMetrics: { navigationTotalDuration: 30, navigationCount: 3 } },
    ];
    const s = computePerformanceSummary(cases as any);
    expect(s.totalNavigationDuration).toBe(80);
    expect(s.avgNavigationDuration).toBe(Math.round(80 / 5));
  });

  it('avgNavigationDuration is 0 when no navigation steps', () => {
    const s = computePerformanceSummary([{ title: 'a', duration: 100 }] as any);
    expect(s.avgNavigationDuration).toBe(0);
    expect(s.totalNavigationDuration).toBe(0);
  });

  it('computes totalWastedTimeMs from performanceMetrics', () => {
    const cases = [
      { title: 'a', duration: 100, performanceMetrics: { waitTotalDuration: 5000, waitCount: 1 } },
      { title: 'b', duration: 200, performanceMetrics: { waitTotalDuration: 3000, waitCount: 2 } },
    ];
    const s = computePerformanceSummary(cases as any);
    expect(s.totalWastedTimeMs).toBe(8000);
  });

  it('totalWastedTimeMs is 0 when no wait durations', () => {
    const s = computePerformanceSummary([{ title: 'a', duration: 100 }] as any);
    expect(s.totalWastedTimeMs).toBe(0);
  });
});

describe('extractTestStepEvents', () => {
  it('extracts only hook/fixture top-level steps with absolute timings', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const steps = [
      {
        title: 'Before Hooks',
        category: 'hook',
        startTime: start,
        duration: 10,
        location: { file: 'a.ts', line: 1, column: 2 },
      },
      { title: 'locator.click', category: 'action', startTime: start, duration: 5 },
      { title: 'fixture: browser', category: 'fixture', startTime: start, duration: 3, error: new Error('x') },
    ];
    const events = extractTestStepEvents(steps as any, start);
    expect(events.length).toBe(2);
    expect(events[0].title).toBe('Before Hooks');
    expect(events[0].category).toBe('hook');
    expect(events[0].startedAt).toBe(start.getTime());
    expect(events[0].status).toBe('passed');
    expect(events[0].location).toBe('a.ts:1:2');
    expect(events[1].status).toBe('failed'); // error present
  });

  it('skips steps without startTime', () => {
    const events = extractTestStepEvents([{ title: 'Before Hooks', category: 'hook', duration: 1 }] as any, new Date());
    expect(events.length).toBe(0);
  });

  it('accepts numeric startTime (passes through)', () => {
    const events = extractTestStepEvents(
      [{ title: 'Before Hooks', category: 'hook', startTime: 12345, duration: 1 }] as any,
      new Date(),
    );
    expect(events[0].startedAt).toBe(12345);
  });

  it('names the hooks and fixtures each hook section ran, in order', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const steps = [
      {
        title: 'Before Hooks',
        category: 'hook',
        startTime: start,
        duration: 254,
        steps: [
          { title: 'beforeAll hook', category: 'hook', startTime: start, duration: 120, steps: [] },
          { title: 'seed users', category: 'hook', startTime: start, duration: 73, steps: [] },
          {
            title: 'beforeEach hook',
            category: 'hook',
            startTime: start,
            duration: 60,
            steps: [{ title: 'Fixture "db"', category: 'fixture', startTime: start, duration: 1, steps: [] }],
          },
          { title: 'Fixture "piwiCapture"', category: 'fixture', startTime: start, duration: 4, steps: [] },
        ],
      },
      { title: 'Click', category: 'pw:api', startTime: start, duration: 5 },
    ];
    const [setup] = extractTestStepEvents(steps as any, start);
    expect(setup.hooks).toEqual([
      { title: 'beforeAll hook', category: 'hook', duration: 120 },
      { title: 'seed users', category: 'hook', duration: 73 },
      { title: 'beforeEach hook', category: 'hook', duration: 60 },
    ]);
    expect(setup.error).toBeUndefined();
  });

  it('carries the first line of a failed section error and flags the hook that failed', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const error = { message: '\u001b[31mError: afterAll boom\u001b[39m\n\n  at a.spec.ts:8:3' };
    const steps = [
      {
        title: 'After Hooks',
        category: 'hook',
        startTime: start,
        duration: 52,
        error,
        steps: [
          { title: 'afterEach hook', category: 'hook', startTime: start, duration: 0, steps: [] },
          { title: 'afterAll hook', category: 'hook', startTime: start, duration: 24, error, steps: [] },
        ],
      },
    ];
    const [teardown] = extractTestStepEvents(steps as any, start);
    expect(teardown.status).toBe('failed');
    expect(teardown.error).toBe('Error: afterAll boom');
    expect(teardown.hooks).toEqual([
      { title: 'afterEach hook', category: 'hook', duration: 0 },
      { title: 'afterAll hook', category: 'hook', duration: 24, failed: true },
    ]);
  });

  it('keeps the failed and the slowest hooks of a crowded section, in the order they ran', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const children = Array.from({ length: MAX_SECTION_HOOKS + 3 }, (_, i) => ({
      title: `Fixture "f${i}"`,
      category: 'fixture',
      startTime: start,
      duration: i,
      steps: [],
    }));
    (children[0] as any).error = { message: 'boom' };
    const [setup] = extractTestStepEvents(
      [{ title: 'Before Hooks', category: 'hook', startTime: start, duration: 100, steps: children }] as any,
      start,
    );
    expect(setup.hooks).toHaveLength(MAX_SECTION_HOOKS);
    expect(setup.hooks![0]).toEqual({ title: 'Fixture "f0"', category: 'fixture', duration: 0, failed: true });
    expect(setup.hooks!.slice(1).map((h) => h.duration)).toEqual(
      Array.from({ length: MAX_SECTION_HOOKS - 1 }, (_, i) => i + 4),
    );
  });
});

describe('extractWaitEvents', () => {
  it('extracts wait-category steps with absolute timings', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const steps = [
      {
        title: 'page.waitForTimeout',
        category: undefined,
        startTime: start,
        duration: 5000,
        location: { file: 'test.spec.ts', line: 10, column: 5 },
      },
      { title: 'locator.click', category: 'action', startTime: start, duration: 100 },
    ];
    const events = extractWaitEvents(steps as any);
    expect(events.length).toBe(1);
    expect(events[0].title).toBe('page.waitForTimeout');
    expect(events[0].category).toBe('wait');
    expect(events[0].startedAt).toBe(start.getTime());
    expect(events[0].duration).toBe(5000);
    expect(events[0].status).toBe('wasted');
    expect(events[0].location).toBe('test.spec.ts:10:5');
  });

  it('skips steps without startTime', () => {
    const events = extractWaitEvents([{ title: 'page.waitForTimeout', duration: 5000 }] as any);
    expect(events.length).toBe(0);
  });

  it('extracts waits nested inside test.step() blocks', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const steps = [
      {
        title: 'test.step: fill form',
        category: 'test.step',
        startTime: start,
        duration: 2000,
        steps: [
          { title: 'locator.fill', duration: 200, steps: [] },
          { title: 'page.waitForTimeout', startTime: new Date(start.getTime() + 200), duration: 1000, steps: [] },
        ],
      },
    ];
    const events = extractWaitEvents(steps as any);
    expect(events.length).toBe(1);
    expect(events[0].title).toBe('page.waitForTimeout');
  });

  it('does NOT extract waits nested inside another wait step', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const steps = [
      {
        title: 'page.waitForResponse',
        startTime: start,
        duration: 3000,
        steps: [{ title: 'page.waitForTimeout', startTime: new Date(start.getTime() + 100), duration: 500, steps: [] }],
      },
    ];
    const events = extractWaitEvents(steps as any);
    expect(events.length).toBe(1); // only the outer wait
    expect(events[0].title).toBe('page.waitForResponse');
  });

  it('accepts numeric startTime', () => {
    const events = extractWaitEvents([{ title: 'page.waitForTimeout', startTime: 12345, duration: 100 }] as any);
    expect(events[0].startedAt).toBe(12345);
  });
});

describe('stepLabel', () => {
  it('returns the title alone when there is no subtitle', () => {
    expect(stepLabel({ title: 'Click' })).toBe('Click');
  });

  it('appends the subtitle when it adds a target the title lacks', () => {
    expect(stepLabel({ title: 'Click', subtitle: "getByRole('button', { name: 'Pay' })" })).toBe(
      "Click getByRole('button', { name: 'Pay' })",
    );
  });

  it('does not repeat a subtitle already contained in the title', () => {
    expect(stepLabel({ title: 'Fill "x" getByLabel(\'Email\')', subtitle: "getByLabel('Email')" })).toBe(
      'Fill "x" getByLabel(\'Email\')',
    );
  });

  it('falls back to the subtitle when the title is empty', () => {
    expect(stepLabel({ title: '', subtitle: 'example.com/' })).toBe('example.com/');
  });
});

describe('stepLabelParts', () => {
  it('returns the title with a null subtitle when there is none', () => {
    expect(stepLabelParts({ title: 'Click' })).toEqual({ title: 'Click', subtitle: null });
  });

  it('splits the title and the subtitle when the subtitle adds a target', () => {
    expect(stepLabelParts({ title: 'Click', subtitle: "getByRole('button', { name: 'Pay' })" })).toEqual({
      title: 'Click',
      subtitle: "getByRole('button', { name: 'Pay' })",
    });
  });

  it('folds a subtitle already contained in the title', () => {
    expect(stepLabelParts({ title: 'Fill "x" getByLabel(\'Email\')', subtitle: "getByLabel('Email')" })).toEqual({
      title: 'Fill "x" getByLabel(\'Email\')',
      subtitle: null,
    });
  });

  it('rejoins to the same string stepLabel produces', () => {
    const step = { title: 'Navigate', subtitle: '/checkout' };
    const parts = stepLabelParts(step);
    expect([parts.title, parts.subtitle].filter(Boolean).join(' ')).toBe(stepLabel(step));
  });
});

describe('orderedStepParams', () => {
  it('is empty for null or non-object params', () => {
    expect(orderedStepParams(null)).toEqual([]);
    expect(orderedStepParams(undefined)).toEqual([]);
  });

  it('puts the locator first and keeps the rest in insertion order', () => {
    expect(orderedStepParams({ value: 'x', button: 'left', locator: "getByRole('button')" })).toEqual([
      ['locator', "getByRole('button')"],
      ['value', 'x'],
      ['button', 'left'],
    ]);
  });

  it('keeps insertion order when there is no locator', () => {
    expect(orderedStepParams({ url: 'https://x/', method: 'GET' })).toEqual([
      ['url', 'https://x/'],
      ['method', 'GET'],
    ]);
  });
});

describe('flattenSteps captures 1.63 subtitle and params', () => {
  it("captures a Click step's locator subtitle and params", () => {
    const flat = flattenSteps([
      {
        title: 'Click',
        category: 'pw:api',
        duration: 5,
        subtitle: "getByRole('button', { name: 'Pay' })",
        params: { locator: "getByRole('button', { name: 'Pay' })", button: 'left' },
        steps: [],
      },
    ] as any);
    expect(flat[0].subtitle).toBe("getByRole('button', { name: 'Pay' })");
    expect(flat[0].params).toEqual({ locator: "getByRole('button', { name: 'Pay' })", button: 'left' });
    expect(flat[0].category).toBe('action');
  });

  it('captures a Navigate step and categorizes it from params.url', () => {
    const flat = flattenSteps([
      {
        title: 'Navigate',
        category: 'pw:api',
        duration: 12,
        subtitle: 'example.com/',
        params: { url: 'https://example.com/' },
        steps: [],
      },
    ] as any);
    expect(flat[0].subtitle).toBe('example.com/');
    expect(flat[0].params).toEqual({ url: 'https://example.com/' });
    expect(flat[0].category).toBe('navigation');
  });

  it("keeps a test.step author's own params, stringifying non-primitives", () => {
    const flat = flattenSteps([
      {
        title: 'sign in',
        category: 'test.step',
        duration: 40,
        params: { user: 'admin', attempts: 2, remember: true, extra: { role: 'owner' } },
        steps: [],
      },
    ] as any);
    expect(flat[0].params).toEqual({
      user: 'admin',
      attempts: 2,
      remember: true,
      extra: '{"role":"owner"}',
    });
  });

  it('caps params to the key limit and each value to the char limit', () => {
    const rawParams: Record<string, string> = {};
    for (let i = 0; i < MAX_STEP_PARAM_KEYS + 10; i++) rawParams[`k${i}`] = 'v';
    rawParams.long = 'a'.repeat(MAX_STEP_PARAM_VALUE_CHARS + 50);
    const flat = flattenSteps([{ title: 'Click', duration: 1, params: rawParams, steps: [] }] as any);
    expect(Object.keys(flat[0].params!).length).toBe(MAX_STEP_PARAM_KEYS);
  });

  it('ends a cut value with a marker', () => {
    const flat = flattenSteps([
      { title: 'Click', duration: 1, params: { locator: `getByText('${'Lorem ipsum '.repeat(30)}')` }, steps: [] },
    ] as any);
    const locator = flat[0].params!.locator as string;
    expect(locator).toHaveLength(MAX_STEP_PARAM_VALUE_CHARS);
    expect(locator.endsWith('…')).toBe(true);
  });

  it('hides a test.step param named like a credential, and masks token-shaped values in the others', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456';
    const hex = 'a'.repeat(40);
    const flat = flattenSteps([
      {
        title: 'Set token',
        category: 'test.step',
        duration: 1,
        subtitle: `Authorization ${jwt}`,
        params: { token: jwt, sessionId: hex },
        steps: [],
      },
      { title: 'Click', category: 'pw:api', duration: 1, params: { selector: `#${hex}` }, steps: [] },
    ] as any);
    expect(flat[0].params!.token).toBe('<hidden>');
    expect(flat[0].params!.sessionId).toBe('<hidden>');
    expect(flat[0].subtitle).not.toContain(jwt);
    expect(flat[1].params!.selector).toBe('#[masked-hex]');
  });

  it('leaves 1.61-shaped steps (no subtitle/params) unchanged', () => {
    const flat = flattenSteps([
      { title: "Click getByRole('button', { name: 'Pay' })", category: 'pw:api', duration: 5, steps: [] },
    ] as any);
    expect('subtitle' in flat[0]).toBe(false);
    expect('params' in flat[0]).toBe(false);
    expect(flat[0].category).toBe('action');
  });
});

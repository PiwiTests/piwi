import { describe, test, expect } from 'vitest';
import {
  buildFlakeProfile,
  flakeLift,
  type FlakeProfileAttempt,
  type FlakeProfileInput,
} from '#shared/handlers/flake-profile';

let nextId = 1;

/** One attempt of the test under study: passed or failed, with its requests and neighbors. */
function attempt(status: 'passed' | 'failed', overrides: Partial<FlakeProfileAttempt> = {}): FlakeProfileAttempt {
  const id = nextId++;
  return {
    id,
    runId: 1000 + id,
    status,
    retry: 0,
    startedAt: Date.UTC(2026, 8, 1, 10) + id * 60_000,
    duration: 5_000,
    shardIndex: null,
    workerIndex: 0,
    project: 'chromium',
    requests: [],
    overlaps: [],
    before: null,
    ...overrides,
  };
}

function cart(ms: number) {
  return { method: 'GET', url: 'https://shop.test/api/cart', status: 200, duration: ms };
}

function input(attempts: FlakeProfileAttempt[], extra: Partial<FlakeProfileInput> = {}): FlakeProfileInput {
  return { testCaseId: 7, attempts, ...extra };
}

/** `n` copies of an attempt built by `make`. */
function times(n: number, make: (i: number) => FlakeProfileAttempt): FlakeProfileAttempt[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

describe('flakeLift', () => {
  test('is the smoothed ratio of the failure rate to the pass rate', () => {
    // (7 + 1) / (8 + 2) ÷ (3 + 1) / (44 + 2) = 0.8 / 0.0869…
    expect(flakeLift(7, 8, 3, 44)).toBeCloseTo(9.2, 1);
    expect(flakeLift(0, 8, 0, 44)).toBeCloseTo(1 / 10 / (1 / 46), 5);
  });
});

describe('buildFlakeProfile', () => {
  test('a route slow on the failures is the top suspect, with a threshold that separates them', () => {
    const attempts = [
      ...times(7, (i) => attempt('failed', { requests: [cart(1_700 + i * 100)] })),
      attempt('failed', { requests: [cart(150)] }),
      ...times(41, (i) => attempt('passed', { requests: [cart(120 + (i % 5) * 20)] })),
      ...times(3, () => attempt('passed', { requests: [cart(1_900)] })),
    ];
    const profile = buildFlakeProfile(input(attempts));

    expect(profile.failures).toBe(8);
    expect(profile.passes).toBe(44);
    const top = profile.suspects[0]!;
    expect(top.kind).toBe('slow-route');
    expect(top.route).toBe('GET /api/cart');
    expect(top.thresholdMs).toBe(1_700);
    expect(top.counts).toEqual({ failuresWith: 7, failures: 8, passesWith: 3, passes: 44 });
    expect(top.label).toBe('GET /api/cart slower (≥1.7 s)');
    // The median of the seven slow failures: 1.7 s … 2.3 s → 2.0 s.
    expect(top.condition).toEqual({ kind: 'delay', route: 'GET /api/cart', ms: 2_000 });
    expect(top.conditionLabel).toBe('delay to 2 s');
    expect(top.executionIds).toHaveLength(7);
    expect(top.lift).toBeCloseTo(flakeLift(7, 8, 3, 44), 5);
  });

  test('a threshold label rounds down, so "or more" holds', () => {
    const attempts = [
      ...times(4, () => attempt('failed', { requests: [cart(1_792)] })),
      ...times(20, () => attempt('passed', { requests: [cart(100)] })),
    ];
    const top = buildFlakeProfile(input(attempts)).suspects[0]!;
    expect(top.label).toBe('GET /api/cart slower (≥1.7 s)');
    expect(top.sentence).toBe('GET /api/cart took 1.7 s or more in 4 of 4 failures and 0 of 20 passes.');
  });

  test('the counts of every suspect add up to the attempts', () => {
    const attempts = [
      ...times(5, () => attempt('failed', { requests: [cart(2_000)] })),
      ...times(20, () => attempt('passed', { requests: [cart(100)] })),
    ];
    const profile = buildFlakeProfile(input(attempts));
    for (const s of profile.suspects) {
      expect(s.counts.failures).toBe(5);
      expect(s.counts.passes).toBe(20);
      expect(s.counts.failures + s.counts.passes).toBe(profile.attempts);
    }
  });

  test('a route only the failures call is not slower', () => {
    const extra = { method: 'POST', url: 'https://shop.test/api/coupon', status: 200, duration: 90 };
    const attempts = [
      ...times(5, () => attempt('failed', { requests: [cart(100), extra] })),
      ...times(20, () => attempt('passed', { requests: [cart(100)] })),
    ];
    expect(buildFlakeProfile(input(attempts)).suspects).toEqual([]);
  });

  test('the threshold is the lowest value among the failures that separates best', () => {
    // Failures at 1.2, 1.5, 1.55 and 1.6 s; passes up to 1.3 s: 1.5 s keeps three
    // failures and drops every pass, 1.2 s keeps all four failures and one pass.
    const attempts = [
      attempt('failed', { requests: [cart(1_200)] }),
      attempt('failed', { requests: [cart(1_500)] }),
      attempt('failed', { requests: [cart(1_600)] }),
      attempt('failed', { requests: [cart(1_550)] }),
      ...times(30, () => attempt('passed', { requests: [cart(200)] })),
      attempt('passed', { requests: [cart(1_300)] }),
    ];
    const top = buildFlakeProfile(input(attempts)).suspects[0]!;
    expect(top.kind).toBe('slow-route');
    // At 1.2 s: 4/4 failures, 1/31 passes (J = 0.968); at 1.5 s: 3/4, 0/31 (J = 0.75).
    expect(top.thresholdMs).toBe(1_200);
    expect(top.counts.failuresWith).toBe(4);
    expect(top.counts.passesWith).toBe(1);
  });

  test('a factor needs at least 3 supporting failures', () => {
    const attempts = [
      ...times(2, () => attempt('failed', { requests: [cart(3_000)] })),
      ...times(6, () => attempt('failed', { requests: [cart(100)] })),
      ...times(30, () => attempt('passed', { requests: [cart(100)] })),
    ];
    expect(buildFlakeProfile(input(attempts)).suspects).toEqual([]);
  });

  test('a factor needs a lift of at least 2', () => {
    // Slow on 4 of 8 failures and 10 of 20 passes: lift (5/10)/(11/22) = 1.
    const attempts = [
      ...times(4, () => attempt('failed', { requests: [cart(2_000)] })),
      ...times(4, () => attempt('failed', { requests: [cart(100)] })),
      ...times(10, () => attempt('passed', { requests: [cart(2_000)] })),
      ...times(10, () => attempt('passed', { requests: [cart(100)] })),
    ];
    expect(buildFlakeProfile(input(attempts)).suspects).toEqual([]);
  });

  test('a route that fails on the failures suggests failing it the same way', () => {
    const reset = {
      method: 'POST',
      url: 'https://shop.test/api/pay',
      status: 0,
      duration: 40,
      failure: 'net::ERR_CONNECTION_RESET',
    };
    const attempts = [
      ...times(4, () => attempt('failed', { requests: [reset] })),
      ...times(20, () => attempt('passed', { requests: [{ ...reset, status: 201, failure: null }] })),
    ];
    const top = buildFlakeProfile(input(attempts)).suspects[0]!;
    expect(top.kind).toBe('failed-route');
    expect(top.route).toBe('POST /api/pay');
    expect(top.condition).toEqual({ kind: 'fail', route: 'POST /api/pay', abort: true });
    expect(top.label).toBe('POST /api/pay failed (net::ERR_CONNECTION_RESET)');

    const errored = [
      ...times(3, () => attempt('failed', { requests: [{ ...reset, status: 503, failure: null }] })),
      ...times(20, () => attempt('passed', { requests: [{ ...reset, status: 201, failure: null }] })),
    ];
    const suspect = buildFlakeProfile(input(errored)).suspects.find((s) => s.kind === 'failed-route')!;
    expect(suspect.condition).toEqual({ kind: 'fail', route: 'POST /api/pay', status: 503 });
    expect(suspect.label).toBe('POST /api/pay failed (503)');
  });

  test('a neighbor running alongside the failures is a suspect with the write routes both call', () => {
    const neighbor = (i: number, shardIndex: number | null = null) => ({
      executionId: 5000 + i,
      testCaseId: 42,
      shardIndex,
    });
    const other = (i: number) => ({ executionId: 6000 + i, testCaseId: 43, shardIndex: null });
    const attempts = [
      ...times(5, (i) => attempt('failed', { overlaps: [neighbor(i), other(i)] })),
      ...times(3, (i) => attempt('failed', { overlaps: [other(10 + i)] })),
      ...times(4, (i) => attempt('passed', { overlaps: [neighbor(20 + i), other(20 + i)] })),
      ...times(40, (i) => attempt('passed', { overlaps: [other(30 + i)] })),
    ];
    const writes: Record<number, string[]> = {};
    for (const a of attempts.slice(0, 5)) writes[a.id] = ['POST /api/products', 'POST /api/cart'];
    for (let i = 0; i < 5; i++) writes[5000 + i] = ['PUT /api/products', 'POST /api/products'];

    const profile = buildFlakeProfile(
      input(attempts, { titles: { 42: 'admin › resets catalog' }, writeRoutes: writes }),
    );
    const top = profile.suspects[0]!;
    expect(top.kind).toBe('alongside');
    expect(top.testCaseId).toBe(42);
    expect(top.counts).toEqual({ failuresWith: 5, failures: 8, passesWith: 4, passes: 44 });
    expect(top.label).toBe('admin › resets catalog alongside');
    expect(top.condition).toEqual({ kind: 'alongside', testCaseId: 42, title: 'admin › resets catalog' });
    expect(top.sharedRoutes).toEqual(['/api/products']);
    expect(top.approximate).toBe(false);
    // The test that runs beside every attempt is no suspect.
    expect(profile.suspects.some((s) => s.testCaseId === 43)).toBe(false);
  });

  test('overlap with an execution on another shard is flagged approximate', () => {
    const attempts = [
      ...times(4, (i) =>
        attempt('failed', { shardIndex: 1, overlaps: [{ executionId: 7000 + i, testCaseId: 42, shardIndex: 2 }] }),
      ),
      ...times(20, () => attempt('passed', { shardIndex: 1 })),
    ];
    const top = buildFlakeProfile(input(attempts)).suspects[0]!;
    expect(top.kind).toBe('alongside');
    expect(top.approximate).toBe(true);
  });

  test('load: many executions of the same run at once on the failures', () => {
    // Every neighbor is a different test, so none of them recurs as a suspect.
    let neighborId = 10_000;
    const crowd = (n: number) =>
      Array.from({ length: n }, () => ({ executionId: neighborId, testCaseId: neighborId++, shardIndex: null }));
    const attempts = [
      ...times(6, () => attempt('failed', { overlaps: crowd(7) })),
      ...times(2, () => attempt('failed', { overlaps: crowd(2) })),
      ...times(33, () => attempt('passed', { overlaps: crowd(2) })),
      ...times(11, () => attempt('passed', { overlaps: crowd(7) })),
    ];
    const load = buildFlakeProfile(input(attempts)).suspects.find((s) => s.kind === 'load')!;
    expect(load.thresholdCount).toBe(7);
    // The id names the factor, not the threshold, so a lab result stays attached when the threshold moves.
    expect(load.id).toBe('load');
    expect(load.counts).toEqual({ failuresWith: 6, failures: 8, passesWith: 11, passes: 44 });
    expect(load.label).toBe('7 or more other tests running at once');
    expect(load.condition).toEqual({ kind: 'cpu', rate: 4 });
  });

  test('load counts only the executions on the same shard', () => {
    const cross = Array.from({ length: 8 }, (_, k) => ({ executionId: 9000 + k, testCaseId: 950 + k, shardIndex: 2 }));
    const attempts = [
      ...times(6, () => attempt('failed', { shardIndex: 1, overlaps: cross })),
      ...times(30, () => attempt('passed', { shardIndex: 1 })),
    ];
    expect(buildFlakeProfile(input(attempts)).suspects.some((s) => s.kind === 'load')).toBe(false);
  });

  test('the test that ran just before on the same worker is a suspect', () => {
    const attempts = [
      ...times(4, (i) => attempt('failed', { before: { executionId: 8000 + i, testCaseId: 77 } })),
      ...times(2, () => attempt('failed', { before: { executionId: 8100, testCaseId: 78 } })),
      ...times(30, () => attempt('passed', { before: { executionId: 8200, testCaseId: 78 } })),
      ...times(2, () => attempt('passed', { before: { executionId: 8300, testCaseId: 77 } })),
    ];
    const top = buildFlakeProfile(input(attempts, { titles: { 77: 'seeds the cart' } })).suspects[0]!;
    expect(top.kind).toBe('before');
    expect(top.testCaseId).toBe(77);
    expect(top.label).toBe('seeds the cart just before');
    expect(top.condition).toEqual({ kind: 'after', testCaseId: 77, title: 'seeds the cart' });
    expect(top.counts).toEqual({ failuresWith: 4, failures: 6, passesWith: 2, passes: 32 });
  });

  test('a browser-only flake is a project suspect', () => {
    const attempts = [
      ...times(5, () => attempt('failed', { project: 'webkit' })),
      ...times(15, () => attempt('passed', { project: 'webkit' })),
      ...times(30, () => attempt('passed', { project: 'chromium' })),
    ];
    const top = buildFlakeProfile(input(attempts)).suspects[0]!;
    expect(top.kind).toBe('project');
    expect(top.project).toBe('webkit');
    expect(top.condition).toEqual({ kind: 'project', name: 'webkit' });
    expect(top.label).toBe('on webkit');
  });

  test('one browser in the window is no suspect', () => {
    const attempts = [...times(5, () => attempt('failed')), ...times(20, () => attempt('passed'))];
    expect(buildFlakeProfile(input(attempts)).suspects).toEqual([]);
  });

  test('nothing to find: no suspects, and the counts still add up', () => {
    const attempts = [
      ...times(6, (i) => attempt('failed', { requests: [cart(100 + i)], project: i % 2 ? 'webkit' : 'chromium' })),
      ...times(30, (i) =>
        attempt('passed', { requests: [cart(100 + (i % 6))], project: i % 2 ? 'webkit' : 'chromium' }),
      ),
    ];
    const profile = buildFlakeProfile(input(attempts));
    expect(profile.suspects).toEqual([]);
    expect(profile.failures + profile.passes).toBe(36);
  });

  test('at most 5 suspects, ranked by lift × supporting failures', () => {
    const routes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const failed = times(10, (i) =>
      attempt('failed', {
        // Route k is slow on the first 3 + k failures.
        requests: routes.map((r, k) => ({
          method: 'GET',
          url: `https://shop.test/api/${r}`,
          status: 200,
          duration: i < 3 + k ? 3_000 : 100,
        })),
      }),
    );
    const passed = times(40, () =>
      attempt('passed', {
        requests: routes.map((r) => ({ method: 'GET', url: `https://shop.test/api/${r}`, status: 200, duration: 100 })),
      }),
    );
    const profile = buildFlakeProfile(input([...failed, ...passed]));
    expect(profile.suspects).toHaveLength(5);
    const scores = profile.suspects.map((s) => s.lift * s.counts.failuresWith);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    expect(profile.suspects[0]!.route).toBe('GET /api/g');
    expect(profile.suspects.map((s) => s.route)).not.toContain('GET /api/a');
  });

  test('context: first attempts and the UTC hour block, with no condition', () => {
    const at = (h: number) => Date.UTC(2026, 8, 1, h, 30);
    const attempts = [
      ...times(5, () => attempt('failed', { startedAt: at(3) })),
      ...times(2, () => attempt('passed', { startedAt: at(4) })),
      ...times(25, () => attempt('passed', { startedAt: at(14) })),
    ];
    const profile = buildFlakeProfile(input(attempts));
    const hour = profile.context.find((c) => c.kind === 'hour')!;
    expect(hour.label).toBe('between 00:00 and 06:00 UTC');
    expect(hour.counts).toEqual({ failuresWith: 5, failures: 5, passesWith: 2, passes: 27 });
    const first = profile.context.find((c) => c.kind === 'attempt')!;
    expect(first.label).toBe('on a first attempt');
    expect(first.counts.failuresWith).toBe(5);
  });

  test('context: another run on the same environment at the same time', () => {
    const attempts = [
      ...times(4, () => attempt('failed', { concurrentRuns: 1 })),
      ...times(25, () => attempt('passed', { concurrentRuns: 0 })),
    ];
    const ctx = buildFlakeProfile(input(attempts)).context.find((c) => c.kind === 'concurrent-run')!;
    expect(ctx.counts).toEqual({ failuresWith: 4, failures: 4, passesWith: 0, passes: 25 });
  });

  test('a test with no failures or no passes has no suspects', () => {
    expect(buildFlakeProfile(input(times(20, () => attempt('passed', { requests: [cart(3_000)] })))).suspects).toEqual(
      [],
    );
    expect(buildFlakeProfile(input([])).attempts).toBe(0);
  });
});

describe('environment factors', () => {
  const onRunner = (timeZone: string) => ({ environment: { runnerTimeZone: timeZone, runnerLocale: 'en-US' } });

  test('names the runner time zone the failures share and the passes do not', () => {
    const attempts = [
      ...Array.from({ length: 6 }, () => attempt('failed', onRunner('UTC'))),
      ...Array.from({ length: 10 }, () => attempt('passed', onRunner('Europe/Paris'))),
    ];
    const profile = buildFlakeProfile({ testCaseId: 1, attempts });
    const suspect = profile.suspects.find((c) => c.kind === 'environment');
    expect(suspect).toMatchObject({
      label: 'on runner time zone UTC',
      counts: { failuresWith: 6, passesWith: 0 },
      condition: { kind: 'timezone', timeZone: 'UTC' },
      conditionLabel: 'run in time zone UTC',
    });
    expect(profile.suspects.some((c) => c.label.includes('locale'))).toBe(false);
  });

  test('names the runner image as context, which no lab condition applies', () => {
    const on = (image: string) => ({ environment: { runnerImage: image } });
    const attempts = [
      ...Array.from({ length: 6 }, () => attempt('failed', on('ubuntu24 20261102.1'))),
      ...Array.from({ length: 10 }, () => attempt('passed', on('ubuntu24 20261020.1'))),
    ];
    const profile = buildFlakeProfile({ testCaseId: 1, attempts });
    expect(profile.context.find((c) => c.kind === 'environment')?.label).toBe('on runner image ubuntu24 20261102.1');
  });

  test('says nothing when the field never changed or was not recorded', () => {
    const same = [
      ...Array.from({ length: 6 }, () => attempt('failed', onRunner('UTC'))),
      ...Array.from({ length: 6 }, () => attempt('passed', onRunner('UTC'))),
    ];
    expect(buildFlakeProfile({ testCaseId: 1, attempts: same }).suspects.some((c) => c.kind === 'environment')).toBe(
      false,
    );
    const unrecorded = [
      ...Array.from({ length: 6 }, () => attempt('failed')),
      ...Array.from({ length: 6 }, () => attempt('passed')),
    ];
    expect(
      buildFlakeProfile({ testCaseId: 1, attempts: unrecorded }).suspects.some((c) => c.kind === 'environment'),
    ).toBe(false);
  });
});

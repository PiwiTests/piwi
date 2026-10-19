/**
 * Behavioral tests for the run-insights, flaky-classify and spec-health
 * widget endpoints. Seeds a two-run history (a clean baseline followed by a run where
 * one test regresses with a timeout) and asserts the actual computed output —
 * not just status codes.
 */
import { test, expect, type APIRequestContext } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

interface SpecHealthRow {
  prefix: string;
  passRate: number;
  flakyRate: number;
  failureCount: number;
  testCount: number;
  avgDuration: number;
}

// Fixture run times are relative to now so the seeded runs always fall inside
// spec-health's default 30-day look-back window; a hardcoded date silently ages
// out of range and drops the specs from the aggregation.
const BASELINE_START = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const REGRESSION_START = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

async function submit(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post('/api/test-runs/submit', {
    data: { projectName: PROJECT.INSIGHTS_SPEC_HEALTH, ...body },
  });
  expect(res.ok()).toBeTruthy();
  return res.json() as Promise<{ runId: number; projectId: number }>;
}

test.describe.serial('Insights, spec health & flaky classification', () => {
  let projectId = 0;
  let regressionRunId = 0;

  test('seeds a baseline run and a regression run', async ({ request }) => {
    // Baseline: both tests pass, across two spec prefixes.
    const baseline = await submit(request, {
      status: 'passed',
      startTime: BASELINE_START,
      duration: 3000,
      totalTests: 2,
      passedTests: 2,
      failedTests: 0,
      skippedTests: 0,
      testCases: [
        { title: 'login works', status: 'passed', duration: 500, location: 'tests/auth/login.spec.ts:1:1' },
        { title: 'checkout works', status: 'passed', duration: 700, location: 'tests/checkout/pay.spec.ts:1:1' },
      ],
    });
    projectId = baseline.projectId;

    // Current: checkout regresses with a timeout error.
    const current = await submit(request, {
      status: 'failed',
      startTime: REGRESSION_START,
      duration: 3000,
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      skippedTests: 0,
      testCases: [
        { title: 'login works', status: 'passed', duration: 520, location: 'tests/auth/login.spec.ts:1:1' },
        {
          title: 'checkout works',
          status: 'failed',
          duration: 30000,
          location: 'tests/checkout/pay.spec.ts:1:1',
          error:
            'TimeoutError: Timeout 30000ms exceeded waiting for locator to be visible\n    at tests/checkout/pay.spec.ts:5:3',
        },
      ],
    });
    regressionRunId = current.runId;
    expect(projectId).toBeGreaterThan(0);
    expect(regressionRunId).toBeGreaterThan(0);
  });

  test('insights reports the regression against the baseline', async ({ request }) => {
    const res = await request.get(`/api/test-runs/${regressionRunId}/insights`);
    expect(res.ok()).toBeTruthy();
    const insights = await res.json();

    expect(insights.hasBaseline).toBe(true);
    const regressed = (insights.newRegressions as Array<{ title: string }>).map((r) => r.title);
    expect(regressed).toContain('checkout works');
    expect(regressed).not.toContain('login works');
    // The passing test that was already passing is not a regression or recovery.
    expect(insights.passRate).toBeLessThan(insights.baselinePassRate);
  });

  test('spec-health groups by spec prefix with pass/failure stats', async ({ request }) => {
    const res = await request.get(`/api/widgets/spec-health?projects=${projectId}&days=30`);
    expect(res.ok()).toBeTruthy();
    const { project, data } = (await res.json()) as { project: { id: number }; data: { specs: SpecHealthRow[] } };
    expect(project.id).toBe(projectId);
    const { specs } = data;

    const auth = specs.find((s) => s.prefix === 'tests/auth');
    const checkout = specs.find((s) => s.prefix === 'tests/checkout');
    expect(auth, 'tests/auth prefix present').toBeTruthy();
    expect(checkout, 'tests/checkout prefix present').toBeTruthy();

    // auth passed in both runs; checkout passed once and failed once.
    expect(auth!.passRate).toBe(1);
    expect(auth!.failureCount).toBe(0);
    expect(checkout!.failureCount).toBe(1);
    expect(checkout!.passRate).toBeLessThan(1);
  });

  test('flaky-classify labels a timeout failure as "timing"', async ({ request }) => {
    const tcRes = await request.get(`/api/projects/${projectId}/test-cases`);
    expect(tcRes.ok()).toBeTruthy();
    const { items: cases } = (await tcRes.json()) as { items: Array<{ id: number; title: string }> };
    const checkout = cases.find((c) => c.title === 'checkout works');
    expect(checkout, 'checkout test case exists').toBeTruthy();

    const res = await request.post(`/api/projects/${projectId}/flaky-classify`, {
      data: { testCaseId: checkout!.id },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).rootCause).toBe('timing');
  });

  test('validates input and unknown ids', async ({ request }) => {
    // Missing testCaseId → 400
    expect((await request.post(`/api/projects/${projectId}/flaky-classify`, { data: {} })).status()).toBe(400);
    // Unknown test case for classify → 404
    expect(
      (await request.post(`/api/projects/${projectId}/flaky-classify`, { data: { testCaseId: 9999999 } })).status(),
    ).toBe(404);
    // Unknown run for insights → 404
    expect((await request.get('/api/test-runs/9999999/insights')).status()).toBe(404);
  });
});

/**
 * The run-level baseline ladder as the API exposes it: environment first, then
 * branch; the base branch a pull-request run targets; and the two explicit
 * choices (`baseBranch`, `baseline`) with the sentence that explains each.
 */
test.describe.serial('Run baseline: environment, base branch and the explicit choices', () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const cases = (secondStatus: 'passed' | 'failed') => [
    { title: 'home loads', status: 'passed', duration: 300, location: 'tests/home.spec.ts:1:1' },
    { title: 'search works', status: secondStatus, duration: 400, location: 'tests/search.spec.ts:1:1' },
  ];
  const run = (opts: { status: string; environment: string; branch: string; days: number; baseBranch?: string }) => ({
    status: opts.status,
    environment: opts.environment,
    startTime: daysAgo(opts.days),
    duration: 1000,
    totalTests: 2,
    passedTests: opts.status === 'passed' ? 2 : 1,
    failedTests: opts.status === 'passed' ? 0 : 1,
    skippedTests: 0,
    metadata: { scm: { branch: opts.branch, baseBranch: opts.baseBranch, commit: `${opts.branch}-${opts.days}` } },
    testCases: cases(opts.status === 'passed' ? 'passed' : 'failed'),
  });

  async function submitTo(request: APIRequestContext, body: Record<string, unknown>) {
    const res = await request.post('/api/test-runs/submit', {
      data: { projectName: PROJECT.INSIGHTS_BASELINE, ...body },
    });
    expect(res.ok()).toBeTruthy();
    return res.json() as Promise<{ runId: number; projectId: number }>;
  }

  let productionMain = 0;
  let stagingMain = 0;
  let stagingFeature = 0;

  test('seeds passing runs on main in two environments and a failing pull-request run', async ({ request }) => {
    stagingMain = (await submitTo(request, run({ status: 'passed', environment: 'staging', branch: 'main', days: 4 })))
      .runId;
    productionMain = (
      await submitTo(request, run({ status: 'passed', environment: 'production', branch: 'main', days: 2 }))
    ).runId;
    stagingFeature = (
      await submitTo(
        request,
        run({ status: 'failed', environment: 'staging', branch: 'feature/x', days: 1, baseBranch: 'main' }),
      )
    ).runId;
    expect(stagingFeature).toBeGreaterThan(stagingMain);
  });

  test('the automatic baseline stays in the environment and falls back to the pull-request target', async ({
    request,
  }) => {
    const res = await request.get(`/api/test-runs/${stagingFeature}/insights`);
    expect(res.ok()).toBeTruthy();
    const insights = await res.json();
    expect(insights.hasBaseline).toBe(true);
    // The newer production run on main loses to the older staging one.
    expect(insights.baseline.id).toBe(stagingMain);
    expect(insights.baselineSource).toBe('auto');
    expect(insights.baselineMatch).toEqual({ branch: 'fallback', environment: 'same', outcome: 'passed' });
    expect(insights.fallbackBranch).toEqual({ branch: 'main', source: 'pull-request' });
    expect(insights.baselineNote).toBe(
      "No passing staging run exists on feature/x; the last passing run on the pull request's target branch main in staging.",
    );
    expect(insights.run).toEqual({ branch: 'feature/x', environment: 'staging' });
    expect(insights.baseBranches).toEqual(['main']);
    expect((insights.newRegressions as Array<{ title: string }>).map((r) => r.title)).toEqual(['search works']);
    // No environment change is reported against a same-environment baseline.
    expect((insights.metadataDiff as Array<{ key: string }>).map((d) => d.key)).not.toContain('environment');
  });

  test('a chosen base branch restricts the baseline to that branch', async ({ request }) => {
    const chosen = await (await request.get(`/api/test-runs/${stagingFeature}/insights?baseBranch=main`)).json();
    expect(chosen.baseline.id).toBe(stagingMain);
    expect(chosen.baselineSource).toBe('branch');
    expect(chosen.baselineMatch).toEqual({ branch: 'chosen', environment: 'same', outcome: 'passed' });
    expect(chosen.baselineNote).toBe('The last passing run on main in staging, the base branch you chose.');

    const none = await (await request.get(`/api/test-runs/${stagingFeature}/insights?baseBranch=nope`)).json();
    expect(none.hasBaseline).toBe(false);
    expect(none.baseBranch).toBe('nope');
    expect(none.baseBranches).toEqual(['main']);
  });

  test('a chosen run is used as-is and its environment change is reported', async ({ request }) => {
    const picked = await (
      await request.get(`/api/test-runs/${stagingFeature}/insights?baseline=${productionMain}`)
    ).json();
    expect(picked.baseline.id).toBe(productionMain);
    expect(picked.baselineSource).toBe('run');
    expect(picked.baselineMatch).toBeNull();
    expect(picked.baselineNote).toBe('The run you picked.');
    expect((picked.metadataDiff as Array<{ key: string }>).map((d) => d.key)).toContain('environment');
  });
});

import { test, expect, type APIRequestContext } from './fixtures';
import { retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * A flake-lab run replays one test under an injected condition, so nothing it
 * records may count as the suite's own behavior. A real run passes both tests;
 * three runs stamped `piwiFlakeLab` then fail and retry-pass `pays`, and pass it
 * twice; a last real run passes `pays` and fails `refunds`. The lab runs stay
 * out of the performance runs, the flaky list, the test's history and flake profile,
 * the failure clusters, the quarantine streak and the regression baseline.
 */
test.describe('Flake-lab runs', () => {
  test.describe.configure({ mode: 'serial' });

  const LAB = { piwiFlakeLab: { experimentId: 'exp-1', armId: 'delay-cart' } };
  const LAB_ERROR = "Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId('lab-cart-total')";
  const REAL_ERROR = 'Error: refund button never enabled';

  let projectId: number;
  let paysId: number;
  let lastRunId: number;
  let clock = Date.now() - 6 * 3_600_000;

  type Case = { title: string; status: string; retries?: number; error?: string };
  async function submit(request: APIRequestContext, cases: Case[], metadata: object | null): Promise<number> {
    clock += 600_000;
    const failed = cases.filter((c) => c.status === 'failed').length;
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.FLAKE_LAB_RUNS,
        status: failed > 0 ? 'failed' : 'passed',
        startTime: new Date(clock).toISOString(),
        duration: 10_000,
        totalTests: cases.length,
        passedTests: cases.length - failed,
        failedTests: failed,
        skippedTests: 0,
        ...(metadata ? { metadata } : {}),
        testCases: cases.map((c) => ({
          ...c,
          duration: 1_000,
          location: c.title === 'pays' ? 'tests/checkout.spec.ts:5:1' : 'tests/refunds.spec.ts:5:1',
        })),
      },
    });
    const body = await res.json();
    projectId = body.projectId;
    return body.runId;
  }

  test.beforeAll(async ({ request }) => {
    test.setTimeout(90_000);
    await submit(
      request,
      [
        { title: 'pays', status: 'passed' },
        { title: 'refunds', status: 'passed' },
      ],
      null,
    );
    const cases = await (await request.get(`/api/projects/${projectId}/test-cases?maxAgeDays=0`)).json();
    paysId = (cases.items as Array<{ id: number; title: string }>).find((c) => c.title === 'pays')!.id;
    const quarantined = await request.post(`/api/projects/${projectId}/quarantine`, {
      data: { testCaseId: paysId, reason: 'flaky on CI' },
    });
    expect(quarantined.ok()).toBeTruthy();
    // The runs below start after the quarantine, so the streak reads them.
    clock = Date.now();

    await submit(
      request,
      [
        { title: 'pays', status: 'failed', retries: 0, error: LAB_ERROR },
        { title: 'pays', status: 'passed', retries: 1 },
      ],
      LAB,
    );
    await submit(request, [{ title: 'pays', status: 'passed' }], LAB);
    await submit(request, [{ title: 'pays', status: 'passed' }], LAB);
    lastRunId = await submit(
      request,
      [
        { title: 'pays', status: 'passed' },
        { title: 'refunds', status: 'failed', error: REAL_ERROR },
      ],
      null,
    );
  });

  test('stay out of the performance runs and the test history', async ({ request }) => {
    const performance = await (await request.get(`/api/projects/${projectId}/performance`)).json();
    expect(performance.items).toHaveLength(2);
    const history = await (await request.get(`/api/test-cases/${paysId}/history`)).json();
    expect(history.items).toHaveLength(2);
    expect(history.items.every((h: { status: string }) => h.status === 'passed')).toBe(true);
  });

  test('stay out of the flaky list and the flake profile', async ({ request }) => {
    const flaky = await (await request.get(`/api/projects/${projectId}/flaky-tests?runs=20`)).json();
    expect(JSON.stringify(flaky)).not.toContain('"pays"');
    const profile = await (await request.get(`/api/test-cases/${paysId}/flake-profile`)).json();
    expect(profile.failures).toBe(0);
    expect(profile.passes).toBe(2);
  });

  test('form no failure cluster', async ({ request }) => {
    const clusters = await (await request.get(`/api/projects/${projectId}/failure-clusters`)).json();
    const text = JSON.stringify(clusters.items);
    expect(text).not.toContain('lab-cart-total');
    expect(text).toContain('refund button never enabled');
  });

  test('neither count toward nor break a quarantine streak', async ({ request }) => {
    const body = await (await request.get(`/api/projects/${projectId}/quarantine`)).json();
    const entry = (
      body.entries as Array<{ testCaseId: number; consecutivePasses: number; runsSinceQuarantine: number }>
    ).find((e) => e.testCaseId === paysId)!;
    expect(entry.consecutivePasses).toBe(1);
    expect(entry.runsSinceQuarantine).toBe(1);
  });

  test('are never the regression baseline', async ({ request }) => {
    // Against the first real run, `refunds` is a new regression; against the
    // newest lab run, which never ran it, it would have no baseline at all.
    await expect
      .poll(
        async () => {
          const run = await (await request.get(`/api/test-runs/${lastRunId}`)).json();
          const refunds = (run.testCases as Array<{ title: string; isNewRegression: unknown }>).find(
            (c) => c.title === 'refunds',
          );
          return refunds?.isNewRegression;
        },
        { timeout: 15_000 },
      )
      .toBeTruthy();
  });
});

/**
 * The fix plan — the single answer an agent acts on.
 *
 * What matters here is that every section degrades independently (a cluster
 * with no AI diagnosis is still actionable) and that the plan always states how
 * the work will be verified, since that is what closes the loop without a human
 * adjudicating whether the fix worked.
 */

import { test, expect, type APIRequestContext } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

interface FixPlan {
  cluster: { id: number; signature: string; status: string; occurrences: number };
  diagnosis: { rootCause: string | null; patch: string | null } | null;
  edits: Array<{ filePath: string; suggestedLocator: string | null }>;
  failingTests: Array<{ testCaseId: number; title: string; filePath: string; executionId: number }>;
  ownership: { owner: string | null; source: string | null };
  verify: { command: string; cases: Array<{ filePath: string; line?: number | null }>; expectation: string };
}

let clock = Date.now() - 3 * 60 * 60 * 1000;

async function submitFailingRun(request: APIRequestContext): Promise<void> {
  clock += 60 * 1000;
  const res = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.FIX_PLAN,
      status: 'failed',
      startTime: new Date(clock).toISOString(),
      duration: 2000,
      totalTests: 2,
      passedTests: 0,
      failedTests: 2,
      skippedTests: 0,
      testCases: [
        {
          title: 'checkout shows the total',
          status: 'failed',
          error:
            "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('pay')",
          duration: 1000,
          location: 'tests/checkout.spec.ts:12:5',
          testAnnotations: [{ type: 'piwi:owner', description: '@checkout-team' }],
        },
        {
          title: 'checkout applies a coupon',
          status: 'failed',
          error:
            "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('pay')",
          duration: 1000,
          location: 'tests/checkout.spec.ts:30:5',
        },
      ],
    },
  });
  expect(res.ok(), `submit failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

test.describe.serial('Fix plan', () => {
  let clusterId: number;
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    await submitFailingRun(request);

    const projects = (
      (await (await request.get('/api/projects')).json()) as { items: Array<{ id: number; name: string }> }
    ).items;
    projectId = projects.find((p) => p.name === PROJECT.FIX_PLAN)!.id;

    const clusters = (
      (await (await request.get(`/api/projects/${projectId}/failure-clusters`)).json()) as {
        items: Array<{ id: number }>;
      }
    ).items;
    expect(clusters.length).toBeGreaterThan(0);
    clusterId = clusters[0]!.id;
  });

  test('returns the failing tests behind the cluster', async ({ request }) => {
    const res = await request.get(`/api/failure-clusters/${clusterId}/fix-plan`);
    expect(res.ok()).toBeTruthy();
    const plan = (await res.json()) as FixPlan;

    expect(plan.cluster.id).toBe(clusterId);
    expect(plan.failingTests.map((t) => t.title).sort()).toEqual([
      'checkout applies a coupon',
      'checkout shows the total',
    ]);
  });

  test('lists each failing test once, not once per attempt', async ({ request }) => {
    await submitFailingRun(request);

    const plan = (await (await request.get(`/api/failure-clusters/${clusterId}/fix-plan`)).json()) as FixPlan;
    const ids = plan.failingTests.map((t) => t.testCaseId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2);
  });

  // Without an AI provider configured there is no diagnosis — the plan must
  // still be usable, or the feature only works for people who enabled AI.
  test('is actionable with no diagnosis available', async ({ request }) => {
    const plan = (await (await request.get(`/api/failure-clusters/${clusterId}/fix-plan`)).json()) as FixPlan;
    expect(plan.diagnosis).toBeNull();
    expect(plan.failingTests.length).toBeGreaterThan(0);
    expect(plan.verify.command).toBeTruthy();
  });

  test('tells the agent how the work will be verified', async ({ request }) => {
    const plan = (await (await request.get(`/api/failure-clusters/${clusterId}/fix-plan`)).json()) as FixPlan;

    // One command naming each affected test by file and title, so it still matches once the fix moves lines.
    expect(plan.verify.command).toBe(
      'npx playwright test "tests/checkout.spec.ts" -g "checkout applies a coupon|checkout shows the total"',
    );
    expect(plan.verify.cases.map((c) => `${c.filePath}:${c.line}`)).toEqual([
      'tests/checkout.spec.ts:30',
      'tests/checkout.spec.ts:12',
    ]);
    expect(plan.verify.expectation).toContain('Piwi records the fix');
  });

  test('an execution re-runs its test in CI only once CI re-run is set up', async ({ request }) => {
    const plan = (await (await request.get(`/api/failure-clusters/${clusterId}/fix-plan`)).json()) as FixPlan;
    const executionId = plan.failingTests[0]!.executionId;

    const info = await (await request.get(`/api/test-run-cases/${executionId}/rerun`)).json();
    expect(info).toMatchObject({ available: false, reason: 'CI re-run is off for this project.', lastDispatch: null });

    const res = await request.post(`/api/test-run-cases/${executionId}/rerun`);
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('CI re-run is off for this project.');
  });

  test('carries the declared owner', async ({ request }) => {
    const plan = (await (await request.get(`/api/failure-clusters/${clusterId}/fix-plan`)).json()) as FixPlan;
    expect(plan.ownership).toEqual({ owner: '@checkout-team', source: 'annotation' });
  });

  test('404s for a cluster that does not exist', async ({ request }) => {
    const res = await request.get('/api/failure-clusters/99999999/fix-plan');
    expect(res.status()).toBe(404);
  });
});

/**
 * Against the demo seed (a bare test database skips it): the plan reports the
 * patch validation stored with the diagnosis, so it agrees with the next step,
 * which proposes applying the patch only when that validation says it applies.
 */
test('reports the stored patch validation the next step relies on', async ({ request }) => {
  const res = await request.get('/api/failure-clusters/1');
  test.skip(!res.ok(), 'demo seed not loaded on this server');
  const cluster = (await res.json()) as { nextStep: { kind: string } };
  test.skip(cluster.nextStep.kind !== 'apply-patch', 'cluster #1 does not propose its patch on this database');

  const plan = (await (await request.get('/api/failure-clusters/1/fix-plan')).json()) as {
    diagnosis: { patch: string | null; patchValidation: { status: string } | null } | null;
  };
  expect(plan.diagnosis?.patch).toBeTruthy();
  expect(plan.diagnosis?.patchValidation?.status).toMatch(/^applies(-with-offset)?$/);
});

/**
 * Quarantine, end to end.
 *
 * The behaviour that distinguishes this from `--grep-invert @quarantine`: a
 * quarantined test keeps running and keeps reporting, so its passing streak
 * accumulates and the dashboard can propose letting it out again.
 */

import { test, expect, type APIRequestContext } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

interface QuarantineResponse {
  entries: Array<{
    testCaseId: number;
    title: string;
    reason: string | null;
    consecutivePasses: number;
    releaseProposed: boolean;
    runsSinceQuarantine: number;
  }>;
  debt: { active: number; readyToRelease: number; oldestAgeMs: number; stillFailing: number };
  candidates: Array<{ testCaseId: number; title: string; rationale: string }>;
  releaseAfterConsecutivePasses: number;
}

let clock = Date.now() - 12 * 60 * 60 * 1000;
function nextStartTime(): string {
  clock += 5 * 60 * 1000;
  return new Date(clock).toISOString();
}

async function submitRun(
  request: APIRequestContext,
  cases: Array<{ title: string; status: string; error?: string; retries?: number }>,
): Promise<number> {
  const failedTests = cases.filter((c) => c.status === 'failed').length;
  const res = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.QUARANTINE,
      status: failedTests > 0 ? 'failed' : 'passed',
      startTime: nextStartTime(),
      duration: 1000,
      totalTests: cases.length,
      passedTests: cases.length - failedTests,
      failedTests,
      skippedTests: 0,
      testCases: cases.map((c) => ({ ...c, duration: 10, location: 'tests/flaky.spec.ts:5:1' })),
    },
  });
  expect(res.ok(), `submit failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { runId: number }).runId;
}

async function getQuarantine(request: APIRequestContext, projectId: number): Promise<QuarantineResponse> {
  const res = await request.get(`/api/projects/${projectId}/quarantine`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as QuarantineResponse;
}

test.describe.serial('Quarantine', () => {
  let projectId: number;
  let flakyCaseId: number;

  test.beforeAll(async ({ request }) => {
    await submitRun(request, [
      { title: 'wobbly checkout', status: 'failed', error: 'Error: timeout' },
      { title: 'solid login', status: 'passed' },
    ]);

    const projects = (
      (await (await request.get('/api/projects')).json()) as { items: Array<{ id: number; name: string }> }
    ).items;
    projectId = projects.find((p) => p.name === PROJECT.QUARANTINE)!.id;

    const cases = (await (await request.get(`/api/projects/${projectId}/test-cases?maxAgeDays=0`)).json()) as {
      items: Array<{ id: number; title: string }>;
    };
    flakyCaseId = cases.items.find((c) => c.title === 'wobbly checkout')!.id;
  });

  test('starts empty', async ({ request }) => {
    const body = await getQuarantine(request, projectId);
    expect(body.entries).toEqual([]);
    expect(body.debt.active).toBe(0);
  });

  test('quarantining a test records it with its reason', async ({ request }) => {
    const res = await request.post(`/api/projects/${projectId}/quarantine`, {
      data: { testCaseId: flakyCaseId, reason: 'times out on CI only' },
    });
    expect(res.ok(), `POST quarantine failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    // The runs submitted from here on start after the quarantine, so its streak reads them.
    clock = Date.now();

    const body = await getQuarantine(request, projectId);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      testCaseId: flakyCaseId,
      title: 'wobbly checkout',
      reason: 'times out on CI only',
      consecutivePasses: 0,
      releaseProposed: false,
    });
    expect(body.debt.active).toBe(1);
  });

  test('quarantining twice is a no-op rather than a second entry', async ({ request }) => {
    const res = await request.post(`/api/projects/${projectId}/quarantine`, {
      data: { testCaseId: flakyCaseId, reason: 'ignored' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).created).toBe(false);

    const body = await getQuarantine(request, projectId);
    expect(body.entries).toHaveLength(1);
    // The original reason survives, so the audit trail is not overwritten.
    expect(body.entries[0]!.reason).toBe('times out on CI only');
  });

  test('the execution and its cluster report the quarantined state to the failure pages', async ({ request }) => {
    const runId = await submitRun(request, [
      { title: 'wobbly checkout', status: 'failed', error: 'Error: timeout' },
      { title: 'solid login', status: 'passed' },
    ]);

    const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ executionId: number; testCaseId: number; failureClusterId: number | null; title: string }>;
    };
    const wobbly = run.testCases.find((c) => c.title === 'wobbly checkout')!;
    const solid = run.testCases.find((c) => c.title === 'solid login')!;

    // The quarantined test's execution says so; a passing sibling does not.
    const wobblyExec = (await (await request.get(`/api/test-run-cases/${wobbly.executionId}`)).json()) as {
      quarantined: boolean;
    };
    expect(wobblyExec.quarantined).toBe(true);
    const solidExec = (await (await request.get(`/api/test-run-cases/${solid.executionId}`)).json()) as {
      quarantined: boolean;
    };
    expect(solidExec.quarantined).toBe(false);

    // The cluster carries the quarantined flag through to its affected tests.
    expect(wobbly.failureClusterId).not.toBeNull();
    const cluster = (await (await request.get(`/api/failure-clusters/${wobbly.failureClusterId}`)).json()) as {
      affectedTestCases: Array<{ testCaseId: number; quarantined: boolean }>;
    };
    const affected = cluster.affectedTestCases.find((t) => t.testCaseId === flakyCaseId);
    expect(affected?.quarantined).toBe(true);
  });

  test('the gate ignores a quarantined failure but still reports it', async ({ request }) => {
    const runId = await submitRun(request, [
      { title: 'wobbly checkout', status: 'failed', error: 'Error: timeout' },
      { title: 'solid login', status: 'passed' },
    ]);

    const res = await request.post(`/api/test-runs/${runId}/gate`, { data: { maxFailed: 0 } });
    const gate = (await res.json()) as {
      passed: boolean;
      facts: { failedTests: number; quarantinedFailures: number; quarantinedTotal: number };
    };

    // The run failed, but the only failure is quarantined — so the gate passes
    // while stating plainly what it excluded.
    expect(gate.passed).toBe(true);
    expect(gate.facts.failedTests).toBe(0);
    expect(gate.facts.quarantinedFailures).toBe(1);
    expect(gate.facts.quarantinedTotal).toBe(1);
  });

  test('a non-quarantined failure still fails the gate', async ({ request }) => {
    const runId = await submitRun(request, [
      { title: 'wobbly checkout', status: 'failed', error: 'Error: timeout' },
      { title: 'solid login', status: 'failed', error: 'Error: real breakage' },
    ]);

    const res = await request.post(`/api/test-runs/${runId}/gate`, { data: { maxFailed: 0 } });
    const gate = (await res.json()) as { passed: boolean; facts: { failedTests: number } };
    expect(gate.passed).toBe(false);
    expect(gate.facts.failedTests).toBe(1);
  });

  test('a quarantine ceiling can fail the gate on debt alone', async ({ request }) => {
    const runId = await submitRun(request, [{ title: 'solid login', status: 'passed' }]);
    const res = await request.post(`/api/test-runs/${runId}/gate`, { data: { maxQuarantined: 0 } });
    const gate = (await res.json()) as { passed: boolean; violations: Array<{ rule: string }> };
    expect(gate.passed).toBe(false);
    expect(gate.violations[0]?.rule).toBe('max-quarantined');
  });

  // The exit ramp: the test keeps running, so passes accumulate and the
  // dashboard eventually says it has earned its way out.
  test('consecutive passes propose a release', async ({ request }) => {
    const { releaseAfterConsecutivePasses } = await getQuarantine(request, projectId);

    for (let i = 0; i < releaseAfterConsecutivePasses; i++) {
      await submitRun(request, [
        { title: 'wobbly checkout', status: 'passed' },
        { title: 'solid login', status: 'passed' },
      ]);
    }

    const body = await getQuarantine(request, projectId);
    expect(body.entries[0]!.consecutivePasses).toBeGreaterThanOrEqual(releaseAfterConsecutivePasses);
    expect(body.entries[0]!.releaseProposed).toBe(true);
    expect(body.debt.readyToRelease).toBe(1);
  });

  test('one failure resets the streak', async ({ request }) => {
    await submitRun(request, [{ title: 'wobbly checkout', status: 'failed', error: 'Error: timeout' }]);

    const body = await getQuarantine(request, projectId);
    expect(body.entries[0]!.consecutivePasses).toBe(0);
    expect(body.entries[0]!.releaseProposed).toBe(false);
  });

  test('releasing lets the test block the gate again', async ({ request }) => {
    // The optional release reason rides in the request body (not the query
    // string), like every other mutation.
    const res = await request.delete(`/api/projects/${projectId}/quarantine/${flakyCaseId}`, {
      data: { reason: 'stable for two weeks' },
    });
    expect(res.ok()).toBeTruthy();

    const body = await getQuarantine(request, projectId);
    expect(body.entries).toEqual([]);

    const runId = await submitRun(request, [{ title: 'wobbly checkout', status: 'failed', error: 'Error: timeout' }]);
    const gate = (await (await request.post(`/api/test-runs/${runId}/gate`, { data: { maxFailed: 0 } })).json()) as {
      passed: boolean;
    };
    expect(gate.passed).toBe(false);
  });

  test('releasing a test that is not quarantined is a 404', async ({ request }) => {
    const res = await request.delete(`/api/projects/${projectId}/quarantine/${flakyCaseId}`);
    expect(res.status()).toBe(404);
  });
});

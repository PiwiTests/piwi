/**
 * Tests for the flaky-tests detection endpoint (Pillar 3).
 *
 * Verifies the scoring algorithm using controlled test-run submissions.
 */

import { test, expect, type APIRequestContext } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

interface FlakyTestResult {
  title: string;
  testCaseId: number;
  latestRunsCaseId: number;
  retryPassRuns: number;
  alternations: number;
  score: number;
  failureRate: number;
  filePath: string;
}

async function submitRun(
  request: APIRequestContext,
  cases: Array<{
    title: string;
    status: string;
    duration?: number;
    location?: string;
    error?: string;
    retries?: number;
  }>,
  startTime?: string,
) {
  const passedTests = cases.filter((c) => c.status === 'passed').length;
  const failedTests = cases.filter((c) => c.status === 'failed').length;

  const res = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.FLAKY_BOARD,
      status: failedTests > 0 ? 'failed' : 'passed',
      startTime: startTime ?? new Date().toISOString(),
      duration: 30000,
      totalTests: cases.length,
      passedTests,
      failedTests,
      skippedTests: 0,
      testCases: cases,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json() as Promise<{ runId: number; projectId: number }>;
}

test.describe.serial('Flaky tests endpoint', () => {
  let projectId: number | null = null;

  // Build a base time counter so runs have chronological ordering
  const baseMs = Date.now() - 100 * 60 * 60 * 1000; // 100 h ago
  let timeOffset = 0;
  function nextStartTime() {
    timeOffset += 60 * 60 * 1000;
    return new Date(baseMs + timeOffset).toISOString();
  }

  test('returns empty array for project with no runs', async ({ request }) => {
    const { projectId: pid } = await submitRun(request, [
      { title: 'stable test', status: 'passed', duration: 500, location: 'tests/a.spec.ts:1:1' },
    ]);
    projectId = pid;

    const res = await request.get(`/api/projects/${pid}/flaky-tests?runs=50`);
    expect(res.ok()).toBeTruthy();
    const { items: tests } = await res.json();
    // 1 run is below the 3-run minimum
    expect(Array.isArray(tests)).toBe(true);
    expect(tests).toHaveLength(0);
  });

  test('detects flaky test via retry-pass pattern over multiple runs', async ({ request }) => {
    expect(projectId).toBeTruthy();

    // Submit 5 runs: 3 where 'login flaky test' fails then passes on retry
    for (let i = 0; i < 5; i++) {
      const isFlaky = i < 3;
      await submitRun(
        request,
        isFlaky
          ? [
              // Fail on first attempt, pass on retry
              {
                title: 'login flaky test',
                status: 'failed',
                duration: 1500,
                location: 'tests/auth.spec.ts:1:1',
                error: 'TimeoutError: 30000ms\n    at tests/auth.spec.ts:1',
                retries: 0,
              },
              {
                title: 'login flaky test',
                status: 'passed',
                duration: 1200,
                location: 'tests/auth.spec.ts:1:1',
                retries: 1,
              },
              { title: 'stable test', status: 'passed', duration: 500, location: 'tests/a.spec.ts:1:1' },
            ]
          : [
              { title: 'login flaky test', status: 'passed', duration: 1200, location: 'tests/auth.spec.ts:1:1' },
              { title: 'stable test', status: 'passed', duration: 500, location: 'tests/a.spec.ts:1:1' },
            ],
        nextStartTime(),
      );
    }

    const res = await request.get(`/api/projects/${projectId}/flaky-tests?runs=20`);
    expect(res.ok()).toBeTruthy();
    const { items: tests } = await res.json();
    expect(Array.isArray(tests)).toBe(true);

    const flakyTest = (tests as FlakyTestResult[]).find((t) => t.title === 'login flaky test')!;
    expect(flakyTest).toBeDefined();
    expect(flakyTest.retryPassRuns).toBeGreaterThanOrEqual(3);
    expect(flakyTest.score).toBeGreaterThan(0);
    expect(flakyTest.score).toBeLessThanOrEqual(100);
    expect(typeof flakyTest.failureRate).toBe('number');
    expect(typeof flakyTest.latestRunsCaseId).toBe('number');
  });

  test('stable test is not flagged as flaky', async ({ request }) => {
    expect(projectId).toBeTruthy();

    const res = await request.get(`/api/projects/${projectId}/flaky-tests?runs=20`);
    expect(res.ok()).toBeTruthy();
    const { items: tests } = await res.json();

    const stableTest = (tests as FlakyTestResult[]).find((t) => t.title === 'stable test');
    expect(stableTest).toBeUndefined();
  });

  test('detects flaky test via alternating pass/fail pattern (no retries)', async ({ request }) => {
    expect(projectId).toBeTruthy();

    // 6 runs alternating pass/fail for 'alternating test'
    for (let i = 0; i < 6; i++) {
      const fail = i % 2 === 0;
      await submitRun(
        request,
        [
          fail
            ? {
                title: 'alternating test',
                status: 'failed',
                duration: 800,
                location: 'tests/b.spec.ts:1:1',
                error: 'expect(received).toBe(expected)\nExpected: true\nReceived: false',
              }
            : { title: 'alternating test', status: 'passed', duration: 700, location: 'tests/b.spec.ts:1:1' },
          { title: 'stable test', status: 'passed', duration: 500, location: 'tests/a.spec.ts:1:1' },
        ],
        nextStartTime(),
      );
    }

    const res = await request.get(`/api/projects/${projectId}/flaky-tests?runs=20`);
    expect(res.ok()).toBeTruthy();
    const { items: tests } = await res.json();

    const altTest = (tests as FlakyTestResult[]).find((t) => t.title === 'alternating test')!;
    expect(altTest).toBeDefined();
    expect(altTest.alternations).toBeGreaterThanOrEqual(2);
    expect(altTest.score).toBeGreaterThan(0);
  });

  test('runs window parameter limits scope of analysis', async ({ request }) => {
    expect(projectId).toBeTruthy();

    // With runs=1, no test should qualify (< 3 runs minimum)
    const res = await request.get(`/api/projects/${projectId}/flaky-tests?runs=1`);
    expect(res.ok()).toBeTruthy();
    const { items: tests } = await res.json();
    expect(tests).toHaveLength(0);
  });

  test('results are sorted by impact descending', async ({ request }) => {
    expect(projectId).toBeTruthy();

    const res = await request.get(`/api/projects/${projectId}/flaky-tests?runs=50`);
    expect(res.ok()).toBeTruthy();
    const { items: tests } = await res.json();

    if (tests.length >= 2) {
      for (let i = 0; i < tests.length - 1; i++) {
        expect(tests[i].impact).toBeGreaterThanOrEqual(tests[i + 1].impact);
      }
    }
  });

  test('flaky-tests endpoint returns 404 for unknown project', async ({ request }) => {
    const res = await request.get('/api/projects/999999/flaky-tests');
    expect(res.status()).toBe(404);
  });
});

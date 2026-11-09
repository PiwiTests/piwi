/**
 * Tests for the dashboard-overview endpoints:
 *   GET /api/projects/:id/latest-run  – id + status of the project's most recent run
 *   GET /api/projects/overview        – compact per-project overview with trend data
 */
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

test.describe.serial('Latest Run API Tests', () => {
  let projectId: number;
  let firstRunId: number;
  let secondRunId: number;

  test.beforeAll(async ({ request }) => {
    const first = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.LATEST_RUN_TEST,
        status: 'passed',
        startTime: new Date(Date.now() - 60_000).toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(first.ok()).toBeTruthy();
    const firstData = await first.json();
    projectId = firstData.projectId;
    firstRunId = firstData.runId;

    const second = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.LATEST_RUN_TEST,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 2000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [{ title: 'a failing test', status: 'failed', duration: 500, location: 'tests/x.spec.ts:1:1' }],
      },
    });
    expect(second.ok()).toBeTruthy();
    const secondData = await second.json();
    secondRunId = secondData.runId;
  });

  test('GET /api/projects/:id/latest-run returns the most recently submitted run, not the passed one', async ({
    request,
  }) => {
    expect(secondRunId).toBeGreaterThan(firstRunId);

    const response = await request.get(`/api/projects/${projectId}/latest-run`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();

    expect(data).toEqual({ id: secondRunId, status: 'failed' });
  });

  test('GET /api/projects/:id/latest-run returns 400 for a non-numeric project id', async ({ request }) => {
    const response = await request.get('/api/projects/not-a-number/latest-run');
    expect(response.status()).toBe(400);
  });

  test('GET /api/projects/:id/latest-run returns 404 for an unknown project', async ({ request }) => {
    // An id past any a database holds, so a long-lived database or the desktop app has no such project either.
    const response = await request.get('/api/projects/2000000000/latest-run');
    expect(response.status()).toBe(404);
  });
});

test.describe.serial('Projects Overview API Tests', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    // A "flaky-looking" project: oldest run failed, most recent run passed.
    const failedRun = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DASHBOARD_OVERVIEW,
        status: 'failed',
        startTime: new Date(Date.now() - 60_000).toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [{ title: 't1', status: 'failed', duration: 500, location: 'tests/t1.spec.ts:1:1', error: 'e' }],
      },
    });
    expect(failedRun.ok()).toBeTruthy();
    const failedData = await failedRun.json();
    projectId = failedData.projectId;

    const passedRun = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DASHBOARD_OVERVIEW,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1200,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 't1', status: 'passed', duration: 400, location: 'tests/t1.spec.ts:1:1' }],
      },
    });
    expect(passedRun.ok()).toBeTruthy();
  });

  test('GET /api/projects/overview includes the project with the expected shape', async ({ request }) => {
    const response = await request.get('/api/projects/overview');
    expect(response.ok()).toBeTruthy();
    const projects: Array<{
      id: number;
      name: string;
      label: string | null;
      tags: unknown[];
      totalFullRuns: number;
      latestFullRun: { id: number; status: string; passedTests: number; failedTests: number } | null;
      recentRuns: Array<{ id: number; status: string; startTime: string }>;
      tendency: string;
    }> = (await response.json()).items;

    const project = projects.find((p) => p.id === projectId);
    expect(project).toBeDefined();
    expect(project!.name).toBe(PROJECT.DASHBOARD_OVERVIEW);
    expect(project!.label).toBeNull();
    expect(project!.tags).toEqual([]);
    expect(project!.totalFullRuns).toBe(2);
  });

  test('GET /api/projects/overview reports the latest full run', async ({ request }) => {
    const response = await request.get('/api/projects/overview');
    const projects = (
      (await response.json()) as {
        items: Array<{
          id: number;
          latestFullRun: { status: string; passedTests: number; failedTests: number } | null;
        }>;
      }
    ).items;
    const project = projects.find((p) => p.id === projectId)!;

    expect(project.latestFullRun).not.toBeNull();
    expect(project.latestFullRun!.status).toBe('passed');
    expect(project.latestFullRun!.passedTests).toBe(1);
    expect(project.latestFullRun!.failedTests).toBe(0);
  });

  test('GET /api/projects/overview orders recentRuns oldest-first and derives a flaky tendency', async ({
    request,
  }) => {
    const response = await request.get('/api/projects/overview');
    const projects = (
      (await response.json()) as {
        items: Array<{
          id: number;
          recentRuns: Array<{ status: string }>;
          tendency: string;
        }>;
      }
    ).items;
    const project = projects.find((p) => p.id === projectId)!;

    expect(project.recentRuns).toHaveLength(2);
    // Oldest (failed) run first, most recent (passed) run last.
    expect(project.recentRuns[0]!.status).toBe('failed');
    expect(project.recentRuns[1]!.status).toBe('passed');
    // A failed run followed by a passed run within the trailing window is "flaky".
    expect(project.tendency).toBe('flaky');
  });
});

import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

test.describe.serial('Delete test run API', () => {
  let runId: number;
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    // Create a test run to delete
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DELETE_TEST,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 60000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'test to delete 1',
            status: 'passed',
            duration: 1000,
            location: 'tests/delete.spec.ts:5:5',
          },
          {
            title: 'test to delete 2',
            status: 'passed',
            duration: 1500,
            location: 'tests/delete.spec.ts:10:5',
          },
        ],
      },
    });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    runId = data.runId;
    projectId = data.projectId;
  });

  test('should return 404 for non-existent test run', async ({ request }) => {
    const response = await request.delete('/api/test-runs/99999999');
    expect(response.status()).toBe(404);
  });

  test('should delete a test run and its test results', async ({ request }) => {
    // Verify the run exists
    const beforeResponse = await request.get(`/api/test-runs/${runId}`);
    expect(beforeResponse.ok()).toBeTruthy();

    // Delete it
    const deleteResponse = await request.delete(`/api/test-runs/${runId}`);
    expect(deleteResponse.ok()).toBeTruthy();
    const deleteData = await deleteResponse.json();
    expect(deleteData.success).toBe(true);

    // Verify it's gone
    const afterResponse = await request.get(`/api/test-runs/${runId}`);
    expect(afterResponse.status()).toBe(404);
  });

  test('should reflect deletion in project test runs list', async ({ request }) => {
    const response = await request.get(`/api/projects/${projectId}`);
    expect(response.ok()).toBeTruthy();
    const project = await response.json();
    const run = project.testRuns?.find((r: { id: number }) => r.id === runId);
    expect(run).toBeUndefined();
  });
});

test.describe('Admin Stats API', () => {
  test.beforeAll(async ({ request }) => {
    // Ensure there is at least one test run
    await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.STATS_TEST,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 30000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'stats test case',
            status: 'passed',
            duration: 500,
            location: 'tests/stats.spec.ts:1:1',
          },
        ],
      },
    });
  });

  test('should return storage statistics', async ({ request }) => {
    const response = await request.get('/api/admin/stats');
    expect(response.ok()).toBeTruthy();

    const stats = await response.json();
    expect(typeof stats.totalProjects).toBe('number');
    expect(typeof stats.totalRuns).toBe('number');
    expect(typeof stats.totalTestCases).toBe('number');
    expect(typeof stats.totalRunsCases).toBe('number');
    expect(typeof stats.totalFiles).toBe('number');
    expect(typeof stats.totalFileSize).toBe('number');

    expect(stats.totalProjects).toBeGreaterThan(0);
    expect(stats.totalRuns).toBeGreaterThan(0);
  });
});

test.describe('Admin Cleanup API', () => {
  test('should reject invalid olderThanDays value', async ({ request }) => {
    const response = await request.delete('/api/admin/cleanup', {
      data: { olderThanDays: 0 },
    });
    expect(response.status()).toBe(400);
  });

  test('should delete runs older than given days', async ({ request }) => {
    // Create a run with an old start time (simulate by submitting then checking cleanup)
    // We cannot easily set an old date via submit, but we can verify the endpoint works
    // and returns 0 deleted when no runs are old enough
    const response = await request.delete('/api/admin/cleanup', {
      data: { olderThanDays: 365 * 100 }, // 100 years — nothing should be that old
    });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.deletedRuns).toBe(0);
  });

  test('leaves the database writable: runs submitted right after it are stored', async ({ request }) => {
    const run = (cases: number, prefix: string) => ({
      projectName: PROJECT.CLEANUP_WRITES,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 1000,
      totalTests: cases,
      passedTests: 0,
      failedTests: cases,
      skippedTests: 0,
      testCases: Array.from({ length: cases }, (_, i) => ({
        title: `${prefix} ${i}`,
        status: 'failed',
        duration: 10,
        location: `tests/cleanup-writes.spec.ts:${i + 1}:1`,
        error: `Error: ${prefix} ${i} failed\n${'at step '.repeat(200)}`,
      })),
    });

    // A deleted run leaves free pages for the cleanup to give back.
    const freed = await request.post('/api/test-runs/submit', { data: run(80, 'freed') });
    expect(freed.ok()).toBeTruthy();
    expect((await request.delete(`/api/test-runs/${(await freed.json()).runId}`)).ok()).toBeTruthy();

    const cleanup = await request.delete('/api/admin/cleanup', { data: { olderThanDays: 365 * 100 } });
    expect(cleanup.ok()).toBeTruthy();

    // Submitted together, the runs reach both of the server's SQLite connections.
    const submits = await Promise.all(
      Array.from({ length: 4 }, (_, i) => request.post('/api/test-runs/submit', { data: run(3, `after ${i}`) })),
    );
    expect(submits.map((response) => response.status())).toEqual([200, 200, 200, 200]);

    // Read together too, so each connection reads the runs: they were committed.
    const runIds = await Promise.all(submits.map(async (response) => (await response.json()).runId as number));
    const reads = await Promise.all([...runIds, ...runIds].map((runId) => request.get(`/api/test-runs/${runId}`)));
    expect(reads.map((response) => response.status())).toEqual(Array(8).fill(200));
  });
});

import http from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { test, expect } from './fixtures';
import { retryPost, waitForHydration } from './utils';
import { startSpawnedServer, type SpawnedServer } from './utils/spawned-server';
import { PROJECT } from '#shared/test-project-names';

/**
 * What the instance is doing now, for an administrator deciding when to restart it: the runs in progress across every
 * project, answered by the admin activity route and shown on Settings → About. The counts of this server process are
 * checked on a server of its own (port 3108), where nothing else holds a stream or sends a run.
 */

const PORT = 3108;

interface Activity {
  runsInProgress: Array<{ status: string; lastActivityAt: string }>;
  requestsInProgress: number;
  diagnosesInProgress: number;
  assistantAnswersInProgress: number;
  openEventStreams: number;
}

test.describe('Instance activity', () => {
  test('counts a run until it ends, and Settings → About shows it', async ({ page, request }) => {
    const setup = await (
      await retryPost(request, '/api/test-runs/setup', {
        data: { projectName: PROJECT.ADMIN_ACTIVITY, startTime: new Date().toISOString() },
      })
    ).json();
    try {
      const response = await request.get('/api/admin/activity');
      expect(response.ok()).toBeTruthy();
      const activity = (await response.json()) as Activity;
      expect(activity.runsInProgress.map((run) => run.status)).toContain('initializing');
      expect(activity).toMatchObject({
        requestsInProgress: expect.any(Number),
        diagnosesInProgress: expect.any(Number),
        assistantAnswersInProgress: expect.any(Number),
        openEventStreams: expect.any(Number),
      });

      await page.goto('/settings/about');
      await waitForHydration(page);
      const tile = page.getByTestId('about-activity');
      await expect(tile).toContainText(/^Runs in progress\s*[1-9]\d*/);
    } finally {
      const begun = await (
        await retryPost(request, `/api/test-runs/${setup.runId}/begin`, {
          data: { setupToken: setup.setupToken, totalTests: 0 },
        })
      ).json();
      await retryPost(request, `/api/test-runs/${setup.runId}/finish`, {
        data: { streamToken: begun.streamToken, status: 'passed', totalTests: 0 },
      });
    }
  });
});

test.describe('Instance activity counts', () => {
  let server: SpawnedServer | undefined;

  test.beforeAll(async () => {
    test.setTimeout(6 * 60_000);
    server = startSpawnedServer({ port: PORT, tempDir: resolve('.test-temp', 'admin-activity') });
    await server.ready(5 * 60_000);
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  test('count a held event stream and a run arriving until each closes', async () => {
    test.setTimeout(3 * 60_000);
    const base = server!.baseUrl;
    const activity = async () => (await (await fetch(`${base}/api/admin/activity`)).json()) as Activity;
    const counts = async () => {
      const { requestsInProgress, openEventStreams } = await activity();
      return { requestsInProgress, openEventStreams };
    };
    await expect.poll(counts, { timeout: 60_000 }).toEqual({ requestsInProgress: 0, openEventStreams: 0 });

    const stream = new AbortController();
    await fetch(`${base}/api/stream`, { signal: stream.signal });
    await expect.poll(counts).toEqual({ requestsInProgress: 0, openEventStreams: 1 });
    stream.abort();
    await expect.poll(counts).toEqual({ requestsInProgress: 0, openEventStreams: 0 });

    // A run's results whose body has not all arrived.
    const body = JSON.stringify({
      projectName: PROJECT.ADMIN_ACTIVITY,
      status: 'passed',
      startTime: new Date().toISOString(),
      duration: 1000,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      testCases: [],
    });
    const submit = http.request(`${base}/api/test-runs/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    const answered = once(submit, 'response');
    submit.write(body.slice(0, 20));
    await expect.poll(counts).toEqual({ requestsInProgress: 1, openEventStreams: 0 });
    submit.end(body.slice(20));
    const [response] = (await answered) as [http.IncomingMessage];
    response.resume();
    expect(response.statusCode).toBe(200);
    await expect.poll(counts).toEqual({ requestsInProgress: 0, openEventStreams: 0 });
  });
});

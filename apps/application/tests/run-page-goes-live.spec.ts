import * as http from 'node:http';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget, targetAuthHeaders } from './desktop-target';
import { waitForHydration } from './utils';

/**
 * A run page opened while its run initializes (the reporter's global setup registered it, no test has begun) goes
 * live as the run starts, without a reload: its running test shows the step its worker is on and, in a project with
 * the live view on, Watch. The page reads the run again as the instance's stream opens, which it does as soon as it
 * is subscribed, so a start sent before the page listened is not missed either.
 */

const target = resolveE2ETarget();

/** A worker's stream to the run's live view, held as a test worker holds it. */
function holdWorkerStream(runId: number, key: string): { close: () => void } {
  const request = http.request(`${target.baseUrl}/api/test-runs/${runId}/live-view?worker=0`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${key}` },
  });
  request.on('response', (response) => response.resume());
  request.on('error', () => {});
  request.end();
  return { close: () => request.destroy() };
}

/** The instance's run events (`/api/stream`), as they arrive. */
function openInstanceStream(): { text: () => string; close: () => void } {
  let text = '';
  const request = http.request(`${target.baseUrl}/api/stream`, {
    headers: { Accept: 'text/event-stream', ...targetAuthHeaders(target) },
  });
  request.on('response', (response) => response.on('data', (chunk) => (text += String(chunk))));
  request.on('error', () => {});
  request.end();
  return { text: () => text, close: () => request.destroy() };
}

test('the instance’s stream opens once subscribed, and hears every run event after', async ({ request }) => {
  const stream = openInstanceStream();
  try {
    // The comment comes at once, not with the first heartbeat.
    await expect.poll(stream.text, { timeout: 5_000 }).toMatch(/^: subscribed\n\n/);
    const setup = await request.post('/api/test-runs/setup', {
      data: { projectName: PROJECT.RUN_GOES_LIVE, startTime: new Date().toISOString() },
    });
    expect(setup.ok()).toBeTruthy();
    const { runId } = (await setup.json()) as { runId: number };
    await expect.poll(stream.text).toContain(`"type":"run-initializing","runId":${runId}`);
  } finally {
    stream.close();
  }
});

test.describe('Run page of an initializing run', () => {
  test.skip(target.desktop, 'the desktop app mints no live view key, and a test worker holds no desktop token');

  test('goes live as the run starts, with its worker’s step and Watch, without a reload', async ({ page, request }) => {
    test.setTimeout(60_000);
    // The project, with the live view on.
    const submitted = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_GOES_LIVE,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(submitted.ok()).toBeTruthy();
    const first = (await submitted.json()) as { runId: number };
    const { projectId } = (await (await request.get(`/api/test-runs/${first.runId}`)).json()) as { projectId: number };
    expect((await request.patch(`/api/projects/${projectId}`, { data: { liveView: true } })).ok()).toBeTruthy();

    // A CI run's setup, as the reporter's global setup asks for it.
    const setup = await request.post('/api/test-runs/setup', {
      data: { projectName: PROJECT.RUN_GOES_LIVE, startTime: new Date().toISOString(), liveView: true },
    });
    expect(setup.ok()).toBeTruthy();
    const { runId, setupToken, liveView } = (await setup.json()) as {
      runId: number;
      setupToken: string;
      liveView: { key: string };
    };

    const stream = page.waitForResponse((response) => response.url().includes('/api/stream'));
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    const header = page.locator('[data-shot="run-header"]');
    await expect(header).toContainText(/initializing/i);
    // The page hears the run's events from here.
    await stream;
    await page.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));

    // The tests begin: worker 0 runs one, and opens its stream to the live view.
    const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 1 } });
    expect(begun.ok()).toBeTruthy();
    const { streamToken } = (await begun.json()) as { streamToken: string };
    const events = (testCases: Array<Record<string, unknown>>) =>
      request.post(`/api/test-runs/${runId}/events`, { data: { streamToken, testCases } });
    expect(
      (
        await events([
          {
            type: 'begin',
            title: 'pays on a slow page',
            location: 'tests/checkout.spec.ts:3:1',
            workerIndex: 0,
            startedAt: Date.now(),
          },
        ])
      ).ok(),
    ).toBeTruthy();
    const worker = holdWorkerStream(runId, liveView.key);
    try {
      await expect(header).toContainText(/running/i, { timeout: 15_000 });
      await expect(page.getByText('In progress…')).toBeVisible({ timeout: 15_000 });

      // The page streams the run now: the step the worker takes shows on its test's row.
      expect(
        (
          await events([
            {
              type: 'step-begin',
              title: 'Click',
              subtitle: "getByRole('button', { name: 'Pay' })",
              parentTitle: 'pays on a slow page',
              stepCategory: 'pw:api',
              location: 'tests/checkout.spec.ts:5:3',
              workerIndex: 0,
              startedAt: Date.now(),
            },
          ])
        ).ok(),
      ).toBeTruthy();
      await expect(page.getByTestId('live-step')).toContainText('Click');
      await expect(page.getByRole('button', { name: 'Watch worker 0 live' })).toBeVisible({ timeout: 15_000 });

      expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
    } finally {
      worker.close();
      await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'passed', totalTests: 0 } });
    }
  });
});

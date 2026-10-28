import * as http from 'node:http';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget, targetAuthHeaders } from './desktop-target';
import { waitForHydration } from './utils';
import { holdWorkerStream } from './utils/live-view';

/**
 * A run page opened while its run initializes (the reporter's global setup registered it, no test has begun) goes
 * live as the run starts, without a reload: its running test shows the step its worker is on and, in a project with
 * the live view on, Watch. It goes live on the run's start event, and on a start sent before the page listened, which
 * it reads as the instance's stream opens; the stream opens as soon as the server has subscribed it.
 */

const target = resolveE2ETarget();

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

/** A CI run's setup, as the reporter's global setup asks for it: the run initializes. */
async function setUpRun(request: APIRequestContext, liveView = false) {
  const setup = await request.post('/api/test-runs/setup', {
    data: { projectName: PROJECT.RUN_GOES_LIVE, startTime: new Date().toISOString(), liveView },
  });
  expect(setup.ok()).toBeTruthy();
  return (await setup.json()) as { runId: number; setupToken: string; liveView?: { key: string } };
}

/** The run's tests begin: worker 0 runs one. Returns the run's stream token. */
async function beginRun(request: APIRequestContext, runId: number, setupToken: string): Promise<string> {
  const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 1 } });
  expect(begun.ok()).toBeTruthy();
  const { streamToken } = (await begun.json()) as { streamToken: string };
  const events = await request.post(`/api/test-runs/${runId}/events`, {
    data: {
      streamToken,
      testCases: [
        {
          type: 'begin',
          title: 'pays on a slow page',
          location: 'tests/checkout.spec.ts:3:1',
          workerIndex: 0,
          startedAt: Date.now(),
        },
      ],
    },
  });
  expect(events.ok()).toBeTruthy();
  return streamToken;
}

/** End the run, beginning it first when it never began, so it is not left for the stale-run sweep. */
async function endRun(request: APIRequestContext, runId: number, setupToken: string, streamToken: string | null) {
  let token = streamToken;
  if (!token) {
    const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 0 } });
    token = ((await begun.json()) as { streamToken?: string }).streamToken ?? null;
  }
  if (token) {
    await request.post(`/api/test-runs/${runId}/finish`, {
      data: { streamToken: token, status: 'passed', totalTests: 0 },
    });
  }
}

/** Open the run's page and see it initializing; the page notes it was loaded, so a reload shows. */
async function openInitializingRun(page: Page, runId: number) {
  await page.goto(`/test-runs/${runId}`);
  await waitForHydration(page);
  const header = page.locator('[data-shot="run-header"]');
  await expect(header).toContainText(/initializing/i);
  await page.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));
  return header;
}

async function sameDocument(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument);
}

test('the instance’s stream opens once subscribed, and hears every run event after', async ({ request }) => {
  const stream = openInstanceStream();
  let run: { runId: number; setupToken: string } | null = null;
  try {
    // The comment comes at once, not with the first heartbeat.
    await expect.poll(stream.text, { timeout: 5_000 }).toMatch(/^: subscribed\n\n/);
    run = await setUpRun(request);
    await expect.poll(stream.text).toContain(`"type":"run-initializing","runId":${run.runId}`);
  } finally {
    stream.close();
    if (run) await endRun(request, run.runId, run.setupToken, null);
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

    const { runId, setupToken, liveView } = await setUpRun(request, true);
    let streamToken: string | null = null;
    let worker: { close: () => void } | null = null;
    try {
      const stream = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/stream');
      const header = await openInitializingRun(page, runId);
      // The page hears the run's events from here.
      await stream;

      streamToken = await beginRun(request, runId, setupToken);
      worker = holdWorkerStream(target.baseUrl, runId, liveView!.key);
      await expect(header).toContainText(/running/i, { timeout: 15_000 });
      await expect(page.getByText('In progress…')).toBeVisible({ timeout: 15_000 });

      // The page streams the run now: the step the worker takes shows on its test's row.
      const step = await request.post(`/api/test-runs/${runId}/events`, {
        data: {
          streamToken,
          testCases: [
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
          ],
        },
      });
      expect(step.ok()).toBeTruthy();
      await expect(page.getByTestId('live-step')).toContainText('Click');
      await expect(page.getByRole('button', { name: 'Watch worker 0 live' })).toBeVisible({ timeout: 15_000 });

      expect(await sameDocument(page)).toBe(true);
    } finally {
      worker?.close();
      await endRun(request, runId, setupToken, streamToken);
    }
  });

  test('goes live when the run started before the page listened', async ({ page, request }) => {
    test.setTimeout(60_000);
    const { runId, setupToken } = await setUpRun(request);
    let streamToken: string | null = null;
    // The page's request for the instance's stream waits until the run has begun: its start event reaches no one.
    let held!: () => void;
    const requested = new Promise<void>((resolve) => (held = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === '/api/stream',
      async (route) => {
        held();
        await released;
        await route.continue();
      },
    );
    try {
      const header = await openInitializingRun(page, runId);
      await requested;
      streamToken = await beginRun(request, runId, setupToken);
      release();

      await expect(header).toContainText(/running/i, { timeout: 15_000 });
      await expect(page.getByText('In progress…')).toBeVisible({ timeout: 15_000 });
      expect(await sameDocument(page)).toBe(true);
    } finally {
      release();
      await endRun(request, runId, setupToken, streamToken);
    }
  });
});

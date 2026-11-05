import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget } from './desktop-target';
import { waitForHydration } from './utils';

/**
 * A page that follows a running run keeps its live connection beside other dashboard tabs, and says so when it has
 * none. Over HTTP/1.1 a browser opens at most six connections to an address: one tab of the browser holds the
 * notification stream, so Home, a project's runs, three hidden tabs and the run page leave the run page room for its
 * own stream. A page whose stream does not open says why, with Retry, and a list whose first connection opens late
 * reads its runs again when a run started meanwhile.
 */

const target = resolveE2ETarget();

/** Every `EventSource` the page creates, kept on `window` so the test can read their states. */
function trackStreams() {
  const Original = window.EventSource;
  const streams: EventSource[] = [];
  (window as unknown as { piwiStreams: EventSource[] }).piwiStreams = streams;
  window.EventSource = class extends Original {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      streams.push(this);
    }
  };
}

/** The page's streams not closed: their paths and whether each is open (`EventSource.OPEN`). */
function streamsOf(page: Page): Promise<{ path: string; open: boolean }[]> {
  return page.evaluate(() =>
    (window as unknown as { piwiStreams: EventSource[] }).piwiStreams
      .filter((s) => s.readyState !== EventSource.CLOSED)
      .map((s) => ({ path: new URL(s.url).pathname, open: s.readyState === EventSource.OPEN })),
  );
}

/** Open `path` in a new tab of the context, hidden from its first script when asked, and wait for its streams to open. */
async function openTab(context: BrowserContext, path: string, hidden: boolean): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(trackStreams);
  if (hidden) {
    await page.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { get: () => true });
    });
  }
  await page.goto(path);
  await waitForHydration(page);
  await expect.poll(async () => (await streamsOf(page)).every((s) => s.open), { timeout: 15_000 }).toBe(true);
  return page;
}

/** A run of the spec's project that has begun: its id, its stream token and its project. */
async function beginRun(request: APIRequestContext) {
  const setup = await request.post('/api/test-runs/setup', {
    data: { projectName: PROJECT.RUN_PAGE_TABS, startTime: new Date().toISOString() },
  });
  expect(setup.ok()).toBeTruthy();
  const { runId, setupToken } = (await setup.json()) as { runId: number; setupToken: string };
  const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 2 } });
  expect(begun.ok()).toBeTruthy();
  const { streamToken } = (await begun.json()) as { streamToken: string };
  const { projectId } = (await (await request.get(`/api/test-runs/${runId}`)).json()) as { projectId: number };
  return { runId, streamToken, projectId };
}

/** End a run the test began, whatever state the test left it in. */
async function finishRun(request: APIRequestContext, run: { runId: number; streamToken: string }) {
  await request
    .post(`/api/test-runs/${run.runId}/finish`, {
      data: { streamToken: run.streamToken, status: 'passed', totalTests: 0 },
    })
    .catch(() => {});
}

test.describe('Run page beside other dashboard tabs', () => {
  test.skip(target.desktop, 'the desktop app shows its notifications from the shell, and has one window');
  // Each test opens dashboard pages and waits for live connections, which a dev server serves slowly.
  test.slow();

  test('goes live with Home, the runs list and three hidden tabs open', async ({ page, request }) => {
    const run = await beginRun(request);
    try {
      const context = page.context();
      const tabs = await Promise.all([
        openTab(context, '/', false),
        openTab(context, `/projects/${run.projectId}`, false),
        openTab(context, '/', true),
        openTab(context, '/', true),
        openTab(context, '/', true),
      ]);

      await page.addInitScript(trackStreams);
      await page.goto(`/test-runs/${run.runId}`);
      await waitForHydration(page);
      const events = await request.post(`/api/test-runs/${run.runId}/events`, {
        data: {
          streamToken: run.streamToken,
          testCases: [
            {
              type: 'begin',
              title: 'checks out beside other tabs',
              location: 'tests/checkout.spec.ts:3:1',
              workerIndex: 0,
              startedAt: Date.now(),
            },
          ],
        },
      });
      expect(events.ok()).toBeTruthy();
      await expect(page.getByText('checks out beside other tabs')).toBeVisible({ timeout: 5_000 });
      // The stream is open and has said the project's live view is off.
      await expect(page.getByTestId('live-view-readiness')).toHaveAttribute('data-state', 'disabled');

      // One tab of the browser holds the notification stream.
      const notificationStreams = (await Promise.all([page, ...tabs].map(streamsOf)))
        .flat()
        .filter((s) => s.path === '/api/notifications/stream');
      expect(notificationStreams).toHaveLength(1);
    } finally {
      await finishRun(request, run);
    }
  });

  test('says when its stream does not open, and Retry brings it live', async ({ page, request }) => {
    const run = await beginRun(request);
    try {
      const stream = (url: URL) => url.pathname === `/api/test-runs/${run.runId}/stream`;
      // The stream's first request is never answered, as one queued behind the browser's other connections; the next
      // one, which Retry opens, goes through.
      let requests = 0;
      await page.route(stream, async (route) => {
        if (requests++ > 0) await route.continue();
      });
      await page.goto(`/test-runs/${run.runId}`);
      await waitForHydration(page);
      const status = page.getByTestId('live-view-readiness');
      await expect(status).toHaveAttribute('data-state', 'stalled', { timeout: 15_000 });
      await expect(status).toContainText('Live updates stalled');

      await status.getByRole('button', { name: 'Retry' }).click();
      await expect(status).toHaveAttribute('data-state', 'disabled', { timeout: 15_000 });
    } finally {
      await finishRun(request, run);
    }
  });

  test('a runs list whose first connection opens late lists a run that started meanwhile', async ({
    page,
    request,
  }) => {
    const first = await beginRun(request);
    await finishRun(request, first);
    // The list's request for the instance's stream waits until the next run has begun: its start reaches no one.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === '/api/stream',
      async (route) => {
        await released;
        await route.continue();
      },
    );
    await page.goto(`/projects/${first.projectId}`);
    await waitForHydration(page);
    const run = await beginRun(request);
    try {
      const row = page.locator(`a[href$="/test-runs/${run.runId}"]`).first();
      await expect(row).toHaveCount(0);
      release();
      await expect(row).toBeVisible({ timeout: 15_000 });
    } finally {
      await finishRun(request, run);
    }
  });
});

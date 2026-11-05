import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget } from './desktop-target';
import { waitForHydration } from './utils';

/**
 * A run page opened beside other dashboard tabs goes live. Over HTTP/1.1 a browser opens at most six connections to an
 * address, and every tab holds event streams; one tab of the browser holds the notification stream, so Home, a
 * project's runs, three hidden tabs and the run page leave the run page room for its own stream.
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

/** The page's streams: their paths and whether each is open (`EventSource.OPEN`). */
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
  await expect.poll(async () => (await streamsOf(page)).every((s) => s.open), { timeout: 10_000 }).toBe(true);
  return page;
}

test.describe('Run page beside other dashboard tabs', () => {
  test.skip(target.desktop, 'the desktop app shows its notifications from the shell, and has one window');

  test('goes live with Home, the runs list and three hidden tabs open', async ({ page, request }) => {
    test.setTimeout(90_000);
    const setup = await request.post('/api/test-runs/setup', {
      data: { projectName: PROJECT.RUN_PAGE_TABS, startTime: new Date().toISOString() },
    });
    expect(setup.ok()).toBeTruthy();
    const { runId, setupToken } = (await setup.json()) as { runId: number; setupToken: string };
    const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 2 } });
    expect(begun.ok()).toBeTruthy();
    const { streamToken } = (await begun.json()) as { streamToken: string };
    try {
      const { projectId } = (await (await request.get(`/api/test-runs/${runId}`)).json()) as { projectId: number };
      const context = page.context();
      const tabs = [
        await openTab(context, '/', false),
        await openTab(context, `/projects/${projectId}`, false),
        await openTab(context, '/', true),
        await openTab(context, '/', true),
        await openTab(context, '/', true),
      ];

      await page.addInitScript(trackStreams);
      await page.goto(`/test-runs/${runId}`);
      await waitForHydration(page);
      const events = await request.post(`/api/test-runs/${runId}/events`, {
        data: {
          streamToken,
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
      await expect(page.getByText('checks out beside other tabs')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('live-view-readiness')).not.toHaveAttribute('data-state', /checking|stalled/);

      // One tab of the browser holds the notification stream.
      const notificationStreams = (await Promise.all([page, ...tabs].map(streamsOf)))
        .flat()
        .filter((s) => s.path === '/api/notifications/stream');
      expect(notificationStreams).toHaveLength(1);
    } finally {
      await request.post(`/api/test-runs/${runId}/finish`, {
        data: { streamToken, status: 'passed', totalTests: 0 },
      });
    }
  });
});

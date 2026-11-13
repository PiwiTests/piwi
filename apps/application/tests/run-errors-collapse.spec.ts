import { test, expect, type Page } from './fixtures';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT } from '#shared/test-project-names';
import { retryPost, waitForHydration } from './utils';

/**
 * The run header's errors outside the tests fold to one line, so the Video tab's video takes back the height a long
 * stack took: the page still does not scroll, the full message comes back with Expand, and the browser keeps the
 * choice across a reload.
 */

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 375, height: 667 },
] as const;

/** A video of 3.5 s, longer than the 3 s each test lasts. */
const VIDEO = readFileSync(join(process.cwd(), 'public/demo/videos/checkout-pay-timeout.webm'));
const TITLES = ['opens the cart', 'fills the card', 'places the order'];
const MESSAGE = 'Error: ENOSPC: no space left on device, write';
/** A stack long enough to fill the error's framed box, with placeholder paths only. */
const STACK = Array.from(
  { length: 16 },
  (_, i) => `    at step${i} (/workspace/project/tests/setup/global-setup.ts:${10 + i}:5)`,
).join('\n');

test.describe('Run errors collapse', () => {
  test.describe.configure({ mode: 'serial' });
  const t0 = Date.now() - 120_000;
  let runId = 0;

  test.beforeAll(async ({ request }) => {
    const start = await retryPost(request, '/api/test-runs/start', {
      data: { projectName: PROJECT.RUN_ERRORS_COLLAPSE, startTime: new Date(t0).toISOString() },
    });
    expect(start.ok()).toBeTruthy();
    const started = await start.json();
    runId = started.runId;
    const streamToken: string = started.streamToken;

    const cases = TITLES.map((title, i) => ({
      title,
      location: `tests/collapse.spec.ts:${5 + i * 10}:3`,
      retries: 0,
      workerIndex: 0,
      startedAt: t0 + i * 4000,
      steps: [200, 1600].map((at, n) => ({
        title: `Click getByRole('button', { name: 'Step ${n}' })`,
        category: 'pw:api',
        startTime: t0 + i * 4000 + at,
        duration: 80,
        params: { locator: `getByRole('button', { name: 'Step ${n}' })` },
      })),
    }));
    const events = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: cases.map((c) => ({ type: 'complete', ...c, status: 'passed', duration: 3000 })),
      },
    });
    expect(events.ok()).toBeTruthy();

    for (const testCase of cases) {
      const form = new FormData();
      form.set('streamToken', streamToken);
      form.set('testCase', JSON.stringify({ title: testCase.title, location: testCase.location, retries: 0 }));
      form.set(
        'attach_meta',
        JSON.stringify([{ name: 'video', contentType: 'video/webm', originalName: 'video.webm' }]),
      );
      form.append('attach_file', new Blob([new Uint8Array(VIDEO)], { type: 'video/webm' }), 'video.webm');
      const response = await request.post(`/api/test-runs/${runId}/case-files`, { multipart: form });
      expect(response.ok()).toBeTruthy();
    }

    const finish = await request.post(`/api/test-runs/${runId}/finish`, {
      data: {
        streamToken,
        status: 'failed',
        startTime: new Date(t0).toISOString(),
        duration: 12_000,
        runErrors: [{ message: MESSAGE, stack: STACK }],
      },
    });
    expect(finish.ok()).toBeTruthy();
  });

  async function openVideoTab(page: Page, size: (typeof SIZES)[number]) {
    await page.setViewportSize(size);
    await page.goto(`/test-runs/${runId}?tab=video`);
    await waitForHydration(page);
    await expect(page.getByTestId('video-action-count')).toBeVisible({ timeout: 30_000 });
  }

  /** The video's rendered height, whether the page scrolls, and the error block's height. */
  const measure = (page: Page) =>
    page.evaluate(() => ({
      video: document.querySelector('[data-shot="run-video-tab"] video')!.getBoundingClientRect().height,
      block: document.querySelector('[data-shot="run-errors"]')!.getBoundingClientRect().height,
      pageHeight: document.scrollingElement!.scrollHeight,
      // What scrolls on a phone with the summary shown: the layout's root, not the document.
      scrolled: (() => {
        for (
          let el = document.querySelector('[data-shot="run-video-tab"]') as HTMLElement | null;
          el;
          el = el.parentElement
        )
          if (getComputedStyle(el).overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1)
            return el.scrollHeight;
        return document.scrollingElement!.scrollHeight;
      })(),
      innerHeight: window.innerHeight,
    }));

  const block = (page: Page) => page.locator('[data-shot="run-errors"]');
  const toggle = (page: Page, name: 'Collapse' | 'Expand') => block(page).getByRole('button', { name });

  for (const size of SIZES) {
    test.describe(`${size.width}x${size.height}`, () => {
      test.beforeEach(async ({ page }) => {
        // Every test starts from a browser that has not chosen yet.
        await page.addInitScript(() => {
          if (!sessionStorage.getItem('run-errors-collapse-seeded')) {
            localStorage.removeItem('piwi-run-errors-collapsed');
            sessionStorage.setItem('run-errors-collapse-seeded', '1');
          }
        });
      });

      test('Collapse folds the block to one line and gives its height to the video', async ({ page }) => {
        await openVideoTab(page, size);
        if (size.width < 1024) {
          // Phones open the Video tab with the summary, and so the block, folded; the video fits as it is.
          await expect(page.getByRole('button', { name: 'Show summary' })).toBeVisible();
          await expect(block(page)).toBeHidden();
          const folded = await measure(page);
          expect(folded.pageHeight).toBeLessThanOrEqual(folded.innerHeight + 1);
          await page.getByRole('button', { name: 'Show summary' }).click();
        }

        // Unchosen, the block is open, as before: the message and its stack in their box.
        await expect(block(page)).toBeVisible();
        await expect(toggle(page, 'Collapse')).toHaveAttribute('aria-expanded', 'true');
        await expect(block(page).getByText('ENOSPC: no space left on device, write').first()).toBeVisible();
        await expect(block(page).getByText('global-setup.ts:10:5').first()).toBeVisible();
        const open = await measure(page);

        await toggle(page, 'Collapse').click();
        await expect(toggle(page, 'Expand')).toHaveAttribute('aria-expanded', 'false');
        const headline = page.getByTestId('run-errors-headline');
        await expect(headline).toHaveText(MESSAGE);
        await expect(headline).toHaveAttribute('title', MESSAGE);
        await expect(block(page).getByText('global-setup.ts:10:5')).toBeHidden();

        const freed = async () => open.block - (await measure(page)).block;
        await expect.poll(freed, { timeout: 5_000 }).toBeGreaterThan(100);
        if (size.width >= 1024) {
          // The panel takes the height left, so the video takes back most of what the block gave up (the reel keeps
          // the video's aspect ratio, so a wide window may stop short of all of it) and the page still does not scroll.
          await expect
            .poll(async () => (await measure(page)).video, { timeout: 5_000 })
            .toBeGreaterThan(open.video + 1);
          const closed = await measure(page);
          expect(closed.video - open.video).toBeGreaterThanOrEqual(
            Math.min(open.block - closed.block, open.video) * 0.5,
          );
          expect(closed.pageHeight).toBeLessThanOrEqual(closed.innerHeight + 1);
          expect(open.pageHeight).toBeLessThanOrEqual(open.innerHeight + 1);
        } else {
          // With the summary shown a phone scrolls as one document and the video is as wide as the screen, so the
          // video keeps its height and the document is shorter by what the block gave up.
          const closed = await measure(page);
          expect(closed.video).toBeGreaterThanOrEqual(open.video - 1);
          expect(open.scrolled - closed.scrolled).toBeGreaterThanOrEqual((open.block - closed.block) * 0.9);
        }

        // The full message is one click away.
        await toggle(page, 'Expand').click();
        await expect(block(page).getByText('global-setup.ts:10:5').first()).toBeVisible();
        await expect(headline).toBeHidden();
      });

      test('keeps the choice across a reload', async ({ page }) => {
        // Three page loads, each waiting for the reel.
        test.slow();
        await openVideoTab(page, size);
        if (size.width < 1024) await page.getByRole('button', { name: 'Show summary' }).click();
        await toggle(page, 'Collapse').click();
        await expect(page.getByTestId('run-errors-headline')).toBeVisible();

        await page.reload();
        await waitForHydration(page);
        await expect(page.getByTestId('video-action-count')).toBeVisible({ timeout: 30_000 });
        if (size.width < 1024) await page.getByRole('button', { name: 'Show summary' }).click();
        await expect(toggle(page, 'Expand')).toBeVisible();
        await expect(page.getByTestId('run-errors-headline')).toHaveText(MESSAGE);
        await expect(block(page).getByText('global-setup.ts:10:5')).toBeHidden();

        await toggle(page, 'Expand').click();
        await page.reload();
        await waitForHydration(page);
        if (size.width < 1024) await page.getByRole('button', { name: 'Show summary' }).click();
        await expect(toggle(page, 'Collapse')).toBeVisible();
        await expect(block(page).getByText('global-setup.ts:10:5').first()).toBeVisible();
      });
    });
  }
});

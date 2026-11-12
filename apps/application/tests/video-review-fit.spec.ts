import { test, expect, type Page } from './fixtures';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT } from '#shared/test-project-names';
import { retryPost, waitForHydration } from './utils';

/**
 * The video review on the run's Video tab and in the Evidence window: it fits the screen without scrolling the page,
 * the current block's ring is whole, and a click on the bar, a mark or the checklist keeps the play state.
 */

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 375, height: 667 },
] as const;

/** A video of 3.5 s, longer than the 3 s each test lasts. */
const VIDEO = readFileSync(join(process.cwd(), 'public/demo/videos/checkout-pay-timeout.webm'));
const TITLES = ['opens the cart', 'fills the card', 'places the order'];

test.describe('Video review fit', () => {
  test.describe.configure({ mode: 'serial' });
  const t0 = Date.now() - 120_000;
  let runId = 0;
  let firstExecutionId = 0;

  test.beforeAll(async ({ request }) => {
    const start = await retryPost(request, '/api/test-runs/start', {
      data: { projectName: PROJECT.VIDEO_REVIEW_FIT, startTime: new Date(t0).toISOString() },
    });
    expect(start.ok()).toBeTruthy();
    const started = await start.json();
    runId = started.runId;
    const streamToken: string = started.streamToken;

    const cases = TITLES.map((title, i) => ({
      title,
      location: `tests/fit.spec.ts:${5 + i * 10}:3`,
      retries: 0,
      workerIndex: 0,
      startedAt: t0 + i * 4000,
      steps: [
        {
          title: "Click getByRole('button', { name: 'Add' })",
          category: 'pw:api',
          startTime: t0 + i * 4000 + 200,
          duration: 80,
          params: { locator: "getByRole('button', { name: 'Add' })" },
        },
        {
          title: "Click getByRole('button', { name: 'Pay' })",
          category: 'pw:api',
          startTime: t0 + i * 4000 + 1600,
          duration: 80,
          params: { locator: "getByRole('button', { name: 'Pay' })" },
        },
      ],
    }));
    const events = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: cases.map((c) => ({ type: 'complete', ...c, status: 'passed', duration: 3000 })),
      },
    });
    expect(events.ok()).toBeTruthy();

    for (const [i, testCase] of cases.entries()) {
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
      if (i === 0) firstExecutionId = (await response.json()).executionId;
    }

    const finish = await request.post(`/api/test-runs/${runId}/finish`, {
      data: { streamToken, status: 'passed', startTime: new Date(t0).toISOString(), duration: 12_000 },
    });
    expect(finish.ok()).toBeTruthy();
  });

  async function openVideoTab(page: Page, size: (typeof SIZES)[number]) {
    await page.setViewportSize(size);
    await page.goto(`/test-runs/${runId}?tab=video`);
    await waitForHydration(page);
    await expect(page.getByTestId('video-action-count')).toBeVisible({ timeout: 30_000 });
  }

  /** The state a viewer sees: the button's label, and whether any `<video>` plays. */
  const playState = (page: Page) =>
    page.evaluate(() => ({
      label: document.querySelector('[aria-label="Play"], [aria-label="Pause"]')?.getAttribute('aria-label'),
      playing: [...document.querySelectorAll('video')].some((v) => !v.paused),
    }));
  const bar = (page: Page) => page.getByRole('group', { name: 'Tests in this reel' });
  const row = (page: Page, title: string) => page.getByRole('button', { name: new RegExp(`${title}`) }).last();

  for (const size of SIZES) {
    test.describe(`${size.width}x${size.height}`, () => {
      test('fits the screen: the page does not scroll and the whole reel is in view', async ({ page }) => {
        await openVideoTab(page, size);
        const fit = await page.evaluate(() => {
          const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
          const tab = document.querySelector('[data-shot="run-video-tab"]')!;
          const scrolling: string[] = [];
          for (let el = tab as HTMLElement | null; el; el = el.parentElement) {
            const overflowY = getComputedStyle(el).overflowY;
            if (overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1)
              scrolling.push(
                `${el.tagName}.${String(el.className).slice(0, 60)} ${el.scrollHeight}>${el.clientHeight}`,
              );
          }
          return {
            page: [document.scrollingElement!.scrollHeight, window.innerHeight],
            video: rect('[data-shot="run-video-tab"] video').bottom,
            play: rect('[aria-label="Play"]').bottom,
            bar: rect('[aria-label="Tests in this reel"]').bottom,
            marks: rect('[data-testid="video-action-marks"]').bottom,
            scrolling,
          };
        });
        expect(fit.page[0]).toBeLessThanOrEqual(fit.page[1]! + 1);
        for (const bottom of [fit.video, fit.play, fit.bar, fit.marks]) expect(bottom).toBeLessThanOrEqual(size.height);
        expect(fit.scrolling).toEqual([]);
      });

      if (size.width < 1024) {
        test('scrolls as one document while the summary is shown, and fits again when it is folded', async ({
          page,
        }) => {
          await openVideoTab(page, size);
          const show = page.getByRole('button', { name: 'Show summary' });
          await expect(show).toBeVisible();
          await show.click();
          await expect(page.getByRole('button', { name: 'Hide summary' })).toBeVisible();

          const open = await page.evaluate(() => {
            const tab = document.querySelector('[data-shot="run-video-tab"]')!;
            const scrolling: string[] = [];
            for (let el = tab as HTMLElement | null; el; el = el.parentElement) {
              if (getComputedStyle(el).overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1)
                scrolling.push(`${el.tagName}.${String(el.className).slice(0, 40)}`);
            }
            return {
              video: tab.querySelector('video')!.getBoundingClientRect().height,
              scrolling,
              list: tab.querySelector('ul')!.scrollHeight - tab.querySelector('ul')!.clientHeight,
            };
          });
          // The video keeps its height and only the page (the layout's root) scrolls; the list does not scroll inside it.
          expect(open.video).toBeGreaterThan(150);
          expect(open.scrolling).toHaveLength(1);
          expect(open.list).toBeLessThanOrEqual(1);
          await bar(page).scrollIntoViewIfNeeded();
          await expect(bar(page)).toBeInViewport();

          await page.getByRole('button', { name: 'Hide summary' }).click();
          await expect(page.getByRole('button', { name: 'Show summary' })).toBeVisible();
          const folded = await page.evaluate(() => {
            const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
            return {
              video: rect('[data-shot="run-video-tab"] video').bottom,
              bar: rect('[aria-label="Tests in this reel"]').bottom,
            };
          });
          expect(folded.video).toBeLessThanOrEqual(size.height);
          expect(folded.bar).toBeLessThanOrEqual(size.height);
        });

        test('gives the fold back when the Video tab is left', async ({ page }) => {
          await page.setViewportSize(size);
          await page.goto(`/test-runs/${runId}?tab=test-cases`);
          await waitForHydration(page);
          await page.getByRole('button', { name: 'Hide summary' }).click();
          await expect(page.getByRole('button', { name: 'Show summary' })).toBeVisible();

          const pick = async (name: RegExp) => {
            await page.getByRole('combobox', { name: 'Select tab' }).click();
            await page.getByRole('option', { name }).click();
          };
          await pick(/^Video/);
          await expect(page.getByTestId('video-action-count')).toBeVisible({ timeout: 30_000 });
          await page.getByRole('button', { name: 'Show summary' }).click();
          await pick(/^Tests/);
          // The summary was folded before the Video tab, and it is folded again, not unfolded.
          await expect(page.getByRole('button', { name: 'Show summary' })).toBeVisible();
        });
      }

      test('gives every mark a hit area of at least 24 by 24 px', async ({ page }) => {
        await openVideoTab(page, size);
        const hit = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="video-action-mark"]')].map((mark) => {
            const box = mark.getBoundingClientRect();
            const at = (dx: number, dy: number) =>
              mark.contains(document.elementFromPoint(box.left + box.width / 2 + dx, box.top + box.height / 2 + dy));
            // The 24 px square around the mark's center, corners included.
            return [-11.5, 11.5].flatMap((dx) => [-11.5, 11.5].map((dy) => at(dx, dy))).every(Boolean);
          }),
        );
        expect(hit.length).toBeGreaterThan(0);
        expect(hit.every(Boolean)).toBe(true);
      });

      test('shows the current block whole, with its ring, on the tab and in the Evidence window', async ({ page }) => {
        const clipped = (page: Page) =>
          page.evaluate(() => {
            const block = document.querySelector('[aria-label="Tests in this reel"] [aria-current="true"]')!;
            const box = block.getBoundingClientRect();
            // The ring is 2 px and the focus outline 2 px at a 1 px offset.
            const reach = 3;
            const clippedBy: string[] = [];
            // An overflow on <body> moves to the viewport, which is checked on its own.
            for (let el = block.parentElement; el && el !== document.body; el = el.parentElement) {
              const style = getComputedStyle(el);
              if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
              const at = el.getBoundingClientRect();
              const inside =
                box.left - reach >= at.left + el.clientLeft - 0.5 &&
                box.right + reach <= at.left + el.clientLeft + el.clientWidth + 0.5 &&
                box.top - reach >= at.top + el.clientTop - 0.5 &&
                box.bottom + reach <= at.top + el.clientTop + el.clientHeight + 0.5;
              if (!inside) clippedBy.push(`${el.tagName}.${String(el.className).slice(0, 40)}`);
            }
            if (
              box.left - reach < 0 ||
              box.top - reach < 0 ||
              box.right + reach > window.innerWidth ||
              box.bottom + reach > window.innerHeight
            ) {
              clippedBy.push('viewport');
            }
            return clippedBy;
          });

        await openVideoTab(page, size);
        await bar(page).locator('[aria-current="true"]').focus();
        expect(await clipped(page)).toEqual([]);

        await page.goto(`/test-run-cases/${firstExecutionId}`);
        await waitForHydration(page);
        await page.getByRole('button', { name: 'Open video review' }).click();
        await expect(page.getByRole('dialog').getByTestId('video-action-count')).toBeVisible({ timeout: 30_000 });
        await bar(page).locator('[aria-current="true"]').focus();
        expect(await clipped(page)).toEqual([]);
      });

      test('keeps a paused reel paused and a playing one playing when the bar, a mark or the list is clicked', async ({
        page,
      }) => {
        await openVideoTab(page, size);
        expect(await playState(page)).toEqual({ label: 'Play', playing: false });

        // Paused: a mark, the bar, and a test whose video is not the one waiting.
        await page.getByTestId('video-action-mark').first().click();
        await expect.poll(() => playState(page)).toEqual({ label: 'Play', playing: false });
        await bar(page)
          .getByRole('button')
          .nth(1)
          .click({ position: { x: 4, y: 4 } });
        await expect(row(page, TITLES[1]!)).toHaveAttribute('aria-current', 'true');
        await expect.poll(() => playState(page)).toEqual({ label: 'Play', playing: false });
        await row(page, TITLES[2]!).click();
        await expect(row(page, TITLES[2]!)).toHaveAttribute('aria-current', 'true');
        await expect.poll(() => playState(page)).toEqual({ label: 'Play', playing: false });

        // Playing: the same clicks, the last on a test whose video has to load first.
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await expect.poll(() => playState(page)).toEqual({ label: 'Pause', playing: true });
        await page.getByTestId('video-action-mark').first().click();
        await expect.poll(() => playState(page)).toEqual({ label: 'Pause', playing: true });
        await bar(page)
          .getByRole('button')
          .nth(1)
          .click({ position: { x: 4, y: 4 } });
        await expect(row(page, TITLES[1]!)).toHaveAttribute('aria-current', 'true');
        await expect.poll(() => playState(page)).toEqual({ label: 'Pause', playing: true });
        await row(page, TITLES[0]!).click();
        await expect(row(page, TITLES[0]!)).toHaveAttribute('aria-current', 'true');
        await expect.poll(() => playState(page)).toEqual({ label: 'Pause', playing: true });
      });
    });
  }
});

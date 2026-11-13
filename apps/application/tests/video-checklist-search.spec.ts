import { test, expect, type Page } from './fixtures';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT } from '#shared/test-project-names';
import { retryPost, waitForHydration } from './utils';

/**
 * The search above the Video tab's checklist: it finds tests by title the way the Tests tab does, says how many match,
 * and only hides rows, so the video, the bar and the ticks never change with it.
 */

/** A video of 3.5 s, longer than the 3 s each test lasts. */
const VIDEO = readFileSync(join(process.cwd(), 'public/demo/videos/checkout-pay-timeout.webm'));
const TITLES = [
  'opens the cart',
  'adds a sock to the cart',
  'fills the card',
  'applies a coupon',
  'places the order',
  'shows the order number',
  'emails the receipt',
  'signs out',
];

test.describe('Video checklist search', () => {
  test.describe.configure({ mode: 'serial' });
  const t0 = Date.now() - 120_000;
  let runId = 0;

  test.beforeAll(async ({ request }) => {
    const start = await retryPost(request, '/api/test-runs/start', {
      data: { projectName: PROJECT.VIDEO_CHECKLIST_SEARCH, startTime: new Date(t0).toISOString() },
    });
    expect(start.ok()).toBeTruthy();
    const started = await start.json();
    runId = started.runId;
    const streamToken: string = started.streamToken;

    const cases = TITLES.map((title, i) => ({
      title,
      location: `tests/checkout.spec.ts:${5 + i * 10}:3`,
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
      data: { streamToken, status: 'passed', startTime: new Date(t0).toISOString(), duration: 40_000 },
    });
    expect(finish.ok()).toBeTruthy();
  });

  async function openVideoTab(page: Page, size = { width: 1280, height: 720 }) {
    await page.setViewportSize(size);
    await page.goto(`/test-runs/${runId}?tab=video`);
    await waitForHydration(page);
    await expect(page.getByTestId('video-action-count')).toBeVisible({ timeout: 30_000 });
  }

  const tab = (page: Page) => page.locator('[data-shot="run-video-tab"]');
  const box = (page: Page) => tab(page).getByRole('textbox', { name: 'Search tests' });
  const rows = (page: Page) => tab(page).locator('ul > li');
  const rowTitles = (page: Page) => rows(page).locator('.text-highlighted').allInnerTexts();
  const bar = (page: Page) => page.getByRole('group', { name: 'Tests in this reel' });

  /** What a viewer sees of the player: the button, whether a video plays, where, and which block is current. */
  const player = (page: Page) =>
    page.evaluate(() => {
      const videos = [...document.querySelectorAll<HTMLVideoElement>('[data-shot="run-video-tab"] video')];
      const shown = videos.find((v) => !v.classList.contains('invisible')) ?? videos[0]!;
      const blocks = [...document.querySelectorAll('[aria-label="Tests in this reel"] button')];
      return {
        label: document.querySelector('[aria-label="Play"], [aria-label="Pause"]')?.getAttribute('aria-label'),
        playing: videos.some((v) => !v.paused),
        time: shown.currentTime,
        current: blocks.findIndex((b) => b.getAttribute('aria-current') === 'true'),
        blocks: blocks.length,
        // A block is dimmed until its test is ticked or current.
        ticked: blocks.map((b) => b.classList.contains('opacity-100')),
      };
    });

  test('finds tests by title, says how many match, and marks the words', async ({ page }) => {
    await openVideoTab(page);
    await expect(rows(page)).toHaveCount(TITLES.length);
    // The Tests tab's box: magnifier and placeholder, no Ctrl+F hint and no list of qualifiers under it.
    await expect(box(page)).toHaveAttribute('placeholder', 'Search tests');
    await expect(tab(page).locator('kbd')).toHaveCount(0);

    await box(page).fill('CART');
    await expect(rows(page)).toHaveCount(2);
    expect(await rowTitles(page)).toEqual(['opens the cart', 'adds a sock to the cart']);
    await expect(tab(page).getByText(`2 of ${TITLES.length} tests match`)).toBeVisible();
    await expect(rows(page).locator('mark')).toHaveCount(2);
    await expect(rows(page).locator('mark').first()).toHaveText('cart');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    // There is no Clear button beside the box: the box's own x clears it.
    await expect(tab(page).getByRole('button', { name: /^Clear/ })).toHaveCount(1);

    await tab(page).getByRole('button', { name: 'Clear search' }).click();
    await expect(box(page)).toHaveValue('');
    await expect(rows(page)).toHaveCount(TITLES.length);
    await expect(tab(page).getByText(`0 of ${TITLES.length} tests · ${TITLES.length} videos`)).toBeVisible();
  });

  test('says so when no test matches, and the x brings the list back', async ({ page }) => {
    await openVideoTab(page);
    await box(page).fill('zzz');
    await expect(tab(page).getByText('No tests match your search.')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await expect(tab(page).getByText(`0 of ${TITLES.length} tests match`)).toBeVisible();
    // The bar still holds every test.
    await expect(bar(page).getByRole('button')).toHaveCount(TITLES.length);

    await tab(page).getByRole('button', { name: 'Clear search' }).click();
    await expect(rows(page)).toHaveCount(TITLES.length);
  });

  test('changes neither the play state, the current block, the bar nor the ticks while filtering', async ({ page }) => {
    await openVideoTab(page);

    // Paused, it stays paused where it was.
    const paused = await player(page);
    expect(paused).toMatchObject({ label: 'Play', playing: false, current: 0, blocks: TITLES.length });
    await box(page).fill('order');
    await expect(rows(page)).toHaveCount(2);
    expect(await player(page)).toEqual(paused);
    await box(page).fill('');

    // Playing, it keeps playing the same test, and the playhead keeps moving, though that test's row is hidden.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(async () => (await player(page)).playing).toBe(true);
    const before = await player(page);
    await box(page).fill('receipt');
    await expect(rows(page)).toHaveCount(1);
    const after = await player(page);
    expect(after).toMatchObject({ label: 'Pause', playing: true, blocks: before.blocks });
    // The reel may have moved on to the next test meanwhile, as it does unsearched, but never back or elsewhere.
    expect(after.current - before.current).toBeGreaterThanOrEqual(0);
    expect(after.current - before.current).toBeLessThanOrEqual(1);
    expect(after.ticked.slice(0, before.current)).toEqual(before.ticked.slice(0, before.current));
    await expect.poll(async () => (await player(page)).time).toBeGreaterThan(after.time);
    expect((await player(page)).playing).toBe(true);
  });

  test('a click on a row the search kept jumps to that test', async ({ page }) => {
    await openVideoTab(page);
    await box(page).fill('order number');
    await expect(rows(page)).toHaveCount(1);
    await rows(page).getByRole('button').click();
    const index = TITLES.indexOf('shows the order number');
    await expect(bar(page).getByRole('button').nth(index)).toHaveAttribute('aria-current', 'true');
    await expect(rows(page).getByRole('button')).toHaveAttribute('aria-current', 'true');
    await expect.poll(async () => (await player(page)).label).toBe('Play');
  });

  test('fits a 1280x720 screen with the box added', async ({ page }) => {
    await openVideoTab(page);
    const fit = await page.evaluate(() => ({
      page: document.scrollingElement!.scrollHeight - window.innerHeight,
      bar: document.querySelector('[aria-label="Tests in this reel"]')!.getBoundingClientRect().bottom,
    }));
    expect(fit.page).toBeLessThanOrEqual(1);
    expect(fit.bar).toBeLessThanOrEqual(720);
  });

  test('fits a phone while the summary is folded, as the Video tab opens there', async ({ page }) => {
    await openVideoTab(page, { width: 375, height: 667 });
    await expect(page.getByRole('button', { name: 'Show summary' })).toBeVisible();
    await expect(box(page)).toBeVisible();
    const fit = await page.evaluate(() => ({
      page: document.scrollingElement!.scrollHeight - window.innerHeight,
      video: document.querySelector('[data-shot="run-video-tab"] video')!.getBoundingClientRect().bottom,
      bar: document.querySelector('[aria-label="Tests in this reel"]')!.getBoundingClientRect().bottom,
    }));
    expect(fit.page).toBeLessThanOrEqual(1);
    expect(fit.video).toBeLessThanOrEqual(667);
    expect(fit.bar).toBeLessThanOrEqual(667);
  });
});

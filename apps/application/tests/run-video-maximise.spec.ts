import { test, expect, type Page } from './fixtures';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT } from '#shared/test-project-names';
import { retryPost, waitForHydration } from './utils';

/**
 * Maximise on the run's Video tab: it opens the video review dialog around the same reel, with the same group, worker
 * and search, plays one video at a time, starts at the test the tab was on and hands the test back on close.
 */

/** A video of 3.5 s, longer than the 3 s each test lasts. */
const VIDEO = readFileSync(join(process.cwd(), 'public/demo/videos/checkout-pay-timeout.webm'));
const TITLES = ['opens the cart', 'fills the card', 'places the order', 'shows the receipt'];

test.describe('Video tab maximise', () => {
  test.describe.configure({ mode: 'serial' });
  const t0 = Date.now() - 120_000;
  let runId = 0;

  test.beforeAll(async ({ request }) => {
    const start = await retryPost(request, '/api/test-runs/start', {
      data: { projectName: PROJECT.VIDEO_MAXIMISE, startTime: new Date(t0).toISOString() },
    });
    expect(start.ok()).toBeTruthy();
    const started = await start.json();
    runId = started.runId;
    const streamToken: string = started.streamToken;

    const cases = TITLES.map((title, i) => ({
      title,
      location: `tests/maximise.spec.ts:${5 + i * 10}:3`,
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
      data: { streamToken, status: 'passed', startTime: new Date(t0).toISOString(), duration: 16_000 },
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
  const dialog = (page: Page) => page.getByRole('dialog', { name: 'Video review' });
  const maximise = (page: Page) => tab(page).getByRole('button', { name: 'Maximise video' });
  const bar = (page: Page) => page.getByRole('group', { name: 'Tests in this reel' });
  /** The index of the block the playhead is on. */
  const currentBlock = async (page: Page) =>
    bar(page)
      .getByRole('button')
      .evaluateAll((blocks) => blocks.findIndex((b) => b.getAttribute('aria-current') === 'true'));
  const videos = (page: Page) =>
    page.evaluate(() => {
      const all = [...document.querySelectorAll('video')];
      return { count: all.length, playing: all.filter((v) => !v.paused).length };
    });

  test('the button opens the dialog with the reel, and the close button closes it', async ({ page }) => {
    await openVideoTab(page);
    await expect(maximise(page)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);

    await maximise(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Worker', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(dialog(page).getByRole('button', { name: 'File', exact: true })).toBeVisible();
    await expect(dialog(page).getByRole('group', { name: 'Tests in this reel' }).getByRole('button')).toHaveCount(
      TITLES.length,
    );
    await expect(dialog(page).getByText(`Run #${runId}`)).toBeVisible();

    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(maximise(page)).toBeVisible();
  });

  test('Escape closes it', async ({ page }) => {
    await openVideoTab(page);
    await maximise(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('the grouping and the search are the tab’s own: File picked inside stays on the tab', async ({ page }) => {
    await openVideoTab(page);
    await tab(page).getByRole('textbox', { name: 'Search tests' }).fill('receipt');
    await maximise(page).click();

    // The search shows inside the dialog, filtering the same reel.
    await expect(dialog(page).getByRole('textbox', { name: 'Search tests' })).toHaveValue('receipt');
    await expect(dialog(page).locator('ul > li')).toHaveCount(1);

    const byFile = dialog(page).getByRole('button', { name: 'File', exact: true });
    await byFile.click();
    await expect(byFile).toHaveAttribute('aria-pressed', 'true');
    await dialog(page).getByRole('textbox', { name: 'Search tests' }).fill('cart');

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(tab(page).getByRole('button', { name: 'File', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(tab(page).getByRole('textbox', { name: 'Search tests' })).toHaveValue('cart');
  });

  test('the test on show carries over, both ways', async ({ page }) => {
    await openVideoTab(page);
    // Open on the third test.
    await tab(page)
      .locator('ul > li')
      .getByRole('button', { name: /places the order/ })
      .click();
    await expect.poll(() => currentBlock(page)).toBe(2);

    await maximise(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect.poll(() => currentBlock(page)).toBe(2);
    await expect(bar(page)).toHaveCount(1);

    // Move on to the last test inside the dialog; the tab is on it after the close.
    await dialog(page)
      .locator('ul > li')
      .getByRole('button', { name: /shows the receipt/ })
      .click();
    await expect.poll(() => currentBlock(page)).toBe(3);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => currentBlock(page)).toBe(3);
  });

  test('only one video plays at a time: the tab’s reel is not mounted while the dialog is open', async ({ page }) => {
    await openVideoTab(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(async () => (await videos(page)).playing).toBe(1);
    expect((await videos(page)).count).toBe(2);

    await maximise(page).click();
    await expect(dialog(page)).toBeVisible();
    // The tab's two elements are gone; the dialog's two are there, and nothing plays until Play is pressed.
    await expect.poll(async () => (await videos(page)).count).toBe(2);
    expect((await videos(page)).playing).toBeLessThanOrEqual(1);
    await dialog(page).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(async () => (await videos(page)).playing).toBe(1);

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(async () => (await videos(page)).count).toBe(2);
    expect((await videos(page)).playing).toBeLessThanOrEqual(1);
  });

  test('fills the screen of a phone', async ({ page }) => {
    await openVideoTab(page, { width: 375, height: 667 });
    // The label is for screen readers on a phone; the button keeps its name.
    await maximise(page).click();
    await expect(dialog(page)).toBeVisible();
    // The dialog animates in: measure once it has settled, to the pixel.
    await expect
      .poll(async () => {
        const box = (await dialog(page).boundingBox())!;
        return [box.x, box.y, box.width, box.height].map(Math.round);
      })
      .toEqual([0, 0, 375, 667]);
  });
});

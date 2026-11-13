import { test, expect, type Page } from './fixtures';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT } from '#shared/test-project-names';
import { retryPost, waitForHydration } from './utils';

/**
 * The run page's Video tab in a run with an error outside its tests: the error block folds to one line and the video
 * takes the height back, the browser keeping the choice; the checklist's search box hides the rows that do not match,
 * and leaves the reel's playing and ticks as they are.
 */

const VIDEO = readFileSync(join(process.cwd(), 'public/demo/videos/checkout-pay-timeout.webm'));
const TITLES = ['adds a mug to the cart', 'empties the cart', 'pays by card'];
const ERROR = {
  message: 'Error: ENOSPC: no space left on device, write',
  stack: Array.from({ length: 12 }, (_, i) => `    at frame${i} (/workspace/demo-app/lib/writer.js:${80 + i}:9)`).join(
    '\n',
  ),
  location: { file: 'global-teardown.ts', line: 12, column: 3 },
};

test.describe('Video tab: the error block and the checklist search', () => {
  test.describe.configure({ mode: 'serial' });
  const t0 = Date.now() - 120_000;
  let runId = 0;

  test.beforeAll(async ({ request }) => {
    const start = await retryPost(request, '/api/test-runs/start', {
      data: { projectName: PROJECT.VIDEO_TAB_SEARCH, startTime: new Date(t0).toISOString() },
    });
    expect(start.ok()).toBeTruthy();
    const started = await start.json();
    runId = started.runId;
    const streamToken: string = started.streamToken;

    const cases = TITLES.map((title, i) => ({
      title,
      location: `tests/shop.spec.ts:${5 + i * 10}:3`,
      retries: 0,
      workerIndex: 0,
      parallelIndex: 0,
      startedAt: t0 + i * 4000,
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
        runErrors: [ERROR],
      },
    });
    expect(finish.ok()).toBeTruthy();
  });

  async function openVideoTab(page: Page) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/test-runs/${runId}?tab=video`);
    await waitForHydration(page);
    await expect(page.getByTestId('video-checklist-count')).toBeVisible({ timeout: 30_000 });
  }
  const videoHeight = (page: Page) =>
    page
      .locator('[data-shot="run-video-tab"] video')
      .first()
      .evaluate((v) => v.getBoundingClientRect().height);
  const errors = (page: Page) => page.locator('[data-shot="run-errors"]');
  const checklist = (page: Page) => page.locator('[data-shot="run-video-tab"] ul').last();
  const countLine = (page: Page) => page.getByTestId('video-checklist-count');
  const playState = (page: Page) =>
    page.evaluate(() => ({
      label: document.querySelector('[aria-label="Play"], [aria-label="Pause"]')?.getAttribute('aria-label'),
      playing: [...document.querySelectorAll('video')].some((v) => !v.paused),
    }));

  test('folds the error block to one line, gives the video the height, and keeps the choice', async ({ page }) => {
    await openVideoTab(page);
    await expect(errors(page).getByText('frame11')).toBeVisible();
    const before = await videoHeight(page);

    await errors(page).getByRole('button', { name: 'Collapse' }).click();
    await expect(errors(page).getByText('frame11')).toBeHidden();
    // One line: the first error's message, its whole text on hover.
    const line = errors(page).locator('[data-run-errors-line]');
    await expect(line).toHaveText(ERROR.message);
    await expect(line).toHaveAttribute('title', ERROR.message);
    await expect.poll(() => videoHeight(page)).toBeGreaterThan(before + 50);

    await page.reload();
    await waitForHydration(page);
    await expect(errors(page).getByRole('button', { name: 'Expand' })).toBeVisible();
    await expect(errors(page).getByText('frame11')).toBeHidden();

    await errors(page).getByRole('button', { name: 'Expand' }).click();
    await expect(errors(page).getByText('frame11')).toBeVisible();
    await expect(errors(page).getByRole('button', { name: 'Collapse' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('filters the checklist by title, marks the match, and leaves the reel as it was', async ({ page }) => {
    await openVideoTab(page);
    const search = page.getByRole('combobox', { name: 'Search the tests of this reel' });
    const rows = checklist(page).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    expect(await playState(page)).toEqual({ label: 'Play', playing: false });

    await search.fill('CART');
    await expect(countLine(page)).toHaveText('2 of 3 tests match');
    await expect(rows).toHaveCount(2);
    await expect(checklist(page).locator('mark')).toHaveText(['cart', 'cart']);
    // The bar keeps every test.
    await expect(page.getByRole('group', { name: 'Tests in this reel' }).getByRole('button')).toHaveCount(3);

    // A row the search found still moves the video there, which stays paused.
    await checklist(page)
      .getByRole('button', { name: /empties the cart/ })
      .click();
    await expect(checklist(page).getByRole('button', { name: /empties the cart/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(await playState(page)).toEqual({ label: 'Play', playing: false });

    // Escape clears it (a first press may only close the suggestions).
    await search.press('Escape');
    if (await search.inputValue()) await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(rows).toHaveCount(3);
    await expect(countLine(page)).toContainText('of 3 tests');

    await search.fill('zzz');
    await expect(page.getByText('No test matches this search.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear the search' }).click();
    await expect(search).toHaveValue('');
    await expect(rows).toHaveCount(3);
  });
});

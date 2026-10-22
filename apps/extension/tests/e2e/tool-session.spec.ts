import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { stubCoverageChrome } from './coverage-fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

/**
 * Each tool claims the page on injection and tears down whichever one was
 * already running, so no two overlays and their capture-phase listeners compete
 * for the same clicks; Escape cancels the current one from anywhere.
 */
const PAGE = `<!doctype html><html><body>
  <main><h1>Checkout</h1><button id="pay" data-testid="pay">Pay now</button></main>
</body></html>`;

function inject(page: Page, file: string) {
  return page.addScriptTag({ path: path.join(DIST, file) });
}

const activeTool = (page: Page) =>
  page.evaluate(() => (globalThis as { __piwiActiveTool?: { id: string } }).__piwiActiveTool?.id ?? null);

/** The tools that mount a host of their own, with its id. */
const HOSTED_TOOLS = [
  { file: 'lint-overlay.js', id: 'lint-overlay', host: 'piwi-lint-overlay-host' },
  { file: 'playwright-view.js', id: 'playwright-view', host: 'piwi-playwright-view-host' },
  { file: 'coverage-overlay.js', id: 'coverage-overlay', host: 'piwi-coverage-host' },
  { file: 'test-function-panel.js', id: 'test-function-panel', host: 'piwi-test-function-host' },
] as const;

/** Surfaces on the page that are not a momentary tool's: the recorder's, a replay's, a bug report's, and the page's own. */
const OTHER_SURFACES = [
  'piwi-record-hud-host',
  'piwi-replay-hud-host',
  'piwi-replay-cursor-host',
  'piwi-conditions-banner',
  'piwi-bug-dialog-host',
  'piwi-desktop-run-host',
  'piwi-app-root',
];

/** Picks the Pay button, which its test id finds alone, so no anchors step: the pick's results panel is open. */
async function openPickResults(page: Page): Promise<void> {
  await inject(page, 'pick.js');
  await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
  await page.hover('#pay');
  await page.click('#pay');
  await expect(page.locator('#piwi-picker-results-host')).toBeAttached();
}

test.describe('one tool at a time', () => {
  test('starting a tool tears down the one already running', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(PAGE);

    await inject(page, 'playwright-view.js');
    await expect.poll(() => activeTool(page)).toBe('playwright-view');
    expect(await page.locator('#piwi-playwright-view-host').count()).toBe(1);

    await inject(page, 'lint-overlay.js');
    await expect.poll(() => activeTool(page)).toBe('lint-overlay');
    // The predecessor's surface is gone, not merely covered up.
    expect(await page.locator('#piwi-playwright-view-host').count()).toBe(0);
    expect(await page.locator('#piwi-lint-overlay-host').count()).toBe(1);
  });

  test('a pick started over another tool leaves only the picking overlay', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(PAGE);

    await inject(page, 'lint-overlay.js');
    await expect.poll(() => activeTool(page)).toBe('lint-overlay');

    await inject(page, 'pick.js');
    await expect.poll(() => activeTool(page)).toBe('pick');
    expect(await page.locator('#piwi-lint-overlay-host').count()).toBe(0);
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
  });

  test('Escape cancels the running tool and releases the page', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(PAGE);

    await inject(page, 'lint-overlay.js');
    await expect.poll(() => activeTool(page)).toBe('lint-overlay');

    await page.keyboard.press('Escape');
    await expect.poll(() => activeTool(page)).toBeNull();
    expect(await page.locator('#piwi-lint-overlay-host').count()).toBe(0);
  });

  test('Escape during a pick cancels it without stranding the re-entry guard', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(PAGE);

    await inject(page, 'pick.js');
    await expect.poll(() => activeTool(page)).toBe('pick');

    await page.keyboard.press('Escape');
    await expect.poll(() => activeTool(page)).toBeNull();
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(0);

    // Proof it really is reusable: a second pick claims the page again.
    await inject(page, 'pick.js');
    await expect.poll(() => activeTool(page)).toBe('pick');
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
  });

  for (const tool of HOSTED_TOOLS) {
    test(`${tool.id} started over a pick keeps its own surface`, async ({ context }) => {
      // Storage and a worker for the tools that read the connection settings.
      await stubCoverageChrome(context);
      const page = await context.newPage();
      await page.setContent(PAGE);
      await inject(page, 'pick.js');
      await expect.poll(() => activeTool(page)).toBe('pick');

      await inject(page, tool.file);
      await expect.poll(() => activeTool(page)).toBe(tool.id);
      await expect(page.locator(`#${tool.host}`)).toBeAttached();
      await expect(page.locator('#__piwi_picker_banner')).toHaveCount(0);
    });
  }

  test('a pick torn down by another tool leaves every other surface on the page', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(PAGE);
    await page.evaluate((ids) => {
      for (const id of ids) {
        const element = document.createElement('div');
        element.id = id;
        document.documentElement.appendChild(element);
      }
    }, OTHER_SURFACES);
    await openPickResults(page);

    await inject(page, 'lint-overlay.js');
    await expect.poll(() => activeTool(page)).toBe('lint-overlay');
    await expect(page.locator('#piwi-picker-results-host')).toHaveCount(0);
    for (const id of OTHER_SURFACES) await expect(page.locator(`#${id}`)).toBeAttached();

    await page.keyboard.press('Escape');
    await expect.poll(() => activeTool(page)).toBeNull();
    for (const id of OTHER_SURFACES) await expect(page.locator(`#${id}`)).toBeAttached();
  });

  test('a pick-driven tool started during a pick replaces it', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(PAGE);
    await inject(page, 'pick.js');
    await expect.poll(() => activeTool(page)).toBe('pick');

    await inject(page, 'assertion-panel.js');
    await expect.poll(() => activeTool(page)).toBe('assertion-panel');
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
    await page.hover('#pay');
    await page.click('#pay');
    await expect(page.locator('#piwi-assertion-panel-host')).toBeAttached();
    // The pick it replaced goes no further: no anchors step, no results panel.
    await page.waitForTimeout(400);
    await expect(page.getByText('Scope to stable parents')).toHaveCount(0);
    await expect(page.locator('#piwi-picker-results-host')).toHaveCount(0);
  });

  test('a pick whose results another tool closed leaves the page its Escape, and picks again', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(PAGE);
    await page.evaluate(() => {
      const g = globalThis as { __pageEscapes?: number };
      g.__pageEscapes = 0;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') g.__pageEscapes!++;
      });
    });
    await openPickResults(page);

    await inject(page, 'lint-overlay.js');
    await expect.poll(() => activeTool(page)).toBe('lint-overlay');
    await expect(page.locator('#piwi-picker-results-host')).toHaveCount(0);
    // Injected again, the lint overlay turns off.
    await inject(page, 'lint-overlay.js');
    await expect.poll(() => activeTool(page)).toBeNull();

    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (globalThis as { __pageEscapes?: number }).__pageEscapes)).toBe(1);
    await inject(page, 'pick.js');
    await expect.poll(() => activeTool(page)).toBe('pick');
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
  });

  test('a tool that finishes on its own releases the page', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(PAGE);

    await inject(page, 'lint-overlay.js');
    await expect.poll(() => activeTool(page)).toBe('lint-overlay');
    // Re-injecting a toggle turns it off, which must also release ownership
    // rather than leaving the popup claiming it is still running.
    await inject(page, 'lint-overlay.js');
    await expect.poll(() => activeTool(page)).toBeNull();
  });
});

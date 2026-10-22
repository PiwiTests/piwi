import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { openShadowRoots } from './shadow.js';
import { stubChromeI18n } from './i18n-stub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

/**
 * A modal dialog the page opened puts itself in the top layer and makes the
 * rest of the page inert: the extension's surfaces follow it there, and come
 * back out when it closes or leaves the page.
 */

/** Two buttons alike, so no locator finds the first alone and the pick opens the anchors step inside the dialog. */
function modalPage(dialogStyle = ''): string {
  return `<!doctype html><html><body>
    <dialog id="d" style="${dialogStyle}"><p>Settings</p><button>Save settings</button><button>Save settings</button></dialog>
    <script>document.getElementById('d').showModal();</script>
  </body></html>`;
}

/** The first of the dialog's buttons. */
const TARGET = '#d > button:first-of-type';

const RESULTS = '#piwi-picker-results-host';
const ORIGIN = 'https://modal-dialog.test';

/** The page with its dialog open, served from an https origin, where the clipboard works. */
async function openModalPage(context: BrowserContext, dialogStyle = ''): Promise<Page> {
  await context.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: modalPage(dialogStyle) }),
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  return page;
}

/** Picks the dialog's button and waits for the results panel; the anchors step is skipped with a click, or Escape. */
async function pickInDialog(page: Page, skipWith: 'click' | 'Escape' = 'click'): Promise<void> {
  await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
  await page.hover(TARGET);
  await page.click(TARGET);
  // The dialog is a parent to scope to: the anchors step.
  await expect(page.getByText('Scope to stable parents')).toBeVisible();
  if (skipWith === 'click') await page.getByRole('button', { name: 'Skip (Esc)' }).click({ timeout: 5000 });
  else await page.keyboard.press('Escape');
  await expect(page.locator(RESULTS)).toBeAttached();
}

function parentOf(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((s) => {
    const parent = document.querySelector(s)?.parentElement;
    return parent ? parent.id || parent.tagName.toLowerCase() : null;
  }, selector);
}

test.describe('surfaces over a page’s modal dialog', () => {
  test('the pick results take clicks above the dialog, and go back to the page when it closes', async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openShadowRoots(context);
    await stubChromeI18n(context, 'en');
    const page = await openModalPage(context);
    await pickInDialog(page);

    expect(await parentOf(page, RESULTS)).toBe('d');
    // A real click, which an inert surface does not take.
    await page
      .locator(RESULTS)
      .getByRole('button', { name: /^Copy all/ })
      .click({ timeout: 5000 });
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Save settings');

    await page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).close());
    await expect.poll(() => parentOf(page, RESULTS)).toBe('html');
    await expect(page.locator(RESULTS).getByRole('button', { name: /^Copy all/ })).toBeVisible();
  });

  test('a surface the page removes with its dialog stays on the page', async ({ context }) => {
    await openShadowRoots(context);
    await stubChromeI18n(context, 'en');
    const page = await openModalPage(context);
    await pickInDialog(page);
    expect(await parentOf(page, RESULTS)).toBe('d');

    await page.evaluate(() => document.getElementById('d')!.remove());
    await expect.poll(() => parentOf(page, RESULTS)).toBe('html');
    await expect(page.locator(RESULTS).getByRole('button', { name: /^Copy all/ })).toBeVisible();
  });

  test('a surface closed by its own code is not brought back', async ({ context }) => {
    await openShadowRoots(context);
    await stubChromeI18n(context, 'en');
    const page = await openModalPage(context);
    await pickInDialog(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(RESULTS)).toHaveCount(0);
    await page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).close());
    await page.waitForTimeout(200);
    await expect(page.locator(RESULTS)).toHaveCount(0);
  });

  test('a dialog that would hold a fixed surface to its own box keeps it out', async ({ context }) => {
    await openShadowRoots(context);
    await stubChromeI18n(context, 'en');
    const page = await openModalPage(context, 'transform: translateY(0)');
    await pickInDialog(page, 'Escape');
    await page.waitForTimeout(200);
    expect(await parentOf(page, RESULTS)).toBe('html');
  });
});

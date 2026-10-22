import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { servePages } from './engine-bundle.js';
import { playwrightLocator } from './playwright-locator.js';
import { stubChromeI18n } from './i18n-stub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');
const ORIGIN = 'https://pick-shadow.test';

/**
 * A newsletter web component: its field and button live in an open shadow
 * root, under a host with a test id. The light DOM keeps a button of its own.
 */
const SHADOW_PAGE = `<!doctype html><html><head><title>Shadow</title></head><body style="margin-top:140px">
  <main>
    <x-newsletter data-testid="newsletter"></x-newsletter>
    <button id="later">Remind me later</button>
  </main>
  <script>
    window.__submits = 0;
    const root = document.querySelector('x-newsletter').attachShadow({ mode: 'open' });
    root.innerHTML =
      '<form id="signup"><label>Email <input id="email" type="email"></label>' +
      '<button id="subscribe" type="submit"><span id="subscribe-text">Subscribe</span></button></form>';
    root.getElementById('signup').addEventListener('submit', (event) => {
      event.preventDefault();
      window.__submits++;
    });
  </script>
</body></html>`;

const activeTool = (page: Page) =>
  page.evaluate(() => (globalThis as { __piwiActiveTool?: { id: string } }).__piwiActiveTool?.id ?? null);

async function openShadowPage(context: BrowserContext): Promise<Page> {
  // pick.js runs in the page's main world here: its texts need a `chrome.i18n`.
  await stubChromeI18n(context);
  const page = await context.newPage();
  await servePages(page, ORIGIN, { 'shadow.html': SHADOW_PAGE });
  await page.goto(`${ORIGIN}/shadow.html`);
  await page.evaluate(() => {
    (globalThis as { __piwiTestOpenShadow?: boolean }).__piwiTestOpenShadow = true;
  });
  await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
  await expect(page.locator('#__piwi_picker_banner')).toBeVisible();
  return page;
}

/** Skips the anchors step when it shows, and reads the locators of the results panel's rows. */
async function resultRows(page: Page): Promise<string[]> {
  const results = page.locator('#piwi-picker-results-host .panel');
  const skip = page.getByRole('button', { name: 'Skip (Esc)' });
  await expect(results.or(skip)).toBeVisible();
  if (await skip.isVisible()) await skip.click();
  await expect(results).toBeVisible();
  return page.evaluate(() => {
    const root = document.getElementById('piwi-picker-results-host')!.shadowRoot!;
    return [...root.querySelectorAll('.row code')].map((code) => code.textContent!);
  });
}

/** The id of the element real Playwright finds with `locator`, which must find exactly one. */
async function foundId(page: Page, locator: string): Promise<string | null> {
  const found = playwrightLocator(page, locator);
  await expect(found).toHaveCount(1);
  return found.getAttribute('id');
}

test.describe('pick.js inside open shadow roots', () => {
  test('a control inside an open shadow root is outlined on hover and picked on click', async ({ context }) => {
    const page = await openShadowPage(context);
    const button = page.locator('x-newsletter #subscribe');
    await page.locator('x-newsletter #subscribe-text').hover();
    await expect(page.locator('#__piwi_picker_label')).toContainText('<button>');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("getByRole('button', { name: 'Subscribe' })");
    expect(await page.locator('#__piwi_picker_highlight').boundingBox()).toEqual(await button.boundingBox());

    await page.locator('x-newsletter #subscribe-text').click();
    // The anchors step lists the parents out through the shadow root's host.
    const anchors = page.locator('label').filter({ hasText: 'data-testid="newsletter"' });
    await expect(anchors).toContainText('<x-newsletter>');
    await expect(anchors).toContainText('contains exactly 1 matching element');
    const rows = await resultRows(page);
    expect(rows[0]).toBe("getByRole('button', { name: 'Subscribe' })");
    expect(await foundId(page, rows[0]!)).toBe('subscribe');
    await page.keyboard.press('Escape');
    await expect.poll(() => activeTool(page)).toBeNull();
    expect(await page.evaluate(() => (window as { __submits?: number }).__submits)).toBe(0);
  });

  test('a scope to the shadow root’s host gives a locator Playwright resolves to the control', async ({ context }) => {
    const page = await openShadowPage(context);
    await page.locator('x-newsletter #subscribe').hover();
    await page.locator('x-newsletter #subscribe').click();
    const anchors = page.locator('label').filter({ hasText: 'data-testid="newsletter"' });
    await anchors.locator('input[type="checkbox"]').check();
    await expect(page.getByText('Selection matches exactly 1 element')).toBeVisible();
    await page.getByRole('button', { name: 'Use selected parents' }).click();
    const rows = await resultRows(page);
    const scoped = rows.find((row) => row.startsWith("getByTestId('newsletter')."));
    expect(scoped).toBeDefined();
    expect(await foundId(page, scoped!)).toBe('subscribe');
  });
});

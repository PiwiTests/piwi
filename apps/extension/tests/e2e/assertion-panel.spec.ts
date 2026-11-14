import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { stubChromeI18n } from './i18n-stub.js';
import { clippedInShadows, openShadowRoots } from './shadow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

const activeTool = (page: Page) =>
  page.evaluate(() => (globalThis as { __piwiActiveTool?: { id: string } }).__piwiActiveTool?.id ?? null);

/**
 * Drives the real built `assertion-panel.js`, the same way
 * `chrome.scripting.executeScript({ files: ['assertion-panel.js'] })` would
 * (see `pick.spec.ts` for why the popup→injection wiring itself isn't
 * simulated here). The panel lives in a closed shadow root by design (same
 * reasoning as `results-panel.ts`), so these tests assert only
 * externally-observable effects (host presence, toggling) rather than
 * shadow-root-internal content — `suggestAssertions`'s own candidate logic
 * is covered directly in `assertion-suggest.spec.ts`.
 */
test.describe('assertion-panel.js', () => {
  test('picks an element and opens the assertion panel', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button id="target" data-testid="submit-btn">Submit</button>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();

    await page.hover('#target');
    await page.click('#target');

    // The panel lives in a closed shadow root, unreachable through
    // Playwright's locator engine — the host existing confirms the flow
    // reached the end (no anchors step: assertion-panel.ts never calls
    // showAnchorPicker).
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-assertion-panel-host'))).toBe(true);
  });

  test('Escape at the element step ends the flow with no panel', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><button id="x">X</button></body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
    await expect.poll(() => activeTool(page)).toBe('assertion-panel');
    await page.keyboard.press('Escape');
    await expect.poll(() => activeTool(page)).toBeNull();
    expect(await page.evaluate(() => !!document.getElementById('piwi-assertion-panel-host'))).toBe(false);
  });

  test('re-injecting while a pick is already in progress does not double-install the overlay', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><button id="x">X</button></body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();
    await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
    // Still exactly one banner/highlight pair: the second injection left the
    // running one be.
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
  });

  test('Escape closes the assertion panel once open', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button id="target" data-testid="submit-btn">Submit</button>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
    await page.hover('#target');
    await page.click('#target');
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-assertion-panel-host'))).toBe(true);

    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-assertion-panel-host'))).toBe(false);
  });

  test('holds the focus while open, and gives it back as it closes', async ({ context }) => {
    await openShadowRoots(context);
    await stubChromeI18n(context);
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <input id="search" aria-label="Search"><button id="target" data-testid="submit-btn">Submit</button>
    </body></html>`);
    await page.locator('#search').focus();
    await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
    await page.hover('#target');
    await page.click('#target');
    const panel = page.locator('#piwi-assertion-panel-host .panel');
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    const close = panel.getByRole('button', { name: 'Close' });
    const lastCopy = panel.getByRole('button', { name: 'Copy', exact: true }).last();
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(lastCopy).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#piwi-assertion-panel-host')).toHaveCount(0);
    await expect(page.locator('#search')).toBeFocused();
  });

  test('speaks French: title, locator line, buttons and lang', async ({ context }) => {
    await openShadowRoots(context);
    await stubChromeI18n(context, 'fr');
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button id="target" data-testid="submit-btn">Submit</button>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
    await page.hover('#target');
    await page.click('#target');

    const panel = () =>
      page.evaluate(() => {
        const root = document.getElementById('piwi-assertion-panel-host')?.shadowRoot;
        const dialog = root?.querySelector('[role="dialog"]');
        if (!root || !dialog) return null;
        return {
          lang: (dialog as HTMLElement).lang,
          label: dialog.getAttribute('aria-label'),
          title: root.querySelector('.title')?.textContent,
          sub: root.querySelector('.sub')?.textContent,
          close: root.querySelector('.close')?.getAttribute('aria-label'),
          copy: [...root.querySelectorAll('button.copy')].map((b) => b.textContent),
        };
      });
    await expect.poll(panel).not.toBeNull();
    expect(await panel()).toEqual({
      lang: 'fr',
      label: 'Assertions',
      title: '3 assertions suggérées',
      sub: "Avec le locator getByTestId('submit-btn')",
      close: 'Fermer',
      copy: ['Copier', 'Copier', 'Copier'],
    });
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('shows nothing a password field holds, and copies no line with it', async ({ context }) => {
    await openShadowRoots(context);
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <label>Password <input id="target" type="password" value="hunter2" /></label>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
    await page.hover('#target');
    await page.click('#target');
    const panel = page.locator('#piwi-assertion-panel-host').getByRole('dialog');
    await expect(panel).toBeVisible();
    await expect(panel.locator('button.copy')).toHaveCount(2);
    await expect(panel).not.toContainText('hunter2');
  });

  test('lays out in German without clipping', async ({ context }) => {
    await openShadowRoots(context);
    await stubChromeI18n(context, 'de');
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button id="target" data-testid="submit-btn">Submit</button>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
    await page.hover('#target');
    await page.click('#target');

    const lang = () =>
      page.evaluate(
        () =>
          document
            .getElementById('piwi-assertion-panel-host')
            ?.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]')?.lang ?? null,
      );
    await expect.poll(lang).toBe('de');
    expect(await clippedInShadows(page)).toEqual([]);
  });
});

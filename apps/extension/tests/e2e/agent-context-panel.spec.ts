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
 * Drives the real built `agent-context-panel.js`, the same way
 * `chrome.scripting.executeScript({ files: ['agent-context-panel.js'] })`
 * would (see `pick.spec.ts` for why the popup→injection wiring itself
 * isn't simulated here). The panel lives in a closed shadow root by design
 * (same reasoning as `results-panel.ts`), so these tests assert only
 * externally-observable effects — `buildAgentContext`'s own content is
 * covered directly in `agent-context.spec.ts`.
 */
test.describe('agent-context-panel.js', () => {
  test('picks an element and opens the context panel', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button id="target" data-testid="submit-btn">Submit</button>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'agent-context-panel.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();

    await page.hover('#target');
    await page.click('#target');

    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-agent-context-host'))).toBe(true);
  });

  test('Escape at the element step ends the flow with no panel', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><button id="x">X</button></body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'agent-context-panel.js') });
    await expect.poll(() => activeTool(page)).toBe('agent-context-panel');
    await page.keyboard.press('Escape');
    await expect.poll(() => activeTool(page)).toBeNull();
    expect(await page.evaluate(() => !!document.getElementById('piwi-agent-context-host'))).toBe(false);
  });

  test('re-injecting while a pick is already in progress does not double-install the overlay', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><button id="x">X</button></body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'agent-context-panel.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();
    await page.addScriptTag({ path: path.join(DIST, 'agent-context-panel.js') });
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
  });

  test('Escape closes the context panel once open', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button id="target" data-testid="submit-btn">Submit</button>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'agent-context-panel.js') });
    await page.hover('#target');
    await page.click('#target');
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-agent-context-host'))).toBe(true);

    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-agent-context-host'))).toBe(false);
  });

  test('speaks French around a block that stays in English', async ({ context }) => {
    await openShadowRoots(context);
    await stubChromeI18n(context, 'fr');
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button id="target" data-testid="submit-btn">Submit</button>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'agent-context-panel.js') });
    await page.hover('#target');
    await page.click('#target');

    const panel = () =>
      page.evaluate(() => {
        const root = document.getElementById('piwi-agent-context-host')?.shadowRoot;
        const dialog = root?.querySelector('[role="dialog"]');
        if (!root || !dialog) return null;
        return {
          lang: (dialog as HTMLElement).lang,
          label: dialog.getAttribute('aria-label'),
          title: root.querySelector('.title')?.textContent,
          sub: root.querySelector('.sub')?.textContent,
          close: root.querySelector('.close')?.getAttribute('aria-label'),
          copy: root.querySelector('button.copy')?.textContent,
          blockLang: root.querySelector('pre')?.lang,
          block: root.querySelector('pre')?.textContent?.split('\n')[0],
        };
      });
    await expect.poll(panel).not.toBeNull();
    expect(await panel()).toEqual({
      lang: 'fr',
      label: 'Contexte IA',
      title: 'Contexte IA',
      sub: 'Collez ce texte dans votre assistant de code IA · Échap pour fermer',
      close: 'Fermer',
      copy: 'Copier',
      blockLang: 'en',
      block: '## Piwi element context',
    });
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('lays out in German without clipping', async ({ context }) => {
    await openShadowRoots(context);
    await stubChromeI18n(context, 'de');
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button id="target" data-testid="submit-btn">Submit</button>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'agent-context-panel.js') });
    await page.hover('#target');
    await page.click('#target');

    const lang = () =>
      page.evaluate(
        () =>
          document.getElementById('piwi-agent-context-host')?.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]')
            ?.lang ?? null,
      );
    await expect.poll(lang).toBe('de');
    expect(await clippedInShadows(page)).toEqual([]);
  });
});

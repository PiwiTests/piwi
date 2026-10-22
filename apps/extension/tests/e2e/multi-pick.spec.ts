import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';
import { openShadowRoots } from './shadow.js';
import { stubChromeI18n } from './i18n-stub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

/**
 * Waits for a *fresh* pick-overlay banner, not just any banner: the previous
 * cycle's banner keeps showing "click any element…" as its head text even
 * after being picked (only the foot text changes, to "Analyzing element…"),
 * and `pickOne`'s ~120ms state-poll lag means the next `installPickerOverlay`
 * call (and its fresh banner) doesn't happen the instant a click fires.
 * `getByText('click any element…')` can therefore match the *stale* banner
 * from the pick that just happened, letting a hover/click on the next target
 * land with no picker actually listening yet. The foot's untouched initial
 * text is the one signal that's unambiguous across pick cycles.
 */
async function waitForFreshPickBanner(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.getElementById('__piwi_picker_foot')?.textContent))
    .toBe('Enter picks the focused element · ↑ parent · ↓ child · Esc skip');
}

const activeTool = (page: Page) =>
  page.evaluate(() => (globalThis as { __piwiActiveTool?: { id: string } }).__piwiActiveTool?.id ?? null);

/**
 * The between-picks bar, the "no pattern found" message, and the results
 * panel all live in closed shadow roots by design (same reasoning as
 * `results-panel.ts`), so — like `pick.spec.ts` — these tests assert only
 * externally-observable effects (host presence, the picker's own light-DOM
 * banner, and session lifecycle) rather than shadow-root-internal content.
 * `derivePattern`'s matching/derivation logic itself is covered directly in
 * `multi-pick-derive.spec.ts`.
 */
test.describe('multi-pick.js', () => {
  test('picks 2 items and derives a pattern into a results panel on Enter', async ({ context }) => {
    const page = await context.newPage();
    // margin-top clears the picker banner's fixed top-center area (~y 12-70px)
    // so hovering the rows below never fights its own "click here" chrome.
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <ul>
        <li id="row1">Alice - active</li>
        <li id="row2">Bob - active</li>
        <li id="row3">Carol - suspended</li>
      </ul>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });

    await waitForFreshPickBanner(page);
    await page.hover('#row1');
    await page.click('#row1');

    // The picker overlay re-installs itself for the second mandatory pick.
    await waitForFreshPickBanner(page);
    await page.hover('#row2');
    await page.click('#row2');

    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-multi-pick-bar-host'))).toBe(true);
    await page.keyboard.press('Enter');

    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-multi-pick-panel-host'))).toBe(true);
    expect(await page.evaluate(() => !!document.getElementById('piwi-multi-pick-bar-host'))).toBe(false);
  });

  test('picking a 3rd item ("pick another", reached via Shift+Tab since it lives in a closed shadow root) auto-finishes without another prompt', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <ul>
        <li id="row1">Alice - active</li>
        <li id="row2">Bob - active</li>
        <li id="row3">Carol - suspended</li>
      </ul>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });

    await waitForFreshPickBanner(page);
    await page.hover('#row1');
    await page.click('#row1');
    await waitForFreshPickBanner(page);
    await page.hover('#row2');
    await page.click('#row2');

    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-multi-pick-bar-host'))).toBe(true);
    // deriveBtn is focused by default (native button focus/activation, no
    // global Enter hijack — see multi-pick.ts) — Shift+Tab reaches the
    // previous focusable element, moreBtn ("Pick another"), and Enter
    // activates whichever button currently has focus, same as a real user
    // tabbing through the bar.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');

    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-multi-pick-bar-host'))).toBe(false);
    await waitForFreshPickBanner(page);
    await page.hover('#row3');
    await page.click('#row3');

    // 3 picks reached (MAX_PICKS) — derives immediately, no further prompt.
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-multi-pick-panel-host'))).toBe(true);
    expect(await page.evaluate(() => !!document.getElementById('piwi-multi-pick-bar-host'))).toBe(false);
  });

  test('Escape during the first pick cancels the whole session', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><li id="row1">Alice</li></body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });
    await waitForFreshPickBanner(page);

    await page.keyboard.press('Escape');

    expect(await page.evaluate(() => !!document.getElementById('piwi-multi-pick-bar-host'))).toBe(false);
    expect(await page.evaluate(() => !!document.getElementById('piwi-multi-pick-panel-host'))).toBe(false);
    await expect.poll(() => activeTool(page)).toBeNull();
  });

  test('Escape at the between-picks bar cancels the session with no results panel', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <li id="row1">Alice</li><li id="row2">Bob</li>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });

    await waitForFreshPickBanner(page);
    await page.hover('#row1');
    await page.click('#row1');
    await waitForFreshPickBanner(page);
    await page.hover('#row2');
    await page.click('#row2');

    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-multi-pick-bar-host'))).toBe(true);
    await page.keyboard.press('Escape');

    expect(await page.evaluate(() => !!document.getElementById('piwi-multi-pick-bar-host'))).toBe(false);
    expect(await page.evaluate(() => !!document.getElementById('piwi-multi-pick-panel-host'))).toBe(false);
    await expect.poll(() => activeTool(page)).toBeNull();
  });

  test('another tool started at the between-picks bar ends the session, and multi-pick starts again', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <li id="row1">Alice</li><li id="row2">Bob</li>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });

    await waitForFreshPickBanner(page);
    await page.hover('#row1');
    await page.click('#row1');
    await waitForFreshPickBanner(page);
    await page.hover('#row2');
    await page.click('#row2');
    await expect(page.locator('#piwi-multi-pick-bar-host')).toBeAttached();

    await page.addScriptTag({ path: path.join(DIST, 'lint-overlay.js') });
    await expect.poll(() => activeTool(page)).toBe('lint-overlay');
    await expect(page.locator('#piwi-multi-pick-bar-host')).toHaveCount(0);
    await expect(page.locator('#piwi-lint-overlay-host')).toBeAttached();

    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });
    await expect.poll(() => activeTool(page)).toBe('multi-pick');
    await waitForFreshPickBanner(page);
    await expect(page.locator('#piwi-lint-overlay-host')).toHaveCount(0);
  });

  test('shows a dismissible message and no panel when the picks share no common pattern', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <button id="a">Save</button>
      <img id="b" alt="logo" src="x.png" />
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });

    await waitForFreshPickBanner(page);
    await page.hover('#a');
    await page.click('#a');
    await waitForFreshPickBanner(page);
    await page.hover('#b');
    await page.click('#b');

    // 2 picks always stop at the between-picks bar first — derive to reach
    // the pattern-lookup step this test actually wants to exercise.
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-multi-pick-bar-host'))).toBe(true);
    await page.keyboard.press('Enter');

    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-multi-pick-message-host'))).toBe(true);
    expect(await page.evaluate(() => !!document.getElementById('piwi-multi-pick-panel-host'))).toBe(false);

    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-multi-pick-message-host'))).toBe(false);
  });

  test('counts the position among the rows Playwright finds, a hidden copy aside', async ({ context }) => {
    await openShadowRoots(context);
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <ul>
        <li style="display:none">Loading…</li>
        <li id="row1">Loading…</li>
        <li id="row2">Loading…</li>
      </ul>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });
    for (const row of ['#row1', '#row2']) {
      await waitForFreshPickBanner(page);
      await page.hover(row);
      await page.click(row);
    }
    await expect(page.locator('#piwi-multi-pick-bar-host')).toBeAttached();
    await page.keyboard.press('Enter');

    const locators = page.locator('#piwi-multi-pick-panel-host .row code');
    await expect(locators).toHaveText([`getByRole('listitem').nth(0)`, `getByRole('listitem').nth(1)`]);
    await expect(page.getByRole('listitem').nth(0)).toHaveAttribute('id', 'row1');
    await expect(page.getByRole('listitem').nth(1)).toHaveAttribute('id', 'row2');
  });

  test('the panel shows the base locator as code, and marks the copy mode chosen in every row', async ({ context }) => {
    await openShadowRoots(context);
    await stubChromeI18n(context);
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <ul><li id="row1">Alice - active</li><li id="row2">Bob - active</li></ul>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });
    for (const row of ['#row1', '#row2']) {
      await waitForFreshPickBanner(page);
      await page.hover(row);
      await page.click(row);
    }
    await expect(page.locator('#piwi-multi-pick-bar-host')).toBeAttached();
    await page.keyboard.press('Enter');

    const panel = page.locator('#piwi-multi-pick-panel-host .panel');
    const title = panel.locator('.title');
    await expect(title).toHaveText("2 locators built on getByRole('listitem')");
    await expect(title.locator('.piwi-loc')).toHaveText("getByRole('listitem')");
    await expect(title.locator('.piwi-loc .piwi-tok-fn')).toHaveText('getByRole');
    await expect(panel).toHaveAttribute('aria-modal', 'true');

    const rows = panel.locator('.row');
    await rows
      .nth(1)
      .getByRole('button', { name: /^Action/ })
      .click();
    for (const row of await rows.all()) {
      await expect(row.getByRole('button', { name: /^Action/ })).toHaveAttribute('data-active', 'true');
    }
  });

  test('re-injecting while a session is already in progress does not start a second one', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><li id="row1">Alice</li></body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });
    await waitForFreshPickBanner(page);

    await page.addScriptTag({ path: path.join(DIST, 'multi-pick.js') });
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
  });
});

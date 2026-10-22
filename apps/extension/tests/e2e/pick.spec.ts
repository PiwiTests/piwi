import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { servePages } from './engine-bundle.js';
import { playwrightLocator } from './playwright-locator.js';
import { stubChromeI18n } from './i18n-stub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

const activeTool = (page: Page) =>
  page.evaluate(() => (globalThis as { __piwiActiveTool?: { id: string } }).__piwiActiveTool?.id ?? null);

/** A button inside a form with a test id: picking it opens the anchors step. */
const ANCHORED = `<!doctype html><html><body style="margin-top:120px">
  <form data-testid="signup-form"><button id="target" data-testid="join-btn">Join now</button></form>
</body></html>`;

/**
 * Drives the real built `pick.js` — injected the same way
 * `chrome.scripting.executeScript({ files: ['pick.js'] })` would, since
 * Playwright has no API to click the browser's own toolbar icon (the
 * popup→injection wiring itself is covered by `popup.spec.ts` and manual
 * verification, not simulated end-to-end here).
 */
test.describe('pick.js', () => {
  test('picks an element, skips the anchors step, and opens the results panel', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <form data-testid="signup-form"><button id="target" data-testid="join-btn">Join now</button></form>
    </body></html>`);

    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();

    await page.hover('#target');
    await page.click('#target');

    // The role has an anchor-worthy ancestor (the form's data-testid), so the
    // anchors step opens — skip it to reach the results panel.
    await expect(page.getByText('Scope to stable parents')).toBeVisible();
    await page.getByRole('button', { name: 'Skip (Esc)' }).click();

    // The results panel lives in a closed shadow root (deliberate — see
    // results-panel.ts) so its contents aren't reachable through Playwright's
    // locator engine; the host existing confirms the flow reached the end.
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-picker-results-host'))).toBe(true);
    // …and the picking overlay is gone by then: one left reading "Analyzing
    // element…" at the end of the flow would look exactly like a pick that hung.
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(0);
  });

  test('the hover preview shows the ranked locator, not the overlay approximation', async ({ context }) => {
    const page = await context.newPage();
    // An id and an accessible name: the overlay's own descriptor would settle
    // for `locator('#target')`, the ranking engine prefers the role+name.
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <button id="target">Join now</button>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();

    await page.hover('#target');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("getByRole('button', { name: 'Join now' })");
    await expect(page.locator('#__piwi_picker_label')).toContainText("getByRole('button', { name: 'Join now' })");
  });

  test('a form control named only by its label is located by that label', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <label for="country">Country</label>
      <select id="country"><option>United Kingdom</option><option>Ireland</option><option>France</option></select>
      <label><input type="checkbox" id="news"> Keep me posted on new roasts</label>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();

    const preview = page.locator('#__piwi_picker_locator');
    await page.hover('#country');
    await expect(preview).toContainText("getByRole('combobox', { name: 'Country' })");
    // The suggestion resolves in real Playwright too.
    await expect(page.getByRole('combobox', { name: 'Country' })).toHaveId('country');

    await page.hover('#news');
    await expect(preview).toContainText("getByRole('checkbox', { name: 'Keep me posted on new roasts' })");
    await page.evaluate(() => document.getElementById('news')!.removeAttribute('id'));
    await page.mouse.move(0, 0);
    await page.hover('input[type=checkbox]');
    await expect(preview).toContainText("getByRole('checkbox', { name: 'Keep me posted on new roasts' })");
  });

  test('Escape at the element step ends the flow with no results panel', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><button id="x">X</button></body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect.poll(() => activeTool(page)).toBe('pick');
    await page.keyboard.press('Escape');
    await expect.poll(() => activeTool(page)).toBeNull();
    expect(await page.evaluate(() => !!document.getElementById('piwi-picker-results-host'))).toBe(false);
  });

  test('Escape at the anchors step skips it, and the results open for the pick still running', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(ANCHORED);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await page.hover('#target');
    await page.click('#target');
    await expect(page.getByText('Scope to stable parents')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#piwi-picker-results-host')).toBeAttached();
    await expect(page.getByText('Scope to stable parents')).toHaveCount(0);
    expect(await activeTool(page)).toBe('pick');

    // The next Escape closes the results and ends the pick.
    await page.keyboard.press('Escape');
    await expect(page.locator('#piwi-picker-results-host')).toHaveCount(0);
    await expect.poll(() => activeTool(page)).toBeNull();
  });

  test('a pick replaced before its click gives the page back its clicks and arrow keys', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <button id="target" onclick="window.__clicks = (window.__clicks || 0) + 1">Join now</button>
      <input id="field" onkeydown="if (event.key === 'ArrowDown') window.__arrows = (window.__arrows || 0) + 1">
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
    await page.addScriptTag({ path: path.join(DIST, 'lint-overlay.js') });
    await expect.poll(() => activeTool(page)).toBe('lint-overlay');
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(0);

    await page.focus('#field');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => (window as { __arrows?: number }).__arrows)).toBe(1);
    await page.click('#target');
    expect(await page.evaluate(() => (window as { __clicks?: number }).__clicks)).toBe(1);
    expect(await page.evaluate(() => (globalThis as { __piwiPickState?: string }).__piwiPickState)).not.toBe('picked');
  });

  test('a pick replaced at the anchors step leaves no panel behind and opens no results', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(ANCHORED);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await page.hover('#target');
    await page.click('#target');
    await expect(page.getByText('Scope to stable parents')).toBeVisible();

    await page.addScriptTag({ path: path.join(DIST, 'lint-overlay.js') });
    await expect.poll(() => activeTool(page)).toBe('lint-overlay');
    await expect(page.getByText('Scope to stable parents')).toHaveCount(0);
    // Long enough for the replaced pick to have opened its results, were it still going.
    await page.waitForTimeout(400);
    await expect(page.locator('#piwi-picker-results-host')).toHaveCount(0);
    await expect(page.locator('#piwi-lint-overlay-host')).toBeAttached();
    expect(await activeTool(page)).toBe('lint-overlay');
  });

  test('re-injecting while a pick is already in progress does not double-install the overlay', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><button id="x">X</button></body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    // Still exactly one banner/highlight pair — the guard in pick.ts returned
    // early on the second injection instead of installing a second overlay.
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(1);
  });
});

const ORIGIN = 'https://pick.test';

async function openCases(context: BrowserContext): Promise<Page> {
  // pick.js runs in the page's main world here: its texts need a `chrome.i18n`.
  await stubChromeI18n(context);
  const page = await context.newPage();
  await servePages(page, ORIGIN);
  await page.goto(`${ORIGIN}/pick-cases.html`);
  return page;
}

interface PanelRow {
  locator: string;
  verdict: 'unique' | 'ambiguous' | null;
  note: string;
}

/** Picks the element marked `data-case="<name>"` on `pick-cases.html` and reads the results panel's rows. */
async function pickRows(page: Page, name: string): Promise<PanelRow[]> {
  await page.evaluate(() => {
    (globalThis as { __piwiTestOpenShadow?: boolean }).__piwiTestOpenShadow = true;
  });
  await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
  await expect(page.getByText('click any element to generate locators')).toBeVisible();
  const target = `[data-case="${name}"]`;
  await page.hover(target);
  await page.click(target);
  const results = page.locator('#piwi-picker-results-host .panel');
  const skip = page.getByRole('button', { name: 'Skip (Esc)' });
  await expect(results.or(skip)).toBeVisible();
  if (await skip.isVisible()) await skip.click();
  await expect(results).toBeVisible();
  const rows = await page.evaluate(() => {
    const root = document.getElementById('piwi-picker-results-host')!.shadowRoot!;
    return [...root.querySelectorAll('.row')].map((row) => {
      const badge = row.querySelector('.unique, .ambiguous');
      return {
        locator: row.querySelector('code')!.textContent!,
        verdict: (badge?.className ?? null) as 'unique' | 'ambiguous' | null,
        note: badge?.textContent ?? '',
      };
    });
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#piwi-picker-results-host')).toHaveCount(0);
  await expect.poll(() => activeTool(page)).toBeNull();
  return rows;
}

/** Real Playwright finds exactly the picked element with `locator`, and a click on it lands there. */
async function expectPlaywrightClicks(page: Page, locator: string, name: string): Promise<void> {
  const found = playwrightLocator(page, locator);
  await expect(found).toHaveCount(1);
  expect(await found.getAttribute('data-case')).toBe(name);
  await page.evaluate(() => {
    const g = globalThis as { __clicked?: string | null };
    g.__clicked = null;
    document.addEventListener(
      'click',
      (event) => {
        g.__clicked = (event.target as Element).closest('[data-case]')?.getAttribute('data-case') ?? null;
        event.preventDefault();
      },
      { capture: true, once: true },
    );
  });
  await found.click();
  expect(await page.evaluate(() => (globalThis as { __clicked?: string | null }).__clicked)).toBe(name);
}

/**
 * The composite controls and repeated names that made the extension offer
 * locators Playwright never resolves to the picked element. The top locator
 * the results panel offers is clicked by real Playwright on the same page.
 */
test.describe('pick.js offers locators Playwright resolves to the picked element', () => {
  const cases: Array<{ name: string; title: string; top?: string }> = [
    { name: 'tab', title: 'a tab with a count badge', top: "getByRole('tab', { name: 'Regressions 5' })" },
    { name: 'search', title: 'a button with key hints', top: "getByRole('button', { name: 'Search… Ctrl k' })" },
    { name: 'failed', title: "a name that is a substring of another ('Failed' beside '3 failed')" },
    { name: 'link', title: 'the same link in the nav and in main' },
    { name: 'popup', title: 'two buttons sharing an aria-label, showing different text' },
    { name: 'th', title: 'a table column header', top: "getByRole('columnheader', { name: 'Price' })" },
    {
      name: 'combobox',
      title: 'a search field with suggestions, a combobox',
      top: "getByRole('combobox', { name: 'Find a run' })",
    },
    { name: 'banner', title: 'a page header, a banner landmark', top: "getByRole('banner', { name: 'Site header' })" },
  ];
  for (const { name, title, top } of cases) {
    test(title, async ({ context }) => {
      const page = await openCases(context);
      const rows = await pickRows(page, name);
      expect(rows.length).toBeGreaterThan(0);
      if (top) expect(rows[0]!.locator).toBe(top);
      expect(rows[0]!.verdict).toBe('unique');
      // Verified rows come first; every row after the first unverified one is unverified too.
      const firstOther = rows.findIndex((row) => row.verdict !== 'unique');
      if (firstOther >= 0) expect(rows.slice(firstOther).every((row) => row.verdict !== 'unique')).toBe(true);
      // Every verified row resolves to the picked element in Playwright, the top one clicked.
      for (const row of rows.filter((r) => r.verdict === 'unique')) {
        await expect(playwrightLocator(page, row.locator), row.locator).toHaveCount(1);
      }
      await expectPlaywrightClicks(page, rows[0]!.locator, name);
    });
  }

  test('an ambiguous candidate shows how many elements it finds, and its narrowed form is offered', async ({
    context,
  }) => {
    const page = await openCases(context);
    const rows = await pickRows(page, 'failed');
    const loose = rows.find((row) => row.locator === "getByRole('button', { name: 'Failed' })");
    expect(loose?.verdict).toBe('ambiguous');
    expect(loose?.note).toContain('2');
    await expect(playwrightLocator(page, loose!.locator)).toHaveCount(2);
    const exact = rows.find((row) => row.locator === "getByRole('button', { name: 'Failed', exact: true })");
    expect(exact?.verdict).toBe('unique');
    expect(rows.indexOf(exact!)).toBeLessThan(rows.indexOf(loose!));
  });

  test('the hover preview shows the verified locator, not the substring match', async ({ context }) => {
    const page = await openCases(context);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();
    await page.hover('[data-case="link"]');
    const preview = page.locator('#__piwi_picker_locator');
    // The ranked candidate shows as the pointer enters; the checked one once it rests.
    await expect(preview).toHaveText("getByRole('main').getByRole('link', { name: 'Runs', exact: true })");
    await expect(page.locator('#__piwi_picker_label')).toContainText(
      "getByRole('main').getByRole('link', { name: 'Runs', exact: true })",
    );
    const shown = (await preview.textContent())!.trim();
    await expect(playwrightLocator(page, shown)).toHaveCount(1);
    expect(await playwrightLocator(page, shown).getAttribute('data-case')).toBe('link');
  });
});

const RESULTS = '#piwi-picker-results-host';

/** Picks `#target` on a page served from an https origin, where the clipboard works, and opens its results, in an open shadow root. */
async function openResults(context: BrowserContext, before?: (page: Page) => Promise<void>): Promise<Page> {
  await stubChromeI18n(context);
  const page = await context.newPage();
  await servePages(page, ORIGIN, {
    'results.html': `<!doctype html><html><body style="margin-top:120px">
      <input id="search" aria-label="Search"><button id="target">Join now</button>
    </body></html>`,
  });
  await page.goto(`${ORIGIN}/results.html`);
  await page.evaluate(() => {
    (globalThis as { __piwiTestOpenShadow?: boolean }).__piwiTestOpenShadow = true;
  });
  await before?.(page);
  await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
  await expect(page.getByText('click any element to generate locators')).toBeVisible();
  await page.hover('#target');
  await page.click('#target');
  await expect(page.locator(`${RESULTS} .panel`)).toBeVisible();
  return page;
}

test.describe('pick.js results panel', () => {
  test('a copy button clicked twice within a second goes back to its own label', async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await openResults(context);
    const copyAll = page.locator(`${RESULTS} .header-actions button.copy`);
    const label = (await copyAll.textContent())!;
    expect(label).toMatch(/^Copy all \d+$/);
    await copyAll.click();
    await expect(copyAll).toHaveText('Copied');
    await copyAll.click();
    await expect(copyAll).toHaveText('Copied');
    // Past the second click's moment, not only the first's.
    await page.waitForTimeout(1600);
    await expect(copyAll).toHaveText(label);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      "getByRole('button', { name: 'Join now' })",
    );
  });

  test('a copy the browser refuses says so, then shows the label again', async ({ context }) => {
    const page = await openResults(context, (p) =>
      p.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')) },
        });
        document.execCommand = () => false;
      }),
    );
    const copyAll = page.locator(`${RESULTS} .header-actions button.copy`);
    const label = (await copyAll.textContent())!;
    await copyAll.click();
    await expect(copyAll).toHaveText('Not copied');
    await expect(copyAll).toHaveText(label);
  });

  test('where the clipboard API refuses, the copy command copies', async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await openResults(context, (p) =>
      p.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: () => Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')) },
        });
      }),
    );
    const row = page.locator(`${RESULTS} .row`).first();
    const locator = (await row.locator('code').textContent())!;
    const copy = row.locator('button.copy').first();
    await expect(copy).toHaveText('Locator');
    await copy.click();
    await expect(copy).toHaveText('Copied');
    await expect(copy).toBeFocused();
    // The page's own clipboard, under the stub.
    const copied = await page.evaluate(() =>
      (Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard')!.get!.call(navigator) as Clipboard).readText(),
    );
    expect(copied).toBe(`page.${locator}`);
  });

  test('the copy mode chosen in one row is marked in every row, as Send to editor sends it', async ({ context }) => {
    const page = await openResults(context);
    const rows = page.locator(`${RESULTS} .row`);
    expect(await rows.count()).toBeGreaterThan(1);
    await rows.nth(1).getByRole('button', { name: 'Assertion', exact: true }).click();
    for (const row of await rows.all()) {
      await expect(row.getByRole('button', { name: 'Assertion', exact: true })).toHaveAttribute('data-active', 'true');
      await expect(row.getByRole('button', { name: 'Locator', exact: true })).toHaveAttribute('data-active', 'false');
    }
  });

  test('holds the focus while open, and gives it back as it closes', async ({ context }) => {
    const page = await openResults(context, (p) => p.locator('#search').focus());
    const panel = page.locator(`${RESULTS} .panel`);
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    const first = page.locator(`${RESULTS} .header-actions button.copy`);
    const last = panel.locator('button').last();
    await expect(first).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator(RESULTS)).toHaveCount(0);
    await expect(page.locator('#search')).toBeFocused();
  });
});

test.describe('pick.js in another language', () => {
  test('the picking overlay and the anchors step speak French', async ({ context }) => {
    await stubChromeI18n(context, 'fr');
    const page = await context.newPage();
    await page.setContent(ANCHORED);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect(page.locator('#__piwi_picker_banner')).toContainText(
      'Inspecteur Piwi, cliquez sur un élément pour générer ses locators',
    );
    await expect(page.locator('#__piwi_picker_foot')).toHaveText(
      'Entrée choisit l’élément qui a le focus · ↑ parent · ↓ enfant · Échap pour passer',
    );
    await page.hover('#target');
    await expect(page.locator('#__piwi_picker_foot')).toHaveText(
      'cliquez ou Entrée pour choisir · ↑ parent · ↓ enfant · Échap pour passer',
    );
    await page.click('#target');
    await expect(page.getByText('Limiter à des parents stables (facultatif)')).toBeVisible();
    await expect(page.getByText('Aucun parent choisi, les locators habituels seulement.')).toBeVisible();
    await expect(page.getByText('contient exactement 1 élément correspondant')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Utiliser les parents choisis' })).toBeVisible();
    await page.getByRole('button', { name: 'Passer (Échap)' }).click();
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-picker-results-host'))).toBe(true);
  });
});

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, extensionWorker, launchWithExtension, openOptions } from './fixtures.js';
import { dispatchRuntimeMessage, readStoredEvents, stubChromeStorage } from './recording-stub.js';
import { stubChromeI18n } from './i18n-stub.js';
import { routeShop, SHOP_ORIGIN } from './bug-shop.js';
import { readStoredZip } from '../zip-reader.js';
import { engineBundle } from './engine-bundle.js';
import { emptyBugEvidence, isBugReportArchive, renderBugSpec, type BugReport } from '@piwitests/core/bug-report';
import { parseSteps, type PiwiSteps } from '@piwitests/core/steps';
import { clippedInShadows, openShadowRoots } from './shadow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');
const TOKEN = 'a'.repeat(32);
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * A bug recording driven through the real `record-panel.js` and
 * `bug-evidence-main.js` bundles, on top of the stubbed `chrome.storage` of
 * `recording-stub.ts`: the evidence script is added at document start, as its
 * registration does, and both run in the page's main world here, where the
 * relay works the same way it does across the two worlds.
 */
async function startBugRecording(
  context: BrowserContext,
  screenshot: { ok: boolean; reason?: string },
  options: { language?: string; path?: string; init?: (context: BrowserContext) => Promise<void> } = {},
): Promise<Page> {
  await stubChromeStorage(context, {
    session: {
      piwiRecording: {
        active: true,
        events: [],
        startedAt: Date.now(),
        grantedOriginPattern: `${SHOP_ORIGIN}/*`,
        mode: 'bug',
        bugToken: TOKEN,
      },
    },
    responses: {
      'piwi-bug-screenshot': screenshot.ok
        ? { ok: true, dataUrl: PNG }
        : { ok: false, error: 'activeTab', reason: screenshot.reason ?? 'not-granted' },
    },
  });
  if (options.language) await stubChromeI18n(context, options.language);
  await options.init?.(context);
  await context.addInitScript({ path: path.join(DIST, 'bug-evidence-main.js') });
  const page = await context.newPage();
  await page.goto(`${SHOP_ORIGIN}${options.path ?? '/cart'}`);
  await attachRecorder(page);
  return page;
}

async function attachRecorder(page: Page): Promise<void> {
  await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
}

/** The HUD's buttons, in order, reached through its host: its shadow root delegates focus. */
const HUD = { mark: 0, missing: 1, wrongPage: 2, finish: 3 } as const;

async function pressHudButton(page: Page, which: keyof typeof HUD): Promise<void> {
  // A hidden HUD takes no focus: it is hidden while a screenshot is taken.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById('piwi-record-hud-host')!).visibility))
    .toBe('visible');
  await page.focus('#piwi-record-hud-host');
  for (let i = 0; i < HUD[which]; i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
}

function hostPresent(page: Page, id: string): Promise<boolean> {
  return page.evaluate((hostId) => !!document.getElementById(hostId), id);
}

async function readEvidence(page: Page): Promise<Record<string, any>> {
  const stored = await page.evaluate(async () => (globalThis as any).chrome.storage.session.get('piwiBugEvidence'));
  return stored.piwiBugEvidence ?? {};
}

/** Screenshots kept so far: the last thing a marking flow does. */
async function screenshotCount(page: Page): Promise<number> {
  const stored = await page.evaluate(async () => (globalThis as any).chrome.storage.session.get('piwiBugScreenshots'));
  return (stored.piwiBugScreenshots ?? []).length;
}

/** The `lang` of the panel inside a host's shadow root. */
function panelLang(page: Page, hostId: string, selector: string): Promise<string | null> {
  return page.evaluate(
    ([id, sel]) => document.getElementById(id)?.shadowRoot?.querySelector(sel)?.getAttribute('lang') ?? null,
    [hostId, selector] as const,
  );
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** A sign-in page: a password a button shows in clear, a card number its autocomplete names, and a plain field. */
const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body><main>
  <h1>Sign in</h1>
  <label for="user">User</label> <input id="user" value="ana" />
  <label for="pw">Password</label> <input id="pw" type="password" />
  <button type="button" id="show" onclick="pw.type = pw.type === 'password' ? 'text' : 'password'">Show password</button>
  <label for="card">Card number</label> <input id="card" autocomplete="cc-number" value="4111111111111111" />
</main></body></html>`;

async function routeLogin(context: BrowserContext): Promise<void> {
  await context.route(`${SHOP_ORIGIN}/login`, (route) => route.fulfill({ contentType: 'text/html', body: LOGIN_PAGE }));
}

/**
 * Holds each message of `delays` back for its delay, as a screenshot takes
 * time, and keeps the recorder's surfaces that are visible once it has passed:
 * what the screenshot would show. `__piwiInFlight` counts those held, by type.
 */
async function slowMessages(context: BrowserContext, delays: Record<string, number>): Promise<void> {
  await context.addInitScript((delayOf) => {
    const g = globalThis as any;
    const runtime = g.chrome.runtime;
    const send = runtime.sendMessage;
    g.__piwiShown = [] as string[];
    g.__piwiInFlight = {} as Record<string, number>;
    runtime.sendMessage = async (message: { type?: string } | undefined) => {
      const type = message?.type ?? '';
      const delay = delayOf[type];
      if (delay != null) {
        g.__piwiInFlight[type] = (g.__piwiInFlight[type] ?? 0) + 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        for (const id of ['piwi-record-hud-host', 'piwi-record-frame-host', 'piwi-bug-dialog-host']) {
          const host = document.getElementById(id);
          if (type === 'piwi-bug-screenshot' && host && getComputedStyle(host).visibility !== 'hidden')
            g.__piwiShown.push(id);
        }
        g.__piwiInFlight[type]--;
      }
      return send(message);
    };
  }, delays);
}

const inFlight = (page: Page, type: string): Promise<number> =>
  page.evaluate((t) => (globalThis as any).__piwiInFlight[t] ?? 0, type);

const shownInScreenshots = (page: Page): Promise<string[]> => page.evaluate(() => (globalThis as any).__piwiShown);

const visibility = (page: Page, id: string): Promise<string | null> =>
  page.evaluate((hostId) => {
    const host = document.getElementById(hostId);
    return host ? getComputedStyle(host).visibility : null;
  }, id);

test.describe('Report a bug', () => {
  test('records the flow, what is wrong, what is missing and the evidence, and exports a failing test', async ({
    context,
  }) => {
    test.setTimeout(90_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const shop = { fixed: false };
    await routeShop(context, shop);
    const requests: string[] = [];
    context.on('request', (r) => requests.push(r.url()));
    const page = await startBugRecording(context, { ok: true });

    await page.fill('#coupon', 'SPRING10');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(async () => (await readEvidence(page)).requests?.length ?? 0).toBe(1);
    await expect.poll(async () => (await readEvidence(page)).console?.length ?? 0).toBe(1);

    // Mark what's wrong: pick the total, say it should read "Total: 45".
    await pressHudButton(page, 'mark');
    await expect(page.getByText('click any element to generate locators')).toBeVisible();
    await page.hover('#total');
    await page.click('#total');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
    // The expected field has focus, holding what the page shows.
    await page.keyboard.type('Total: 45');
    await page.keyboard.press('Tab');
    await page.keyboard.type('The coupon is ignored');
    await page.keyboard.press('Enter');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);
    await expect.poll(async () => (await readStoredEvents(page)).filter((e) => e.kind === 'assert').length).toBe(1);
    await expect.poll(() => screenshotCount(page)).toBe(1);

    // Something is missing: an element that is on the page is refused, then the missing one is added.
    await pressHudButton(page, 'missing');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
    await page.keyboard.type('Apply');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(await hostPresent(page, 'piwi-bug-dialog-host'), 'Apply is on the page: the dialog stays open').toBe(true);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Download invoice');
    await page.keyboard.press('Enter');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);
    await expect.poll(async () => (await readStoredEvents(page)).filter((e) => e.kind === 'assert').length).toBe(2);
    await expect.poll(() => screenshotCount(page)).toBe(2);

    // The picks and the dialogs recorded no step of their own.
    const events = await readStoredEvents(page);
    expect(events.map((e) => e.kind)).toEqual(['viewport', 'navigate', 'input', 'click', 'assert', 'assert']);

    // To the next page, where the evidence script and the recorder attach again.
    await page.getByRole('link', { name: 'Checkout' }).click();
    await page.waitForURL('**/checkout');
    await attachRecorder(page);
    await expect.poll(async () => (await readEvidence(page)).console?.length ?? 0).toBe(2);

    await pressHudButton(page, 'finish');
    await expect.poll(() => hostPresent(page, 'piwi-record-review-host')).toBe(true);
    expect(await hostPresent(page, 'piwi-record-hud-host')).toBe(false);
    expect(await hostPresent(page, 'piwi-record-frame-host')).toBe(false);

    // Finish panel, in its closed shadow root: close, title, Copy failing test, Copy report, Download .piwibug.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Coupon not applied to the total');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect.poll(() => readClipboard(page)).toContain('test.fail();');
    const spec = await readClipboard(page);
    expect(spec).toContain(`test('bug: coupon not applied to the total', {`);
    expect(spec).toContain(`tag: ['@bug'],`);
    expect(spec).toMatch(
      / {2}await page\.setViewportSize\(\{ width: \d+, height: \d+ \}\);\n {2}await page\.goto\('\/cart'\);/,
    );
    expect(spec).toContain(`await page.getByRole('textbox', { name: 'Coupon' }).fill('SPRING10');`);
    expect(spec).toContain(
      `await expect(page.getByTestId('cart-total')).toHaveText('Total: 45'); // recorded: 'Total: 50'`,
    );
    expect(spec).toContain(`await expect(page.getByRole('button', { name: 'Download invoice' })).toBeVisible();`);
    expect(spec).toMatch(/Checkout' \}\)\.click\(\);\n\}\);\n$/);

    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect.poll(() => readClipboard(page)).toContain('# Coupon not applied to the total');
    const markdown = await readClipboard(page);
    expect(markdown).toMatch(/^\*\*Page\*\* `\/checkout` on https:\/\/record-test\.local · Chrome \d+ · /m);
    expect(markdown).toContain('4. The element with test id `cart-total` should read "Total: 45"');
    expect(markdown).toContain('   - Actual: "Total: 50"');
    expect(markdown).toContain('   - Note: The coupon is ignored');
    expect(markdown).toContain('5. Button "Download invoice" should be visible');
    expect(markdown).toContain('3 screenshots · 1 console error · 1 console warning · 1 failed request · page outline');
    expect(markdown).toContain('`POST /api/cart/coupon?code=%3Credacted%3E` → 500, on `/cart`');
    expect(markdown).toContain('error on `/cart`');
    expect(markdown).toContain('`Coupon failed: 500`');
    expect(markdown).toContain('`Checkout: total not recomputed`');
    expect(markdown).toContain('### Page outline');
    expect(markdown).toContain('- heading "Your cart" [level=1]');
    expect(markdown).toContain('- textbox "Coupon": SPRING10');
    expect(markdown).toContain('- button "Apply"');
    expect(markdown).not.toContain('secret server detail');

    const download = page.waitForEvent('download');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^piwi-bug-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.piwibug$/);
    const archive = new Uint8Array(await readFile((await file.path())!));
    expect(isBugReportArchive(archive)).toBe(true);
    const files = readStoredZip(archive);
    expect([...files.keys()]).toEqual([
      'mimetype',
      'steps.json',
      'coupon-not-applied-to-the-total.spec.ts',
      'bug-report.md',
      'evidence.json',
      'screenshots/1-marked.png',
      'screenshots/2-marked.png',
      'screenshots/3-finish.png',
    ]);
    const text = (name: string) => new TextDecoder().decode(files.get(name));
    expect(text('coupon-not-applied-to-the-total.spec.ts')).toBe(spec);
    expect(text('bug-report.md')).toBe(markdown);
    expect(Array.from(files.get('screenshots/3-finish.png')!.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    const evidence = JSON.parse(text('evidence.json'));
    expect(evidence.context).toMatchObject({
      origin: SHOP_ORIGIN,
      pageKey: '/checkout',
      path: '/checkout',
      extensionVersion: '0.0.0-test',
    });
    expect(evidence.evidence.requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/api/cart/coupon?code=%3Credacted%3E',
        status: 500,
        page: '/cart',
      }),
    ]);
    expect(evidence.evidence.console).toEqual([
      expect.objectContaining({ level: 'error', source: 'console', message: 'Coupon failed: 500', page: '/cart' }),
      expect.objectContaining({ level: 'warn', message: 'Checkout: total not recomputed', page: '/checkout' }),
    ]);
    expect(evidence.evidence.screenshots.map((s: { step: number | null }) => s.step)).toEqual([3, 4, 5]);
    expect(JSON.stringify(evidence.evidence.requests)).not.toContain('SPRING10');

    // Nothing left the browser but the shop's own requests.
    expect(requests.filter((url) => /^https?:/.test(url) && !url.startsWith(SHOP_ORIGIN))).toEqual([]);

    // The steps, rendered without test.fail() and run on a new page: they fail
    // on the marked assertion while the bug is there, and pass once it is fixed.
    const parsed = parseSteps(text('steps.json'));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const doc: PiwiSteps = parsed.steps;
    expect(doc.title).toBe('Coupon not applied to the total');
    expect(doc.steps.map((s) => [s.action, s.pageUrl])).toEqual([
      ['goto', '/cart'],
      ['fill', '/cart'],
      ['click', '/cart'],
      ['assert', '/cart'],
      ['assert', '/cart'],
      ['click', '/cart'],
    ]);
    const report: BugReport = { v: 1, steps: doc, evidence: emptyBugEvidence(), context: evidence.context };
    const { code, warnings } = renderBugSpec(report, { format: 'body', expectFail: false, urls: 'absolute' });
    expect(warnings).toEqual([]);
    const run = async () => {
      const replayPage = await context.newPage();
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      try {
        await new AsyncFunction('page', 'expect', code)(replayPage, expect.configure({ timeout: 2000 }));
        return 'passed';
      } catch (error) {
        return stripVTControlCharacters((error as Error).message);
      } finally {
        await replayPage.close();
      }
    };
    const failure = await run();
    expect(failure).toContain("getByTestId('cart-total')");
    expect(failure).toContain('toHaveText');
    expect(failure).toContain('Total: 45');
    shop.fixed = true;
    expect(await run()).toBe('passed');
  });

  test('without the activeTab grant the report says there is no screenshot, and Wrong page adds a URL check', async ({
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: false });

    await pressHudButton(page, 'wrongPage');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
    // The field holds this page's path; the same path is refused.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(await hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('/cart/discounted');
    await page.keyboard.press('Enter');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);
    await expect.poll(async () => (await readEvidence(page)).screenshotNote ?? null).toContain('Take a screenshot');

    await pressHudButton(page, 'finish');
    await expect.poll(() => hostPresent(page, 'piwi-record-review-host')).toBe(true);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => readClipboard(page))
      .toContain("await expect(page).toHaveURL('/cart/discounted'); // recorded: '/cart'");

    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect.poll(() => readClipboard(page)).toContain('No screenshot: Chrome lets Piwi Picker take a screenshot');
    const markdown = await readClipboard(page);
    expect(markdown).toContain('2. The page should be `/cart/discounted`');
    expect(markdown).toMatch(/^no screenshot · page outline$/m);
  });

  test('Escape during the pick records nothing and resumes capture', async ({ context }) => {
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: true });
    await pressHudButton(page, 'mark');
    await expect(page.getByText('click any element to generate locators')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('click any element to generate locators')).toBeHidden();
    // The HUD, hidden during the pick, is back once capture has resumed.
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.getElementById('piwi-record-hud-host')!).visibility))
      .toBe('visible');
    await page.fill('#coupon', 'X1');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect
      .poll(async () => (await readStoredEvents(page)).map((e) => e.kind))
      .toEqual(['viewport', 'navigate', 'input', 'click']);
  });

  test('Mark what’s wrong shows the expected field only for a value', async ({ context }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: true });
    await pressHudButton(page, 'mark');
    await page.hover('#total');
    await page.click('#total');
    const dialog = page.locator('#piwi-bug-dialog-host').getByRole('dialog', { name: 'Mark what’s wrong' });
    await expect(dialog.getByLabel('What it should show')).toBeVisible();

    await dialog.getByLabel('What’s wrong').selectOption({ label: 'It should be hidden' });
    await expect(dialog.getByText('What it should show')).toBeHidden();
    await expect(dialog.getByRole('textbox')).toHaveCount(1);

    await dialog.getByLabel('What’s wrong').selectOption({ label: 'Its text' });
    await expect(dialog.getByLabel('What it should show')).toBeVisible();
  });

  test('in French: the HUD, the dialogs and the finished report', async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: false }, { language: 'fr' });
    const hud = page.locator('#piwi-record-hud-host');

    await expect(hud.getByText('Signalement d’un bug · 1 étape')).toBeVisible();
    await expect(hud.getByRole('button', { name: 'Marquer ce qui ne va pas' })).toHaveAttribute(
      'title',
      'Choisissez un élément de la page et dites ce qu’il devrait afficher',
    );
    await expect(hud.getByRole('button', { name: 'Il manque quelque chose' })).toBeVisible();
    await expect(hud.getByRole('button', { name: 'Terminer' })).toBeVisible();
    expect(await panelLang(page, 'piwi-record-hud-host', '.bar')).toBe('fr');

    // Something is missing: the kinds in French, and an element that is there refused in French.
    await pressHudButton(page, 'missing');
    const dialog = page.locator('#piwi-bug-dialog-host');
    await expect(dialog.getByRole('dialog', { name: 'Il manque quelque chose' })).toBeVisible();
    expect(await panelLang(page, 'piwi-bug-dialog-host', '.panel')).toBe('fr');
    await expect(dialog.getByLabel('Ce qui devrait être là')).toHaveValue('button');
    await expect(dialog.getByRole('option', { name: 'Case à cocher' })).toBeAttached();
    await page.keyboard.type('Apply');
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('alert')).toHaveText(
      '1 élément de ce type est déjà sur la page\u00a0: utilisez «\u202fMarquer ce qui ne va pas\u202f» pour dire ce qui ne va pas.',
    );
    await page.keyboard.press('Escape');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);

    // Mark what's wrong: the state choices and what the page shows, in French.
    await pressHudButton(page, 'mark');
    await page.hover('#total');
    await page.click('#total');
    await expect(dialog.getByRole('dialog', { name: 'Marquer ce qui ne va pas' })).toBeVisible();
    await expect(dialog.getByText('La page affiche')).toBeVisible();
    await expect(dialog.getByRole('option', { name: 'Il devrait être masqué' })).toBeAttached();
    await page.keyboard.type('Total: 45');
    await page.keyboard.press('Enter');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);
    await expect(hud.getByText('affiche «\u202fTotal: 50\u202f»')).toBeVisible();

    await pressHudButton(page, 'finish');
    const review = page.locator('#piwi-record-review-host');
    await expect(review.getByRole('dialog', { name: 'Rapport de bug Piwi Picker' })).toBeVisible();
    expect(await panelLang(page, 'piwi-record-review-host', '.panel')).toBe('fr');
    await expect(review.getByText('Rapport de bug · 2 étapes')).toBeVisible();
    await expect(review.getByLabel('Titre')).toBeVisible();
    for (const name of [
      'Copier le test en échec',
      'Copier le rapport',
      'Télécharger le .piwibug',
      'Rejouer',
      'Abandonner',
    ])
      await expect(review.getByRole('button', { name })).toBeVisible();
    await expect(review.getByText(/^Pas de capture d’écran\u00a0: Chrome ne laisse/)).toBeVisible();
    await expect(review.getByText('Tout reste dans ce navigateur\u00a0: rien n’est envoyé nulle part.')).toBeVisible();
    // The steps in French words, the page's texts as they are.
    await expect(review.locator('.step').first()).toContainText(/^1\s*Ouvrir /);
    await expect(review.locator('.step.marked')).toContainText('devrait afficher «\u202fTotal: 45\u202f»');
    expect(await clippedInShadows(page)).toEqual([]);

    // The report is written in French; the failing test is the one an English report makes.
    await review.getByRole('button', { name: 'Copier le rapport' }).click();
    await expect.poll(() => readClipboard(page)).toContain('## Étapes pour reproduire');
    const markdown = await readClipboard(page);
    expect(markdown).toContain('devrait afficher «\u202fTotal: 45\u202f»');
    expect(markdown).toContain('   - Résultat\u00a0: «\u202fTotal: 50\u202f»');
    expect(markdown).toContain('## Attendu et constaté');
    expect(markdown).toMatch(/^Aucune capture d’écran\u00a0: Chrome ne laisse Piwi Picker/m);
    expect(markdown).not.toContain(' should ');
    await review.getByRole('button', { name: 'Copier le test en échec' }).click();
    await expect.poll(() => readClipboard(page)).toContain('test.fail();');
    const spec = await readClipboard(page);
    expect(spec).toContain(
      `await expect(page.getByTestId('cart-total')).toHaveText('Total: 45'); // recorded: 'Total: 50'`,
    );
    expect(spec).toMatch(/test\('bug: bug on \/cart'/);
  });

  test('in German: the HUD, the dialogs and the finished report lay out without clipping', async ({ context }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: false }, { language: 'de' });
    const dialog = page.locator('#piwi-bug-dialog-host');
    await expect.poll(() => panelLang(page, 'piwi-record-hud-host', '.bar')).toBe('de');
    expect(await clippedInShadows(page)).toEqual([]);

    await pressHudButton(page, 'missing');
    await expect.poll(() => panelLang(page, 'piwi-bug-dialog-host', '.panel')).toBe('de');
    expect(await clippedInShadows(page)).toEqual([]);
    await page.keyboard.type('Apply');
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);

    await pressHudButton(page, 'mark');
    await page.hover('#total');
    await page.click('#total');
    await expect.poll(() => panelLang(page, 'piwi-bug-dialog-host', '.panel')).toBe('de');
    expect(await clippedInShadows(page)).toEqual([]);
    await page.keyboard.type('Total: 45');
    await page.keyboard.press('Enter');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);
    await expect(page.locator('#piwi-record-hud-host').getByText('Total: 50', { exact: false })).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);

    await pressHudButton(page, 'finish');
    await expect.poll(() => panelLang(page, 'piwi-record-review-host', '.panel')).toBe('de');
    await expect(page.locator('#piwi-record-review-host .step.marked')).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('in the real extension without the debugging protocol: the main-world script is registered for the recording, relays across worlds, and no screenshot is taken without activeTab', async () => {
    // A copy of the build whose manifest grants the shop's origin: what the
    // popup's per-origin request grants, which a test cannot click through.
    // Without `debugger`, as in Firefox: the evidence comes from the page.
    const dir = mkdtempSync(path.join(tmpdir(), 'piwi-picker-bug-'));
    cpSync(DIST, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.host_permissions = [`${SHOP_ORIGIN}/*`];
    manifest.permissions = manifest.permissions.filter((p: string) => p !== 'debugger');
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const context = await launchWithExtension(dir);
    try {
      await routeShop(context, { fixed: false });
      const worker = await extensionWorker(context);
      const extensionId = worker.url().split('/')[2]!;
      const page = await context.newPage();
      await page.goto(`${SHOP_ORIGIN}/cart`);
      const tabId = await worker.evaluate(
        async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0]!.id!,
        SHOP_ORIGIN,
      );

      // The popup's start message, sent from an extension page.
      const extensionPage = await context.newPage();
      await openOptions(extensionPage, extensionId);
      const started = await extensionPage.evaluate(
        ({ origin, tab }) =>
          chrome.runtime.sendMessage({
            type: 'piwi-start-recording',
            originPattern: `${origin}/*`,
            tabId: tab,
            mode: 'bug',
          }),
        { origin: SHOP_ORIGIN, tab: tabId },
      );
      expect(started).toEqual({ ok: true });
      await extensionPage.close();
      await page.bringToFront();

      const registered = () =>
        worker.evaluate(async () =>
          (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({
            id: s.id,
            world: s.world ?? 'ISOLATED',
          })),
        );
      expect(await registered()).toEqual(
        expect.arrayContaining([
          { id: 'piwi-bug-evidence', world: 'MAIN' },
          { id: 'piwi-record-panel', world: 'ISOLATED' },
        ]),
      );
      await expect.poll(() => hostPresent(page, 'piwi-record-hud-host')).toBe(true);
      expect(await page.evaluate(() => (globalThis as any).__piwiBugEvidenceInstalled)).toBe(true);

      const storedEvidence = (): Promise<Record<string, any>> =>
        worker.evaluate(async () => (await chrome.storage.session.get('piwiBugEvidence')).piwiBugEvidence ?? {});
      await page.fill('#coupon', 'SPRING10');
      await page.getByRole('button', { name: 'Apply' }).click();
      await expect.poll(async () => (await storedEvidence()).requests?.length ?? 0).toBe(1);
      await expect.poll(async () => (await storedEvidence()).console?.length ?? 0).toBe(1);

      // The registrations re-attach both scripts on the next page.
      await page.getByRole('link', { name: 'Checkout' }).click();
      await page.waitForURL('**/checkout');
      await expect.poll(() => hostPresent(page, 'piwi-record-hud-host')).toBe(true);
      await expect.poll(async () => (await storedEvidence()).console?.length ?? 0).toBe(2);

      await pressHudButton(page, 'finish');
      await expect.poll(() => hostPresent(page, 'piwi-record-review-host')).toBe(true);
      const evidence = await storedEvidence();
      expect(evidence.screenshotNote).toContain('only after you open it on this tab');
      expect(
        await worker.evaluate(
          async () => (await chrome.storage.session.get('piwiBugScreenshots')).piwiBugScreenshots ?? [],
        ),
      ).toEqual([]);
      expect(evidence.console.map((e: { message: string }) => e.message)).toEqual([
        'Coupon failed: 500',
        'Checkout: total not recomputed',
      ]);
      expect(evidence.requests[0]).toMatchObject({
        method: 'POST',
        url: '/api/cart/coupon?code=%3Credacted%3E',
        status: 500,
      });
      await expect.poll(registered).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('keeps the viewport the steps were played at, and the size a resize settles at, in the failing test', async ({
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: true });
    const start = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.fill('#coupon', 'SPRING10');
    // A drag through sizes records where it ends only.
    await page.setViewportSize({ width: 500, height: 700 });
    await page.setViewportSize({ width: 390, height: 664 });
    const sizes = async () =>
      (await readStoredEvents(page)).filter((e) => e.kind === 'viewport').map((e) => e.viewport);
    await expect.poll(sizes).toEqual([start, { width: 390, height: 664 }]);
    await page.getByRole('button', { name: 'Apply' }).click();
    // The next page has the same size: nothing more is kept.
    await page.getByRole('link', { name: 'Checkout' }).click();
    await page.waitForURL('**/checkout');
    await attachRecorder(page);
    expect(await sizes()).toHaveLength(2);

    await pressHudButton(page, 'finish');
    await expect.poll(() => hostPresent(page, 'piwi-record-review-host')).toBe(true);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect.poll(() => readClipboard(page)).toContain('test.fail();');
    const spec = await readClipboard(page);
    expect(spec).toContain(
      `  await page.setViewportSize({ width: ${start.width}, height: ${start.height} });\n  await page.goto('/cart');`,
    );
    expect(spec).toMatch(
      /setViewportSize\(\{ width: 390, height: 664 \}\);\n {2}await page\.getByRole\('button', \{ name: 'Apply' \}\)\.click\(\);/,
    );
  });

  test('a password shown in clear stays out of Mark what’s wrong and of the outline, as a card number does', async ({
    context,
  }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    await routeLogin(context);
    const page = await startBugRecording(context, { ok: true }, { path: '/login' });
    await page.locator('#pw').click();
    await page.keyboard.type('s3cr');
    await page.locator('#show').click();
    await page.locator('#pw').click();
    await page.keyboard.type('et!');

    await pressHudButton(page, 'mark');
    await page.hover('#pw');
    await page.click('#pw');
    const dialog = page.locator('#piwi-bug-dialog-host').getByRole('dialog', { name: 'Mark what’s wrong' });
    await expect(dialog).toBeVisible();
    // Its states only: no value, text or name, so what it holds is never shown or kept.
    await expect(dialog.getByRole('option')).toHaveText(['It should be hidden', 'It should be grayed out, not usable']);
    await expect(dialog.getByText('What it should show')).toBeHidden();
    await expect(dialog).not.toContainText('s3cr');
    await dialog.getByRole('button', { name: 'Add to the report' }).click();
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);
    await expect.poll(() => screenshotCount(page)).toBe(1);

    const events = await readStoredEvents(page);
    expect(events.find((e) => e.kind === 'assert')?.assertion).toMatchObject({
      matcher: 'toBeHidden',
      expected: null,
      actual: 'visible',
    });
    const outline = (await readEvidence(page)).outline as string;
    expect(outline).toContain('- textbox "User": ana');
    expect(outline).toContain('- textbox "Password"\n');
    expect(outline).toContain('- textbox "Card number"');
    for (const secret of ['s3cr', 'et!', '4111']) {
      expect(outline).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(secret);
    }
  });

  test('the HUD and the border are in no screenshot, even redrawn during one, and come back once the last ends', async ({
    context,
  }) => {
    test.setTimeout(60_000);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(
      context,
      { ok: true },
      { init: (c) => slowMessages(c, { 'piwi-bug-screenshot': 1000, 'piwi-bug-step-view': 800 }) },
    );
    // The view of the first step is taken as the page is reached, with the surfaces hidden.
    await expect.poll(() => visibility(page, 'piwi-record-hud-host')).toBe('visible');
    // The HUD redraws while the screenshot of a mark is taken: an evidence entry has come in.
    await pressHudButton(page, 'mark');
    await page.hover('#total');
    await page.click('#total');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
    await page.keyboard.type('Total: 45');
    await page.keyboard.press('Enter');
    await expect.poll(() => inFlight(page, 'piwi-bug-screenshot')).toBe(1);
    await page.evaluate(() => console.error('Late failure'));
    await expect.poll(() => screenshotCount(page)).toBe(1);
    expect(await shownInScreenshots(page)).toEqual([]);

    // A screenshot from the popup while the view of the next step is taken: both hide the surfaces.
    await page.locator('#coupon').click();
    await expect.poll(() => inFlight(page, 'piwi-bug-step-view')).toBe(1);
    await dispatchRuntimeMessage(page, { type: 'piwi-bug-take-screenshot' });
    await expect.poll(() => screenshotCount(page)).toBe(2);
    expect(await shownInScreenshots(page)).toEqual([]);
    await expect.poll(() => visibility(page, 'piwi-record-frame-host')).toBe('visible');
    await expect.poll(() => visibility(page, 'piwi-record-hud-host')).toBe('visible');

    // The HUD redraws while the screenshot of Finish is taken.
    await pressHudButton(page, 'finish');
    await expect.poll(() => inFlight(page, 'piwi-bug-screenshot')).toBe(1);
    await page.evaluate(() => console.error('Failure at the end'));
    await expect.poll(() => hostPresent(page, 'piwi-record-review-host'), { timeout: 10_000 }).toBe(true);
    expect(await shownInScreenshots(page)).toEqual([]);
  });

  test('a screenshot session storage has no room for leaves a note, and Finish still finishes', async ({ context }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(
      context,
      { ok: true },
      {
        // Session storage with no room for a screenshot.
        init: async (c) => {
          await c.addInitScript(() => {
            const session = (globalThis as any).chrome.storage.session;
            const set = session.set;
            session.set = async (values: Record<string, unknown>) => {
              if ('piwiBugScreenshots' in values) throw new Error('Session storage quota bytes exceeded.');
              return set(values);
            };
          });
        },
      },
    );
    await pressHudButton(page, 'wrongPage');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('/cart/discounted');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await readStoredEvents(page)).filter((e) => e.kind === 'assert').length).toBe(1);
    await page.waitForTimeout(500);

    await pressHudButton(page, 'finish');
    await expect.poll(() => hostPresent(page, 'piwi-record-review-host')).toBe(true);
    expect(await hostPresent(page, 'piwi-record-hud-host')).toBe(false);
    await expect(
      page
        .locator('#piwi-record-review-host')
        .getByText('No screenshot: The screenshot was too large to keep in this browser’s storage.'),
    ).toBeVisible();
    expect((await readEvidence(page)).context).toMatchObject({ path: '/cart' });
  });

  test('two screenshots taken at once are both kept', async ({ context }) => {
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(
      context,
      { ok: true },
      {
        // Reading the screenshots takes a while, as reading session storage does in the browser.
        init: async (c) => {
          await c.addInitScript(() => {
            const session = (globalThis as any).chrome.storage.session;
            const get = session.get;
            session.get = async (key: string) => {
              const value = await get(key);
              if (key === 'piwiBugScreenshots') await new Promise((resolve) => setTimeout(resolve, 100));
              return value;
            };
          });
        },
      },
    );
    await dispatchRuntimeMessage(page, { type: 'piwi-bug-take-screenshot' }, { type: 'piwi-bug-take-screenshot' });
    await expect.poll(() => screenshotCount(page)).toBe(2);
    expect((await readEvidence(page)).screenshots).toBe(2);
  });

  test('the evidence line counts a mark’s screenshot once it is stored, and says why when there is none', async ({
    context,
  }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    // The screenshot comes well after the mark's step has redrawn the bar.
    const page = await startBugRecording(
      context,
      { ok: true },
      { init: (c) => slowMessages(c, { 'piwi-bug-screenshot': 800 }) },
    );
    const evidence = page.locator('#piwi-record-hud-host .evidence').first();
    await expect(evidence).toHaveText(/^no screenshot/);
    await pressHudButton(page, 'wrongPage');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('/cart/discounted');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await readStoredEvents(page)).filter((e) => e.kind === 'assert').length).toBe(1);
    await expect.poll(() => inFlight(page, 'piwi-bug-screenshot')).toBe(1);
    await expect(evidence).toHaveText(/^no screenshot/);
    await expect(evidence).toHaveText(/^1 screenshot/);
    await expect.poll(() => screenshotCount(page)).toBe(1);
  });

  test('a screenshot that fails says why on the bar at once', async ({ context }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: false, reason: 'not-in-front' });
    const hud = page.locator('#piwi-record-hud-host');
    await page.waitForTimeout(300);
    await expect(hud.getByText('The tab was not the one in front', { exact: false })).toHaveCount(0);
    await dispatchRuntimeMessage(page, { type: 'piwi-bug-take-screenshot' });
    await expect(hud.getByText('The tab was not the one in front', { exact: false })).toBeVisible();
  });

  test('the bar is a labelled region, and its dot pulses only when motion is welcome', async ({ context }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: true });
    const hud = page.locator('#piwi-record-hud-host');
    await expect(hud.getByRole('region', { name: 'Piwi Picker bug report' })).toBeVisible();
    const dotAnimation = () =>
      page.evaluate(
        () =>
          getComputedStyle(document.getElementById('piwi-record-hud-host')!.shadowRoot!.querySelector('.dot')!)
            .animationName,
      );
    expect(await dotAnimation()).toBe('pulse');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await dotAnimation()).toBe('none');
  });

  test('an evidence entry updates the HUD in place: the focus stays on its button', async ({ context }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: true });
    await page.waitForTimeout(1000);
    await page.focus('#piwi-record-hud-host');
    await page.evaluate(() => {
      (document.getElementById('piwi-record-hud-host') as HTMLElement & { __same?: boolean }).__same = true;
      console.error('While the HUD has focus');
    });
    await expect(page.locator('#piwi-record-hud-host').getByText('1 console error')).toBeVisible();
    expect(
      await page.evaluate(
        () => (document.getElementById('piwi-record-hud-host') as { __same?: boolean } | null)?.__same,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('piwi-record-hud-host');
  });

  test('a redraw of the HUD keeps the focus on the button it was on, and Tab goes on from there', async ({
    context,
  }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: true });
    await page.waitForTimeout(1000);
    await page.focus('#piwi-record-hud-host');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const focusedButton = () =>
      page.evaluate(() => document.getElementById('piwi-record-hud-host')?.shadowRoot?.activeElement?.textContent);
    expect(await focusedButton()).toBe('Wrong page');
    await page.evaluate(() => {
      (document.getElementById('piwi-record-hud-host') as HTMLElement & { __same?: boolean }).__same = true;
    });
    // Injected again into a page it already records, the recorder draws its HUD again.
    await attachRecorder(page);
    await expect
      .poll(() =>
        page.evaluate(() => (document.getElementById('piwi-record-hud-host') as { __same?: boolean } | null)?.__same),
      )
      .toBeUndefined();
    expect(await focusedButton()).toBe('Wrong page');
    await page.keyboard.press('Tab');
    expect(await focusedButton()).toBe('Finish');
  });

  test('a dialog the page removes is cancelled: capture goes on, and the page has its Escape back', async ({
    context,
  }) => {
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: true });
    await pressHudButton(page, 'missing');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
    await page.evaluate(() => {
      const g = globalThis as { __escapes?: number };
      g.__escapes = 0;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') g.__escapes!++;
      });
      document.getElementById('piwi-bug-dialog-host')!.remove();
    });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (globalThis as { __escapes?: number }).__escapes)).toBe(1);
    await page.fill('#coupon', 'X1');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect
      .poll(async () => (await readStoredEvents(page)).map((e) => e.kind))
      .toEqual(['viewport', 'navigate', 'keydown', 'input', 'click']);
    // Another way to mark what is wrong opens.
    await pressHudButton(page, 'wrongPage');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
  });

  test('a stop during Mark’s pick takes the pick down', async ({ context }) => {
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: true });
    await pressHudButton(page, 'mark');
    await expect(page.getByText('click any element to generate locators')).toBeVisible();
    await dispatchRuntimeMessage(page, { type: 'piwi-recording-stopped' });
    await expect(page.getByText('click any element to generate locators')).toBeHidden();
    await page.click('#total');
    await page.waitForTimeout(300);
    expect(await hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);
  });

  test('a Pick started during Mark’s pick leaves it be, and picks once it is over', async ({ context }) => {
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(context, { ok: true });
    await pressHudButton(page, 'mark');
    const overlay = page.getByText('click any element to generate locators');
    await expect(overlay).toBeVisible();
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await page.hover('#total');
    await page.click('#total');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
    await page.waitForTimeout(500);
    expect(await hostPresent(page, 'piwi-picker-results-host')).toBe(false);
    await page.keyboard.press('Escape');
    await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);

    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect(overlay).toBeVisible();
    await page.hover('#total');
    await page.click('#total');
    await page.waitForTimeout(500);
    expect(await hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);
  });

  for (const [reason, note] of [
    ['not-in-front', 'The tab was not the one in front, and the browser captures only the tab on screen.'],
    ['failed', 'The browser could not take the screenshot.'],
  ] as const) {
    test(`the note says why there is no screenshot: ${reason}`, async ({ context }) => {
      await routeShop(context, { fixed: false });
      const page = await startBugRecording(context, { ok: false, reason });
      await dispatchRuntimeMessage(page, { type: 'piwi-bug-take-screenshot' });
      await expect.poll(async () => (await readEvidence(page)).screenshotNote ?? null).toBe(note);
      await expect(page.locator('#piwi-record-hud-host')).toBeAttached();
    });
  }

  test('in Firefox, the note on the grant a screenshot needs names Firefox', async ({ context }) => {
    await routeShop(context, { fixed: false });
    const page = await startBugRecording(
      context,
      { ok: false },
      {
        init: async (c) => {
          await c.addInitScript(() => {
            Object.defineProperty(navigator, 'userAgent', {
              get: () => 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
            });
          });
        },
      },
    );
    await dispatchRuntimeMessage(page, { type: 'piwi-bug-take-screenshot' });
    await expect
      .poll(async () => (await readEvidence(page)).screenshotNote ?? null)
      .toBe(
        'Firefox lets Piwi Picker take a screenshot only after you open it on this tab. Open Piwi Picker and choose Take a screenshot.',
      );
  });

  test('the outline has roles, names, states and values, never a password, and stops at 400 lines', async ({
    context,
  }) => {
    const page = await context.newPage();
    const rows = Array.from({ length: 450 }, (_, i) => `<li><a href="/p/${i}">Product ${i}</a></li>`).join('');
    await page.setContent(`<!doctype html><html><body>
      <nav aria-label="Main"><a href="/">Home</a></nav>
      <main>
        <h2>Sign in</h2>
        <label>Email <input type="email" value="ana@acme.test"></label>
        <label>Password <input type="password" value="hunter2"></label>
        <label><input type="checkbox" checked> Remember me</label>
        <button disabled>Continue</button>
        <p style="display:none">Hidden hint</p>
        <div><span>Plain</span> <b>text</b></div>
      </main>
      <section aria-label="Catalog"><ul>${rows}</ul></section>
    </body></html>`);
    await page.addScriptTag({ path: await engineBundle() });
    const outline = (selector?: string, max?: number) =>
      page.evaluate(([s, m]) => (globalThis as any).__piwiBuildOutline(s, m) as string, [selector, max] as const);

    expect(await outline('main')).toBe(
      [
        '- main:',
        '  - heading "Sign in" [level=2]',
        '  - text: Email',
        '  - textbox "Email": "ana@acme.test"',
        '  - text: Password',
        '  - textbox "Password"',
        '  - checkbox "Remember me" [checked]',
        '  - text: Remember me',
        '  - button "Continue" [disabled]',
        '  - text: Plain text',
      ].join('\n'),
    );
    const whole = (await outline()).split('\n');
    expect(whole).toHaveLength(400);
    expect(whole[0]).toBe('- navigation "Main":');
    expect(whole[399]).toBe('- text: "… outline cut at 400 lines"');
    expect(whole.join('\n')).not.toContain('hunter2');
  });
});

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type BrowserContext, type Frame, type Page } from '@playwright/test';
import {
  IDE_CHROME_GLOBAL,
  IDE_DISPATCH_GLOBAL,
  IDE_RECORDER_BINDING,
  IDE_SETTINGS_KEY,
  type IdeRecorderRequest,
  type IdeRecorderSettings,
} from '@piwitests/core/ide-recorder';
import { normalizeSteps, parseCaptureEvent, type RawCaptureEvent } from '@piwitests/core/recording';
import type { RawCatalog } from '../../src/shared/i18n.js';
import { buildIdeBundle } from '../../scripts/build.mjs';
import { openShadowRoots } from './shadow.js';

/**
 * The IDE bundle in a plain browser, as the editor service's launcher runs it:
 * the binding exposed in every page and answered here as the launcher answers
 * it, the bundle loaded into every document, and Playwright's own input across
 * two pages of a site.
 */

const ORIGIN = 'https://shop.record-ide.test';
const BUNDLE_DIR = mkdtempSync(path.join(tmpdir(), 'piwi-record-ide-'));

/** An already-installed Chromium to use instead of the revision Playwright pins, as `fixtures.ts` does. */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim() || '';
test.use({ launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {} });

test.beforeAll(() => buildIdeBundle({ outDir: BUNDLE_DIR }));

const PAGES: Record<string, string> = {
  '/': `<!doctype html><html><body>
    <input aria-label="Search" />
    <button data-test="add-to-cart">Add to cart</button>
    <iframe src="/promo" title="Promo"></iframe>
    <a href="/checkout">Checkout</a>
  </body></html>`,
  '/promo': `<!doctype html><html><body><button>Claim coupon</button></body></html>`,
  '/checkout': `<!doctype html><html><body>
    <label>Coupon <input /></label>
    <button data-testid="pay-later">Pay later</button>
    <button data-test="place-order">Place order</button>
  </body></html>`,
};

type Area = Record<string, unknown>;
type LocalKeys = Extract<IdeRecorderRequest, { kind: 'local-get' }>['keys'];

/** What `chrome.storage.local.get(keys)` answers from `area`. */
function pick(area: Area, keys: LocalKeys): Area {
  if (keys == null) return { ...area };
  if (typeof keys === 'string') return keys in area ? { [keys]: area[keys] } : {};
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in area).map((key) => [key, area[key]]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, key in area ? area[key] : fallback]));
}

interface RecordingState {
  active: boolean;
  events: RawCaptureEvent[];
  paused?: boolean;
}

interface Message {
  type?: string;
  paused?: boolean;
  op?: string;
  key?: string;
  items?: Area;
  event?: unknown;
}

/**
 * The launcher's side of the binding: `chrome.storage.local` seeded with the
 * English catalog and `settings`, the recording's session storage, and an
 * answer to each message the recorder sends; with what it heard.
 */
function createLauncher(settings: IdeRecorderSettings) {
  const catalogs = JSON.parse(readFileSync(path.join(BUNDLE_DIR, 'record-ide-messages.json'), 'utf8')) as Record<
    string,
    RawCatalog
  >;
  const local: Area = { piwiLanguage: { code: 'en', messages: catalogs.en }, [IDE_SETTINGS_KEY]: settings };
  const session: Area = {
    piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: null, mode: 'actions' },
  };
  const heard = { messages: [] as Message[], frames: [] as string[] };
  const recording = () => session.piwiRecording as RecordingState;

  const answer = (message: Message): unknown => {
    switch (message.type) {
      case 'piwi-ping':
        return { ok: true };
      case 'piwi-session-storage':
        if (message.op === 'get') return { ok: true, items: pick(session, message.key ?? null) };
        if (message.op === 'set') Object.assign(session, message.items);
        else if (message.op === 'remove') delete session[message.key ?? ''];
        return { ok: true };
      case 'piwi-append-recording-event': {
        const event = parseCaptureEvent(message.event);
        if (!event) return { ok: false, error: 'Malformed recording event.' };
        if (recording().active) recording().events.push(event);
        return { ok: true, state: recording() };
      }
      case 'piwi-recording-stopped':
        return { ok: true };
      case 'piwi-recording-paused':
        recording().paused = message.paused === true;
        return { ok: true };
      case 'piwi-tab-zoom':
        return { zoom: 1 };
      default:
        return { ok: false, error: 'Not available in a recording started from the editor.' };
    }
  };

  const handle = ({ frame }: { frame: Frame }, request: IdeRecorderRequest): unknown => {
    heard.frames.push(frame.url());
    switch (request.kind) {
      case 'local-get':
        return pick(local, request.keys);
      case 'local-set':
        Object.assign(local, request.items);
        return undefined;
      case 'local-remove':
        for (const key of [request.keys].flat()) delete local[key];
        return undefined;
      case 'message':
        heard.messages.push(request.message as Message);
        return answer(request.message as Message);
    }
  };

  return { heard, recording, handle };
}

/**
 * Serves the site's pages, each with a `chrome` of its own, as Chrome gives
 * every page (the headless shell gives none), kept as it is before any other
 * script runs.
 */
async function servePages(context: BrowserContext): Promise<void> {
  await context.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: PAGES[new URL(route.request().url()).pathname] ?? '' }),
  );
  await context.addInitScript(() => {
    const g = window as unknown as Record<string, unknown>;
    g.chrome ??= { app: { isInstalled: false } };
    g.__pageChromeAtStart = g.chrome;
    g.__pageChromeKeysAtStart = Object.getOwnPropertyNames(g.chrome).sort();
  });
}

/** The page's `chrome` now and as it was before any other script ran. */
function pageChrome(page: Page) {
  return page.evaluate(() => {
    const g = window as unknown as Record<string, unknown>;
    return {
      same: g.chrome === g.__pageChromeAtStart,
      keys: Object.getOwnPropertyNames(g.chrome).sort(),
      keysAtStart: g.__pageChromeKeysAtStart,
    };
  });
}

/** A context as the launcher sets it up: its binding first, then the bundle in every document. */
async function launch(context: BrowserContext, settings: IdeRecorderSettings) {
  const launcher = createLauncher(settings);
  await servePages(context);
  await openShadowRoots(context);
  await context.exposeBinding(IDE_RECORDER_BINDING, (source, request: IdeRecorderRequest) =>
    launcher.handle(source, request),
  );
  await context.addInitScript({ path: path.join(BUNDLE_DIR, 'record-ide.js') });
  return launcher;
}

const hud = (page: Page) => page.locator('#piwi-record-hud-host');

test('records real input across two pages through the launcher’s binding, in the top-level document only', async ({
  context,
}) => {
  const launcher = await launch(context, { file: 'checkout.spec.ts', testIdAttribute: 'data-test' });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await expect(hud(page).getByText('Recording into checkout.spec.ts: 1 step')).toBeVisible();
  await expect(page.locator('#piwi-record-frame-host')).toBeAttached();

  await page.getByRole('textbox', { name: 'Search' }).fill('red shoes');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  // A frame's document loads the bundle too, and records nothing.
  const promo = page.frame({ url: `${ORIGIN}/promo` })!;
  await promo.getByRole('button', { name: 'Claim coupon' }).click();
  expect(await promo.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(false);

  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.waitForURL(`${ORIGIN}/checkout`);
  await expect(hud(page)).toBeAttached();
  await page.getByRole('textbox', { name: 'Coupon' }).fill('SPRING10');
  await page.getByRole('button', { name: 'Pay later' }).click();
  await page.getByRole('button', { name: 'Place order' }).click();

  await expect.poll(() => normalizeSteps(launcher.recording().events).length).toBe(7);
  const steps = normalizeSteps(launcher.recording().events);
  expect(steps.map((s) => s.action)).toEqual(['goto', 'fill', 'click', 'click', 'fill', 'click', 'click']);
  const [goto, search, addToCart, checkout, coupon, payLater, placeOrder] = steps;
  expect(goto).toMatchObject({ value: `${ORIGIN}/` });
  expect(search).toMatchObject({ value: 'red shoes' });
  expect(checkout!.target?.accessibleName).toBe('Checkout');
  expect(coupon).toMatchObject({ value: 'SPRING10', pageUrl: `${ORIGIN}/checkout` });
  // Every event came through the binding, from the top-level document of each page: not from the frame, nor from
  // the new page's `about:blank`, which loads the bundle too.
  const appends = launcher.heard.messages.filter((m) => m.type === 'piwi-append-recording-event');
  expect(appends).toHaveLength(launcher.recording().events.length);
  expect(new Set(launcher.heard.frames)).toEqual(new Set([`${ORIGIN}/`, `${ORIGIN}/checkout`]));
  expect(launcher.recording().events.some((e) => e.target?.accessibleName === 'Claim coupon')).toBe(false);

  // The project's test id attribute names the elements carrying it; `data-testid` is any other attribute there.
  expect(addToCart!.target).toMatchObject({ testId: 'add-to-cart' });
  expect(addToCart!.target?.alternatives[0]?.locator).toBe(`getByTestId('add-to-cart')`);
  expect(placeOrder!.target?.alternatives[0]?.locator).toBe(`getByTestId('place-order')`);
  expect(payLater!.target?.testId).toBeNull();
  expect(payLater!.target?.alternatives.map((a) => a.locator)).toEqual(
    expect.not.arrayContaining([expect.stringContaining('getByTestId')]),
  );

  await expect(hud(page).getByText('Recording into checkout.spec.ts: 7 steps')).toBeVisible();

  // Stop in the browser: the launcher hears it, capture ends, and no review opens, the steps being in the editor.
  await hud(page).getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => launcher.heard.messages.some((m) => m.type === 'piwi-recording-stopped')).toBe(true);
  await expect(hud(page)).toHaveCount(0);
  await expect(page.locator('#piwi-record-frame-host')).toHaveCount(0);
  expect(launcher.recording().active).toBe(false);
  const recorded = launcher.recording().events.length;
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.waitForTimeout(300);
  await expect(page.locator('#piwi-record-review-host')).toHaveCount(0);
  expect(launcher.recording().events).toHaveLength(recorded);

  const chrome = await pageChrome(page);
  expect(chrome.same).toBe(true);
  expect(chrome.keys).toEqual(chrome.keysAtStart);
});

test('Pause in the bar stops the recording until Resume, and the editor’s Pause shows there, on every page', async ({
  context,
}) => {
  const launcher = await launch(context, { file: 'checkout.spec.ts', testIdAttribute: null });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await expect(hud(page).getByText('Recording into checkout.spec.ts: 1 step')).toBeVisible();

  // Paused in the bar: the launcher hears it, and what is done meanwhile is not recorded.
  await hud(page).getByRole('button', { name: 'Pause' }).click();
  await expect.poll(() => launcher.recording().paused).toBe(true);
  expect(launcher.heard.messages).toContainEqual({ type: 'piwi-recording-paused', paused: true });
  await expect(hud(page).getByText('Paused: what you do here is not recorded until you resume.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search' }).fill('red shoes');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.waitForTimeout(300);
  expect(normalizeSteps(launcher.recording().events)).toHaveLength(1);

  // Still paused on the next page, as the recording says.
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.waitForURL(`${ORIGIN}/checkout`);
  await expect(hud(page).getByRole('button', { name: 'Resume' })).toBeVisible();
  await hud(page).getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => launcher.recording().paused).toBe(false);
  await page.getByRole('button', { name: 'Pay later' }).click();
  await expect.poll(() => normalizeSteps(launcher.recording().events).length).toBe(2);

  // The editor's Pause, handed to the page through the host, shows in the bar and stops capture there too.
  launcher.recording().paused = true;
  await page.evaluate((name) => {
    const dispatch = (globalThis as unknown as Record<string, (m: unknown) => void>)[name]!;
    dispatch({ type: 'piwi-recording-paused', paused: true });
  }, IDE_DISPATCH_GLOBAL);
  await expect(hud(page).getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.waitForTimeout(300);
  expect(normalizeSteps(launcher.recording().events)).toHaveLength(2);
});

test('Check an element and Check the address add checks of what the page shows, and the pick records nothing', async ({
  context,
}) => {
  const launcher = await launch(context, { file: 'checkout.spec.ts', testIdAttribute: 'data-test' });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await expect(hud(page).getByText('Recording into checkout.spec.ts: 1 step')).toBeVisible();
  const dialog = page.locator('#piwi-bug-dialog-host');

  // A button's short text is offered first, filled with what it shows.
  await hud(page).getByRole('button', { name: 'Check an element' }).click();
  await page.hover('[data-test="add-to-cart"]');
  await page.click('[data-test="add-to-cart"]');
  await expect(dialog.getByRole('dialog', { name: 'Check an element' })).toBeVisible();
  await expect(dialog.getByText("Element: getByTestId('add-to-cart')")).toBeVisible();
  const what = dialog.getByRole('combobox', { name: 'What to check' });
  await expect(what.locator('option')).toHaveText([
    'Its text',
    'Its name, as screen readers announce it',
    'It is visible',
    'It is usable, not grayed out',
  ]);
  await expect(dialog.getByRole('textbox', { name: 'Expected' })).toHaveValue('Add to cart');
  await dialog.getByRole('button', { name: 'Add the check' }).click();
  await expect(dialog).toHaveCount(0);

  // A state takes no value.
  await hud(page).getByRole('button', { name: 'Check an element' }).click();
  await page.hover('input[aria-label="Search"]');
  await page.click('input[aria-label="Search"]');
  await expect(dialog.getByRole('combobox', { name: 'What to check' })).toHaveValue('0');
  await expect(dialog.getByRole('textbox', { name: 'Expected' })).toBeHidden();
  await dialog.getByRole('button', { name: 'Add the check' }).click();
  await expect(dialog).toHaveCount(0);

  // The address starts from the page's own, and an empty one is refused.
  await hud(page).getByRole('button', { name: 'Check the address' }).click();
  const address = dialog.getByRole('textbox', { name: 'The address the page should be on' });
  await expect(address).toHaveValue('/');
  await address.fill('');
  await dialog.getByRole('button', { name: 'Add the check' }).click();
  await expect(dialog.getByText('Type the address the page should be on.')).toBeVisible();
  await address.fill('/?ref=home');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => normalizeSteps(launcher.recording().events).length).toBe(4);
  const [, text, visible, url] = normalizeSteps(launcher.recording().events);
  expect(text).toMatchObject({
    action: 'assert',
    target: { testId: 'add-to-cart' },
    assertion: { matcher: 'toHaveText', expected: 'Add to cart', actual: null, negated: false, note: null },
  });
  expect(visible).toMatchObject({ action: 'assert', assertion: { matcher: 'toBeVisible', expected: null } });
  expect(visible!.target?.accessibleName).toBe('Search');
  expect(url).toMatchObject({
    action: 'assert',
    target: null,
    assertion: { matcher: 'toHaveURL', expected: '/?ref=home' },
  });

  // Paused, nothing is recorded: no check either.
  await hud(page).getByRole('button', { name: 'Pause' }).click();
  await expect(hud(page).getByRole('button', { name: 'Check an element' })).toBeDisabled();
  await expect(hud(page).getByRole('button', { name: 'Check the address' })).toBeDisabled();
});

test('in its check mode, opens Check an element at once, adds the check alone and stops, with no bar', async ({
  context,
}) => {
  const launcher = await launch(context, { file: 'checkout.spec.ts', testIdAttribute: 'data-test', check: true });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/checkout`);
  const dialog = page.locator('#piwi-bug-dialog-host');
  // The pick is on as the page loads: what a click lands on is the element checked, and nothing else is recorded.
  await page.getByRole('textbox', { name: 'Coupon' }).fill('WELCOME10');
  await page.hover('[data-test="place-order"]');
  await page.click('[data-test="place-order"]');
  await expect(dialog.getByRole('dialog', { name: 'Check an element' })).toBeVisible();
  await expect(hud(page)).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'Expected' })).toHaveValue('Place order');
  await dialog.getByRole('button', { name: 'Add the check' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => launcher.heard.messages.some((m) => m.type === 'piwi-recording-stopped')).toBe(true);
  const steps = normalizeSteps(launcher.recording().events);
  expect(steps).toEqual([
    expect.objectContaining({
      action: 'assert',
      target: expect.objectContaining({ testId: 'place-order' }),
      assertion: { matcher: 'toHaveText', expected: 'Place order', actual: null, negated: false, note: null },
    }),
  ]);
  // A check runs once in a document: the bundle loaded again there starts none.
  await page.addScriptTag({ path: path.join(BUNDLE_DIR, 'record-ide.js') });
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
});

test('loaded into a page without the launcher’s binding, the bundle does nothing', async ({ context }) => {
  await servePages(context);
  await openShadowRoots(context);
  await context.addInitScript({ path: path.join(BUNDLE_DIR, 'record-ide.js') });
  const page = await context.newPage();
  const output: string[] = [];
  page.on('pageerror', (error) => output.push(error.message));
  page.on('console', (message) => output.push(message.text()));
  await page.goto(`${ORIGIN}/`);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.waitForTimeout(300);

  expect(output).toEqual([]);
  expect(await page.evaluate((name) => name in globalThis, IDE_CHROME_GLOBAL)).toBe(false);
  await expect(hud(page)).toHaveCount(0);
  await expect(page.locator('#piwi-record-frame-host')).toHaveCount(0);
  const chrome = await pageChrome(page);
  expect(chrome.same).toBe(true);
  expect(chrome.keys).toEqual(chrome.keysAtStart);
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { dispatchRuntimeMessage, readStoredEvents, setRecordingActive, stubChromeStorage } from './recording-stub.js';
import { stubChromeI18n } from './i18n-stub.js';
import { playwrightLocator } from './playwright-locator.js';
import { normalizeSteps, type RawCaptureEvent } from '@piwitests/core/recording';
import { renderSpec } from '@piwitests/core/codegen';
import { parseSteps, sessionFromSteps, type PiwiSteps } from '@piwitests/core/steps';
import type { TestFunctionEntry } from '@piwitests/core/function-match';
import { clippedInShadows, openShadowRoots } from './shadow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');
const ORIGIN = 'https://record-test.local';

const LOGIN_PAGE = `<!doctype html><html><body>
  <input id="username" data-testid="username-field" />
  <label><input type="checkbox" data-testid="remember-me" /> Remember me</label>
  <button id="submit" data-testid="login-submit" onclick="location.href='/dashboard'">Log in</button>
</body></html>`;

const DASHBOARD_PAGE = `<!doctype html><html><body>
  <button id="add" data-testid="add-to-cart">Add to cart</button>
</body></html>`;

/**
 * Two text inputs with nothing to tell them apart — no label, no placeholder,
 * no id the probe would use, no test id — plus a real submit button to press
 * Enter on. Both fields resolve to the same tag, role and (absent) accessible
 * name, and neither gets a locator alternative, since a bare role anchor needs
 * the role to be document-unique.
 */
const BARE_FORM_PAGE = `<!doctype html><html><body>
  <form onsubmit="return false">
    <input type="text" /><input type="text" />
    <button type="submit">Save</button>
  </form>
</body></html>`;

/** A link both in the sidebar and in the page, and a tab showing a count badge (not inline, as the dashboard's). */
const LINKS_PAGE = `<!doctype html><html><body>
  <nav><a href="#runs">Runs</a></nav>
  <main>
    <div role="tablist"><button role="tab" id="tab">Regressions<span style="display:inline-flex">5</span></button></div>
    <a href="#runs" id="runs">Runs</a>
  </main>
</body></html>`;

/** A search form whose submissions the page counts, without leaving it. */
const SEARCH_PAGE = `<!doctype html><html><body data-submits="0">
  <form onsubmit="event.preventDefault(); document.body.dataset.submits = Number(document.body.dataset.submits) + 1">
    <input name="q" aria-label="Search" />
    <button type="submit">Go</button>
  </form>
</body></html>`;

/** Fields inside the open shadow roots of custom elements: a password, a text field and a checkbox. */
const SHADOW_FIELDS_PAGE = `<!doctype html><html><body>
  <x-pass></x-pass>
  <x-profile></x-profile>
  <script>
    customElements.define('x-pass', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = '<label>Password <input type="password" /></label>';
      }
    });
    customElements.define('x-profile', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML =
          '<label>Name <input /></label><label><input type="checkbox" /> Subscribe</label>';
      }
    });
  </script>
</body></html>`;

/** A password field inside a closed shadow root, which the page's own script can focus. */
const CLOSED_SHADOW_PAGE = `<!doctype html><html><body>
  <x-secret></x-secret>
  <script>
    customElements.define('x-secret', class extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'closed' });
        root.innerHTML = '<label>Password <input type="password" /></label>';
        this.focusField = () => root.querySelector('input').focus();
      }
    });
  </script>
</body></html>`;

/** A file field, a row that opens on a double click, and a card dragged onto a column. */
const FILES_PAGE = `<!doctype html><html><body>
  <input type="file" data-testid="attachment" aria-label="Attachment" multiple />
  <div role="row" data-testid="invoice" ondblclick="this.dataset.open = 'yes'">Invoice 42</div>
  <div draggable="true" data-testid="card" ondragstart="event.dataTransfer.setData('text/plain', 'c')">Card</div>
  <section data-testid="done" aria-label="Done" ondragover="event.preventDefault()" ondrop="event.preventDefault()"
    style="height: 80px; border: 1px dashed">Done</section>
</body></html>`;

/** Password fields a button shows in clear, before or after typing, and fields whose autocomplete names a secret. */
const REVEAL_PAGE = `<!doctype html><html><body>
  <label>Password <input id="pw" type="password" /></label>
  <button id="show" type="button" onclick="pw.type = pw.type === 'password' ? 'text' : 'password'">Show password</button>
  <label>PIN <input id="pin" type="password" /></label>
  <button id="show-pin" type="button" onclick="pin.type = 'text'">Show PIN</button>
  <label>Card number <input id="card" autocomplete="cc-number" /></label>
  <label>Code <input id="otp" autocomplete="one-time-code" /></label>
  <label>Name <input id="name" /></label>
</body></html>`;

/** An editable note that takes plain text only, and a comment box editable by its bare attribute. */
const EDITABLE_PAGE = `<!doctype html><html><body>
  <div contenteditable="plaintext-only" aria-label="Note" data-testid="note"></div>
  <div contenteditable aria-label="Comment"><p>Looks <b>good</b> to me</p></div>
</body></html>`;

/** The pages by path; any other path is the login page. */
const PAGES: Record<string, string> = {
  '/editable': EDITABLE_PAGE,
  '/reveal': REVEAL_PAGE,
  '/dashboard': DASHBOARD_PAGE,
  '/bare': BARE_FORM_PAGE,
  '/links': LINKS_PAGE,
  '/files': FILES_PAGE,
  '/search': SEARCH_PAGE,
  '/shadow': SHADOW_FIELDS_PAGE,
  '/closed-shadow': CLOSED_SHADOW_PAGE,
};

async function routePages(context: BrowserContext): Promise<void> {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const body = PAGES[new URL(route.request().url()).pathname] ?? LOGIN_PAGE;
    await route.fulfill({ contentType: 'text/html', body });
  });
}

test.describe('record-panel.js', () => {
  test('captures steps across a real cross-page navigation', async ({ context }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });

    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    // A border around the viewport marks the tab as being captured, and must
    // survive a navigation the same way the HUD does.
    expect(await page.evaluate(() => !!document.getElementById('piwi-record-frame-host'))).toBe(true);
    expect(
      await page.evaluate(() => getComputedStyle(document.getElementById('piwi-record-frame-host')!).pointerEvents),
      'the border must never intercept a click the recorder should capture',
    ).toBe('none');

    await page.fill('#username', 'alice');
    // Blur commits the pending fill before the click navigates away.
    await page.click('#submit');

    await page.waitForURL('**/dashboard');
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    expect(await page.evaluate(() => !!document.getElementById('piwi-record-frame-host'))).toBe(true);
    await page.click('#add');

    await expect.poll(() => readStoredEvents(page).then((e) => e.length)).toBeGreaterThanOrEqual(4);

    const events = await readStoredEvents(page);
    const steps = normalizeSteps(events);
    expect(steps.map((s) => s.action)).toEqual(['goto', 'fill', 'click', 'click']);
    expect(steps[0]).toMatchObject({ value: `${ORIGIN}/login` });
    expect(steps[1]).toMatchObject({ value: 'alice' });
    expect(steps[2]!.target?.testId).toBe('login-submit');
    expect(steps[3]!.target?.testId).toBe('add-to-cart');
    // Both pages' events are present under one session — proof the recording survived the navigation.
    expect(new Set(events.map((e) => e.pageUrl)).size).toBeGreaterThanOrEqual(2);
  });

  test('records the name Playwright computes and ranks a repeated link as the other tools do', async ({ context }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/links`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);

    await page.click('#tab');
    await page.click('#runs');
    await expect.poll(() => readStoredEvents(page).then((e) => e.length)).toBeGreaterThanOrEqual(3);

    const [, tab, link] = normalizeSteps(await readStoredEvents(page));
    expect(tab!.target?.accessibleName).toBe('Regressions 5');
    expect(tab!.target?.alternatives[0]?.locator).toBe(`getByRole('tab', { name: 'Regressions 5' })`);
    // The name locator narrowed to main ranks above a name-less scoped one:
    // candidates are ranked after their match count is checked.
    expect(link!.target?.alternatives[0]?.locator).toBe(
      `getByRole('main').getByRole('link', { name: 'Runs', exact: true })`,
    );
    for (const alternative of link!.target!.alternatives) {
      await expect(playwrightLocator(page, alternative.locator), alternative.locator).toHaveId('runs');
    }
  });

  test('two indistinguishable fields record as two fills, and Enter does not double up with its own click', async ({
    context,
  }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });

    const page = await context.newPage();
    await page.goto(`${ORIGIN}/bare`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);

    const fields = page.locator('input[type="text"]');
    await fields.nth(0).fill('alice');
    await fields.nth(1).fill('smith');
    // Enter on a focused submit button fires keydown *and* a synthetic click.
    await page.locator('button[type="submit"]').focus();
    await page.keyboard.press('Enter');

    await expect.poll(() => readStoredEvents(page).then((e) => e.length)).toBeGreaterThanOrEqual(4);
    await page.waitForTimeout(200);

    const steps = normalizeSteps(await readStoredEvents(page));
    // Neither field's value may be absorbed into the other's, and the submit
    // must be activated once, not twice.
    expect(steps.map((s) => s.action)).toEqual(['goto', 'fill', 'fill', 'press']);
    expect(steps.filter((s) => s.action === 'fill').map((s) => s.value)).toEqual(['alice', 'smith']);
  });

  /** A live recording on `pathname`, the recorder attached. */
  async function recordingOn(context: BrowserContext, pathname: string): Promise<Page> {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}${pathname}`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    return page;
  }

  test('Enter in a form’s field submits once: the click it sends to the submit button is no step', async ({
    context,
  }) => {
    const page = await recordingOn(context, '/search');
    await page.getByLabel('Search').fill('shoes');
    await page.getByLabel('Search').press('Enter');
    // A click with the mouse, and Space on the focused button, each submit again.
    const go = page.getByRole('button', { name: 'Go' });
    await go.click();
    await go.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('body')).toHaveAttribute('data-submits', '3');

    await expect.poll(async () => normalizeSteps(await readStoredEvents(page)).length).toBeGreaterThanOrEqual(5);
    await page.waitForTimeout(200);
    const steps = normalizeSteps(await readStoredEvents(page));
    expect(steps.map((s) => [s.action, s.value, s.target?.accessibleName ?? null])).toEqual([
      ['goto', `${ORIGIN}/search`, null],
      ['fill', 'shoes', 'Search'],
      ['press', 'Enter', 'Search'],
      ['click', null, 'Go'],
      ['click', null, 'Go'],
    ]);
  });

  test('a page’s shortcuts are recorded, and typing, select-all, Tab and a checkbox’s own input are not', async ({
    context,
  }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });

    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);

    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.press('?');
    await page.locator('#username').click();
    await page.keyboard.type('abc');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await page.getByTestId('remember-me').click();

    await expect.poll(() => readStoredEvents(page).then((e) => e.length)).toBeGreaterThanOrEqual(8);
    await page.waitForTimeout(200);
    const steps = normalizeSteps(await readStoredEvents(page));
    expect(steps.map((s) => [s.action, s.value, s.target?.testId ?? null])).toEqual([
      ['goto', `${ORIGIN}/login`, null],
      // Ctrl on Windows and Linux, ⌘ on a Mac: the spec replays it on either.
      ['press', 'ControlOrMeta+k', null],
      ['press', '?', null],
      ['click', null, 'username-field'],
      ['fill', 'abc', 'username-field'],
      ['press', 'Escape', null],
      // A checkbox fires `input` as well as `change`: one step, never a fill.
      ['check', null, 'remember-me'],
    ]);
  });

  test('typing in an element that takes plain text only is no key press', async ({ context }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/editable`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    await page.getByTestId('note').click();
    await page.keyboard.type('ab');
    await expect.poll(() => readStoredEvents(page).then((e) => e.length)).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(200);
    expect(normalizeSteps(await readStoredEvents(page)).map((s) => s.action)).toEqual(['goto', 'click']);
  });

  test('a click inside an editable element is a click on the element', async ({ context }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/editable`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    await page.getByText('good').click();
    await expect.poll(() => readStoredEvents(page).then((e) => e.length)).toBeGreaterThanOrEqual(2);
    const steps = normalizeSteps(await readStoredEvents(page));
    // The box itself, not the bold word clicked: an editable element has no role of its own, as in Playwright.
    expect(
      steps.map((s) => [s.action, s.target?.tagName.toLowerCase() ?? null, s.target?.accessibleName ?? null]),
    ).toEqual([
      ['goto', null, null],
      ['click', 'div', 'Comment'],
    ]);
  });

  test('a file choice is recorded by the files’ names only, a double click as one step, and a drop as dragTo', async ({
    context,
  }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/files`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);

    // Files on disk, as a person chooses them: the browser sets them and sends a trusted `change`.
    const dir = mkdtempSync(path.join(tmpdir(), 'piwi-record-files-'));
    writeFileSync(path.join(dir, 'invoice.pdf'), '%PDF secret content');
    writeFileSync(path.join(dir, 'photo.png'), 'png');
    await page.getByTestId('attachment').setInputFiles([path.join(dir, 'invoice.pdf'), path.join(dir, 'photo.png')]);
    await page.getByTestId('invoice').dblclick();
    await page.getByTestId('card').dragTo(page.getByTestId('done'));

    await expect.poll(async () => normalizeSteps(await readStoredEvents(page)).length).toBe(4);
    const events = await readStoredEvents(page);
    expect(JSON.stringify(events)).not.toContain('secret content');
    const steps = normalizeSteps(events);
    expect(steps.map((s) => [s.action, s.value, s.target?.testId ?? null, s.dropTarget?.testId ?? null])).toEqual([
      ['goto', `${ORIGIN}/files`, null, null],
      ['setInputFiles', 'invoice.pdf\nphoto.png', 'attachment', null],
      ['dblclick', null, 'invoice', null],
      ['dragTo', null, 'card', 'done'],
    ]);
  });

  test('a password field is never captured — redacted with no value in storage', async ({ context }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });
    const page = await context.newPage();
    await context.route(`${ORIGIN}/secret`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body><input id="pw" type="password" /></body></html>`,
      }),
    );
    await page.goto(`${ORIGIN}/secret`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);

    await page.fill('#pw', 'hunter2');
    await expect.poll(() => readStoredEvents(page).then((e) => e.length)).toBeGreaterThan(0);

    const events = await readStoredEvents(page);
    expect(events.some((e) => e.value === 'hunter2')).toBe(false);
    const steps = normalizeSteps(events);
    const fillStep = steps.find((s) => s.action === 'fill');
    expect(fillStep?.redacted).toBe(true);
    expect(fillStep?.value).toBeNull();
  });

  test('a password shown in clear, before or after typing, and a card number or a one-time code are never captured', async ({
    context,
  }) => {
    const page = await recordingOn(context, '/reveal');
    await page.locator('#pw').click();
    await page.keyboard.type('s3cr');
    await page.locator('#show').click();
    await expect(page.locator('#pw')).toHaveAttribute('type', 'text');
    await page.locator('#pw').click();
    await page.keyboard.type('et!');
    await page.keyboard.press('Control+Alt+q');
    // Shown in clear before it is ever focused.
    await page.locator('#show-pin').click();
    await page.locator('#pin').click();
    await page.keyboard.type('4321');
    await page.locator('#card').click();
    await page.keyboard.type('4111111111111111');
    await page.locator('#otp').click();
    await page.keyboard.type('987654');
    await page.locator('#name').click();
    await page.keyboard.type('alice');

    await expect
      .poll(async () => normalizeSteps(await readStoredEvents(page)).some((s) => s.value === 'alice'))
      .toBe(true);
    const events = await readStoredEvents(page);
    for (const secret of ['s3c', 'et!', '4321', '4111', '9876']) expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.filter((e) => e.kind === 'keydown').map((e) => e.value)).toEqual([]);
    const fills = normalizeSteps(events).filter((s) => s.action === 'fill');
    expect(fills.map((s) => [s.target?.accessibleName, s.value, s.redacted])).toEqual([
      ['Password', null, true],
      ['Password', null, true],
      ['PIN', null, true],
      ['Card number', null, true],
      ['Code', null, true],
      ['Name', 'alice', false],
    ]);
  });

  test('a password field inside an open shadow root is never captured: no key it holds, its fill redacted', async ({
    context,
  }) => {
    const page = await recordingOn(context, '/shadow');
    await page.getByLabel('Password').click();
    await page.keyboard.type('hunter2');
    await page.keyboard.press('Control+Alt+q');
    await page.keyboard.press('Enter');

    await expect
      .poll(async () => normalizeSteps(await readStoredEvents(page)).some((s) => s.action === 'press'))
      .toBe(true);
    await page.waitForTimeout(200);
    const events = await readStoredEvents(page);
    expect(events.filter((e) => e.kind === 'keydown').map((e) => e.value)).toEqual(['Enter']);
    expect(JSON.stringify(events)).not.toContain('hunter2');
    const steps = normalizeSteps(events);
    expect(steps.map((s) => [s.action, s.value, s.redacted])).toEqual([
      ['goto', `${ORIGIN}/shadow`, false],
      ['click', null, false],
      ['fill', null, true],
      ['press', 'Enter', false],
    ]);
    // Every step names the field inside the shadow root, as the replay and the spec need.
    for (const step of steps.slice(1)) {
      const locator = step.target?.alternatives[0]?.locator ?? '';
      await expect(playwrightLocator(page, locator), locator).toHaveAttribute('type', 'password');
    }
  });

  test('a text field and a checkbox inside an open shadow root are recorded as a fill and a check', async ({
    context,
  }) => {
    const page = await recordingOn(context, '/shadow');
    await page.getByLabel('Name').click();
    await page.keyboard.type('alice');
    await page.getByLabel('Subscribe').check();

    await expect
      .poll(async () => normalizeSteps(await readStoredEvents(page)).some((s) => s.action === 'check'))
      .toBe(true);
    await page.waitForTimeout(200);
    const steps = normalizeSteps(await readStoredEvents(page));
    expect(steps.map((s) => [s.action, s.value, s.target?.accessibleName ?? null])).toEqual([
      ['goto', `${ORIGIN}/shadow`, null],
      ['click', null, 'Name'],
      ['fill', 'alice', 'Name'],
      ['check', null, 'Subscribe'],
    ]);
    for (const step of steps.slice(1)) {
      const locator = step.target?.alternatives[0]?.locator ?? '';
      await expect(playwrightLocator(page, locator), locator).toHaveJSProperty('localName', 'input');
    }
  });

  test('a key pressed in a closed shadow root is recorded only as a password field’s would be', async ({ context }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });
    // `chrome.dom.openOrClosedShadowRoot`, which a content script has: the shadow root of an element, closed ones too.
    await context.addInitScript(() => {
      const roots = new WeakMap<Element, ShadowRoot>();
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init: ShadowRootInit) {
        const root = attach.call(this, init);
        roots.set(this, root);
        return root;
      };
      (globalThis as any).chrome.dom = { openOrClosedShadowRoot: (el: Element) => roots.get(el) ?? null };
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/closed-shadow`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);

    await page.evaluate(() =>
      (document.querySelector('x-secret') as HTMLElement & { focusField(): void }).focusField(),
    );
    await page.keyboard.type('hunter2');
    await page.keyboard.press('Control+Alt+q');
    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.press('Enter');

    await expect
      .poll(async () => normalizeSteps(await readStoredEvents(page)).some((s) => s.action === 'press'))
      .toBe(true);
    await page.waitForTimeout(200);
    const events = await readStoredEvents(page);
    expect(events.filter((e) => e.kind === 'keydown').map((e) => e.value)).toEqual(['Enter']);
    expect(JSON.stringify(events)).not.toContain('hunter2');
  });

  /** A page with a password field and a text field, the recorder attached, `platform` as `navigator.platform`. */
  async function keysPage(context: BrowserContext, platform?: string): Promise<Page> {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });
    await context.route(`${ORIGIN}/keys`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body><input id="pw" type="password" /><input id="name" /></body></html>`,
      }),
    );
    const page = await context.newPage();
    if (platform) {
      await page.addInitScript((value) => Object.defineProperty(navigator, 'platform', { get: () => value }), platform);
    }
    await page.goto(`${ORIGIN}/keys`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    return page;
  }

  test('in a password field, a key with a modifier (AltGr arrives as Ctrl+Alt on Windows) is never recorded', async ({
    context,
  }) => {
    const page = await keysPage(context);
    await page.locator('#pw').click();
    await page.keyboard.press('Control+Alt+q');
    await page.keyboard.press('Alt+2');
    await page.keyboard.press('Enter');

    await expect
      .poll(async () => normalizeSteps(await readStoredEvents(page)).some((s) => s.action === 'press'))
      .toBe(true);
    await page.waitForTimeout(200);
    const presses = normalizeSteps(await readStoredEvents(page)).filter((s) => s.action === 'press');
    expect(presses.map((s) => s.value)).toEqual(['Enter']);
  });

  test('Option with a character on a Mac types it: no shortcut step in a field', async ({ context }) => {
    const page = await keysPage(context, 'MacIntel');
    await page.locator('#name').click();
    await page.keyboard.press('Alt+g');
    await page.keyboard.press('Meta+k');

    await expect
      .poll(async () => normalizeSteps(await readStoredEvents(page)).some((s) => s.action === 'press'))
      .toBe(true);
    await page.waitForTimeout(200);
    const presses = normalizeSteps(await readStoredEvents(page)).filter((s) => s.action === 'press');
    expect(presses.map((s) => s.value)).toEqual(['ControlOrMeta+k']);
  });

  /** Seeds a live recording and drives it to a page that already has the recorder attached. */
  async function recordingInProgress(context: BrowserContext): Promise<Page> {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    return page;
  }

  test('a stop from the popup reaches an already-recording page: HUD and border go, review panel opens', async ({
    context,
  }) => {
    const page = await recordingInProgress(context);

    // Exactly what the popup's Stop does — `stopRecording()` writes the state,
    // then it re-injects this script. It cannot message the content script:
    // `chrome.runtime.sendMessage` reaches extension pages and the worker only.
    await setRecordingActive(page, false);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });

    // Neither surface may outlive the capture — the border especially, since it
    // is the only always-visible signal that the tab is being recorded.
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(false);
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-frame-host'))).toBe(false);
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(true);
  });

  test('the worker’s stop fan-out tears a non-initiating tab down without opening a review panel there', async ({
    context,
  }) => {
    const page = await recordingInProgress(context);

    // The worker's `chrome.tabs.sendMessage` fan-out, as received by a tab that
    // did not ask for the stop.
    await setRecordingActive(page, false);
    await dispatchRuntimeMessage(page, { type: 'piwi-recording-stopped' });

    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(false);
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-frame-host'))).toBe(false);
    // The review belongs to the tab the user stopped from, not to every tab.
    expect(await page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(false);

    // Capture is really over, not just its UI: further interaction records nothing.
    const before = (await readStoredEvents(page)).length;
    await page.click('#submit');
    await page.waitForTimeout(200);
    expect((await readStoredEvents(page)).length).toBe(before);
  });

  test('Pause in the bar records nothing until Resume, on the next page too, and a pause from another tab shows here', async ({
    context,
  }) => {
    await openShadowRoots(context);
    const page = await recordingInProgress(context);
    const hud = page.locator('#piwi-record-hud-host');
    const paused = () =>
      page.evaluate(
        async () => (await (globalThis as any).chrome.storage.session.get('piwiRecording')).piwiRecording.paused,
      );
    const steps = async () => normalizeSteps(await readStoredEvents(page)).map((s) => s.action);

    await hud.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(paused).toBe(true);
    await expect(hud.getByText('Paused: what you do here is not recorded until you resume.')).toBeVisible();
    await expect(hud.getByRole('button', { name: 'Resume' })).toHaveAttribute('aria-pressed', 'true');
    // Nothing is recorded meanwhile, so no check is offered either.
    await expect(hud.getByRole('button', { name: 'Check an element' })).toBeDisabled();
    await expect(hud.getByRole('button', { name: 'Check the address' })).toBeDisabled();
    await page.fill('#username', 'alice');
    await page.getByTestId('remember-me').click();

    // Still paused on the next page, as the recording says.
    await page.click('#submit');
    await page.waitForURL('**/dashboard');
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect(hud.getByRole('button', { name: 'Resume' })).toBeVisible();
    await page.click('#add');
    await page.waitForTimeout(200);
    expect(await steps()).toEqual(['goto']);

    await hud.getByRole('button', { name: 'Resume' }).click();
    await expect.poll(paused).toBe(false);
    await expect(hud.getByRole('button', { name: 'Check an element' })).toBeEnabled();
    await page.click('#add');
    await expect.poll(steps).toEqual(['goto', 'click']);

    // Paused from the recording's bar in another tab: the worker passes it on.
    await dispatchRuntimeMessage(page, { type: 'piwi-recording-paused', paused: true });
    await expect(hud.getByRole('button', { name: 'Resume' })).toBeVisible();
    await page.click('#add');
    await page.waitForTimeout(200);
    expect(await steps()).toEqual(['goto', 'click']);
  });

  test('a page restored from the back/forward cache records that the flow came back to it', async ({ context }) => {
    const page = await recordingInProgress(context);
    const navigations = async () => (await readStoredEvents(page)).filter((e) => e.kind === 'navigate').length;
    await expect.poll(navigations).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect.poll(navigations).toBe(2);
    expect(await page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    // Capture goes on, once.
    await page.getByTestId('remember-me').click();
    await expect.poll(async () => (await readStoredEvents(page)).filter((e) => e.kind === 'change').length).toBe(1);
    await page.waitForTimeout(200);
    expect((await readStoredEvents(page)).filter((e) => e.kind === 'change')).toHaveLength(1);
  });

  test('a page restored from the back/forward cache after the recording stopped lets go of it', async ({ context }) => {
    const page = await recordingInProgress(context);
    await setRecordingActive(page, false);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(false);
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-frame-host'))).toBe(false);
    expect(await page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(false);
    const before = (await readStoredEvents(page)).length;
    await page.click('#username');
    await page.waitForTimeout(200);
    expect((await readStoredEvents(page)).length).toBe(before);
  });

  test('stopping shows the review panel, and Copy as TypeScript substitutes a matching catalog function', async ({
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const catalog: TestFunctionEntry[] = [
      {
        id: 1,
        name: 'addToCart',
        kind: 'helper',
        module: './helpers/cart',
        receiver: null,
        importName: null,
        params: [],
        urlPattern: null,
        steps: [{ action: 'click', target: { testId: 'add-to-cart' } }],
        paramSources: [],
      },
    ];
    const seededEvents: RawCaptureEvent[] = [
      {
        kind: 'click',
        target: {
          tagName: 'button',
          role: 'button',
          accessibleName: 'Add to cart',
          testId: 'add-to-cart',
          text: 'Add to cart',
          alternatives: [{ locator: `getByTestId('add-to-cart')`, method: 'getByTestId', score: 100 }],
        },
        value: null,
        checked: null,
        inputType: null,
        isPasswordField: false,
        pageUrl: `${ORIGIN}/dashboard`,
        timestamp: 1,
      },
    ];
    await routePages(context);
    await stubChromeStorage(context, {
      session: { piwiRecording: { active: false, events: seededEvents, startedAt: 1, grantedOriginPattern: null } },
      local: {
        piwiCatalogCache: { '1': { entries: catalog, fetchedAt: 1 } },
        piwiConnection: {
          instanceUrl: 'https://piwi.test',
          apiKey: '',
          projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Test project' }],
        },
      },
    });

    const page = await context.newPage();
    await page.goto(`${ORIGIN}/dashboard`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(true);
    // The recording border must not outlive the capture it signals.
    expect(await page.evaluate(() => !!document.getElementById('piwi-record-frame-host'))).toBe(false);

    // The review panel is in a closed shadow root (deliberate, same reasoning
    // as session-panel.ts/results-panel.ts) — Tab/Enter reaches its buttons
    // the same way session-panel.spec.ts drives its name prompt. Tab order:
    // close button, then "Copy as TypeScript".
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('addToCart(page)');
  });

  test('Download steps saves a steps file whose rendered spec replays the flow in a real browser', async ({
    context,
  }) => {
    await routePages(context);
    await stubChromeStorage(context, {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${ORIGIN}/*` },
      },
    });

    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    await page.fill('#username', 'alice');
    await page.click('#submit');
    await page.waitForURL('**/dashboard');
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
    await page.click('#add');
    await expect.poll(() => readStoredEvents(page).then((e) => e.length)).toBeGreaterThanOrEqual(4);

    // Stopped: a fresh document opens straight on the review panel.
    await setRecordingActive(page, false);
    await page.reload();
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(true);

    // Tab order in the closed shadow root: close, Copy as TypeScript, Download steps.
    const download = page.waitForEvent('download');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^piwi-steps-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
    const parsed = parseSteps(await readFile((await file.path())!, 'utf-8'));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const doc: PiwiSteps = parsed.steps;
    expect(doc.origin).toBe(ORIGIN);
    expect(doc.steps.map((s) => [s.action, s.pageUrl])).toEqual([
      ['goto', '/login'],
      ['fill', '/login'],
      ['click', '/login'],
      ['click', '/dashboard'],
    ]);

    // Render the steps as the lines of a test and run them on a new page with
    // Playwright's own expect, once as recorded and once with a wrong expectation.
    const run = async (expected: string) => {
      const withCheck: PiwiSteps = {
        ...doc,
        steps: [
          ...doc.steps,
          {
            ...doc.steps[3]!,
            action: 'assert',
            assertion: { matcher: 'toHaveText', expected, actual: null, negated: false, note: null },
          },
        ],
      };
      const { code, warnings } = renderSpec(sessionFromSteps(withCheck), {
        format: 'body',
        locators: 'stable',
        urlChecks: true,
      });
      expect(warnings).toEqual([]);
      expect(code).toContain('await expect(page).toHaveURL(/\\/dashboard(?:[?#]|$)/);');
      const replayPage = await context.newPage();
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      try {
        await new AsyncFunction('page', 'expect', code)(replayPage, expect.configure({ timeout: 2000 }));
        return 'passed';
      } catch (error) {
        // Playwright colors the differing part of a value; drop the color codes.
        return stripVTControlCharacters((error as Error).message);
      } finally {
        await replayPage.close();
      }
    };
    expect(await run('Add to cart')).toBe('passed');
    expect(await run('Remove from cart')).toContain('Remove from cart');
  });
});

test.describe('record-panel.js in French and German', () => {
  const addToCart: TestFunctionEntry = {
    id: 1,
    name: 'addToCart',
    kind: 'helper',
    module: './helpers/cart',
    receiver: null,
    importName: null,
    params: [],
    urlPattern: null,
    steps: [{ action: 'click', target: { testId: 'add-to-cart' } }],
    paramSources: [],
  };
  const clickAddToCart: RawCaptureEvent = {
    kind: 'click',
    target: {
      tagName: 'button',
      role: 'button',
      accessibleName: 'Add to cart',
      testId: 'add-to-cart',
      text: 'Add to cart',
      alternatives: [{ locator: `getByTestId('add-to-cart')`, method: 'getByTestId', score: 100 }],
    },
    value: null,
    checked: null,
    inputType: null,
    isPasswordField: false,
    pageUrl: `${ORIGIN}/dashboard`,
    timestamp: 2,
  };
  const fillCoupon: RawCaptureEvent = {
    ...clickAddToCart,
    kind: 'input',
    target: { ...clickAddToCart.target!, role: 'textbox', accessibleName: 'Coupon', testId: null, alternatives: [] },
    value: 'SPRING10',
    timestamp: 1,
  };

  /** A recording in `language` seeded with `events`, a connection and a one-function catalog; the recorder's shadow roots open. */
  async function recordingIn(
    language: string,
    context: BrowserContext,
    active: boolean,
    events: RawCaptureEvent[],
  ): Promise<Page> {
    await routePages(context);
    await stubChromeStorage(context, {
      session: { piwiRecording: { active, events, startedAt: 1, grantedOriginPattern: `${ORIGIN}/*` } },
      local: {
        piwiCatalogCache: { '1': { entries: [addToCart], fetchedAt: Date.now() } },
        piwiConnection: {
          instanceUrl: 'https://piwi.test',
          apiKey: '',
          projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Test project' }],
        },
      },
    });
    await stubChromeI18n(context, language);
    await openShadowRoots(context);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/dashboard`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    return page;
  }

  function shadowOf(page: Page, hostId: string) {
    return page.evaluate((id) => {
      const root = document.getElementById(id)?.shadowRoot;
      if (!root) return null;
      const box = root.querySelector<HTMLElement>('[lang]');
      return {
        lang: box?.lang ?? null,
        text: (box?.innerText ?? '').replace(/[ \t\n]+/g, ' '),
        labels: [...root.querySelectorAll('[aria-label], [title]')].map(
          (el) => el.getAttribute('aria-label') ?? el.getAttribute('title'),
        ),
      };
    }, hostId);
  }

  test('the HUD speaks French', async ({ context }) => {
    const page = await recordingIn('fr', context, true, [clickAddToCart]);
    await expect.poll(() => shadowOf(page, 'piwi-record-hud-host').then((s) => s?.text ?? '')).toContain('Arrêter');
    const hud = (await shadowOf(page, 'piwi-record-hud-host'))!;
    expect(hud.lang).toBe('fr');
    // The seeded click plus this page's own navigation.
    expect(hud.text).toContain('Enregistrement : 2 étapes');
    expect(hud.text).toMatch(/Dernier locator/i);
    expect(hud.text).toContain(`getByTestId('add-to-cart')`);
    // The locator is highlighted as every panel shows one.
    expect(
      await page.evaluate(
        () =>
          document.getElementById('piwi-record-hud-host')!.shadowRoot!.querySelectorAll('.piwi-loc .piwi-tok-fn')
            .length,
      ),
    ).toBe(1);
    expect(hud.text).toMatch(/Fonctions de test correspondantes/i);
    expect(hud.text).toContain('addToCart');
    expect(hud.text).toContain('prête');
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('the review panel speaks French, and keeps the page’s text as it is', async ({ context }) => {
    const page = await recordingIn('fr', context, false, [fillCoupon, clickAddToCart]);
    await expect.poll(() => shadowOf(page, 'piwi-record-review-host').then((s) => s?.lang ?? null)).toBe('fr');
    const review = (await shadowOf(page, 'piwi-record-review-host'))!;
    expect(review.text).toContain('2 étapes enregistrées');
    expect(review.text).toContain('1 étape correspond à l’une de vos fonctions de test');
    expect(review.text).toContain('Saisir « SPRING10 » dans le champ de texte « Coupon »');
    expect(review.text).toContain('Copier en TypeScript (avec vos fonctions)');
    expect(review.text).toContain('Copier en TypeScript sans vos fonctions');
    expect(review.text).toContain('Télécharger les étapes');
    expect(review.text).toContain('Abandonner');
    expect(review.labels).toEqual(
      expect.arrayContaining(['Votre enregistrement', 'Fermer', expect.stringContaining('piwi codegen')]),
    );
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('the HUD lays out in German without clipping', async ({ context }) => {
    const page = await recordingIn('de', context, true, [clickAddToCart]);
    await expect.poll(() => shadowOf(page, 'piwi-record-hud-host').then((s) => s?.text ?? '')).toContain('addToCart');
    expect((await shadowOf(page, 'piwi-record-hud-host'))!.lang).toBe('de');
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('the review panel lays out in German without clipping', async ({ context }) => {
    const page = await recordingIn('de', context, false, [fillCoupon, clickAddToCart]);
    await expect.poll(() => shadowOf(page, 'piwi-record-review-host').then((s) => s?.lang ?? null)).toBe('de');
    expect(await clippedInShadows(page)).toEqual([]);
  });
});

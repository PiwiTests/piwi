import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import type { PiwiSteps } from '@piwitests/core/steps';
import { test, expect } from './fixtures.js';
import { readCatalog, stubChromeI18n } from './i18n-stub.js';
import { clippedInShadows, openShadowRoots } from './shadow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');
const ORIGIN = 'https://replay-test.local';
/** A screenshot stand-in, wide and short as a page's. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAIAAABM5OhcAAAAx0lEQVR42u3SMQ0AAAzDsPJHVlhFMWmHDSFKCgciAcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbEwFhgLY2EsMBbGwlhgLIyFscBY/DbsGSW6o0IJdQAAAABJRU5ErkJggg==';

/**
 * The replay script, driven the way `record.spec.ts` drives the recorder: the
 * built bundle runs in the page with a stubbed `chrome.storage` kept in
 * `window.name`, which survives the replay's own navigations in the tab. The
 * bundle is added as an init script, as the background script's registration
 * adds it to every page of the origin.
 */
async function stubChrome(context: BrowserContext, session: Record<string, unknown>, language = 'en'): Promise<void> {
  await context.addInitScript((seed) => {
    function load(): { session: Record<string, unknown> } {
      if (!window.name) return { session: seed };
      try {
        return { session: JSON.parse(window.name).session ?? {} };
      } catch {
        return { session: {} };
      }
    }
    function persist(data: { session: Record<string, unknown> }): void {
      window.name = JSON.stringify(data);
    }
    if (!window.name) persist(load());
    const area = {
      get: async (key: string) => ({ [key]: load().session[key] }),
      set: async (values: Record<string, unknown>) => {
        const data = load();
        Object.assign(data.session, values);
        persist(data);
      },
      remove: async (key: string) => {
        const data = load();
        delete data.session[key];
        persist(data);
      },
    };
    (globalThis as any).chrome = {
      storage: { session: area, local: area },
      runtime: {
        sendMessage: async () => ({ ok: true }),
        onMessage: {
          addListener: (fn: (message: unknown) => void) => {
            ((globalThis as any).__piwiTestRuntimeListeners ??= []).push(fn);
          },
        },
      },
    };
  }, session);
  await stubChromeI18n(context, language);
  await context.addInitScript({ path: path.join(DIST, 'replay-panel.js') });
}

const LOGIN = `<!doctype html><html><body>
  <input id="username" data-testid="username-field" aria-label="Username" />
  <button data-testid="login-submit" onclick="location.href='/dashboard'">Log in</button>
</body></html>`;

/** The cart: `fixed` adds the coupon, the buggy one does not, and `broken` has no button at all. */
function dashboard(kind: 'buggy' | 'fixed' | 'broken'): string {
  const onclick = kind === 'fixed' ? `document.getElementById('total').textContent = 'Total: 42'` : '';
  const button =
    kind === 'broken' ? '' : `<button data-testid="add-to-cart" onclick="${onclick}">Apply coupon</button>`;
  return `<!doctype html><html><body>${button}<output id="total" data-testid="cart-total">Total: 40</output></body></html>`;
}

async function routePages(context: BrowserContext, kind: 'buggy' | 'fixed' | 'broken'): Promise<void> {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: url.pathname === '/dashboard' ? dashboard(kind) : LOGIN });
  });
}

const target = (testId: string, role: string | null, name: string | null) => ({
  tagName: role === 'button' ? 'button' : 'input',
  role,
  accessibleName: name,
  testId,
  text: null,
  alternatives: [{ locator: `getByTestId('${testId}')`, method: 'getByTestId', score: 100 }],
});

/** A bug report recorded on staging, replayed on the test origin. */
const REPORT: PiwiSteps = {
  v: 1,
  title: 'Coupon not applied',
  origin: 'https://staging.acme.test',
  recordedAt: 0,
  note: null,
  steps: [
    { action: 'goto', target: null, value: '/login', redacted: false, pageUrl: '/login', timestamp: 0 },
    {
      action: 'fill',
      target: target('username-field', 'textbox', 'Username'),
      value: 'alice',
      redacted: false,
      pageUrl: '/login',
      timestamp: 1,
    },
    {
      action: 'click',
      target: target('login-submit', 'button', 'Log in'),
      value: null,
      redacted: false,
      pageUrl: '/login',
      timestamp: 2,
    },
    {
      action: 'click',
      target: target('add-to-cart', 'button', 'Apply coupon'),
      value: null,
      redacted: false,
      pageUrl: '/dashboard',
      timestamp: 3,
    },
    {
      action: 'assert',
      target: target('cart-total', 'status', null),
      value: null,
      redacted: false,
      pageUrl: '/dashboard',
      timestamp: 4,
      assertion: { matcher: 'toHaveText', expected: 'Total: 42', actual: 'Total: 40', negated: false, note: null },
    },
  ],
};

function running(
  stepMode = false,
  startPage: { recorded: string; actual: string } | null = null,
  steps: PiwiSteps = REPORT,
): Record<string, unknown> {
  return {
    piwiReplay: {
      id: 'r1',
      steps,
      origin: ORIGIN,
      position: 0,
      results: [],
      status: 'running',
      stepMode,
      cursor: null,
      startedAt: 0,
      startPage,
    },
  };
}

/** The replay's stored state, read from the page; the replay navigates it, so a read can land mid-load and is retried. */
async function replayState(
  page: Page,
): Promise<{ status: string; results: Array<{ status: string; detail: string | null }> }> {
  for (;;) {
    try {
      return await page.evaluate(() => JSON.parse(window.name).session.piwiReplay);
    } catch (error) {
      if (!/Execution context was destroyed|navigat/i.test(String(error))) throw error;
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

async function verdict(page: Page): Promise<Record<string, unknown>> {
  await expect.poll(() => replayState(page).then((s) => s.status), { timeout: 30_000 }).toBe('done');
  return page.evaluate(
    () => (globalThis as { __piwiReplayVerdict?: Record<string, unknown> }).__piwiReplayVerdict ?? {},
  );
}

test.describe('replay-panel.js', () => {
  test('replays a report across pages with a fake cursor, and finds the bug as reported', async ({ context }) => {
    await routePages(context, 'buggy');
    await stubChrome(context, running());
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    await page.waitForURL('**/dashboard');
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-replay-cursor-host'))).toBe(true);
    await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-replay-hud-host'))).toBe(true);

    expect(await verdict(page)).toEqual({ kind: 'reproduced', step: 4, found: '"Total: 40"', sameAsReported: true });
    expect((await replayState(page)).results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done', 'failed']);
  });

  test('says the bug does not show when the expected result holds', async ({ context }) => {
    await routePages(context, 'fixed');
    await stubChrome(context, running());
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    expect(await verdict(page)).toEqual({ kind: 'not-reproduced' });
  });

  test('starts from the tab’s own page when asked, whatever its address', async ({ context }) => {
    await routePages(context, 'buggy');
    const opened: string[] = [];
    context.on('request', (request) => {
      if (request.resourceType() === 'document') opened.push(new URL(request.url()).pathname);
    });
    await stubChrome(context, running(false, { recorded: `${ORIGIN}/login`, actual: `${ORIGIN}/signin?from=mail` }));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/signin?from=mail`);
    expect(await verdict(page)).toEqual({ kind: 'reproduced', step: 4, found: '"Total: 40"', sameAsReported: true });
    expect(opened).toEqual(['/signin', '/dashboard']);
    expect((await replayState(page)).results[0]).toEqual({
      status: 'done',
      detail: 'Started from the tab’s page instead.',
    });
  });

  test('step by step turned off while the page is still settling plays the rest', async ({ context }) => {
    await routePages(context, 'buggy');
    // The page keeps changing for a while, so the first step waits for it: the
    // panel is up, and step mode is turned off, before the replay reaches Next.
    await context.addInitScript(() => {
      const started = Date.now();
      const tick = setInterval(() => {
        document.body?.setAttribute('data-tick', String(Date.now()));
        if (Date.now() - started > 2500) clearInterval(tick);
      }, 100);
    });
    await stubChrome(context, running(true));
    await openShadowRoots(context);
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const stepByStep = page.locator('#piwi-replay-hud-host').getByRole('checkbox', { name: 'Step by step' });
    await stepByStep.uncheck();
    expect(await verdict(page)).toEqual({ kind: 'reproduced', step: 4, found: '"Total: 40"', sameAsReported: true });
  });

  test('the dialog offers to start on this page only for a report that opens one', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {});
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);
    const dialog = page.locator('#piwi-replay-dialog-host').getByRole('dialog', { name: 'Replay a bug report' });
    const file = dialog.getByLabel('The bug report’s .piwibug, or its steps.json');
    const stepByStep = dialog.getByRole('checkbox', { name: 'Step by step: click Next step before each step' });
    await expect(stepByStep).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);

    const noPage: PiwiSteps = { ...REPORT, steps: REPORT.steps.slice(1) };
    await file.setInputFiles({
      name: 'steps.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(noPage)),
    });
    await expect(dialog).toContainText('4 steps');
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);

    await file.setInputFiles({
      name: 'steps.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(REPORT)),
    });
    await expect(dialog).toContainText('5 steps');
    await expect(dialog.getByRole('checkbox')).toHaveCount(2);
    await expect(stepByStep).toBeVisible();
  });

  test('a Stop while a step waits for its element is kept, and the step is not played', async ({ context }) => {
    // The coupon button shows a while after the cart: the replay waits for it.
    const late = `<!doctype html><html><body><output id="total" data-testid="cart-total">Total: 40</output><script>
      setTimeout(() => {
        const b = document.createElement('button');
        b.dataset.testid = 'add-to-cart';
        b.textContent = 'Apply coupon';
        b.onclick = () => (document.getElementById('total').textContent = 'Total: 42');
        document.body.prepend(b);
      }, 4000);
    </script></body></html>`;
    await context.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({ contentType: 'text/html', body: url.pathname === '/dashboard' ? late : LOGIN });
    });
    await openShadowRoots(context);
    await stubChrome(context, running());
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    await page.waitForURL('**/dashboard');
    await expect.poll(async () => (await replayState(page)).results.length).toBe(3);
    // The page is ready and the replay looks for the button, not there yet.
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('add-to-cart')).toHaveCount(0);
    await page.locator('#piwi-replay-hud-host').getByRole('button', { name: 'Stop' }).click();

    await expect
      .poll(() => page.evaluate(() => (globalThis as any).__piwiReplayVerdict?.kind ?? null), { timeout: 20_000 })
      .toBe('stopped');
    await expect(page.getByTestId('add-to-cart')).toBeAttached();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('cart-total')).toHaveText('Total: 40');
    const state = await replayState(page);
    expect(state.status).toBe('stopped');
    expect(state.results.map((r) => r.status)).toEqual(['done', 'done', 'done']);
  });

  test('a replay stopped while no page played it shows its verdict on the next page, not the chooser', async ({
    context,
  }) => {
    await routePages(context, 'buggy');
    const seed = running();
    const replay = seed.piwiReplay as Record<string, unknown>;
    replay.status = 'stopped';
    replay.position = 1;
    replay.results = [{ status: 'done', detail: null }];
    await stubChrome(context, seed);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    await expect
      .poll(() => page.evaluate(() => (globalThis as any).__piwiReplayVerdict ?? null))
      .toEqual({ kind: 'stopped', step: 1 });
    expect(await page.evaluate(() => !!document.getElementById('piwi-replay-dialog-host'))).toBe(false);
    expect(await page.evaluate(() => !!document.getElementById('piwi-replay-hud-host'))).toBe(true);
    expect(await page.evaluate(() => JSON.parse(window.name).session.piwiReplay.finished)).toBe(true);
  });

  test('its panel takes clicks above a modal dialog the page opened, and plays the step inside it', async ({
    context,
  }) => {
    const modalLogin = `<!doctype html><html><body><dialog id="login">
      <input id="username" data-testid="username-field" aria-label="Username" />
      <button data-testid="login-submit">Log in</button>
    </dialog><script>document.getElementById('login').showModal();</script></body></html>`;
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: modalLogin }));
    await stubChrome(context, running(true));
    await openShadowRoots(context);
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    await expect.poll(async () => (await replayState(page)).results.length).toBe(1);
    // A real click, which a panel left under the dialog does not take.
    await page.locator('#piwi-replay-hud-host').getByRole('button', { name: 'Next step' }).click({ timeout: 5000 });
    await expect(page.getByTestId('username-field')).toHaveValue('alice');
  });

  test('a Next from the Piwi panel in DevTools plays the step waiting for it', async ({ context }) => {
    await routePages(context, 'buggy');
    await stubChrome(context, running(true));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    await expect(page.locator('#piwi-replay-hud-host')).toBeAttached();
    await expect.poll(async () => (await replayState(page)).results.length).toBe(1);
    // What the panel sends to the replayed site's tabs after a Next.
    await page.evaluate(() => {
      for (const fn of (globalThis as any).__piwiTestRuntimeListeners ?? [])
        fn({ type: 'piwi-replay-wake', wake: true });
    });
    await expect.poll(async () => (await replayState(page)).results.length).toBe(2);
  });

  test('says which request conditions were on', async ({ context }) => {
    await routePages(context, 'buggy');
    const session = running();
    const conditions = [{ id: 'c1', method: 'GET', pattern: '**/api/cart', kind: 'delay', delayMs: 2000 }];
    await stubChrome(context, { piwiReplay: { ...(session.piwiReplay as object), conditions } });
    await openShadowRoots(context);
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    await verdict(page);
    await expect(page.locator('#piwi-replay-hud-host')).toContainText(
      'Request conditions on: Slow down GET **/api/cart by 2 s',
    );
  });

  test('hands a step it cannot play to the person, and stops there when asked, saying why', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'broken');
    await stubChrome(context, running());
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud).toContainText(
      "Step 4 could not be played here. Nothing on this page matches getByTestId('add-to-cart').",
      {
        timeout: 20_000,
      },
    );
    await expect(hud).toContainText('Click button "Apply coupon"');
    await expect(hud).toContainText('Do it yourself on the page, then continue.');
    await hud.getByRole('button', { name: 'Stop here' }).click();
    expect(await verdict(page)).toEqual({
      kind: 'diverged',
      step: 3,
      reason: "Nothing on this page matches getByTestId('add-to-cart').",
    });
  });

  test('hands a manual step to the person, and says a stop there is where the test failed in its run', async ({
    context,
  }) => {
    await openShadowRoots(context);
    await routePages(context, 'fixed');
    const steps: PiwiSteps = {
      ...REPORT,
      steps: [
        ...REPORT.steps.slice(0, 3),
        {
          action: 'manual',
          target: null,
          value: null,
          redacted: false,
          pageUrl: '',
          timestamp: 3,
          manual: { description: 'Apply the coupon the test applied', location: 'tests/cart.spec.ts:12', call: null },
        },
      ],
    };
    const state = running(false, null, steps);
    await stubChrome(context, { piwiReplay: { ...(state.piwiReplay as object), runFailedStep: 3 } });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud).toContainText(
      'Step 4 could not be played here. The test does this at tests/cart.spec.ts:12, in a way Replay cannot play.',
      { timeout: 20_000 },
    );
    await expect(hud).toContainText('By hand: Apply the coupon the test applied');
    await hud.getByRole('button', { name: 'Stop here' }).click();
    expect(await verdict(page)).toEqual({
      kind: 'diverged',
      step: 3,
      reason: 'The test does this at tests/cart.spec.ts:12, in a way Replay cannot play.',
      asInRun: true,
    });
    await expect(hud).toContainText('Failed at step 4, as in the test run');
  });

  test('goes on once the person did the step, showing them the page as it began', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'broken');
    await stubChrome(context, running());
    await stubWorker(context, {
      'piwi-replay-step-view': {
        step: 3,
        dataUrl: PNG,
        box: { x: 100, y: 50, width: 200, height: 25 },
        viewport: { width: 1000, height: 500 },
      },
    });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    const shot = hud.getByRole('img', { name: 'The page as step 4 began, its element outlined' });
    await expect(shot).toBeVisible({ timeout: 20_000 });
    await expect(hud).toContainText('Do it yourself on the page, as the screenshot shows, then continue.');
    // Which element it is, as recorded, and that nothing on this page matches it.
    await expect(hud.locator('.locs .piwi-loc')).toHaveText(["getByTestId('add-to-cart')"]);
    await expect(hud).toContainText('None of them finds it on this page.');
    // The element is outlined where the recording found it.
    expect(
      await hud
        .locator('.shot .mark')
        .evaluate((mark: HTMLElement) => [mark.style.left, mark.style.top, mark.style.width, mark.style.height]),
    ).toEqual(['10%', '10%', '20%', '5%']);
    expect(await clippedInShadows(page)).toEqual([]);
    await hud.getByRole('button', { name: 'I did it, continue' }).click();
    expect(await verdict(page)).toMatchObject({ kind: 'reproduced', step: 4 });
    const state = await replayState(page);
    expect(state.results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'manual', 'failed']);
    await expect(hud.getByRole('status')).toContainText('1 step played by hand: 4.');
  });

  test('finds an element with another of its recorded locators when the test’s finds nothing, and says so', async ({
    context,
  }) => {
    await openShadowRoots(context);
    await routePages(context, 'fixed');
    // Recorded as "Apply discount", the button reads "Apply coupon" here: its test id still finds it.
    const renamed = {
      ...target('add-to-cart', 'button', 'Apply discount'),
      alternatives: [
        { locator: "getByRole('button', { name: 'Apply discount' })", method: 'getByRole', score: 90 },
        { locator: "getByTestId('add-to-cart')", method: 'getByTestId', score: 80 },
      ],
    };
    const steps: PiwiSteps = {
      ...REPORT,
      steps: REPORT.steps.map((step, i) => (i === 3 ? { ...step, target: renamed } : step)),
    };
    await stubChrome(context, running(false, null, steps));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    expect(await verdict(page)).toEqual({ kind: 'not-reproduced' });
    const state = await replayState(page);
    expect(state.results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done', 'passed']);
    expect(state.results[3]!.detail).toBe(
      "Found with getByTestId('add-to-cart'): getByRole('button', { name: 'Apply discount' }), the locator the test is written with, finds nothing here.",
    );
    await expect(page.locator('#piwi-replay-hud-host .note').filter({ hasText: 'Found with' })).toHaveCount(1);
  });

  test('takes the element most of its recorded locators agree on over the one the test’s finds', async ({
    context,
  }) => {
    await openShadowRoots(context);
    await context.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        // The page swapped the buttons' texts since the recording, as one that makes them up on each load does.
        body: `<!doctype html><html><body>
          <a id="save" class="button success" href="#saved" onclick="document.getElementById('out').textContent = 'saved'">bar</a>
          <a id="drop" class="button alert" href="#dropped" onclick="document.getElementById('out').textContent = 'dropped'">foo</a>
          <output id="out"></output>
        </body></html>`,
      }),
    );
    const steps: PiwiSteps = {
      ...REPORT,
      steps: [
        { action: 'goto', target: null, value: '/', redacted: false, pageUrl: '/', timestamp: 0 },
        {
          action: 'click',
          target: {
            tagName: 'a',
            role: 'link',
            accessibleName: 'foo',
            testId: null,
            text: 'foo',
            alternatives: [
              { locator: "getByRole('link', { name: 'foo' })", method: 'getByRole', score: 90 },
              { locator: "locator('#save')", method: 'locator', score: 65 },
              { locator: "locator('.success')", method: 'locator', score: 40 },
            ],
          },
          value: null,
          redacted: false,
          pageUrl: '/',
          timestamp: 1,
        },
      ],
    };
    await stubChrome(context, running(false, null, steps));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/`);
    await expect.poll(() => replayState(page).then((s) => s.status), { timeout: 30_000 }).toBe('done');
    await expect(page.locator('#out')).toHaveText('saved');
    expect((await replayState(page)).results[1]!.detail).toBe(
      "Found with locator('#save'), which the other recorded locators agree on: getByRole('link', { name: 'foo' }), the locator the test is written with, finds another element.",
    );
  });

  test('hands a password to the person, which a recording never keeps', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'fixed');
    const steps: PiwiSteps = {
      ...REPORT,
      steps: REPORT.steps.map((step, i) => (i === 1 ? { ...step, value: null, redacted: true } : step)),
    };
    await stubChrome(context, running(false, null, steps));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud).toContainText(
      'Step 2 could not be played here. This field held a password or another secret, which a recording never keeps: type it on the page, then continue.',
      { timeout: 20_000 },
    );
    await page.getByLabel('Username').fill('alice');
    await hud.getByRole('button', { name: 'I did it, continue' }).click();
    expect(await verdict(page)).toEqual({ kind: 'not-reproduced' });
    expect((await replayState(page)).results.map((r) => r.status)).toEqual([
      'done',
      'manual',
      'done',
      'done',
      'passed',
    ]);
  });

  test('waits on the page the person’s own action loads, then goes on from the next step', async ({ context }) => {
    await openShadowRoots(context);
    // The login page has no Log in button: the person gets to the dashboard their own way.
    await context.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      const body =
        url.pathname === '/dashboard'
          ? dashboard('buggy')
          : `<!doctype html><html><body><input data-testid="username-field" aria-label="Username" /><a href="/dashboard">Go on</a></body></html>`;
      await route.fulfill({ contentType: 'text/html', body });
    });
    await stubChrome(context, running());
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud).toContainText('Step 3 could not be played here.', { timeout: 20_000 });
    await page.getByRole('link', { name: 'Go on' }).click();
    await page.waitForURL('**/dashboard');
    // The step still waits for the person on the new page.
    await expect(hud).toContainText('Step 3 could not be played here.');
    await hud.getByRole('button', { name: 'I did it, continue' }).click();
    expect(await verdict(page)).toMatchObject({ kind: 'reproduced', step: 4 });
    const state = await replayState(page);
    expect(state.results.map((r) => r.status)).toEqual(['done', 'done', 'manual', 'done', 'failed']);
  });

  test('outlines on the page the elements its recorded locators still find, as the page changes', async ({
    context,
  }) => {
    await openShadowRoots(context);
    // Two buttons answer to the recorded test id: the replay cannot tell which one, the person can.
    await context.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      const body =
        url.pathname === '/dashboard'
          ? `<!doctype html><html><body><button data-testid="add-to-cart">Apply coupon</button>
             <button data-testid="add-to-cart" onclick="this.remove()">Apply coupon (gift)</button>
             <output data-testid="cart-total">Total: 40</output></body></html>`
          : LOGIN;
      await route.fulfill({ contentType: 'text/html', body });
    });
    await stubChrome(context, running());
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    const marks = page.locator('#piwi-replay-cursor-host .mark');
    await expect(hud).toContainText('2 elements on this page match them: outlined.', { timeout: 20_000 });
    await expect(marks).toHaveCount(2);
    const box = (await page.getByRole('button', { name: 'Apply coupon', exact: true }).boundingBox())!;
    const first = (await marks.first().boundingBox())!;
    expect(first.x).toBeCloseTo(box.x - 3, 0);
    expect(first.width).toBeCloseTo(box.width + 6, 0);
    // The page changes while the person acts: one button is gone, one outline with it.
    await page.getByRole('button', { name: 'Apply coupon (gift)' }).click();
    await expect(hud).toContainText('1 element on this page matches them: outlined.');
    await expect(marks).toHaveCount(1);
    await hud.getByRole('button', { name: 'I did it, continue' }).click();
    expect(await verdict(page)).toMatchObject({ kind: 'reproduced', step: 4 });
    await expect(marks).toHaveCount(0);
  });

  test('goes on without a step the person skips', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'broken');
    await stubChrome(context, running());
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await hud.getByRole('button', { name: 'Skip this step' }).click({ timeout: 20_000 });
    expect(await verdict(page)).toMatchObject({ kind: 'reproduced', step: 4 });
    const state = await replayState(page);
    expect(state.results[3]).toEqual({ status: 'skipped', detail: 'Skipped.' });
  });

  /** Opens the login page, then a page that answers 204 and leaves the tab where it is. */
  const EXPORT: PiwiSteps = {
    ...REPORT,
    title: 'Export',
    steps: [
      REPORT.steps[0]!,
      { action: 'goto', target: null, value: '/export', redacted: false, pageUrl: '/export', timestamp: 1 },
      {
        action: 'assert',
        target: target('login-submit', 'button', 'Log in'),
        value: null,
        redacted: false,
        pageUrl: '/login',
        timestamp: 2,
        assertion: { matcher: 'toBeVisible', expected: null, actual: null, negated: false, note: null },
      },
    ],
  };

  async function routeExport(context: BrowserContext): Promise<void> {
    await context.route(`${ORIGIN}/**`, async (route) => {
      if (new URL(route.request().url()).pathname === '/export') await route.fulfill({ status: 204 });
      else await route.fulfill({ contentType: 'text/html', body: LOGIN });
    });
  }

  test('a goto that leaves the tab on its page goes to the person, and the replay goes on once they skip it', async ({
    context,
  }) => {
    await openShadowRoots(context);
    await routeExport(context);
    await stubChrome(context, running(false, null, EXPORT));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud).toContainText(
      'Step 2 could not be played here. This step happened on /export, and the tab is on /login.',
      { timeout: 25_000 },
    );
    await hud.getByRole('button', { name: 'Skip this step' }).click();
    await expect.poll(() => replayState(page).then((s) => s.status), { timeout: 20_000 }).toBe('done');
    expect((await replayState(page)).results.map((r) => r.status)).toEqual(['done', 'skipped', 'passed']);
  });

  test('a Stop while a goto waits for a page that never comes ends the replay there', async ({ context }) => {
    await openShadowRoots(context);
    await routeExport(context);
    await stubChrome(context, running(false, null, EXPORT));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    await expect.poll(async () => (await replayState(page)).results.length, { timeout: 20_000 }).toBe(2);
    await page.locator('#piwi-replay-hud-host').getByRole('button', { name: 'Stop' }).click();
    await expect
      .poll(() => page.evaluate(() => (globalThis as any).__piwiReplayVerdict ?? null), { timeout: 5_000 })
      .toEqual({ kind: 'stopped', step: 1 });
    expect((await replayState(page)).results.map((r) => r.status)).toEqual(['done']);
  });

  test('a Next clicked just after the person did a step plays the step after it', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'broken');
    await stubChrome(context, running(true));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    const next = hud.getByRole('button', { name: 'Next step' });
    // The first step opens the login page again, where the replay goes on.
    await expect(hud).toContainText('step 2 of 5', { timeout: 20_000 });
    await next.click();
    await expect(hud).toContainText('step 3 of 5');
    await next.click();
    await page.waitForURL('**/dashboard');
    await expect(hud).toContainText('Step 4 could not be played here.', { timeout: 20_000 });
    // The replay is still busy with what follows the step when Next comes.
    await page.evaluate(() => {
      const root = document.getElementById('piwi-replay-hud-host')!.shadowRoot!;
      const named = (name: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === name)!;
      named('I did it, continue').click();
      setTimeout(() => named('Next step').click(), 30);
    });
    expect(await verdict(page)).toMatchObject({ kind: 'reproduced', step: 4 });
  });

  test('a Pause and a Continue while a step waits for its element leave the step waiting for Next', async ({
    context,
  }) => {
    // The coupon button shows a while after the cart.
    const late = `<!doctype html><html><body><output id="total" data-testid="cart-total">Total: 40</output><script>
      setTimeout(() => {
        const b = document.createElement('button');
        b.dataset.testid = 'add-to-cart';
        b.textContent = 'Apply coupon';
        b.onclick = () => (document.getElementById('total').textContent = 'Total: 42');
        document.body.prepend(b);
      }, 4000);
    </script></body></html>`;
    await context.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({ contentType: 'text/html', body: url.pathname === '/dashboard' ? late : LOGIN });
    });
    await openShadowRoots(context);
    await stubChrome(context, running(true));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    const next = hud.getByRole('button', { name: 'Next step' });
    const played = async () => (await replayState(page)).results.length;
    // The first step opens the login page again, where the replay goes on.
    await expect(hud).toContainText('step 2 of 5', { timeout: 20_000 });
    await next.click();
    await expect(hud).toContainText('step 3 of 5');
    await next.click();
    await page.waitForURL('**/dashboard');
    await expect.poll(played).toBe(3);
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('add-to-cart')).toHaveCount(0);
    await hud.getByRole('button', { name: 'Pause' }).click();
    await hud.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('add-to-cart')).toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    expect(await played()).toBe(3);
    await expect(page.getByTestId('cart-total')).toHaveText('Total: 40');
    await next.click();
    await expect(page.getByTestId('cart-total')).toHaveText('Total: 42');
  });

  test('looks for a handed-over step’s elements with one locator engine each time', async ({ context }) => {
    // Every scan of the whole page, which each new engine makes once.
    await context.addInitScript(() => {
      const all = Document.prototype.querySelectorAll;
      (globalThis as any).__piwiPageScans = 0;
      Document.prototype.querySelectorAll = function (this: Document, selectors: string) {
        if (selectors === '*') (globalThis as any).__piwiPageScans++;
        return all.call(this, selectors);
      } as typeof all;
    });
    await openShadowRoots(context);
    await routePages(context, 'broken');
    const alternatives = [
      { locator: "getByTestId('add-to-cart')", method: 'getByTestId', score: 100 },
      { locator: "getByRole('button', { name: 'Apply coupon' })", method: 'getByRole', score: 90 },
      { locator: "getByText('Apply coupon')", method: 'getByText', score: 80 },
    ];
    const steps = REPORT.steps.map((s, i) => (i === 3 ? { ...s, target: { ...s.target!, alternatives } } : s));
    await stubChrome(context, running(false, null, { ...REPORT, steps }));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud.locator('.locs .piwi-loc')).toHaveCount(3, { timeout: 20_000 });
    const scans = () => page.evaluate(() => (globalThis as any).__piwiPageScans as number);
    const before = await scans();
    await page.waitForTimeout(2000);
    // About five looks, each scanning the page once or twice whatever the number of locators.
    expect((await scans()) - before).toBeLessThanOrEqual(14);
  });

  test('hands over a goto it does not follow: another site, another scheme, or no address at all', async ({
    context,
  }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    const goto = (value: string, timestamp: number) => ({
      action: 'goto' as const,
      target: null,
      value,
      redacted: false,
      pageUrl: value,
      timestamp,
    });
    const elsewhere: PiwiSteps = {
      ...REPORT,
      title: 'Elsewhere',
      steps: [
        REPORT.steps[0]!,
        goto('https://elsewhere.test/sso', 1),
        goto('javascript:document.title="ran"', 2),
        goto('http://[', 3),
        {
          action: 'assert',
          target: target('login-submit', 'button', 'Log in'),
          value: null,
          redacted: false,
          pageUrl: '/login',
          timestamp: 4,
          assertion: { matcher: 'toBeVisible', expected: null, actual: null, negated: false, note: null },
        },
      ],
    };
    await stubChrome(context, running(false, null, elsewhere));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    for (const [step, value] of [
      [2, 'https://elsewhere.test/sso'],
      [3, 'javascript:document.title="ran"'],
      [4, 'http://['],
    ] as const) {
      await expect(hud).toContainText(
        `Step ${step} could not be played here. This step happened on ${value}, and the tab is on /login.`,
        { timeout: 20_000 },
      );
      await hud.getByRole('button', { name: 'Skip this step' }).click();
    }
    await expect.poll(() => replayState(page).then((s) => s.status), { timeout: 20_000 }).toBe('done');
    expect((await replayState(page)).results.map((r) => r.status)).toEqual([
      'done',
      'skipped',
      'skipped',
      'skipped',
      'passed',
    ]);
    expect(page.url()).toBe(`${ORIGIN}/login`);
    expect(await page.title()).not.toBe('ran');
  });

  test('hands over a start page it does not follow, as any goto', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    const start = { recorded: `${ORIGIN}/login`, actual: 'https://elsewhere.test/start' };
    await stubChrome(context, running(false, start));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud).toContainText(
      'Step 1 could not be played here. This step happened on https://elsewhere.test/start, and the tab is on /login.',
      { timeout: 20_000 },
    );
    expect(page.url()).toBe(`${ORIGIN}/login`);
    await hud.getByRole('button', { name: 'Skip this step' }).click();
    await expect.poll(() => replayState(page).then((s) => s.results[0]?.status), { timeout: 20_000 }).toBe('skipped');
    expect(page.url()).toBe(`${ORIGIN}/login`);
  });

  test('hands over a file step whose element takes no file', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    const upload: PiwiSteps = {
      ...REPORT,
      title: 'Upload',
      steps: [
        REPORT.steps[0]!,
        {
          action: 'setInputFiles',
          target: target('login-submit', 'button', 'Log in'),
          value: 'note.txt',
          redacted: false,
          pageUrl: '/login',
          timestamp: 1,
        },
      ],
    };
    await stubChrome(context, running(false, null, upload));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await hud
      .getByLabel('The file for this step')
      .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }, { timeout: 20_000 });
    await expect(hud).toContainText(
      'Step 2 could not be played here. The page did not react to the action the way it did when it was recorded.',
    );
    await hud.getByRole('button', { name: 'Skip this step' }).click();
    await expect.poll(() => replayState(page).then((s) => s.status), { timeout: 20_000 }).toBe('done');
    expect((await replayState(page)).results.map((r) => r.status)).toEqual(['done', 'skipped']);
  });

  test('keeps the focus on the control it was on as its panel is drawn again', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, running(true));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    // The first step opens the login page again, where the replay waits for Next.
    await expect(hud).toContainText('step 2 of 5', { timeout: 20_000 });
    await hud.getByRole('button', { name: 'Pause' }).focus();
    await page.keyboard.press('Enter');
    await expect(hud.getByRole('button', { name: 'Continue' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(hud.getByRole('button', { name: 'Pause' })).toBeFocused();
  });

  test('emulates a hover in a frame of the page apart from the page’s own', async ({ context }) => {
    await openShadowRoots(context);
    const menus = `<!doctype html><html><head><style>
      .menu .act { display: none; } .menu:hover .act { display: inline-block; }
    </style></head><body>
      <div class="menu" data-testid="menu">Menu <button class="act" data-testid="act"
        onclick="document.getElementById('out').textContent += 'top;'">Act</button></div>
      <iframe src="/inner" style="width: 400px; height: 120px"></iframe>
      <output id="out" data-testid="out"></output></body></html>`;
    const inner = `<!doctype html><html><head><style>
      .row .del { display: none; } .row:hover .del { display: inline-block; }
    </style></head><body>
      <div class="row" data-testid="row">Row <button class="del" data-testid="del"
        onclick="parent.document.getElementById('out').textContent += 'frame;'">Delete</button></div></body></html>`;
    await context.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: new URL(route.request().url()).pathname === '/inner' ? inner : menus,
      }),
    );
    // The background script registers the replay script in the top frame only.
    await context.addInitScript(() => {
      if (window !== window.top) (globalThis as any).__piwiReplayEntry = async () => undefined;
    });
    const inFrame = (testId: string, role: string | null, name: string | null) => ({
      ...target(testId, role, name),
      alternatives: [{ locator: `frameLocator('iframe').getByTestId('${testId}')`, method: 'getByTestId', score: 100 }],
    });
    const act = (action: 'hover' | 'click', on: ReturnType<typeof target>, timestamp: number) => ({
      action,
      target: on,
      value: null,
      redacted: false,
      pageUrl: '/menus',
      timestamp,
    });
    const hovers: PiwiSteps = {
      ...REPORT,
      title: 'Menus',
      steps: [
        { action: 'goto', target: null, value: '/menus', redacted: false, pageUrl: '/menus', timestamp: 0 },
        act('hover', target('menu', null, null), 1),
        act('click', target('act', 'button', 'Act'), 2),
        act('hover', inFrame('row', null, null), 3),
        act('click', inFrame('del', 'button', 'Delete'), 4),
        {
          ...act('click', target('out', 'status', null), 5),
          action: 'assert',
          assertion: { matcher: 'toHaveText', expected: 'top;frame;', actual: null, negated: false, note: null },
        },
      ],
    };
    await stubChrome(context, running(false, null, hovers));
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/menus`);
    expect(await verdict(page)).toEqual({ kind: 'not-reproduced' });
    // Gone with the replay, from both documents.
    for (const frame of page.frames()) {
      expect(
        await frame.evaluate(() => [
          document.adoptedStyleSheets.length,
          document.querySelectorAll('[data-piwi-hover]').length,
        ]),
      ).toEqual([0, 0]);
    }
  });
});

/**
 * The worker's answers, by message type, each after its delay in milliseconds when `delays` gives one; every
 * message the page sends is kept in `__piwiSent`.
 */
async function stubWorker(
  context: BrowserContext,
  answers: Record<string, unknown>,
  delays: Record<string, number> = {},
): Promise<void> {
  await context.addInitScript(
    ({ byType, after }) => {
      const sent: Array<{ type?: string }> = [];
      (globalThis as any).__piwiSent = sent;
      (globalThis as any).chrome.runtime.sendMessage = async (message: { type?: string }) => {
        sent.push(message);
        const delay = after[message.type ?? ''];
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return byType[message.type ?? ''] ?? { ok: true };
      };
    },
    { byType: answers, after: delays },
  );
}

/** The messages of one type the page sent the worker, as `stubWorker` keeps them. */
function sentOf(page: Page, type: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    (kind) => ((globalThis as any).__piwiSent as Array<{ type?: string }>).filter((m) => m.type === kind),
    type,
  );
}

/** The replay dialog, once a steps file holding `steps` is chosen in it. */
async function chooseFile(page: Page, steps: PiwiSteps = REPORT) {
  const dialog = page.locator('#piwi-replay-dialog-host').getByRole('dialog', { name: 'Replay a bug report' });
  await dialog.getByLabel(/steps\.json/).setInputFiles({
    name: 'steps.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(steps)),
  });
  await expect(dialog).toContainText(steps.title ?? 'Untitled report');
  return dialog;
}

test.describe('Run with Playwright', () => {
  async function chooseReport(page: Page) {
    const dialog = await chooseFile(page);
    await dialog.getByRole('button', { name: 'Run with Playwright…' }).click();
    return page
      .locator('#piwi-desktop-run-host')
      .getByRole('dialog', { name: 'Run with Playwright in the desktop app' });
  }

  test('shows what it sends, sends nothing before Send, then shows the desktop app’s verdict', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {});
    await stubWorker(context, {
      'piwi-desktop-target': { paired: true, url: 'http://127.0.0.1:4318' },
      'piwi-desktop-repro': { ok: true, id: 'a1b2', windowOpen: true },
      'piwi-desktop-repro-status': {
        ok: true,
        status: 'done',
        verdict: { kind: 'reproduced', step: 4, found: '"Total: 40"' },
      },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const desktop = await chooseReport(page);
    await expect(desktop).toContainText('Sends to the desktop app at http://127.0.0.1:4318');
    await expect(desktop).toContainText('The element with test id cart-total should read "Total: 42"');
    const sentTypes = () => page.evaluate(() => ((globalThis as any).__piwiSent as any[]).map((m) => m.type));
    expect(await sentTypes()).not.toContain('piwi-desktop-repro');

    await desktop.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(desktop).toContainText('Reproduced: the bug shows here');
    const sent = await page.evaluate(() =>
      ((globalThis as any).__piwiSent as any[]).find((m) => m.type === 'piwi-desktop-repro'),
    );
    expect(sent.steps.title).toBe('Coupon not applied');
    expect(sent.steps.steps).toHaveLength(5);
    expect(sent.bugReportId).toBeNull();
  });

  test('says to pair the desktop app first when none is', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {});
    await stubWorker(context, { 'piwi-desktop-target': { paired: false, url: null } });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const desktop = await chooseReport(page);
    await expect(desktop).toContainText('Pair the desktop app first');
    await expect(desktop.getByRole('button', { name: 'Open the options' })).toBeVisible();
  });

  test('says so when the desktop app’s verdict is not one it can show', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {});
    await stubWorker(context, {
      'piwi-desktop-target': { paired: true, url: 'http://127.0.0.1:4318' },
      'piwi-desktop-repro': { ok: true, id: 'a1b2', windowOpen: true },
      'piwi-desktop-repro-status': { ok: true, status: 'done', verdict: { kind: 'flaky', step: 2 } },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const desktop = await chooseReport(page);
    await desktop.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(desktop).toContainText(
      'The desktop app sent no verdict Piwi Picker can show: see the run in the app’s window.',
    );
    await expect(desktop.getByRole('button', { name: 'Close' })).toBeVisible();
  });

  test('takes the focus as it opens, and closes on Escape', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {});
    await stubWorker(context, { 'piwi-desktop-target': { paired: false, url: null } });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const desktop = await chooseReport(page);
    await expect(desktop).toHaveAttribute('aria-modal', 'true');
    await expect(desktop).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#piwi-desktop-run-host')).toHaveCount(0);
  });
});

test.describe('after a replay', () => {
  /** The cart, whose Apply posts a coupon the server refuses and logs the error. */
  async function routeFailingCart(context: BrowserContext): Promise<void> {
    await routePages(context, 'buggy');
    await context.route(`${ORIGIN}/dashboard`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <button data-testid="add-to-cart" onclick="fetch('/api/cart/coupon', { method: 'POST' }).then(() => console.error('Coupon failed: 500'))">Apply coupon</button>
          <output id="total" data-testid="cart-total">Total: 40</output></body></html>`,
      }),
    );
    await context.route(`${ORIGIN}/api/**`, (route) => route.fulfill({ status: 500, body: '{}' }));
  }

  test('says what the page showed during the replay: the failed request and the console error', async ({ context }) => {
    await openShadowRoots(context);
    await routeFailingCart(context);
    const state = running() as { piwiReplay: Record<string, unknown> };
    await stubChrome(context, { piwiReplay: { ...state.piwiReplay, evidenceToken: 'tok1' } });
    // The background script registers it in the page's main world for as long as the replay runs.
    await context.addInitScript({ path: path.join(DIST, 'bug-evidence-main.js') });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    expect(await verdict(page)).toMatchObject({ kind: 'reproduced' });
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud).toContainText('What the page showed during the replay:');
    await expect(hud).toContainText('POST /api/cart/coupon answered 500');
    await expect(hud).toContainText('Console error: Coupon failed: 500');
  });

  test('shares the verdict on the report it came from, after showing what it sends', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    const state = running() as { piwiReplay: Record<string, unknown> };
    await stubChrome(context, { piwiReplay: { ...state.piwiReplay, bugReportId: 37 } });
    await stubWorker(context, {
      'piwi-share-target': { instance: 'piwi.acme.test' },
      'piwi-share-reproduction': { ok: true },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    expect(await verdict(page)).toMatchObject({ kind: 'reproduced' });
    const hud = page.locator('#piwi-replay-hud-host');
    await hud.getByRole('button', { name: 'Share result…' }).click();
    await expect(hud).toContainText(
      `Sends to piwi.acme.test, on the report: this verdict, the site it ran on (${ORIGIN})`,
    );
    const shares = () =>
      page.evaluate(() =>
        ((globalThis as any).__piwiSent as any[]).filter((m) => m.type === 'piwi-share-reproduction'),
      );
    expect(await shares()).toEqual([]);
    await hud.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(hud).toContainText('Shared on the report.');
    expect(await shares()).toEqual([
      {
        type: 'piwi-share-reproduction',
        bugReportId: 37,
        source: 'replay',
        verdict: 'reproduced',
        divergedAt: null,
        origin: ORIGIN,
      },
    ]);
  });

  test('offers no Share result for steps that did not come from the instance', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, running());
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);
    expect(await verdict(page)).toMatchObject({ kind: 'reproduced' });
    await expect(page.locator('#piwi-replay-hud-host').getByRole('button', { name: 'Replay again' })).toBeVisible();
    await expect(page.locator('#piwi-replay-hud-host').getByRole('button', { name: 'Share result…' })).toHaveCount(0);
  });

  /** A replay of the report that ended, the bug found, while no page played it: the next page shows its verdict. */
  function ended(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const replay = running().piwiReplay as Record<string, unknown>;
    const done = { status: 'done', detail: null };
    const results = [done, done, done, done, { status: 'failed', detail: null, found: '"Total: 40"' }];
    return { piwiReplay: { ...replay, status: 'done', position: 5, results, ...extra } };
  }

  test('says a share that failed as an error', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, ended({ bugReportId: 37 }));
    await stubWorker(context, {
      'piwi-share-target': { instance: 'piwi.acme.test' },
      'piwi-share-reproduction': { ok: false, error: 'The instance cannot be reached.' },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const hud = page.locator('#piwi-replay-hud-host');
    await hud.getByRole('button', { name: 'Share result…' }).click();
    await hud.getByRole('button', { name: 'Send', exact: true }).click();
    const failed = hud.getByRole('alert');
    await expect(failed).toHaveText('Could not share the result: The instance cannot be reached.');
    // The error color of the panel's light scheme, not the grey of its notes.
    await expect(failed).toHaveCSS('color', 'rgb(185, 28, 28)');
  });

  test('a double click on Replay again starts the replay once', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, ended());
    await stubWorker(context, {}, { 'piwi-start-replay': 500 });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    await page.locator('#piwi-replay-hud-host').getByRole('button', { name: 'Replay again' }).dblclick();
    await page.waitForTimeout(1500);
    expect(await sentOf(page, 'piwi-start-replay')).toHaveLength(1);
  });

  test('a Replay again the worker refuses says why, and can be tried again', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, ended());
    await stubWorker(context, { 'piwi-start-replay': { ok: false, error: 'Piwi Picker has no access to this site.' } });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const hud = page.locator('#piwi-replay-hud-host');
    const again = hud.getByRole('button', { name: 'Replay again' });
    await again.click();
    await expect(hud.getByRole('alert')).toHaveText('Piwi Picker has no access to this site.');
    await expect(again).toBeEnabled();
  });
});

test.describe('the replay dialog', () => {
  test('a double click on Replay starts the replay once', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {});
    await stubWorker(context, {}, { 'piwi-start-replay': 500 });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const dialog = await chooseFile(page);
    await dialog.getByRole('button', { name: 'Replay', exact: true }).dblclick();
    await expect(page.locator('#piwi-replay-dialog-host')).toHaveCount(0);
    expect(await sentOf(page, 'piwi-start-replay')).toHaveLength(1);
  });

  test('keeps the report chosen last, whatever order the answers come in', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {});
    await stubWorker(context, {
      'piwi-list-bug-reports': {
        ok: true,
        project: { id: 1, label: 'Shop' },
        items: [
          { id: 1, title: 'First report' },
          { id: 2, title: 'Second report' },
        ],
      },
    });
    // The instance answers the first report slowly, the second at once.
    await context.addInitScript((steps) => {
      const send = (globalThis as any).chrome.runtime.sendMessage;
      (globalThis as any).chrome.runtime.sendMessage = async (message: { type?: string; id?: number }) => {
        if (message.type !== 'piwi-get-bug-report') return send(message);
        if (message.id === 1) await new Promise((resolve) => setTimeout(resolve, 800));
        return { ok: true, steps: { ...steps, title: message.id === 1 ? 'First report' : 'Second report' } };
      };
    }, REPORT);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const dialog = page.locator('#piwi-replay-dialog-host').getByRole('dialog', { name: 'Replay a bug report' });
    const reports = dialog.getByRole('combobox', { name: 'Choose a bug report' });
    await reports.selectOption('1');
    await reports.selectOption('2');
    await expect(dialog).toContainText('Second report · 5 steps');
    await page.waitForTimeout(1200);
    await expect(dialog).toContainText('Second report · 5 steps');
    await expect(dialog).not.toContainText('First report · 5 steps');

    // A file chosen while a report is still on its way is the one replayed.
    await reports.selectOption('1');
    await chooseFile(page);
    await page.waitForTimeout(1200);
    await expect(dialog).toContainText('Coupon not applied · 5 steps');
    await dialog.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect.poll(() => sentOf(page, 'piwi-start-replay')).toHaveLength(1);
    expect((await sentOf(page, 'piwi-start-replay'))[0]!.bugReportId).toBeNull();
  });

  test('replays steps pasted as text, and says what is wrong with text that is not steps', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {});
    await stubWorker(context, {});
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const dialog = page.locator('#piwi-replay-dialog-host').getByRole('dialog', { name: 'Replay a bug report' });
    await dialog.getByText('Or paste the text of a steps.json').click();
    const field = dialog.getByRole('textbox', { name: 'Steps to paste' });
    await field.fill('{"v":1,"steps":[{"action":"eval"}]}');
    await dialog.getByRole('button', { name: 'Use these steps' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'The pasted text is not a steps file: steps[0].action: is not a known action',
    );
    await field.fill(JSON.stringify(REPORT));
    await dialog.getByRole('button', { name: 'Use these steps' }).click();
    await expect(dialog).toContainText('Coupon not applied · 5 steps');
    await dialog.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect.poll(() => sentOf(page, 'piwi-start-replay')).toHaveLength(1);
    expect((await sentOf(page, 'piwi-start-replay'))[0]!.steps).toEqual(REPORT);
  });

  for (const mode of ['actions', 'bug'] as const) {
    test(`offers the ${mode === 'bug' ? 'bug report' : 'plain recording'} recorded in this browser, under its own name`, async ({
      context,
    }) => {
      const events = [
        {
          kind: 'navigate',
          target: null,
          value: `${ORIGIN}/login`,
          checked: null,
          inputType: null,
          isPasswordField: false,
          pageUrl: `${ORIGIN}/login`,
          timestamp: 1,
        },
        {
          kind: 'click',
          target: target('login-submit', 'button', 'Log in'),
          value: null,
          checked: null,
          inputType: null,
          isPasswordField: false,
          pageUrl: `${ORIGIN}/login`,
          timestamp: 2,
        },
      ];
      await openShadowRoots(context);
      await routePages(context, 'buggy');
      await stubChrome(context, {
        piwiRecording: { active: false, events, startedAt: 1, grantedOriginPattern: `${ORIGIN}/*`, mode },
      });
      await stubWorker(context, {});
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/login`);

      const dialog = page.locator('#piwi-replay-dialog-host').getByRole('dialog', { name: 'Replay a bug report' });
      const own =
        mode === 'bug' ? 'Use the bug report recorded in this browser' : 'Use the actions recorded in this browser';
      const other =
        mode === 'bug' ? 'Use the actions recorded in this browser' : 'Use the bug report recorded in this browser';
      await expect(dialog.getByRole('button', { name: other })).toHaveCount(0);
      await dialog.getByRole('button', { name: own }).click();
      await expect(dialog).toContainText('2 steps');
      // A recording of actions goes by its first action when it has no title of its own.
      if (mode === 'actions') await expect(dialog).toContainText('Click');
      else await expect(dialog).toContainText('Untitled report');
      await dialog.getByRole('button', { name: 'Replay', exact: true }).click();
      await expect.poll(() => sentOf(page, 'piwi-start-replay')).toHaveLength(1);
      const [start] = await sentOf(page, 'piwi-start-replay');
      expect((start!.steps as PiwiSteps).steps.map((s) => s.action)).toEqual(['goto', 'click']);
    });
  }

  test('takes the focus as it opens, and closes on Escape', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {});
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const dialog = page.locator('#piwi-replay-dialog-host').getByRole('dialog', { name: 'Replay a bug report' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#piwi-replay-dialog-host')).toHaveCount(0);
  });
});

test.describe('replay-panel.js in French', () => {
  test('shows its panel and its verdict in French, the page texts quoted the French way', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, running(true), 'fr');
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);

    const hud = page.locator('#piwi-replay-hud-host').getByRole('region');
    await expect(hud).toHaveAttribute('lang', 'fr');
    await expect(hud).toHaveAttribute('aria-label', 'Piwi Picker\u00a0: rapport de bug rejoué');
    await expect(hud).toContainText('En cours : Coupon not applied');
    await expect(hud).toContainText('étape 2 sur 5');
    await expect(hud.getByRole('button', { name: 'Étape suivante' })).toBeVisible();
    await expect(hud.getByRole('checkbox', { name: 'Pas à pas' })).toBeChecked();

    // Plays the rest without stopping.
    await hud.getByRole('checkbox', { name: 'Pas à pas' }).uncheck();
    expect(await verdict(page)).toEqual({
      kind: 'reproduced',
      step: 4,
      found: '«\u202fTotal: 40\u202f»',
      sameAsReported: true,
    });
    const done = page.locator('#piwi-replay-hud-host').getByRole('region');
    await expect(done).toHaveAttribute('lang', 'fr');
    const status = done.getByRole('status');
    await expect(status).toContainText('Reproduit\u00a0: le bug est visible ici');
    await expect(status).toContainText(
      'Étape 5\u00a0: attendu «\u202fTotal: 42\u202f», résultat\u00a0: «\u202fTotal: 40\u202f», comme signalé.',
    );
    await expect(done).toContainText('Terminé : Coupon not applied');
    await expect(done).toContainText('Résultat : «\u202fTotal: 40\u202f».');
    // The steps in French words, the page's texts as they are.
    await expect(done).toContainText('Saisir «\u202falice\u202f» dans le champ de texte «\u202fUsername\u202f»');
    await expect(done).toContainText('Cliquer sur le bouton «\u202fApply coupon\u202f»');
    await expect(done).toContainText('L’élément avec le test id cart-total devrait afficher «\u202fTotal: 42\u202f»');
    await expect(done.getByRole('button', { name: 'Rejouer' })).toBeVisible();
    await expect(done.getByRole('button', { name: 'Fermer' })).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('says in French why the replay stopped where the page differs', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'broken');
    await stubChrome(context, running(), 'fr');
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud).toContainText('L’étape 4 n’a pas pu être rejouée ici.', { timeout: 20_000 });
    expect(await clippedInShadows(page)).toEqual([]);
    await hud.getByRole('button', { name: 'Arrêter ici' }).click();
    expect(await verdict(page)).toEqual({
      kind: 'diverged',
      step: 3,
      reason: "Aucun élément de cette page ne correspond à getByTestId('add-to-cart').",
    });
    const status = page.locator('#piwi-replay-hud-host').getByRole('status');
    await expect(status).toContainText('Impossible d’atteindre le bug\u00a0: arrêt à l’étape 4');
    await expect(status).toContainText('Cette page n’est pas la même que dans le rapport');
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('asks for the report to replay in French, and says what is wrong with a file', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {}, 'fr');
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const dialog = page.locator('#piwi-replay-dialog-host').getByRole('dialog', { name: 'Rejouer un rapport de bug' });
    await expect(dialog).toHaveAttribute('lang', 'fr');
    await expect(dialog).toContainText(`Rejoue ses étapes sur ${ORIGIN}`);
    await dialog.getByRole('button', { name: 'Rejouer' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Choisissez d’abord un rapport.');

    const file = dialog.getByLabel('Le .piwibug du rapport de bug, ou son steps.json');
    await file.setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
    await expect(dialog.getByRole('alert')).toContainText('notes.json n’est pas un fichier d’étapes\u00a0:');

    await file.setInputFiles({
      name: 'steps.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(REPORT)),
    });
    await expect(dialog).toContainText(`Coupon not applied · 5 étapes · enregistré sur ${REPORT.origin}`);
    await expect(
      dialog.getByRole('checkbox', { name: 'Pas à pas : cliquez sur Étape suivante avant chaque étape' }),
    ).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);
  });
});

test.describe('replay-panel.js in German', () => {
  const catalog = readCatalog('de');

  test('lays out its panel and its verdict without clipping', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, running(true), 'de');
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);

    const hud = page.locator('#piwi-replay-hud-host').getByRole('region');
    await expect(hud).toHaveAttribute('lang', 'de');
    await expect(hud.getByRole('checkbox')).toBeChecked();
    expect(await clippedInShadows(page)).toEqual([]);

    await hud.getByRole('checkbox').uncheck();
    expect(await verdict(page)).toMatchObject({ kind: 'reproduced' });
    const done = page.locator('#piwi-replay-hud-host').getByRole('region');
    await expect(done).toHaveAttribute('lang', 'de');
    await expect(done.getByRole('status')).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('lays out why the replay stopped without clipping', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'broken');
    await stubChrome(context, running(), 'de');
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/login`);
    const hud = page.locator('#piwi-replay-hud-host');
    await expect(hud.getByRole('button', { name: 'Hier abbrechen' })).toBeVisible({ timeout: 20_000 });
    expect(await clippedInShadows(page)).toEqual([]);
    await hud.getByRole('button', { name: 'Hier abbrechen' }).click();
    expect(await verdict(page)).toMatchObject({ kind: 'diverged' });
    await expect(page.locator('#piwi-replay-hud-host').getByRole('region')).toHaveAttribute('lang', 'de');
    await expect(page.locator('#piwi-replay-hud-host').getByRole('status')).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('lays out the dialog, its errors and a chosen report without clipping', async ({ context }) => {
    await openShadowRoots(context);
    await routePages(context, 'buggy');
    await stubChrome(context, {}, 'de');
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);

    const dialog = page
      .locator('#piwi-replay-dialog-host')
      .getByRole('dialog', { name: catalog.replay_dialogTitle!.message });
    await expect(dialog).toHaveAttribute('lang', 'de');
    expect(await clippedInShadows(page)).toEqual([]);
    await dialog.getByRole('button', { name: catalog.replay_start!.message, exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);

    const file = dialog.getByLabel(catalog.replay_fileLabel!.message);
    await file.setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
    await expect(dialog.getByRole('alert')).toContainText('notes.json');
    expect(await clippedInShadows(page)).toEqual([]);

    await file.setInputFiles({
      name: 'steps.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(REPORT)),
    });
    await expect(dialog).toContainText(REPORT.origin!);
    // Step by step, and starting from this page instead of the report's first one.
    await expect(dialog.getByRole('checkbox')).toHaveCount(2);
    await expect(dialog).toContainText('/login');
    expect(await clippedInShadows(page)).toEqual([]);
  });
});

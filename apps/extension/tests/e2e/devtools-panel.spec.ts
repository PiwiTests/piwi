import type { Page } from '@playwright/test';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import type { PiwiSteps } from '@piwitests/core/steps';
import { test, expect } from './fixtures.js';
import { openDevtoolsPage } from './devtools-stub.js';
import { tabIdOf, test as trustedTest } from './trusted-site.js';

const ORIGIN = 'http://piwi-panel.test';

const button = (testId: string, name: string) => ({
  tagName: 'button',
  role: 'button',
  accessibleName: name,
  testId,
  text: name,
  alternatives: [{ locator: `getByTestId('${testId}')`, method: 'getByTestId', score: 100 }],
});

function click(testId: string, name: string, timestamp: number): RawCaptureEvent {
  return {
    kind: 'click',
    target: button(testId, name),
    value: null,
    checked: null,
    inputType: null,
    isPasswordField: false,
    pageUrl: `${ORIGIN}/cart`,
    timestamp,
  } as RawCaptureEvent;
}

const REPORT: PiwiSteps = {
  v: 1,
  title: 'Coupon not applied',
  origin: ORIGIN,
  recordedAt: 0,
  note: null,
  steps: [
    { action: 'goto', target: null, value: '/cart', redacted: false, pageUrl: '/cart', timestamp: 0 },
    {
      action: 'click',
      target: button('apply-coupon', 'Apply coupon'),
      value: null,
      redacted: false,
      pageUrl: '/cart',
      timestamp: 1,
    },
    {
      action: 'assert',
      target: { ...button('cart-total', 'Total'), role: 'status', tagName: 'output' },
      value: null,
      redacted: false,
      pageUrl: '/cart',
      timestamp: 2,
      assertion: { matcher: 'toHaveText', expected: 'Total: 42', actual: 'Total: 40', negated: false, note: null },
    },
  ],
};

async function openPanel(page: Page, extensionId: string, context: Parameters<typeof openDevtoolsPage>[0]) {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<button data-testid="apply-coupon">Apply coupon</button>' }),
  );
  await page.goto(`${ORIGIN}/cart`);
  return openDevtoolsPage(context, extensionId, 'devtools-panel.html', page);
}

/**
 * Answers the panel's site requests with `grant` (then with `globalThis.__grant`) and keeps them, and keeps the
 * scripts it injects instead of injecting them: the inspected tab of the stub does not exist. Waits for the panel to
 * have read the page.
 */
async function stubPageTools(panel: Page, grant: boolean): Promise<void> {
  await expect(panel.locator('html')).toHaveAttribute('data-ready', 'true');
  await panel.evaluate((granted) => {
    const g = globalThis as unknown as { __grant: boolean; __asked: string[]; __injected: unknown[] };
    g.__grant = granted;
    g.__asked = [];
    g.__injected = [];
    chrome.permissions.request = ((request: { origins?: string[] }) => {
      g.__asked.push(...(request.origins ?? []));
      return Promise.resolve(g.__grant);
    }) as typeof chrome.permissions.request;
    chrome.scripting.executeScript = ((injection: { target: { tabId: number }; files: string[] }) => {
      if (!g.__grant) return Promise.reject(new Error('Cannot access contents of the page.'));
      g.__injected.push({ tabId: injection.target.tabId, files: injection.files });
      return Promise.resolve([]);
    }) as unknown as typeof chrome.scripting.executeScript;
  }, grant);
}

function pageToolCalls(panel: Page): Promise<{ asked: string[]; injected: Array<{ tabId: number; files: string[] }> }> {
  return panel.evaluate(() => {
    const g = globalThis as unknown as { __asked: string[]; __injected: Array<{ tabId: number; files: string[] }> };
    return { asked: g.__asked, injected: g.__injected };
  });
}

function setSession(panel: Page, values: Record<string, unknown>): Promise<void> {
  return panel.evaluate((v) => chrome.storage.session.set(v), values);
}

/**
 * The Piwi panel (`devtools-panel.html`), opened as a tab with
 * `chrome.devtools` stubbed. It reads the real session storage of the
 * extension, which the spec writes as the recorder and the replay would.
 */
test.describe('the Piwi panel', () => {
  test('follows a recording as it is captured, stops it, and exports it', async ({ context, extensionId }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const shop = await context.newPage();
    const panel = await openPanel(shop, extensionId, context);
    await expect(panel.getByRole('tab', { name: 'Record' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByText('Nothing is being recorded.')).toBeVisible();

    const recording = { active: true, startedAt: 1, grantedOriginPattern: `${ORIGIN}/*`, mode: 'actions' };
    await setSession(panel, { piwiRecording: { ...recording, events: [click('apply-coupon', 'Apply coupon', 1)] } });
    await expect(panel.getByRole('status')).toHaveText(`Recording on ${ORIGIN}: 1 step`);
    await expect(panel.getByRole('listitem')).toHaveCount(1);
    await expect(panel.getByRole('listitem').first().locator('code')).toHaveText("getByTestId('apply-coupon')");

    // A step captured on the page shows up without a reload.
    await setSession(panel, {
      piwiRecording: {
        ...recording,
        events: [click('apply-coupon', 'Apply coupon', 1), click('checkout', 'Checkout', 2)],
      },
    });
    await expect(panel.getByRole('status')).toHaveText(`Recording on ${ORIGIN}: 2 steps`);

    // Paused from the bar on the page: the panel says so until it resumes.
    const twoSteps = [click('apply-coupon', 'Apply coupon', 1), click('checkout', 'Checkout', 2)];
    await setSession(panel, { piwiRecording: { ...recording, events: twoSteps, paused: true } });
    await expect(panel.getByRole('status')).toHaveText(`Paused on ${ORIGIN}: 2 steps`);
    await setSession(panel, { piwiRecording: { ...recording, events: twoSteps, paused: false } });
    await expect(panel.getByRole('status')).toHaveText(`Recording on ${ORIGIN}: 2 steps`);

    await panel.getByRole('button', { name: 'Stop recording' }).click();
    await expect(panel.getByRole('status')).toHaveText('Recording stopped: 2 steps, not exported yet');
    expect(
      await panel.evaluate(
        async () => ((await chrome.storage.session.get('piwiRecording')).piwiRecording as { active: boolean }).active,
      ),
    ).toBe(false);

    await panel.getByRole('button', { name: 'Copy as TypeScript' }).click();
    await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
    const spec = await panel.evaluate(() => navigator.clipboard.readText());
    expect(spec).toContain("await page.getByTestId('apply-coupon').click();");
    expect(spec).toContain("await page.getByTestId('checkout').click();");

    const download = panel.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download steps' }).click();
    expect((await download).suggestedFilename()).toMatch(/^piwi-steps-.*\.json$/);

    await panel.getByRole('button', { name: 'Discard' }).click();
    await expect(panel.getByText('Nothing is being recorded.')).toBeVisible();
  });

  test('follows a replay, pauses and stops it, and says the verdict', async ({ context, extensionId }) => {
    const shop = await context.newPage();
    const panel = await openPanel(shop, extensionId, context);
    await panel.getByRole('tab', { name: 'Replay' }).click();
    await expect(panel.getByText('No replay yet.')).toBeVisible();

    const replay = {
      id: 'r1',
      steps: REPORT,
      origin: ORIGIN,
      position: 1,
      results: [{ status: 'done', detail: null }],
      status: 'running',
      stepMode: true,
      cursor: null,
      startedAt: 0,
    };
    await setSession(panel, { piwiReplay: replay });
    await expect(panel.getByRole('status')).toHaveText(`Replaying · ${ORIGIN}`);
    const steps = panel.getByRole('listitem');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(1).locator('.glyph [data-icon="play"]')).toHaveCount(1);
    await expect(steps.nth(1).locator('code')).toHaveText("getByTestId('apply-coupon')");
    await expect(panel.getByRole('button', { name: 'Next step' })).toBeVisible();

    await panel.getByRole('button', { name: 'Pause' }).click();
    await expect(panel.getByRole('status')).toHaveText(`Paused · ${ORIGIN}`);
    await panel.getByRole('button', { name: 'Stop' }).click();
    await expect
      .poll(() =>
        panel.evaluate(
          async () => ((await chrome.storage.session.get('piwiReplay')).piwiReplay as { status: string }).status,
        ),
      )
      .toBe('stopped');

    // The replay finishes on the page: the panel shows the verdict.
    await setSession(panel, {
      piwiReplay: {
        ...replay,
        position: 3,
        status: 'done',
        results: [
          { status: 'done', detail: null },
          { status: 'done', detail: null },
          { status: 'failed', detail: null, found: '"Total: 40"' },
        ],
      },
    });
    await expect(panel.getByRole('status')).toHaveText(`Replayed · ${ORIGIN}`);
    await expect(panel.getByText('Reproduced: the bug shows here')).toBeVisible();
  });

  test('Pause and Continue release only a wait in progress, Next step and Stop a wait to come too', async ({
    context,
    extensionId,
  }) => {
    const shop = await context.newPage();
    const panel = await openPanel(shop, extensionId, context);
    await panel.getByRole('tab', { name: 'Replay' }).click();
    // What the panel sends the replayed site's tabs.
    await panel.evaluate(() => {
      const sent: unknown[] = [];
      (globalThis as { __sent?: unknown[] }).__sent = sent;
      chrome.tabs.query = (() => Promise.resolve([{ id: 1 }])) as unknown as typeof chrome.tabs.query;
      chrome.tabs.sendMessage = ((_tabId: number, message: unknown) => {
        sent.push(message);
        return Promise.resolve();
      }) as typeof chrome.tabs.sendMessage;
    });
    const sent = () =>
      panel.evaluate(() => (globalThis as { __sent?: Array<{ wake: unknown }> }).__sent!.map((m) => m.wake));
    const replay = {
      id: 'r1',
      steps: REPORT,
      origin: ORIGIN,
      position: 1,
      results: [{ status: 'done', detail: null }],
      status: 'running',
      stepMode: true,
      cursor: null,
      startedAt: 0,
    };
    await setSession(panel, { piwiReplay: replay });

    await panel.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(sent).toEqual(['waiting']);
    await panel.getByRole('button', { name: 'Continue' }).click();
    await expect.poll(sent).toEqual(['waiting', 'waiting']);
    await panel.getByRole('button', { name: 'Next step' }).click();
    await expect.poll(sent).toEqual(['waiting', 'waiting', true]);
    await panel.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(sent).toEqual(['waiting', 'waiting', true, true]);
  });

  test('asks for the site inside the click, then runs Pick, Lint and the Playwright view in the inspected tab', async ({
    context,
    extensionId,
  }) => {
    const shop = await context.newPage();
    const panel = await openPanel(shop, extensionId, context);
    await stubPageTools(panel, true);
    await panel.getByRole('button', { name: 'Pick', exact: true }).click();
    await panel.getByRole('button', { name: 'Lint', exact: true }).click();
    await panel.getByRole('button', { name: 'Playwright view' }).click();
    await expect
      .poll(() => pageToolCalls(panel))
      .toEqual({
        asked: [`${ORIGIN}/*`, `${ORIGIN}/*`, `${ORIGIN}/*`],
        injected: [
          { tabId: 987_654_321, files: ['pick.js'] },
          { tabId: 987_654_321, files: ['lint-overlay.js'] },
          { tabId: 987_654_321, files: ['playwright-view.js'] },
        ],
      });
    await expect(panel.locator('#notice')).toBeEmpty();
  });

  test('says so when the site is refused, and asks again with Allow on this site', async ({ context, extensionId }) => {
    const shop = await context.newPage();
    const panel = await openPanel(shop, extensionId, context);
    await stubPageTools(panel, false);
    await panel.getByRole('button', { name: 'Playwright view' }).click();
    await expect(panel.getByText(`Piwi Picker needs access to ${ORIGIN} to read this page.`)).toBeVisible();
    await panel.evaluate(() => {
      (globalThis as unknown as { __grant: boolean }).__grant = true;
    });
    await panel.getByRole('button', { name: 'Allow on this site' }).click();
    await expect
      .poll(async () => (await pageToolCalls(panel)).injected)
      .toEqual([{ tabId: 987_654_321, files: ['playwright-view.js'] }]);
    await expect(panel.locator('#notice')).toBeEmpty();
  });

  test('offers Tested elements once an instance is connected and the site mapped to a project', async ({
    context,
    extensionId,
  }) => {
    const shop = await context.newPage();
    const panel = await openPanel(shop, extensionId, context);
    await stubPageTools(panel, true);
    const tested = panel.getByRole('button', { name: 'Tested elements' });
    await expect(tested).toHaveAttribute('aria-disabled', 'true');
    await expect(tested).toHaveAttribute('title', 'Connect to your Piwi instance to see what your tests reach');
    // Marked disabled, it still answers a click with what is missing (Playwright waits for an enabled button).
    await tested.click({ force: true });
    await expect(panel.locator('#notice')).toContainText('Connect to your Piwi instance');
    await expect(panel.getByRole('button', { name: 'Open Piwi Picker settings' })).toBeVisible();

    // Connected, but no pattern covers the inspected site.
    const connect = (urlPattern: string) =>
      panel.evaluate(
        (pattern) =>
          chrome.storage.local.set({
            piwiConnection: {
              instanceUrl: 'http://piwi.test',
              projectMappings: [{ urlPattern: pattern, projectId: 1, projectLabel: 'Shop' }],
            },
          }),
        urlPattern,
      );
    await connect('http://elsewhere.test/**');
    await expect(tested).toHaveAttribute('title', /^No project is set for this page\./);
    await expect(tested).toHaveAttribute('aria-disabled', 'true');

    await connect(`${ORIGIN}/**`);
    await expect(tested).toHaveAttribute('aria-disabled', 'false');
    await expect(tested).toHaveAttribute('title', 'What your tests reach on this page, and what they miss');
    await panel.getByRole('button', { name: 'Close' }).click();
    await tested.click();
    await expect
      .poll(async () => (await pageToolCalls(panel)).injected)
      .toEqual([{ tabId: 987_654_321, files: ['coverage-overlay.js'] }]);
  });

  test('opens Save login for tests for the inspected tab', async ({ context, extensionId }) => {
    const shop = await context.newPage();
    const panel = await openPanel(shop, extensionId, context);
    const opened = context.waitForEvent('page');
    await panel.getByRole('button', { name: 'Save login for tests' }).click();
    const login = await opened;
    await login.waitForLoadState();
    expect(login.url()).toContain('/login.html?tabId=987654321&url=');
    await expect(login.getByText(`Site: ${ORIGIN}`)).toBeVisible();
  });
});

trustedTest.describe('the Piwi panel on a site the extension may run on', () => {
  trustedTest.use({
    pages: { '/shop': '<!doctype html><title>Shop</title><button data-testid="buy">Buy</button>' },
  });

  trustedTest('starts Pick and Lint in the inspected tab itself', async ({ context, worker, site }) => {
    const shop = await context.newPage();
    await shop.goto(`${site}/shop`);
    const tabId = await tabIdOf(worker, `${site}/shop`);
    const panel = await openDevtoolsPage(context, new URL(worker.url()).host, 'devtools-panel.html', shop, { tabId });
    await expect(panel.locator('html')).toHaveAttribute('data-ready', 'true');
    // The site is granted already: the request answers without a prompt, as Chrome answers it.
    await panel.evaluate(() => {
      chrome.permissions.request = (() => Promise.resolve(true)) as typeof chrome.permissions.request;
    });
    await panel.getByRole('button', { name: 'Lint', exact: true }).click();
    await expect(shop.locator('#piwi-lint-overlay-host')).toBeAttached();
    await panel.getByRole('button', { name: 'Pick', exact: true }).click();
    await expect(shop.locator('#__piwi_picker_banner')).toHaveCount(1);
    await expect(panel.locator('#notice')).toBeEmpty();
  });
});

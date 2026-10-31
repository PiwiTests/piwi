// The sandboxed webview in Chromium, with the extension's message boundary supplied by the test.
import * as fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { pausedPageHtml } from '../../src/run-control.ts';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

async function preview(page) {
  await page.setViewportSize({ width: 800, height: 540 });
  await page.setContent(
    '<body style="font:24px sans-serif;background:#fff;padding:32px"><h2>Checkout</h2><p>Canvas tote · €24.00</p><label>Coupon <input value="SUMMER"></label><p><button>Pay now</button></p></body>',
  );
  const data = (await page.screenshot({ type: 'jpeg' })).toString('base64');
  const view = {
    image: { mime: 'image/jpeg', data, width: 1280, height: 864 },
    caption: 'Paused · Fill coupon · checkout.spec.ts:12',
    pick: { shown: 7 },
    live: { shown: 7, on: false, input: true, interacting: false, clickCounts: true },
  };
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      // The theme variables the VS Code host supplies to its webviews.
      document.documentElement.style.setProperty('--vscode-font-family', 'system-ui');
      document.documentElement.style.setProperty('--vscode-descriptionForeground', '#666');
    });
    window.messages = [];
    window.acquireVsCodeApi = () => ({
      postMessage: (message) => {
        window.messages.push(message);
        if (message.type === 'input') window.postMessage({ type: 'input-result', id: message.id, ok: true }, '*');
      },
    });
  });
  const script = fs.readFileSync(new URL('../../dist/paused-page.js', import.meta.url), 'utf8');
  await page.route('http://piwi.test/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('/paused-page.js')
        ? { contentType: 'text/javascript', body: script }
        : { contentType: 'text/html', body: pausedPageHtml(view, 'test-nonce', 'http://piwi.test/paused-page.js') },
    ),
  );
  await page.goto('http://piwi.test/preview');
  await expect.poll(() => page.evaluate(() => window.messages.some((m) => m.type === 'ready'))).toBe(true);
  const state = async () => page.evaluate((view) => window.postMessage({ type: 'state', view }, '*'), view);
  await state();
  await expect(page.locator('#page')).toBeVisible();
  return { view, state };
}

test('watch and interaction are opt-in, help stays closed, and clicks still pick by default', async ({
  page,
}, testInfo) => {
  await preview(page);
  await expect(page.getByLabel('Watch live')).not.toBeChecked();
  await expect(page.getByLabel('Interact', { exact: true })).toBeDisabled();
  await expect(page.locator('details')).not.toHaveAttribute('open');
  await page.locator('#page').click({ position: { x: 100, y: 80 } });
  const messages = await page.evaluate(() => window.messages);
  expect(messages.filter((m) => m.type === 'pick')).toEqual([expect.objectContaining({ shown: 7, x: 100, y: 80 })]);
  expect(messages.filter((m) => m.type === 'input' || m.type === 'view')).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('paused-page.png') });
});

test('plays scaled input only after interaction, keeps focus through frames, and releases it with Escape', async ({
  page,
}) => {
  const { view, state } = await preview(page);
  await page.getByLabel('Watch live').check();
  expect(await page.evaluate(() => window.messages)).toContainEqual({ type: 'view', shown: 7, on: true });
  view.live.on = true;
  await state();
  await page.getByLabel('Interact', { exact: true }).check();
  view.live.interacting = true;
  await state();
  await page.locator('#page').click({ position: { x: 100, y: 80 } });
  await page.keyboard.type('hello');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.messages
          .filter((m) => m.type === 'input')
          .flatMap((m) => m.events)
          .some((e) => e.type === 'key' && e.key === 'o'),
      ),
    )
    .toBe(true);
  const events = await page.evaluate(() => window.messages.filter((m) => m.type === 'input').flatMap((m) => m.events));
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'mouse',
      action: 'down',
      x: expect.any(Number),
      y: expect.any(Number),
      clickCount: 1,
    }),
  );
  const down = events.find((e) => e.type === 'mouse' && e.action === 'down');
  expect(down.x).toBeCloseTo((100 * 1280) / 776, 0);
  view.note = 'Live';
  await state();
  await expect(page.locator('#page')).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('Live');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Watch live')).toBeFocused();
  expect(await page.evaluate(() => window.messages)).toContainEqual({ type: 'release', shown: 7 });
  await page.keyboard.down('Shift');
  await page.locator('#page').click({ position: { x: 40, y: 30 } });
  await page.keyboard.up('Shift');
  expect(await page.evaluate(() => window.messages)).toContainEqual(
    expect.objectContaining({ type: 'pick', shown: 7, x: 40, y: 30 }),
  );
  await page.getByLabel('Watch live').uncheck();
  expect(await page.evaluate(() => window.messages)).toContainEqual({ type: 'view', shown: 7, on: false });
});

test('ignores another stop’s state and keeps guidance compact at a narrow width', async ({ page }) => {
  const { view, state } = await preview(page);
  await page.setViewportSize({ width: 375, height: 650 });
  await page.evaluate(
    (view) =>
      window.postMessage({ type: 'state', view: { ...view, caption: 'Stale', live: { ...view.live, shown: 6 } } }, '*'),
    view,
  );
  await expect(page.locator('#caption')).toHaveText(view.caption);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await state();
  await expect(page.locator('details')).not.toHaveAttribute('open');
});

test('Escape cancels queued input and a double click keeps its click count', async ({ page }) => {
  const { view, state } = await preview(page);
  view.live.on = true;
  view.live.interacting = true;
  await state();
  await expect(page.getByLabel('Interact', { exact: true })).toBeChecked();
  await page.locator('#page').dblclick({ position: { x: 100, y: 80 } });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.messages
          .filter((m) => m.type === 'input')
          .flatMap((m) => m.events)
          .some((e) => e.type === 'mouse' && e.action === 'up' && e.clickCount === 2),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.messages = [];
    const picture = document.getElementById('page');
    picture.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true, clientX: 120, clientY: 220 }),
    );
    picture.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  await expect(page.getByLabel('Watch live')).toBeFocused();
  // Past the batch interval: a cancelled down must not arrive after the release.
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.messages.filter((m) => m.type === 'input'))).toEqual([]);
});

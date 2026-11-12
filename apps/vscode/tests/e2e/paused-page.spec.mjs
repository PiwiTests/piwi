// The sandboxed webview in Chromium, with the extension's message boundary supplied by the test.
import * as fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { pausedPageHtml } from '../../src/run-control.ts';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

async function preview(page, extra = {}, image = 'The page of the paused test') {
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
    ...extra,
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
  await expect(page.getByRole('img', { name: image })).toBeVisible();
  return { view, state };
}

test('watch and interaction are opt-in, help stays closed, and clicks still pick by default', async ({
  page,
}, testInfo) => {
  await preview(page);
  await expect(page.getByLabel('Watch live')).not.toBeChecked();
  await expect(page.getByLabel('Interact', { exact: true })).toBeDisabled();
  await expect(page.getByRole('group')).not.toHaveAttribute('open');
  await page.getByRole('img', { name: 'The page of the paused test' }).click({ position: { x: 100, y: 80 } });
  const messages = await page.evaluate(() => window.messages);
  expect(messages.filter((m) => m.type === 'pick')).toEqual([expect.objectContaining({ shown: 7, x: 100, y: 80 })]);
  expect(messages.filter((m) => m.type === 'input' || m.type === 'view')).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('paused-page.png') });
});

test('plays scaled input only after interaction, keeps focus through frames, and Escape turns Interact off', async ({
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
  await page.getByRole('img', { name: 'The page of the paused test' }).click({ position: { x: 100, y: 80 } });
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
  await expect(page.getByRole('img', { name: 'The page of the paused test' })).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('Live');
  // While a pick runs in the test's window, Escape is the page's: it goes there, and Interact stays on.
  view.acting = true;
  await state();
  const acting = await page.evaluate(() => window.messages.length);
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      page.evaluate(
        (from) =>
          window.messages
            .slice(from)
            .filter((m) => m.type === 'input')
            .flatMap((m) => m.events),
        acting,
      ),
    )
    .toEqual([{ type: 'key', action: 'press', key: 'Escape' }]);
  await expect(page.getByLabel('Interact', { exact: true })).toBeChecked();
  view.acting = false;
  await state();
  // Checking Watch live and Interact posted releases of their own: only what follows Escape counts.
  const before = await page.evaluate(() => window.messages.length);
  await page.keyboard.press('Escape');
  // Escape lets go of the input held, then turns Interact off, which gives the stop back.
  await expect(page.getByLabel('Interact', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Interact', { exact: true })).not.toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.messages.some((m) => m.type === 'interact' && m.on === false)))
    .toBe(true);
  const escaped = (await page.evaluate(() => window.messages)).slice(before).filter((m) => m.type !== 'input');
  expect(escaped[0]).toEqual({ type: 'release', shown: 7 });
  expect(escaped.filter((m) => m.type === 'interact')).toEqual([{ type: 'interact', shown: 7, on: false }]);
  expect(escaped.slice(-2)).toEqual([
    { type: 'release', shown: 7 },
    { type: 'interact', shown: 7, on: false },
  ]);
  await page.keyboard.down('Shift');
  await page.getByRole('img', { name: 'The page of the paused test' }).click({ position: { x: 40, y: 30 } });
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
  await expect(page.getByText(view.caption, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await state();
  await expect(page.getByRole('group')).not.toHaveAttribute('open');
});

test('Escape sends the input queued before it, then the release, and a double click keeps its click count', async ({
  page,
}) => {
  const { view, state } = await preview(page);
  view.live.on = true;
  view.live.interacting = true;
  await state();
  await expect(page.getByLabel('Interact', { exact: true })).toBeChecked();
  await page.getByRole('img', { name: 'The page of the paused test' }).dblclick({ position: { x: 100, y: 80 } });
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
  await expect(page.getByLabel('Interact', { exact: true })).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.messages.some((m) => m.type === 'interact' && m.on === false)))
    .toBe(true);
  // Past the batch interval: the press goes out, its button and its key up again, before the release, and nothing
  // after Interact went off.
  await page.waitForTimeout(100);
  const messages = await page.evaluate(() => window.messages);
  const sent = messages.filter((m) => m.type === 'input').flatMap((m) => m.events);
  expect(sent.map((e) => [e.type, e.action, e.key ?? e.button])).toEqual([
    ['key', 'down', 'Control'],
    ['mouse', 'down', 'left'],
    ['mouse', 'up', 'left'],
    ['key', 'up', 'Control'],
  ]);
  expect(messages.slice(-2)).toEqual([
    { type: 'release', shown: 7 },
    { type: 'interact', shown: 7, on: false },
  ]);
});

test('Watch live off sends the click held back for a second one, then the release, then turns the view off', async ({
  page,
}) => {
  const { view, state } = await preview(page, {
    live: { shown: 7, on: true, input: true, interacting: true, clickCounts: false },
  });
  await state();
  await expect(page.getByLabel('Interact', { exact: true })).toBeChecked();
  // A click held back for a second one, then Watch live off, and the extension's state of a frame meanwhile.
  await page.evaluate((view) => {
    window.messages = [];
    const picture = document.getElementById('page');
    const box = picture.getBoundingClientRect();
    const at = { bubbles: true, button: 0, detail: 1, clientX: box.left + 100, clientY: box.top + 80 };
    picture.dispatchEvent(new MouseEvent('mousedown', at));
    picture.dispatchEvent(new MouseEvent('mouseup', at));
    document.getElementById('live').click();
    window.postMessage({ type: 'state', view }, '*');
  }, view);
  await expect
    .poll(() => page.evaluate(() => window.messages.map((m) => m.type)))
    .toEqual(['input', 'release', 'view']);
  const [sent, , off] = await page.evaluate(() => window.messages);
  expect(sent.events).toEqual([expect.objectContaining({ type: 'mouse', action: 'click', clickCount: 1 })]);
  expect(off).toEqual({ type: 'view', shown: 7, on: false });
  await expect(page.getByLabel('Watch live')).not.toBeChecked();
});

test('the worker panel watches its slot, dims an image of what the worker left, and offers Interact at a stop alone', async ({
  page,
}) => {
  const image = "The page of the worker's test";
  const { view, state } = await preview(
    page,
    {
      caption: 'Worker 2 · Running · checkout › pays',
      lane: true,
      stale: false,
      pick: null,
      live: { shown: 7, on: true, input: false, interacting: false, clickCounts: true },
    },
    image,
  );
  await expect(page.getByLabel('Watch', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Interact', { exact: true })).toBeDisabled();
  await expect(page.getByText('Watch shows the page of the test this worker runs', { exact: false })).toBeHidden();
  await expect(page.getByRole('img', { name: image })).not.toHaveClass(/stale/);
  // The worker stopped: the image of its test running stays, dimmed, and Interact is offered.
  view.caption = "Worker 2 · Paused · Click getByRole('button') · checkout.spec.ts:12";
  view.stale = true;
  view.live.input = true;
  await state();
  await expect(page.getByText(view.caption, { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: image })).toHaveClass(/stale/);
  await expect(page.getByLabel('Interact', { exact: true })).toBeEnabled();
  view.stale = false;
  await state();
  await expect(page.getByRole('img', { name: image })).not.toHaveClass(/stale/);
  // Interact stays on while the worker runs to its next stop: shown off while it runs, on again at the stop.
  view.live.interacting = true;
  view.live.input = false;
  await state();
  await expect(page.getByLabel('Interact', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Interact', { exact: true })).not.toBeChecked();
  view.live.input = true;
  await state();
  await expect(page.getByLabel('Interact', { exact: true })).toBeChecked();
  await page.getByLabel('Watch', { exact: true }).uncheck();
  expect(await page.evaluate(() => window.messages)).toContainEqual({ type: 'view', shown: 7, on: false });
});

test('the worker panel shows its slot’s next stop in its document, the strip’s images kept, its messages naming it', async ({
  page,
}) => {
  const image = "The page of the worker's test";
  const { view, state } = await preview(
    page,
    {
      caption: 'Worker 2 · Paused · checkout.spec.ts:12',
      lane: true,
      stale: false,
      pick: null,
      live: { shown: 7, on: true, input: true, interacting: true, clickCounts: true },
      layers: { text: true, filmstrip: true, note: null },
    },
    image,
  );
  const strip = [{ call: 'c1', title: 'Click', index: 1 }];
  await page.evaluate(
    ([strip, data]) => window.postMessage({ type: 'layers', shown: 7, strip, images: { c1: data } }, '*'),
    [strip, view.image.data],
  );
  await expect(page.getByRole('button', { name: '1. Click' })).toBeVisible();
  // The next stop: a view of its own in the same document, which keeps the image of the strip it holds.
  view.caption = 'Worker 2 · Paused · checkout.spec.ts:14';
  view.live = { ...view.live, shown: 8 };
  await state();
  await expect(page.getByText(view.caption, { exact: true })).toBeVisible();
  await page.evaluate(
    (strip) =>
      window.postMessage({ type: 'layers', shown: 8, strip: [...strip, { call: 'c2', title: 'Fill', index: 2 }] }, '*'),
    strip,
  );
  await expect(page.getByRole('button', { name: '1. Click' })).toBeVisible();
  expect(await page.evaluate(() => window.messages.filter((m) => m.type === 'ready'))).toHaveLength(1);
  // A state of the view before changes nothing now; the input and the toggles name the new view.
  await page.evaluate(
    (view) =>
      window.postMessage({ type: 'state', view: { ...view, caption: 'Stale', live: { ...view.live, shown: 7 } } }, '*'),
    view,
  );
  await expect(page.getByText(view.caption, { exact: true })).toBeVisible();
  await page.getByRole('img', { name: image }).click({ position: { x: 100, y: 80 } });
  await expect
    .poll(() => page.evaluate(() => window.messages.filter((m) => m.type === 'input').map((m) => m.shown)))
    .toEqual([8]);
  // Take the text again is off until the extension says its ask was answered.
  const again = page.getByRole('button', { name: 'Take the text again' });
  await again.click();
  await expect(again).toBeDisabled();
  expect(await page.evaluate(() => window.messages)).toContainEqual({ type: 'text', shown: 8 });
  view.layers = { ...view.layers, textAsking: false };
  await state();
  await expect(again).toBeEnabled();
  await page.getByLabel('Watch', { exact: true }).uncheck();
  expect(await page.evaluate(() => window.messages)).toContainEqual({ type: 'view', shown: 8, on: false });
});

test('the worker panel offers Open the trace so far while its worker can open its trace, and asks for it once', async ({
  page,
}) => {
  const image = "The page of the worker's test";
  const { view, state } = await preview(
    page,
    {
      caption: 'Worker 2 · Between tests',
      lane: true,
      stale: false,
      pick: null,
      live: { shown: 7, on: true, input: false, interacting: false, clickCounts: true },
    },
    image,
  );
  const trace = page.getByRole('button', { name: 'Open the trace so far' });
  await expect(trace).toBeHidden();
  // The worker runs a test its reporter can open the trace of: the button shows beside Watch and Interact.
  view.caption = 'Worker 2 · Running · checkout › pays';
  view.trace = { asking: false };
  await state();
  await expect(trace).toBeVisible();
  await expect(trace).toHaveAttribute(
    'title',
    'Open this test’s trace up to now in Playwright’s trace viewer, on the machine the run runs on',
  );
  // Off from the click until the extension says the service answered.
  await trace.click();
  await expect(trace).toBeDisabled();
  expect(await page.evaluate(() => window.messages.filter((m) => m.type === 'trace'))).toEqual([
    { type: 'trace', shown: 7 },
  ]);
  view.trace = { asking: true };
  await state();
  await expect(trace).toBeDisabled();
  view.trace = { asking: false };
  await state();
  await expect(trace).toBeEnabled();
  // The test ended: the button goes until the worker's next one.
  view.caption = 'Worker 2 · Between tests';
  view.trace = null;
  await state();
  await expect(trace).toBeHidden();
});

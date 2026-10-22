import { test, expect, type Page } from '@playwright/test';
import { installPickerOverlay, type PickerOverlayArg } from '../../src/overlay-element.js';
import { probeElementAttrs } from '../../src/probe.js';

const FIXTURE = `<!doctype html><html><body>
  <div id="wrap"><span id="inner">Click me</span></div>
  <button id="submit" data-testid="submit-btn">Submit</button>
</body></html>`;

const install = (page: Page, arg: PickerOverlayArg) => page.evaluate(installPickerOverlay, arg);

const dispatchKey = (page: Page, key: string) =>
  page.evaluate(
    (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })),
    key,
  );

/** `window.parent === window` at the top level — patching `postMessage` lets a plain page stand in for the sandboxed iframe. */
async function recordPostMessages(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as any).__piwiMessages = [];
    const orig = window.postMessage.bind(window);
    window.postMessage = (msg: unknown, ...rest: unknown[]) => {
      (globalThis as any).__piwiMessages.push(msg);
      return (orig as (...a: unknown[]) => unknown)(msg, ...rest);
    };
  });
}

const messagesOfType = (page: Page, type: string) =>
  page.evaluate((t) => (globalThis as any).__piwiMessages.filter((m: any) => m?.type === t), type);

test.describe('installPickerOverlay — global transport (live page)', () => {
  test('click reports the picked element via globalThis and suppresses stray pointer events', async ({ page }) => {
    await page.setContent(FIXTURE);
    await install(page, { transport: 'global', failing: null });
    await page.hover('#submit');
    await page.click('#submit');
    const state = await page.evaluate(() => (globalThis as any).__piwiPickState);
    expect(state).toBe('picked');
    const pickedId = await page.evaluate(() => (globalThis as any).__piwiPickedElement.id);
    expect(pickedId).toBe('submit');
  });

  test('Escape reports skipped and removes the overlay chrome', async ({ page }) => {
    await page.setContent(FIXTURE);
    await install(page, { transport: 'global', failing: "getByText('Pay now')" });
    await expect(page.locator('#__piwi_picker_banner')).toBeVisible();
    await dispatchKey(page, 'Escape');
    const state = await page.evaluate(() => (globalThis as any).__piwiPickState);
    expect(state).toBe('skipped');
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(0);
  });

  test('shows the hovered element locator on the element and in the banner', async ({ page }) => {
    await page.setContent(FIXTURE);
    await install(page, { transport: 'global', failing: null });
    await page.hover('#submit');
    await expect(page.locator('#__piwi_picker_label')).toBeVisible();
    await expect(page.locator('#__piwi_picker_label')).toContainText("getByTestId('submit-btn')");
    await expect(page.locator('#__piwi_picker_label')).toContainText('<button>');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("getByTestId('submit-btn')");
  });

  test('a host describe hook supplies the locator the overlay shows', async ({ page }) => {
    await page.setContent(FIXTURE);
    await page.evaluate(() => {
      (globalThis as any).__piwiDescribeElement = (el: Element) => `getByRole('button', { name: '${el.id}' })`;
    });
    await install(page, { transport: 'global', failing: null });
    await page.hover('#submit');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("getByRole('button', { name: 'submit' })");
  });

  test('speaks English by default, and the host’s texts when it gives them', async ({ page }) => {
    await page.setContent(FIXTURE);
    await install(page, { transport: 'global', failing: null });
    const banner = page.locator('#__piwi_picker_banner');
    await expect(banner).toContainText('Piwi inspector — click any element to generate locators for it');
    await expect(page.locator('#__piwi_picker_foot')).toHaveText('↑ parent · ↓ child · Esc skip');
    await dispatchKey(page, 'Escape');

    await page.evaluate(() => delete (globalThis as any).__piwiPickState);
    await install(page, {
      transport: 'global',
      failing: null,
      strings: {
        banner: 'Inspecteur Piwi, cliquez sur un élément',
        keys: '↑ parent · ↓ enfant',
        keysHovering: 'cliquez pour choisir',
        analyzing: 'Analyse…',
      },
    });
    await expect(banner).toHaveText(/^Inspecteur Piwi, cliquez sur un élément/);
    const foot = page.locator('#__piwi_picker_foot');
    await expect(foot).toHaveText('↑ parent · ↓ enfant');
    await page.hover('#submit');
    await expect(foot).toHaveText('cliquez pour choisir');
    await page.click('#submit');
    await expect(foot).toHaveText('Analyse…');
  });

  test('a text the host leaves empty keeps its English', async ({ page }) => {
    await page.setContent(FIXTURE);
    await install(page, { transport: 'global', failing: null, strings: { banner: '', keys: 'keys only' } });
    await expect(page.locator('#__piwi_picker_banner')).toContainText('Piwi inspector — click any element');
    await expect(page.locator('#__piwi_picker_foot')).toHaveText('keys only');
  });

  test('ArrowUp walks to the parent before the click commits', async ({ page }) => {
    await page.setContent(FIXTURE);
    await install(page, { transport: 'global', failing: null });
    await page.hover('#inner');
    await dispatchKey(page, 'ArrowUp');
    await page.click('#inner', { force: true });
    const pickedId = await page.evaluate(() => (globalThis as any).__piwiPickedElement.id);
    expect(pickedId).toBe('wrap');
  });
});

test.describe('installPickerOverlay — postMessage transport (snapshot picker)', () => {
  test('click probes inline and posts elementPicked, staying inert afterward', async ({ page }) => {
    await page.setContent(FIXTURE);
    await recordPostMessages(page);
    await page.evaluate((probeSrc) => {
      // Mirrors what the host's script-tag builder does at a source level:
      // install the probe on a well-known global before the overlay runs.
      (globalThis as any).__piwiProbe = new Function(`return (${probeSrc})`)();
    }, probeElementAttrs.toString());
    await install(page, {
      transport: 'postMessage',
      probeArg: { keep: ['id', 'data-testid'], includeStructural: false },
    });
    expect((await messagesOfType(page, 'pickerReady')).length).toBe(1);

    await page.hover('#submit');
    await page.click('#submit');
    const picked = await messagesOfType(page, 'elementPicked');
    expect(picked).toHaveLength(1);
    expect(picked[0].attrs.attributes['data-testid']).toBe('submit-btn');

    // The snapshot stays inert through the review step — a stray click must
    // still do nothing (freezeAfterPick's intent), not resume picking.
    const clicksBefore = (await messagesOfType(page, 'elementPicked')).length;
    await page.click('#submit', { force: true });
    expect((await messagesOfType(page, 'elementPicked')).length).toBe(clicksBefore);
  });

  test('Escape posts pickerClosed', async ({ page }) => {
    await page.setContent(FIXTURE);
    await recordPostMessages(page);
    await install(page, {
      transport: 'postMessage',
      probeArg: { keep: [], includeStructural: false },
    });
    await dispatchKey(page, 'Escape');
    expect((await messagesOfType(page, 'pickerClosed')).length).toBe(1);
    await expect(page.locator('#__piwi_picker_banner')).toHaveCount(0);
  });

  test('forwards a piwiPickerKey message into the tree walk', async ({ page }) => {
    await page.setContent(FIXTURE);
    await recordPostMessages(page);
    await page.evaluate((probeSrc) => {
      (globalThis as any).__piwiProbe = new Function(`return (${probeSrc})`)();
    }, probeElementAttrs.toString());
    await install(page, {
      transport: 'postMessage',
      probeArg: { keep: ['id'], includeStructural: false },
    });
    await page.hover('#inner');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("locator('#inner')");
    // The iframe rarely holds focus in the real snapshot picker, so its host
    // forwards arrow keys via postMessage instead of a real keydown — confirm
    // the walk actually moves before asserting on the eventual pick.
    await page.evaluate(() => window.postMessage({ type: 'piwiPickerKey', key: 'ArrowUp' }, '*'));
    await expect(page.locator('#__piwi_picker_locator')).toContainText("locator('#wrap')");
    await page.click('#inner', { force: true });
    const picked = await messagesOfType(page, 'elementPicked');
    expect(picked[picked.length - 1]!.attrs.attributes.id).toBe('wrap');
  });
});

test.describe('installPickerOverlay — the project’s test id attribute', () => {
  const CARD = `<!doctype html><html><body>
    <div id="card" data-test="card"><span id="inner">Card</span></div>
    <button id="go" data-test="go-btn" data-testid="lib-button">Go</button>
  </body></html>`;

  test('the overlay’s own description reads it', async ({ page }) => {
    await page.setContent(CARD);
    await install(page, { transport: 'global', failing: null, testIdAttribute: 'data-test' });
    await page.hover('#go');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("getByTestId('go-btn')");
  });

  test('a hover snaps to an ancestor that carries it', async ({ page }) => {
    await page.setContent(CARD);
    await install(page, { transport: 'global', failing: null, testIdAttribute: 'data-test' });
    await page.hover('#inner');
    await page.click('#inner', { force: true });
    expect(await page.evaluate(() => (globalThis as any).__piwiPickedElement.id)).toBe('card');
  });

  test('without it, data-testid is what the overlay reads', async ({ page }) => {
    await page.setContent(CARD);
    await install(page, { transport: 'global', failing: null });
    await page.hover('#go');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("getByTestId('lib-button')");
    await page.hover('#inner');
    await page.click('#inner', { force: true });
    expect(await page.evaluate(() => (globalThis as any).__piwiPickedElement.id)).toBe('inner');
  });
});

test.describe('installPickerOverlay — shadow roots', () => {
  // `<x-card>` holds a button in an open shadow root, `<x-sealed>` one in a closed root.
  const SHADOW = `<!doctype html><html><body style="margin-top:120px">
    <section id="list"><x-card id="card"></x-card></section>
    <x-sealed id="sealed"></x-sealed>
    <script>
      const open = document.getElementById('card').attachShadow({ mode: 'open' });
      open.innerHTML = '<div id="frame"><button id="buy"><span id="buy-text">Buy</span></button></div>';
      const closed = document.getElementById('sealed').attachShadow({ mode: 'closed' });
      closed.innerHTML = '<button id="hidden">Hidden</button>';
    </script>
  </body></html>`;
  const inShadow = (page: Page, id: string) => page.locator('#card').locator(`#${id}`);
  const pickedId = (page: Page) => page.evaluate(() => (globalThis as any).__piwiPickedElement?.id ?? null);

  test('a control inside an open shadow root is outlined on hover and picked on click', async ({ page }) => {
    await page.setContent(SHADOW);
    await install(page, { transport: 'global', failing: null });
    await inShadow(page, 'buy-text').hover();
    await expect(page.locator('#__piwi_picker_label')).toContainText('<button>');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("locator('#buy')");
    const outline = await page.locator('#__piwi_picker_highlight').boundingBox();
    expect(outline).toEqual(await inShadow(page, 'buy').boundingBox());
    await inShadow(page, 'buy-text').click();
    expect(await pickedId(page)).toBe('buy');
  });

  test('the chain walks out of the shadow root through its host', async ({ page }) => {
    await page.setContent(SHADOW);
    await install(page, { transport: 'global', failing: null });
    await inShadow(page, 'buy').hover();
    for (let i = 0; i < 3; i++) await dispatchKey(page, 'ArrowUp');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("locator('#list')");
    await dispatchKey(page, 'ArrowDown');
    await expect(page.locator('#__piwi_picker_locator')).toContainText("locator('#card')");
    await inShadow(page, 'buy').click({ force: true });
    expect(await pickedId(page)).toBe('card');
  });

  test('a closed shadow root stays at its host', async ({ page }) => {
    await page.setContent(SHADOW);
    await install(page, { transport: 'global', failing: null });
    await page.hover('#sealed');
    await page.click('#sealed');
    expect(await pickedId(page)).toBe('sealed');
  });
});

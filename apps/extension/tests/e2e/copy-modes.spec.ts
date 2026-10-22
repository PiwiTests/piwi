import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { servePages } from './engine-bundle.js';
import { stubChromeI18n } from './i18n-stub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');
const ORIGIN = 'https://copy-modes.test';
const RESULTS = '#piwi-picker-results-host';

const FORM = `<!doctype html><html><body style="margin-top:120px">
  <label>Email <input id="email" value="ada@example.com"></label>
  <label>Password <input id="password" type="password" value="hunter2"></label>
  <label><input id="terms" type="checkbox" checked> I accept the terms</label>
  <label>Size <select id="size"><option value="s">Small</option><option value="m" selected>Medium</option></select></label>
  <button id="pay">Pay now</button>
</body></html>`;

/** Runs a copied line as a test body would, against `page`. */
async function runPasted(page: Page, line: string): Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (page: Page, assert: typeof expect) => Promise<void>;
  await new AsyncFunction('page', 'expect', line)(page, expect);
}

async function openForm(context: BrowserContext): Promise<Page> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await stubChromeI18n(context);
  const page = await context.newPage();
  await servePages(page, ORIGIN, { 'form.html': FORM });
  await page.goto(`${ORIGIN}/form.html`);
  return page;
}

/** Picks `selector` with the real `pick.js` and copies the top row in the mode its button is named for. */
async function copyTop(page: Page, selector: string, buttons: string[]): Promise<string[]> {
  await page.evaluate(() => {
    (globalThis as { __piwiTestOpenShadow?: boolean }).__piwiTestOpenShadow = true;
  });
  await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
  await expect(page.getByText('click any element to generate locators')).toBeVisible();
  await page.hover(selector);
  await page.click(selector);
  const row = page.locator(`${RESULTS} .row`).first();
  // The anchors step, when it offers the field's label as a parent.
  const skip = page.getByRole('button', { name: 'Skip (Esc)' });
  await expect(row.or(skip)).toBeVisible();
  if (await skip.isVisible()) await skip.click();
  await expect(row).toBeVisible();
  const copied: string[] = [];
  for (const name of buttons) {
    await row.getByRole('button', { name, exact: true }).click();
    copied.push(await page.evaluate(() => navigator.clipboard.readText()));
  }
  await page.keyboard.press('Escape');
  await expect(page.locator(RESULTS)).toHaveCount(0);
  return copied;
}

/**
 * The pick results' Action and Assertion copy modes write what the picked
 * element calls for, and each line runs as pasted into a test.
 */
test.describe('the copy modes of the pick results', () => {
  test('a text field fills what it holds and asserts its value', async ({ context }) => {
    const page = await openForm(context);
    const [fill, value] = await copyTop(page, '#email', ['Action (fill)', 'Assertion (toHaveValue)']);
    expect(fill).toMatch(/\.fill\('ada@example\.com'\);$/);
    expect(value).toMatch(/\.toHaveValue\('ada@example\.com'\);$/);
    await page.locator('#email').fill('');
    await runPasted(page, fill!);
    await runPasted(page, value!);
  });

  test('a password field fills a placeholder, never what it holds', async ({ context }) => {
    const page = await openForm(context);
    const [fill, name] = await copyTop(page, '#password', ['Action (fill)', 'Assertion (toHaveAccessibleName)']);
    expect(fill).toMatch(/\.fill\('value'\);$/);
    expect(`${fill}${name}`).not.toContain('hunter2');
    await runPasted(page, fill!);
    await runPasted(page, name!);
  });

  test('a checkbox is checked, a select chooses its option, a button is clicked', async ({ context }) => {
    const page = await openForm(context);
    const [check, checked] = await copyTop(page, '#terms', ['Action (check)', 'Assertion (toBeChecked)']);
    expect(check).toMatch(/\.check\(\);$/);
    expect(checked).toMatch(/\.toBeChecked\(\);$/);
    await page.locator('#terms').uncheck();
    await runPasted(page, check!);
    await runPasted(page, checked!);

    const [select, selected] = await copyTop(page, '#size', ['Action (selectOption)', 'Assertion (toHaveValue)']);
    expect(select).toMatch(/\.selectOption\('m'\);$/);
    expect(selected).toMatch(/\.toHaveValue\('m'\);$/);
    await page.locator('#size').selectOption('s');
    await runPasted(page, select!);
    await runPasted(page, selected!);

    const [click, text] = await copyTop(page, '#pay', ['Action (click)', 'Assertion (toHaveText)']);
    expect(click).toMatch(/\.click\(\);$/);
    expect(text).toMatch(/\.toHaveText\('Pay now'\);$/);
    await runPasted(page, text!);
  });
});

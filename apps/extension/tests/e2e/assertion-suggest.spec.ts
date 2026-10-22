import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { playwrightLocator } from './playwright-locator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

interface ExposedCandidate {
  method: 'toHaveValue' | 'toHaveValues' | 'toHaveText' | 'toHaveAccessibleName' | 'toBeVisible';
  detail: string | null;
  values?: string[];
  expectLine: string;
}

interface ExposedSuggestion {
  locator: string | null;
  candidates: ExposedCandidate[];
}

/**
 * `suggestAssertions` calls @piwitests/core's `generateAlternatives`, which
 * has its own web of private module-level helpers (`attr`, `esc`, etc.) —
 * like `lint-scan.spec.ts`, this drives the real built `assertion-panel.js`
 * and reads what it bridges out to `globalThis.__piwiAssertionSuggestion`
 * (see that file) instead of attempting `Function.prototype.toString()`
 * reconstruction, which can't carry those helpers along.
 */
async function pickAndSuggest(page: Page, targetSelector: string): Promise<ExposedSuggestion> {
  await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
  await page.hover(targetSelector);
  await page.click(targetSelector);
  await expect.poll(() => page.evaluate(() => !!(globalThis as any).__piwiAssertionSuggestion)).toBe(true);
  return page.evaluate(() => (globalThis as any).__piwiAssertionSuggestion as ExposedSuggestion);
}

/** `pickAndSuggest` for an element pointing at would act on (a multiple select): the pick is answered as the overlay answers it. */
async function suggestFor(page: Page, targetSelector: string): Promise<ExposedSuggestion> {
  await page.evaluate(() => delete (globalThis as any).__piwiAssertionSuggestion);
  await page.addScriptTag({ path: path.join(DIST, 'assertion-panel.js') });
  await expect(page.getByText('click any element to generate locators')).toBeVisible();
  await page.evaluate((selector) => {
    (globalThis as any).__piwiPickedElement = document.querySelector(selector);
    (globalThis as any).__piwiPickState = 'picked';
  }, targetSelector);
  await expect.poll(() => page.evaluate(() => !!(globalThis as any).__piwiAssertionSuggestion)).toBe(true);
  const suggestion = await page.evaluate(() => (globalThis as any).__piwiAssertionSuggestion as ExposedSuggestion);
  await page.keyboard.press('Escape');
  return suggestion;
}

test.describe('suggestAssertions (via the real built assertion-panel.js)', () => {
  test('a plain button with text gets toHaveText, toHaveAccessibleName, and toBeVisible — no toHaveValue', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button data-testid="submit-btn">Submit</button>
    </body></html>`);
    const { locator, candidates } = await pickAndSuggest(page, '[data-testid="submit-btn"]');

    expect(locator).toBe(`getByTestId('submit-btn')`);
    expect(candidates.map((c) => c.method)).toEqual(['toHaveText', 'toHaveAccessibleName', 'toBeVisible']);
    expect(candidates[0]).toEqual({
      method: 'toHaveText',
      detail: 'Submit',
      expectLine: `await expect(page.getByTestId('submit-btn')).toHaveText('Submit');`,
    });
    expect(candidates[2]).toEqual({
      method: 'toBeVisible',
      detail: null,
      expectLine: `await expect(page.getByTestId('submit-btn')).toBeVisible();`,
    });
  });

  test('a tab with a count badge is named as Playwright names it, and its locator resolves in Playwright', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin-top:120px">
      <div role="tablist"><button role="tab" id="tab">Regressions<span style="display:inline-flex">5</span></button></div>
    </body></html>`);
    const { locator, candidates } = await pickAndSuggest(page, '#tab');

    expect(locator).toBe(`getByRole('tab', { name: 'Regressions 5' })`);
    expect(candidates.find((c) => c.method === 'toHaveAccessibleName')?.detail).toBe('Regressions 5');
    await expect(playwrightLocator(page, locator!)).toHaveAccessibleName('Regressions 5');
    // toHaveText compares the element's text, which has no space.
    await expect(playwrightLocator(page, locator!)).toHaveText('Regressions5');
  });

  test('a paragraph, which takes no name from its text, gets no toHaveAccessibleName', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <p>Free shipping from 30 €.</p>
    </body></html>`);
    const { locator, candidates } = await suggestFor(page, 'p');

    expect(locator).not.toBeNull();
    expect(candidates.map((c) => c.method)).toEqual(['toHaveText', 'toBeVisible']);
    await expect(playwrightLocator(page, locator!)).toHaveAccessibleName('');
  });

  test('a field named by its label asserts that name, as Playwright computes it', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <label for="city">Delivery city</label> <input id="city" />
    </body></html>`);
    const { locator, candidates } = await suggestFor(page, 'input');

    expect(candidates.map((c) => c.method)).toEqual(['toHaveAccessibleName', 'toBeVisible']);
    expect(candidates[0]!.expectLine).toBe(`await expect(page.${locator}).toHaveAccessibleName('Delivery city');`);
    await expect(playwrightLocator(page, locator!)).toHaveAccessibleName('Delivery city');
  });

  test('whitespace in text content is normalized (collapsed and trimmed)', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button data-testid="msg-btn">   Hello   \n   World   </button>
    </body></html>`);
    const { candidates } = await pickAndSuggest(page, '[data-testid="msg-btn"]');

    const textCandidate = candidates.find((c) => c.method === 'toHaveText');
    expect(textCandidate?.detail).toBe('Hello World');
    expect(textCandidate?.expectLine).toContain(`toHaveText('Hello World')`);
  });

  test('a text input with a value and placeholder gets toHaveValue and toHaveAccessibleName, not toHaveText', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <input data-testid="email-input" value="user@example.com" placeholder="Email" />
    </body></html>`);
    const { locator, candidates } = await pickAndSuggest(page, '[data-testid="email-input"]');

    expect(locator).toBe(`getByTestId('email-input')`);
    expect(candidates.map((c) => c.method)).toEqual(['toHaveValue', 'toHaveAccessibleName', 'toBeVisible']);
    expect(candidates[0]).toMatchObject({ detail: 'user@example.com' });
    expect(candidates[1]).toMatchObject({ detail: 'Email' });
  });

  test('a checkbox does not get toHaveValue (checked state, not value, is the relevant signal)', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <input type="checkbox" data-testid="agree-checkbox" checked />
    </body></html>`);
    const { candidates } = await pickAndSuggest(page, '[data-testid="agree-checkbox"]');

    expect(candidates.map((c) => c.method)).not.toContain('toHaveValue');
  });

  test('a password field, one shown in clear, and a card number never offer their value', async ({ context }) => {
    for (const field of [
      '<input type="password" aria-label="Password" value="hunter2" />',
      '<input autocomplete="cc-number" aria-label="Card number" value="4111111111111111" />',
      '<input autocomplete="section-pay cc-csc" aria-label="Security code" value="737" />',
    ]) {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html><body>${field}</body></html>`);
      const { candidates } = await pickAndSuggest(page, 'input');
      expect(
        candidates.map((c) => c.method),
        field,
      ).toEqual(['toHaveAccessibleName', 'toBeVisible']);
      await page.close();
    }

    // Seen as a password once, it stays one when the page shows it in clear.
    const page = await context.newPage();
    await page.setContent(
      `<!doctype html><html><body><input type="password" aria-label="Password" value="hunter2" /></body></html>`,
    );
    await suggestFor(page, 'input');
    await page.evaluate(() => (document.querySelector('input')!.type = 'text'));
    const { candidates } = await suggestFor(page, 'input');
    expect(JSON.stringify(candidates)).not.toContain('hunter2');
  });

  test('a value keeps its line breaks escaped, and a multiple select asserts every selected value', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <textarea data-testid="notes"></textarea>
      <select data-testid="tags" multiple>
        <option value="a" selected>A</option><option value="b">B</option><option value="it's" selected>C</option>
      </select>
    </body></html>`);
    await page.locator('textarea').fill('line one\nline two\u2028three');
    const notes = await suggestFor(page, 'textarea');
    expect(notes.candidates[0]!.expectLine).toBe(
      "await expect(page.getByTestId('notes')).toHaveValue('line one\\nline two\\u2028three');",
    );

    const tags = await suggestFor(page, 'select');
    expect(tags.candidates[0]).toEqual({
      method: 'toHaveValues',
      detail: null,
      values: ['a', "it's"],
      expectLine: "await expect(page.getByTestId('tags')).toHaveValues(['a', 'it\\'s']);",
    });
    await expect(playwrightLocator(page, tags.locator!)).toHaveValues(['a', "it's"]);
  });

  test('an element with no identifying attributes, text, or role yields no locator and no candidates', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div style="width:60px;height:20px;"></div>
    </body></html>`);
    const { locator, candidates } = await pickAndSuggest(page, 'div');

    expect(locator).toBeNull();
    expect(candidates).toEqual([]);
  });
});

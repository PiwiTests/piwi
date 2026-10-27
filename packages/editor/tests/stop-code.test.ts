/**
 * The code made at a stopped test, rendered for its place in the file as it stands: a check, a region's ARIA snapshot
 * and a mock, above the stopped statement, on the page expression in scope there, with the import lines it needs; and
 * the locator at a caret.
 */
import { describe, expect, test } from 'vitest';
import ts from 'typescript';
import type { RecordedSession, RecordedStep } from '@piwitests/core/recording';
import type { FileEdit } from '../src/protocol';
import { caretLocator, renderStopCode, stopCodeRefusal } from '../src/stop-code';

const SPEC = [
  "import { test } from '@playwright/test';",
  '',
  "test('pays', async ({ page }) => {",
  "  await page.goto('/cart');",
  "  await page.getByRole('button', { name: 'Pay' }).click();",
  '});',
  '',
].join('\n');

const PAGE_OBJECT = [
  "import { expect, type Page } from '@playwright/test';",
  '',
  'export class CartPage {',
  '  constructor(private readonly page: Page) {}',
  '',
  '  async pay() {',
  '    await this.page',
  "      .getByRole('button', { name: 'Pay' })",
  '      .click();',
  '  }',
  '}',
  '',
].join('\n');

/** The text once the edits are made, as a client makes them: against the text they were placed in. */
function applied(text: string, edits: FileEdit[]): string {
  const lines = text.split('\n');
  const offset = (p: { line: number; character: number }) =>
    lines.slice(0, p.line).reduce((sum, line) => sum + line.length + 1, 0) + p.character;
  return [...edits]
    .sort((a, b) => offset(b.range.start) - offset(a.range.start))
    .reduce((out, e) => out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end)), text);
}

function check(matcher: 'toHaveText' | 'toBeVisible', expected: string | null): RecordedSession {
  const step: RecordedStep = {
    action: 'assert',
    target: {
      tagName: 'output',
      role: 'status',
      accessibleName: null,
      testId: 'total',
      text: 'Total €72.00',
      alternatives: [{ locator: "getByTestId('total')", method: 'getByTestId', score: 90 }],
    },
    value: null,
    redacted: false,
    pageUrl: 'http://localhost:3000/cart',
    timestamp: 0,
    assertion: { matcher, expected, actual: null, negated: false, note: null },
  };
  return { steps: [step], startedAt: 0, startUrl: 'http://localhost:3000/cart' };
}

const CART = {
  method: 'GET',
  url: 'http://localhost:3000/api/cart?_=1695820800000&token=abc',
  status: 200,
  type: 'application/json',
  body: JSON.stringify({ items: [{ sku: 'TEE' }], password: 'hunter2' }),
};

describe('the code made at a stop', () => {
  test('writes a check above the stopped statement, adding the import of expect the spec lacks', () => {
    const rendered = renderStopCode(SPEC, 4, { action: 'assert', session: check('toHaveText', 'Total €72.00') });
    if ('refusal' in rendered) throw new Error(rendered.refusal);
    expect(rendered.line).toBe(4);
    expect(rendered.code).toBe("  await expect(page.getByTestId('total')).toHaveText('Total €72.00');");
    expect(applied(SPEC, rendered.edits)).toBe(
      [
        "import { test } from '@playwright/test';",
        "import { expect } from '@playwright/test';",
        '',
        "test('pays', async ({ page }) => {",
        "  await page.goto('/cart');",
        "  await expect(page.getByTestId('total')).toHaveText('Total €72.00');",
        "  await page.getByRole('button', { name: 'Pay' }).click();",
        '});',
        '',
      ].join('\n'),
    );
    expect(rendered.warnings).toEqual([]);
  });

  test('writes a region’s ARIA snapshot in a page object, on this.page, above a chain broken over lines', () => {
    const snapshot = '- region "Order summary":\n  - heading "Order summary" [level=2]\n  - text: Total `€72` ${x}';
    const rendered = renderStopCode(PAGE_OBJECT, 8, {
      action: 'assert-region',
      locator: "getByRole('region', { name: 'Order summary' })",
      snapshot,
    });
    if ('refusal' in rendered) throw new Error(rendered.refusal);
    expect(rendered.line).toBe(6);
    // The file imports expect already.
    expect(rendered.edits).toHaveLength(1);
    expect(rendered.code).toBe(
      [
        "    await expect(this.page.getByRole('region', { name: 'Order summary' })).toMatchAriaSnapshot(`",
        '      - region "Order summary":',
        '        - heading "Order summary" [level=2]',
        '        - text: Total \\`€72\\` \\${x}',
        '    `);',
      ].join('\n'),
    );
    const text = applied(PAGE_OBJECT, rendered.edits);
    expect(text.split('\n').slice(5, 13)).toEqual([
      '  async pay() {',
      ...rendered.code.split('\n'),
      '    await this.page',
      "      .getByRole('button', { name: 'Pay' })",
    ]);
    const out = ts.transpileModule(text, { reportDiagnostics: true });
    expect(out.diagnostics ?? []).toEqual([]);
  });

  test('writes a mock of a kept response with its credentials hidden, on the page in scope', () => {
    const rendered = renderStopCode(PAGE_OBJECT, 6, { action: 'mock', response: CART });
    if ('refusal' in rendered) throw new Error(rendered.refusal);
    expect(rendered.code).toBe(
      [
        "    await this.page.route('**/api/cart?_=*&token=**', (route) =>",
        '      route.fulfill({',
        '        json: {',
        '          "items": [',
        '            {',
        '              "sku": "TEE"',
        '            }',
        '          ],',
        '          "password": "<hidden>"',
        '        },',
        '      }),',
        '    );',
      ].join('\n'),
    );
    expect(rendered.code).not.toContain('hunter2');
    expect(rendered.code).not.toContain('abc');
    expect(rendered.warnings).toEqual(['A value named or shaped like a credential is written as <hidden>.']);
    // No import: page.route needs none.
    expect(rendered.edits).toEqual([
      { range: { start: { line: 6, character: 0 }, end: { line: 6, character: 0 } }, newText: `${rendered.code}\n` },
    ]);
  });

  test('writes a body of the largest size kept inline, and a text a page sent as an escaped literal', () => {
    const body = `{"note":"'); process.exit(1); ('${'x'.repeat(200_000)}"}`;
    const rendered = renderStopCode(SPEC, 4, { action: 'mock', response: { ...CART, url: 'http://a.test/n', body } });
    if ('refusal' in rendered) throw new Error(rendered.refusal);
    expect(rendered.code).not.toContain('path:');
    const out = ts.transpileModule(applied(SPEC, rendered.edits), { reportDiagnostics: true });
    expect(out.diagnostics ?? []).toEqual([]);
    const plain = renderStopCode(SPEC, 4, {
      action: 'mock',
      response: { ...CART, type: 'text/plain', body: "it's `done` ${now}\n" },
    });
    if ('refusal' in plain) throw new Error(plain.refusal);
    expect(plain.code).toContain(`body: 'it\\'s \`done\` \${now}\\n'`);
  });

  test('warns of a body written as it came, and of one that holds personal data', () => {
    const html = renderStopCode(SPEC, 4, {
      action: 'mock',
      response: { ...CART, type: 'text/html', body: '<p>Ada, ada@shop.test</p>' },
    });
    if ('refusal' in html) throw new Error(html.refusal);
    expect(html.warnings).toEqual([
      'The body is neither JSON nor a form: it is written as the server sent it, but for its token-shaped values, and may hold other secrets. Read it before you commit it.',
      'The body looks like it holds an email address or a phone number: replace it with made-up data.',
    ]);
    const json = renderStopCode(SPEC, 4, {
      action: 'mock',
      response: { ...CART, url: 'http://a.test/c', body: '{"a":1}' },
    });
    if ('refusal' in json) throw new Error(json.refusal);
    expect(json.warnings).toEqual([]);
  });

  test('refuses a stop outside a test or a function, and a region’s locator it cannot write', () => {
    expect(stopCodeRefusal(SPEC, 0)).toBe(
      'The test is stopped outside a test or a function of this file: nothing can be written there.',
    );
    expect(stopCodeRefusal(SPEC, 4)).toBeNull();
    // The line of the test's declaration, and of a method's: the block would go outside their bodies.
    expect(stopCodeRefusal(SPEC, 2)).toBe(
      'The test is stopped outside a test or a function of this file: nothing can be written there.',
    );
    expect(stopCodeRefusal(PAGE_OBJECT, 5)).toBe(
      'The test is stopped outside a test or a function of this file: nothing can be written there.',
    );
    expect(stopCodeRefusal(PAGE_OBJECT, 6)).toBeNull();
    expect(
      stopCodeRefusal(SPEC.replace("  await page.goto('/cart');", "  if (ready)\n    await page.goto('/cart');"), 4),
    ).toBe('The statement on line 5 is the body of an `if` without braces: put it in braces to write code above it.');
    expect(
      renderStopCode(SPEC, 4, {
        action: 'assert-region',
        locator: "getByRole('x')); process.exit(1); ((0",
        snapshot: '- a',
      }),
    ).toEqual({ refusal: "The region's locator, getByRole('x')); process.exit(1); ((0, is not one Piwi can write." });
    expect(renderStopCode(SPEC, 4, { action: 'assert', session: { steps: [], startedAt: 0, startUrl: '' } })).toEqual({
      refusal: 'Nothing was checked.',
    });
  });

  test('refuses a call in an arrow function’s expression body, at the column the test stopped at', () => {
    const helper = SPEC.replace("  await page.goto('/cart');", "  const go = async () => await page.goto('/cart');");
    const refusal =
      'The call on line 4 is the body of an arrow function without braces, which runs when the arrow is called: put that body in braces to write code above it.';
    expect(stopCodeRefusal(helper, 3, 36)).toBe(refusal);
    expect(renderStopCode(helper, 3, { action: 'mock', response: CART }, { character: 36 })).toEqual({ refusal });
    // The statement after it, and the line without a column, take code as usual.
    expect(stopCodeRefusal(helper, 4, 8)).toBeNull();
    expect(stopCodeRefusal(helper, 3)).toBeNull();
  });
});

describe('the locator at a caret', () => {
  test('reads the chain on the line and the page it starts from, in a spec and in a page object', () => {
    expect(caretLocator(SPEC, 4)).toEqual({ locator: "getByRole('button', { name: 'Pay' })", page: 'page' });
    const pageObject = PAGE_OBJECT.replace(
      "await this.page\n      .getByRole('button', { name: 'Pay' })\n      .click();",
      "await this.page.getByText('Pay').first().click();",
    );
    expect(caretLocator(pageObject, 6)).toEqual({ locator: "getByText('Pay').first()", page: 'this.page' });
  });

  test('says why when the line holds no locator, one with arguments it cannot read, or one off a page', () => {
    expect(caretLocator(SPEC, 3)).toEqual({ refusal: 'No locator on this line.' });
    const text = [
      "test('t', async ({ page }) => {",
      '  const name = "Pay";',
      "  await page.getByRole('button', { name }).click();",
      "  const dialog = page.getByRole('dialog');",
      "  await dialog.getByRole('button').click();",
      '});',
    ].join('\n');
    expect(caretLocator(text, 2)).toEqual({
      refusal: 'The locator on this line is not one Piwi reads: its arguments must be literals.',
    });
    expect(caretLocator(text, 4)).toEqual({
      refusal: 'dialog is not a page in scope on this line: Piwi counts a locator that starts from one.',
    });
    expect(caretLocator("  expect(getByRole('x'));", 0)).toEqual({
      refusal: 'The locator on this line does not start from a page: Piwi counts one that does.',
    });
  });
});

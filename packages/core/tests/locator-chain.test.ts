import { describe, expect, test } from 'vitest';
import {
  canonicalLocator,
  locatorCallValues,
  parseLeafLocatorCall,
  locatorScopes,
  locatorTarget,
  parseLocatorChain,
  quoteJsString,
  renderLocatorChain,
  scanLocatorChain,
  tryParseLocatorChain,
} from '../src/locator-chain';

describe('parseLocatorChain', () => {
  // Every expression below is printed verbatim by Playwright 1.63's formatter.
  test.each([
    "getByRole('button', { name: 'Save' })",
    "getByRole('button', { name: 'Save', exact: true })",
    "getByRole('form', { name: 'Shipping' }).getByLabel('Country')",
    "locator('.field').filter({ hasText: 'Country' }).locator('select')",
    "locator('.field').filter({ has: getByRole('combobox') }).first()",
    "getByRole('row', { name: 'Acme' }).getByRole('button', { name: 'Delete' }).first()",
    "locator('iframe#pay').contentFrame().getByRole('textbox', { name: 'Card' })",
    "getByText('France').locator('..')",
    'getByText(/total: \\d+/i)',
    "getByRole('heading', { name: 'Orders', level: 2 })",
    "getByTestId('address-form').nth(2)",
    "getByRole('button').and(getByTitle('Subscribe'))",
    "getByLabel('Country').or(getByRole('combobox'))",
    "locator('.item').filter({ visible: true })",
  ])('round-trips %s', (expr) => {
    expect(renderLocatorChain(parseLocatorChain(expr))).toBe(expr);
  });

  test('normalizes quotes, spacing and a page. prefix', () => {
    expect(canonicalLocator(`await page.getByRole("button",{name:"Save"})`)).toBe(
      "getByRole('button', { name: 'Save' })",
    );
  });

  test('keeps escaped quotes inside strings', () => {
    const chain = parseLocatorChain("getByText('It\\'s done')");
    expect(chain.calls[0]!.args[0]).toEqual({ type: 'string', value: "It's done" });
    expect(renderLocatorChain(chain)).toBe("getByText('It\\'s done')");
  });

  test.each([
    ['a CR LF pair', 'a\r\nb'],
    ['a tab', 'a\tb'],
    ['an escape character', '\u001b[31m'],
    ['a backspace and a form feed', '\b\f'],
    ['quotes of both kinds and a backslash', `it's "done" \\ ok`],
    ['an emoji', 'Save 💾'],
  ])('renders and reads back %s as Playwright prints it', (_label, text) => {
    // Playwright quotes with JSON.stringify inside single quotes.
    const printed = `getByText('${JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}')`;
    const chain = parseLocatorChain(printed);
    expect(chain.calls[0]!.args[0]).toEqual({ type: 'string', value: text });
    expect(renderLocatorChain(chain)).toBe(printed);
  });

  test('decodes \\x, \\u{…} and \\v escapes', () => {
    expect(parseLocatorChain("getByText('\\x41\\u{1F4BE}\\v')").calls[0]!.args[0]).toEqual({
      type: 'string',
      value: 'A💾\v',
    });
  });

  test.each([
    ['an unknown method', "getByRole('button').click()"],
    ['a narrowing call first', 'first()'],
    ['trailing text', "getByText('a') and more"],
    ['an unterminated string', "getByText('a"],
    ['arbitrary code', "locator(eval('1'))"],
  ])('refuses %s', (_label, expr) => {
    expect(tryParseLocatorChain(expr)).toBeNull();
  });
});

describe('scanLocatorChain', () => {
  test('reads the chain at the start of the text and stops where it ends', () => {
    const text = "getByRole('row', { name: 'A (b)' }).getByRole('button').first().click() to be visible";
    const scanned = scanLocatorChain(text)!;
    expect(renderLocatorChain(scanned.chain)).toBe("getByRole('row', { name: 'A (b)' }).getByRole('button').first()");
    expect(scanned.spans.map((s) => text.slice(s.start, s.end))).toEqual([
      "getByRole('row', { name: 'A (b)' })",
      "getByRole('button')",
      'first()',
    ]);
    expect(text.slice(scanned.end)).toBe('.click() to be visible');
  });

  test('null when the text does not start with a locator call', () => {
    expect(scanLocatorChain("getByRole('button")).toBeNull();
    expect(scanLocatorChain('waiting for')).toBeNull();
  });
});

describe('locatorTarget and locatorScopes', () => {
  test('a chained field: the label is the target, the form the scope', () => {
    const chain = parseLocatorChain("getByRole('form', { name: 'Shipping' }).getByLabel('Country')");
    expect(locatorTarget(chain)).toBe("getByLabel('Country')");
    expect(locatorScopes(chain)).toEqual(["getByRole('form', { name: 'Shipping' })"]);
  });

  test('a filtered container stays whole as the scope', () => {
    const chain = parseLocatorChain("locator('.field').filter({ hasText: 'Country' }).locator('select')");
    expect(locatorTarget(chain)).toBe("locator('select')");
    expect(locatorScopes(chain)).toEqual(["locator('.field').filter({ hasText: 'Country' })"]);
  });

  test('a single call has no scope and is its own target', () => {
    const chain = parseLocatorChain("getByTestId('order-total').first()");
    expect(locatorTarget(chain)).toBe("getByTestId('order-total')");
    expect(locatorScopes(chain)).toEqual([]);
  });
});

describe('parseLeafLocatorCall and locatorCallValues', () => {
  test('the leaf is the last locating call, past narrowing calls', () => {
    const leaf = parseLeafLocatorCall(
      "getByRole('row', { name: 'Acme' }).getByRole('button', { name: 'Delete' }).first()",
    );
    expect(leaf && locatorCallValues(leaf)).toEqual(['button', { name: 'Delete' }]);
    expect(leaf?.method).toBe('getByRole');
  });

  test('values keep options and drop nested locators', () => {
    const leaf = parseLeafLocatorCall("locator('.field', { has: getByRole('combobox'), hasText: 'Country' })");
    expect(leaf && locatorCallValues(leaf)).toEqual(['.field', { hasText: 'Country' }]);
  });

  test('regexes are dropped, or kept as text for display', () => {
    const leaf = parseLeafLocatorCall("getByRole('button', { name: /pay/i })")!;
    expect(locatorCallValues(leaf)).toEqual(['button', {}]);
    expect(locatorCallValues(leaf, { regexAsText: true })).toEqual(['button', { name: '/pay/i' }]);
  });

  test('null for text that is not a locator', () => {
    expect(parseLeafLocatorCall('not a locator')).toBeNull();
  });
});

describe('quoteJsString', () => {
  test('quotes the way Playwright prints a string, on one line', () => {
    expect(quoteJsString('Pay')).toBe("'Pay'");
    expect(quoteJsString(`Don't "stop"`)).toBe(`'Don\\'t "stop"'`);
    expect(quoteJsString('a\\b')).toBe("'a\\\\b'");
    expect(quoteJsString('a\nb\rc\u2028d\u2029e\u001b')).toBe("'a\\nb\\rc\\u2028d\\u2029e\\u001b'");
  });

  test('reads back as the same string', () => {
    for (const value of ["it's", 'a\\"b', 'line\nbreak', '\u2028\u2029', "x'), evil(('", "\\'"]) {
      const call = parseLocatorChain(`getByText(${quoteJsString(value)})`).calls[0]!;
      expect(call.args).toEqual([{ type: 'string', value }]);
    }
  });
});

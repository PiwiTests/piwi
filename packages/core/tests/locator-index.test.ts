import { describe, expect, test } from 'vitest';
import {
  extractLocatorExpressions,
  lookupLocators,
  targetWouldMatch,
  type LocatorIndex,
  type LocatorIndexEntry,
} from '../src/locator-index';
import { parseLocatorChain } from '../src/locator-chain';

function entry(locator: string, tests: number[], actions: string[] = ['click']): LocatorIndexEntry {
  return {
    locator,
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    uses: tests.map((test) => ({ test, actions, callSites: [], projects: [], branches: ['main'] })),
  };
}

function index(locators: LocatorIndexEntry[]): LocatorIndex {
  return {
    projectId: 1,
    projectName: 'shop',
    branch: 'main',
    defaultBranch: 'main',
    branches: [],
    builtAt: null,
    generatedAt: '2026-09-01T00:00:00.000Z',
    testIdAttributes: null,
    tests: [0, 1, 2, 3, 4].map((id) => ({ id, title: `t${id}`, file: 'a.spec.ts', suite: [], status: 'passed' })),
    locators,
    truncated: false,
  };
}

function call(expr: string) {
  const chain = parseLocatorChain(expr);
  return chain.calls[chain.calls.length - 1]!;
}

describe('extractLocatorExpressions', () => {
  test('reads one locator per line, as the extension copies them', () => {
    const text = [
      "getByTestId('pay')",
      "getByRole('button', { name: 'Pay now' })",
      "getByText('Pay now', { exact: true })",
      "locator('#pay')",
    ].join('\n');
    expect(extractLocatorExpressions(text).map((e) => e.locator)).toEqual([
      "getByTestId('pay')",
      "getByRole('button', { name: 'Pay now' })",
      "getByText('Pay now', { exact: true })",
      "locator('#pay')",
    ]);
  });

  test('pulls chains out of test code and stops at the action', () => {
    const code = `
      test('pays', async ({ page }) => {
        await page.getByRole("form", { name: "Shipping" }).getByLabel("Country").selectOption('FR');
        await expect(page.getByTestId('total')).toHaveText('42 €');
        await this.page.locator('.row').filter({ has: page.getByRole('button') }).first().click();
      });`;
    expect(extractLocatorExpressions(code).map((e) => e.locator)).toEqual([
      "getByRole('form', { name: 'Shipping' }).getByLabel('Country')",
      "getByTestId('total')",
      "locator('.row').filter({ has: getByRole('button') }).first()",
    ]);
  });

  test('reads within() and describe() in test code as the chain Playwright reports', () => {
    const code = `
      await page.getByRole('button', { name: 'Save' }).within(page.getByRole('dialog')).click();
      await page.getByTestId('total').describe('Order total').click();`;
    expect(extractLocatorExpressions(code).map((e) => e.locator)).toEqual([
      "getByRole('dialog').locator(getByRole('button', { name: 'Save' }))",
      "getByTestId('total')",
    ]);
  });

  test('keeps nested locators inside the chain that holds them', () => {
    const found = extractLocatorExpressions(
      "getByRole('listitem').filter({ has: getByRole('link', { name: 'Docs' }) })",
    );
    expect(found).toEqual([
      {
        input: "getByRole('listitem').filter({ has: getByRole('link', { name: 'Docs' }) })",
        locator: "getByRole('listitem').filter({ has: getByRole('link', { name: 'Docs' }) })",
      },
    ]);
  });

  test('drops duplicates in any quoting, and ignores words that merely end in locator', () => {
    const found = extractLocatorExpressions(`getByText("Hi")\ngetByText('Hi')\nmylocator('x')`);
    expect(found.map((e) => e.locator)).toEqual(["getByText('Hi')"]);
  });

  test('reports a call that starts like a locator but cannot be read', () => {
    const found = extractLocatorExpressions("getByRole('button', { name: 'Save'\ngetByTestId('ok')");
    expect(found).toEqual([
      { input: "getByRole('button', { name: 'Save'", locator: null },
      { input: "getByTestId('ok')", locator: "getByTestId('ok')" },
    ]);
  });

  test('finds nothing in plain prose', () => {
    expect(extractLocatorExpressions('The pay button is broken on mobile.')).toEqual([]);
  });
});

describe('targetWouldMatch', () => {
  test.each([
    ["getByRole('button', { name: 'Save' })", "getByRole('button', { name: 'Save changes' })", true],
    ["getByRole('button', { name: 'save' })", "getByRole('button', { name: 'Save changes' })", true],
    ["getByRole('button', { name: 'Save', exact: true })", "getByRole('button', { name: 'Save changes' })", false],
    ["getByRole('button', { name: /^save/i })", "getByRole('button', { name: 'Save changes' })", true],
    ["getByRole('button', { name: 'Save' })", "getByRole('link', { name: 'Save' })", false],
    ["getByRole('button')", "getByRole('button', { name: 'Save' })", false],
    ["getByRole('heading', { name: 'Orders', level: 2 })", "getByRole('heading', { name: 'Orders', level: 3 })", false],
    ["getByRole('heading', { name: 'Orders', level: 2 })", "getByRole('heading', { name: 'Orders' })", true],
    ["getByText('Pay')", "getByText('Pay   now')", true],
    ["getByText('Pay now', { exact: true })", "getByText('Pay now')", true],
    ["getByLabel('country')", "getByLabel('Country of residence')", true],
    ["getByPlaceholder('mail')", "getByPlaceholder('Email')", true],
    ["getByPlaceholder('E  mail')", "getByPlaceholder('E mail')", false],
    ["getByTestId('pay')", "getByTestId('pay')", true],
    ["getByTestId('pay')", "getByTestId('Pay')", false],
    ['getByTestId(/^pay-/)', "getByTestId('pay-later')", true],
    ["getByText('Pay')", "getByLabel('Pay')", false],
    ["locator('.pay')", "locator('.pay')", false],
  ])('%s finds the element %s: %s', (indexed, described, expected) => {
    expect(targetWouldMatch(call(indexed), call(described))).toBe(expected);
  });
});

describe('lookupLocators', () => {
  const idx = index([
    entry("getByRole('button', { name: 'Pay now' })", [0, 1]),
    entry("getByRole('dialog').getByRole('button', { name: 'Pay now' })", [2]),
    entry("getByRole('button', { name: 'Pay' })", [3], ['expect.toBeEnabled']),
    entry("getByRole('form', { name: 'Checkout' }).getByLabel('Card number')", [4], ['fill']),
    entry("getByTestId('unrelated')", [1]),
  ]);

  test('ranks the exact chain, then the same target, then similar targets', () => {
    const [result] = lookupLocators(idx, extractLocatorExpressions("getByRole('button', { name: 'Pay now' })"));
    expect(result!.hits.map((h) => [h.kind, h.locator])).toEqual([
      ['exact', "getByRole('button', { name: 'Pay now' })"],
      ['target', "getByRole('dialog').getByRole('button', { name: 'Pay now' })"],
      ['similar', "getByRole('button', { name: 'Pay' })"],
    ]);
    expect(result!.tests.sort()).toEqual([0, 1, 2, 3]);
    expect(result!.hits[2]!.actions).toEqual(['expect.toBeEnabled']);
  });

  test('finds the chains that search inside a container', () => {
    const [result] = lookupLocators(idx, extractLocatorExpressions("getByRole('form', { name: 'Checkout' })"));
    expect(result!.hits).toEqual([
      {
        locator: "getByRole('form', { name: 'Checkout' }).getByLabel('Card number')",
        kind: 'scope',
        tests: [4],
        actions: ['fill'],
      },
    ]);
  });

  test('answers an unused locator and an unreadable one with no hits', () => {
    const results = lookupLocators(idx, [
      { input: "getByRole('link', { name: 'Home' })", locator: "getByRole('link', { name: 'Home' })" },
      { input: 'getByRole(', locator: null },
    ]);
    expect(results.map((r) => [r.locator, r.hits.length])).toEqual([
      ["getByRole('link', { name: 'Home' })", 0],
      [null, 0],
    ]);
  });
});

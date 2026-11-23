import { describe, expect, test } from 'vitest';
import {
  LOCATOR_STABILITY_RULES,
  assessLocator,
  locatorStabilityRule,
  stabilityLabels,
  type LocatorStabilityLevel,
  type LocatorStabilityRuleId,
} from '../src/locator-stability';

const assess = (expr: string) => {
  const result = assessLocator(expr);
  if (!result) throw new Error(`does not parse: ${expr}`);
  return result;
};

const rules = (expr: string) => assess(expr).findings.map((f) => `${f.rule}:${f.level}`);

describe('assessLocator', () => {
  test.each<[string, LocatorStabilityLevel, string[]]>([
    // position
    ["getByRole('listitem').nth(2)", 'brittle', ['position:brittle']],
    ["getByRole('listitem').nth(0)", 'watch', ['position:watch']],
    ["getByRole('row', { name: /Acme/ }).first()", 'watch', ['position:watch']],
    ["getByRole('row').last()", 'watch', ['position:watch']],
    ["locator('li >> nth=3')", 'brittle', ['position:brittle']],
    ["locator('li:nth-match(li, 2)')", 'brittle', ['position:brittle']],
    // css-class
    ["locator('.bg-blue-500')", 'brittle', ['css-class:brittle']],
    ["locator('.css-1q2w3e')", 'brittle', ['css-class:brittle']],
    ["locator('.a1b2c3d4e5')", 'brittle', ['css-class:brittle']],
    ["locator('.product-card')", 'watch', ['css-class:watch']],
    ["locator('.Panel_body__x7k2p')", 'brittle', ['css-class:brittle']],
    ["locator('.ng-valid')", 'brittle', ['css-class:brittle']],
    ["locator('.btn-primary').nth(1)", 'brittle', ['position:brittle', 'css-class:watch']],
    // css-structure
    ["locator('form > div:nth-child(2) input')", 'brittle', ['css-structure:brittle', 'css-structure:brittle']],
    ["locator('ul li a')", 'brittle', ['css-structure:brittle']],
    ["locator('div span')", 'brittle', ['css-structure:brittle']],
    ["locator('label + input')", 'brittle', ['css-structure:brittle']],
    ["locator('tr:first-child')", 'brittle', ['css-structure:brittle']],
    // xpath
    ["locator('//main/div[2]//button')", 'brittle', ['xpath:brittle']],
    ["locator('/html/body/main')", 'brittle', ['xpath:brittle']],
    ["locator('xpath=(//button)[last()]')", 'brittle', ['xpath:brittle']],
    ['locator(\'//button[@type="submit"]\')', 'watch', ['xpath:watch']],
    // generated-id
    ["locator('#input-1748291')", 'brittle', ['generated-id:brittle']],
    ["locator('#radix-:r4:')", 'brittle', ['generated-id:brittle']],
    ['locator(\'[id="headlessui-menu-3"]\')', 'brittle', ['generated-id:brittle']],
    ["locator('id=mui-12345')", 'brittle', ['generated-id:brittle']],
    ["locator('#reka-select-item-text-v-0-0-22-55')", 'brittle', ['generated-id:brittle']],
    ["locator('#v-0-0-22')", 'brittle', ['generated-id:brittle']],
    ["locator('#el-id-4127-12')", 'brittle', ['generated-id:brittle']],
    ['locator(\'[id="_R_0H1_"]\')', 'brittle', ['generated-id:brittle']],
    ['locator(\'[id="base-ui-:r2:"]\')', 'brittle', ['generated-id:brittle']],
    ["locator('#v-1')", 'brittle', ['generated-id:brittle']],
    ["locator('#mat-select-value-1')", 'brittle', ['generated-id:brittle']],
    // style-attribute
    ['locator(\'[style*="display: block"]\')', 'brittle', ['style-attribute:brittle']],
    ['locator(\'div[class="card active"]\')', 'brittle', ['style-attribute:brittle']],
    // long-text
    ["getByText('Sign up today and get twenty percent off your first order')", 'watch', ['long-text:watch']],
    // data-text
    ["getByRole('button', { name: 'Cart (3)' })", 'watch', ['data-text:watch']],
    ["getByText('$19.99')", 'watch', ['data-text:watch']],
    ["getByText('Only 3 left in stock')", 'watch', ['data-text:watch']],
    ["getByText('Delivered on 2026-09-27')", 'watch', ['data-text:watch']],
    ["getByRole('listitem').filter({ hasText: '45%' })", 'watch', ['data-text:watch']],
    ['locator(\'button:has-text("12 results")\')', 'watch', ['data-text:watch']],
    // deep-chain
    [
      "getByRole('main').getByRole('region', { name: 'Orders' }).getByRole('table').getByRole('row', { name: 'Acme' })",
      'watch',
      ['deep-chain:watch'],
    ],
    // nested chains are judged too
    ["getByRole('row').filter({ has: locator('.css-1q2w3e') })", 'brittle', ['css-class:brittle']],
    ["getByRole('button').and(locator('div span'))", 'brittle', ['css-structure:brittle']],
  ])('%s is %s', (expr, level, expected) => {
    const result = assess(expr);
    expect(result.level).toBe(level);
    expect(rules(expr)).toEqual(expected);
  });

  test.each([
    "getByTestId('save')",
    "getByRole('button', { name: 'Save' })",
    "getByRole('button', { name: /pay/i })",
    "getByLabel('Address line 2')",
    "getByLabel('Password')",
    "getByPlaceholder('Search products')",
    "getByAltText('Company logo')",
    "getByTitle('Close')",
    "getByText('Step 2')",
    "getByText('Enable 2FA')",
    "locator('#checkout-form')",
    'locator(\'[name="email"]\')',
    'locator(\'input[name="email"]\')',
    'locator(\'[data-testid="save"]\')',
    "locator('data-testid=save')",
    "locator('button')",
    "locator('#search input')",
    "getByTestId('search').locator('input')",
    "getByRole('listitem').filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' })",
    "getByRole('dialog').getByRole('button', { name: 'Close' })",
    "locator('text=Sign in')",
    "locator('button:visible')",
    "locator('#f').contentFrame().getByText('Hi')",
  ])('%s is stable', (expr) => {
    expect(assess(expr)).toEqual({ level: 'stable', findings: [] });
  });

  test('brittle findings come before watch findings, and each part is named', () => {
    const result = assess("locator('.product-card').nth(2)");
    expect(result.findings).toEqual([
      { rule: 'position', level: 'brittle', detail: 'nth(2)' },
      { rule: 'css-class', level: 'watch', detail: '.product-card' },
    ]);
  });

  test('a part caught twice is listed once', () => {
    expect(assess("locator('.css-1q2w3e').filter({ has: locator('.css-1q2w3e') })").findings).toHaveLength(1);
  });

  test('an expression that does not parse has no verdict', () => {
    expect(assessLocator('page.$("x")')).toBeNull();
  });
});

describe('stabilityLabels', () => {
  test('names each rule once, brittle first', () => {
    expect(stabilityLabels(assess("locator('.btn-primary.css-1q2w3e').nth(1)"))).toBe('position · CSS class');
    expect(stabilityLabels(assess("getByTestId('x')"))).toBe('');
  });
});

describe('LOCATOR_STABILITY_RULES', () => {
  test('every rule has a unique id, a label and a description', () => {
    const ids = LOCATOR_STABILITY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of LOCATOR_STABILITY_RULES) {
      expect(rule.label).toBeTruthy();
      expect(rule.description.length).toBeGreaterThan(20);
      expect(locatorStabilityRule(rule.id as LocatorStabilityRuleId)).toBe(rule);
    }
  });
});

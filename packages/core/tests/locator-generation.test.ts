import { describe, expect, test } from 'vitest';
import {
  approximateAccessibleName,
  generateAlternatives,
  type AncestorAnchor,
  type ElementAttributes,
  type RankedLocator,
} from '../src/locator-generation';
import { parseLocatorChain } from '../src/locator-chain';

const el = (overrides: Partial<ElementAttributes>): ElementAttributes => ({
  tagName: 'div',
  attributes: {},
  textContent: null,
  accessibleName: null,
  center: null,
  ...overrides,
});

describe('approximateAccessibleName', () => {
  test('names a select by its label, never by its options', () => {
    const select = el({
      tagName: 'select',
      attributes: { id: 'country' },
      textContent: 'United KingdomIrelandFrance',
      hasLabel: true,
      labelText: 'Country',
    });
    expect(approximateAccessibleName(select)).toBe('Country');
    expect(approximateAccessibleName({ ...select, labelText: null, hasLabel: false })).toBeNull();
  });

  test('names a textarea by its label, never by its value', () => {
    expect(approximateAccessibleName(el({ tagName: 'textarea', textContent: 'Draft', labelText: 'Message' }))).toBe(
      'Message',
    );
  });

  test('aria-labelledby outranks aria-label, which outranks a label', () => {
    const input = el({ tagName: 'input', attributes: { 'aria-label': 'Aria' }, labelText: 'Label' });
    expect(approximateAccessibleName(input)).toBe('Aria');
    expect(approximateAccessibleName({ ...input, attributes: { ...input.attributes, 'aria-labelledby': 'l' } })).toBe(
      'Label',
    );
  });

  test('anything but a form field is still named by its text', () => {
    expect(approximateAccessibleName(el({ tagName: 'button', textContent: 'Join', labelText: null }))).toBe('Join');
  });

  test('falls back to title, then placeholder', () => {
    expect(approximateAccessibleName(el({ tagName: 'input', attributes: { placeholder: 'Search' } }))).toBe('Search');
    expect(approximateAccessibleName(el({ tagName: 'input', attributes: { title: 'T', placeholder: 'P' } }))).toBe('T');
  });
});

describe('generateAlternatives for a label-named form field', () => {
  test('ranks role + label name and getByLabel above the id and the bare role', () => {
    const attrs = el({
      tagName: 'input',
      attributes: { type: 'checkbox', id: 'news' },
      hasLabel: true,
      labelText: 'Keep me posted on new roasts',
      rolePosition: { role: 'checkbox', count: 1, index: 0 },
    });
    const ranked = generateAlternatives({ ...attrs, accessibleName: approximateAccessibleName(attrs) });
    expect(ranked.map((r) => r.locator).slice(0, 4)).toEqual([
      "getByRole('checkbox', { name: 'Keep me posted on new roasts' })",
      "getByLabel('Keep me posted on new roasts')",
      "locator('#news')",
      "getByRole('checkbox')",
    ]);
  });
});

describe('generateAlternatives with a role from an accessibility model', () => {
  const header = el({
    tagName: 'th',
    attributes: { id: 'price' },
    textContent: 'Price',
    accessibleName: 'Price',
  });

  test('builds the role candidates from the given role, which the tag maps do not know', () => {
    expect(generateAlternatives(header).some((r) => r.method === 'getByRole')).toBe(false);
    const ranked = generateAlternatives(header, { role: 'columnheader' });
    expect(ranked[0]).toMatchObject({ locator: "getByRole('columnheader', { name: 'Price' })", score: 90 });
  });

  test('a null role leaves only the candidates of an element without one', () => {
    const summary = el({ tagName: 'summary', textContent: 'More info', accessibleName: 'More info' });
    expect(generateAlternatives(summary)[0]!.locator).toBe("getByRole('button', { name: 'More info' })");
    const ranked = generateAlternatives(summary, { role: null });
    expect(ranked.some((r) => r.method === 'getByRole')).toBe(false);
    expect(ranked[0]!.locator).toBe("getByText('More info')");
  });

  test('without the option the tag maps decide', () => {
    const button = el({ tagName: 'button', textContent: 'Join', accessibleName: 'Join' });
    expect(generateAlternatives(button, {})).toEqual(generateAlternatives(button));
  });
});

describe('generateAlternatives with the project’s test id attribute', () => {
  const anchor = (overrides: Partial<AncestorAnchor>): AncestorAnchor => ({
    tag: 'div',
    depth: 1,
    testId: null,
    id: null,
    role: null,
    ariaLabel: null,
    scopedRoleCount: 1,
    ...overrides,
  });
  /** A Pay button carrying both attributes, as the probe reads it with `testIdAttribute: 'data-test'`. */
  const pay = (overrides: Partial<ElementAttributes> = {}): ElementAttributes =>
    el({
      tagName: 'button',
      attributes: { 'data-test': 'pay', 'data-testid': 'lib-button' },
      textContent: 'Pay',
      accessibleName: 'Pay',
      selectorCounts: { testId: 1 },
      ...overrides,
    });
  const locators = (ranked: RankedLocator[]) => ranked.map((r) => r.locator);

  test('the element’s own getByTestId comes from that attribute, and data-testid gives none', () => {
    const ranked = generateAlternatives(pay(), { testIdAttribute: 'data-test' });
    expect(ranked[0]).toEqual({
      locator: "getByTestId('pay')",
      method: 'getByTestId',
      args: { testId: 'pay' },
      score: 100,
    });
    expect(locators(ranked).filter((l) => l.includes('lib-button'))).toEqual([]);
  });

  test('a test id of that attribute found more than once gives no getByTestId, and the chains come back', () => {
    const shared = pay({
      selectorCounts: { testId: 3 },
      ancestors: [anchor({ tag: 'section', testId: 'cart', testIdCount: 1 })],
    });
    const ranked = locators(generateAlternatives(shared, { testIdAttribute: 'data-test' }));
    expect(ranked).not.toContain("getByTestId('pay')");
    expect(ranked).toContain("getByTestId('cart').getByRole('button')");
  });

  test('an ancestor’s anchors: its test id is the attribute’s, data-testid an ordinary data-* hook, the attribute itself none', () => {
    const remove = el({
      tagName: 'button',
      attributes: {},
      textContent: 'Remove',
      accessibleName: 'Remove',
      selectorCounts: { roleName: 3 },
      ancestors: [
        anchor({ depth: 1, dataAttr: { name: 'data-test', value: 'row' }, dataAttrCount: 1 }),
        anchor({ depth: 2, dataAttr: { name: 'data-testid', value: 'lib-row' }, dataAttrCount: 1 }),
        anchor({ tag: 'section', depth: 3, testId: 'cart', testIdCount: 1 }),
      ],
    });
    const ranked = generateAlternatives(remove, { testIdAttribute: 'data-test' });
    expect(ranked.find((r) => r.locator === "getByTestId('cart').getByRole('button')")?.score).toBe(72);
    // An ordinary author-chosen data-* scores 60; the test-oriented ones 70.
    expect(ranked.find((r) => r.locator === `locator('[data-testid="lib-row"]').getByRole('button')`)?.score).toBe(60);
    expect(locators(ranked).filter((l) => l.includes('data-test='))).toEqual([]);

    // With Playwright's default, data-test is a test-oriented data-* hook.
    const byDefault = generateAlternatives(remove);
    expect(byDefault.find((r) => r.locator === `locator('[data-test="row"]').getByRole('button')`)?.score).toBe(70);
  });

  test('the attribute is never a locator() candidate, whatever its name and case', () => {
    const field = el({
      tagName: 'input',
      attributes: { name: 'email', id: 'email-field', type: 'email' },
      accessibleName: 'Email',
      selectorCounts: { testId: 1, name: 1, id: 1 },
    });
    const byName = locators(generateAlternatives(field, { testIdAttribute: 'name' }));
    expect(byName).toContain("getByTestId('email')");
    expect(byName).not.toContain(`locator('[name="email"]')`);
    expect(byName).toContain("locator('#email-field')");
    const byId = locators(generateAlternatives(field, { testIdAttribute: 'id' }));
    expect(byId).toContain("getByTestId('email-field')");
    expect(byId.filter((l) => l.includes("locator('#"))).toEqual([]);
    expect(byId).toContain(`locator('[name="email"]')`);

    // A leaf with no test id of its own is scoped by its ancestors: by getByTestId, never by the same id as CSS.
    const signup = anchor({ tag: 'form', id: 'signup', idCount: 1, testId: 'signup', testIdCount: 1 });
    const leaf = el({ tagName: 'input', attributes: { type: 'email' }, accessibleName: 'Email', ancestors: [signup] });
    const scoped = locators(generateAlternatives(leaf, { testIdAttribute: 'id' }));
    expect(scoped).toContain("getByTestId('signup').getByRole('textbox')");
    expect(scoped).not.toContain("locator('#signup').getByRole('textbox')");
    expect(locators(generateAlternatives(leaf))).toContain("locator('#signup').getByRole('textbox')");

    const card = el({
      tagName: 'button',
      textContent: 'Remove',
      accessibleName: 'Remove',
      ancestors: [anchor({ dataAttr: { name: 'data-test', value: 'row' }, dataAttrCount: 1 })],
    });
    expect(locators(generateAlternatives(card, { testIdAttribute: 'data-Test' }))).not.toContain(
      `locator('[data-test="row"]').getByRole('button')`,
    );
  });

  test('unset, null or data-testid: the ranking of Playwright’s default', () => {
    const attrs = el({
      tagName: 'button',
      attributes: { 'data-testid': 'pay', 'data-test': 'pay-2', id: 'pay-button', name: 'pay', class: 'btn-pay' },
      textContent: 'Pay',
      accessibleName: 'Pay',
      selectorCounts: { testId: 1, id: 1, name: 1 },
      ancestors: [
        anchor({ dataAttr: { name: 'data-qa', value: 'row' }, dataAttrCount: 1 }),
        anchor({ tag: 'section', depth: 2, testId: 'cart', testIdCount: 1, id: 'cart', idCount: 1 }),
      ],
    });
    const byDefault = generateAlternatives(attrs);
    expect(byDefault[0]!.locator).toBe("getByTestId('pay')");
    expect(locators(byDefault)).toContain("locator('#pay-button')");
    expect(locators(byDefault)).toContain(`locator('[name="pay"]')`);
    expect(generateAlternatives(attrs, { testIdAttribute: null })).toEqual(byDefault);
    expect(generateAlternatives(attrs, { testIdAttribute: 'data-testid' })).toEqual(byDefault);
    expect(generateAlternatives(attrs, { testIdAttribute: '' })).toEqual(byDefault);
    const roleOnly = { ...attrs, attributes: {}, selectorCounts: {} };
    expect(generateAlternatives(roleOnly, { testIdAttribute: 'data-testid' })).toEqual(generateAlternatives(roleOnly));
  });
});

describe('generateAlternatives with hostile attribute values', () => {
  test('quotes a raw role attribute, so every alternative parses with the role as one string', () => {
    const role = "button'), require('child_process').execSync('id'), ('";
    const ranked = generateAlternatives(
      el({
        tagName: 'div',
        attributes: { role, 'aria-label': 'Pay\nnow', 'data-testid': 'pay\u2028' },
        accessibleName: 'Pay\nnow',
        rolePosition: { role, count: 1, index: 0 },
      }),
    );
    const byRole = ranked.filter((r) => r.method === 'getByRole');
    expect(byRole.length).toBeGreaterThan(0);
    for (const alt of ranked) {
      expect(alt.locator).not.toMatch(/[\n\r\u2028\u2029]/);
      const calls = parseLocatorChain(alt.locator).calls;
      for (const call of calls.filter((c) => c.method === 'getByRole')) {
        expect(call.args[0]).toEqual({ type: 'string', value: role });
      }
    }
  });
});

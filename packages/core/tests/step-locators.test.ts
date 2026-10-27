import { describe, expect, test } from 'vitest';
import {
  extractStepLocatorUse,
  extractStepLocatorUses,
  findLocationRoot,
  isAbsoluteLocation,
  isInteractionAction,
  locationRootOf,
  locatorActionLabel,
  resolveLocationRoot,
  stepLocations,
  stripLocationRoot,
} from '../src/step-locators';

describe('extractStepLocatorUse — Playwright 1.63 steps', () => {
  // Shapes as the reporter stores them: title, Piwi's category, params, subtitle, location.
  test('reads the chain from params.locator and the action from the title', () => {
    const use = extractStepLocatorUse({
      title: 'Select option',
      category: 'input',
      subtitle: "getByRole('form', { name: 'Shipping' }).getByLabel('Country')",
      params: {
        locator: "getByRole('form', { name: 'Shipping' }).getByLabel('Country')",
        options: '[{"valueOrLabel":"FR"}]',
      },
      location: '/work/shop/pages/shipping.page.ts:41:7',
    });
    expect(use).toMatchObject({
      action: 'selectOption',
      locator: "getByRole('form', { name: 'Shipping' }).getByLabel('Country')",
      location: '/work/shop/pages/shipping.page.ts:41:7',
    });
  });

  test('keeps the fill value out of the result', () => {
    const use = extractStepLocatorUse({
      title: 'Fill "Jane Secret"',
      params: { locator: "getByLabel('Name')", value: 'Jane Secret' },
    });
    expect(use?.action).toBe('fill');
    expect(JSON.stringify(use)).not.toContain('Jane Secret');
  });

  test('names assertions by matcher, including negation', () => {
    expect(
      extractStepLocatorUse({
        title: 'Expect "toContainText"',
        params: { locator: "getByTestId('address-form')", expected: 'France' },
      })?.action,
    ).toBe('expect.toContainText');
    expect(
      extractStepLocatorUse({ title: 'Expect "soft not toBeVisible"', params: { locator: "getByText('Error')" } })
        ?.action,
    ).toBe('expect.not.toBeVisible');
  });

  test('a custom expect message still yields the locator', () => {
    const use = extractStepLocatorUse({
      title: 'the total is shown',
      category: 'assertion',
      params: { locator: "getByTestId('total')" },
    });
    expect(use).toMatchObject({ action: 'expect', locator: "getByTestId('total')" });
  });

  test('skips a chain the runner truncated', () => {
    expect(
      extractStepLocatorUse({ title: 'Click', params: { locator: "getByRole('button', { name: 'Very lo…" } }),
    ).toBeNull();
  });

  test('ignores steps without a locator', () => {
    expect(
      extractStepLocatorUse({
        title: 'Navigate',
        params: { url: 'https://shop.test/cart' },
        subtitle: 'https://shop.test/cart',
      }),
    ).toBeNull();
    expect(extractStepLocatorUse({ title: 'Create page' })).toBeNull();
  });
});

describe('extractStepLocatorUse — Playwright 1.61 titles', () => {
  // Titles printed by Playwright 1.61.1 for the same test.
  test.each([
    [
      "Select option getByRole('form', { name: 'Shipping' }).getByLabel('Country')",
      'selectOption',
      "getByRole('form', { name: 'Shipping' }).getByLabel('Country')",
    ],
    ['Fill "Jane Secret" getByLabel(\'Name\')', 'fill', "getByLabel('Name')"],
    [
      "Click locator('.field').filter({ hasText: 'Country' }).locator('select')",
      'click',
      "locator('.field').filter({ hasText: 'Country' }).locator('select')",
    ],
    ['Expect "toContainText" getByTestId(\'address-form\')', 'expect.toContainText', "getByTestId('address-form')"],
    ['Expect "not toHaveValue" getByLabel(\'Country\')', 'expect.not.toHaveValue', "getByLabel('Country')"],
    ["Double click getByRole('row', { name: 'Order 7' })", 'dblclick', "getByRole('row', { name: 'Order 7' })"],
  ])('%s', (title, action, locator) => {
    expect(extractStepLocatorUse({ title })).toMatchObject({ action, locator });
  });

  test('a value ending in a backslash keeps the action', () => {
    expect(extractStepLocatorUse({ title: 'Fill "C:\\" getByLabel(\'Path\')' })).toMatchObject({
      action: 'fill',
      locator: "getByLabel('Path')",
    });
  });

  test('a typed value that looks like a locator does not win', () => {
    const use = extractStepLocatorUse({ title: "Fill \"use getByText('x') here\" getByLabel('Notes')" });
    expect(use).toMatchObject({ action: 'fill', locator: "getByLabel('Notes')" });
  });
});

describe('extractStepLocatorUse — cut values', () => {
  const chain =
    "getByRole('dialog', { name: 'Edit shipping address' }).getByRole('group', { name: 'Address details' }).getByLabel('Country')";

  test('a chain cut with a marker is skipped, even when the cut part parses', () => {
    const cut = `${chain.slice(0, chain.indexOf('.getByLabel'))}…`;
    expect(extractStepLocatorUse({ title: 'Select option', params: { locator: cut }, subtitle: cut })).toBeNull();
  });

  test('a chain exactly at the default cap is skipped: an older reporter cut it without a marker', () => {
    const cut = `getByTestId('${'x'.repeat(200 - "getByTestId('')".length)}')`;
    expect(cut).toHaveLength(200);
    expect(extractStepLocatorUse({ title: 'Click', params: { locator: cut } })).toBeNull();
  });
});

describe('extractStepLocatorUses', () => {
  test('keeps step order and indexes', () => {
    const uses = extractStepLocatorUses([
      { title: 'Navigate', params: { url: '/' } },
      { title: 'Click', params: { locator: "getByRole('link', { name: 'Checkout' })" } },
      null,
      { title: "Click getByRole('button', { name: 'Pay' })" },
    ]);
    expect(uses.map((u) => [u.stepIndex, u.locator])).toEqual([
      [1, "getByRole('link', { name: 'Checkout' })"],
      [3, "getByRole('button', { name: 'Pay' })"],
    ]);
  });

  test('tolerates a non-array', () => {
    expect(extractStepLocatorUses(null)).toEqual([]);
  });

  test("skips the capture's own reads of an element the test used", () => {
    const uses = extractStepLocatorUses([
      { title: 'Click', subtitle: "getByRole('button', { name: 'Pay' })", location: '/w/tests/pay.spec.ts:9:5' },
      {
        title: 'Evaluate',
        subtitle: "getByRole('button', { name: 'Pay' })",
        location: '/w/node_modules/@piwitests/reporter/dist/index.js:7770:17',
      },
    ]);
    expect(uses.map((u) => [u.stepIndex, u.action])).toEqual([[0, 'click']]);
  });
});

describe('locationRootOf and isAbsoluteLocation', () => {
  test('a working directory becomes a root with one trailing slash', () => {
    expect(locationRootOf('/work/shop')).toBe('/work/shop/');
    expect(locationRootOf('C:\\work\\shop\\')).toBe('C:/work/shop/');
    expect(locationRootOf('')).toBeNull();
    expect(locationRootOf(undefined)).toBeNull();
  });

  test.each([
    ['/work/shop/pages/p.ts:1:1', true],
    ['C:/work/p.ts:1:1', true],
    ['pages/p.ts:1:1', false],
    ['../shared/p.ts:1:1', false],
  ])('%s is absolute: %s', (location, absolute) => {
    expect(isAbsoluteLocation(location)).toBe(absolute);
  });
});

describe('findLocationRoot and stripLocationRoot', () => {
  test('finds the root through a location in the test file', () => {
    const root = findLocationRoot(
      ['/work/shop/pages/shipping.page.ts:41:7', '/work/shop/tests/checkout.spec.ts:12:5'],
      'tests/checkout.spec.ts',
    );
    expect(root).toBe('/work/shop/');
    expect(stripLocationRoot('/work/shop/pages/shipping.page.ts:41:7', root)).toBe('pages/shipping.page.ts:41:7');
  });

  test('normalizes Windows separators', () => {
    const root = findLocationRoot(['C:\\work\\shop\\tests\\a.spec.ts:3:1'], 'tests/a.spec.ts');
    expect(stripLocationRoot('C:\\work\\shop\\pages\\p.ts:1:1', root)).toBe('pages/p.ts:1:1');
  });

  test('no root when no step sits in the test file', () => {
    expect(findLocationRoot(['/work/shop/pages/p.ts:1:1'], 'tests/a.spec.ts')).toBeNull();
    expect(stripLocationRoot('/work/shop/pages/p.ts:1:1', null)).toBe('/work/shop/pages/p.ts:1:1');
  });

  test('resolveLocationRoot prefers the working directory when it prefixes a step', () => {
    const locations = ['/work/shop/pages/p.ts:1:1', '/work/shop/tests/a.spec.ts:3:1'];
    expect(resolveLocationRoot(locations, 'tests/a.spec.ts', '/work/shop')).toBe('/work/shop/');
    // Only helpers ran, nothing in the test file: the working directory still strips them.
    expect(resolveLocationRoot(['/work/shop/pages/p.ts:1:1'], 'tests/a.spec.ts', '/work/shop/')).toBe('/work/shop/');
    expect(resolveLocationRoot(['C:\\work\\shop\\pages\\p.ts:1:1'], null, 'C:\\work\\shop')).toBe('C:/work/shop/');
  });

  test('resolveLocationRoot falls back when the working directory prefixes no step', () => {
    // A shard that ran in another workspace than the one the run recorded.
    const locations = ['/ci/job@2/pages/p.ts:1:1', '/ci/job@2/tests/a.spec.ts:3:1'];
    expect(resolveLocationRoot(locations, 'tests/a.spec.ts', '/ci/job')).toBe('/ci/job@2/');
    expect(resolveLocationRoot(['/ci/job@2/pages/p.ts:1:1'], 'tests/a.spec.ts', '/ci/job')).toBeNull();
    expect(resolveLocationRoot(locations, 'tests/a.spec.ts', null)).toBe('/ci/job@2/');
  });

  test('stepLocations reads every step, locator or not', () => {
    expect(stepLocations([{ title: 'Navigate', location: '/a/t.spec.ts:1:1' }, { title: 'x' }, null])).toEqual([
      '/a/t.spec.ts:1:1',
    ]);
  });
});

describe('action vocabulary', () => {
  test('labels actions and expectations in sentence case', () => {
    expect(locatorActionLabel('selectOption')).toBe('Select option');
    expect(locatorActionLabel('expect.toHaveValue')).toBe('Expect toHaveValue');
    expect(locatorActionLabel('expect.not.toBeVisible')).toBe('Expect not toBeVisible');
    expect(locatorActionLabel('somethingNew')).toBe('somethingNew');
  });

  test('tells interactions from assertions and reads', () => {
    expect(['click', 'fill', 'check', 'hover', 'press'].every(isInteractionAction)).toBe(true);
    expect(['expect.toBeVisible', 'count', 'waitFor', 'evaluate', 'other'].some(isInteractionAction)).toBe(false);
  });
});

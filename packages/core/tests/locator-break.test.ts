import { describe, expect, test } from 'vitest';
import type { DiffAnchor } from '../src/diff-anchors';
import { buildLiteralEdit } from '../src/locator-edit';
import { itemsOfFile, predictLocatorBreaks, reachOfIndex, renameValue, sameFilePath } from '../src/locator-break';
import type { LocatorIndex } from '../src/locator-index';

function index(locators: string[], extra: Partial<LocatorIndex> = {}): LocatorIndex {
  return {
    projectId: 1,
    projectName: 'Acme Mugs',
    branch: 'main',
    defaultBranch: 'main',
    branches: [],
    builtAt: null,
    generatedAt: '2026-09-27T00:00:00Z',
    testIdAttributes: null,
    tests: [
      { id: 11, title: 'pays', file: 'tests/checkout.spec.ts', suite: [], status: 'passed' },
      { id: 12, title: 'pays twice', file: 'tests/checkout.spec.ts', suite: [], status: 'passed' },
    ],
    locators: locators.map((locator, i) => ({
      locator,
      lastSeenAt: '2026-09-27T00:00:00Z',
      uses: [
        {
          test: 0,
          actions: ['click'],
          callSites: [`tests/pages/checkout.page.ts:${30 + i}:5`],
          projects: [],
          branches: ['main'],
        },
        {
          test: 1,
          actions: ['click'],
          callSites: [`tests/pages/checkout.page.ts:${30 + i}:5`],
          projects: [],
          branches: ['main'],
        },
      ],
    })),
    truncated: false,
    ...extra,
  };
}

function anchor(a: Partial<DiffAnchor> & Pick<DiffAnchor, 'kind' | 'before'>): DiffAnchor {
  return { file: 'src/components/CheckoutButton.vue', line: 14, oldLine: 14, ...a };
}

function broken(anchors: DiffAnchor[], locators: string[], extra: Partial<LocatorIndex> = {}) {
  return predictLocatorBreaks(anchors, index(locators, extra)).map((b) => ({
    locator: b.locator,
    rewrite: b.rewrite,
    confidence: b.confidence,
  }));
}

const rename = (kind: DiffAnchor['kind'], before: string, after?: string, attribute?: string) =>
  anchor({ kind, before, ...(after !== undefined ? { after } : {}), ...(attribute ? { attribute } : {}) });

describe('predictLocatorBreaks — the matching table', () => {
  test('getByTestId and a test id CSS selector match test id attributes exactly', () => {
    const a = rename('attribute', 'pay-btn', 'pay-button', 'data-testid');
    expect(
      broken([a], ["getByTestId('pay-btn')", 'locator(\'[data-testid="pay-btn"]\')', "getByTestId('pay')"]),
    ).toEqual([
      { locator: "getByTestId('pay-btn')", rewrite: "getByTestId('pay-button')", confidence: 'likely' },
      {
        locator: 'locator(\'[data-testid="pay-btn"]\')',
        rewrite: 'locator(\'[data-testid="pay-button"]\')',
        confidence: 'likely',
      },
    ]);
  });

  test("the project's own test id attribute", () => {
    const a = rename('attribute', 'basket', 'cart', 'data-qa');
    expect(broken([a], ["getByTestId('basket')"], { testIdAttributes: ['data-qa'] })).toHaveLength(1);
    expect(broken([a], ["getByTestId('basket')"])).toHaveLength(0);
  });

  test('getByRole name: text, translation, literal and the naming attributes', () => {
    const chain = "getByRole('button', { name: 'Pay now' })";
    for (const a of [
      rename('text', 'Pay now', 'Pay'),
      rename('translation', 'Pay now', 'Pay'),
      rename('literal', 'Pay now', 'Pay'),
      rename('attribute', 'Pay now', 'Pay', 'aria-label'),
      rename('attribute', 'Pay now', 'Pay', 'title'),
      rename('attribute', 'Pay now', 'Pay', 'alt'),
      rename('attribute', 'Pay now', 'Pay', 'value'),
    ]) {
      expect(broken([a], [chain]), `${a.kind} ${a.attribute ?? ''}`).toEqual([
        {
          locator: chain,
          rewrite: "getByRole('button', { name: 'Pay' })",
          confidence: a.kind === 'literal' ? 'possible' : 'likely',
        },
      ]);
    }
    expect(broken([rename('attribute', 'Pay now', 'Pay', 'placeholder')], [chain])).toEqual([]);
  });

  test('getByText and hasText read text, translation and literal anchors', () => {
    const a = rename('text', 'Apply coupon', 'Use coupon');
    expect(
      broken(
        [a],
        [
          "getByText('Apply coupon')",
          "locator('.row').filter({ hasText: 'Apply coupon' })",
          "locator('li', { hasText: 'apply COUPON' })",
        ],
      ),
    ).toEqual([
      { locator: "getByText('Apply coupon')", rewrite: "getByText('Use coupon')", confidence: 'likely' },
      {
        locator: "locator('.row').filter({ hasText: 'Apply coupon' })",
        rewrite: "locator('.row').filter({ hasText: 'Use coupon' })",
        confidence: 'likely',
      },
      {
        locator: "locator('li', { hasText: 'apply COUPON' })",
        rewrite: "locator('li', { hasText: 'Use coupon' })",
        confidence: 'likely',
      },
    ]);
    expect(broken([rename('attribute', 'Apply coupon', 'x', 'aria-label')], ["getByText('Apply coupon')"])).toEqual([]);
  });

  test('getByLabel reads aria-label as well as text', () => {
    const a = rename('attribute', 'Email address', 'Email', 'aria-label');
    expect(broken([a], ["getByLabel('Email address')"])).toHaveLength(1);
  });

  test('getByPlaceholder, getByAltText and getByTitle read their attribute, translations and literals', () => {
    expect(broken([rename('attribute', 'Search', 'Find', 'placeholder')], ["getByPlaceholder('Search')"])).toHaveLength(
      1,
    );
    expect(broken([rename('attribute', 'Logo', 'Brand', 'alt')], ["getByAltText('Logo')"])).toHaveLength(1);
    expect(broken([rename('attribute', 'Close', 'Dismiss', 'title')], ["getByTitle('Close')"])).toHaveLength(1);
    expect(broken([rename('translation', 'Search', 'Find')], ["getByPlaceholder('Search')"])).toHaveLength(1);
    expect(broken([rename('text', 'Search', 'Find')], ["getByPlaceholder('Search')"])).toHaveLength(0);
  });

  test('#id and [name=…] match id and name attributes exactly', () => {
    expect(broken([rename('attribute', 'email', 'mail', 'id')], ["locator('#email')", "locator('#emails')"])).toEqual([
      { locator: "locator('#email')", rewrite: "locator('#mail')", confidence: 'likely' },
    ]);
    expect(broken([rename('attribute', 'email', 'mail', 'name')], ["locator('input[name=email]')"])).toEqual([
      { locator: "locator('input[name=email]')", rewrite: "locator('input[name=mail]')", confidence: 'likely' },
    ]);
  });
});

describe('predictLocatorBreaks — Playwright text rules', () => {
  test('a rename the call still matches is not a break', () => {
    expect(broken([rename('text', 'Pay now', 'Pay now!')], ["getByRole('button', { name: 'Pay now' })"])).toEqual([]);
    expect(broken([rename('text', 'Pay now', 'Pay')], ["getByText('Pay')"])).toEqual([]);
  });

  test('a substring call breaks when the text is removed', () => {
    expect(broken([rename('text', 'Pay now')], ["getByText('Pay')"])).toEqual([
      { locator: "getByText('Pay')", rewrite: undefined, confidence: 'likely' },
    ]);
  });

  test('exact: case and whole value matter', () => {
    expect(broken([rename('text', 'Pay now', 'Pay')], ["getByText('pay now', { exact: true })"])).toEqual([]);
    expect(broken([rename('text', 'Pay now', 'Pay')], ["getByText('Pay now', { exact: true })"])).toEqual([
      {
        locator: "getByText('Pay now', { exact: true })",
        rewrite: "getByText('Pay', { exact: true })",
        confidence: 'likely',
      },
    ]);
    // An exact 'Pay' does not match 'Pay now', so the removal does not touch it.
    expect(broken([rename('text', 'Pay now')], ["getByRole('button', { name: 'Pay', exact: true })"])).toEqual([]);
  });

  test('a regex breaks with no rewrite', () => {
    expect(broken([rename('text', 'Pay now', 'Checkout')], ["getByRole('button', { name: /pay/i })"])).toEqual([
      { locator: "getByRole('button', { name: /pay/i })", rewrite: undefined, confidence: 'likely' },
    ]);
  });

  test('a value equal to the old string up to case and spacing becomes the new string verbatim', () => {
    expect(broken([rename('text', 'Apply coupon', 'Use voucher')], ["getByText('apply  COUPON')"])).toEqual([
      { locator: "getByText('apply  COUPON')", rewrite: "getByText('Use voucher')", confidence: 'likely' },
    ]);
  });

  test('a nested chain is rewritten in place', () => {
    const chain = "getByRole('listitem').filter({ has: getByRole('button', { name: 'Remove item' }) })";
    expect(broken([rename('attribute', 'Remove item', 'Delete', 'aria-label')], [chain])).toEqual([
      {
        locator: chain,
        rewrite: "getByRole('listitem').filter({ has: getByRole('button', { name: 'Delete' }) })",
        confidence: 'likely',
      },
    ]);
  });
});

describe('predictLocatorBreaks — confidence and scope', () => {
  test('with reach, a break is likely only when a test reaches the file', () => {
    const idx = index(["getByText('Pay now')"]);
    const a = rename('text', 'Pay now', 'Pay');
    expect(predictLocatorBreaks([a], idx, { reach: () => false })[0]!.confidence).toBe('possible');
    expect(predictLocatorBreaks([a], idx, { reach: (id, file) => id === 12 && file === a.file })[0]!.confidence).toBe(
      'likely',
    );
    const locale = anchor({ kind: 'translation', before: 'Pay now', after: 'Pay', file: 'src/locales/en.json' });
    expect(predictLocatorBreaks([locale], idx, { reach: () => false })[0]!.confidence).toBe('likely');
  });

  test('likely breaks come first, carrying their tests and uses', () => {
    const idx = index(["getByText('Total')", "getByText('Pay now')"]);
    const breaks = predictLocatorBreaks([rename('literal', 'Total'), rename('text', 'Pay now', 'Pay')], idx);
    expect(breaks.map((b) => [b.locator, b.confidence])).toEqual([
      ["getByText('Pay now')", 'likely'],
      ["getByText('Total')", 'possible'],
    ]);
    expect(breaks[0]!.tests.map((t) => t.id)).toEqual([11, 12]);
    expect(breaks[0]!.uses[0]!.callSites).toEqual(['tests/pages/checkout.page.ts:31:5']);
    expect(breaks[0]!.replacements).toEqual([['Pay now', 'Pay']]);
  });

  test('anchors in the files locators are called from are skipped', () => {
    const a = anchor({ kind: 'literal', before: 'Pay now', after: 'Pay', file: 'e2e/tests/pages/checkout.page.ts' });
    expect(broken([a], ["getByText('Pay now')"])).toEqual([]);
  });
});

describe('helpers', () => {
  test('renameValue', () => {
    expect(renameValue('Pay  now', 'pay now', 'Pay', false)).toBe('Pay');
    expect(renameValue('Pay now', 'pay now', 'Pay', true)).toBeNull();
    expect(renameValue('Click Pay now', 'Pay now', 'Pay', false)).toBe('Click Pay');
  });

  test('sameFilePath', () => {
    expect(sameFilePath('src/a.ts', 'app/src/a.ts')).toBe(true);
    expect(sameFilePath('./src/a.ts', 'src/a.ts')).toBe(true);
    expect(sameFilePath('rc/a.ts', 'src/a.ts')).toBe(false);
  });

  test('itemsOfFile keeps the file’s own path when any item has it', () => {
    const items = [{ path: 'apps/admin/src/App.vue' }, { path: 'src/App.vue' }, { path: 'src/Other.vue' }];
    expect(itemsOfFile(items, './src/App.vue')).toEqual([{ path: 'src/App.vue' }]);
    expect(itemsOfFile(items, 'App.vue')).toEqual([{ path: 'apps/admin/src/App.vue' }, { path: 'src/App.vue' }]);
    expect(itemsOfFile(items, 'web/src/App.vue')).toEqual([{ path: 'src/App.vue' }]);
  });

  test('buildLiteralEdit keeps the quote the author used', () => {
    expect(buildLiteralEdit(`  this.pay = page.getByRole("button", { name: "Pay now" });`, 'Pay now', 'Pay')).toEqual({
      old: `  this.pay = page.getByRole("button", { name: "Pay now" });`,
      new: `  this.pay = page.getByRole("button", { name: "Pay" });`,
    });
    expect(buildLiteralEdit("getByText('Save')", 'Save', "Don't save")!.new).toBe("getByText('Don\\'t save')");
    expect(buildLiteralEdit('getByText(LABELS.pay)', 'Pay now', 'Pay')).toBeNull();
  });

  test('buildLiteralEdit keeps the new value on the line', () => {
    expect(buildLiteralEdit("getByText('Save')", 'Save', 'a\rb\u2028c\u2029d\ne')!.new).toBe(
      "getByText('a\\rb\\u2028c\\u2029d\\ne')",
    );
  });
});

describe('reachOfIndex', () => {
  const index = {
    files: ['src/pay.ts', 'src/cart.ts', 'server/api/pay.ts'],
    tests: [{ id: 11 }, { id: 12 }],
    reach: [
      { file: 0, tests: [0, 1], origin: 'client' },
      { file: 1, tests: [1], origin: 'client' },
      { file: 2, tests: [0], origin: 'server' },
    ],
  };

  test('answers which test reaches which file, by path suffix', () => {
    const reaches = reachOfIndex(index)!;
    expect(reaches(11, 'src/pay.ts')).toBe(true);
    expect(reaches(11, 'app/src/pay.ts')).toBe(true);
    expect(reaches(11, 'src/cart.ts')).toBe(false);
    expect(reaches(12, 'src/cart.ts')).toBe(true);
    expect(reaches(11, 'server/api/pay.ts')).toBe(true);
    expect(reaches(99, 'src/pay.ts')).toBe(false);
  });

  test('is undefined without client reach', () => {
    expect(reachOfIndex({ ...index, reach: index.reach.filter((r) => r.origin === 'server') })).toBeUndefined();
  });
});

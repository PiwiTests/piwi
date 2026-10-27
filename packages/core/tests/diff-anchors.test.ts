import { describe, expect, test } from 'vitest';
import {
  diffFileFromPatch,
  extractDiffAnchors,
  isTranslationFile,
  parseTranslationFile,
  parseUnifiedDiff,
  type DiffAnchor,
} from '../src/diff-anchors';

/** A one-hunk diff of `path` replacing `removed` lines with `added` lines. */
function diff(path: string, removed: string[], added: string[], start = 10): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${removed.length} +${start},${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n');
}

function anchors(text: string, options = {}): DiffAnchor[] {
  return extractDiffAnchors(parseUnifiedDiff(text), options);
}

function brief(list: DiffAnchor[]) {
  return list.map((a) => ({
    kind: a.kind,
    ...(a.attribute ? { attribute: a.attribute } : {}),
    ...(a.key ? { key: a.key } : {}),
    before: a.before,
    ...(a.after !== undefined ? { after: a.after } : {}),
  }));
}

describe('parseUnifiedDiff', () => {
  test('reads files, statuses and line numbers', () => {
    const text = [
      'diff --git a/src/a.vue b/src/a.vue',
      '--- a/src/a.vue',
      '+++ b/src/a.vue',
      '@@ -3,2 +3,2 @@',
      ' <div>',
      '-  Pay now',
      '+  Pay',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      "+export const x = 'y';",
      'diff --git a/old.ts b/renamed.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to renamed.ts',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.vue', 'modified'],
      ['src/new.ts', 'added'],
      ['renamed.ts', 'renamed'],
    ]);
    expect(files[0]!.hunks[0]!.removed).toEqual([{ line: 4, text: '  Pay now' }]);
    expect(files[0]!.hunks[0]!.added).toEqual([{ line: 4, text: '  Pay' }]);
    expect(files[2]!.oldPath).toBe('old.ts');
  });

  test('reads the blob ids of the index line, none for a side that does not exist', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 3f2a91c..9b0e1d4 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000000000000000000000000000000000000..E69DE29BB2D1D6434B8B29AE775AD8C2E48C5391',
      '--- /dev/null',
      '+++ b/src/new.ts',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => [f.path, f.oldBlob, f.newBlob])).toEqual([
      ['src/a.ts', '3f2a91c', '9b0e1d4'],
      ['src/new.ts', undefined, 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'],
    ]);
  });

  test('a removed line that starts with dashes stays a removed line', () => {
    const text = ['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,1 @@', '--- a rule', '-second', '+only'].join('\n');
    const [file] = parseUnifiedDiff(text);
    expect(file!.hunks[0]!.removed.map((l) => l.text)).toEqual(['-- a rule', 'second']);
  });

  test('reads a provider patch with no file header', () => {
    const file = diffFileFromPatch('src/B.tsx', '@@ -1 +1 @@\n-<b>Save</b>\n+<b>Store</b>');
    expect(file.hunks[0]!.removed[0]!.text).toBe('<b>Save</b>');
  });
});

describe('extractDiffAnchors — markup and code', () => {
  test('JSX: text between tags renamed, attribute renamed', () => {
    const list = anchors(
      diff(
        'src/Checkout.tsx',
        ['      <button aria-label="Pay now" data-testid="pay-btn">Pay now</button>'],
        ['      <button aria-label="Pay" data-testid="pay-button">Pay</button>'],
      ),
    );
    expect(brief(list)).toEqual([
      { kind: 'attribute', attribute: 'aria-label', before: 'Pay now', after: 'Pay' },
      { kind: 'attribute', attribute: 'data-testid', before: 'pay-btn', after: 'pay-button' },
      { kind: 'text', before: 'Pay now', after: 'Pay' },
    ]);
    expect(list[0]!.line).toBe(10);
    expect(list[0]!.file).toBe('src/Checkout.tsx');
  });

  test('JSX: braces around a literal attribute value', () => {
    const list = anchors(
      diff('src/A.jsx', ["<input placeholder={'Email address'} />"], ["<input placeholder={'Email'} />"]),
    );
    expect(brief(list)).toEqual([
      { kind: 'attribute', attribute: 'placeholder', before: 'Email address', after: 'Email' },
    ]);
  });

  test('Vue: a bound attribute and a text-only line in the template', () => {
    const list = anchors(
      diff(
        'src/components/CheckoutButton.vue',
        ['  <button :title="\'Pay the order\'">', '    Pay now'],
        ['  <button :title="\'Pay\'">', '    Pay'],
      ),
    );
    expect(brief(list)).toEqual([
      { kind: 'attribute', attribute: 'title', before: 'Pay the order', after: 'Pay' },
      { kind: 'text', before: 'Pay now', after: 'Pay' },
    ]);
  });

  test('Svelte: removed text with nothing replacing it', () => {
    const list = anchors(diff('src/Cart.svelte', ['<p>Apply coupon</p>', '<p>Total</p>'], ['<p>Total</p>']));
    expect(brief(list)).toEqual([{ kind: 'text', before: 'Apply coupon' }]);
  });

  test('Angular: property binding and attr binding', () => {
    const list = anchors(
      diff(
        'src/app/pay.component.html',
        [`<input [placeholder]="'Card number'" [attr.aria-label]="'Card'">`],
        [`<input [placeholder]="'Card'" [attr.aria-label]="'Card'">`],
      ),
    );
    expect(brief(list)).toEqual([
      { kind: 'attribute', attribute: 'placeholder', before: 'Card number', after: 'Card' },
    ]);
  });

  test('Razor: attribute and text, with the Razor expression skipped', () => {
    const list = anchors(
      diff(
        'Views/Cart/Index.cshtml',
        ['<button id="checkout" title="Go to checkout">Checkout @Model.Count</button>'],
        ['<button id="checkout-now" title="Go to checkout">Checkout @Model.Count</button>'],
      ),
    );
    expect(brief(list)).toEqual([{ kind: 'attribute', attribute: 'id', before: 'checkout', after: 'checkout-now' }]);
  });

  test('plain HTML: a changed test id with a configured attribute', () => {
    const list = anchors(diff('public/index.html', ['<div data-qa="basket">'], ['<div data-qa="cart">']), {
      testIdAttributes: ['data-qa'],
    });
    expect(brief(list)).toEqual([{ kind: 'attribute', attribute: 'data-qa', before: 'basket', after: 'cart' }]);
  });

  test('an object literal key: value', () => {
    const list = anchors(
      diff('src/fields.ts', ["  { name: 'email', label: 'Email' },"], ["  { name: 'email', label: 'E-mail' },"]),
    );
    expect(brief(list)).toEqual([{ kind: 'attribute', attribute: 'label', before: 'Email', after: 'E-mail' }]);
  });

  test('bare literals in code are literals; imports, paths and keys are not', () => {
    const list = anchors(
      diff(
        'src/labels.ts',
        ["import x from './x';", "export const PAY = 'Pay now';", "const url = '/api/cart';", "log('app.ready');"],
        ["import x from './x';", "export const PAY = 'Pay';", "const url = '/api/cart';", "log('app.ready');"],
      ),
    );
    expect(brief(list)).toEqual([{ kind: 'literal', before: 'Pay now', after: 'Pay' }]);
  });

  test('two removed strings with one replacement are not paired', () => {
    const list = anchors(diff('src/A.vue', ['<b>Save</b>', '<i>Cancel</i>'], ['<b>Store</b>']));
    expect(brief(list)).toEqual([
      { kind: 'text', before: 'Save' },
      { kind: 'text', before: 'Cancel' },
    ]);
  });

  test('moved lines produce no anchor; short, numeric and interpolated strings are dropped', () => {
    const list = anchors(
      diff(
        'src/A.vue',
        ['<b>Save</b>', '<i>1234</i>', '<p>X</p>', '<p>Hello {{ name }}</p>'],
        ['<p>Hi</p>', '<b>Save</b>'],
      ),
    );
    expect(brief(list)).toEqual([]);
  });

  test('test files are skipped', () => {
    const list = anchors(diff('tests/pay.spec.ts', ["getByText('Pay now')"], ["getByText('Pay')"]), {
      isTestFile: (p: string) => p.startsWith('tests/'),
    });
    expect(list).toEqual([]);
  });
});

describe('extractDiffAnchors — translations', () => {
  test('JSON: value change, with the full key when the file can be read', () => {
    const text = diff('src/locales/en.json', ['      "apply": "Apply coupon",'], ['      "apply": "Use coupon",'], 4);
    expect(brief(anchors(text))).toEqual([
      { kind: 'translation', key: 'apply', before: 'Apply coupon', after: 'Use coupon' },
    ]);
    const file = (value: string) =>
      `{\n  "checkout": {\n    "coupon": {\n      "apply": "${value}",\n      "x": "y"\n    }\n  }\n}`;
    const full = anchors(text, {
      readFile: (_p: string, side: string) => file(side === 'old' ? 'Apply coupon' : 'Use coupon'),
    });
    expect(full[0]!.key).toBe('checkout.coupon.apply');
  });

  test('YAML and .properties', () => {
    expect(brief(anchors(diff('config/locales/en.yml', ['    pay: "Pay now"'], ['    pay: Pay'])))).toEqual([
      { kind: 'translation', key: 'pay', before: 'Pay now', after: 'Pay' },
    ]);
    expect(
      brief(anchors(diff('src/i18n/messages.properties', ['checkout.pay=Pay now'], ['checkout.pay=Pay']))),
    ).toEqual([{ kind: 'translation', key: 'checkout.pay', before: 'Pay now', after: 'Pay' }]);
  });

  test('.resx and .po values', () => {
    expect(
      brief(anchors(diff('Resources/Shared.resx', ['    <value>Pay now</value>'], ['    <value>Pay</value>']))),
    ).toEqual([{ kind: 'translation', before: 'Pay now', after: 'Pay' }]);
    expect(brief(anchors(diff('locale/fr/messages.po', ['msgstr "Payer maintenant"'], ['msgstr "Payer"'])))).toEqual([
      { kind: 'translation', before: 'Payer maintenant', after: 'Payer' },
    ]);
  });

  test('a template whose translation key changed resolves both keys', () => {
    const values: Record<string, string> = { 'checkout.pay': 'Pay now', 'checkout.payNow': 'Pay' };
    const list = anchors(
      diff(
        'src/Pay.vue',
        ["  <button>{{ $t('checkout.pay') }}</button>"],
        ["  <button>{{ $t('checkout.payNow') }}</button>"],
      ),
      {
        translations: (key: string) => values[key],
      },
    );
    expect(brief(list)).toEqual([{ kind: 'translation', key: 'checkout.pay', before: 'Pay now', after: 'Pay' }]);
  });

  test('a JSON file outside a translations path is ordinary code', () => {
    expect(isTranslationFile('package.json')).toBe(false);
    expect(isTranslationFile('src/locales/en.json')).toBe(true);
    expect(isTranslationFile('app/i18n/fr/common.yaml')).toBe(true);
    expect(isTranslationFile('Properties/Resources.resx')).toBe(true);
  });
});

describe('parseTranslationFile', () => {
  test('nested JSON with arrays', () => {
    const entries = parseTranslationFile(
      'en.json',
      '{\n  "a": {\n    "b": "B",\n    "list": [\n      "one",\n      "two"\n    ]\n  },\n  "c": "C"\n}',
    );
    expect(entries.map((e) => [e.key, e.value, e.line])).toEqual([
      ['a.b', 'B', 3],
      ['a.list.0', 'one', 5],
      ['a.list.1', 'two', 6],
      ['c', 'C', 9],
    ]);
  });

  test('nested YAML', () => {
    const entries = parseTranslationFile('en.yml', 'en:\n  checkout:\n    pay: Pay now\n  cart: "Cart"\n');
    expect(entries.map((e) => [e.key, e.value])).toEqual([
      ['en.checkout.pay', 'Pay now'],
      ['en.cart', 'Cart'],
    ]);
  });

  test('.resx and .po', () => {
    expect(
      parseTranslationFile('a.resx', '<data name="Pay" xml:space="preserve">\n  <value>Pay &amp; go</value>\n</data>'),
    ).toEqual([{ key: 'Pay', value: 'Pay & go', line: 2 }]);
    expect(parseTranslationFile('a.po', 'msgid "Pay"\nmsgstr "Payer"')).toEqual([
      { key: 'Pay', value: 'Payer', line: 2 },
    ]);
  });
});

import { describe, expect, test } from 'vitest';
import { extractErrorSignature, maskPaths, maskSelector, maskVolatile } from '../src/error-signature';
import * as core from '../src/index';

describe('extractErrorSignature', () => {
  test('classifies and normalizes an assertion failure', () => {
    const sig = extractErrorSignature(
      "Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByRole('row', { name: 'Order 42' })\nExpected: \"paid\"\n    at tests/orders.spec.ts:12:5",
    );
    expect(sig.errorType).toBe('assertion');
    expect(sig.signature).toBe('Error: expect(locator).toHaveText(expected) failed');
    expect(sig.normalizedMessage).toContain('Expected: <VALUE>');
    expect(sig.normalizedMessage).toContain("Locator: getByRole('row', { name: <STR> })");
    expect(sig.selector).toBe("getByRole('row', { name: 'Order 42' })");
    expect(sig.topFrameFile).toBe('tests/orders.spec.ts');
  });

  test('gives rows that differ only by locator options the same normalized message', () => {
    const rowError = (name: string) =>
      `Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('row', { name: '${name}' })\nExpected: visible\nReceived: <element(s) not found>\nTimeout: 5000ms`;
    const alice = extractErrorSignature(rowError('Alice'));
    const bob = extractErrorSignature(rowError('Bob'));
    expect(alice.normalizedMessage).toBe(bob.normalizedMessage);
    expect(alice.selector).toBe("getByRole('row', { name: 'Alice' })");
    expect(bob.selector).toBe("getByRole('row', { name: 'Bob' })");
  });

  test('masks locator options in a strict mode violation line', () => {
    const sig = extractErrorSignature(
      "Error: strict mode violation: getByRole('row', { name: 'Alice' }) resolved to 2 elements:",
    );
    expect(sig.normalizedMessage).toBe(
      "Error: strict mode violation: getByRole('row', { name: <STR> }) resolved to <N> elements:",
    );
  });

  test('keeps different locator targets apart', () => {
    const save = extractErrorSignature("Locator: getByTestId('save')\nExpected: visible");
    const cancel = extractErrorSignature("Locator: getByTestId('cancel')\nExpected: visible");
    expect(save.normalizedMessage).not.toBe(cancel.normalizedMessage);
  });

  test('names an empty error', () => {
    expect(extractErrorSignature('').signature).toBe('Unknown error');
  });

  test('masks volatile tokens but keeps identifiers', () => {
    expect(maskVolatile('Timeout 30000ms exceeded for p1 at https://x.test/a')).toBe(
      'Timeout <N>ms exceeded for p1 at <URL>',
    );
    expect(maskSelector("getByRole('row', { name: 'Order 42' })")).toBe("getByRole('row', { name: <STR> })");
  });

  test('is exported from the package entry', () => {
    expect(core.extractErrorSignature).toBe(extractErrorSignature);
  });
});

describe('volatile text masking', () => {
  test("masks a strict-mode violation's element list, so its length and its elements do not count", () => {
    const violation = (elements: string[]) =>
      [
        "Error: locator.click: Error: strict mode violation: getByRole('button') resolved to " +
          `${elements.length} elements:`,
        ...elements.map((element, i) => `    ${i + 1}) ${element}`),
      ].join('\n');
    const two = violation([
      "<button class=\"primary\">Pay</button> aka getByRole('button', { name: 'Pay' })",
      "<button>Pay later</button> aka getByTestId('pay-later')",
    ]);
    const many = violation([
      '<button id="b1">Pay</button> aka locator(\'#b1\')',
      "<button>Cancel</button> aka getByRole('button', { name: 'Cancel' })",
      "<button>Help</button> aka getByText('Help')",
      '...',
    ]);
    expect(maskVolatile(two)).toBe(
      "Error: locator.click: Error: strict mode violation: getByRole('button') resolved to <N> elements:",
    );
    expect(extractErrorSignature(many).normalizedMessage).toBe(extractErrorSignature(two).normalizedMessage);
  });

  test('masks an ISO timestamp whole, its time of day included', () => {
    expect(maskVolatile('Error: booking expired at 2026-05-01T10:30:00Z')).toBe(
      'Error: booking expired at <TIMESTAMP>',
    );
    expect(maskVolatile('Error: booking expired at 2026-05-02T17:05:42.120+02:00')).toBe(
      'Error: booking expired at <TIMESTAMP>',
    );
  });

  test('masks an id glued to an underscore, and keeps a word ending in a number', () => {
    expect(maskVolatile('Error: order_5f3a9c1e2b not found')).toBe('Error: order_<ID> not found');
    expect(maskVolatile('Error: no customer cus_4QFJrkXyZ8aB2m')).toBe('Error: no customer cus_<ID>');
    expect(maskVolatile('Error: field_label12 is required')).toBe('Error: field_label12 is required');
  });

  test("masks the random suffix of a temporary folder's name", () => {
    expect(maskVolatile('Error: profile /tmp/playwright_chromiumdev_profile-Xo8n2p is locked')).toBe(
      'Error: profile /tmp/playwright_chromiumdev_profile-<TMP> is locked',
    );
    expect(maskVolatile('Error: /tmp/test-results/page-object')).toBe('Error: /tmp/test-results/page-object');
  });

  test('masks the folders of an absolute path under a home, a CI workspace or a Windows drive', () => {
    const opened = (path: string) => maskVolatile(`Error: ENOENT: no such file or directory, open '${path}'`);
    const masked = "Error: ENOENT: no such file or directory, open '<PATH>/user.json'";
    expect(opened('/home/runner/work/shop/shop/fixtures/user.json')).toBe(masked);
    expect(opened('/Users/alice/code/shop/fixtures/user.json')).toBe(masked);
    expect(opened('C:\\Users\\alice\\shop\\fixtures\\user.json')).toBe(masked);
    expect(opened('/__w/shop/shop/fixtures/user.json')).toBe(masked);
    // A path of the app's own, or relative, says something about the failure.
    expect(opened('/srv/shop/fixtures/user.json')).toBe(
      "Error: ENOENT: no such file or directory, open '/srv/shop/fixtures/user.json'",
    );
    expect(maskPaths('tests/home/settings.spec.ts')).toBe('tests/home/settings.spec.ts');
  });
});

describe('locator option masking', () => {
  // The expression the masking scan reproduces, run only on inputs short enough for it.
  const REFERENCE =
    /\b(name|hasText|hasNotText|has|placeholder|label|title|alt|exact)\s*:\s*(['"`])(?:\\.|(?!\2)[\s\S])*?\2/gi;
  const reference = (text: string) => maskVolatile(text.replace(REFERENCE, (_m, key: string) => `${key}: <STR>`));

  test('matches the backtracking expression on generated inputs', () => {
    const pieces = ['name: ', 'hasText:', " '", '"', '`', '\\', '\\\\', "\\'", 'a', ' ', '\n', 'x}', 'title :'];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 4000; i++) {
      let text = '';
      const len = 1 + Math.floor(next() * 10);
      for (let j = 0; j < len; j++) text += pieces[Math.floor(next() * pieces.length)];
      expect(maskSelector(text), JSON.stringify(text)).toBe(reference(text));
    }
  });

  test('keeps a value that ends on an escaped quote with nothing after it', () => {
    expect(maskSelector("getByRole('button', { name: 'Don\\'")).toBe(reference("getByRole('button', { name: 'Don\\'"));
  });

  test('stays linear on an unterminated run of escape pairs', () => {
    const text = `Error: getByRole('button', { name: '${'\\a'.repeat(20_000)}`;
    const started = performance.now();
    extractErrorSignature(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

import { describe, test, expect } from 'vitest';
import {
  stripAnsi,
  maskVolatile,
  extractSelector,
  extractLeafSelector,
  extractTopFrameFile,
  extractErrorSignature,
  computeErrorFingerprint,
  condenseErrorText,
  FINGERPRINT_VERSION,
  isGenericFailure,
} from '#shared/error-fingerprint';
import { errorFingerprintV4 } from '#shared/error-fingerprint-v4';

describe('stripAnsi', () => {
  test('removes SGR color codes', () => {
    expect(stripAnsi('\u001B[31mred\u001B[39m text \u001B[0m')).toBe('red text ');
  });

  test('leaves plain text untouched', () => {
    expect(stripAnsi('no colors here')).toBe('no colors here');
  });
});

describe('maskVolatile', () => {
  test('masks bare numbers not glued to a letter (timeouts/durations)', () => {
    expect(maskVolatile('Timeout 30000ms exceeded')).toBe('Timeout <N>ms exceeded');
    expect(maskVolatile('row-5')).toBe('row-<N>');
  });

  test('preserves digits that are part of an identifier', () => {
    expect(maskVolatile('field2 utf8 p1')).toBe('field2 utf8 p1');
  });

  test('masks URLs, emails, and UUIDs', () => {
    expect(maskVolatile('open https://example.com/a?b=1 now')).toBe('open <URL> now');
    expect(maskVolatile('mailto user@example.com')).toBe('mailto <EMAIL>');
    expect(maskVolatile('id 550e8400-e29b-41d4-a716-446655440000 x')).toBe('id <UUID> x');
  });

  test('masks long hashes and mixed short hex tokens', () => {
    expect(maskVolatile('sha deadbeefcafe0123 end')).toBe('sha <HASH> end');
    expect(maskVolatile('commit a1b2c3 done')).toBe('commit <HASH> done');
  });

  test('masks the value part of Received/Expected assertion lines', () => {
    expect(maskVolatile('Expected: "hello world"')).toBe('Expected: <VALUE>');
    expect(maskVolatile('Received: 42')).toBe('Received: <VALUE>');
  });
});

describe('extractSelector', () => {
  test('extracts a balanced locator expression with options', () => {
    expect(extractSelector("page.getByRole('button', { name: 'Submit' }).click()")).toBe(
      "getByRole('button', { name: 'Submit' })",
    );
  });

  test('extracts a plain getByTestId call', () => {
    expect(extractSelector("await page.getByTestId('login').fill('x')")).toBe("getByTestId('login')");
  });

  test('returns null when there is no locator', () => {
    expect(extractSelector('Timeout 30000ms exceeded')).toBeNull();
  });
});

describe('extractLeafSelector', () => {
  test('returns the innermost call of a chained locator', () => {
    const text = "getByRole('row', { name: 'Acme' }).getByRole('button', { name: 'Delete' })";
    expect(extractLeafSelector(text)).toBe("getByRole('button', { name: 'Delete' })");
  });

  test('returns the whole expression for a non-chained locator', () => {
    expect(extractLeafSelector("getByTestId('save')")).toBe("getByTestId('save')");
  });
});

describe('extractTopFrameFile', () => {
  test('returns the first user frame, skipping node_modules', () => {
    const text = [
      'Error: boom',
      '    at Object.<anonymous> (/app/node_modules/@playwright/test/lib.js:5:5)',
      '    at loginTest (/app/tests/login.spec.ts:12:7)',
    ].join('\n');
    expect(extractTopFrameFile(text)).toBe('/app/tests/login.spec.ts');
  });

  test('returns null when there are only internal frames', () => {
    const text = 'Error: boom\n    at /app/node_modules/x.js:1:1';
    expect(extractTopFrameFile(text)).toBeNull();
  });
});

describe('extractErrorSignature — classification', () => {
  const errorType = (t: string) => extractErrorSignature(t).errorType;

  test('classifies strict-mode violations', () => {
    expect(errorType('Error: strict mode violation: locator resolved to 2 elements')).toBe('strict-mode');
  });

  test('classifies assertions, including timed-out expects', () => {
    expect(errorType('expect(received).toBe(expected)')).toBe('assertion');
    expect(errorType('expect(locator).toBeVisible()\nTimeout 5000ms exceeded')).toBe('assertion');
  });

  test('classifies crashes and navigation errors', () => {
    expect(errorType('Target page, context or browser has been closed')).toBe('crash');
    expect(errorType('page.goto: net::ERR_CONNECTION_REFUSED')).toBe('navigation');
  });

  test('classifies plain timeouts and falls back to unknown', () => {
    expect(errorType('Timeout 30000ms exceeded')).toBe('timeout');
    expect(errorType('something entirely unexpected happened')).toBe('unknown');
  });

  test('derives a masked signature from the first message line', () => {
    const sig = extractErrorSignature('Timeout 30000ms exceeded\n    at /app/tests/a.spec.ts:1:1');
    expect(sig.signature).toBe('Timeout <N>ms exceeded');
    expect(sig.topFrameFile).toBe('/app/tests/a.spec.ts');
  });
});

describe('computeErrorFingerprint', () => {
  test('is a deterministic 64-char hex hash', async () => {
    const a = await computeErrorFingerprint('expect(received).toBe(expected)');
    const b = await computeErrorFingerprint('expect(received).toBe(expected)');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('groups a failure that names its locator across spec files (its frame not hashed)', async () => {
    const base = "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Pay' })";
    const fromA = await computeErrorFingerprint(`${base}\n    at /app/tests/a.spec.ts:1:1`);
    const fromB = await computeErrorFingerprint(`${base}\n    at /app/tests/b.spec.ts:99:9`);
    expect(fromA.fingerprint).toBe(fromB.fingerprint);
    // …but the display frame still differs.
    expect(fromA.topFrameFile).not.toBe(fromB.topFrameFile);
  });

  test('separates volatile values that mask to the same shape from genuinely different messages', async () => {
    const one = await computeErrorFingerprint('Expected length 3, got 5');
    const two = await computeErrorFingerprint('Element is not attached to the DOM');
    expect(one.fingerprint).not.toBe(two.fingerprint);
  });

  test('collapses per-row volatile values into one fingerprint', async () => {
    const rowA = await computeErrorFingerprint('Timeout 30000ms exceeded waiting for row 12');
    const rowB = await computeErrorFingerprint('Timeout 45000ms exceeded waiting for row 87');
    expect(rowA.fingerprint).toBe(rowB.fingerprint);
  });

  test('groups per-row expect(locator) failures that differ only by locator options', async () => {
    const rowError = (name: string) =>
      [
        'Error: expect(locator).toBeVisible() failed',
        '',
        `Locator: getByRole('row', { name: '${name}' })`,
        'Expected: visible',
        'Received: <element(s) not found>',
        'Timeout: 5000ms',
        '',
        'Call log:',
        `  - waiting for getByRole('row', { name: '${name}' })`,
        '    at /app/tests/table.spec.ts:20:5',
      ].join('\n');
    const alice = await computeErrorFingerprint(rowError('Alice'));
    const bob = await computeErrorFingerprint(rowError('Bob'));
    expect(alice.fingerprint).toBe(bob.fingerprint);
    expect(alice.normalizedMessage).toContain("Locator: getByRole('row', { name: <STR> })");
    // The unmasked locator stays available for display.
    expect(alice.selector).toBe("getByRole('row', { name: 'Alice' })");
    expect(bob.selector).toBe("getByRole('row', { name: 'Bob' })");
  });

  test('keeps a different locator role or target in a different cluster', async () => {
    const row = await computeErrorFingerprint(
      "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('row', { name: 'Alice' })",
    );
    const button = await computeErrorFingerprint(
      "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Alice' })",
    );
    const testId = await computeErrorFingerprint(
      "Error: expect(locator).toBeVisible() failed\n\nLocator: getByTestId('alice-row')",
    );
    expect(new Set([row.fingerprint, button.fingerprint, testId.fingerprint]).size).toBe(3);
  });

  test('exposes a positive fingerprint version', () => {
    expect(FINGERPRINT_VERSION).toBeGreaterThan(0);
  });
});

describe('a generic failure', () => {
  const at = (frames: string[]) => frames.map((frame) => `\n    at ${frame}`).join('');
  const toBe = (expected: string, received: string) =>
    `Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: ${expected}\nReceived: ${received}`;

  test('is told apart by the file it failed in: the matchers, test timeouts and TypeErrors of unrelated tests', async () => {
    const pairs = [
      [
        toBe('3', '2') + at(['tests/basic.spec.ts:12:5']),
        toBe('"accepted"', '"declined"') + at(['tests/serial.spec.ts:30:7']),
      ],
      [
        'Test timeout of 30000ms exceeded.' + at(['tests/cart.spec.ts:4:1']),
        'Test timeout of 30000ms exceeded.' + at(['tests/search.spec.ts:9:1']),
      ],
      [
        "TypeError: Cannot read properties of undefined (reading 'id')" + at(['tests/orders.spec.ts:20:15']),
        "TypeError: Cannot read properties of undefined (reading 'id')" + at(['tests/users.spec.ts:7:31']),
      ],
    ];
    for (const [a, b] of pairs) {
      const [fpA, fpB] = await Promise.all([computeErrorFingerprint(a!), computeErrorFingerprint(b!)]);
      expect(isGenericFailure(fpA), a).toBe(true);
      expect(fpA.fingerprint, a).not.toBe(fpB.fingerprint);
    }
  });

  test('reached through one helper from two specs still groups: the helper is the file it failed in', async () => {
    const helper = 'assertTotal (tests/helpers/cart.ts:8:3)';
    const fromCheckout = await computeErrorFingerprint(toBe('3', '2') + at([helper, 'tests/checkout.spec.ts:12:5']));
    const fromCart = await computeErrorFingerprint(toBe('5', '0') + at([helper, 'tests/cart.spec.ts:40:9']));
    expect(fromCheckout.topFrameFile).toBe('tests/helpers/cart.ts');
    expect(fromCheckout.fingerprint).toBe(fromCart.fingerprint);
  });

  test('groups across machines: an absolute frame counts from its last segment', async () => {
    const onCi = await computeErrorFingerprint(
      toBe('3', '2') + at(['/home/runner/work/shop/shop/tests/basic.spec.ts:12:5']),
    );
    const onLaptop = await computeErrorFingerprint(toBe('3', '2') + at(['/Users/alice/shop/tests/basic.spec.ts:12:5']));
    expect(onCi.fingerprint).toBe(onLaptop.fingerprint);
  });

  test('is one that names nothing specific', () => {
    const generic = (text: string) => isGenericFailure(extractErrorSignature(text));
    expect(generic(toBe('3', '2'))).toBe(true);
    expect(
      generic(
        'Error: expect(page).toHaveURL(expected) failed\n\nExpected: "/done"\nReceived: "/cart"\nTimeout: 5000ms',
      ),
    ).toBe(true);
    expect(generic('Test timeout of 30000ms exceeded while running "beforeEach" hook.')).toBe(true);
    expect(generic('ReferenceError: total is not defined')).toBe(true);
    // A locator, a message of the test's own, values the masks keep, or more than a bare TypeError line say what failed.
    expect(
      generic(
        "Test timeout of 30000ms exceeded.\n---\nError: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button')",
      ),
    ).toBe(false);
    expect(generic(`Error: the cart total is wrong\n\n${toBe('3', '2')}`)).toBe(false);
    expect(
      generic(
        'Error: expect(received).toEqual(expected) // deep equality\n\n- Expected  - 1\n+ Received  + 1\n\n-   "status": "accepted",\n+   "status": "declined",',
      ),
    ).toBe(false);
    expect(
      generic("TypeError: Cannot read properties of undefined (reading 'id')\n---\nError: the order page broke"),
    ).toBe(false);
    expect(generic('Error: something broke')).toBe(false);
  });
});

describe('errorFingerprintV4', () => {
  // The fingerprints version 4 stored for these errors.
  const STORED = [
    [
      'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 3\nReceived: 2\n    at tests/basic.spec.ts:12:5',
      'd8d8061611d2c1d592c70fc0bc3285c1a619235cb074d7a31f367ccd59a447f2',
    ],
    [
      "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })\n    at tests/checkout.spec.ts:20:7",
      '688fbb833444d91e9ddec5d3c1f443c7533e84b0954f628f54eef9c35e9c945a',
    ],
    [
      "Error: strict mode violation: getByRole('row', { name: 'Alice' }) resolved to 2 elements:\n    1) <tr>…</tr> aka getByRole('row', { name: 'Alice', exact: true })\n    2) <tr>…</tr> aka getByRole('row', { name: 'Alice Smith' })",
      'd92bf5549ef7edad35be2fed3983c03833e0376714494c63643500850e94f022',
    ],
    [
      "Error: ENOENT: no such file or directory, open '/home/runner/work/app/app/fixtures/order_5f3a9c1e2b.json' at 2024-05-01T10:30:00Z",
      '72909a236f188f7e482590a32e422ed0859bcf748075f7b9e86ad94b5e79dcb0',
    ],
  ] as const;

  test('computes what version 4 stored', async () => {
    for (const [error, stored] of STORED) {
      expect(await errorFingerprintV4(error), error).toBe(stored);
      expect((await computeErrorFingerprint(error)).fingerprint, error).not.toBe(stored);
    }
  });
});

describe('condenseErrorText', () => {
  test('collapses consecutive internal frames into a placeholder', () => {
    const text = [
      'boom message',
      '    at userFn (/app/tests/a.spec.ts:1:1)',
      '    at /app/node_modules/x.js:2:2',
      '    at /app/node_modules/y.js:3:3',
      '    at other (/app/tests/b.spec.ts:4:4)',
    ].join('\n');
    const out = condenseErrorText(text);
    expect(out).toContain('at userFn (/app/tests/a.spec.ts:1:1)');
    expect(out).toContain('… (2 internal frames)');
    expect(out).toContain('at other (/app/tests/b.spec.ts:4:4)');
    expect(out).not.toContain('node_modules');
  });

  test('applies a character budget with a truncation marker when there is no stack', () => {
    expect(condenseErrorText('a very long message', 5)).toBe('a ver\n[truncated]');
  });

  test('returns short no-stack text unchanged', () => {
    expect(condenseErrorText('short')).toBe('short');
  });
});

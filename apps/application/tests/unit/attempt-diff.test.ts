import { describe, test, expect } from 'vitest';
import { diffAttempts, type AttemptEvidence } from '#shared/attempt-diff';

/** A minimal passing attempt: no error, no failed requests, no problem logs. */
function cleanPass(overrides: Partial<AttemptEvidence> = {}): AttemptEvidence {
  return {
    error: null,
    steps: [],
    networkRequests: [],
    consoleLogs: [],
    pageState: null,
    ariaSnapshot: null,
    duration: 1000,
    ...overrides,
  };
}

describe('diffAttempts', () => {
  test('fail→pass with a 500 that recovered ranks the error first, then the request', () => {
    const failing: AttemptEvidence = {
      error: 'Error: expected 200, got 500',
      networkRequests: [
        { method: 'GET', url: 'https://app.test/', status: 200, duration: 40 },
        { method: 'POST', url: 'https://app.test/api/orders?id=7', status: 500, duration: 120 },
      ],
      duration: 1200,
    };
    const passing = cleanPass({
      networkRequests: [
        { method: 'GET', url: 'https://app.test/', status: 200, duration: 40 },
        { method: 'POST', url: 'https://app.test/api/orders?id=8', status: 201, duration: 90 },
      ],
      duration: 1100,
    });

    const diff = diffAttempts(failing, passing);
    const kinds = diff.map((d) => d.kind);
    expect(kinds[0]).toBe('error');
    expect(kinds).toContain('network');
    // Error before network in the ordered list.
    expect(kinds.indexOf('error')).toBeLessThan(kinds.indexOf('network'));

    const net = diff.find((d) => d.kind === 'network')!;
    expect(net.only).toBe('failing');
    expect(net.summary).toContain('POST /api/orders');
    expect(net.detail).toBe('https://app.test/api/orders?id=7');
    expect(net.summary).toContain('500');
    expect(net.ref).toEqual({ section: 'networkRequests' });
  });

  test('fail→pass with a console error only on the fail emits a console diff', () => {
    const failing: AttemptEvidence = {
      error: 'Error: element not found',
      consoleLogs: [
        { type: 'log', text: 'app booted' },
        { type: 'error', text: 'Uncaught TypeError: cannot read foo of undefined' },
      ],
      duration: 1000,
    };
    const passing = cleanPass({
      consoleLogs: [{ type: 'log', text: 'app booted' }],
    });

    const diff = diffAttempts(failing, passing);
    const console = diff.filter((d) => d.kind === 'console');
    expect(console).toHaveLength(1);
    expect(console[0]!.only).toBe('failing');
    expect(console[0]!.detail).toContain('Uncaught TypeError');
    expect(console[0]!.ref).toEqual({ section: 'console' });
  });

  test('an uncaught page error only on the fail emits a console diff that names it', () => {
    const failing: AttemptEvidence = {
      error: 'Error: element not found',
      consoleLogs: [{ type: 'pageerror', text: 'TypeError: cart is undefined' }],
      duration: 1000,
    };
    const console = diffAttempts(failing, cleanPass()).filter((d) => d.kind === 'console');
    expect(console).toEqual([
      {
        kind: 'console',
        summary: 'Uncaught page error on only the failing attempt',
        detail: 'TypeError: cart is undefined',
        only: 'failing',
        ref: { section: 'console' },
      },
    ]);
  });

  test('a timing-only difference yields a single duration row', () => {
    const failing = cleanPass({ error: null, duration: 8000 });
    const passing = cleanPass({ duration: 1500 });

    const diff = diffAttempts(failing, passing);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.kind).toBe('duration');
    expect(diff[0]!.only).toBeUndefined();
    expect(diff[0]!.summary).toContain('slower');
  });

  test('attempts with no fixture data produce an error-only diff and never throw', () => {
    const failing: AttemptEvidence = { error: 'AssertionError: expected true' };
    const passing: AttemptEvidence = { error: null };

    const diff = diffAttempts(failing, passing);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.kind).toBe('error');
    expect(diff[0]!.only).toBe('failing');
    expect(diff[0]!.detail).toBe('AssertionError: expected true');
    expect(diff[0]!.ref).toEqual({ section: 'executionError' });
  });

  test('aligns 1.63-shaped steps by label so a failed click is not lost among bare "Click" titles', () => {
    // Both attempts have two "Click" steps; only the failing attempt's second
    // one errored. Keying by title alone would pair it with the passing first
    // click and miss the error — the label (title + subtitle) keeps them apart.
    const failing = cleanPass({
      steps: [
        { title: 'Click', subtitle: "getByRole('button', { name: 'Cancel' })", duration: 10 },
        {
          title: 'Click',
          subtitle: "getByRole('button', { name: 'Pay' })",
          duration: 10,
          error: { message: 'not enabled' },
        },
      ],
    });
    const passing = cleanPass({
      steps: [
        { title: 'Click', subtitle: "getByRole('button', { name: 'Cancel' })", duration: 10 },
        { title: 'Click', subtitle: "getByRole('button', { name: 'Pay' })", duration: 10 },
      ],
    });
    const diff = diffAttempts(failing, passing);
    const stepRow = diff.find((d) => d.kind === 'step');
    expect(stepRow?.summary).toBe(
      "Step \"Click getByRole('button', { name: 'Pay' })\" errored on only the failing attempt",
    );
  });

  test('a step run on both attempts with different params is reported', () => {
    const failing = cleanPass({
      steps: [
        {
          title: 'Navigate',
          subtitle: '/checkout',
          duration: 10,
          params: { url: 'https://app.test/checkout?coupon=EXPIRED' },
        },
      ],
    });
    const passing = cleanPass({
      steps: [
        {
          title: 'Navigate',
          subtitle: '/checkout',
          duration: 10,
          params: { url: 'https://app.test/checkout?coupon=SAVE10' },
        },
      ],
    });
    const diff = diffAttempts(failing, passing);
    const stepRow = diff.find((d) => d.kind === 'step');
    expect(stepRow?.summary).toBe('Step "Navigate /checkout" ran with different params');
    expect(stepRow?.detail).toBe(
      'url: https://app.test/checkout?coupon=EXPIRED → https://app.test/checkout?coupon=SAVE10',
    );
  });

  test('a step present on both attempts with identical params yields no step diff', () => {
    const step = {
      title: 'Click',
      subtitle: "getByRole('button')",
      duration: 10,
      params: { locator: "getByRole('button')" },
    };
    expect(diffAttempts(cleanPass({ steps: [step] }), cleanPass({ steps: [{ ...step }] }))).toEqual([]);
  });

  test('two identical attempts yield no differences', () => {
    expect(diffAttempts(cleanPass(), cleanPass())).toEqual([]);
  });

  test('empty inputs never throw', () => {
    expect(diffAttempts({}, {})).toEqual([]);
  });

  test('an ARIA structural node present only on the failure is reported', () => {
    const failing = cleanPass({
      ariaSnapshot: '- main:\n  - heading "Dashboard" [level=1]\n- dialog "Session expired"',
    });
    const passing = cleanPass({
      ariaSnapshot: '- main:\n  - heading "Dashboard" [level=1]',
    });

    const diff = diffAttempts(failing, passing);
    const aria = diff.filter((d) => d.kind === 'aria');
    expect(aria).toHaveLength(1);
    expect(aria[0]!.only).toBe('failing');
    expect(aria[0]!.summary).toContain('dialog "Session expired"');
  });

  test('a request much slower on the failing attempt is a network row with both durations', () => {
    const failing: AttemptEvidence = {
      error: 'Error: expect(locator).toHaveText() failed',
      networkRequests: [
        { method: 'GET', url: 'https://shop.test/api/cart?v=2', status: 200, duration: 2_100 },
        { method: 'GET', url: 'https://shop.test/api/cart?v=3', status: 200, duration: 150 },
        { method: 'GET', url: 'https://shop.test/api/user', status: 200, duration: 120 },
      ],
    };
    const passing = cleanPass({
      networkRequests: [
        { method: 'GET', url: 'https://shop.test/api/cart', status: 200, duration: 200 },
        { method: 'GET', url: 'https://shop.test/api/user', status: 200, duration: 110 },
      ],
    });
    const rows = diffAttempts(failing, passing).filter((d) => d.kind === 'network');
    expect(rows).toEqual([
      {
        kind: 'network',
        summary: 'GET /api/cart 2.1 s on the failing attempt, 200 ms on the passing one',
        detail: null,
        route: 'GET /api/cart',
        ref: { section: 'networkRequests' },
      },
    ]);
  });

  test('a slower request under 1 s, or less than twice as slow, is no difference', () => {
    const failing: AttemptEvidence = {
      error: 'boom',
      networkRequests: [
        { method: 'GET', url: 'https://shop.test/api/a', status: 200, duration: 900 },
        { method: 'GET', url: 'https://shop.test/api/b', status: 200, duration: 1_500 },
      ],
    };
    const passing = cleanPass({
      networkRequests: [
        { method: 'GET', url: 'https://shop.test/api/a', status: 200, duration: 100 },
        { method: 'GET', url: 'https://shop.test/api/b', status: 200, duration: 900 },
      ],
    });
    expect(diffAttempts(failing, passing).filter((d) => d.kind === 'network')).toEqual([]);
  });

  test('a request made only on the failing attempt has no duration to compare', () => {
    const failing: AttemptEvidence = {
      error: 'boom',
      networkRequests: [{ method: 'GET', url: 'https://shop.test/api/slow', status: 200, duration: 4_000 }],
    };
    expect(diffAttempts(failing, cleanPass()).filter((d) => d.kind === 'network')).toEqual([]);
  });

  test('the slowest requests come first, and they do not vote as a failed request', () => {
    const failing: AttemptEvidence = {
      error: 'boom',
      networkRequests: [
        { method: 'GET', url: 'https://shop.test/api/a', status: 200, duration: 1_200 },
        { method: 'POST', url: 'https://shop.test/api/b', status: 201, duration: 5_000 },
      ],
    };
    const passing = cleanPass({
      networkRequests: [
        { method: 'GET', url: 'https://shop.test/api/a', status: 200, duration: 100 },
        { method: 'POST', url: 'https://shop.test/api/b', status: 201, duration: 300 },
      ],
    });
    const rows = diffAttempts(failing, passing).filter((d) => d.kind === 'network');
    expect(rows.map((r) => r.summary)).toEqual([
      'POST /api/b 5 s on the failing attempt, 300 ms on the passing one',
      'GET /api/a 1.2 s on the failing attempt, 100 ms on the passing one',
    ]);
    expect(rows.every((r) => r.only === undefined)).toBe(true);
  });

  test('a request that failed without a response names its error', () => {
    const failing: AttemptEvidence = {
      error: 'boom',
      networkRequests: [
        {
          method: 'GET',
          url: 'https://shop.test/api/cart',
          status: 0,
          duration: 1_800,
          failure: 'net::ERR_CONNECTION_RESET',
        },
      ],
    };
    const passing = cleanPass({
      networkRequests: [{ method: 'GET', url: 'https://shop.test/api/cart', status: 200, duration: 200 }],
    });
    const rows = diffAttempts(failing, passing).filter((d) => d.kind === 'network');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      summary: 'GET /api/cart → net::ERR_CONNECTION_RESET',
      detail: 'https://shop.test/api/cart',
      route: 'GET /api/cart',
      only: 'failing',
    });
  });

  test('requests are keyed by route pattern, so two ids of one route compare as one', () => {
    const failing: AttemptEvidence = {
      error: 'boom',
      networkRequests: [{ method: 'get', url: 'https://shop.test/api/orders/41', status: 200, duration: 3_000 }],
    };
    const passing = cleanPass({
      networkRequests: [{ method: 'GET', url: 'https://shop.test/api/orders/42', status: 200, duration: 300 }],
    });
    const rows = diffAttempts(failing, passing).filter((d) => d.kind === 'network');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      summary: 'GET /api/orders/:id 3 s on the failing attempt, 300 ms on the passing one',
      route: 'GET /api/orders/:id',
    });
  });
});

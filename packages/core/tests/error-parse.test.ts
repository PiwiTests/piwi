import { describe, test, expect } from 'vitest';
import {
  parsePlaywrightError,
  extractLocatorChain,
  extractLeafSelector,
  extractSelector,
  extractMessageHead,
  extractStackFrames,
  extractTopFrame,
  extractTopFrameFile,
  readLocatorHeader,
  stripAnsi,
  withoutStackFrames,
  type ParsedPlaywrightError,
} from '../src/error-parse';
import { ERRORS, type ErrorKey } from './fixtures/playwright-errors';
import { extractErrorSignature } from '../src/error-signature';
import { appendErrorLocation } from '../src/error-text';

type Expected = Partial<Omit<ParsedPlaywrightError, 'messageHead'>>;

/** Every field the corpus pins per shape; fields left out are not asserted. */
const EXPECTED: Record<ErrorKey, Expected> = {
  clickNotEnabled: {
    kind: 'action-timeout',
    errorName: 'TimeoutError',
    subject: 'locator',
    action: 'click',
    assertion: null,
    locator: "getByRole('button', { name: 'Pay' })",
    leafLocator: "getByRole('button', { name: 'Pay' })",
    timeoutMs: 30000,
    lastState: 'not-enabled',
    lastStateLine: 'element is not enabled',
    lastCallLogLine: 'waiting 100ms',
    topFrame: 'tests/checkout.spec.ts:42',
    isLocatorResolutionFailure: false,
  },
  fillNotFound: {
    kind: 'action-timeout',
    action: 'fill',
    locator: "getByLabel('Email address')",
    timeoutMs: 10000,
    lastState: 'not-found',
    isLocatorResolutionFailure: true,
  },
  clickNoCallLogHeader: {
    kind: 'action-timeout',
    action: 'click',
    locator: "getByRole('button', { name: 'Pay' })",
    lastState: 'not-found',
    lastCallLogLine: "waiting for getByRole('button', { name: 'Pay' })",
    topFrame: null,
    isLocatorResolutionFailure: true,
  },
  clickIntercepted: {
    kind: 'action-timeout',
    action: 'click',
    lastState: 'intercepts-pointer',
    lastStateLine: '<div class="modal-backdrop"></div> intercepts pointer events',
    isLocatorResolutionFailure: false,
  },
  fillNotVisible: {
    kind: 'action-timeout',
    action: 'fill',
    locator: "getByPlaceholder('Search')",
    lastState: 'not-visible',
    isLocatorResolutionFailure: false,
  },
  clickChained: {
    kind: 'action-timeout',
    locator: "getByRole('row', { name: 'Ada Lovelace' }).getByRole('button', { name: 'Delete' })",
    leafLocator: "getByRole('button', { name: 'Delete' })",
    lastState: 'not-found',
    isLocatorResolutionFailure: true,
  },
  waitForSelector: {
    kind: 'action-timeout',
    subject: 'page',
    action: 'waitForSelector',
    locator: "locator('#app-ready')",
    timeoutMs: 5000,
    lastState: 'not-found',
    isLocatorResolutionFailure: true,
  },
  toHaveCount: {
    kind: 'assertion-timeout',
    errorName: 'Error',
    action: null,
    assertion: 'toHaveCount',
    negated: false,
    locator: "getByRole('row')",
    expected: '26',
    received: '51',
    timeoutMs: 5000,
    lastState: 'resolved-count',
    resolvedCount: 51,
    isLocatorResolutionFailure: false,
  },
  toHaveCountZero: {
    kind: 'assertion-timeout',
    assertion: 'toHaveCount',
    expected: '3',
    received: '0',
    lastState: 'resolved-count',
    resolvedCount: 0,
    isLocatorResolutionFailure: true,
  },
  toBeVisibleText: {
    kind: 'assertion-timeout',
    assertion: 'toBeVisible',
    locator: "getByText('Invite sent')",
    expected: 'visible',
    received: '<element(s) not found>',
    timeoutMs: 30000,
    lastState: 'not-found',
    isLocatorResolutionFailure: true,
  },
  toBeVisibleHidden: {
    kind: 'assertion-timeout',
    assertion: 'toBeVisible',
    locator: "getByRole('button', { name: 'Export CSV' })",
    received: 'hidden',
    lastState: 'hidden',
    isLocatorResolutionFailure: false,
  },
  notToBeVisible: {
    kind: 'assertion-timeout',
    assertion: 'toBeVisible',
    negated: true,
    locator: "locator('.spinner')",
    expected: 'not visible',
    received: 'visible',
    lastState: 'resolved',
  },
  toHaveText: {
    kind: 'assertion-timeout',
    assertion: 'toHaveText',
    locator: "getByRole('heading', { level: 1 })",
    expected: '"Welcome back"',
    received: '"Sign in"',
    lastState: 'resolved',
    isLocatorResolutionFailure: false,
  },
  toHaveAttribute: {
    kind: 'assertion-timeout',
    assertion: 'toHaveAttribute',
    locator: "locator('html')",
    expected: '"dark"',
    received: '"light"',
  },
  toHaveURL: {
    kind: 'assertion-timeout',
    assertion: 'toHaveURL',
    locator: null,
    leafLocator: null,
    expected: '/\\/dashboard$/',
    received: '"http://localhost:3000/login?next=%2Fdashboard"',
    url: 'http://localhost:3000/login?next=%2Fdashboard',
    timeoutMs: 5000,
    isNavigationFailure: false,
    isLocatorResolutionFailure: false,
  },
  toHaveTitle: {
    kind: 'assertion-timeout',
    assertion: 'toHaveTitle',
    locator: null,
    expected: '/Dashboard/',
    received: '"Sign in — Acme"',
  },
  timedOutExpectOldFormat: {
    kind: 'assertion-timeout',
    assertion: 'toBeVisible',
    locator: "locator('.modal.is-open')",
    timeoutMs: 5000,
    lastState: 'not-found',
    isLocatorResolutionFailure: true,
  },
  toPass: { kind: 'assertion-timeout', assertion: 'toPass', locator: null, timeoutMs: 10000 },
  toBeValue: {
    kind: 'assertion',
    assertion: 'toBe',
    locator: null,
    expected: '200',
    received: '401',
    timeoutMs: null,
    lastState: 'unknown',
  },
  toContainValue: { kind: 'assertion', assertion: 'toContain', expected: '"confirmed"', received: '"pending"' },
  toEqualDiff: { kind: 'assertion', assertion: 'toEqual', expected: null, received: null },
  strictClick: {
    kind: 'strict-mode',
    action: 'click',
    locator: "getByRole('button')",
    lastState: 'resolved-count',
    resolvedCount: 3,
    isLocatorResolutionFailure: true,
  },
  strictExpect: {
    kind: 'strict-mode',
    subject: 'expect',
    action: null,
    assertion: 'toBeVisible',
    locator: "getByText('Save')",
    resolvedCount: 2,
    timeoutMs: 5000,
    isLocatorResolutionFailure: true,
  },
  gotoRefused: {
    kind: 'navigation',
    subject: 'page',
    action: 'goto',
    url: 'http://localhost:3000/',
    networkErrorCode: 'net::ERR_CONNECTION_REFUSED',
    timeoutMs: null,
    locator: null,
    lastState: 'navigating',
    isNavigationFailure: true,
    isLocatorResolutionFailure: false,
  },
  gotoTimeout: {
    kind: 'navigation',
    action: 'goto',
    url: 'http://localhost:3000/users',
    networkErrorCode: null,
    timeoutMs: 30000,
    isNavigationFailure: true,
  },
  gotoDns: {
    kind: 'navigation',
    url: 'https://staging.example.internal/login',
    networkErrorCode: 'net::ERR_NAME_NOT_RESOLVED',
  },
  waitForURL: {
    kind: 'navigation',
    action: 'waitForURL',
    url: '/dashboard',
    timeoutMs: 5000,
    lastState: 'navigating',
    isNavigationFailure: true,
  },
  testTimeoutBare: {
    kind: 'test-timeout',
    errorName: null,
    action: null,
    locator: null,
    timeoutMs: 30000,
    timeoutPhase: null,
    lastState: 'unknown',
    lastCallLogLine: null,
    topFrame: null,
  },
  testTimeoutJoined: {
    kind: 'test-timeout',
    action: 'click',
    locator: "getByRole('button', { name: 'Pay' })",
    timeoutMs: 30000,
    lastState: 'not-enabled',
    isLocatorResolutionFailure: false,
  },
  testTimeoutHook: { kind: 'test-timeout', timeoutMs: 30000, timeoutPhase: 'beforeEach' },
  testTimeoutTeardown: { kind: 'test-timeout', timeoutMs: 30000, timeoutPhase: 'context' },
  testTimeoutGoto: {
    kind: 'test-timeout',
    action: 'goto',
    url: 'http://localhost:3000/reports',
    isNavigationFailure: true,
  },
  testTimeoutExpect: {
    kind: 'test-timeout',
    assertion: 'toBeVisible',
    locator: "getByText('Order confirmed')",
    lastState: 'not-found',
    isLocatorResolutionFailure: true,
  },
  crashClosed: {
    kind: 'crash',
    action: 'click',
    locator: "getByRole('button', { name: 'Continue' })",
    timeoutMs: null,
  },
  crashGoto: { kind: 'crash', action: 'goto', locator: null },
  pageCrashed: { kind: 'crash', action: 'click' },
  thrownError: {
    kind: 'unknown',
    errorName: 'Error',
    action: null,
    assertion: null,
    locator: null,
    topFrame: 'tests/checkout.spec.ts:20',
  },
  thrownTypeError: { kind: 'unknown', errorName: 'TypeError', topFrame: 'tests/users.spec.ts:33' },
  ansiColored: {
    kind: 'assertion-timeout',
    errorName: 'Error',
    assertion: 'toBeVisible',
    locator: "getByText('Settings saved')",
    expected: 'visible',
    received: '<element(s) not found>',
    lastState: 'not-found',
    isLocatorResolutionFailure: true,
  },
  apiRefused: { kind: 'unknown', subject: 'apiRequestContext', action: 'get', locator: null },
};

describe('parsePlaywrightError — golden corpus', () => {
  const keys = Object.keys(ERRORS) as ErrorKey[];

  test('covers at least 25 real error shapes', () => {
    expect(keys.length).toBeGreaterThanOrEqual(25);
  });

  test.each(keys)('%s', (key) => {
    const parsed = parsePlaywrightError(ERRORS[key]);
    expect(parsed).toMatchObject(EXPECTED[key]);
  });

  test('every corpus entry keeps its first line as the message head', () => {
    for (const key of keys) {
      const parsed = parsePlaywrightError(ERRORS[key]);
      const firstLine = stripAnsi(ERRORS[key]).split('\n')[0]!.trim();
      expect(parsed.messageHead.split('\n')[0]).toBe(firstLine);
      expect(parsed.messageHead).not.toContain('Call log:');
      expect(parsed.messageHead).not.toMatch(/^\s+at /m);
    }
  });

  test('the resolution flag is only set on never-found, zero-match and strict-mode failures', () => {
    for (const key of keys) {
      const parsed = parsePlaywrightError(ERRORS[key]);
      const derived =
        parsed.kind === 'strict-mode' ||
        (parsed.locator !== null &&
          (parsed.lastState === 'not-found' || (parsed.lastState === 'resolved-count' && parsed.resolvedCount === 0)));
      expect(parsed.isLocatorResolutionFailure, key).toBe(derived);
    }
  });
});

describe('parsePlaywrightError — edge cases', () => {
  test('never throws on empty, null or garbage input', () => {
    expect(parsePlaywrightError('')).toMatchObject({ kind: 'unknown', locator: null, messageHead: '' });
    expect(parsePlaywrightError(null)).toMatchObject({ kind: 'unknown' });
    expect(parsePlaywrightError(undefined)).toMatchObject({ kind: 'unknown' });
    expect(parsePlaywrightError(')))(((\n\n  - \n')).toMatchObject({ kind: 'unknown' });
  });

  test('a locator resolving to an element with no later state reads as resolved', () => {
    const parsed = parsePlaywrightError(
      "Error: locator.click: Target closed\nCall log:\n  - waiting for getByTestId('save')\n  - locator resolved to <button>Save</button>",
    );
    expect(parsed.lastState).toBe('resolved');
    expect(parsed.isLocatorResolutionFailure).toBe(false);
  });

  test('a detached element and an element outside the viewport are distinct states', () => {
    const base =
      "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button')\n  - locator resolved to <button>Go</button>\n";
    expect(parsePlaywrightError(`${base}  - element was detached from the DOM, retrying`).lastState).toBe('detached');
    expect(parsePlaywrightError(`${base}  - element is outside of the viewport`).lastState).toBe('outside-viewport');
    expect(parsePlaywrightError(`${base}  - element is not stable`).lastState).toBe('not-stable');
    expect(parsePlaywrightError(`${base}  - element is not editable`).lastState).toBe('not-editable');
  });

  test('a helper named goto in a stack frame is not a navigation', () => {
    const parsed = parsePlaywrightError(
      "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('link')\n    at goto (tests/helpers/page.goto.ts:3:1)",
    );
    expect(parsed.kind).toBe('action-timeout');
    expect(parsed.isNavigationFailure).toBe(false);
  });

  test('Windows line endings and a CRLF call log parse like LF', () => {
    const parsed = parsePlaywrightError(
      "TimeoutError: locator.click: Timeout 5000ms exceeded.\r\nCall log:\r\n  - waiting for getByRole('link')\r\n",
    );
    expect(parsed.lastState).toBe('not-found');
    expect(parsed.locator).toBe("getByRole('link')");
  });

  test('a locator nested inside a filter option stays part of the chain', () => {
    const chain = "getByRole('row').filter({ has: getByText('Ada') }).getByRole('button')";
    const parsed = parsePlaywrightError(
      `TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for ${chain}\n`,
    );
    expect(parsed.locator).toBe(chain);
    expect(parsed.leafLocator).toBe("getByRole('button')");
  });
});

describe('parsePlaywrightError — step params back the locator', () => {
  test("the error text's own locator wins over the step params", () => {
    const parsed = parsePlaywrightError(
      "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('link')\n",
      { stepParams: { locator: "getByRole('button', { name: 'Pay' })" } },
    );
    expect(parsed.locator).toBe("getByRole('link')");
  });

  test('the step params supply the locator when the error text names none', () => {
    // A custom expect.extend matcher: no Playwright-rendered locator in the message.
    const parsed = parsePlaywrightError('Error: expected the badge to read "3"\n    at tests/x.spec.ts:4:1', {
      stepParams: { locator: "getByTestId('badge')" },
    });
    expect(parsed.locator).toBe("getByTestId('badge')");
    expect(parsed.leafLocator).toBe("getByTestId('badge')");
  });

  test('the step params supply the URL when the error text names none', () => {
    const parsed = parsePlaywrightError('Error: something went wrong in a test.step\n    at tests/x.spec.ts:4:1', {
      stepParams: { url: 'https://shop.example.com/login' },
    });
    expect(parsed.url).toBe('https://shop.example.com/login');
  });

  test('no context leaves the parse unchanged', () => {
    const raw = 'Error: expected the badge to read "3"\n    at tests/x.spec.ts:4:1';
    expect(parsePlaywrightError(raw).locator).toBeNull();
    expect(parsePlaywrightError(raw, {}).locator).toBeNull();
  });
});

describe('locator and frame helpers', () => {
  test('extractSelector returns the first balanced call; extractLocatorChain the whole chain', () => {
    const text = "page.getByRole('row', { name: 'Acme' }).getByRole('button', { name: 'Delete' }).first().click()";
    expect(extractSelector(text)).toBe("getByRole('row', { name: 'Acme' })");
    expect(extractLocatorChain(text)).toBe(
      "getByRole('row', { name: 'Acme' }).getByRole('button', { name: 'Delete' }).first()",
    );
    expect(extractLeafSelector(text)).toBe("getByRole('button', { name: 'Delete' })");
  });

  test('extractLeafSelector reads parentheses inside names as text', () => {
    const text = "waiting for getByRole('dialog').getByRole('button', { name: 'Save :)' }) to be visible";
    expect(extractLeafSelector(text)).toBe("getByRole('button', { name: 'Save :)' })");
  });

  test('extractLeafSelector still finds the leaf of a chain cut short', () => {
    const text = "waiting for getByRole('row', { name: 'A (b)' }).getByRole('button', { name: 'Delete (c";
    expect(extractLeafSelector(text)).toBe("getByRole('button', { name: 'Delete (c");
  });

  test('extractSelector and extractLocatorChain return null without a locator', () => {
    expect(extractSelector('Timeout 30000ms exceeded')).toBeNull();
    expect(extractLocatorChain('Timeout 30000ms exceeded')).toBeNull();
  });

  test('extractTopFrame skips node_modules and node: frames and reports line and column', () => {
    const text = [
      'Error: boom',
      '    at Object.<anonymous> (/app/node_modules/@playwright/test/lib.js:5:5)',
      '    at node:internal/process/task_queues:95:5',
      '    at loginTest (/app/tests/login.spec.ts:12:7)',
    ].join('\n');
    expect(extractTopFrame(text)).toEqual({ file: '/app/tests/login.spec.ts', line: 12, column: 7 });
    expect(extractTopFrameFile(text)).toBe('/app/tests/login.spec.ts');
    expect(extractTopFrame('Error: boom\n    at /app/node_modules/x.js:1:1')).toBeNull();
  });

  test('extractStackFrames lists every frame outside node_modules, innermost first', () => {
    const text = [
      'Error: boom',
      '    at CheckoutPage.pay (C:\\ci\\tests\\pages\\checkout.page.ts:12:19)',
      '    at /app/node_modules/@playwright/test/lib.js:5:5',
      '    at /ci/tests/checkout.spec.ts:8:3',
    ].join('\n');
    expect(extractStackFrames(text)).toEqual([
      { file: 'C:/ci/tests/pages/checkout.page.ts', line: 12, column: 19 },
      { file: '/ci/tests/checkout.spec.ts', line: 8, column: 3 },
    ]);
    expect(withoutStackFrames(text)).toBe('Error: boom');
  });

  test('extractMessageHead stops at the call log and the stack and keeps five lines', () => {
    expect(extractMessageHead('a\n\nb\nCall log:\n  - x\n    at f:1:1')).toBe('a\nb');
    expect(extractMessageHead('1\n2\n3\n4\n5\n6\n7')).toBe('1\n2\n3\n4\n5');
  });

  test('readLocatorHeader reads the Locator: line of a web-first assertion only', () => {
    const text =
      "Error: expect(locator).toBeVisible() failed\n\nLocator:  getByRole('button', { name: 'Pay' }) \nExpected: visible";
    expect(readLocatorHeader(text)).toBe("getByRole('button', { name: 'Pay' })");
    expect(readLocatorHeader("locator.click: Timeout 5000ms exceeded.\n  - waiting for getByText('x')")).toBeNull();
  });

  test('stripAnsi removes SGR codes only', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m text \x1b[0m')).toBe('red text ');
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('parsing time stays linear in the text', () => {
  // Whitespace runs that a line-anchored `\s` pattern rescans from every line break.
  const pathological = {
    'blank lines': `Error: boom${'\n'.repeat(200_000)}x`,
    'space lines': `Error: boom${'\n '.repeat(100_000)}x`,
    'trailing-space lines': `Error: boom${' \n'.repeat(100_000)}x`,
    'unindented at lines': `Error: boom${'\n\nat x'.repeat(40_000)}`,
  };

  test.each(Object.entries(pathological))('%s parse in well under a second', (_name, text) => {
    const started = performance.now();
    parsePlaywrightError(text);
    extractErrorSignature(text);
    extractStackFrames(text);
    appendErrorLocation(text, { file: 'a.spec.ts', line: 1, column: 1 });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('the message head still ends where a stack frame follows blank lines', () => {
    expect(extractMessageHead('Error: boom\n\n\n    at f (a.ts:1:2)')).toBe('Error: boom');
    // The fingerprint hashes the head: a blank line, then `at `, starts the stack.
    expect(extractMessageHead('Error: boom\n\nat least one more line')).toBe('Error: boom');
    expect(extractMessageHead('Error: boom\nat least one more line')).toBe('Error: boom\nat least one more line');
    expect(extractMessageHead('Error: boom\n \nat f (a.ts:1:2)')).toBe('Error: boom');
  });

  test('a frame after blank lines and CRLF line ends is still read', () => {
    expect(extractStackFrames('Error: boom\r\n\r\n    at f (/app/a.spec.ts:3:4)\r\n')).toEqual([
      { file: '/app/a.spec.ts', line: 3, column: 4 },
    ]);
  });
});

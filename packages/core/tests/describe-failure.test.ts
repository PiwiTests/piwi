import { describe, test, expect } from 'vitest';
import { parsePlaywrightError } from '../src/error-parse';
import {
  describeFailure,
  describeFailureText,
  formatTimeout,
  lastStepTitle,
  stepHeadlineContext,
  HEADLINE_MAX_CHARS,
} from '../src/describe-failure';
import { ERRORS, type ErrorKey } from './fixtures/playwright-errors';
import {
  afterAllFailure,
  beforeAllFailure,
  beforeEachFailure,
  bodyFailure,
  type RecordedExecution,
} from './fixtures/playwright-steps';

const headline = (key: ErrorKey, ctx?: { lastStepTitle?: string | null }) =>
  describeFailure(parsePlaywrightError(ERRORS[key]), ctx).headline;

describe('describeFailure — one line per shape', () => {
  const EXPECTED: Record<ErrorKey, string> = {
    clickNotEnabled: "getByRole('button', { name: 'Pay' }) never became enabled — click timed out after 30 s",
    fillNotFound: "getByLabel('Email address') was not found on the page — fill timed out after 10 s",
    clickNoCallLogHeader: "getByRole('button', { name: 'Pay' }) was not found on the page — click timed out after 30 s",
    clickIntercepted:
      "getByRole('button', { name: 'Save' }) was covered by another element — click timed out after 5 s",
    fillNotVisible: "getByPlaceholder('Search') never became visible — fill timed out after 5 s",
    clickInert: "getByRole('button', { name: 'Place order' }) stayed inert — click timed out after 5 s",
    clickChained: "getByRole('button', { name: 'Delete' }) was not found on the page — click timed out after 30 s",
    waitForSelector: "locator('#app-ready') was not found on the page — waitForSelector timed out after 5 s",
    toHaveCount: "Expected 26 rows, found 51 — getByRole('row') toHaveCount",
    toHaveCountZero: "Expected 3 listitems, found none — getByRole('listitem') toHaveCount",
    toBeVisibleText: 'Text "Invite sent" never became visible (30 s)',
    toBeVisibleHidden: "getByRole('button', { name: 'Export CSV' }) never became visible (5 s)",
    notToBeVisible: "locator('.spinner') stayed visible (5 s)",
    toHaveText: 'Expected text "Welcome back", got "Sign in" — getByRole(\'heading\', { level: 1 }) toHaveText',
    toHaveTextDescribed:
      "getByTestId('cart').getByTestId('order-total') was not found on the page — expected text \"$42.00\" (5 s)",
    toHaveAttribute: 'Expected attribute "dark", got "light" — locator(\'html\') toHaveAttribute',
    toHaveURL: 'Expected URL /\\/dashboard$/, got "/login?next=%2Fdashboard" — page toHaveURL',
    toHaveTitle: 'Expected title /Dashboard/, got "Sign in — Acme" — page toHaveTitle',
    timedOutExpectOldFormat: "locator('.modal.is-open') never became visible (5 s)",
    toPass: 'expect.toPass never passed (10 s)',
    toBeValue: 'Expected 200, got 401 — toBe',
    toContainValue: 'Expected "confirmed", got "pending" — toContain',
    toEqualDiff: 'toEqual assertion failed',
    strictClick: "getByRole('button') matched 3 buttons — strict mode",
    strictExpect: "getByText('Save') matched 2 elements — strict mode",
    gotoRefused: 'Connection refused loading http://localhost:3000/',
    gotoTimeout: 'Navigation to /users timed out after 30 s',
    gotoDns: 'DNS lookup failed for https://staging.example.internal/login',
    waitForURL: 'Never navigated to /dashboard — waitForURL timed out after 5 s',
    testTimeoutBare: 'Test timed out after 30 s',
    testTimeoutJoined: "Test timed out after 30 s while clicking getByRole('button', { name: 'Pay' })",
    testTimeoutHook: 'Test timed out after 30 s in the "beforeEach" hook',
    testTimeoutTeardown: 'Test timed out after 30 s while tearing down "context"',
    testTimeoutGoto: 'Test timed out after 30 s while navigating to /reports',
    testTimeoutExpect: 'Test timed out after 30 s while waiting for Text "Order confirmed" to be visible',
    crashClosed: "Page or browser closed during click on getByRole('button', { name: 'Continue' })",
    crashGoto: 'Page or browser closed during navigation',
    pageCrashed: 'Page crashed during click',
    thrownError: 'Payment provider returned an unexpected status',
    thrownTypeError: "TypeError: Cannot read properties of undefined (reading 'id')",
    ansiColored: 'Text "Settings saved" never became visible (5 s)',
    apiRefused: 'apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:4000',
  };

  test.each(Object.keys(ERRORS) as ErrorKey[])('%s', (key) => {
    expect(headline(key)).toBe(EXPECTED[key]);
  });

  test('every headline is plain, short, mask-free and equals its parts', () => {
    for (const key of Object.keys(ERRORS) as ErrorKey[]) {
      const d = describeFailure(parsePlaywrightError(ERRORS[key]));
      expect(d.headline.length, key).toBeLessThanOrEqual(HEADLINE_MAX_CHARS);
      // eslint-disable-next-line no-control-regex
      expect(d.headline, key).not.toMatch(/\n|\x1b/);
      expect(d.headline, key).not.toMatch(/<(?:N|VALUE|URL|STR|UUID|HASH|EMAIL)>/);
      expect(d.parts.map((p) => p.text).join(''), key).toBe(d.headline);
      expect(d.headline.trim().length, key).toBeGreaterThan(0);
    }
  });

  test('is deterministic', () => {
    expect(headline('clickNotEnabled')).toBe(headline('clickNotEnabled'));
  });
});

describe('describeFailure — test timeouts name the step when the error carries no pending action', () => {
  test('the pending action in the error wins over a step title', () => {
    expect(headline('testTimeoutJoined', { lastStepTitle: 'Verify confirmation' })).toBe(
      "Test timed out after 30 s while clicking getByRole('button', { name: 'Pay' })",
    );
  });

  test('a bare test timeout names the step the caller knows', () => {
    expect(headline('testTimeoutBare', { lastStepTitle: 'fillPaymentDetails(page)' })).toBe(
      'Test timed out after 30 s while "fillPaymentDetails(page)"',
    );
    expect(headline('testTimeoutBare', { lastStepTitle: '  ' })).toBe('Test timed out after 30 s');
  });
});

describe('describeFailure — toHaveCount reads the received count from an unbulleted retry line', () => {
  // Playwright indents the retry-count line under its `waiting for` bullet without a
  // bullet of its own; the received count must still reach the headline.
  const err = `Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('row')
Expected: 26
Received: 51
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" with timeout 5000ms
  - waiting for getByRole('row')
    9 × locator resolved to 51 elements
      - unexpected value "51"

    at tests/admin/users.spec.ts:7:44`;

  test('the headline names the resolved count, not "none"', () => {
    const d = describeFailureText(err);
    expect(d?.headline).toBe("Expected 26 rows, found 51 — getByRole('row') toHaveCount");
    expect(d?.detail).toBeNull();
  });

  test('the count mismatch is not read as a locator-resolution failure', () => {
    const parsed = parsePlaywrightError(err);
    expect(parsed.resolvedCount).toBe(51);
    expect(parsed.lastState).toBe('resolved-count');
    expect(parsed.isLocatorResolutionFailure).toBe(false);
  });
});

describe('describeFailure — parts and detail', () => {
  test('marks the locator so a UI can render it as code', () => {
    const d = describeFailure(parsePlaywrightError(ERRORS.clickNotEnabled));
    expect(d.parts).toEqual([
      { kind: 'locator', text: "getByRole('button', { name: 'Pay' })" },
      { kind: 'text', text: ' never became enabled — click timed out after 30 s' },
    ]);
  });

  test('marks values and the getByText subject', () => {
    const count = describeFailure(parsePlaywrightError(ERRORS.toBeValue));
    expect(count.parts).toEqual([
      { kind: 'text', text: 'Expected ' },
      { kind: 'value', text: '200' },
      { kind: 'text', text: ', got ' },
      { kind: 'value', text: '401' },
      { kind: 'text', text: ' — toBe' },
    ]);
    const text = describeFailure(parsePlaywrightError(ERRORS.toBeVisibleText));
    expect(text.parts[0]).toEqual({ kind: 'text', text: 'Text ' });
    expect(text.parts[1]).toEqual({ kind: 'value', text: '"Invite sent"' });
  });

  test('the detail carries what the headline left out, and nothing it already says', () => {
    expect(describeFailure(parsePlaywrightError(ERRORS.clickNotEnabled)).detail).toBe('element is not enabled');
    expect(describeFailure(parsePlaywrightError(ERRORS.clickInert)).detail).toBe('element is inert');
    expect(describeFailure(parsePlaywrightError(ERRORS.clickIntercepted)).detail).toBe(
      '<div class="modal-backdrop"></div> intercepts pointer events',
    );
    expect(describeFailure(parsePlaywrightError(ERRORS.fillNotFound)).detail).toBeNull();
    expect(describeFailure(parsePlaywrightError(ERRORS.toBeVisibleHidden)).detail).toBe('Received: hidden');
    expect(describeFailure(parsePlaywrightError(ERRORS.toBeVisibleText)).detail).toBeNull();
    expect(describeFailure(parsePlaywrightError(ERRORS.toHaveCount)).detail).toBeNull();
    expect(describeFailure(parsePlaywrightError(ERRORS.gotoRefused)).detail).toBe('net::ERR_CONNECTION_REFUSED');
    expect(describeFailure(parsePlaywrightError(ERRORS.strictClick)).detail).toBeNull();
  });
});

describe('describeFailure — length control', () => {
  test('a long chain falls back to the leaf locator before truncating', () => {
    const chain = `getByRole('row', { name: '${'Ada Lovelace '.repeat(6).trim()}' }).getByRole('cell', { name: 'Email' }).getByRole('button', { name: 'Copy address' })`;
    const d = describeFailure(
      parsePlaywrightError(
        `TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for ${chain}\n`,
      ),
    );
    expect(d.headline).toBe(
      "getByRole('button', { name: 'Copy address' }) was not found on the page — click timed out after 5 s",
    );
  });

  test('a hopeless line is truncated with an ellipsis and its parts follow', () => {
    const d = describeFailure(parsePlaywrightError(`Error: ${'x'.repeat(300)}`));
    expect(d.headline.length).toBe(HEADLINE_MAX_CHARS);
    expect(d.headline.endsWith('…')).toBe(true);
    expect(d.parts.map((p) => p.text).join('')).toBe(d.headline);
  });

  test('long expected and received values are shortened', () => {
    const d = describeFailure(
      parsePlaywrightError(
        `Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "${'a'.repeat(80)}"\nReceived: "${'b'.repeat(80)}"\n`,
      ),
    );
    expect(d.headline.length).toBeLessThanOrEqual(HEADLINE_MAX_CHARS);
    expect(d.headline).toMatch(/^Expected "a+…, got "b+… — toBe$/);
  });
});

describe('describeFailure — fallbacks', () => {
  test('an unknown shape returns its first line, trimmed and ANSI-free', () => {
    const d = describeFailureText('\x1b[31m  Something odd happened  \x1b[0m\nmore\n');
    expect(d?.headline).toBe('Something odd happened');
  });

  test('a fingerprint mask token never reaches the headline', () => {
    expect(describeFailureText('Timeout <N>ms exceeded waiting for <VALUE>')?.headline).toBe(
      'Timeout …ms exceeded waiting for …',
    );
  });

  test('empty input yields null from the text helper and a placeholder from the parsed one', () => {
    expect(describeFailureText('')).toBeNull();
    expect(describeFailureText(null)).toBeNull();
    expect(describeFailure(parsePlaywrightError('')).headline).toBe('Unknown error');
  });
});

describe('helpers', () => {
  test('formatTimeout', () => {
    expect(formatTimeout(30000)).toBe('30 s');
    expect(formatTimeout(1500)).toBe('1.5 s');
    expect(formatTimeout(500)).toBe('500 ms');
    expect(formatTimeout(90000)).toBe('90 s');
  });

  test('lastStepTitle prefers the failed step, then the last one', () => {
    expect(lastStepTitle([{ title: 'a' }, { title: 'b', failed: true }, { title: 'c' }])).toBe('b');
    expect(lastStepTitle([{ title: 'a' }, { title: 'c' }])).toBe('c');
    expect(lastStepTitle([])).toBeNull();
    expect(lastStepTitle(null)).toBeNull();
  });

  test('lastStepTitle names the failing step inside a hook, never the hook container', () => {
    expect(lastStepTitle(beforeEachFailure.steps)).toBe('Click');
    expect(lastStepTitle(beforeAllFailure.steps)).toBe('seeding the report fixtures');
  });

  test('lastStepTitle falls back to the last step of the test body, not the teardown', () => {
    const passedSteps = bodyFailure.steps.map(({ failed: _failed, error: _error, ...step }) => step);
    expect(lastStepTitle(passedSteps)).toBe('Fill "ada@example.com"');
  });
});

describe('headlines read with the recorded steps', () => {
  const headlineOf = (execution: RecordedExecution) =>
    describeFailureText(execution.error, stepHeadlineContext(execution.steps, execution.error))?.headline;

  test('a failure in the test body has no lead', () => {
    expect(headlineOf(bodyFailure)).toBe(
      "getByLabel('Email address') was not found on the page — fill timed out after 2 s",
    );
  });

  test('a failure in a hook names the hook first', () => {
    expect(headlineOf(beforeEachFailure)).toBe(
      "In beforeEach: getByRole('button', { name: 'Edit profile' }) was not found on the page — click timed out after 1.5 s",
    );
  });

  test('the message given to expect() is quoted, after the hook', () => {
    expect(headlineOf(beforeAllFailure)).toBe(
      'In beforeAll, "seeding the report fixtures" failed: expected true, got false — toBe',
    );
    expect(headlineOf(afterAllFailure)).toBe('In afterAll, "cleanup endpoint" failed: expected 200, got 500 — toBe');
  });

  test('a custom expect() message leads a failure in the test body too', () => {
    const error =
      'Error: the order total\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 42\nReceived: 41';
    expect(describeFailureText(error)?.headline).toBe('"the order total" failed: expected 42, got 41 — toBe');
  });

  test('a lead keeps the capital of a name the line starts with', () => {
    const failedIn = { phase: 'setup' as const, hook: 'beforeAll' };
    expect(describeFailureText('TypeError: fetch failed', { failedIn })?.headline).toBe(
      'In beforeAll: TypeError: fetch failed',
    );
    expect(describeFailureText('Error: Timed out waiting for the seed', { failedIn })?.headline).toMatch(
      /^In beforeAll: timed out/,
    );
  });

  test('a test timeout that names its hook keeps its own wording', () => {
    const d = describeFailure(parsePlaywrightError(ERRORS.testTimeoutHook), {
      failedIn: { phase: 'setup', hook: 'beforeEach' },
    });
    expect(d.headline.startsWith('In ')).toBe(false);
  });
});

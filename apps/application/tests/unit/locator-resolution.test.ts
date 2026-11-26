import { describe, test, expect } from 'vitest';
import { classifyLocatorResolution, healingNotApplicableMarkdown } from '#shared/locator-resolution';

/**
 * The healing gate reads Playwright's call log: healing applies only when the
 * locator never resolved, matched nothing, or matched several elements. Each
 * case below is a real call-log shape.
 */

const STACK = '\n    at tests/checkout.spec.ts:42:5';
const ESC = '\x1b';

describe('classifyLocatorResolution — applicable', () => {
  test('waiting for a locator with no later "resolved to" line → never-resolved', () => {
    const error = `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })\n${STACK}`;
    expect(classifyLocatorResolution(error)).toEqual({ kind: 'never-resolved', applicable: true, reason: null });
  });

  test('a web-first assertion still waiting for the locator → never-resolved', () => {
    const error = `Error: expect(locator).toBeVisible() failed\n\nLocator: locator('.modal.is-open')\nExpected: visible\nTimeout: 5000ms\n\nCall log:\n  - Expect "toBeVisible" with timeout 5000ms\n  - waiting for locator('.modal.is-open') to be visible\n${STACK}`;
    expect(classifyLocatorResolution(error).kind).toBe('never-resolved');
  });

  test('a described locator, its description in the Locator: header, still waiting → never-resolved', () => {
    const error = `Error: expect(locator).toHaveText(expected) failed\n\nLocator: Order total\nExpected: "$42.00"\nTimeout: 5000ms\nError: element(s) not found\n\nCall log:\n  - Expect "toHaveText" with timeout 5000ms\n  - waiting for getByTestId('order-total')\n${STACK}`;
    expect(classifyLocatorResolution(error)).toEqual({ kind: 'never-resolved', applicable: true, reason: null });
  });

  test('an explicit "resolved to 0 elements" → zero-elements', () => {
    const error = `Error: expect(locator).toHaveCount(expected) failed\n\nCall log:\n  - waiting for getByRole('row')\n  - locator resolved to 0 elements\n  - unexpected value "0"\n${STACK}`;
    expect(classifyLocatorResolution(error)).toEqual({ kind: 'zero-elements', applicable: true, reason: null });
  });

  test('a strict-mode violation → strict-mode, even though it lists resolved elements', () => {
    const error = `Error: locator.click: Error: strict mode violation: getByRole('button') resolved to 2 elements:\n    1) <button>Save</button>\n    2) <button>Cancel</button>\n${STACK}`;
    expect(classifyLocatorResolution(error)).toEqual({ kind: 'strict-mode', applicable: true, reason: null });
  });

  test('a locator with no call log at all is given the benefit of the doubt', () => {
    const error = `Error: locator.click: Target closed\nLocator: getByTestId('save')${STACK}`;
    expect(classifyLocatorResolution(error)).toEqual({ kind: 'unknown', applicable: true, reason: null });
  });
});

describe('classifyLocatorResolution — not applicable', () => {
  test('"locator resolved to N elements" (a count mismatch) → resolved', () => {
    const error = `Error: expect(locator).toHaveCount(expected) failed\n\nLocator: getByRole('row')\nExpected: 26\nReceived: 51\nTimeout: 5000ms\n\nCall log:\n  - Expect "toHaveCount" with timeout 5000ms\n  - waiting for getByRole('row')\n  - 9 × locator resolved to 51 elements\n    - unexpected value "51"\n${STACK}`;
    expect(classifyLocatorResolution(error)).toEqual({
      kind: 'resolved',
      applicable: false,
      reason: 'The locator resolved; this is not a locator problem.',
    });
  });

  test('"locator resolved to <element>" followed by "element is not enabled" → resolved', () => {
    const error = `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })\n  - locator resolved to <button disabled type="submit">Pay now</button>\n  - attempting click action\n  - waiting for element to be visible, enabled and stable\n  - element is not enabled\n  - retrying click action\n${STACK}`;
    const verdict = classifyLocatorResolution(error);
    expect(verdict.kind).toBe('resolved');
    expect(verdict.applicable).toBe(false);
  });

  test('"locator resolved to <element>" followed by "element is inert" → resolved', () => {
    const error = `TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })\n    - locator resolved to <button type="submit">Pay now</button>\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is inert\n    - retrying click action\n    - waiting 20ms\n${STACK}`;
    expect(classifyLocatorResolution(error)).toEqual({
      kind: 'resolved',
      applicable: false,
      reason: 'The locator resolved; this is not a locator problem.',
    });
  });

  test('a hidden element ("resolved to <button hidden>", "unexpected value hidden") → resolved', () => {
    const error = `Error: expect(locator).toBeVisible() failed\n\nCall log:\n  - waiting for getByRole('button', { name: 'Export CSV' })\n  - 9 × locator resolved to <button hidden class="export-btn">Export CSV</button>\n    - unexpected value "hidden"\n${STACK}`;
    expect(classifyLocatorResolution(error).kind).toBe('resolved');
  });

  test('a page.goto timeout → navigation', () => {
    const error = `TimeoutError: page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://shop.example.com/checkout", waiting until "load"\n${STACK}`;
    expect(classifyLocatorResolution(error)).toEqual({
      kind: 'navigation',
      applicable: false,
      reason: 'The page failed to navigate before any locator ran; this is not a locator problem.',
    });
    const refused = `Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/${STACK}`;
    expect(classifyLocatorResolution(refused).kind).toBe('navigation');
  });

  test('an error that names no locator → no-locator', () => {
    const error = `Error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 3${STACK}`;
    expect(classifyLocatorResolution(error)).toEqual({
      kind: 'no-locator',
      applicable: false,
      reason: 'No locator in the error; nothing to heal.',
    });
    expect(classifyLocatorResolution(null).applicable).toBe(false);
    expect(classifyLocatorResolution('').applicable).toBe(false);
  });

  test('a "goto" in a stack-frame path is not a navigation error', () => {
    const error = `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('link', { name: 'Next' })\n\n    at tests/goto-helpers.spec.ts:10:3`;
    expect(classifyLocatorResolution(error).kind).toBe('never-resolved');
  });

  test('ANSI color codes do not hide the resolved line', () => {
    const error = `${ESC}[31mError: expect(locator).toHaveCount(expected) failed${ESC}[39m\nCall log:\n  - waiting for getByRole('row')\n  - ${ESC}[2mlocator resolved to 51 elements${ESC}[22m`;
    expect(classifyLocatorResolution(error).kind).toBe('resolved');
  });
});

describe('healingNotApplicableMarkdown', () => {
  test('renders the reason as an AI-context section only for a rejected result', () => {
    expect(healingNotApplicableMarkdown({ applicable: true })).toBeNull();
    expect(healingNotApplicableMarkdown({})).toBeNull();
    const md = healingNotApplicableMarkdown({
      applicable: false,
      reason: 'The locator resolved; this is not a locator problem.',
    });
    expect(md).toContain('## Alternative Locators (Locator Healing)');
    expect(md).toContain('Not applicable — The locator resolved; this is not a locator problem.');
    expect(md).toContain('Do not propose a replacement locator.');
  });
});

describe('classifyLocatorResolution agrees with the parser', () => {
  test('a resolution failure per the parser is always healable, and a resolved locator never is', async () => {
    const { parsePlaywrightError } = await import('#shared/error-parse');
    const errors = [
      `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })\n${STACK}`,
      `Error: expect(locator).toHaveCount(expected) failed\n\nLocator: getByRole('row')\nExpected: 26\nReceived: 51\nTimeout: 5000ms\n\nCall log:\n  - waiting for getByRole('row')\n  - 9 × locator resolved to 51 elements\n${STACK}`,
      `Error: locator.click: Error: strict mode violation: getByRole('button') resolved to 2 elements:\n    1) <button>Save</button>\n    2) <button>Cancel</button>\n${STACK}`,
      `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })\n  - locator resolved to <button disabled>Pay</button>\n  - element is not enabled\n${STACK}`,
      `Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/\nCall log:\n  - navigating to "http://localhost:3000/", waiting until "load"\n${STACK}`,
      `Error: expect(locator).toHaveCount(expected) failed\n\nCall log:\n  - waiting for getByRole('row')\n  - locator resolved to 0 elements\n${STACK}`,
    ];
    for (const error of errors) {
      const parsed = parsePlaywrightError(error);
      const verdict = classifyLocatorResolution(error);
      if (parsed.isLocatorResolutionFailure) expect(verdict.applicable, error).toBe(true);
      if (verdict.kind === 'resolved' || verdict.kind === 'navigation')
        expect(parsed.isLocatorResolutionFailure, error).toBe(false);
    }
  });
});

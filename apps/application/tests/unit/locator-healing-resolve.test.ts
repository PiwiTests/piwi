import { describe, test, expect } from 'vitest';
import { healedInRunFrom, resolveHealingForCase } from '~~/server/utils/locator-healing';
import type { OutcomeRecord } from '~~/server/utils/outcomes';
import { locatorSignatureFromExpression } from '#shared/locator-healing';
import type { LocatorSnapshotRow } from '~~/server/database/schema';
import type { RankedLocator } from '#shared/locator-healing.types';

/**
 * The shared healing ladder used by both the single-case and batch entry
 * points: location → signature → cross-test → ARIA fallback, and the stored
 * healed-run signal. Driven with fabricated snapshot rows and an injected
 * cross-test lookup, so no DB is needed.
 */

const chainError = (chain: string, loc = 'tests/checkout.spec.ts:42:5') =>
  `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for ${chain}\n    at ${loc}`;

const PAY_TESTID: RankedLocator = {
  locator: "getByTestId('pay-btn')",
  method: 'getByTestId',
  args: { testId: 'pay-btn' },
  score: 100,
};

function snap(o: Partial<LocatorSnapshotRow>): LocatorSnapshotRow {
  return {
    id: 1,
    testCaseId: 10,
    location: null,
    usedMethod: 'getByRole',
    usedArgs: '[]',
    usedArgsFp: 'fp-x',
    elementTag: 'button',
    elementAttrs: '{}',
    elementText: 'Pay',
    alternatives: JSON.stringify([PAY_TESTID]),
    lastSeenRunId: 1,
    lastSeenAt: new Date(0),
    ...o,
  } as LocatorSnapshotRow;
}

const FAILING = "getByRole('button', { name: 'Pay' })";

describe('resolveHealingForCase — ladder', () => {
  test('no error → source none, not applicable', async () => {
    const r = await resolveHealingForCase({ error: null }, [], null);
    expect(r.source).toBe('none');
    expect(r.applicable).toBe(false);
    expect(r.reason).toBe('No locator in the error; nothing to heal.');
  });

  test('a resolution failure marks the result applicable', async () => {
    const rows = [snap({ location: 'tests/checkout.spec.ts:42:5' })];
    const r = await resolveHealingForCase({ error: chainError(FAILING) }, rows, null);
    expect(r.applicable).toBe(true);
    expect(r.reason).toBeNull();
  });

  test('ladder 1: call-site location match → prior-run, with location + sourceLine stamped', async () => {
    const rows = [snap({ location: 'tests/checkout.spec.ts:42:5' })];
    const r = await resolveHealingForCase(
      {
        error: chainError(FAILING),
        testSource: '>  42 |   await page.getByRole("button", { name: "Pay" }).click();',
      },
      rows,
      null,
    );
    expect(r.source).toBe('prior-run');
    expect(r.location).toBe('tests/checkout.spec.ts:42:5');
    expect(r.sourceLine).toEqual({ line: 42, text: '  await page.getByRole("button", { name: "Pay" }).click();' });
    expect(r.recommendation?.recommended?.locator).toBe("getByTestId('pay-btn')");
  });

  test('ladder 2: signature match (no location) → fingerprint', async () => {
    const sig = await locatorSignatureFromExpression(FAILING);
    // Snapshot at a different line, so only the signature can match.
    const rows = [snap({ location: 'tests/checkout.spec.ts:99:1', usedArgsFp: sig, usedMethod: 'getByRole' })];
    const r = await resolveHealingForCase({ error: chainError(FAILING) }, rows, null);
    expect(r.source).toBe('fingerprint');
  });

  test('ladder 2.5: cross-test lookup via the injected callback → cross-test', async () => {
    const sig = await locatorSignatureFromExpression(FAILING);
    let askedSig: string | null = null;
    const crossRow = snap({ testCaseId: 77, usedArgsFp: sig });
    const r = await resolveHealingForCase({ error: chainError(FAILING) }, [], (s) => {
      askedSig = s;
      return Promise.resolve(crossRow);
    });
    expect(askedSig).toBe(sig);
    expect(r.source).toBe('cross-test');
  });

  test('ladder 3: ARIA fallback when nothing is stored', async () => {
    const r = await resolveHealingForCase({ error: chainError(FAILING), ariaSnapshot: '- button "Pay now"' }, [], () =>
      Promise.resolve(null),
    );
    expect(r.source).toBe('aria-snapshot');
    expect(r.recommendation?.recommended?.locator).toBe("getByRole('button', { name: 'Pay now' })");
  });

  test('ladder 3 never recommends the element the failing getByRole already names', async () => {
    const aria = '- button "Pay"\n- link "Pay"';
    const r = await resolveHealingForCase({ error: chainError(FAILING), ariaSnapshot: aria }, [], null);
    expect(r.source).toBe('aria-snapshot');
    // Listed for context, never recommended: each finds the button "Pay", or one named like it.
    expect(r.fromAriaSnapshot?.map((a) => a.locator)).toContain(FAILING);
    expect(r.recommendation).toBeNull();
  });

  test('ladder 3 can recommend a getByRole with the name of a failing getByText', async () => {
    // An aria-label names the button: getByText does not read it, getByRole does.
    const error = chainError("getByText('Pay')");
    const r = await resolveHealingForCase({ error, ariaSnapshot: '- button "Pay"' }, [], null);
    expect(r.recommendation?.recommended?.locator).toBe("getByRole('button', { name: 'Pay' })");
  });
});

describe('resolveHealingForCase — resolution gate', () => {
  const ARIA = '- document:\n  - button "Pay" [ref=e1]\n  - button "Cancel" [ref=e2]';

  test('a locator that resolved (count mismatch) yields no alternatives, no recommendation, no ARIA fallback', async () => {
    const error = `Error: expect(locator).toHaveCount(expected) failed\n\nCall log:\n  - waiting for getByRole('row')\n  - 9 × locator resolved to 51 elements\n    - unexpected value "51"\n    at tests/admin/users.spec.ts:12:3`;
    const rows = [snap({ location: 'tests/admin/users.spec.ts:12:3' })];
    const r = await resolveHealingForCase({ error, ariaSnapshot: ARIA }, rows, null);
    expect(r.applicable).toBe(false);
    expect(r.reason).toBe('The locator resolved; this is not a locator problem.');
    expect(r.source).toBe('none');
    expect(r.recommendation).toBeNull();
    expect(r.fromPriorSuccess).toBeNull();
    expect(r.fromAriaSnapshot).toBeNull();
    expect(r.edit).toBeUndefined();
    // The failing locator stays for display.
    expect(r.failingLocator).toEqual({ method: 'getByRole', args: { role: 'row' } });
  });

  test('a resolved-then-disabled element is not healed even with a stored snapshot at the call site', async () => {
    const error = `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for ${FAILING}\n  - locator resolved to <button disabled>Pay now</button>\n  - element is not enabled\n    at tests/checkout.spec.ts:42:5`;
    const rows = [snap({ location: 'tests/checkout.spec.ts:42:5' })];
    const r = await resolveHealingForCase({ error, ariaSnapshot: ARIA }, rows, null);
    expect(r.applicable).toBe(false);
    expect(r.recommendation).toBeNull();
  });

  test('a navigation timeout never reaches the ARIA fallback', async () => {
    const error = `TimeoutError: page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://shop.example.com/checkout", waiting until "load"\n    at tests/checkout.spec.ts:8:3`;
    const r = await resolveHealingForCase({ error, ariaSnapshot: ARIA }, [], null);
    expect(r.applicable).toBe(false);
    expect(r.reason).toContain('not a locator problem');
    expect(r.fromAriaSnapshot).toBeNull();
  });

  test('a strict-mode violation is healed', async () => {
    const error = `Error: locator.click: Error: strict mode violation: ${FAILING} resolved to 2 elements:\n    1) <button>Pay</button>\n    2) <button>Pay</button>\n    at tests/checkout.spec.ts:42:5`;
    const rows = [snap({ location: 'tests/checkout.spec.ts:42:5' })];
    const r = await resolveHealingForCase({ error }, rows, null);
    expect(r.applicable).toBe(true);
    expect(r.source).toBe('prior-run');
  });
});

describe('resolveHealingForCase — narrowing suggestion', () => {
  const strictError = `Error: locator.click: Error: strict mode violation: ${FAILING} resolved to 3 elements:\n    1) <button>Pay</button>\n    2) <button>Pay</button>\n    3) <button>Pay</button>\n    at tests/checkout.spec.ts:42:5`;
  // The aria tree omits hidden nodes, so a single matching entry means one visible match.
  const oneVisibleAria = '- heading "Checkout"\n- button "Pay"';

  test('suggests .visible() when one match is visible and Playwright is 1.63+', async () => {
    const r = await resolveHealingForCase(
      { error: strictError, ariaSnapshot: oneVisibleAria, playwrightVersion: '1.63.0' },
      [],
      null,
    );
    expect(r.narrowingSuggestion).toEqual({ method: 'visible', matchCount: 3, visibleCount: 1 });
  });

  test('withheld below Playwright 1.63', async () => {
    const r = await resolveHealingForCase(
      { error: strictError, ariaSnapshot: oneVisibleAria, playwrightVersion: '1.61.1' },
      [],
      null,
    );
    expect(r.narrowingSuggestion ?? null).toBeNull();
  });

  test('withheld when several matches are visible', async () => {
    const r = await resolveHealingForCase(
      {
        error: strictError,
        ariaSnapshot: '- button "Pay"\n- button "Pay"',
        playwrightVersion: '1.63.0',
      },
      [],
      null,
    );
    expect(r.narrowingSuggestion ?? null).toBeNull();
  });

  test('withheld for a non-strict failure', async () => {
    const timeout = `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for ${FAILING}\n    at tests/checkout.spec.ts:42:5`;
    const r = await resolveHealingForCase(
      { error: timeout, ariaSnapshot: oneVisibleAria, playwrightVersion: '1.63.0' },
      [],
      null,
    );
    expect(r.narrowingSuggestion ?? null).toBeNull();
  });
});

describe('healedInRunFrom — the stored applied heal', () => {
  const applied = (o: { subjectId?: number; location?: string; appliedRunId?: number }): OutcomeRecord => ({
    id: 1,
    projectId: 1,
    kind: 'locator-heal',
    subjectType: 'test-case',
    subjectId: o.subjectId ?? 10,
    suggestionKey: 'k',
    outcome: 'applied',
    channel: 'inferred',
    actorUserId: null,
    actorApiKeyId: null,
    runId: o.appliedRunId ?? 42,
    commit: null,
    details: {
      location: o.location ?? 'tests/checkout.spec.ts:42:5',
      recommendedLocator: PAY_TESTID.locator,
      recommendedSig: 'sig',
      failingLocator: null,
      failingRunId: 1,
      appliedRunId: o.appliedRunId ?? 42,
    },
    createdAt: new Date(0),
  });

  test('names the run whose code first used the recommendation at the failing call site', () => {
    const rows = [applied({ appliedRunId: 50 }), applied({ appliedRunId: 42 })];
    expect(healedInRunFrom(rows, 10, '/repo/tests/checkout.spec.ts:42:9', 1)).toBe(42);
  });

  test('an earlier run never counts as healed', () => {
    expect(healedInRunFrom([applied({ appliedRunId: 3 })], 10, 'tests/checkout.spec.ts:42:5', 7)).toBeNull();
    expect(healedInRunFrom([applied({ appliedRunId: 7 })], 10, 'tests/checkout.spec.ts:42:5', 7)).toBeNull();
  });

  test('another call site or another test does not count', () => {
    expect(
      healedInRunFrom([applied({ location: 'tests/checkout.spec.ts:80:3' })], 10, 'tests/checkout.spec.ts:42:5', 1),
    ).toBeNull();
    expect(healedInRunFrom([applied({ subjectId: 11 })], 10, 'tests/checkout.spec.ts:42:5', 1)).toBeNull();
  });
});

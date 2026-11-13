import { describe, test, expect } from 'vitest';
import { buildFailureVerdict, caseHeadline } from '#shared/failure-verdict';

const PAY_ERROR = `TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Pay' })
  - locator resolved to <button disabled>Pay now</button>
  - attempting click action
  - waiting for element to be visible, enabled and stable
  - element is not enabled
    at tests/checkout.spec.ts:42:5`;

const CLUSTER = {
  id: 7,
  signature: 'TimeoutError: locator.click: Timeout <N>ms exceeded.',
  title: 'Pay button stays disabled after the quote times out',
  errorType: 'timeout',
  selector: "getByRole('button', { name: 'Pay' })",
  firstSeenRunId: 4,
  firstSeenAt: '2026-08-30T10:00:00.000Z',
  sameRunCaseCount: 2,
};

describe('caseHeadline', () => {
  test('describes the stored error, naming the failed step for a test timeout', () => {
    expect(caseHeadline({ error: PAY_ERROR })?.headline).toBe(
      "getByRole('button', { name: 'Pay' }) never became enabled — click timed out after 30 s",
    );
    expect(
      caseHeadline({
        error: 'Test timeout of 30000ms exceeded.',
        steps: [{ title: "page.goto('/checkout')" }, { title: 'fillPaymentDetails(page)', failed: true }],
      })?.headline,
    ).toBe('Test timed out after 30 s while "fillPaymentDetails(page)"');
    expect(caseHeadline({ error: null })).toBeNull();
  });
});

describe('buildFailureVerdict', () => {
  test('returns null for an execution without an error', () => {
    expect(buildFailureVerdict({ error: null, status: 'passed', runId: 9 })).toBeNull();
  });

  test('assembles headline, why, since, cluster and owner from the loaded rows', () => {
    const verdict = buildFailureVerdict({
      error: PAY_ERROR,
      status: 'failed',
      isNewRegression: true,
      runId: 9,
      scm: { commit: 'a1b2c3d4e5f6', branch: 'main', author: 'Alice Chen', commitMessage: 'add payment provider' },
      cluster: CLUSTER,
      owner: 'checkout-team',
    });
    expect(verdict).toMatchObject({
      headline: "getByRole('button', { name: 'Pay' }) never became enabled — click timed out after 30 s",
      detail: 'element is not enabled',
      kind: 'action-timeout',
      locator: "getByRole('button', { name: 'Pay' })",
      isLocatorResolutionFailure: false,
      why: 'new-regression',
      since: {
        firstFailingRunId: 4,
        firstFailingAt: '2026-08-30T10:00:00.000Z',
        isFirstFailure: false,
        commit: {
          sha: 'a1b2c3d4e5f6',
          shortSha: 'a1b2c3d',
          author: 'Alice Chen',
          message: 'add payment provider',
          branch: 'main',
        },
      },
      cluster: { id: 7, name: 'Pay button stays disabled after the quote times out', otherTestsInRun: 1 },
      owner: { name: 'checkout-team', source: 'annotation' },
    });
    expect(verdict!.parts[0]).toEqual({ kind: 'locator', text: "getByRole('button', { name: 'Pay' })" });
  });

  test('an unclustered failure without SCM metadata is a first failure in its own run', () => {
    const verdict = buildFailureVerdict({ error: PAY_ERROR, status: 'failed', runId: 9 });
    expect(verdict!.since).toEqual({
      firstFailingRunId: 9,
      firstFailingAt: null,
      isFirstFailure: true,
      commit: null,
      fixedBefore: null,
    });
    expect(verdict!.cluster).toBeNull();
    expect(verdict!.owner).toBeNull();
    expect(verdict!.why).toBeNull();
  });

  test('since.fixedBefore is set when the cluster regressed, null otherwise', () => {
    const cluster = {
      signature: 'x',
      id: 1,
      firstSeenRunId: 4,
      firstSeenAt: null,
      sameRunCaseCount: 1,
      fixCommit: 'demo001abc',
      fixLandedRunId: 3,
      fixLandedAt: null,
    };
    const regressed = buildFailureVerdict({
      error: PAY_ERROR,
      status: 'failed',
      runId: 9,
      cluster: { ...cluster, fixVerification: 'regressed' },
    });
    expect(regressed!.since.fixedBefore).toEqual({ commit: 'demo001abc', commitShort: 'demo001', runId: 3, at: null });
    const verified = buildFailureVerdict({
      error: PAY_ERROR,
      status: 'failed',
      runId: 9,
      cluster: { ...cluster, fixVerification: 'diagnosis-verified' },
    });
    expect(verified!.since.fixedBefore).toBeNull();
  });

  test('classifies why in priority order: regression, retry pass, new flaky, infrastructure', () => {
    const base = { error: PAY_ERROR, runId: 9 };
    expect(buildFailureVerdict({ ...base, status: 'passed', passedAfterFailure: true })!.why).toBe('passed-on-retry');
    expect(buildFailureVerdict({ ...base, status: 'passed', passedAfterFailure: false })?.why ?? null).not.toBe(
      'passed-on-retry',
    );
    expect(
      buildFailureVerdict({ ...base, status: 'passed', passedAfterFailure: true, isNewRegression: true })!.why,
    ).toBe('new-regression');
    expect(buildFailureVerdict({ ...base, status: 'failed', isNewFlaky: true })!.why).toBe('new-flaky');
    expect(
      buildFailureVerdict({
        ...base,
        status: 'failed',
        error: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://x/',
      })!.why,
    ).toBe('infrastructure');
    expect(buildFailureVerdict({ ...base, status: 'failed', cluster: { ...CLUSTER, errorType: 'crash' } })!.why).toBe(
      'infrastructure',
    );
  });

  test("a retry pass read from its failed attempt's error names that attempt and passed on retry", () => {
    const verdict = buildFailureVerdict({
      error: PAY_ERROR,
      status: 'passed',
      passedAfterFailure: true,
      runId: 9,
      fromAttempt: { retry: 0, executionId: 41 },
    });
    expect(verdict!.headline).toBe(
      "getByRole('button', { name: 'Pay' }) never became enabled — click timed out after 30 s",
    );
    expect(verdict!.why).toBe('passed-on-retry');
    expect(verdict!.attempt).toEqual({ retry: 0, executionId: 41 });
  });

  test("the attempt is null when the headline is the execution's own error", () => {
    expect(buildFailureVerdict({ error: PAY_ERROR, status: 'failed', runId: 9 })!.attempt).toBeNull();
    expect(
      buildFailureVerdict({ error: PAY_ERROR, status: 'failed', runId: 9, fromAttempt: null })!.attempt,
    ).toBeNull();
  });

  test('falls back to the deterministic cluster title when the cluster has no AI title', () => {
    const verdict = buildFailureVerdict({
      error: PAY_ERROR,
      status: 'failed',
      runId: 9,
      cluster: { ...CLUSTER, title: null, filePath: 'tests/checkout/checkout.spec.ts' },
    });
    expect(verdict!.cluster!.name).toBe("Timeout on getByRole('button') in checkout.spec.ts");
  });
});

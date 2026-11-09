import type { TestInfo } from '@playwright/test';
import { detectCi } from '../support/ci.js';

/**
 * Shared gate for Piwi's failure-time overlay. Both `inspectOnFailure`
 * (`PIWI_INSPECT_ON_FAIL`) and `pickLocatorOnFailure` (`PIWI_PICK_LOCATOR_ON_FAIL`)
 * open Piwi's own in-page overlay (see `pick-on-failure.ts`) — never
 * Playwright's native inspector — so the experience is fully ours and a
 * confirmed pick flows back into the dashboard.
 *
 * Local-only by design: the overlay needs a human and a visible browser, so the
 * gate requires a headed browser and refuses to run under CI regardless of the
 * flag. It also waits for the final attempt when retries are configured — an
 * attempt that is about to be retried closes without opening the overlay.
 */

/** Everything the gate reads, as plain values so it stays unit-testable. */
export interface InspectionGate {
  /** Raw `PIWI_INSPECT_ON_FAIL` env value — only the string `'true'` enables. */
  enabled: string | undefined;
  /** Whether the run is a CI job, as `detectCi` reads the environment. */
  ci: boolean;
  /** `testInfo.status` at teardown. */
  status: string | undefined;
  /** `testInfo.expectedStatus` — an expected failure (test.fail()) never pauses. */
  expectedStatus: string | undefined;
  /** `testInfo.project.use.headless` — must be explicitly `false` (headed). */
  headless: unknown;
  /** Zero-based attempt index (`testInfo.retry`). */
  retry: number;
  /** Configured retry count for the project (`testInfo.project.retries`). */
  retries: number;
}

/** Decide whether the failing page should be handed to the Inspector. */
export function shouldInspectOnFailure(gate: InspectionGate): boolean {
  if (gate.enabled !== 'true') return false;
  if (gate.ci) return false;
  if (gate.headless !== false) return false;
  if (gate.status !== 'failed' && gate.status !== 'timedOut') return false;
  if (gate.status === gate.expectedStatus) return false;
  // Another attempt is coming — inspect the final failure, not each retry.
  return gate.retry >= gate.retries;
}

/**
 * When a failure-time feature is *enabled* on a *real* failure but the gate
 * still refused for an environmental reason (headless / CI), return a
 * one-line human explanation so "nothing happened" is never a silent mystery.
 * Returns null when the feature is off, the test didn't really fail, or the
 * gate would actually pass (the feature ran, so there is nothing to explain).
 */
export function environmentalSkipReason(gate: InspectionGate): string | null {
  if (gate.enabled !== 'true') return null;
  if (gate.status !== 'failed' && gate.status !== 'timedOut') return null;
  if (gate.status === gate.expectedStatus) return null;
  if (gate.ci) return 'running under CI — this is a headed, local-only feature';
  if (gate.headless !== false) {
    return 'the browser is headless — re-run with --headed (or set use: { headless: false })';
  }
  return null;
}

/**
 * Project the live TestInfo + process env into the plain gate shape. The gate
 * conditions are shared by every failure-time affordance that needs a live
 * headed page; `enabled` selects which opt-in flag arms this one (defaults to
 * the Inspector's `PIWI_INSPECT_ON_FAIL`).
 */
export function inspectionGateFromTestInfo(
  testInfo: TestInfo,
  enabled: string | undefined = process.env.PIWI_INSPECT_ON_FAIL,
): InspectionGate {
  const use = (testInfo.project?.use ?? {}) as { headless?: unknown };
  return {
    enabled,
    ci: detectCi(process.env),
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    headless: use.headless,
    retry: testInfo.retry,
    retries: testInfo.project?.retries ?? 0,
  };
}

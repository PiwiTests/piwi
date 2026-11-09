/**
 * Hand-back outcomes read from a finished run, with no client involved.
 *
 * - **Locator heal.** A failing execution whose healing recommends a
 *   replacement records the heal as `suggested`. A later run whose snapshot at
 *   the failing call site itself carries the recommended locator's signature
 *   records it `applied` (labeled "matched the recommendation": the code that
 *   ran uses it, whoever wrote it), and the test's next passing run after that
 *   records it `verified`.
 * - **Auto-heal PR.** The first run after a merged heal PR in which every test
 *   its edits heal passes records it `verified`.
 * - **Flake verify.** The first retry-pass of a test after its Flake Lab
 *   verified fix records the fix `regressed`.
 *
 * Every run is checked against the eligibility rule (`auto-heal` for heals,
 * `flakiness` for flakes), and "later" means a higher run id than the run the
 * previous outcome was seen in. Re-finalizing a run records nothing twice.
 */
import { eq } from 'drizzle-orm';
import { locatorSnapshots, testRuns, testRunsCases } from '../database/schema';
import { extractLeafSelector } from '#shared/error-fingerprint';
import { classifyLocatorResolution } from '#shared/locator-resolution';
import { locatorSignatureFromExpression } from '#shared/locator-healing';
import { isEligibleRun } from '#shared/run-eligibility';
import { isFailedStatus } from '#shared/utils/test-counts';
import { MATCHED_RECOMMENDATION_LABEL, suggestionHash, type LocatorHealDetails } from '#shared/handback-outcomes';
import type { DrizzleDB } from '#shared/handlers/db';
import { getLocatorHealingBatch, sameFileLine } from './locator-healing';
import { listOutcomes, recordOutcome, type OutcomeRecord } from './outcomes';
import type { RunMetadata } from './run-json-types';

/** Failing executions per run whose heal is worked out and recorded. */
export const HEAL_SUGGESTIONS_PER_RUN = 50;

interface InferenceRun {
  id: number;
  projectId: number;
  startTime: Date;
  commit: string | null;
}

interface RunExecution {
  id: number;
  testCaseId: number;
  status: string;
  error: string | null;
  browserKey: string;
  /** Passed after an earlier attempt of its result failed or timed out (`passed_after_failure`). */
  passedAfterFailure: boolean;
}

/** Record every hand-back outcome a finished run shows. Best-effort per step. */
export async function inferRunOutcomes(db: DrizzleDB, runId: number): Promise<void> {
  const [row] = await db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      startTime: testRuns.startTime,
      metadata: testRuns.metadata,
      isFullRun: testRuns.isFullRun,
      status: testRuns.status,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!row) return;
  const run: InferenceRun = {
    id: row.id,
    projectId: row.projectId,
    startTime: row.startTime instanceof Date ? row.startTime : new Date(row.startTime),
    commit: (row.metadata as RunMetadata | null)?.scm?.commit ?? null,
  };

  const executions: RunExecution[] = (
    await db
      .select({
        id: testRunsCases.id,
        testCaseId: testRunsCases.testCaseId,
        status: testRunsCases.status,
        error: testRunsCases.error,
        browser: testRunsCases.browser,
        passedAfterFailure: testRunsCases.passedAfterFailure,
      })
      .from(testRunsCases)
      .where(eq(testRunsCases.testRunId, runId))
  ).map((e) => {
    const browser = e.browser as { projectName?: string; browserName?: string } | null;
    return { ...e, browserKey: browser?.projectName ?? browser?.browserName ?? '' };
  });
  if (executions.length === 0) return;

  const steps: Array<[string, () => Promise<void>]> = [];
  if (isEligibleRun(row, 'auto-heal')) {
    steps.push(['heal suggestions', () => recordHealSuggestions(db, run, executions)]);
    steps.push(['applied heals', () => recordAppliedHeals(db, run)]);
    steps.push(['verified heals', () => recordVerifiedHeals(db, run, executions)]);
    steps.push(['verified heal PRs', () => recordVerifiedHealPrs(db, run, executions)]);
  }
  if (isEligibleRun(row, 'flakiness')) {
    steps.push(['flake regressions', () => recordFlakeRegressions(db, run, executions)]);
  }
  for (const [label, step] of steps) {
    await step().catch((e) => console.error(`[outcomes] ${label} failed for run ${runId}`, e));
  }
}

/** Test cases with a passing attempt in the run (a retry-pass included). */
function passedTestCases(executions: RunExecution[]): Set<number> {
  return new Set(executions.filter((e) => e.status === 'passed').map((e) => e.testCaseId));
}

/** Keys that already reached `outcome`, per subject. */
function reachedKeys(rows: OutcomeRecord[], outcome: OutcomeRecord['outcome']): Set<string> {
  return new Set(rows.filter((r) => r.outcome === outcome).map((r) => `${r.subjectId}|${r.suggestionKey}`));
}

// ── Locator heals ─────────────────────────────────────────────────────────────

/** The suggestion key of a heal: the call site (file and line), the failing and the recommended locator. */
export function locatorHealKey(location: string, failingSig: string | null, recommendedSig: string): string {
  const fileLine = location.replace(/:\d+$/, '');
  return suggestionHash([fileLine, failingSig, recommendedSig]);
}

async function recordHealSuggestions(db: DrizzleDB, run: InferenceRun, executions: RunExecution[]): Promise<void> {
  const failing = executions
    .filter((e) => isFailedStatus(e.status) && e.error && classifyLocatorResolution(e.error).applicable)
    .slice(0, HEAL_SUGGESTIONS_PER_RUN);
  if (failing.length === 0) return;
  const healing = await getLocatorHealingBatch(
    db,
    failing.map((e) => e.id),
  );
  for (const execution of failing) {
    const result = healing.get(execution.id);
    const recommended = result?.recommendation?.recommended?.locator;
    if (!result?.applicable || !recommended || !result.location) continue;
    const recommendedSig = await locatorSignatureFromExpression(recommended);
    const failingLocator = extractLeafSelector(execution.error!);
    const failingSig = failingLocator ? await locatorSignatureFromExpression(failingLocator) : null;
    // Recommending the locator that failed proposes no change.
    if (!recommendedSig || recommendedSig === failingSig) continue;
    const details: LocatorHealDetails = {
      location: result.location,
      failingLocator,
      recommendedLocator: recommended,
      recommendedSig,
      failingRunId: run.id,
      executionId: execution.id,
    };
    await recordOutcome(db, {
      projectId: run.projectId,
      kind: 'locator-heal',
      subjectType: 'test-case',
      subjectId: execution.testCaseId,
      suggestionKey: locatorHealKey(result.location, failingSig, recommendedSig),
      outcome: 'suggested',
      runId: run.id,
      commit: run.commit,
      details: { ...details },
    });
  }
}

async function recordAppliedHeals(db: DrizzleDB, run: InferenceRun): Promise<void> {
  // The call sites this run captured, per test.
  const snaps = await db
    .select({
      testCaseId: locatorSnapshots.testCaseId,
      location: locatorSnapshots.location,
      usedArgsFp: locatorSnapshots.usedArgsFp,
    })
    .from(locatorSnapshots)
    .where(eq(locatorSnapshots.lastSeenRunId, run.id));
  if (snaps.length === 0) return;
  const testCaseIds = [...new Set(snaps.map((s) => s.testCaseId))];

  const rows = await listOutcomes(db, {
    projectId: run.projectId,
    kind: 'locator-heal',
    subjectType: 'test-case',
    subjectIds: testCaseIds,
    outcomes: ['suggested', 'applied'],
  });
  const applied = reachedKeys(rows, 'applied');
  for (const suggestion of rows) {
    if (suggestion.outcome !== 'suggested') continue;
    const id = `${suggestion.subjectId}|${suggestion.suggestionKey}`;
    if (applied.has(id)) continue;
    const details = suggestion.details as LocatorHealDetails | null;
    // Only a run after the failing one can carry the fix.
    if (!details || !(run.id > details.failingRunId)) continue;
    const matched = snaps.some(
      (s) =>
        s.testCaseId === suggestion.subjectId &&
        s.usedArgsFp === details.recommendedSig &&
        sameFileLine(s.location, details.location),
    );
    if (!matched) continue;
    const appliedDetails: LocatorHealDetails = {
      ...details,
      appliedRunId: run.id,
      label: MATCHED_RECOMMENDATION_LABEL,
    };
    await recordOutcome(db, {
      projectId: run.projectId,
      kind: 'locator-heal',
      subjectType: 'test-case',
      subjectId: suggestion.subjectId,
      suggestionKey: suggestion.suggestionKey,
      outcome: 'applied',
      runId: run.id,
      commit: run.commit,
      details: { ...appliedDetails },
    });
    applied.add(id);
  }
}

async function recordVerifiedHeals(db: DrizzleDB, run: InferenceRun, executions: RunExecution[]): Promise<void> {
  const passed = passedTestCases(executions);
  if (passed.size === 0) return;
  const rows = await listOutcomes(db, {
    projectId: run.projectId,
    kind: 'locator-heal',
    subjectType: 'test-case',
    subjectIds: [...passed],
    outcomes: ['applied', 'verified'],
  });
  const verified = reachedKeys(rows, 'verified');
  for (const applied of rows) {
    if (applied.outcome !== 'applied' || verified.has(`${applied.subjectId}|${applied.suggestionKey}`)) continue;
    const details = applied.details as LocatorHealDetails | null;
    if (!details?.appliedRunId || !(run.id > details.appliedRunId)) continue;
    await recordOutcome(db, {
      projectId: run.projectId,
      kind: 'locator-heal',
      subjectType: 'test-case',
      subjectId: applied.subjectId,
      suggestionKey: applied.suggestionKey,
      outcome: 'verified',
      runId: run.id,
      commit: run.commit,
      details: { ...details },
    });
  }
}

// ── Auto-heal pull requests ─────────────────────────────────────────────────

async function recordVerifiedHealPrs(db: DrizzleDB, run: InferenceRun, executions: RunExecution[]): Promise<void> {
  const rows = await listOutcomes(db, {
    projectId: run.projectId,
    kind: 'auto-heal-pr',
    subjectType: 'heal-action',
    outcomes: ['applied', 'verified'],
  });
  if (rows.length === 0) return;
  const passed = passedTestCases(executions);
  const verified = reachedKeys(rows, 'verified');
  for (const merged of rows) {
    if (merged.outcome !== 'applied' || verified.has(`${merged.subjectId}|${merged.suggestionKey}`)) continue;
    // A run that started before the merge was seen cannot carry it.
    if (run.startTime.getTime() <= merged.createdAt.getTime()) continue;
    const tests = (merged.details?.testCaseIds as number[] | undefined) ?? [];
    if (tests.length === 0 || !tests.every((id) => passed.has(id))) continue;
    await recordOutcome(db, {
      projectId: run.projectId,
      kind: 'auto-heal-pr',
      subjectType: 'heal-action',
      subjectId: merged.subjectId,
      suggestionKey: merged.suggestionKey,
      outcome: 'verified',
      runId: run.id,
      commit: run.commit,
      details: merged.details,
    });
  }
}

// ── Flake Lab verified fixes ────────────────────────────────────────────────

async function recordFlakeRegressions(db: DrizzleDB, run: InferenceRun, executions: RunExecution[]): Promise<void> {
  // A retry-pass: an attempt of the test in this run that passed after an earlier one failed or timed out.
  const flaked = [...new Set(executions.filter((e) => e.passedAfterFailure).map((e) => e.testCaseId))];
  if (flaked.length === 0) return;

  const rows = await listOutcomes(db, {
    projectId: run.projectId,
    kind: 'flake-verify',
    subjectType: 'test-case',
    subjectIds: flaked,
    outcomes: ['verified', 'regressed'],
  });
  const regressed = reachedKeys(rows, 'regressed');
  for (const fix of rows) {
    if (fix.outcome !== 'verified' || regressed.has(`${fix.subjectId}|${fix.suggestionKey}`)) continue;
    if (run.startTime.getTime() <= fix.createdAt.getTime()) continue;
    await recordOutcome(db, {
      projectId: run.projectId,
      kind: 'flake-verify',
      subjectType: 'test-case',
      subjectId: fix.subjectId,
      suggestionKey: fix.suggestionKey,
      outcome: 'regressed',
      runId: run.id,
      commit: run.commit,
      details: fix.details,
    });
  }
}

/**
 * Test-count folding utilities.
 *
 * Piwi has no dedicated `timedOutTests` column on `test_runs` — timed-out tests
 * are folded into `failedTests` so the run summary reconciles
 * (`total = passed + failed + skipped + didNotRun`). This matches the UI,
 * which already treats `timedOut`/`timedout` as failed (status filter, color,
 * retry command).
 *
 * Status string note: Playwright emits `'timedOut'` (camelCase) as
 * `TestResult.status`, while Piwi stores the lowercase `'timedout'`. Both
 * forms are accepted here so the folding is robust regardless of which path
 * produced the value.
 */

import { isFlakyResult } from '@piwitests/core/status-classify';
import { isFixmeSkip } from './skip-kind';

/**
 * Per-status tally keys that should be counted as "failed".
 * `timedOut` (Playwright wire value) and `timedout` (the stored spelling).
 */
export const FAILED_STATUS_KEYS = ['failed', 'timedOut', 'timedout'] as const;

/** Whether a per-case status is a failure, in either spelling of timed out. */
export function isFailedStatus(status: string | null | undefined): boolean {
  return status != null && (FAILED_STATUS_KEYS as readonly string[]).includes(status);
}

/**
 * Canonical spelling for a per-case status. The wire may carry Playwright's
 * camelCase `timedOut`; every stored value uses the lowercase form. A stored
 * row can still hold the camelCase form, so readers match both
 * (`FAILED_STATUS_KEYS`) while writers go through this.
 */
export function normalizeTestCaseStatus(status: string): string {
  return status === 'timedOut' ? 'timedout' : status;
}

/**
 * Sum the failed-ish entries from a per-status tally (e.g. the
 * `insertedStatusCounts` record built while persisting streaming events).
 * Returns 0 when the record is empty or has no failed/timed-out entries.
 */
export function countFailedFromTally(tally: Record<string, number> | undefined | null): number {
  if (!tally) return 0;
  let sum = 0;
  for (const key of FAILED_STATUS_KEYS) {
    const v = tally[key];
    if (typeof v === 'number' && v > 0) sum += v;
  }
  return sum;
}

const FAILED_STATUS_SET = new Set<string>(FAILED_STATUS_KEYS);

/** Stored run counters, one per test result (each repetition of a test counts). `failedTests` already folds timed-out in. */
export interface DistinctRunCounts {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  didNotRunTests: number;
  flakyTests: number;
}

/** The columns that tell one attempt row of a run from another. */
interface AttemptRow {
  testCaseId: number;
  browserName?: string | null;
  /** Playwright's `repeatEachIndex`: each `--repeat-each` repetition is a test result of its own, with its own retries. */
  repeatEachIndex: number | null;
  retries?: number | null;
}

/**
 * The final attempt of each repetition of a test in a run: per (test case, browser, repeat), the row with the highest
 * retry. A run stores one row per attempt; this row decides that repetition's outcome.
 */
export function finalAttempts<T extends AttemptRow>(rows: ReadonlyArray<T>): T[] {
  const final = new Map<string, T>();
  for (const r of rows) {
    const key = attemptKey(r);
    const prev = final.get(key);
    if (!prev || (r.retries ?? 0) >= (prev.retries ?? 0)) final.set(key, r);
  }
  return [...final.values()];
}

/** The (test case, browser, repeat) identity shared by all attempts of one repetition of a test in a run. */
export function attemptKey(row: Pick<AttemptRow, 'testCaseId' | 'browserName' | 'repeatEachIndex'>): string {
  return `${testKey(row)}\x00${row.repeatEachIndex ?? 0}`;
}

/** The (test case, browser) identity of a test in a run, shared by every repetition and attempt of it. */
export function testKey(row: Pick<AttemptRow, 'testCaseId' | 'browserName'>): string {
  return `${row.testCaseId}\x00${row.browserName ?? ''}`;
}

/** A final attempt as `decidesOutcome` compares it. */
interface OutcomeRow {
  status: string;
  retries?: number | null;
  repeatEachIndex: number | null;
}

/** A pass on a retry: how a final attempt reads as flaky when none of its earlier attempts is at hand. */
function passedOnRetry(row: { status: string; retries?: number | null }): boolean {
  return row.status === 'passed' && (row.retries ?? 0) > 0;
}

/** How strongly a repetition's final attempt speaks for its test: a failure first, then a flaky pass. */
function outcomeRank(row: { status: string }, flaky: boolean): number {
  if (FAILED_STATUS_SET.has(row.status)) return 3;
  if (row.status === 'passed') return flaky ? 2 : 1;
  return 0;
}

/**
 * Whether `row` rather than `current` decides a test's outcome in a run, both being final attempts of its
 * repetitions: a failed one when any failed, else a flaky one, else the later repetition. `isFlaky` tells a flaky
 * final attempt (`flakyFinalAttempts`); without it, a pass on a retry reads as flaky.
 */
export function decidesOutcome<R extends OutcomeRow>(
  row: R,
  current: R | undefined,
  isFlaky: (row: R) => boolean = passedOnRetry,
): boolean {
  if (!current) return true;
  const rank = outcomeRank(row, isFlaky(row));
  const currentRank = outcomeRank(current, isFlaky(current));
  return rank > currentRank || (rank === currentRank && (row.repeatEachIndex ?? 0) >= (current.repeatEachIndex ?? 0));
}

/**
 * The outcome of each test in a run, one row per (test case, browser): among the final attempts of its repetitions
 * (`finalAttempts`), the one `decidesOutcome` picks. A test failed in a run when one of its repetitions failed, and
 * is flaky there when none failed and one is flaky (`flakyFinalAttempts`). Without `--repeat-each` this is the test's
 * final attempt. Pass every attempt row of the run; the returned rows are the given objects.
 */
export function testOutcomes<T extends AttemptRow & { status: string }>(rows: ReadonlyArray<T>): T[] {
  const flaky = flakyFinalAttempts(rows);
  const isFlaky = (row: T) => flaky.has(row);
  const outcome = new Map<string, T>();
  for (const r of finalAttempts(rows)) {
    const key = testKey(r);
    if (decidesOutcome(r, outcome.get(key), isFlaky)) outcome.set(key, r);
  }
  return [...outcome.values()];
}

/**
 * The final attempts (`finalAttempts`) of a run's rows that are flaky: each passed after an earlier attempt of its
 * repetition failed or timed out (`isFlakyResult`). A retry that passed after attempts that passed, were skipped or
 * did not run (a `describe.serial` group retried for another test's failure) is not flaky. A final attempt none of
 * whose earlier attempts is among the rows (a payload of final attempts only) is flaky when it passed on a retry.
 * Pass every attempt row of the run; the returned rows are the given objects.
 */
export function flakyFinalAttempts<T extends AttemptRow & { status: string }>(rows: ReadonlyArray<T>): Set<T> {
  const final = new Map(finalAttempts(rows).map((row) => [attemptKey(row), row]));
  const earlier = new Map<string, string[]>();
  for (const row of rows) {
    const key = attemptKey(row);
    const last = final.get(key);
    if (!last || (row.retries ?? 0) >= (last.retries ?? 0)) continue;
    const statuses = earlier.get(key);
    if (statuses) statuses.push(row.status);
    else earlier.set(key, [row.status]);
  }
  const flaky = new Set<T>();
  for (const [key, row] of final) {
    const statuses = earlier.get(key);
    if (statuses ? isFlakyResult(row.status, statuses) : passedOnRetry(row)) flaky.add(row);
  }
  return flaky;
}

/** One attempt in an execution's own attempt history (`test_runs_cases.attempts`). */
interface AttemptHistoryEntry {
  retry?: number | null;
  status?: string | null;
}

/**
 * Whether a test result is flaky, read from its final attempt's row alone: it passed, and its attempt history
 * (`attempts`: the reporter's, or the run's stored attempts of it, `withAttemptHistory`) holds an earlier attempt
 * that failed or timed out (`isFlakyResult`). A row whose history holds no earlier attempt is flaky when it passed on
 * a retry, as `flakyFinalAttempts` reads a final attempt with no earlier row.
 */
export function isFlakyExecution(row: {
  status: string;
  retries?: number | null;
  attempts?: ReadonlyArray<AttemptHistoryEntry> | null;
}): boolean {
  const retries = row.retries ?? 0;
  const history = Array.isArray(row.attempts) ? row.attempts : [];
  const earlier = history.filter((a) => (a?.retry ?? 0) < retries).map((a) => a?.status);
  return earlier.length > 0 ? isFlakyResult(row.status, earlier) : passedOnRetry(row);
}

/** A stored attempt row, as `withAttemptHistory` reads it into a history entry. */
interface StoredAttempt extends AttemptRow {
  status: string;
  duration?: number | null;
  startedAt?: number | null;
  attempts?: unknown;
}

/**
 * A run's attempt rows, each without an attempt history (a trace import, a reporter that sent none) given one from
 * the run's stored attempts of the same test, project and repetition up to it, so `isFlakyExecution` reads it as
 * `flakyFinalAttempts` reads the rows. A row with a history, or with no earlier stored attempt, is returned as is.
 */
export function withAttemptHistory<T extends StoredAttempt>(rows: ReadonlyArray<T>): T[] {
  const byKey = new Map<string, T[]>();
  for (const row of rows) {
    const key = attemptKey(row);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  return rows.map((row) => {
    if (Array.isArray(row.attempts) && row.attempts.length > 0) return row;
    const retries = row.retries ?? 0;
    const upTo = byKey
      .get(attemptKey(row))!
      .filter((a) => (a.retries ?? 0) <= retries)
      .sort((a, b) => (a.retries ?? 0) - (b.retries ?? 0));
    if (upTo.length < 2) return row;
    const attempts = upTo.map((a) => ({
      retry: a.retries ?? 0,
      status: a.status,
      duration: a.duration ?? 0,
      startedAt: a.startedAt ?? null,
    }));
    return { ...row, attempts };
  });
}

/**
 * Reduce a run's per-attempt `test_runs_cases` rows to its counters, one per test result: the final attempt of each
 * repetition of a test (per test case, browser and `--repeat-each` repetition, the highest retry) decides that
 * result, so retry attempts never inflate the counters while each repetition counts once, as Playwright's own summary
 * counts them. Timed-out folds into `failedTests` (Piwi has no separate column), and a result that passed after an
 * earlier attempt failed counts as passed and as flaky (`flakyFinalAttempts`).
 */
export function distinctRunCountsFromAttempts(rows: ReadonlyArray<AttemptRow & { status: string }>): DistinctRunCounts {
  const final = finalAttempts(rows);
  const flaky = flakyFinalAttempts(rows);
  const counts: DistinctRunCounts = {
    totalTests: final.length,
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
    didNotRunTests: 0,
    flakyTests: 0,
  };
  for (const row of final) {
    const { status } = row;
    if (FAILED_STATUS_SET.has(status)) counts.failedTests++;
    else if (status === 'passed') {
      counts.passedTests++;
      if (flaky.has(row)) counts.flakyTests++;
    } else if (status === 'skipped') counts.skippedTests++;
    else if (status === 'didnotrun') counts.didNotRunTests++;
  }
  return counts;
}

/** A distinct-test tally of a run's cases, as the run views count them. */
export interface RunCaseSummary {
  /** Number of cases summarized — the denominator (`= passed + failed + skipped + didNotRun + running`). */
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  didNotRun: number;
  /** Passed after an earlier attempt failed (`isFlakyExecution`): a subset of `passed`, not an extra bucket. */
  flaky: number;
  /** Skipped by `test.fixme()` — a subset of `skipped`, not an extra bucket. */
  fixme: number;
  /** Still in flight (not yet settled). */
  running: number;
}

/**
 * Tally a run's cases the way the live run views count them: timed-out folds
 * into `failed`, a case that passed after an earlier attempt failed
 * (`isFlakyExecution`) counts as `passed` **and** as `flaky` (never as a
 * failure), a `test.fixme()` skip counts as `skipped` **and** as `fixme`, and
 * `running` is the in-flight remainder. Pass one entry per test, its final
 * attempt with its attempt history (de-duplicate attempts first), and the
 * buckets reconcile: `total = passed + failed + skipped + didNotRun +
 * running`. This is the single source the run header, the count bar and the
 * grouped list all count with, so they cannot disagree.
 */
export function summarizeRunCases(
  cases: ReadonlyArray<{
    status: string;
    retries?: number | null;
    attempts?: ReadonlyArray<AttemptHistoryEntry> | null;
    testAnnotations?: ReadonlyArray<{ type: string }> | null;
  }>,
): RunCaseSummary {
  const s: RunCaseSummary = {
    total: cases.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    didNotRun: 0,
    flaky: 0,
    fixme: 0,
    running: 0,
  };
  for (const tc of cases) {
    if (FAILED_STATUS_SET.has(tc.status)) s.failed++;
    else if (tc.status === 'passed') {
      s.passed++;
      if (isFlakyExecution(tc)) s.flaky++;
    } else if (tc.status === 'skipped') {
      s.skipped++;
      if (isFixmeSkip(tc)) s.fixme++;
    } else if (tc.status === 'didnotrun') s.didNotRun++;
    else if (tc.status === 'running') s.running++;
  }
  return s;
}

/**
 * Sum the `failedTests` and `timedOutTests` fields from a run submission body.
 * The reporter tracks these separately, but the server stores a single
 * `failedTests` column that includes timed-out tests.
 */
export function sumFailedAndTimedOut(
  failedTests: number | undefined | null,
  timedOutTests: number | undefined | null,
): number {
  return (
    (typeof failedTests === 'number' && failedTests > 0 ? failedTests : 0) +
    (typeof timedOutTests === 'number' && timedOutTests > 0 ? timedOutTests : 0)
  );
}

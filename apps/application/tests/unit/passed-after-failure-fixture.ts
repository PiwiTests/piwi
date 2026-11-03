import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalAttempts, isFlakyExecution, withAttemptHistory } from '#shared/utils/test-counts';

/**
 * The stored executions the `passed_after_failure` backfill migration is checked on, in both dialects
 * (`passed-after-failure-backfill.test.ts`, `passed-after-failure-backfill-pg.test.ts`).
 */

/** The SQL statements of the custom migration of `folder` whose tag ends with `_<name>`. */
function migrationSql(folder: string, name: string): string[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entry = journal.entries.find((e) => e.tag.endsWith(`_${name}`));
  if (!entry) throw new Error(`no ${name} migration in ${folder}`);
  return readFileSync(join(folder, `${entry.tag}.sql`), 'utf8').split('--> statement-breakpoint');
}

/**
 * The SQL statements of the migrations that set `passed_after_failure` on the executions stored before them, recount
 * the settled runs' flaky counts and have the daily rollups computed again.
 */
export function passedAfterFailureBackfillSql(folder: string): string[] {
  return [...migrationSql(folder, 'backfill_passed_after_failure'), ...migrationSql(folder, 'recompute_flaky_rollups')];
}

/** The app setting whose absence has the daily rollups of every stored run computed again at startup. */
export const ROLLUPS_BACKFILLED_KEY = 'analytics_rollups_backfilled_at';

/** One stored execution: `attempts` is its history as stored, `null` for none, a string for text that is not JSON. */
export interface StoredExecution {
  id: number;
  testRunId: number;
  testCaseId: number;
  browserName: string | null;
  repeatEachIndex: number;
  retries: number;
  status: string;
  attempts: Array<{ retry: number; status: string }> | string | null;
}

const history = (...statuses: string[]) => statuses.map((status, retry) => ({ retry, status }));

let nextId = 0;
/** The attempts of one result of run `testRunId`, test `testCaseId`, stored with or without their histories. */
function result(testRunId: number, testCaseId: number, statuses: string[], withHistory: boolean): StoredExecution[] {
  return statuses.map((status, retries) => ({
    id: ++nextId,
    testRunId,
    testCaseId,
    browserName: 'chromium',
    repeatEachIndex: 0,
    retries,
    status,
    attempts: withHistory ? history(...statuses.slice(0, retries + 1)) : null,
  }));
}

/** A settled run (1), a run still taking results (2), and the results of every shape the verdict reads. */
export const STORED_EXECUTIONS: StoredExecution[] = [
  ...result(1, 1, ['failed', 'passed'], true),
  ...result(1, 2, ['passed', 'passed'], true),
  ...result(1, 3, ['didnotrun', 'passed'], false),
  ...result(1, 4, ['timedout', 'passed'], false),
  ...result(1, 5, ['passed', 'passed'], false),
  ...result(1, 6, ['timedOut', 'passed'], true),
  ...result(1, 7, ['failed', 'failed'], true),
  ...result(1, 8, ['passed', 'failed', 'passed'], true),
  ...result(1, 9, ['skipped', 'passed'], true),
  // A retry stored alone: no earlier attempt at hand.
  {
    id: ++nextId,
    testRunId: 1,
    testCaseId: 10,
    browserName: 'chromium',
    repeatEachIndex: 0,
    retries: 1,
    status: 'passed',
    attempts: null,
  },
  // A history of its own attempt only, beside an earlier stored attempt that failed.
  {
    id: ++nextId,
    testRunId: 1,
    testCaseId: 11,
    browserName: null,
    repeatEachIndex: 0,
    retries: 0,
    status: 'failed',
    attempts: null,
  },
  {
    id: ++nextId,
    testRunId: 1,
    testCaseId: 11,
    browserName: null,
    repeatEachIndex: 0,
    retries: 1,
    status: 'passed',
    attempts: [{ retry: 1, status: 'passed' }],
  },
  // A history that is not JSON, beside an earlier stored attempt that passed.
  {
    id: ++nextId,
    testRunId: 1,
    testCaseId: 12,
    browserName: 'chromium',
    repeatEachIndex: 0,
    retries: 0,
    status: 'passed',
    attempts: null,
  },
  {
    id: ++nextId,
    testRunId: 1,
    testCaseId: 12,
    browserName: 'chromium',
    repeatEachIndex: 0,
    retries: 1,
    status: 'passed',
    attempts: 'not json',
  },
  // Another repetition's failure is no earlier attempt of this one.
  {
    id: ++nextId,
    testRunId: 1,
    testCaseId: 13,
    browserName: 'chromium',
    repeatEachIndex: 0,
    retries: 0,
    status: 'failed',
    attempts: null,
  },
  {
    id: ++nextId,
    testRunId: 1,
    testCaseId: 13,
    browserName: 'chromium',
    repeatEachIndex: 1,
    retries: 0,
    status: 'passed',
    attempts: null,
  },
  {
    id: ++nextId,
    testRunId: 1,
    testCaseId: 13,
    browserName: 'chromium',
    repeatEachIndex: 1,
    retries: 1,
    status: 'passed',
    attempts: null,
  },
  ...result(2, 1, ['failed', 'passed'], true),
];

/** The runs of {@link STORED_EXECUTIONS}, with a stale flaky counter, and a settled run with no stored execution (3). */
export const STORED_RUNS = [
  { id: 1, status: 'passed', flakyTests: 99 },
  { id: 2, status: 'running', flakyTests: 7 },
  { id: 3, status: 'failed', flakyTests: 5 },
];

/** Whether each of {@link STORED_EXECUTIONS} is the final attempt of its result (`finalAttempts`). */
export function finalAttemptFlags(): boolean[] {
  const finals = new Set<StoredExecution>();
  for (const runId of new Set(STORED_EXECUTIONS.map((row) => row.testRunId))) {
    for (const row of finalAttempts(STORED_EXECUTIONS.filter((r) => r.testRunId === runId))) finals.add(row);
  }
  return STORED_EXECUTIONS.map((row) => finals.has(row));
}

/** Each of {@link STORED_EXECUTIONS}' verdict as the run page reads it: `isFlakyExecution` over `withAttemptHistory`. */
export function expectedVerdicts(): boolean[] {
  const verdict = new Map<number, boolean>();
  for (const runId of new Set(STORED_EXECUTIONS.map((row) => row.testRunId))) {
    const rows = STORED_EXECUTIONS.filter((r) => r.testRunId === runId).map((row) => ({
      ...row,
      attempts: Array.isArray(row.attempts) ? row.attempts : null,
    }));
    for (const row of withAttemptHistory(rows)) verdict.set(row.id, isFlakyExecution(row));
  }
  return STORED_EXECUTIONS.map((row) => verdict.get(row.id)!);
}

/** Each run's flaky counter once the migration ran: run 1 recounted, the others as they were. */
export function expectedFlakyCounts(): number[] {
  const finals = finalAttemptFlags();
  const verdicts = expectedVerdicts();
  const run1 = STORED_EXECUTIONS.filter((row, i) => row.testRunId === 1 && finals[i] && verdicts[i]).length;
  return [run1, 7, 5];
}

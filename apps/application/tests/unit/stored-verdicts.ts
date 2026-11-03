import { isFlakyExecution, withAttemptHistory } from '#shared/utils/test-counts';

/** An execution a fixture inserts directly, as `withStoredVerdicts` reads it. */
interface FixtureExecution {
  testRunId: number;
  testCaseId: number;
  status: string;
  retries?: number | null;
  repeatEachIndex?: number | null;
  browserName?: string | null;
  attempts?: unknown;
  passedAfterFailure?: boolean;
}

/**
 * The executions a fixture inserts, each given the verdict ingest stores with it (`passedAfterFailure`, set by
 * `fillAttemptHistories`): `isFlakyExecution` over its attempt history, else over the history the given attempts of its
 * result make (`withAttemptHistory`). A row that sets its verdict keeps it. Returns the given objects.
 */
export function withStoredVerdicts<T extends FixtureExecution>(rows: T): T & { passedAfterFailure: boolean };
export function withStoredVerdicts<T extends FixtureExecution>(rows: T[]): Array<T & { passedAfterFailure: boolean }>;
export function withStoredVerdicts<T extends FixtureExecution>(given: T | T[]) {
  const rows = Array.isArray(given) ? given : [given];
  const byRun = new Map<number, T[]>();
  for (const row of rows) {
    const list = byRun.get(row.testRunId);
    if (list) list.push(row);
    else byRun.set(row.testRunId, [row]);
  }
  for (const runRows of byRun.values()) {
    const read = withAttemptHistory(
      runRows.map((row) => ({
        ...row,
        repeatEachIndex: row.repeatEachIndex ?? 0,
        attempts: Array.isArray(row.attempts) ? row.attempts : null,
      })),
    );
    runRows.forEach((row, i) => {
      row.passedAfterFailure ??= isFlakyExecution(read[i]!);
    });
  }
  return given;
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalAttempts } from '#shared/utils/test-counts';

/**
 * The stored executions the final-attempt backfill migration is checked on, in both dialects
 * (`final-attempt.test.ts`, `final-attempt-pg.test.ts`).
 */

/** The SQL of the migration that sets `final_attempt` on the executions stored before it, in `folder`. */
export function finalAttemptBackfillSql(folder: string): string {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entry = journal.entries.find((e) => e.tag.endsWith('_backfill_final_attempt'));
  if (!entry) throw new Error(`no backfill_final_attempt migration in ${folder}`);
  return readFileSync(join(folder, `${entry.tag}.sql`), 'utf8');
}

/** Executions of every shape a result's attempts take: retries, projects, repetitions, a row without a project. */
export const STORED_ATTEMPTS: Array<{
  testRunId: number;
  testCaseId: number;
  browserName: string | null;
  repeatEachIndex: number;
  retries: number;
}> = [
  { testRunId: 1, testCaseId: 1, browserName: 'chromium', repeatEachIndex: 0, retries: 0 },
  { testRunId: 1, testCaseId: 1, browserName: 'chromium', repeatEachIndex: 0, retries: 1 },
  { testRunId: 1, testCaseId: 1, browserName: 'chromium', repeatEachIndex: 0, retries: 2 },
  { testRunId: 1, testCaseId: 1, browserName: 'firefox', repeatEachIndex: 0, retries: 0 },
  { testRunId: 1, testCaseId: 1, browserName: 'chromium', repeatEachIndex: 1, retries: 0 },
  { testRunId: 1, testCaseId: 2, browserName: 'chromium', repeatEachIndex: 0, retries: 1 },
  { testRunId: 1, testCaseId: 2, browserName: 'chromium', repeatEachIndex: 0, retries: 0 },
  { testRunId: 1, testCaseId: 2, browserName: null, repeatEachIndex: 0, retries: 0 },
  { testRunId: 1, testCaseId: 2, browserName: null, repeatEachIndex: 0, retries: 0 },
  { testRunId: 2, testCaseId: 1, browserName: 'chromium', repeatEachIndex: 0, retries: 0 },
];

/** Whether each of {@link STORED_ATTEMPTS}, in order, is the final attempt of its result as `finalAttempts` reads them. */
export function expectedFinalFlags(): boolean[] {
  const rows = STORED_ATTEMPTS.map((row, i) => ({ ...row, id: i + 1 }));
  const finals = new Set<(typeof rows)[number]>();
  for (const runId of new Set(rows.map((row) => row.testRunId))) {
    for (const row of finalAttempts(rows.filter((r) => r.testRunId === runId))) finals.add(row);
  }
  return rows.map((row) => finals.has(row));
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalAttempts } from '#shared/utils/test-counts';

/**
 * The stored executions the final-attempt backfill migration is checked on, in both dialects
 * (`final-attempt.test.ts`, `final-attempt-pg.test.ts`).
 */

/** The journal tags of the migrations in `folder`, in the order they run. */
function migrationTags(folder: string): string[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  return journal.entries.map((e) => e.tag);
}

/** The SQL of the migration of `folder` whose tag ends with `suffix`, and of the migration after it. */
function migrationSql(folder: string, suffix: string): { sql: string; next: string } {
  const tags = migrationTags(folder);
  const i = tags.findIndex((tag) => tag.endsWith(suffix));
  if (i < 0) throw new Error(`no ${suffix} migration in ${folder}`);
  const read = (tag: string | undefined) => (tag ? readFileSync(join(folder, `${tag}.sql`), 'utf8') : '');
  return { sql: read(tags[i]), next: read(tags[i + 1]) };
}

/** The SQL of the migration that sets `final_attempt` on the executions stored before it, in `folder`. */
export function finalAttemptBackfillSql(folder: string): string {
  return migrationSql(folder, '_backfill_final_attempt').sql;
}

/**
 * The SQL of the migration that deletes the repeated executions without a project, in `folder`, then the statement
 * of the migration after it that builds the unique index those repeats would break.
 */
export function dedupeExecutionsSql(folder: string): { dedupe: string; uniqueIndex: string } {
  const { sql, next } = migrationSql(folder, '_dedupe_executions_without_project');
  const uniqueIndex = next.split('--> statement-breakpoint').find((s) => s.includes('CREATE UNIQUE INDEX'));
  if (!uniqueIndex) throw new Error(`no unique index after the dedupe migration in ${folder}`);
  return { dedupe: sql, uniqueIndex };
}

/** The index of the row of {@link STORED_ATTEMPTS} that repeats a later one, which the dedupe migration deletes. */
export const REPEATED_ATTEMPT = 7;

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

import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  ROLLUPS_BACKFILLED_KEY,
  STORED_EXECUTIONS,
  STORED_RUNS,
  expectedFlakyCounts,
  expectedVerdicts,
  finalAttemptFlags,
  passedAfterFailureBackfillSql,
} from './passed-after-failure-fixture';

/**
 * The migration that gives the executions stored before it their verdict (`passed_after_failure`) on PostgreSQL, and
 * recounts the flaky counter of each settled run and has the daily rollups computed again. Runs against `PIWI_POSTGRES_TEST_URL`, on temporary tables.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const MIGRATIONS = fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url));

describe.skipIf(!postgresUrl)('the passed-after-failure backfill on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');

  test('sets each stored execution’s verdict and recounts the settled runs', async () => {
    const session = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
    try {
      // Temporary tables of the same names are the ones the migration's statements reach in this session.
      await session`CREATE TEMP TABLE test_runs (
          id integer PRIMARY KEY, status text NOT NULL, flaky_tests integer NOT NULL DEFAULT 0)`;
      await session`CREATE TEMP TABLE test_runs_cases (
          id integer PRIMARY KEY, test_run_id integer NOT NULL, test_case_id integer NOT NULL,
          repeat_each_index integer NOT NULL DEFAULT 0, retries integer DEFAULT 0, browser_name text,
          status text NOT NULL, attempts jsonb, final_attempt boolean NOT NULL DEFAULT true,
          passed_after_failure boolean NOT NULL DEFAULT false)`;
      await session`CREATE TEMP TABLE app_settings (key text PRIMARY KEY, value jsonb)`;
      await session`INSERT INTO app_settings (key, value) VALUES (${ROLLUPS_BACKFILLED_KEY}, '"2026-10-01"'::jsonb)`;
      for (const run of STORED_RUNS) {
        await session`INSERT INTO test_runs (id, status, flaky_tests) VALUES (${run.id}, ${run.status}, ${run.flakyTests})`;
      }
      const finals = finalAttemptFlags();
      for (const [i, row] of STORED_EXECUTIONS.entries()) {
        // jsonb holds any JSON value: text that is not JSON is stored as a JSON string.
        const attempts = row.attempts === null ? null : JSON.stringify(row.attempts);
        await session`INSERT INTO test_runs_cases
            (id, test_run_id, test_case_id, repeat_each_index, retries, browser_name, status, attempts, final_attempt)
          VALUES (${row.id}, ${row.testRunId}, ${row.testCaseId}, ${row.repeatEachIndex}, ${row.retries},
            ${row.browserName}, ${row.status}, ${attempts}::jsonb, ${finals[i]!})`;
      }

      for (const statement of passedAfterFailureBackfillSql(MIGRATIONS)) await session.unsafe(statement);

      const rows = await session<
        Array<{ passed_after_failure: boolean }>
      >`SELECT passed_after_failure FROM test_runs_cases ORDER BY id`;
      expect(rows.map((row) => row.passed_after_failure)).toEqual(expectedVerdicts());
      const runs = await session<Array<{ flaky_tests: number }>>`SELECT flaky_tests FROM test_runs ORDER BY id`;
      expect(runs.map((run) => run.flaky_tests)).toEqual(expectedFlakyCounts());
      expect(await session`SELECT key FROM app_settings`).toHaveLength(0);
    } finally {
      await session.end();
    }
  });
});

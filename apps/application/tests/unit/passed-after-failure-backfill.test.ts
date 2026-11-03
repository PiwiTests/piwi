import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
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
 * The migration that gives the executions stored before it their verdict (`passed_after_failure`): each reads as the
 * run page reads it, from its attempt history, else from the stored attempts of its result. It then recounts the
 * flaky counter of each settled run that stores executions, and has the daily rollups, which sum those counters,
 * computed again.
 */

const MIGRATIONS = join(fileURLToPath(new URL('../..', import.meta.url)), 'server/database/migrations');

describe('the passed-after-failure backfill', () => {
  test('sets each stored execution’s verdict and recounts the settled runs', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values({ id: 1, name: 'backfill' });
    await db.insert(schema.testCases).values(
      [...new Set(STORED_EXECUTIONS.map((row) => row.testCaseId))].map((id) => ({
        id,
        projectId: 1,
        filePath: 'a.spec.ts',
        title: `t${id}`,
      })),
    );
    await db
      .insert(schema.testRuns)
      .values(STORED_RUNS.map((run) => ({ ...run, projectId: 1, startTime: new Date() })));
    const finals = finalAttemptFlags();
    await db.insert(schema.testRunsCases).values(
      STORED_EXECUTIONS.map((row, i) => ({
        ...row,
        attempts: typeof row.attempts === 'string' ? null : row.attempts,
        finalAttempt: finals[i],
        passedAfterFailure: false,
      })),
    );
    await db.insert(schema.appSettings).values({ key: ROLLUPS_BACKFILLED_KEY, value: '2026-10-01T00:00:00.000Z' });
    for (const row of STORED_EXECUTIONS.filter((r) => typeof r.attempts === 'string')) {
      await client.execute({
        sql: 'UPDATE test_runs_cases SET attempts = ? WHERE id = ?',
        args: [row.attempts, row.id],
      });
    }

    for (const statement of passedAfterFailureBackfillSql(MIGRATIONS)) await client.executeMultiple(statement);

    const rows = await db
      .select({ verdict: schema.testRunsCases.passedAfterFailure })
      .from(schema.testRunsCases)
      .orderBy(asc(schema.testRunsCases.id));
    expect(rows.map((row) => row.verdict)).toEqual(expectedVerdicts());
    const runs = await db
      .select({ flakyTests: schema.testRuns.flakyTests })
      .from(schema.testRuns)
      .orderBy(asc(schema.testRuns.id));
    expect(runs.map((run) => run.flakyTests)).toEqual(expectedFlakyCounts());
    const setting = await db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, ROLLUPS_BACKFILLED_KEY));
    expect(setting).toEqual([]);
  });
});

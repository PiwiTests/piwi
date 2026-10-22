import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { summarizeNewerExecutions, type NewerExecutionRow } from '#shared/latest-execution';

/**
 * Whether an execution is the latest of its test: the pure summary over the
 * newer executions, then the query that selects them, on an in-memory SQLite
 * database.
 */

// The schema barrel picks PostgreSQL at import time when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getNewerExecutions } = await import('#shared/handlers/test-cases');

const current = { runId: 4, browserName: 'chromium', failureClusterId: 1 };
const hour = 60 * 60 * 1000;
const T0 = Date.parse('2026-09-06T12:00:00Z');

let nextId = 100;
function row(overrides: Partial<NewerExecutionRow> & { runId: number }): NewerExecutionRow {
  return {
    id: nextId++,
    status: 'failed',
    repeatEachIndex: 0,
    retries: 0,
    browserName: 'chromium',
    failureClusterId: 1,
    startTime: new Date(T0 + overrides.runId * hour),
    ...overrides,
  };
}

describe('summarizeNewerExecutions', () => {
  test('no newer execution: the latest', () => {
    const s = summarizeNewerExecutions(current, []);
    expect(s).toMatchObject({ isLatest: true, newest: null, failedAgainCount: 0, laterInOtherProject: false });
    expect(s.projectName).toBe('chromium');
  });

  test('one later failing run', () => {
    const s = summarizeNewerExecutions(current, [row({ runId: 5 })]);
    expect(s.isLatest).toBe(false);
    expect(s.newest).toMatchObject({ runId: 5, status: 'failed', sameRun: false, sameCluster: true });
    expect(s.failedAgainRunIds).toEqual([5]);
  });

  test('a streak of failing runs, newest first, whatever order the rows come in', () => {
    const rows = [row({ runId: 5 }), row({ runId: 7 }), row({ runId: 6 })];
    expect(summarizeNewerExecutions(current, rows).failedAgainRunIds).toEqual([7, 6, 5]);
    const four = [5, 6, 7, 8].map((runId) => row({ runId }));
    expect(summarizeNewerExecutions(current, four)).toMatchObject({ failedAgainCount: 4, newest: { runId: 8 } });
  });

  test('the streak stops at the newest run that did not fail', () => {
    const rows = [row({ runId: 5 }), row({ runId: 6, status: 'passed' }), row({ runId: 7, status: 'timedout' })];
    expect(summarizeNewerExecutions(current, rows).failedAgainRunIds).toEqual([7]);
  });

  test('the newest passed: no streak', () => {
    const s = summarizeNewerExecutions(current, [row({ runId: 5 }), row({ runId: 6, status: 'passed' })]);
    expect(s.newest).toMatchObject({ runId: 6, status: 'passed', retries: 0 });
    expect(s.failedAgainRunIds).toEqual([]);
  });

  test('a flaky newest run reads through its final attempt', () => {
    const rows = [row({ runId: 6, retries: 0 }), row({ runId: 6, retries: 1, status: 'passed' })];
    const s = summarizeNewerExecutions(current, rows);
    expect(s.newest).toMatchObject({ runId: 6, status: 'passed', retries: 1 });
    expect(s.failedAgainRunIds).toEqual([]);
  });

  test('a skipped or not-run newest execution is the newest, not a failure', () => {
    for (const status of ['skipped', 'didnotrun']) {
      const s = summarizeNewerExecutions(current, [row({ runId: 6, status })]);
      expect(s.newest?.status).toBe(status);
      expect(s.failedAgainCount).toBe(0);
    }
  });

  test('a newer failure in another cluster is not the same cluster', () => {
    const s = summarizeNewerExecutions(current, [row({ runId: 6, failureClusterId: 9 })]);
    expect(s.newest).toMatchObject({ sameCluster: false });
    expect(s.failedAgainRunIds).toEqual([6]);
    expect(s.failedAgainInOtherClusterCount).toBe(1);
  });

  test('the streak counts the runs in another cluster, run by run', () => {
    // Runs 5 to 7 fail in the execution's own cluster, run 8 in cluster 9.
    const rows = [row({ runId: 5 }), row({ runId: 6 }), row({ runId: 7 }), row({ runId: 8, failureClusterId: 9 })];
    const s = summarizeNewerExecutions(current, rows);
    expect(s).toMatchObject({ failedAgainCount: 4, failedAgainInOtherClusterCount: 1, newest: { sameCluster: false } });
    const two = summarizeNewerExecutions(current, [row({ runId: 5 }), row({ runId: 6, failureClusterId: 9 })]);
    expect(two).toMatchObject({ failedAgainRunIds: [6, 5], failedAgainInOtherClusterCount: 1 });
    const allOther = [row({ runId: 5, failureClusterId: 9 }), row({ runId: 6, failureClusterId: 9 })];
    expect(summarizeNewerExecutions(current, allOther).failedAgainInOtherClusterCount).toBe(2);
  });

  test('a newer failure with no cluster, or an execution with none, is unknown, not another error', () => {
    const s = summarizeNewerExecutions(current, [row({ runId: 6, failureClusterId: null })]);
    expect(s.newest).toMatchObject({ sameCluster: null });
    expect(s.failedAgainInOtherClusterCount).toBe(0);
    const unclustered = summarizeNewerExecutions({ ...current, failureClusterId: null }, [row({ runId: 6 })]);
    expect(unclustered.newest).toMatchObject({ sameCluster: null });
    expect(unclustered.failedAgainInOtherClusterCount).toBe(0);
  });

  test("a later attempt of the execution's own run is newer, behind any later run", () => {
    const own = row({ runId: 4, retries: 1, status: 'passed' });
    expect(summarizeNewerExecutions(current, [own]).newest).toMatchObject({ sameRun: true, retries: 1 });
    const s = summarizeNewerExecutions(current, [own, row({ runId: 5 })]);
    expect(s.newest).toMatchObject({ runId: 5, sameRun: false });
    expect(s.failedAgainRunIds).toEqual([5]);
  });

  test('another project is left out but noted', () => {
    const s = summarizeNewerExecutions(current, [row({ runId: 6, browserName: 'firefox', status: 'passed' })]);
    expect(s).toMatchObject({ isLatest: true, laterInOtherProject: true, projectName: 'chromium' });
  });

  test('no project name: null matches null', () => {
    const s = summarizeNewerExecutions({ ...current, browserName: null }, [row({ runId: 6, browserName: null })]);
    expect(s).toMatchObject({ isLatest: false, laterInOtherProject: false, projectName: null });
  });

  test('a later run failed it when one of its repetitions failed, whichever ran last', () => {
    const repeated = [
      row({ runId: 6, repeatEachIndex: 2, status: 'passed' }),
      row({ runId: 6, repeatEachIndex: 1, status: 'failed' }),
      row({ runId: 6, repeatEachIndex: 0, status: 'passed' }),
    ];
    const s = summarizeNewerExecutions(current, repeated);
    expect(s.newest).toMatchObject({ runId: 6, status: 'failed', executionId: repeated[1]!.id });
    expect(s.failedAgainRunIds).toEqual([6]);
  });

  test("a repetition's retries are its own: a retry pass of one does not clear another's failure", () => {
    const repeated = [
      row({ runId: 6, repeatEachIndex: 0, retries: 1, status: 'passed' }),
      row({ runId: 6, repeatEachIndex: 0, retries: 0, status: 'failed' }),
      row({ runId: 6, repeatEachIndex: 1, retries: 0, status: 'failed' }),
    ];
    expect(summarizeNewerExecutions(current, repeated).newest).toMatchObject({ status: 'failed', retries: 0 });
    const flaky = [
      row({ runId: 7, repeatEachIndex: 0, retries: 1, status: 'passed' }),
      row({ runId: 7, repeatEachIndex: 0, retries: 0, status: 'failed' }),
      row({ runId: 7, repeatEachIndex: 1, retries: 0, status: 'passed' }),
    ];
    expect(summarizeNewerExecutions(current, flaky)).toMatchObject({
      newest: { runId: 7, status: 'passed', retries: 1 },
      failedAgainCount: 0,
    });
  });
});

describe('getNewerExecutions', () => {
  type Db = ReturnType<typeof drizzle<typeof schema>>;
  let db: Db;

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    await db.insert(schema.projects).values({ id: 1, name: 'shop' });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, title: 'pays by card', filePath: 'tests/checkout.spec.ts' },
      { id: 2, projectId: 1, title: 'pays by transfer', filePath: 'tests/checkout.spec.ts' },
    ]);
    const run = (id: number, hours: number, origin = 'ci') => ({
      id,
      projectId: 1,
      status: 'failed',
      origin,
      startTime: new Date(T0 + hours * hour),
    });
    await db
      .insert(schema.testRuns)
      .values([run(1, 0), run(2, 1), run(3, 2, 'probe'), run(4, 3), run(5, 3), ...[6, 7, 8].map((id) => run(id, id))]);
    const exec = (id: number, testRunId: number, extra: Partial<typeof schema.testRunsCases.$inferInsert> = {}) => ({
      id,
      testRunId,
      testCaseId: 1,
      status: 'failed',
      retries: 0,
      browserName: 'chromium',
      ...extra,
    });
    // Execution 19 is another repetition of the test in run 2: its retry is not a later attempt of execution 10.
    await db
      .insert(schema.testRunsCases)
      .values([
        exec(10, 2),
        exec(11, 2, { retries: 1, status: 'passed' }),
        exec(12, 1),
        exec(13, 3),
        exec(14, 4, { browserName: 'firefox' }),
        exec(15, 5),
        exec(16, 6),
        exec(17, 7, { testCaseId: 2 }),
        exec(18, 8, { status: 'passed' }),
        exec(19, 2, { repeatEachIndex: 1, retries: 1 }),
      ]);
  });

  test('later runs and later attempts of the same repetition, newest first; lab runs and older runs left out', async () => {
    const rows = await getNewerExecutions(db, {
      testCaseId: 1,
      runId: 2,
      runStartTime: new Date(T0 + hour),
      repeatEachIndex: 0,
      retries: 0,
    });
    // Run 3 is a probe, run 1 is older, execution 17 is another test, execution 19 another repetition.
    expect(rows.map((r) => r.id)).toEqual([18, 16, 15, 14, 11]);
    // Another project comes back: the summary decides what to do with it.
    expect(rows.find((r) => r.id === 14)?.browserName).toBe('firefox');
    const s = summarizeNewerExecutions({ runId: 2, browserName: 'chromium', failureClusterId: null }, rows);
    expect(s).toMatchObject({ newest: { executionId: 18, status: 'passed' }, laterInOtherProject: true });
  });

  test('a run starting at the same time counts as newer when its id is higher', async () => {
    const rows = await getNewerExecutions(db, {
      testCaseId: 1,
      runId: 4,
      runStartTime: new Date(T0 + 3 * hour),
      repeatEachIndex: 0,
      retries: 0,
    });
    expect(rows.map((r) => r.id)).toEqual([18, 16, 15]);
  });

  test('at most fifty rows', async () => {
    await db.insert(schema.testRuns).values(
      Array.from({ length: 60 }, (_, i) => ({
        id: 100 + i,
        projectId: 1,
        status: 'failed',
        origin: 'ci',
        startTime: new Date(T0 + (20 + i) * hour),
      })),
    );
    await db.insert(schema.testRunsCases).values(
      Array.from({ length: 60 }, (_, i) => ({
        id: 1000 + i,
        testRunId: 100 + i,
        testCaseId: 1,
        status: 'failed',
        retries: 0,
        browserName: 'chromium',
      })),
    );
    const rows = await getNewerExecutions(db, {
      testCaseId: 1,
      runId: 1,
      runStartTime: new Date(T0),
      repeatEachIndex: 0,
      retries: 0,
    });
    expect(rows).toHaveLength(50);
    expect(rows[0]!.id).toBe(1059);
  });
});

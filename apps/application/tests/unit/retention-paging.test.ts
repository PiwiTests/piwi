import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

/** A purge reads the executions of one slice of runs at a time, never every doomed execution at once. */

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

delete process.env.PIWI_DATABASE_URL;

const { deleteRunsByIds } = await import('../../server/utils/retention');

const DAY_MS = 24 * 60 * 60 * 1000;

let queries: Array<{ sql: string; params: unknown[] }> = [];
let db: ReturnType<typeof drizzle<typeof schema>>;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-retention-paging-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'p1' });
  await db
    .insert(schema.testCases)
    .values(Array.from({ length: 3 }, (_, i) => ({ id: i + 1, projectId: 1, filePath: 'a.spec.ts', title: `t${i}` })));
});

afterEach(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('deleteRunsByIds', () => {
  test('reads the doomed executions one slice of runs at a time', async () => {
    const ids = [1, 2, 3, 4, 5, 6];
    for (const id of ids) {
      await db
        .insert(schema.testRuns)
        .values({ id, projectId: 1, status: 'passed', startTime: new Date(Date.now() - (400 - id) * DAY_MS) });
      await db
        .insert(schema.testRunsCases)
        .values([1, 2, 3].map((testCaseId) => ({ testRunId: id, testCaseId, status: 'passed' })));
    }
    queries = [];

    const result = await deleteRunsByIds(db as unknown as DbClient, ids, { archiveRollups: true, sliceRuns: 2 });

    expect(result).toEqual({ deletedRuns: 6, deletedCases: 18 });
    const executionReads = queries.filter((q) =>
      /^select .* from "test_runs_cases" where "test_runs_cases"\."test_run_id" in/.test(q.sql),
    );
    expect(executionReads.length).toBeGreaterThan(0);
    expect(Math.max(...executionReads.map((q) => q.params.length))).toBe(2);
    expect(await db.select().from(schema.testRunsCases)).toEqual([]);
  });
});

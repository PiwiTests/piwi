import { describe, test, expect, beforeAll } from 'vitest';
import { and, asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { parseTestSearch, RUN_SEARCH_FIELDS } from '../../shared/test-search';
import { testSearchConditions } from '../../shared/utils/test-search-sql';

/**
 * The run's qualifiers in SQL, on stored executions: `worker:` reads the lane from 1 (`parallel_index` + 1) and
 * `shard:` the shard from 1, as the in-memory matcher does; `is:` reads a live state no column holds, so it matches no
 * row and its exclusion keeps every one.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

/** Each execution as `[lane, shard]`, a null for one it does not know. */
const EXECUTIONS: Array<[number | null, number | null]> = [
  [0, 1],
  [1, 1],
  [0, 2],
  [null, null],
];

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'search-sql' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'a' });
  for (const [i, [lane, shard]] of EXECUTIONS.entries()) {
    await db.insert(schema.testRunsCases).values({
      id: i + 1,
      testRunId: 1,
      testCaseId: 1,
      repeatEachIndex: i,
      status: 'passed',
      parallelIndex: lane,
      shardIndex: shard,
    });
  }
});

/** The executions a run's query finds, by their position in `EXECUTIONS`. */
async function found(query: string): Promise<number[]> {
  const conditions = testSearchConditions(parseTestSearch(query, RUN_SEARCH_FIELDS), {
    worker: schema.testRunsCases.parallelIndex,
    shard: schema.testRunsCases.shardIndex,
  });
  const rows = await db
    .select({ id: schema.testRunsCases.id })
    .from(schema.testRunsCases)
    .where(and(...conditions))
    .orderBy(asc(schema.testRunsCases.id));
  return rows.map((row) => row.id - 1);
}

describe('the run qualifiers in SQL', () => {
  test('worker reads the lane from 1, and shard the shard', async () => {
    expect(await found('worker:1')).toEqual([0, 2]);
    expect(await found('worker:02')).toEqual([1]);
    expect(await found('worker:0')).toEqual([]);
    expect(await found('shard:2')).toEqual([2]);
    expect(await found('worker:1 shard:1')).toEqual([0]);
  });

  test('a repeated worker or shard widens, and an exclusion keeps the executions with none', async () => {
    expect(await found('shard:1 shard:2')).toEqual([0, 1, 2]);
    expect(await found('-worker:1')).toEqual([1, 3]);
    expect(await found('-shard:1')).toEqual([2, 3]);
  });

  test('a value that names no number matches nothing, and excludes nothing', async () => {
    expect(await found('worker:two')).toEqual([]);
    expect(await found('-worker:two')).toEqual([0, 1, 2, 3]);
  });

  test('is:stuck matches no stored execution, and -is:stuck keeps them all', async () => {
    expect(await found('is:stuck')).toEqual([]);
    expect(await found('-is:stuck')).toEqual([0, 1, 2, 3]);
  });
});

import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy';
import { createClient, type InValue } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getTestCase } = await import('../../shared/handlers/test-cases');
const { getProjectTestCases } = await import('../../shared/handlers/projects');
const { getAriaSampling } = await import('../../shared/handlers/aria-sampling');

const client = createClient({ url: ':memory:' });
const sqliteDb = drizzle(client, { schema });

/**
 * postgres.js parses int4 and float columns but returns int8 (COUNT, SUM) and
 * numeric (AVG, a division by 1.0) as strings, and drizzle leaves timestamps
 * unparsed. This database answers from the same SQLite data the way postgres.js
 * would for those expressions.
 */
const TEXT_AGGREGATE = /^\(?\s*(select\s+)?(count|sum|avg|case)\b/i;
const TIMESTAMP_AGGREGATE = /^max\(.*"created_at"\)$/i;
/** Every statement the PostgreSQL-style database ran. */
const pgQueries: string[] = [];
const pgLikeDb = drizzleProxy(
  async (query, params, method) => {
    pgQueries.push(query);
    const result = await client.execute({ sql: query, args: params as InValue[] });
    const rows = result.rows.map((row) =>
      result.columns.map((column, i) => {
        const value = row[i];
        if (typeof value !== 'number') return value;
        if (TIMESTAMP_AGGREGATE.test(column)) return new Date(value).toISOString();
        return TEXT_AGGREGATE.test(column) ? String(value) : value;
      }),
    );
    return { rows: method === 'get' ? rows[0] : rows };
  },
  { schema },
);

/** The word that follows each `FROM ( … )` derived table: its alias, or the next keyword. */
function derivedTableAliases(query: string): string[] {
  const aliases: string[] = [];
  for (const match of query.matchAll(/\bFROM\s*\(/gi)) {
    let end = match.index + match[0].length - 1;
    for (let depth = 0; end < query.length; end++) {
      if (query[end] === '(') depth++;
      else if (query[end] === ')' && --depth === 0) break;
    }
    aliases.push(/^\s*(?:AS\s+)?(\w*)/i.exec(query.slice(end + 1))![1]!);
  }
  return aliases;
}

const MINUTE = 60_000;
const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MINUTE);

/**
 * Project 1: twelve executions of one test, five passed, two skipped, five
 * failed, the newest one minute ago. Project 2: a green ARIA sample two days
 * old, one an hour old, and a test with none.
 */
beforeAll(async () => {
  await migrateToLatest(sqliteDb);
  await sqliteDb.insert(schema.projects).values({ id: 1, name: 'shop' });
  await sqliteDb.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds' });
  const statuses = [...Array(5).fill('passed'), ...Array(2).fill('skipped'), ...Array(5).fill('failed')];
  for (const [index, status] of statuses.entries()) {
    const id = index + 1;
    const minutesAgo = statuses.length - index;
    await sqliteDb.insert(schema.testRuns).values({ id, projectId: 1, status, startTime: at(minutesAgo) });
    await sqliteDb.insert(schema.testRunsCases).values({
      id,
      testRunId: id,
      testCaseId: 1,
      status,
      duration: 1000 * id,
      createdAt: at(minutesAgo),
    });
  }

  await sqliteDb.insert(schema.projects).values({ id: 2, name: 'docs' });
  await sqliteDb.insert(schema.testCases).values([
    { id: 2, projectId: 2, filePath: 'docs.spec.ts', title: 'stale' },
    { id: 3, projectId: 2, filePath: 'docs.spec.ts', title: 'fresh' },
    { id: 4, projectId: 2, filePath: 'docs.spec.ts', title: 'never' },
  ]);
  for (const [testCaseId, minutesAgo] of [
    [2, 2 * 24 * 60],
    [3, 60],
  ] as const) {
    const id = 100 + testCaseId;
    await sqliteDb.insert(schema.testRuns).values({ id, projectId: 2, status: 'passed', startTime: at(minutesAgo) });
    await sqliteDb.insert(schema.testRunsCases).values({
      id,
      testRunId: id,
      testCaseId,
      status: 'passed',
      ariaSnapshot: '- heading "Docs"',
      createdAt: at(minutesAgo),
    });
  }
});

describe.each([
  ['SQLite', () => sqliteDb],
  ['PostgreSQL-style results', () => pgLikeDb],
])('aggregates read as numbers and dates on %s', (_name, database) => {
  test('the test page header and its pass rate', async () => {
    const testCase = await getTestCase(database() as never, 1);
    expect(testCase).toMatchObject({
      totalRuns: 12,
      passedRuns: 5,
      failedRuns: 5,
      skippedRuns: 2,
      flakyRuns: 0,
      recentFlakyRuns: 0,
      avgDuration: 6500,
      passRate: 58,
    });
    expect(testCase!.lastRunAt).toEqual(at(1));
  });

  test('the test-cases list', async () => {
    const { items } = await getProjectTestCases(database() as never, 1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      totalRuns: 12,
      passedRuns: 5,
      failedRuns: 5,
      skippedRuns: 2,
      fixmeRuns: 0,
      didNotRunRuns: 0,
      flakyRuns: 0,
      recentFlakyRuns: 0,
      passRate: 0.5,
      avgDuration: 6500,
      lastRun: at(1).getTime(),
    });
  });

  test('the green ARIA samples a test is due', async () => {
    const { tests } = await getAriaSampling(database() as never, 2, NOW);
    expect(tests.map((t) => t.title).sort()).toEqual(['never', 'stale']);
  });
});

describe('test case SQL', () => {
  // PostgreSQL before 16 rejects a subquery in FROM without an alias.
  test('names every derived table', async () => {
    pgQueries.length = 0;
    await getTestCase(pgLikeDb as never, 1);
    expect(pgQueries.flatMap(derivedTableAliases)).toEqual(['recent']);
  });
});

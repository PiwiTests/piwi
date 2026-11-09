import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { matchInsertedRunCases } from '../../server/utils/inserted-run-cases';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set;
// clear it before the modules that import the barrel load.
delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;

// Each test builds a fresh database that reuses project id 1, so the
// process-level id caches must not carry ids over from the previous one.
beforeEach(() => {
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
});

async function freshRun(): Promise<{ db: Db; runId: number }> {
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'links-project' });
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId: 1, status: 'passed', startTime: new Date('2026-09-30T10:00:00Z') })
    .returning({ id: schema.testRuns.id });
  return { db, runId: run!.id };
}

function execution(title: string, requestPath: string, browser: string | null = 'chromium') {
  return {
    title,
    filePath: 'tests/checkout.spec.ts',
    status: 'passed',
    line: null,
    column: null,
    browser,
    networkRequests: [{ method: 'GET', url: `https://app.test${requestPath}`, status: 200 }],
  };
}

describe('matchInsertedRunCases', () => {
  test('matches returned rows by key, whatever order they come back in', () => {
    const rows = [
      { testCaseId: 1, retries: 0, browserName: 'chromium' },
      { testCaseId: 2, retries: 0, browserName: 'chromium' },
    ];
    const inserted = [
      { id: 20, testCaseId: 2, retries: 0, browserName: 'chromium' },
      { id: 10, testCaseId: 1, retries: 0, browserName: 'chromium' },
    ];
    expect(matchInsertedRunCases(rows, inserted).map((r) => [r.id, r.rowIndex])).toEqual([
      [20, 1],
      [10, 0],
    ]);
  });

  test('a repeated key is matched to its first row, and rows without a browser each in turn', () => {
    const rows = [
      { testCaseId: 1, retries: 0, browserName: 'chromium' },
      { testCaseId: 1, retries: 0, browserName: 'chromium' },
      { testCaseId: 3, retries: 0, browserName: null },
      { testCaseId: 3, retries: 0, browserName: null },
    ];
    const inserted = [
      { id: 10, testCaseId: 1, retries: 0, browserName: 'chromium' },
      { id: 30, testCaseId: 3, retries: 0, browserName: null },
      { id: 31, testCaseId: 3, retries: 0, browserName: null },
    ];
    expect(matchInsertedRunCases(rows, inserted).map((r) => [r.id, r.rowIndex])).toEqual([
      [10, 0],
      [30, 2],
      [31, 3],
    ]);
  });
});

describe('persistRunCases with a skipped duplicate', () => {
  test('each inserted execution carries the index of the case it came from', async () => {
    const { db, runId } = await freshRun();

    const inserted = await persistRunCases(db, 1, runId, [
      execution('adds to cart', '/cart'),
      execution('adds to cart', '/cart-again'),
      execution('pays', '/pay'),
    ]);

    const cases = await db.select().from(schema.testCases);
    const caseIdOf = (title: string) => cases.find((c) => c.title === title)!.id;
    expect(inserted).toHaveLength(2);
    expect(inserted.map((r) => [r.inputIndex, r.testCaseId])).toEqual([
      [0, caseIdOf('adds to cart')],
      [2, caseIdOf('pays')],
    ]);
  });

  test('network requests land on the execution of the case that captured them', async () => {
    const { db, runId } = await freshRun();

    const inserted = await persistRunCases(db, 1, runId, [
      execution('adds to cart', '/cart'),
      execution('adds to cart', '/cart-again'),
      execution('pays', '/pay'),
    ]);

    const requests = await db.select().from(schema.networkRequests);
    const urlsOf = (inputIndex: number) =>
      requests
        .filter((r) => r.testRunsCaseId === inserted.find((i) => i.inputIndex === inputIndex)!.id)
        .map((r) => r.url);
    expect(urlsOf(0)).toEqual(['https://app.test/cart']);
    expect(urlsOf(2)).toEqual(['https://app.test/pay']);
    expect(requests).toHaveLength(2);
  });
});

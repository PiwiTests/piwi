import { describe, expect, test } from 'vitest';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the caches (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

/** A database whose project query fails the first time, like a busy SQLite or a dropped PostgreSQL connection. */
function failingOnceDb(rows: Record<string, unknown>[]) {
  let queries = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: async () => {
          queries++;
          if (queries === 1) throw new Error('SQLITE_BUSY: database is locked');
          return rows;
        },
      }),
    }),
  };
  return { db: db as never, queries: () => queries };
}

describe('testCaseCache', () => {
  test('loads again after a failed load instead of repeating its error', async () => {
    const { db, queries } = failingOnceDb([{ id: 7, filePath: 'a.spec.ts', suitePath: '', title: 'works' }]);

    await expect(testCaseCache.getProjectCache(db, 101)).rejects.toThrow('SQLITE_BUSY');
    const cache = await testCaseCache.getProjectCache(db, 101);

    expect(cache.byKey.get('a.spec.ts\x00\x00works')).toBe(7);
    expect(queries()).toBe(2);
  });

  test('callers sharing a failed load all see the failure, and the next one retries', async () => {
    const { db, queries } = failingOnceDb([]);

    const first = testCaseCache.getProjectCache(db, 102);
    const second = testCaseCache.getProjectCache(db, 102);
    await expect(first).rejects.toThrow('SQLITE_BUSY');
    await expect(second).rejects.toThrow('SQLITE_BUSY');
    expect(queries()).toBe(1);

    await expect(testCaseCache.getProjectCache(db, 102)).resolves.toMatchObject({ byKey: expect.any(Map) });
    expect(queries()).toBe(2);
  });
});

describe('testSuiteCache', () => {
  test('loads again after a failed load instead of repeating its error', async () => {
    const { db, queries } = failingOnceDb([{ id: 3, filePath: 'a.spec.ts', suitePath: 'Checkout' }]);

    await expect(testSuiteCache.getProjectCache(db, 101)).rejects.toThrow('SQLITE_BUSY');
    const cache = await testSuiteCache.getProjectCache(db, 101);

    expect(cache.get('a.spec.ts\x00Checkout')).toBe(3);
    expect(queries()).toBe(2);
  });
});

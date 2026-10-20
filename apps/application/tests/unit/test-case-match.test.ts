import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set;
// clear it before the modules that import the barrel load.
delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');
const { buildTestCaseIndex } = await import('../../server/utils/test-case-match');

type Db = ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
});

async function freshDb(): Promise<Db> {
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values({ id: 1, name: 'ids-project' });
  return db;
}

async function newRun(db: Db): Promise<number> {
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId: 1, status: 'passed', startTime: new Date('2026-10-20T10:00:00Z') })
    .returning({ id: schema.testRuns.id });
  return run!.id;
}

interface CaseOptions {
  filePath?: string;
  suitePath?: string[];
  externalId?: string | null;
  displayTitle?: string | null;
  testAnnotations?: Array<{ type: string; description?: string }>;
  browser?: string;
}

function execution(title: string, options: CaseOptions = {}) {
  return {
    title,
    filePath: options.filePath ?? 'tests/login.spec.ts',
    suitePath: options.suitePath ?? null,
    status: 'passed',
    line: 3,
    column: 1,
    browser: options.browser ?? 'chromium',
    ...('externalId' in options ? { externalId: options.externalId } : {}),
    ...(options.displayTitle !== undefined ? { displayTitle: options.displayTitle } : {}),
    testAnnotations: options.testAnnotations ?? null,
  };
}

async function testCaseRows(db: Db) {
  return db
    .select({
      id: schema.testCases.id,
      filePath: schema.testCases.filePath,
      suitePath: schema.testCases.suitePath,
      title: schema.testCases.title,
      externalId: schema.testCases.externalId,
      displayTitle: schema.testCases.displayTitle,
    })
    .from(schema.testCases)
    .orderBy(schema.testCases.id);
}

async function runMetadata(db: Db, runId: number) {
  const [run] = await db
    .select({ metadata: schema.testRuns.metadata })
    .from(schema.testRuns)
    .where(eq(schema.testRuns.id, runId));
  return (run?.metadata ?? {}) as Record<string, unknown>;
}

describe('matching on external IDs', () => {
  test('a renamed test keeps its test case, which takes the new title', async () => {
    const db = await freshDb();
    const first = await persistRunCases(db, 1, await newRun(db), [
      execution('12526, Log in with Email', { externalId: '12526' }),
    ]);
    const second = await persistRunCases(db, 1, await newRun(db), [
      execution('12526, Log in', { externalId: '12526' }),
    ]);

    expect(second[0]!.testCaseId).toBe(first[0]!.testCaseId);
    expect(await testCaseRows(db)).toMatchObject([{ title: '12526, Log in', externalId: '12526' }]);
  });

  test('a test moved to another file and describe block keeps its test case', async () => {
    const db = await freshDb();
    const first = await persistRunCases(db, 1, await newRun(db), [execution('Log in', { externalId: 'TC-1' })]);
    const second = await persistRunCases(db, 1, await newRun(db), [
      execution('Log in', { externalId: 'TC-1', filePath: 'tests/auth.spec.ts', suitePath: ['Auth'] }),
    ]);

    expect(second[0]!.testCaseId).toBe(first[0]!.testCaseId);
    const [row] = await testCaseRows(db);
    expect(row).toMatchObject({ filePath: 'tests/auth.spec.ts', suitePath: 'Auth' });
  });

  test('an existing test case takes the ID on the first run that declares it', async () => {
    const db = await freshDb();
    const first = await persistRunCases(db, 1, await newRun(db), [execution('12526, Log in')]);
    const second = await persistRunCases(db, 1, await newRun(db), [
      execution('12526, Log in', { externalId: '12526', displayTitle: 'Log in' }),
    ]);
    const third = await persistRunCases(db, 1, await newRun(db), [
      execution('12526, Log in again', { externalId: '12526', displayTitle: 'Log in again' }),
    ]);

    expect(second[0]!.testCaseId).toBe(first[0]!.testCaseId);
    expect(third[0]!.testCaseId).toBe(first[0]!.testCaseId);
    expect(await testCaseRows(db)).toMatchObject([
      { title: '12526, Log in again', externalId: '12526', displayTitle: 'Log in again' },
    ]);
  });

  test('a test case holding an ID is another test for a different ID, whatever its title', async () => {
    const db = await freshDb();
    const first = await persistRunCases(db, 1, await newRun(db), [execution('Log in', { externalId: 'OLD-1' })]);
    const second = await persistRunCases(db, 1, await newRun(db), [execution('Log in', { externalId: 'NEW-1' })]);

    expect(second[0]!.testCaseId).not.toBe(first[0]!.testCaseId);
    expect((await testCaseRows(db)).map((r) => r.externalId)).toEqual(['OLD-1', 'NEW-1']);
  });

  test('a renamed test keeps its history when a new test takes its old title, whatever the order', async () => {
    const db = await freshDb();
    const [login] = await persistRunCases(db, 1, await newRun(db), [execution('login', { externalId: 'X' })]);
    const stored = await persistRunCases(db, 1, await newRun(db), [
      execution('login', { externalId: 'Y' }),
      execution('login with email', { externalId: 'X' }),
    ]);

    expect(stored.find((r) => r.inputIndex === 1)!.testCaseId).toBe(login!.testCaseId);
    expect(stored.find((r) => r.inputIndex === 0)!.testCaseId).not.toBe(login!.testCaseId);
  });

  test('a new test without an ID at the old title of a renamed test gets its own test case', async () => {
    const db = await freshDb();
    const runId = await newRun(db);
    const [login] = await persistRunCases(db, 1, runId, [execution('login', { externalId: 'X' })]);
    const stored = await persistRunCases(db, 1, await newRun(db), [
      execution('login'),
      execution('login v2', { externalId: 'X' }),
    ]);

    expect(stored.find((r) => r.inputIndex === 1)!.testCaseId).toBe(login!.testCaseId);
    expect(stored.find((r) => r.inputIndex === 0)!.testCaseId).not.toBe(login!.testCaseId);
    expect(await testCaseRows(db)).toMatchObject([{ title: 'login v2', externalId: 'X' }, { title: 'login' }]);
  });

  test('an import of an older run matches by ID without renaming or giving out IDs', async () => {
    const db = await freshDb();
    const [current] = await persistRunCases(db, 1, await newRun(db), [
      execution('login with email', { externalId: 'X' }),
    ]);
    await persistRunCases(db, 1, await newRun(db), [execution('sign up')]);
    const imported = await persistRunCases(
      db,
      1,
      await newRun(db),
      [execution('login', { externalId: 'X' }), execution('sign up', { externalId: 'Z' })],
      { keepTestState: true },
    );

    expect(imported[0]!.testCaseId).toBe(current!.testCaseId);
    expect((await testCaseRows(db)).map((r) => [r.title, r.externalId])).toEqual([
      ['login with email', 'X'],
      ['sign up', null],
    ]);
  });

  test('reads piwi:id when the payload carries no externalId field, and trusts an explicit null', async () => {
    const db = await freshDb();
    await persistRunCases(db, 1, await newRun(db), [
      execution('A', { testAnnotations: [{ type: 'piwi:id', description: '7' }] }),
      execution('B', { externalId: null, testAnnotations: [{ type: 'piwi:id', description: '8' }] }),
    ]);

    expect((await testCaseRows(db)).map((r) => r.externalId)).toEqual(['7', null]);
  });

  test('two tests with one ID in a batch: the second is matched without it and the run records both', async () => {
    const db = await freshDb();
    const runId = await newRun(db);
    const stored = await persistRunCases(db, 1, runId, [
      execution('Log in', { externalId: '5' }),
      execution('Log out', { externalId: '5', filePath: 'tests/logout.spec.ts' }),
    ]);

    expect(stored[0]!.testCaseId).not.toBe(stored[1]!.testCaseId);
    expect((await testCaseRows(db)).map((r) => [r.title, r.externalId])).toEqual([
      ['Log in', '5'],
      ['Log out', null],
    ]);
    expect((await runMetadata(db, runId)).externalIdDuplicates).toEqual([
      {
        externalId: '5',
        tests: [
          { filePath: 'tests/login.spec.ts', title: 'Log in' },
          { filePath: 'tests/logout.spec.ts', title: 'Log out', line: 3 },
        ],
      },
    ]);
  });

  test('a duplicate across two batches of one run does not move the test case', async () => {
    const db = await freshDb();
    const runId = await newRun(db);
    const [a] = await persistRunCases(db, 1, runId, [execution('Log in', { externalId: '5' })]);
    testCaseCache.invalidate(1); // as after a restart: the run is read from the database
    const [b] = await persistRunCases(db, 1, runId, [execution('Log out', { externalId: '5' })]);

    expect(b!.testCaseId).not.toBe(a!.testCaseId);
    expect(await testCaseRows(db)).toMatchObject([{ title: 'Log in', externalId: '5' }, { title: 'Log out' }]);
    expect((await runMetadata(db, runId)).externalIdDuplicates).toHaveLength(1);
  });

  test('the same test in two browsers is not a duplicate', async () => {
    const db = await freshDb();
    const runId = await newRun(db);
    const stored = await persistRunCases(db, 1, runId, [
      execution('Log in', { externalId: '5', browser: 'chromium' }),
      execution('Log in', { externalId: '5', browser: 'firefox' }),
    ]);

    expect(stored[0]!.testCaseId).toBe(stored[1]!.testCaseId);
    expect((await runMetadata(db, runId)).externalIdDuplicates).toBeUndefined();
  });

  test('without an ID, matching is unchanged', async () => {
    const db = await freshDb();
    const first = await persistRunCases(db, 1, await newRun(db), [execution('Log in')]);
    const second = await persistRunCases(db, 1, await newRun(db), [execution('Log in, renamed')]);

    expect(second[0]!.testCaseId).not.toBe(first[0]!.testCaseId);
  });

  test('the display title follows the reporter option without the title changing', async () => {
    const db = await freshDb();
    await persistRunCases(db, 1, await newRun(db), [
      execution('12526, Log in', { externalId: '12526', displayTitle: 'Log in' }),
    ]);
    expect(await testCaseRows(db)).toMatchObject([{ displayTitle: 'Log in' }]);

    await persistRunCases(db, 1, await newRun(db), [execution('12526, Log in', { externalId: '12526' })]);
    expect(await testCaseRows(db)).toMatchObject([{ displayTitle: null }]);
  });

  test('two batches at once with the same new test create one test case', async () => {
    const db = await freshDb();
    const runId = await newRun(db);
    const [a, b] = await Promise.all([
      persistRunCases(db, 1, runId, [execution('New test', { browser: 'chromium' })]),
      persistRunCases(db, 1, runId, [execution('New test', { browser: 'firefox' })]),
    ]);

    expect(a[0]!.testCaseId).toBe(b[0]!.testCaseId);
    expect(await testCaseRows(db)).toHaveLength(1);
  });
});

describe('buildTestCaseIndex', () => {
  test('of two rows with one natural key, the one holding an external ID wins', () => {
    const index = buildTestCaseIndex([
      { id: 1, filePath: 'a.spec.ts', suitePath: '', title: 'T', externalId: 'X' },
      { id: 2, filePath: 'a.spec.ts', suitePath: '', title: 'T', externalId: null },
    ]);
    expect(index.byKey.get('a.spec.ts\x00\x00T')).toBe(1);
    expect(index.byExternalId.get('X')).toEqual({ id: 1, key: 'a.spec.ts\x00\x00T' });
  });
});

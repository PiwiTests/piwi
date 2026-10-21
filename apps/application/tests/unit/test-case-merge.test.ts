import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');
const { mergeTestCases } = await import('../../shared/handlers/test-case-merge');

type Db = ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
});

async function freshDb(): Promise<Db> {
  // A file, not `:memory:`: libsql runs a transaction on a connection of its own, which would see an empty
  // in-memory database.
  const file = join(mkdtempSync(join(tmpdir(), 'piwi-merge-')), 'piwi.db');
  const db = drizzle(createClient({ url: `file:${file}` }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values([
    { id: 1, name: 'merge-project' },
    { id: 2, name: 'other-project' },
  ]);
  return db;
}

async function newRun(db: Db, projectId = 1): Promise<number> {
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'passed', startTime: new Date('2026-10-20T10:00:00Z') })
    .returning({ id: schema.testRuns.id });
  return run!.id;
}

function execution(title: string, externalId?: string) {
  return {
    title,
    filePath: 'tests/login.spec.ts',
    status: 'passed',
    line: 3,
    column: 1,
    browser: 'chromium',
    ...(externalId ? { externalId } : {}),
  };
}

/** A test renamed before it had an ID: two test cases, each with one execution. */
async function renamedTest(db: Db) {
  const [old] = await persistRunCases(db, 1, await newRun(db), [execution('login')]);
  const [renamed] = await persistRunCases(db, 1, await newRun(db), [execution('log in', 'TC-1')]);
  return { sourceId: old!.testCaseId, targetId: renamed!.testCaseId };
}

describe('mergeTestCases', () => {
  test('moves the source history to the target and deletes the source', async () => {
    const db = await freshDb();
    const { sourceId, targetId } = await renamedTest(db);

    const result = await mergeTestCases(db as never, targetId, sourceId);

    expect(result).toMatchObject({ ok: true, executionsMoved: 1 });
    const executions = await db.select({ testCaseId: schema.testRunsCases.testCaseId }).from(schema.testRunsCases);
    expect(executions.map((e) => e.testCaseId)).toEqual([targetId, targetId]);
    const cases = await db.select().from(schema.testCases);
    expect(cases.map((c) => [c.id, c.title, c.externalId])).toEqual([[targetId, 'log in', 'TC-1']]);
  });

  test('keeps the target row of two recording the same fact, and one active quarantine', async () => {
    const db = await freshDb();
    const { sourceId, targetId } = await renamedTest(db);
    await db.insert(schema.locatorSnapshots).values([
      {
        testCaseId: sourceId,
        location: 'a.ts:1',
        usedMethod: 'getByRole',
        usedArgs: '[]',
        usedArgsFp: 'fp',
        elementAttrs: '{}',
        alternatives: '[]',
        lastSeenAt: new Date(),
        elementTag: 'source',
      },
      {
        testCaseId: targetId,
        location: 'a.ts:1',
        usedMethod: 'getByRole',
        usedArgs: '[]',
        usedArgsFp: 'fp',
        elementAttrs: '{}',
        alternatives: '[]',
        lastSeenAt: new Date(),
        elementTag: 'target',
      },
      {
        testCaseId: sourceId,
        location: 'a.ts:9',
        usedMethod: 'getByRole',
        usedArgs: '[]',
        usedArgsFp: 'fp',
        elementAttrs: '{}',
        alternatives: '[]',
        lastSeenAt: new Date(),
        elementTag: 'source-only',
      },
    ] as never);
    await db.insert(schema.quarantinedTests).values([
      { projectId: 1, testCaseId: sourceId },
      { projectId: 1, testCaseId: targetId },
    ]);

    await mergeTestCases(db as never, targetId, sourceId);

    const snapshots = await db
      .select({ testCaseId: schema.locatorSnapshots.testCaseId, tag: schema.locatorSnapshots.elementTag })
      .from(schema.locatorSnapshots);
    expect(snapshots.map((s) => s.tag).sort()).toEqual(['source-only', 'target']);
    expect(new Set(snapshots.map((s) => s.testCaseId))).toEqual(new Set([targetId]));
    expect(await db.select().from(schema.quarantinedTests)).toHaveLength(1);
  });

  test('gives the target the source ID when it holds none', async () => {
    const db = await freshDb();
    const [withId] = await persistRunCases(db, 1, await newRun(db), [execution('login', 'TC-9')]);
    const [withoutId] = await persistRunCases(db, 1, await newRun(db), [execution('log in')]);

    await mergeTestCases(db as never, withoutId!.testCaseId, withId!.testCaseId);

    const [kept] = await db.select().from(schema.testCases).where(eq(schema.testCases.id, withoutId!.testCaseId));
    expect(kept?.externalId).toBe('TC-9');
  });

  test('refuses two tests that ran in the same run, another project, itself and an unknown one', async () => {
    const db = await freshDb();
    const together = await persistRunCases(db, 1, await newRun(db), [execution('a'), execution('b')]);
    const [elsewhere] = await persistRunCases(db, 2, await newRun(db, 2), [execution('c')]);
    const [a, b] = together.map((r) => r.testCaseId);

    expect(await mergeTestCases(db as never, a!, b!)).toMatchObject({ ok: false, error: 'ran-together' });
    expect(await mergeTestCases(db as never, a!, elsewhere!.testCaseId)).toMatchObject({
      ok: false,
      error: 'other-project',
    });
    expect(await mergeTestCases(db as never, a!, a!)).toMatchObject({ ok: false, error: 'same-case' });
    expect(await mergeTestCases(db as never, a!, 999)).toMatchObject({ ok: false, error: 'not-found' });
    expect(await db.select().from(schema.testCases)).toHaveLength(3);
  });
});

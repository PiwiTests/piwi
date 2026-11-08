import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { getProject, updateProject, InvalidTagKeysError } = await import('../../shared/handlers/projects');
const { lastCompleteRunTagOverlap } = await import('../../shared/handlers/tag-key-overlap');

const ISSUE = '^[A-Z][A-Z0-9]+-[0-9]+$';
const TEST_CASE = '^SHOP-T[0-9]+$';

describe('a project stores its tag key patterns', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  });

  test('a new project has both patterns off', async () => {
    expect((await getProject(db as never, 1))?.tagKeys).toBeNull();
  });

  test('the patterns read back as saved', async () => {
    await updateProject(db as never, 1, { tagKeys: { issue: ISSUE, testCase: TEST_CASE } });
    expect((await getProject(db as never, 1))?.tagKeys).toEqual({ issue: ISSUE, testCase: TEST_CASE });
  });

  test('one pattern can be on while the other is off', async () => {
    await updateProject(db as never, 1, { tagKeys: { testCase: TEST_CASE } });
    expect((await getProject(db as never, 1))?.tagKeys).toEqual({ issue: null, testCase: TEST_CASE });
  });

  test('a pattern that is not valid is refused and the stored patterns stay', async () => {
    await expect(updateProject(db as never, 1, { tagKeys: { issue: '([' } })).rejects.toBeInstanceOf(
      InvalidTagKeysError,
    );
    await expect(updateProject(db as never, 1, { tagKeys: { issue: '^(a+)+$' } })).rejects.toThrow(/tagKeys\.issue/);
    expect((await getProject(db as never, 1))?.tagKeys).toEqual({ issue: null, testCase: TEST_CASE });
  });

  test('leaving tagKeys out changes nothing, and null clears it', async () => {
    await updateProject(db as never, 1, { name: 'shop' });
    expect((await getProject(db as never, 1))?.tagKeys).toEqual({ issue: null, testCase: TEST_CASE });
    await updateProject(db as never, 1, { tagKeys: null });
    expect((await getProject(db as never, 1))?.tagKeys).toBeNull();
  });
});

describe('lastCompleteRunTagOverlap', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const start = Date.parse('2026-10-01T12:00:00Z');
  const anyTag = '^SHOP-[A-Z0-9]+$';

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values([
      { id: 1, name: 'shop' },
      { id: 2, name: 'empty' },
    ]);
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds an item', tags: ['SHOP-12', 'smoke'] },
      { id: 2, projectId: 1, filePath: 'cart.spec.ts', title: 'removes an item', tags: ['SHOP-T3', 'SHOP-12'] },
      { id: 3, projectId: 1, filePath: 'pay.spec.ts', title: 'pays by card', tags: ['SHOP-99'] },
    ]);
    const run = (id: number, extra: Record<string, unknown> = {}) => ({
      id,
      projectId: 1,
      status: 'passed',
      branch: 'main',
      environment: 'prod',
      startTime: new Date(start + id * 60_000),
      metadata: {},
      ...extra,
    });
    await db.insert(schema.testRuns).values([run(1), run(2, { isFullRun: 0 }), run(3, { origin: 'flake-lab' })]);
    const row = (runId: number, testCaseId: number, tags: string[] | null) => ({
      testRunId: runId,
      testCaseId,
      status: 'passed',
      tags,
    });
    await db
      .insert(schema.testRunsCases)
      .values([
        row(1, 1, ['SHOP-12', 'smoke']),
        row(1, 2, ['SHOP-T3', 'SHOP-12']),
        row(1, 3, null),
        row(2, 3, ['SHOP-99']),
        row(3, 3, ['SHOP-99']),
      ]);
  });

  test('names each tag both patterns match, with the first test that carries it', async () => {
    const report = await lastCompleteRunTagOverlap(db as never, 1, { issue: '^[A-Z]+-[0-9]+$', testCase: anyTag });
    expect(report).toEqual({ runId: 1, overlaps: [{ tag: 'SHOP-12', testTitle: 'adds an item' }] });
  });

  test('lists nothing when the patterns do not overlap', async () => {
    const report = await lastCompleteRunTagOverlap(db as never, 1, {
      issue: '^[A-Z]+-[0-9]+$',
      testCase: '^SHOP-T[0-9]+$',
    });
    expect(report).toEqual({ runId: 1, overlaps: [] });
  });

  test('reads the last complete run, not a later partial or lab run', async () => {
    const report = await lastCompleteRunTagOverlap(db as never, 1, { issue: '^SHOP-99$', testCase: '^SHOP-99$' });
    expect(report.runId).toBe(1);
    expect(report.overlaps).toEqual([]);
  });

  test('stops at the limit', async () => {
    const report = await lastCompleteRunTagOverlap(
      db as never,
      1,
      { issue: '^SHOP-[A-Z0-9]+$', testCase: '^SHOP-[A-Z0-9]+$' },
      1,
    );
    expect(report.overlaps).toHaveLength(1);
  });

  test('reads nothing while a pattern is off', async () => {
    expect(await lastCompleteRunTagOverlap(db as never, 1, { issue: null, testCase: anyTag })).toEqual({
      runId: null,
      overlaps: [],
    });
  });

  test('a project with no run has no run to read', async () => {
    expect(await lastCompleteRunTagOverlap(db as never, 2, { issue: anyTag, testCase: anyTag })).toEqual({
      runId: null,
      overlaps: [],
    });
  });
});

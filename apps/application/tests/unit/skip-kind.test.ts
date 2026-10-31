import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { fixmeSkipPredicate, isFixmeSkip } from '#shared/utils/skip-kind';
import { migrateToLatest } from './temp-db';

describe('isFixmeSkip', () => {
  test('is true only for a skipped case carrying a fixme annotation', () => {
    expect(isFixmeSkip({ status: 'skipped', testAnnotations: [{ type: 'fixme' }] })).toBe(true);
    expect(isFixmeSkip({ status: 'skipped', testAnnotations: [{ type: 'slow' }, { type: 'fixme' }] })).toBe(true);
    expect(isFixmeSkip({ status: 'skipped', testAnnotations: [{ type: 'skip' }] })).toBe(false);
    expect(isFixmeSkip({ status: 'skipped', testAnnotations: null })).toBe(false);
    expect(isFixmeSkip({ status: 'skipped' })).toBe(false);
    expect(isFixmeSkip({ status: 'failed', testAnnotations: [{ type: 'fixme' }] })).toBe(false);
  });
});

describe('fixmeSkipPredicate', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  // One case per row: the title says whether the predicate should match it.
  const ROWS: Array<{ title: string; status: string; annotations: string | null }> = [
    { title: 'match: fixme', status: 'skipped', annotations: JSON.stringify([{ type: 'fixme' }]) },
    {
      title: 'match: fixme with a description',
      status: 'skipped',
      annotations: JSON.stringify([{ type: 'slow' }, { type: 'fixme', description: 'Broken on WebKit' }]),
    },
    // PostgreSQL renders jsonb with a space after each colon.
    { title: 'match: jsonb spelling', status: 'skipped', annotations: '[{"type": "fixme"}]' },
    { title: 'no: plain skip', status: 'skipped', annotations: JSON.stringify([{ type: 'skip' }]) },
    { title: 'no: no annotations', status: 'skipped', annotations: null },
    {
      title: 'no: description mentions fixme',
      status: 'skipped',
      annotations: JSON.stringify([{ type: 'skip', description: 'fixme' }]),
    },
    {
      title: 'no: description quotes the type',
      status: 'skipped',
      annotations: JSON.stringify([{ type: 'skip', description: '"type":"fixme"' }]),
    },
    { title: 'no: fixme on a failure', status: 'failed', annotations: JSON.stringify([{ type: 'fixme' }]) },
  ];

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values([{ id: 1, name: 'Alpha' }]);
    await db.insert(schema.testRuns).values([{ id: 1, projectId: 1, status: 'passed', startTime: new Date() }]);
    await db
      .insert(schema.testCases)
      .values(ROWS.map((r, i) => ({ id: i + 1, projectId: 1, title: r.title, filePath: 'a.spec.ts' })));
    // Bound as raw text, so each row holds exactly the serialized form under test.
    await db.insert(schema.testRunsCases).values(
      ROWS.map((r, i) => ({
        testRunId: 1,
        testCaseId: i + 1,
        status: r.status,
        testAnnotations: sql`${r.annotations}`,
      })),
    );
  });

  test('matches a fixme skip in both JSON spellings and nothing else', async () => {
    const rows = await db
      .select({ title: schema.testCases.title })
      .from(schema.testRunsCases)
      .innerJoin(schema.testCases, eq(schema.testRunsCases.testCaseId, schema.testCases.id))
      .where(fixmeSkipPredicate(schema.testRunsCases.status, schema.testRunsCases.testAnnotations));
    expect(rows.map((r) => r.title).sort()).toEqual(
      ROWS.filter((r) => r.title.startsWith('match:'))
        .map((r) => r.title)
        .sort(),
    );
  });
});

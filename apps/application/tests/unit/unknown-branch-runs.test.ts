import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { backfillRunBranches } = await import('../../server/utils/run-branch-backfill');
const { resolveBranchPolicy } = await import('../../shared/handlers/analytics/common');
const { branchPolicyCondition } = await import('../../shared/handlers/analytics/branch-policy');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { pruneStaleCanonicalNodes } = await import('../../server/utils/graph-ingest');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'with-branches', defaultBranch: 'main' },
    { id: 2, name: 'no-branches', defaultBranch: 'main' },
  ]);
});

const run = (
  id: number,
  projectId: number,
  branch: string | null,
  metadata: Record<string, unknown> | null = null,
) => ({
  id,
  projectId,
  status: 'passed',
  startTime: new Date(id * 1000),
  branch,
  metadata,
});

async function branchOf(id: number) {
  const [row] = await db
    .select({ branch: schema.testRuns.branch })
    .from(schema.testRuns)
    .where(eq(schema.testRuns.id, id));
  return row?.branch;
}

describe('backfillRunBranches', () => {
  test('a run with a branch in its metadata and none in the column gets it, once', async () => {
    await db
      .insert(schema.testRuns)
      .values([
        run(1, 1, null, { scm: { branch: 'feature/pay', commit: 'abc' } }),
        run(2, 1, null, { scm: { branch: 'HEAD' } }),
        run(3, 1, null, { ci: { provider: 'github' } }),
        run(4, 1, 'main', { scm: { branch: 'other' } }),
        run(5, 1, null, null),
      ]);

    expect(await backfillRunBranches(db as any)).toBe(1);
    expect(await branchOf(1)).toBe('feature/pay');
    // A detached checkout, no SCM metadata or no metadata stay unknown; a stored branch is kept.
    expect(await branchOf(2)).toBeNull();
    expect(await branchOf(3)).toBeNull();
    expect(await branchOf(4)).toBe('main');
    expect(await branchOf(5)).toBeNull();

    expect(await backfillRunBranches(db as any)).toBe(0);
    expect(await branchOf(1)).toBe('feature/pay');
  });
});

describe('the default-branch analytics policy', () => {
  test('counts an unknown-branch run only in a project that never recorded a branch', async () => {
    await db
      .insert(schema.testRuns)
      .values([run(1, 1, 'main'), run(2, 1, null), run(3, 1, 'feature/x'), run(4, 2, null), run(5, 2, '')]);
    const policy = await resolveBranchPolicy(db as any, parseAnalyticsScope({}), 'all');
    const condition = branchPolicyCondition(
      policy,
      { branch: schema.testRuns.branch, projectId: schema.testRuns.projectId },
      'null',
    );
    const rows = await db.select({ id: schema.testRuns.id }).from(schema.testRuns).where(condition!);
    expect(rows.map((r) => r.id).sort()).toEqual([1, 4, 5]);
  });

  test('a project whose unknown-branch run gets its branch from the backfill counts it on that branch', async () => {
    await db.insert(schema.testRuns).values([run(1, 1, 'main'), run(2, 1, null, { scm: { branch: 'main' } })]);
    await backfillRunBranches(db as any);
    const policy = await resolveBranchPolicy(db as any, parseAnalyticsScope({}), [1]);
    const condition = branchPolicyCondition(
      policy,
      { branch: schema.testRuns.branch, projectId: schema.testRuns.projectId },
      'null',
    );
    const rows = await db.select({ id: schema.testRuns.id }).from(schema.testRuns).where(condition!);
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2]);
  });
});

describe('pruneStaleCanonicalNodes with unknown-branch runs', () => {
  const staleNode = {
    projectId: 1,
    kind: 'route',
    key: 'GET /cart',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
    lastSeenAt: new Date(),
  };
  const activeKeys = async (projectId: number) =>
    (
      await db
        .select({ key: schema.graphNodes.key })
        .from(schema.graphNodes)
        .where(and(eq(schema.graphNodes.projectId, projectId), isNull(schema.graphNodes.prunedAt)))
    ).map((n) => n.key);

  test('thirty unknown-branch runs do not age the canonical graph of a project that records branches', async () => {
    await db.insert(schema.testRuns).values([run(1, 1, 'main'), run(2, 1, 'main')]);
    for (let id = 3; id <= 33; id++) await db.insert(schema.testRuns).values(run(id, 1, null));
    await db.insert(schema.graphNodes).values(staleNode);

    expect(await pruneStaleCanonicalNodes(db)).toBe(0);
    expect(await activeKeys(1)).toEqual(['GET /cart']);
  });

  test('a project that never recorded a branch still prunes on its unknown-branch runs', async () => {
    for (let id = 1; id <= 31; id++) await db.insert(schema.testRuns).values(run(id, 2, null));
    await db.insert(schema.graphNodes).values({ ...staleNode, projectId: 2 });

    expect(await pruneStaleCanonicalNodes(db)).toBe(1);
    expect(await activeKeys(2)).toEqual([]);
  });
});

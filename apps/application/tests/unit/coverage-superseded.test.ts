/**
 * Off the default branch, each suite keeps only the report of the commit whose
 * coverage arrived last: the earlier commit keeps its totals, final, and its
 * summary answers from them. The notes say what a commit's numbers leave out.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { configureSqliteConnections, sqliteClientConfig } from '../../server/database/sqlite-connections';

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

delete process.env.PIWI_DATABASE_URL;
const { parseCoverageReportUpload, pruneCoverageReports, storeCoverageReport } =
  await import('../../server/utils/coverage-reports');
const { storeRunCoverage } = await import('../../server/utils/coverage');
const {
  commitDetailRemoved,
  loadCommitCoverage,
  pruneSupersededReports,
  settleCommitCoverage,
  staleCoverageCommits,
  storeCommitTotals,
} = await import('../../server/utils/coverage-totals');
const { exportCommitCoverage, getCoverageSummary, getCoverageTree, invalidateCommitCoverage } =
  await import('../../server/utils/coverage-summary');
const { COVERAGE_TOOL_HANDLERS } = await import('../../server/utils/mcp/coverage-tools');
const { ADMIN_ACCESS } = await import('#shared/permissions');

type Db = ReturnType<typeof drizzle<typeof schema>>;
const COMMIT_1 = '1'.repeat(40);
const COMMIT_2 = '2'.repeat(40);
const COMMIT_3 = '3'.repeat(40);
const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);
const BRANCH = 'feature/pay';
const DAY = 24 * 3_600_000;

const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-coverage-superseded-'));
let dbCount = 0;
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

let db: Db;
beforeEach(async () => {
  const client = createClient(sqliteClientConfig(`file:${join(tmpDir, `test-${++dbCount}.db`)}`));
  await configureSqliteConnections(client);
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
});

const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 9, day, hour));

const inventory = [
  ['src/back.cs', BLOB_A],
  ['src/front.ts', BLOB_B],
];
const back = (lines: number[][]) => ({ path: 'src/back.cs', blob: BLOB_A, executable: [[1, 10]], lines });
const front = (lines: number[][]) => ({ path: 'src/front.ts', blob: BLOB_B, executable: [[1, 10]], lines });

/** Upload a suite's report of a commit, arrived at `arrived`. */
async function upload(commit: string, suite: string, body: Record<string, unknown>, arrived: Date) {
  const parsed = parseCoverageReportUpload({ v: 1, commit, suite, branch: BRANCH, inventory, ...body });
  if (typeof parsed === 'string') throw new Error(parsed);
  const stored = await storeCoverageReport(db as never, 1, parsed);
  await db
    .update(schema.coverageReports)
    .set({ createdAt: arrived })
    .where(and(eq(schema.coverageReports.commit, commit), eq(schema.coverageReports.suite, suite)));
  invalidateCommitCoverage(1, commit);
  return stored;
}

async function reports() {
  return (
    await db
      .select({ commit: schema.coverageReports.commit, suite: schema.coverageReports.suite })
      .from(schema.coverageReports)
      .orderBy(schema.coverageReports.commit, schema.coverageReports.suite)
  ).map((r) => `${r.commit.slice(0, 1)} ${r.suite}`);
}

async function totalsOf(commit: string) {
  return db
    .select()
    .from(schema.coverageTotals)
    .where(eq(schema.coverageTotals.commit, commit))
    .orderBy(schema.coverageTotals.id);
}

/** Two pushes of a branch: the first with both suites, the second with the back end's only. */
async function twoPushes() {
  await upload(COMMIT_1, 'unit-back', { files: [back([[1, 4]])] }, at(1));
  await upload(COMMIT_1, 'unit-front', { files: [front([[1, 2]])] }, at(1));
  await storeCommitTotals(db as never, 1, COMMIT_1, at(1, 13));
  await upload(COMMIT_2, 'unit-back', { files: [back([[1, 6]])] }, at(2));
  await storeCommitTotals(db as never, 1, COMMIT_2, at(2, 13));
}

describe('pruneSupersededReports', () => {
  test('keeps per branch and suite the newest commit’s report, the carry source too, and marks the totals final', async () => {
    await twoPushes();
    const before = await totalsOf(COMMIT_1);
    expect(await pruneSupersededReports(db as never, at(2, 14), { projectId: 1, branch: BRANCH })).toBe(1);
    // The first push's front-end report stays: the second push carries it forward.
    expect(await reports()).toEqual(['1 unit-front', '2 unit-back']);
    const after = await totalsOf(COMMIT_1);
    expect(after.map((r) => [r.suite, r.executedLines])).toEqual(before.map((r) => [r.suite, r.executedLines]));
    expect(after.every((r) => r.supersededBy === COMMIT_2 && r.detailRemovedAt !== null)).toBe(true);
    expect(await commitDetailRemoved(db as never, 1, COMMIT_2)).toBeNull();
    invalidateCommitCoverage(1, COMMIT_2);
    const coverage = (await loadCommitCoverage(db as never, 1, COMMIT_2))!;
    expect(coverage.combined.suites.find((s) => s.name === 'unit-front')).toMatchObject({ carriedFrom: COMMIT_1 });
    // Nothing more to prune.
    expect(await pruneSupersededReports(db as never, at(2, 15))).toBe(0);
  });

  test('computes the totals of a superseded commit that has none before its reports go', async () => {
    await upload(COMMIT_1, 'unit-back', { files: [back([[1, 4]])] }, at(1));
    await upload(COMMIT_2, 'unit-back', { files: [back([[1, 6]])] }, at(2));
    expect(await pruneSupersededReports(db as never, at(2, 14))).toBe(1);
    const [combined] = (await totalsOf(COMMIT_1)).filter((r) => r.suite === 'combined' && r.area === '');
    expect(combined).toMatchObject({ executedLines: 4, supersededBy: COMMIT_2 });
  });

  test('leaves the default branch to its own rule', async () => {
    await upload(COMMIT_1, 'unit-back', { branch: 'main', files: [back([[1, 4]])] }, at(1));
    await upload(COMMIT_2, 'unit-back', { branch: 'main', files: [back([[1, 6]])] }, at(2));
    expect(await pruneSupersededReports(db as never, at(2, 14))).toBe(0);
    expect(await reports()).toEqual(['1 unit-back', '2 unit-back']);
  });
});

describe('final totals', () => {
  test('are never computed again: not for a run, a recount or a direct computation', async () => {
    await twoPushes();
    await pruneSupersededReports(db as never, at(2, 14));
    const before = await totalsOf(COMMIT_1);
    await db.insert(schema.testRuns).values({
      id: 10,
      projectId: 1,
      status: 'passed',
      startTime: at(3),
      branch: BRANCH,
      commit: COMMIT_1,
      isFullRun: 1,
      origin: 'ci',
      metadata: { ci: { provider: 'GitHub Actions' }, scm: { commit: COMMIT_1 } },
    });
    await storeRunCoverage(db as never, 10, 1, [
      { path: 'src/back.cs', runtime: 'server', blob: BLOB_A, lines: [[9, 10]] },
    ]);
    expect(await storeCommitTotals(db as never, 1, COMMIT_1, at(3, 1))).toBeNull();
    await db.update(schema.projects).set({ coverageScopeVersion: 7 }).where(eq(schema.projects.id, 1));
    expect(await staleCoverageCommits(db as never, 1)).toEqual([COMMIT_2]);
    expect(await totalsOf(COMMIT_1)).toEqual(before);
  });

  test('take a late upload in, keep it out of the totals and prune it again', async () => {
    await twoPushes();
    await pruneSupersededReports(db as never, at(2, 14));
    const before = await totalsOf(COMMIT_1);
    // A CI job of the first push, run again.
    const stored = await upload(COMMIT_1, 'unit-back', { files: [back([[1, 10]])] }, new Date());
    expect(stored.stored).toBe(1);
    expect(await settleCommitCoverage(async () => db as never, 1, COMMIT_1)).toEqual({ by: COMMIT_2 });
    expect(await reports()).toEqual(['1 unit-front', '2 unit-back']);
    expect((await totalsOf(COMMIT_1)).map((r) => r.executedLines)).toEqual(before.map((r) => r.executedLines));
    expect(await settleCommitCoverage(async () => db as never, 1, COMMIT_2)).toBeNull();
  });

  test('keep a late upload from superseding the newer commit when both arrived in the same second', async () => {
    await upload(COMMIT_1, 'unit-back', { files: [back([[1, 4]])] }, at(1));
    await upload(COMMIT_1, 'unit-front', { files: [front([[1, 2]])] }, at(1));
    await upload(COMMIT_2, 'unit-back', { files: [back([[1, 6]])] }, at(1));
    await storeCommitTotals(db as never, 1, COMMIT_1, at(1, 13));
    await storeCommitTotals(db as never, 1, COMMIT_2, at(1, 14));
    await pruneSupersededReports(db as never, at(1, 15));
    expect(await commitDetailRemoved(db as never, 1, COMMIT_1)).toMatchObject({ supersededBy: COMMIT_2 });
    await upload(COMMIT_1, 'unit-back', { files: [back([[1, 10]])] }, at(1));
    expect(await settleCommitCoverage(async () => db as never, 1, COMMIT_1)).toEqual({ by: COMMIT_2 });
    expect(await reports()).toEqual(['1 unit-front', '2 unit-back']);
    expect(await commitDetailRemoved(db as never, 1, COMMIT_2)).toBeNull();
  });

  test('stay on the default branch for a year, with the day’s commit that superseded them', async () => {
    const now = new Date(Date.UTC(2027, 0, 10, 12));
    const add = async (commit: string, daysAgo: number, hour: number) => {
      const when = new Date(now.getTime() - daysAgo * DAY + (hour - 12) * 3_600_000);
      await db.insert(schema.coverageReports).values({
        projectId: 1,
        commit,
        branch: '',
        suite: 'unit-back',
        kind: 'unit',
        createdAt: when,
        updatedAt: when,
      });
      await db.insert(schema.coverageTotals).values({
        projectId: 1,
        commit,
        branch: '',
        suite: 'combined',
        area: '',
        kind: 'combined',
        executedLines: 3,
        executableLines: 10,
        commitSeenAt: when,
        computedAt: when,
      });
    };
    await add(COMMIT_1, 5, 9); // the same day as the next, earlier
    await add(COMMIT_2, 5, 11);
    await add(COMMIT_3, 0, 12);
    await db.insert(schema.coverageTotals).values([
      {
        projectId: 1,
        commit: 'a'.repeat(40),
        suite: 'combined',
        kind: 'combined',
        computedAt: new Date(now.getTime() - 200 * DAY),
      },
      {
        projectId: 1,
        commit: 'b'.repeat(40),
        suite: 'combined',
        kind: 'combined',
        computedAt: new Date(now.getTime() - 400 * DAY),
      },
    ]);
    expect(await pruneCoverageReports(db as never, now)).toBe(1);
    expect(await commitDetailRemoved(db as never, 1, COMMIT_1)).toEqual({
      at: expect.any(Date),
      supersededBy: COMMIT_2,
    });
    const kept = (await db.select({ commit: schema.coverageTotals.commit }).from(schema.coverageTotals)).map(
      (r) => r.commit[0],
    );
    expect(kept.sort()).toEqual(['1', '2', '3', 'a']);
  });
});

describe('a final commit’s summary', () => {
  test('answers from the stored totals, with no files, and the tree and the export say the detail is gone', async () => {
    await twoPushes();
    await pruneSupersededReports(db as never, at(2, 14));
    const summary = (await getCoverageSummary(db as never, 1, { commit: COMMIT_1, branch: null, folder: 'src' }))!;
    const [combined] = (await totalsOf(COMMIT_1)).filter((r) => r.suite === 'combined' && r.area === '');
    expect(summary).toMatchObject({
      commit: COMMIT_1,
      branch: BRANCH,
      totals: { executedLines: combined!.executedLines, executableLines: combined!.executableLines },
      suites: [{ name: 'unit-back' }, { name: 'unit-front' }],
      filesWithoutData: { count: 0, paths: [] },
      folder: '',
      entries: [],
      leastCovered: [],
      detailRemoved: { supersededBy: COMMIT_2 },
    });
    expect(summary.notes[0]).toEqual({ kind: 'detail-removed', supersededBy: COMMIT_2 });
    const query = { commit: COMMIT_1, branch: null, folder: '' };
    expect(await getCoverageTree(db as never, 1, query)).toMatchObject({
      gone: true,
      message: expect.stringContaining('2222222'),
    });
    expect(await exportCommitCoverage(db as never, 1, query, 'lcov')).toMatchObject({ gone: true });
    expect(await getCoverageSummary(db as never, 1, { ...query, file: 'src/back.cs' })).toMatchObject({
      file: null,
      entries: [],
    });
  });

  test('is what the MCP tool answers, the detail and the newer commit named', async () => {
    await twoPushes();
    await pruneSupersededReports(db as never, at(2, 14));
    const answer = (await COVERAGE_TOOL_HANDLERS.get_coverage_summary(db as never, { projectId: 1, commit: COMMIT_1 }, {
      user: null,
      access: ADMIN_ACCESS,
      scope: 'all',
    } as never)) as Record<string, unknown>;
    expect(answer).toMatchObject({
      commit: COMMIT_1,
      detailRemoved: { supersededBy: COMMIT_2 },
      notes: [{ kind: 'detail-removed', supersededBy: COMMIT_2 }],
      suites: [{ name: 'unit-back' }, { name: 'unit-front' }],
    });
    expect(answer.entries).toBeUndefined();
  });

  test('notes a scope that changed since its totals', async () => {
    await twoPushes();
    await pruneSupersededReports(db as never, at(2, 14));
    await db.update(schema.projects).set({ coverageScopeVersion: 3 }).where(eq(schema.projects.id, 1));
    const summary = (await getCoverageSummary(db as never, 1, { commit: COMMIT_1, branch: null, folder: '' }))!;
    expect(summary.notes.map((n) => n.kind)).toEqual(['detail-removed', 'scope-changed']);
  });
});

describe('the notes of a summary', () => {
  test('name a carried suite, an incomplete report, a missing suite, no inventory and runs that do not count', async () => {
    await twoPushes();
    let summary = (await getCoverageSummary(db as never, 1, { commit: COMMIT_2, branch: null, folder: '' }))!;
    expect(summary.detailRemoved).toBeNull();
    expect(summary.notes).toEqual([{ kind: 'carried', suite: 'unit-front', from: COMMIT_1, files: 1 }]);

    // A third push with no inventory, an incomplete report and a partial run with run coverage.
    await upload(COMMIT_3, 'unit-back', { inventory: undefined, incomplete: true, files: [back([[1, 2]])] }, at(3));
    await db.insert(schema.testRuns).values({
      id: 20,
      projectId: 1,
      status: 'passed',
      startTime: at(3, 14),
      branch: BRANCH,
      commit: COMMIT_3,
      isFullRun: 0,
      origin: 'ci',
      metadata: { ci: { provider: 'GitHub Actions' }, scm: { commit: COMMIT_3 } },
    });
    await storeRunCoverage(db as never, 20, 1, [
      { path: 'src/back.cs', runtime: 'server', blob: BLOB_A, lines: [[3, 3]] },
    ]);
    summary = (await getCoverageSummary(db as never, 1, { commit: COMMIT_3, branch: null, folder: '' }))!;
    expect(summary.notes).toEqual([
      { kind: 'incomplete', suite: 'unit-back' },
      { kind: 'missing-suite', suite: 'e2e' },
      { kind: 'missing-suite', suite: 'unit-front' },
      { kind: 'no-inventory' },
      { kind: 'runs-not-counted', partial: 1, lab: 0 },
    ]);
  });
});

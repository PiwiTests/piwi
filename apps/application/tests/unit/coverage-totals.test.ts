import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { configureSqliteConnections, sqliteClientConfig } from '../../server/database/sqlite-connections';
import { eq } from 'drizzle-orm';

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

delete process.env.PIWI_DATABASE_URL;
const { parseCoverageReportUpload, storeCoverageReport } = await import('../../server/utils/coverage-reports');
const { storeRunCoverage } = await import('../../server/utils/coverage');
const { loadCommitCoverage, storeCommitTotals, latestCoverageCommit, recountStaleCommits, staleCoverageCommits } =
  await import('../../server/utils/coverage-totals');
const { getCoverageSummary, invalidateCommitCoverage, parseCoverageSummaryQuery } =
  await import('../../server/utils/coverage-summary');
const { INVALID_COVERAGE_AREAS, updateProject } = await import('../../shared/handlers/projects');

type Db = ReturnType<typeof drizzle<typeof schema>>;
const COMMIT_1 = '1'.repeat(40);
const COMMIT_2 = '2'.repeat(40);
const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);
const BLOB_C = 'c'.repeat(40);

const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-coverage-totals-'));
let dbCount = 0;
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

let db: Db;
beforeEach(async () => {
  // Configured as the server configures its client: writes wait for an open transaction.
  const client = createClient(sqliteClientConfig(`file:${join(tmpDir, `test-${++dbCount}.db`)}`));
  await configureSqliteConnections(client);
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
});

async function upload(body: Record<string, unknown>) {
  const parsed = parseCoverageReportUpload({ v: 1, commit: COMMIT_1, suite: 'unit-back', branch: 'main', ...body });
  if (typeof parsed === 'string') throw new Error(parsed);
  await storeCoverageReport(db as never, 1, parsed);
  invalidateCommitCoverage(1, parsed.commit);
}

/** Date a commit's reports as arrived at `at`. */
async function arrived(commit: string, at: Date) {
  await db.update(schema.coverageReports).set({ createdAt: at }).where(eq(schema.coverageReports.commit, commit));
  invalidateCommitCoverage(1, commit);
}

async function run(id: number, commit: string, isFullRun = 1, opts: { startTime?: Date; branch?: string } = {}) {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: opts.startTime ?? new Date(Date.UTC(2026, 9, 1) + id * 1000),
    branch: opts.branch ?? 'main',
    commit,
    isFullRun,
    origin: 'ci',
    metadata: { ci: { provider: 'GitHub Actions' }, scm: { commit } },
  });
}

const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 9, day, hour));

const inventory = [
  ['src/Shop.cs', BLOB_A],
  ['src/cart.ts', BLOB_B],
  ['src/idle.ts', BLOB_C],
];

describe('combined coverage of a commit', () => {
  test('counts a unit report and the commit’s complete Playwright runs on the span table’s lines', async () => {
    await upload({
      inventory,
      files: [
        // Microsoft code coverage counts the braces on lines 1, 5 and 9.
        { path: 'src/Shop.cs', blob: BLOB_A, executable: [[1, 9]], lines: [[1, 5]] },
        {
          path: 'src/cart.ts',
          blob: BLOB_B,
          executable: [
            [2, 3],
            [6, 7],
          ],
          lines: [[2, 2]],
          allFunctions: [
            [1, 4],
            [5, 8],
          ],
          functions: [[1, 4]],
        },
      ],
    });
    await run(10, COMMIT_1);
    await run(11, COMMIT_1, 0); // a partial run never counts
    await storeRunCoverage(db as never, 10, 1, [
      {
        path: 'src/Shop.cs',
        runtime: 'server',
        blob: BLOB_A,
        lines: [[6, 7]],
        executable: [
          [2, 4],
          [6, 8],
        ],
      },
      {
        path: 'src/cart.ts',
        runtime: 'browser',
        blob: BLOB_B,
        functions: [[5, 8]],
        allFunctions: [
          [1, 4],
          [5, 8],
        ],
      },
    ]);
    await storeRunCoverage(db as never, 11, 1, [
      { path: 'src/Shop.cs', runtime: 'server', blob: BLOB_A, lines: [[8, 8]] },
    ]);

    const coverage = (await loadCommitCoverage(db as never, 1, COMMIT_1))!;
    expect(coverage.runIds).toEqual([10]);
    const shop = coverage.combined.files.find((f) => f.path === 'src/Shop.cs')!;
    expect(shop).toMatchObject({
      reference: 'span-table',
      executable: [
        [2, 4],
        [6, 8],
      ],
      executed: [
        [2, 4],
        [6, 7],
      ],
    });
    const cart = coverage.combined.files.find((f) => f.path === 'src/cart.ts')!;
    expect(cart.classes.undetermined).toEqual([[6, 7]]);
    expect(coverage.combined.filesWithoutData).toEqual(['src/idle.ts']);
    expect(coverage.combined.totals).toMatchObject({
      executableLines: 10,
      executedLines: 6,
      undeterminedLines: 2,
      knownFunctions: 2,
      runFunctions: 2,
    });

    const summary = (await getCoverageSummary(db as never, 1, { commit: null, branch: null, folder: '' }))!;
    expect(summary.commit).toBe(COMMIT_1);
    expect(summary.totals.linePercent).toBe(60);
    expect(summary.suites.map((s) => [s.name, s.executedLines, s.executableLines])).toEqual([
      ['unit-back', 4, 10],
      ['e2e', 2, 10],
    ]);
    expect(summary.filesWithoutData).toEqual({ count: 1, paths: ['src/idle.ts'] });
    expect(summary.entries.map((e) => [e.path, e.linePercent])).toEqual([['src', 60]]);
    const withFile = (await getCoverageSummary(db as never, 1, {
      commit: null,
      branch: null,
      folder: '',
      file: 'src/Shop.cs',
    }))!;
    expect(withFile.file?.bySuite).toEqual({ 'unit-back': [[2, 4]], e2e: [[6, 7]] });
  });

  test('carries a suite the commit lacks forward from its newest report, where the file version is unchanged', async () => {
    await upload({
      inventory,
      files: [
        { path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 2]] },
        { path: 'src/idle.ts', blob: BLOB_C, executable: [[1, 1]], lines: [[1, 1]] },
      ],
    });
    await arrived(COMMIT_1, at(1));
    // The next commit changed src/idle.ts and uploads another suite only.
    await upload({
      commit: COMMIT_2,
      suite: 'unit-front',
      inventory: [
        ['src/cart.ts', BLOB_B],
        ['src/idle.ts', 'd'.repeat(40)],
      ],
      files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[4, 4]] }],
    });
    const coverage = (await loadCommitCoverage(db as never, 1, COMMIT_2))!;
    const back = coverage.combined.suites.find((s) => s.name === 'unit-back')!;
    expect(back).toMatchObject({ carriedFrom: COMMIT_1, carriedFiles: 1, executedLines: 2 });
    expect(coverage.combined.files.find((f) => f.path === 'src/cart.ts')!.executed).toEqual([
      [1, 2],
      [4, 4],
    ]);
    expect(coverage.combined.filesWithoutData).toEqual(['src/idle.ts']);
  });

  test('stores the totals per suite and for the day, and finds the newest commit with them', async () => {
    await upload({ inventory, files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 1]] }] });
    await arrived(COMMIT_1, at(5, 10));
    // The commit counts on the day it arrived, whenever it is computed.
    const now = at(7);
    await storeCommitTotals(db as never, 1, COMMIT_1, now);
    const totals = await db.select().from(schema.coverageTotals).orderBy(schema.coverageTotals.suite);
    expect(totals.map((t) => [t.suite, t.kind, t.executedLines, t.executableLines, t.filesWithoutData])).toEqual([
      ['combined', 'combined', 1, 4, 2],
      ['unit-back', 'unit', 1, 4, null],
    ]);
    const daily = await db.select().from(schema.coverageDaily).orderBy(schema.coverageDaily.suite);
    expect(daily.map((d) => [d.day, d.branch, d.suite, d.commit])).toEqual([
      ['2026-10-05', '', 'combined', COMMIT_1],
      ['2026-10-05', '', 'unit-back', COMMIT_1],
    ]);
    expect(totals[0]!.commitSeenAt).toEqual(at(5, 10));
    expect(await latestCoverageCommit(db as never, 1, '')).toBe(COMMIT_1);
    // Recomputing replaces the commit's rows.
    await storeCommitTotals(db as never, 1, COMMIT_1, at(8));
    expect(await db.select().from(schema.coverageTotals)).toHaveLength(2);
  });

  test('never lets a computation that started earlier replace a later one, and drops the suites a commit lost', async () => {
    await upload({ inventory, files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 1]] }] });
    await upload({
      suite: 'unit-front',
      inventory,
      files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[2, 2]] }],
    });
    await Promise.all([
      storeCommitTotals(db as never, 1, COMMIT_1, at(5, 12)),
      storeCommitTotals(db as never, 1, COMMIT_1, at(5, 12)),
    ]);
    expect(await db.select().from(schema.coverageTotals)).toHaveLength(3);
    // The unit-front report is gone: a later computation drops its row, an earlier one changes nothing.
    await db.delete(schema.coverageReports).where(eq(schema.coverageReports.suite, 'unit-front'));
    await storeCommitTotals(db as never, 1, COMMIT_1, at(5, 11));
    expect(await db.select().from(schema.coverageTotals)).toHaveLength(3);
    await storeCommitTotals(db as never, 1, COMMIT_1, at(5, 13));
    const rows = await db.select().from(schema.coverageTotals).orderBy(schema.coverageTotals.suite);
    expect(rows.map((r) => [r.suite, r.executedLines])).toEqual([
      ['combined', 1],
      ['unit-back', 1],
    ]);
    expect(rows[0]!.computationStartedAt).toEqual(at(5, 13));
  });

  test('carries only from commits that arrived earlier, and keeps the latest to arrive as the project’s coverage and the day’s', async () => {
    // C1 arrives on the 3rd with its unit tests; C2 on the 4th with a Playwright run.
    await upload({ inventory, files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 1]] }] });
    await arrived(COMMIT_1, at(3));
    await run(20, COMMIT_2, 1, { startTime: at(4) });
    await storeRunCoverage(db as never, 20, 1, [
      { path: 'src/cart.ts', runtime: 'server', blob: BLOB_B, lines: [[4, 4]], executable: [[1, 4]] },
    ]);
    await upload({
      commit: COMMIT_2,
      suite: 'unit-front',
      inventory,
      files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[3, 3]] }],
    });
    await arrived(COMMIT_2, at(4, 13));
    await storeCommitTotals(db as never, 1, COMMIT_2, at(4, 14));
    // CI is retried on C1 days later: it recomputes, and must not take C2's run.
    await upload({ inventory, files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[2, 2]] }] });
    const c1 = (await storeCommitTotals(db as never, 1, COMMIT_1, at(6)))!;
    expect(c1.seenAt).toEqual(at(3));
    expect(c1.combined.suites.map((s) => [s.name, s.carriedFrom])).toEqual([['unit-back', null]]);
    expect(await latestCoverageCommit(db as never, 1, '')).toBe(COMMIT_2);
    const daily = await db
      .select()
      .from(schema.coverageDaily)
      .where(eq(schema.coverageDaily.suite, 'combined'))
      .orderBy(schema.coverageDaily.day);
    expect(daily.map((d) => [d.day, d.commit])).toEqual([
      ['2026-10-03', COMMIT_1],
      ['2026-10-04', COMMIT_2],
    ]);
    // C2 carries C1's unit tests forward.
    const c2 = (await loadCommitCoverage(db as never, 1, COMMIT_2))!;
    expect(c2.combined.suites.find((s) => s.name === 'unit-back')).toMatchObject({ carriedFrom: COMMIT_1 });
  });

  test('keeps a day’s rows to the commit that arrived last that day', async () => {
    await upload({ inventory, files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 1]] }] });
    await arrived(COMMIT_1, at(3, 9));
    await upload({
      commit: COMMIT_2,
      inventory,
      files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 2]] }],
    });
    await arrived(COMMIT_2, at(3, 15));
    await storeCommitTotals(db as never, 1, COMMIT_2, at(3, 16));
    await storeCommitTotals(db as never, 1, COMMIT_1, at(3, 17));
    const daily = await db.select().from(schema.coverageDaily);
    expect(new Set(daily.map((d) => d.commit))).toEqual(new Set([COMMIT_2]));
  });

  test('carries an e2e suite forward as the union of every complete run of its commit', async () => {
    await run(30, COMMIT_1, 1, { startTime: at(2, 10) });
    await run(31, COMMIT_1, 1, { startTime: at(2, 11) });
    await storeRunCoverage(db as never, 30, 1, [
      { path: 'src/cart.ts', runtime: 'server', blob: BLOB_B, lines: [[1, 1]], executable: [[1, 4]] },
    ]);
    await storeRunCoverage(db as never, 31, 1, [
      { path: 'src/cart.ts', runtime: 'server', blob: BLOB_B, lines: [[3, 3]], executable: [[1, 4]] },
    ]);
    await upload({
      commit: COMMIT_2,
      inventory,
      files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[4, 4]] }],
    });
    await arrived(COMMIT_2, at(3));
    const coverage = (await loadCommitCoverage(db as never, 1, COMMIT_2))!;
    const e2e = coverage.combined.suites.find((s) => s.name === 'e2e')!;
    expect(e2e).toMatchObject({ carriedFrom: COMMIT_1, carriedFiles: 1, executedLines: 2 });
  });

  test('carries from the branch’s own earlier report before newer reports of the default branch', async () => {
    const feature = 'f'.repeat(40);
    await upload({
      commit: feature,
      branch: 'feature/x',
      suite: 'unit-front',
      inventory,
      files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 1]] }],
    });
    await arrived(feature, at(1));
    for (let i = 0; i < 12; i++) {
      const commit = i.toString(16).repeat(40);
      await upload({
        commit,
        suite: 'unit-front',
        inventory,
        files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[4, 4]] }],
      });
      await arrived(commit, at(2, i));
    }
    const head = 'e'.repeat(40);
    await upload({
      commit: head,
      branch: 'feature/x',
      inventory,
      files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[2, 2]] }],
    });
    await arrived(head, at(3));
    const coverage = (await loadCommitCoverage(db as never, 1, head))!;
    expect(coverage.branch).toBe('feature/x');
    expect(coverage.combined.suites.find((s) => s.name === 'unit-front')).toMatchObject({ carriedFrom: feature });
  });

  test('counts a commit any part of which ran on the default branch as the default branch’s', async () => {
    await upload({
      branch: 'feature/x',
      inventory,
      files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 1]] }],
    });
    await run(40, COMMIT_1, 1, { branch: 'main' });
    await storeRunCoverage(db as never, 40, 1, [
      { path: 'src/cart.ts', runtime: 'server', blob: BLOB_B, lines: [[2, 2]], executable: [[1, 4]] },
    ]);
    const coverage = (await storeCommitTotals(db as never, 1, COMMIT_1))!;
    expect(coverage.branch).toBe('');
    const reports = await db.select({ branch: schema.coverageReports.branch }).from(schema.coverageReports);
    expect(reports).toEqual([{ branch: '' }]);
    expect(new Set((await db.select().from(schema.coverageTotals)).map((t) => t.branch))).toEqual(new Set(['']));
  });

  test('keeps the browser’s undetermined lines of a file the server ran too', async () => {
    await run(50, COMMIT_1);
    await storeRunCoverage(db as never, 50, 1, [
      { path: 'src/cart.ts', runtime: 'server', blob: BLOB_B, lines: [[2, 2]], executable: [[1, 8]] },
      {
        path: 'src/cart.ts',
        runtime: 'browser',
        blob: BLOB_B,
        functions: [[5, 8]],
        allFunctions: [
          [1, 4],
          [5, 8],
        ],
      },
    ]);
    const coverage = (await loadCommitCoverage(db as never, 1, COMMIT_1))!;
    const cart = coverage.combined.files.find((f) => f.path === 'src/cart.ts')!;
    expect(cart.executed).toEqual([[2, 2]]);
    expect(cart.classes.undetermined).toEqual([[5, 8]]);
    expect(coverage.combined.totals).toMatchObject({ knownFunctions: 2, runFunctions: 1 });
  });

  test('recounts every commit computed under another scope or other areas, and drops the trend of a removed area', async () => {
    await updateProject(db as never, 1, { coverageAreas: [{ name: 'front', include: ['src/'] }] });
    await upload({ inventory, files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 1]] }] });
    await arrived(COMMIT_1, at(1));
    await upload({
      commit: COMMIT_2,
      inventory,
      files: [{ path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 2]] }],
    });
    await arrived(COMMIT_2, at(2));
    await storeCommitTotals(db as never, 1, COMMIT_1, at(2, 13));
    await storeCommitTotals(db as never, 1, COMMIT_2, at(2, 14));
    const areas = async () =>
      new Set((await db.select({ area: schema.coverageDaily.area }).from(schema.coverageDaily)).map((d) => d.area));
    expect(await areas()).toEqual(new Set(['', 'front']));

    await updateProject(db as never, 1, { coverageAreas: [{ name: 'web', include: ['src/'] }] });
    expect(await areas()).toEqual(new Set(['']));
    expect(await staleCoverageCommits(db as never, 1)).toEqual([COMMIT_2, COMMIT_1]);
    await recountStaleCommits(db as never, 1);
    expect(await staleCoverageCommits(db as never, 1)).toEqual([]);
    const totals = await db
      .select({ commit: schema.coverageTotals.commit, area: schema.coverageTotals.area })
      .from(schema.coverageTotals)
      .where(eq(schema.coverageTotals.suite, 'combined'));
    expect(
      totals
        .filter((t) => t.area === 'web')
        .map((t) => t.commit)
        .sort(),
    ).toEqual([COMMIT_1, COMMIT_2]);
    expect(totals.some((t) => t.area === 'front')).toBe(false);
  });

  test('counts each named area apart, in the stored totals and in the summary, and keeps the lists to one area', async () => {
    await db
      .update(schema.projects)
      .set({
        coverageAreas: [
          { name: 'back', include: ['*.cs'] },
          { name: 'front', include: ['src/'] },
        ],
      })
      .where(eq(schema.projects.id, 1));
    await upload({
      inventory,
      files: [
        { path: 'src/Shop.cs', blob: BLOB_A, executable: [[1, 4]], lines: [[1, 3]] },
        { path: 'src/cart.ts', blob: BLOB_B, executable: [[1, 4]], lines: [[1, 1]] },
      ],
    });
    const now = new Date(Date.UTC(2026, 9, 5, 12));
    await storeCommitTotals(db as never, 1, COMMIT_1, now);
    const totals = await db
      .select()
      .from(schema.coverageTotals)
      .orderBy(schema.coverageTotals.area, schema.coverageTotals.suite);
    expect(totals.map((t) => [t.area, t.suite, t.executedLines, t.executableLines])).toEqual([
      ['', 'combined', 4, 8],
      ['', 'unit-back', 4, 8],
      ['back', 'combined', 3, 4],
      ['back', 'unit-back', 3, 4],
      ['front', 'combined', 1, 4],
      ['front', 'unit-back', 1, 4],
    ]);
    expect(await db.select().from(schema.coverageDaily)).toHaveLength(6);

    const summary = (await getCoverageSummary(db as never, 1, {
      commit: COMMIT_1,
      branch: null,
      folder: 'src',
      area: 'front',
    }))!;
    expect(summary.areas.map((a) => [a.name, a.linePercent, a.suites.map((s) => s.name)])).toEqual([
      ['back', 75, ['unit-back']],
      ['front', 25, ['unit-back']],
    ]);
    expect(summary.area).toBe('front');
    expect(summary.entries.map((e) => e.path)).toEqual(['src/cart.ts']);
    expect(summary.filesWithoutData.paths).toEqual(['src/idle.ts']);
    // An area the project does not name keeps every file.
    const unknown = (await getCoverageSummary(db as never, 1, {
      commit: COMMIT_1,
      branch: null,
      folder: 'src',
      area: 'x',
    }))!;
    expect(unknown.area).toBeNull();
    expect(unknown.entries).toHaveLength(2);
  });

  test('stores the areas a project names, refuses ill-formed ones and removes them with an empty list', async () => {
    const areasOf = async () =>
      (await db.select({ areas: schema.projects.coverageAreas }).from(schema.projects))[0]!.areas;
    await updateProject(db as never, 1, { coverageAreas: [{ name: 'front', include: ['apps/web/'] }] });
    expect(await areasOf()).toEqual([{ name: 'front', include: ['apps/web/'] }]);
    await expect(updateProject(db as never, 1, { coverageAreas: [{ name: 'front', include: [] }] })).rejects.toThrow(
      INVALID_COVERAGE_AREAS,
    );
    await updateProject(db as never, 1, { coverageAreas: [] });
    expect(await areasOf()).toBeNull();
  });

  test('has none for a commit without a report or a complete run', async () => {
    expect(await loadCommitCoverage(db as never, 1, COMMIT_2)).toBeNull();
    expect(await getCoverageSummary(db as never, 1, { commit: COMMIT_2, branch: null, folder: '' })).toBeNull();
  });

  test('checks a summary query', () => {
    expect(parseCoverageSummaryQuery(COMMIT_1.toUpperCase(), ' main ', '/src/')).toEqual({
      commit: COMMIT_1,
      branch: 'main',
      folder: 'src',
    });
    expect(parseCoverageSummaryQuery('zz', undefined, undefined)).toHaveProperty('error');
    expect(parseCoverageSummaryQuery(undefined, undefined, 'a/../b')).toHaveProperty('error');
    expect(parseCoverageSummaryQuery(undefined, undefined, undefined, '/src/cart.ts')).toEqual({
      commit: null,
      branch: null,
      folder: '',
      file: 'src/cart.ts',
    });
    expect(parseCoverageSummaryQuery(undefined, undefined, undefined, '../x.ts')).toHaveProperty('error');
  });

  test('refuses the reserved suite names', () => {
    expect(parseCoverageReportUpload({ v: 1, commit: COMMIT_1, suite: 'e2e', files: [] })).toMatch(/reserved/);
    expect(parseCoverageReportUpload({ v: 1, commit: COMMIT_1, suite: 'Combined', files: [] })).toMatch(/reserved/);
  });
});

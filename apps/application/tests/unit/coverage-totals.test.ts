import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
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
const { loadCommitCoverage, storeCommitTotals, latestCoverageCommit } =
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
  db = drizzle(createClient({ url: `file:${join(tmpDir, `test-${++dbCount}.db`)}` }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
});

async function upload(body: Record<string, unknown>) {
  const parsed = parseCoverageReportUpload({ v: 1, commit: COMMIT_1, suite: 'unit-back', branch: 'main', ...body });
  if (typeof parsed === 'string') throw new Error(parsed);
  await storeCoverageReport(db as never, 1, parsed);
  invalidateCommitCoverage(1, parsed.commit);
}

async function run(id: number, commit: string, isFullRun = 1) {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: new Date(Date.UTC(2026, 9, 1) + id * 1000),
    branch: 'main',
    commit,
    isFullRun,
    origin: 'ci',
    metadata: { ci: { provider: 'GitHub Actions' }, scm: { commit } },
  });
}

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
    const now = new Date(Date.UTC(2026, 9, 5, 12));
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
    expect(await latestCoverageCommit(db as never, 1, '')).toBe(COMMIT_1);
    // Recomputing replaces the commit's rows.
    await storeCommitTotals(db as never, 1, COMMIT_1, now);
    expect(await db.select().from(schema.coverageTotals)).toHaveLength(2);
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

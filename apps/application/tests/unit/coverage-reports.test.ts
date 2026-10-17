import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const {
  getReportFiles,
  getReportInventories,
  listCoverageReports,
  parseCoverageReportsQuery,
  parseCoverageReportUpload,
  pruneCoverageReports,
  storeCoverageReport,
} = await import('../../server/utils/coverage-reports');
const { deleteBranchCoverageRows, unreferencedFragments } = await import('../../server/utils/coverage');
const { sweepOrphans } = await import('../../server/utils/retention');
const { deleteProjectData } = await import('../../shared/handlers/projects');

type Db = ReturnType<typeof drizzle<typeof schema>>;
const DAY = 24 * 3_600_000;
const COMMIT_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const COMMIT_B = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);

const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-coverage-reports-'));
let dbCount = 0;
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

async function freshDb(): Promise<Db> {
  const db = drizzle(createClient({ url: `file:${join(tmpDir, `test-${++dbCount}.db`)}` }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  return db;
}

/** An upload, checked, failing the test when it is refused. */
function upload(body: Record<string, unknown>) {
  const parsed = parseCoverageReportUpload({ v: 1, commit: COMMIT_A, suite: 'unit-back', ...body });
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
}

const cart = (lines: number[][], blob = BLOB_A) => ({
  path: 'src/cart.ts',
  blob,
  executable: [[1, 10]],
  lines,
  functions: [[1, 4]],
  allFunctions: [
    [1, 4],
    [6, 9],
  ],
});

describe('parseCoverageReportUpload', () => {
  test('checks the commit, the suite, the kind and the files', () => {
    expect(parseCoverageReportUpload({ v: 1, commit: 'nope', suite: 'unit', files: [] })).toMatch(/commit/);
    expect(parseCoverageReportUpload({ v: 1, commit: COMMIT_A, suite: '-x', files: [] })).toMatch(/suite/);
    expect(parseCoverageReportUpload({ v: 1, commit: COMMIT_A, suite: 'unit', kind: 'x', files: [] })).toMatch(/kind/);
    expect(parseCoverageReportUpload({ v: 1, commit: COMMIT_A, suite: 'unit', files: {} })).toMatch(/files/);
    expect(parseCoverageReportUpload({ v: 2 })).toBeTypeOf('string');
  });

  test('cleans paths and ranges, drops a file with nothing to count, and merges one named twice', () => {
    const parsed = upload({
      commit: COMMIT_A.toUpperCase(),
      inventory: [
        ['src/cart.ts', BLOB_A],
        ['../outside.ts', BLOB_A],
        ['src/bad.ts', 'not-a-blob'],
      ],
      files: [
        {
          path: './src/cart.ts',
          blob: BLOB_A,
          executable: [
            [5, 6],
            [1, 4],
          ],
          lines: [[1, 2]],
        },
        { path: 'src/cart.ts', blob: BLOB_A, executable: [[8, 8]], lines: [[5, 5]] },
        { path: 'node_modules/x/index.js', executable: [[1, 1]] },
        { path: 'src/empty.ts', blob: BLOB_A, lines: [[1, 1]] },
      ],
    });
    expect(parsed.commit).toBe(COMMIT_A);
    expect(parsed.kind).toBe('unit');
    expect(parsed.inventory).toEqual([['src/cart.ts', BLOB_A]]);
    expect(parsed.files).toEqual([
      {
        path: 'src/cart.ts',
        blob: BLOB_A,
        executable: [
          [1, 6],
          [8, 8],
        ],
        lines: [
          [1, 2],
          [5, 5],
        ],
        functions: [],
        allFunctions: [],
      },
    ]);
  });

  test('reads a listing query', () => {
    expect(parseCoverageReportsQuery(COMMIT_A.toUpperCase(), '5')).toEqual({ commit: COMMIT_A, limit: 5 });
    expect(parseCoverageReportsQuery(undefined, undefined)).toEqual({ commit: null, limit: undefined });
    expect(parseCoverageReportsQuery('zz', undefined)).toHaveProperty('error');
    expect(parseCoverageReportsQuery(undefined, 'x')).toHaveProperty('error');
  });
});

describe('storeCoverageReport', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  test('merges the parts of one commit and suite, file by file, and their inventories', async () => {
    const first = await storeCoverageReport(
      db as never,
      1,
      upload({ branch: 'main', tool: 'cobertura', inventory: [['src/cart.ts', BLOB_A]], files: [cart([[1, 2]])] }),
    );
    expect(first.stored).toBe(1);
    expect(first.report).toMatchObject({
      commit: COMMIT_A,
      branch: null,
      suite: 'unit-back',
      files: 1,
      inventoryFiles: 1,
    });
    const second = await storeCoverageReport(
      db as never,
      1,
      upload({
        inventory: [['src/pay.ts', BLOB_B]],
        files: [cart([[5, 5]]), { path: 'src/pay.ts', blob: BLOB_B, executable: [[1, 3]] }],
      }),
    );
    expect(second.report).toMatchObject({
      id: first.report.id,
      files: 2,
      inventoryFiles: 2,
      incomplete: false,
      tool: 'cobertura',
    });
    const files = (await getReportFiles(db as never, [first.report.id])).get(first.report.id);
    expect(files).toEqual([
      {
        path: 'src/cart.ts',
        blob: BLOB_A,
        executable: [[1, 10]],
        lines: [
          [1, 2],
          [5, 5],
        ],
        functions: [[1, 4]],
        allFunctions: [
          [1, 4],
          [6, 9],
        ],
      },
      { path: 'src/pay.ts', blob: BLOB_B, executable: [[1, 3]], lines: [], functions: [], allFunctions: [] },
    ]);
    const [report] = await db.select().from(schema.coverageReports);
    expect((await getReportInventories(db as never, [report!])).get(report!.id)).toEqual([
      ['src/cart.ts', BLOB_A],
      ['src/pay.ts', BLOB_B],
    ]);
  });

  test('keeps the newer version of a file the parts disagree on, and marks the report incomplete', async () => {
    await storeCoverageReport(db as never, 1, upload({ files: [cart([[1, 2]])] }));
    const { report } = await storeCoverageReport(db as never, 1, upload({ files: [cart([[3, 3]], BLOB_B)] }));
    expect(report.incomplete).toBe(true);
    const [file] = (await getReportFiles(db as never, [report.id])).get(report.id)!;
    expect(file).toMatchObject({ blob: BLOB_B, lines: [[3, 3]] });
  });

  test('shares one fragment between two commits whose file ran the same lines, kept apart from test fragments', async () => {
    await storeCoverageReport(db as never, 1, upload({ files: [cart([[1, 2]])] }));
    await storeCoverageReport(db as never, 1, upload({ commit: COMMIT_B, files: [cart([[1, 2]])] }));
    const fragments = await db.select().from(schema.coverageFragments);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({ runtime: 'report', path: 'src/cart.ts', blob: BLOB_A, executable: '1-10' });
    expect(await listCoverageReports(db as never, 1)).toHaveLength(2);
    expect((await listCoverageReports(db as never, 1, { commit: COMMIT_B })).map((r) => r.commit)).toEqual([COMMIT_B]);
  });

  test('stores a branch other than the default as itself, and deletes its reports with its other coverage rows', async () => {
    const { report } = await storeCoverageReport(
      db as never,
      1,
      upload({ branch: 'feature/pay', files: [cart([[1, 2]])] }),
    );
    expect(report.branch).toBe('feature/pay');
    expect(await deleteBranchCoverageRows(db as never, 1, 'feature/pay')).toBe(1);
    expect(await db.select().from(schema.coverageReportFiles)).toEqual([]);
  });

  test('keeps a report’s fragments and inventory from the orphan sweep', async () => {
    await storeCoverageReport(
      db as never,
      1,
      upload({ inventory: [['src/cart.ts', BLOB_A]], files: [cart([[1, 2]])] }),
    );
    await db.update(schema.coverageFragments).set({ lastSeenAt: new Date(Date.now() - 2 * DAY) });
    await db.update(schema.casePayloads).set({ createdAt: new Date(Date.now() - 2 * DAY) });
    const orphans = await db.select().from(schema.coverageFragments).where(unreferencedFragments());
    expect(orphans).toEqual([]);
    const swept = await sweepOrphans(db as never);
    expect(swept).toMatchObject({ coverageFragments: 0, casePayloads: 0 });
    await db.delete(schema.coverageReports);
    expect(await db.select().from(schema.coverageFragments).where(unreferencedFragments())).toHaveLength(1);
  });
});

describe('pruneCoverageReports', () => {
  test('keeps the newest commit and each day’s last on the default branch for ninety days, a branch’s for thirty', async () => {
    const db = await freshDb();
    const now = new Date(Date.UTC(2026, 9, 1, 12));
    const add = async (commit: string, branch: string, at: number) => {
      await db.insert(schema.coverageReports).values({
        projectId: 1,
        commit,
        branch,
        suite: 'unit',
        kind: 'unit',
        createdAt: new Date(at),
        updatedAt: new Date(at),
      });
    };
    const hex = (n: number) => n.toString(16).padStart(40, '0');
    const day = (n: number, hour = 10) => now.getTime() - n * DAY + (hour - 12) * 3_600_000;
    await add(hex(1), '', day(0, 11)); // newest
    await add(hex(2), '', day(0, 9)); // earlier the same day
    await add(hex(3), '', day(5)); // a day's last
    await add(hex(4), '', day(100)); // past ninety days
    await add(hex(5), 'feature/x', day(10));
    await add(hex(6), 'feature/y', day(40));
    expect(await pruneCoverageReports(db as never, now)).toBe(3);
    const kept = await db
      .select({ commit: schema.coverageReports.commit })
      .from(schema.coverageReports)
      .orderBy(schema.coverageReports.commit);
    expect(kept.map((r) => r.commit)).toEqual([hex(1), hex(3), hex(5)]);
  });

  test('keeps the newest commit of a project even past ninety days', async () => {
    const db = await freshDb();
    const now = new Date(Date.UTC(2026, 9, 1));
    await db.insert(schema.coverageReports).values({
      projectId: 1,
      commit: COMMIT_A,
      suite: 'unit',
      kind: 'unit',
      createdAt: new Date(now.getTime() - 200 * DAY),
      updatedAt: new Date(now.getTime() - 200 * DAY),
    });
    expect(await pruneCoverageReports(db as never, now)).toBe(0);
    expect(
      Number(
        (
          await db
            .select({ n: sql<number>`count(*)` })
            .from(schema.coverageReports)
            .where(eq(schema.coverageReports.projectId, 1))
        )[0]!.n,
      ),
    ).toBe(1);
  });

  test('a deleted project takes its reports and their inventories with it', async () => {
    const db = await freshDb();
    await db.run(sql`PRAGMA foreign_keys = ON`);
    await storeCoverageReport(
      db as never,
      1,
      upload({ inventory: [['src/cart.ts', BLOB_A]], files: [cart([[1, 2]])] }),
    );
    await deleteProjectData(db as never, 1);
    expect(await db.select().from(schema.coverageReports)).toEqual([]);
    expect(await db.select().from(schema.casePayloads)).toEqual([]);
  });
});

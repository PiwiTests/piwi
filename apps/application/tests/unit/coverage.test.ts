import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

// Run deletion also clears each run's storage directory; no files exist here.
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const {
  deleteBranchCoverageRows,
  getExecutionCoverage,
  getFileCoverage,
  parseCoveragePayload,
  parseRunCoverage,
  pruneStaleBranchCoverageRows,
  storeRunCoverage,
  upsertCoverageFragments,
} = await import('../../server/utils/coverage');
const { getCodeIndex, getCodeReachForFile } = await import('../../server/utils/code-reach');
const { resolveImpact } = await import('../../server/utils/selection-impact');
const { computeChangeCoverage } = await import('../../shared/handlers/change-coverage');
const { deleteRunsByIds, sweepOrphans } = await import('../../server/utils/retention');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 1);
const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);
const LAYOUT = 'src/Web/Views/Shared/_Layout.cshtml';
const BASKET = 'src/Web/Services/BasketService.cs';
const CART = 'src/lib/cart.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-coverage-'));
let dbCount = 0;
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

/** A migrated file database: libSQL runs a transaction on its own connection, which an in-memory database does not share. */
async function freshDb(): Promise<Db> {
  const db = drizzle(createClient({ url: `file:${join(tmpDir, `test-${++dbCount}.db`)}` }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
  return db;
}

async function run(db: Db, id: number, branch: string | null, at: number, metadata: Record<string, unknown> = {}) {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: new Date(at),
    branch,
    metadata,
    totalTests: 1,
    passedTests: 1,
  });
}

const layout = { path: LAYOUT, runtime: 'server', blob: BLOB_A, functions: [[1, 30]], lines: [[2, 6]] };
const cart = { path: CART, runtime: 'browser', blob: BLOB_A, functions: [[3, 9]] };
function basket(lines: Array<[number, number]>) {
  return { path: BASKET, runtime: 'server', blob: BLOB_B, functions: [[50, 80]], lines };
}
function capture(...files: unknown[]) {
  return { v: 1, files };
}

function execution(title: string, coverage?: unknown, extra: Record<string, unknown> = {}) {
  return { title, filePath: 'tests/shop.spec.ts', status: 'passed', line: 1, column: 1, coverage, ...extra };
}

async function caseId(db: Db, title: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.testCases.id })
    .from(schema.testCases)
    .where(eq(schema.testCases.title, title));
  return row!.id;
}

/** A test's `test_coverage` rows on a branch, as `runtime path lines` strings. */
async function testCoverageOf(db: Db, title: string, branch = ''): Promise<string[]> {
  const rows = await db
    .select({
      runtime: schema.testCoverage.runtime,
      path: schema.coverageFragments.path,
      lines: schema.coverageFragments.lines,
    })
    .from(schema.testCoverage)
    .innerJoin(schema.coverageFragments, eq(schema.testCoverage.fragmentId, schema.coverageFragments.id))
    .where(and(eq(schema.testCoverage.testCaseId, await caseId(db, title)), eq(schema.testCoverage.branch, branch)));
  return rows.map((r) => `${r.runtime} ${r.path} ${r.lines ?? ''}`.trim()).sort();
}

async function executionOf(db: Db, runId: number, title: string, retries = 0) {
  const [row] = await db
    .select({ id: schema.testRunsCases.id, coveragePayloadId: schema.testRunsCases.coveragePayloadId })
    .from(schema.testRunsCases)
    .where(
      and(
        eq(schema.testRunsCases.testRunId, runId),
        eq(schema.testRunsCases.testCaseId, await caseId(db, title)),
        eq(schema.testRunsCases.retries, retries),
      ),
    );
  return row!;
}

describe('coverage ingest', () => {
  let db: Db;

  beforeAll(async () => {
    db = await freshDb();
    await run(db, 10, 'main', T0);
    await persistRunCases(db as never, 1, 10, [
      execution('pays', capture(layout, basket([[51, 53]]), cart)),
      execution('browses', capture(layout, cart)),
    ]);
  });

  test('stores a file the tests recorded alike once, and each test’s fragments', async () => {
    const fragments = await db.select().from(schema.coverageFragments);
    expect(fragments.map((f) => `${f.runtime} ${f.path}`).sort()).toEqual([
      `browser ${CART}`,
      `server ${BASKET}`,
      `server ${LAYOUT}`,
    ]);
    const stored = fragments.find((f) => f.path === BASKET)!;
    expect([stored.blob, stored.functions, stored.lines]).toEqual([BLOB_B, '50-80', '51-53']);
    expect(await testCoverageOf(db, 'pays')).toEqual([
      `browser ${CART}`,
      `server ${BASKET} 51-53`,
      `server ${LAYOUT} 2-6`,
    ]);
    expect(await testCoverageOf(db, 'browses')).toEqual([`browser ${CART}`, `server ${LAYOUT} 2-6`]);
  });

  test('derives code reach per runtime from the coverage', async () => {
    const reach = await db
      .select({ file: schema.codeReach.file, runtime: schema.codeReach.runtime, origin: schema.codeReach.origin })
      .from(schema.codeReach)
      .where(eq(schema.codeReach.testCaseId, await caseId(db, 'pays')));
    expect(reach.map((r) => `${r.runtime} ${r.origin} ${r.file}`).sort()).toEqual([
      `browser client ${CART}`,
      `server server ${BASKET}`,
      `server server ${LAYOUT}`,
    ]);
  });

  test('stores each execution’s fragment ids, shared by identical executions across runs', async () => {
    const first = await executionOf(db, 10, 'browses');
    const [payload] = await db
      .select({ content: schema.casePayloads.content })
      .from(schema.casePayloads)
      .where(eq(schema.casePayloads.id, first.coveragePayloadId!));
    const ids = (
      await db
        .select({ id: schema.coverageFragments.id, path: schema.coverageFragments.path })
        .from(schema.coverageFragments)
    )
      .filter((f) => f.path !== BASKET)
      .map((f) => f.id)
      .sort((a, b) => a - b);
    expect(payload!.content).toBe(JSON.stringify(ids));

    await run(db, 11, 'main', T0 + HOUR);
    await persistRunCases(db as never, 1, 11, [
      execution('browses', capture(cart, layout)),
      execution(
        'pays',
        capture(
          basket([
            [51, 53],
            [57, 59],
          ]),
          cart,
        ),
      ),
    ]);
    expect((await executionOf(db, 11, 'browses')).coveragePayloadId).toBe(first.coveragePayloadId);
    expect(await db.$count(schema.coverageFragments)).toBe(4);
  });

  test('the latest run replaces a test’s coverage; an older one changes nothing', async () => {
    expect(await testCoverageOf(db, 'pays')).toEqual([`browser ${CART}`, `server ${BASKET} 51-53,57-59`]);

    await run(db, 9, 'main', T0 - HOUR);
    await persistRunCases(db as never, 1, 9, [execution('pays', capture(basket([[90, 91]])))]);
    expect(await testCoverageOf(db, 'pays')).toEqual([`browser ${CART}`, `server ${BASKET} 51-53,57-59`]);
    // The older execution keeps its own coverage.
    const old = await getExecutionCoverage(db as never, (await executionOf(db, 9, 'pays')).id);
    expect(old!.files.map((f) => f.lines)).toEqual([[[90, 91]]]);
  });

  test('merges the executions of one run, and keeps the runtimes the run did not record', async () => {
    await run(db, 12, 'main', T0 + 2 * HOUR);
    await persistRunCases(db as never, 1, 12, [
      execution('pays', capture(layout), { status: 'failed', error: 'boom', retries: 0 }),
      execution('pays', capture(basket([[70, 71]])), { retries: 1 }),
    ]);
    expect(await testCoverageOf(db, 'pays')).toEqual([
      `browser ${CART}`,
      `server ${BASKET} 70-71`,
      `server ${LAYOUT} 2-6`,
    ]);
    const reach = await db
      .select({ file: schema.codeReach.file, runtime: schema.codeReach.runtime })
      .from(schema.codeReach)
      .where(eq(schema.codeReach.testCaseId, await caseId(db, 'pays')));
    expect(reach.map((r) => `${r.runtime} ${r.file}`).sort()).toEqual([
      `browser ${CART}`,
      `server ${BASKET}`,
      `server ${LAYOUT}`,
    ]);
  });

  test('a test without coverage gets browser code reach from its list', async () => {
    await run(db, 13, 'main', T0 + 3 * HOUR);
    await persistRunCases(db as never, 1, 13, [execution('coupons', undefined, { codeReach: ['src/lib/coupon.ts'] })]);
    const reach = await db
      .select({ file: schema.codeReach.file, runtime: schema.codeReach.runtime })
      .from(schema.codeReach)
      .where(eq(schema.codeReach.testCaseId, await caseId(db, 'coupons')));
    expect(reach).toEqual([{ file: 'src/lib/coupon.ts', runtime: 'browser' }]);
    expect(await testCoverageOf(db, 'coupons')).toEqual([]);
    expect((await executionOf(db, 13, 'coupons')).coveragePayloadId).toBeNull();
  });

  test('a lab run stores its executions’ coverage but leaves the tests’ coverage alone', async () => {
    await run(db, 14, 'main', T0 + 4 * HOUR, { piwiProbe: true });
    await persistRunCases(db as never, 1, 14, [execution('browses', capture(basket([[99, 99]])))]);
    expect((await executionOf(db, 14, 'browses')).coveragePayloadId).not.toBeNull();
    expect(await testCoverageOf(db, 'browses')).toEqual([`browser ${CART}`, `server ${LAYOUT} 2-6`]);
  });

  test('an invalid coverage field is ignored', async () => {
    await run(db, 15, 'main', T0 + 5 * HOUR);
    await persistRunCases(db as never, 1, 15, [
      execution('broken', { v: 2, files: [] }),
      execution('escapes', capture({ path: '../secret.cs', runtime: 'server' })),
    ]);
    expect((await executionOf(db, 15, 'broken')).coveragePayloadId).toBeNull();
    expect((await executionOf(db, 15, 'escapes')).coveragePayloadId).toBeNull();
  });
});

describe('coverage reads', () => {
  let db: Db;
  let paysRun10: number;

  beforeAll(async () => {
    db = await freshDb();
    await run(db, 10, 'main', T0);
    await persistRunCases(db as never, 1, 10, [
      execution('pays', capture(layout, basket([[51, 53]]), cart)),
      execution('browses', capture(layout, cart)),
      execution('partly', { ...capture(basket([[51, 53]])), incomplete: true }),
      execution('nothing'),
    ]);
    paysRun10 = (await executionOf(db, 10, 'pays')).id;
    // On a feature branch, `pays` records other lines of the basket, and no browser coverage.
    await run(db, 20, 'feature/basket', T0 + HOUR);
    await persistRunCases(db as never, 1, 20, [execution('pays', capture(basket([[60, 62]])))]);
  });

  test('an execution’s coverage, files sorted by path', async () => {
    const coverage = await getExecutionCoverage(db as never, paysRun10);
    expect(coverage).toEqual({
      v: 1,
      files: [
        { path: BASKET, runtime: 'server', blob: BLOB_B, functions: [[50, 80]], lines: [[51, 53]] },
        { path: LAYOUT, runtime: 'server', blob: BLOB_A, functions: [[1, 30]], lines: [[2, 6]] },
        { path: CART, runtime: 'browser', blob: BLOB_A, functions: [[3, 9]] },
      ],
    });
  });

  test('incomplete when the capture was, or when a fragment is gone; empty without coverage', async () => {
    const partly = await getExecutionCoverage(db as never, (await executionOf(db, 10, 'partly')).id);
    expect(partly).toMatchObject({ incomplete: true, files: [{ path: BASKET }] });
    expect(await getExecutionCoverage(db as never, (await executionOf(db, 10, 'nothing')).id)).toEqual({
      v: 1,
      files: [],
    });
    expect(await getExecutionCoverage(db as never, 999_999)).toBeNull();

    const browses = await executionOf(db, 10, 'browses');
    const [cartFragment] = await db
      .select({ id: schema.coverageFragments.id })
      .from(schema.coverageFragments)
      .where(eq(schema.coverageFragments.path, CART));
    const [payload] = await db
      .select({ content: schema.casePayloads.content })
      .from(schema.casePayloads)
      .where(eq(schema.casePayloads.id, browses.coveragePayloadId!));
    expect(parseCoveragePayload(payload!.content)!.fragmentIds).toContain(cartFragment!.id);
    // A copy of the database whose cart fragment is gone reads the rest, marked incomplete.
    const other = await freshDb();
    await other.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'a' });
    await run(other, 1, 'main', T0);
    const [stored] = await upsertCoverageFragments(other as never, 1, [
      {
        v: 1,
        files: [
          { path: CART, runtime: 'browser' },
          { path: LAYOUT, runtime: 'server' },
        ],
      },
    ]);
    const [kept] = await other
      .insert(schema.casePayloads)
      .values({ projectId: 1, hash: 'h', content: JSON.stringify(stored!.map((f) => f.id)), size: 1 })
      .returning();
    const [row] = await other
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 1, status: 'passed', coveragePayloadId: kept!.id })
      .returning();
    await other.delete(schema.coverageFragments).where(eq(schema.coverageFragments.path, CART));
    expect(await getExecutionCoverage(other as never, row!.id)).toEqual({
      v: 1,
      files: [{ path: LAYOUT, runtime: 'server' }],
      incomplete: true,
    });
  });

  test('a file’s coverage on the default branch, matched by a path suffix', async () => {
    const coverage = await getFileCoverage(db as never, 1, 'Services/BasketService.cs');
    expect(coverage.branch).toBe('main');
    expect(coverage.tests.map((t) => t.title)).toEqual(['partly', 'pays']);
    expect(coverage.fragments).toEqual([
      { path: BASKET, runtime: 'server', blob: BLOB_B, functions: [[50, 80]], lines: [[51, 53]], tests: [0, 1] },
    ]);
    expect(coverage.executable).toEqual([]);
    expect((await getFileCoverage(db as never, 1, 'Other.cs')).fragments).toEqual([]);
  });

  test('a file’s executable lines come from the newest run coverage of each version', async () => {
    const other = await freshDb();
    await run(other, 40, 'main', T0);
    await run(other, 41, 'feature/basket', T0 + 1000);
    await run(other, 42, 'main', T0 + 2000);
    await persistRunCases(other as never, 1, 40, [execution('pays', capture(basket([[51, 53]])))]);
    await storeRunCoverage(other as never, 40, 1, [
      { path: BASKET, runtime: 'server', blob: BLOB_B, executable: [[50, 70]] },
    ]);
    await storeRunCoverage(other as never, 41, 1, [
      { path: BASKET, runtime: 'server', blob: BLOB_B, executable: [[50, 80]] },
    ]);
    await storeRunCoverage(other as never, 42, 1, [
      { path: BASKET, runtime: 'server', blob: BLOB_A, executable: [[1, 9]] },
    ]);
    const coverage = await getFileCoverage(other as never, 1, 'BasketService.cs');
    // The version no fragment names is left out; the newest run's lines win for the one they do.
    expect(coverage.executable).toEqual([{ path: BASKET, runtime: 'server', blob: BLOB_B, lines: [[50, 80]] }]);
  });

  test('a branch reads its tests’ own coverage per runtime, the default branch’s for the rest', async () => {
    const onBranch = await getFileCoverage(db as never, 1, BASKET, 'feature/basket');
    expect(onBranch.branch).toBe('feature/basket');
    const named = onBranch.fragments.map((f) => [f.lines, f.tests.map((t) => onBranch.tests[t]!.title)]);
    expect(named).toEqual([
      [[[51, 53]], ['partly']],
      [[[60, 62]], ['pays']],
    ]);
    // `pays` recorded no browser coverage on the branch, so its default-branch browser coverage stands.
    const browser = await getFileCoverage(db as never, 1, CART, 'feature/basket');
    expect(browser.tests.map((t) => t.title)).toEqual(['browses', 'pays']);
  });
});

describe('run coverage', () => {
  let db: Db;

  beforeAll(async () => {
    db = await freshDb();
    await run(db, 30, 'main', T0);
  });

  test('cleans a request like a test’s coverage, and validates executable lines', () => {
    expect(parseRunCoverage({ files: [] })).toBeTypeOf('string');
    expect(parseRunCoverage({ v: 1, files: 'x' })).toBeTypeOf('string');
    expect(parseRunCoverage({ v: 1, files: Array.from({ length: 20_001 }, () => ({})) })).toBeTypeOf('string');
    expect(
      parseRunCoverage({
        v: 1,
        files: [
          { path: '../outside.cs', runtime: 'server', lines: [[1, 2]] },
          { path: 'src/A.cs', runtime: 'gpu' },
          {
            path: 'src\\A.cs',
            runtime: 'server',
            blob: 'not-a-blob',
            lines: [
              [5, 6],
              [1, 2],
              [3, 3],
              [0, 4],
            ],
            executable: [[1, 10], 'x', [12, 11]],
          },
          { path: 'src/A.cs', runtime: 'server', functions: [[1, 20]] },
          { path: 'src/B.cs', runtime: 'server', blob: BLOB_A, executable: [[4, 8]] },
        ],
      }),
    ).toEqual([
      {
        path: 'src/A.cs',
        runtime: 'server',
        functions: [[1, 20]],
        lines: [
          [1, 3],
          [5, 6],
        ],
        executable: [[1, 10]],
      },
      { path: 'src/B.cs', runtime: 'server', blob: BLOB_A, executable: [[4, 8]] },
    ]);
  });

  test('merges what each shard sends, per runtime and path', async () => {
    const first = parseRunCoverage({
      v: 1,
      files: [
        { path: 'src/A.cs', runtime: 'server', blob: BLOB_A, lines: [[1, 3]], executable: [[1, 10]] },
        { path: 'src/B.cs', runtime: 'server', blob: BLOB_A, lines: [[7, 7]] },
        { path: 'src/a.ts', runtime: 'browser', functions: [[1, 4]] },
      ],
    });
    const second = parseRunCoverage({
      v: 1,
      files: [
        { path: 'src/A.cs', runtime: 'server', blob: BLOB_A, lines: [[5, 6]], executable: [[12, 14]] },
        { path: 'src/B.cs', runtime: 'server', blob: BLOB_B, lines: [[9, 9]] },
      ],
    });
    expect(await storeRunCoverage(db as never, 30, 1, first as never)).toBe(3);
    expect(await storeRunCoverage(db as never, 30, 1, second as never)).toBe(2);
    const rows = await db
      .select()
      .from(schema.runCoverage)
      .where(eq(schema.runCoverage.runId, 30))
      .orderBy(schema.runCoverage.path);
    expect(rows.map((r) => [r.runtime, r.path, r.blob, r.functions, r.lines, r.executable])).toEqual([
      ['server', 'src/A.cs', BLOB_A, null, '1-3,5-6', '1-10,12-14'],
      // The shards disagree on the file version, so the blob goes.
      ['server', 'src/B.cs', null, null, '7,9', null],
      ['browser', 'src/a.ts', null, '1-4', null, null],
    ]);
  });
});

describe('code index and reach answers', () => {
  let db: Db;

  beforeAll(async () => {
    db = await freshDb();
    await run(db, 10, 'main', T0);
    await persistRunCases(db as never, 1, 10, [
      execution('pays', capture(basket([[51, 53]]), cart)),
      execution('lists', undefined, { codeReach: [CART] }),
    ]);
    // `lists` calls GET /api/basket, which the Test Map knows BasketService.cs handles; so does `pays`.
    const lists = String(await caseId(db, 'lists'));
    const pays = String(await caseId(db, 'pays'));
    await db.insert(schema.graphEdges).values([
      { projectId: 1, fromKind: 'test', fromKey: lists, toKind: 'route', toKey: 'GET /api/basket', kind: 'reaches' },
      { projectId: 1, fromKind: 'test', fromKey: pays, toKind: 'route', toKey: 'GET /api/basket', kind: 'reaches' },
      {
        projectId: 1,
        fromKind: 'route',
        fromKey: 'GET /api/basket',
        toKind: 'handler',
        toKey: BASKET,
        kind: 'handled-by',
      },
    ]);
  });

  test('each reach names its runtime and how it is known, with origin as before', async () => {
    const index = await getCodeIndex(db as never, 1);
    const named = index.reach.map((r) => ({
      file: index.files[r.file],
      tests: r.tests.map((t) => index.tests[t]!.title).sort(),
      runtime: r.runtime,
      via: r.via,
      origin: r.origin,
    }));
    expect(named).toEqual([
      { file: BASKET, tests: ['pays'], runtime: 'server', via: 'coverage', origin: 'server' },
      { file: BASKET, tests: ['lists', 'pays'], runtime: 'server', via: 'route', origin: 'server' },
      { file: CART, tests: ['lists', 'pays'], runtime: 'browser', via: 'coverage', origin: 'client' },
    ]);
  });

  test('a file’s reach lists each test once, measured coverage first', async () => {
    const reach = await getCodeReachForFile(db as never, 1, 'BasketService.cs');
    expect(reach.tests.map((t) => [t.title, t.runtime, t.via, t.origin])).toEqual([
      ['lists', 'server', 'route', 'server'],
      ['pays', 'server', 'coverage', 'server'],
    ]);
  });

  test('impact-from-diff and change coverage see the server files coverage recorded', async () => {
    await db.delete(schema.graphEdges);
    const impact = await resolveImpact(db as never, 1, [BASKET]);
    expect(impact.impact.widened).toBe(false);
    expect(impact.tests.map((t) => t.testCaseId)).toEqual([await caseId(db, 'pays')]);

    const change = await computeChangeCoverage(db as never, 1, {
      changedFiles: [
        { filePath: BASKET, additions: 3, deletions: 1 },
        { filePath: 'src/Web/Services/OrderService.cs', additions: 1, deletions: 0 },
      ],
    });
    expect(change.files.map((f) => [f.filePath, f.reachBasis, f.reachingTestCount])).toEqual([
      [BASKET, 'reached', 1],
      ['src/Web/Services/OrderService.cs', 'no-evidence', 0],
    ]);
  });
});

describe('coverage retention', () => {
  let db: Db;

  beforeAll(async () => {
    db = await freshDb();
  });

  test('a deleted run takes its run coverage and its executions’ unshared payloads', async () => {
    await run(db, 40, 'main', T0);
    await run(db, 41, 'main', T0 + HOUR);
    await persistRunCases(db as never, 1, 40, [execution('pays', capture(basket([[1, 2]])))]);
    await persistRunCases(db as never, 1, 41, [execution('pays', capture(basket([[3, 4]])))]);
    await storeRunCoverage(db as never, 40, 1, [{ path: BASKET, runtime: 'server', lines: [[1, 2]] }]);
    const doomed = (await executionOf(db, 40, 'pays')).coveragePayloadId!;

    await deleteRunsByIds(db as never, [40]);
    expect(await db.$count(schema.runCoverage, eq(schema.runCoverage.runId, 40))).toBe(0);
    expect(await db.$count(schema.casePayloads, eq(schema.casePayloads.id, doomed))).toBe(0);
  });

  test('keeps the fragments a test or a remaining execution can reference, and deletes the others', async () => {
    // Fragments [1, 2] (run 40, deleted) and [3, 4] (run 41, the test's coverage) exist.
    const byLines = async (lines: string) =>
      (
        await db
          .select({ id: schema.coverageFragments.id })
          .from(schema.coverageFragments)
          .where(eq(schema.coverageFragments.lines, lines))
      )[0]?.id;
    const old = (await byLines('1-2'))!;
    const current = (await byLines('3-4'))!;
    // Another fragment, last seen after the oldest remaining run was created: an execution may name it.
    const [recent] = await upsertCoverageFragments(db as never, 1, [capture(basket([[5, 6]])) as never]);
    const now = Date.now();
    await db
      .update(schema.testRuns)
      .set({ createdAt: new Date(now - 10 * HOUR) })
      .where(eq(schema.testRuns.projectId, 1));
    await db
      .update(schema.coverageFragments)
      .set({ lastSeenAt: new Date(now - 12 * HOUR) })
      .where(inArray(schema.coverageFragments.id, [old, current]));
    await db
      .update(schema.coverageFragments)
      .set({ lastSeenAt: new Date(now - 5 * HOUR) })
      .where(eq(schema.coverageFragments.id, recent![0]!.id));

    expect((await sweepOrphans(db as never)).coverageFragments).toBe(1);
    const left = (await db.select({ id: schema.coverageFragments.id }).from(schema.coverageFragments)).map((f) => f.id);
    expect(left.sort((a, b) => a - b)).toEqual([current, recent![0]!.id].sort((a, b) => a - b));
  });

  test('a project with no run left keeps no fragment nothing references', async () => {
    await db.insert(schema.projects).values({ id: 2, name: 'empty' });
    await upsertCoverageFragments(db as never, 2, [capture({ path: 'src/x.ts', runtime: 'browser' }) as never]);
    await db
      .update(schema.coverageFragments)
      .set({ lastSeenAt: new Date(Date.now() - 2 * HOUR) })
      .where(eq(schema.coverageFragments.projectId, 2));
    await sweepOrphans(db as never);
    expect(await db.$count(schema.coverageFragments, eq(schema.coverageFragments.projectId, 2))).toBe(0);
  });

  test('branch rows go thirty days after their last run, or when their branch closes', async () => {
    const now = new Date(T0 + 60 * DAY);
    await run(db, 50, 'feature/old', now.getTime() - 40 * DAY);
    await run(db, 51, 'feature/new', now.getTime() - DAY);
    await persistRunCases(db as never, 1, 50, [execution('pays', capture(basket([[7, 8]]), cart))]);
    await persistRunCases(db as never, 1, 51, [execution('pays', capture(basket([[9, 9]]), cart))]);
    const branches = async () => ({
      reach: [
        ...new Set((await db.select({ b: schema.codeReach.branch }).from(schema.codeReach)).map((r) => r.b)),
      ].sort(),
      coverage: [
        ...new Set((await db.select({ b: schema.testCoverage.branch }).from(schema.testCoverage)).map((r) => r.b)),
      ].sort(),
    });
    expect(await branches()).toEqual({
      reach: ['', 'feature/new', 'feature/old'],
      coverage: ['', 'feature/new', 'feature/old'],
    });

    expect(await pruneStaleBranchCoverageRows(db as never, now)).toBe(4);
    expect(await branches()).toEqual({ reach: ['', 'feature/new'], coverage: ['', 'feature/new'] });

    expect(await deleteBranchCoverageRows(db as never, 1, 'feature/new')).toBe(4);
    expect(await deleteBranchCoverageRows(db as never, 1, '')).toBe(0);
    expect(await branches()).toEqual({ reach: [''], coverage: [''] });
  });
});

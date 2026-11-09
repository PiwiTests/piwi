import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * Pass reuse plans against a migrated SQLite database, with executions ingested
 * through `persistRunCases` like a reporter's: a clean run at commit `c1` whose
 * tests each show one reason a test runs or is reused.
 */

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async readFile() {
      throw new Error('no file');
    },
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const reuse = await import('../../server/utils/pass-reuse');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

const HOUR = 3_600_000;
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const PW = '1.64.1';
const FINGERPRINT = { playwrightVersion: PW };

let db: TempDb;
let close: () => Promise<void>;

const file = (path: string) => ({ path, runtime: 'browser', blob: 'a'.repeat(40), functions: [[1, 9]] });

function execution(
  title: string,
  opts: { status?: 'passed' | 'failed'; files?: string[]; retries?: number; tags?: string[]; error?: boolean } = {},
) {
  return {
    title,
    filePath: 'tests/shop.spec.ts',
    status: opts.status ?? 'passed',
    ...(opts.status === 'failed' && opts.error !== false ? { error: 'Error: expect(received).toBe(expected)' } : {}),
    duration: 1_000,
    line: 1,
    column: 1,
    startedAt: Date.now(),
    workerIndex: 0,
    retries: opts.retries ?? 0,
    ...(opts.tags ? { tags: opts.tags } : {}),
    browser: { projectName: 'chromium', browserName: 'chromium' },
    ...(opts.files ? { coverage: { v: 1, files: opts.files.map(file) } } : {}),
  };
}

async function addRun(
  id: number,
  commit: string,
  worktree: 'clean' | 'dirty',
  cases: ReturnType<typeof execution>[],
  hoursAgo: number,
): Promise<void> {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: new Date(Date.now() - hoursAgo * HOUR),
    branch: 'main',
    origin: 'ci',
    commit,
    playwrightVersion: PW,
    metadata: {
      scm: { commit, branch: 'main', worktree },
      htmlReport: { rootDir: 'tests', serialFiles: [] },
      piwiOrigin: { kind: 'ci' },
    },
    totalTests: cases.length,
  });
  await persistRunCases(db as never, 1, id, cases);
}

async function idOf(title: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.testCases.id })
    .from(schema.testCases)
    .where(eq(schema.testCases.title, title));
  return row!.id;
}

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values([{ id: 1, name: 'shop', defaultBranch: 'main' }]);
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);

  // An older run in which `checks out` failed with no error, which forms no cluster: flaky within its last 20
  // executions. `refunds` failed with an error, which opened a failure cluster.
  await addRun(
    1,
    C3,
    'clean',
    [
      execution('checks out', { status: 'failed', error: false, files: ['src/checkout.ts'] }),
      execution('refunds', { status: 'failed', files: ['src/refund.ts'] }),
    ],
    30,
  );
  // The clean run at c1 every other test can reuse.
  await addRun(
    2,
    C1,
    'clean',
    [
      execution('adds to cart', { files: ['src/cart.ts'] }),
      execution('logs in', { files: ['src/auth.ts'] }),
      execution('checks out', { files: ['src/checkout.ts'] }),
      execution('browses', {}),
      execution('pays', { files: ['src/pay.ts'], tags: ['no-reuse'] }),
      execution('refunds', { files: ['src/refund.ts'] }),
    ],
    20,
  );
  // A dirty run at c2 is never a source, so `adds to cart` keeps its c1 pass.
  await addRun(3, C2, 'dirty', [execution('adds to cart', { files: ['src/cart.ts'] })], 10);
});

afterAll(async () => {
  await close();
});

describe('pass reuse plans', () => {
  test('a clean first-attempt pass with blob-carrying coverage is a source', async () => {
    const ids = await Promise.all(['adds to cart', 'logs in', 'browses'].map(idOf));
    const sources = await reuse.findReuseSources(db as never, 1, ids, FINGERPRINT);
    expect(sources.get(ids[0]!)).toMatchObject({ commit: C1, runId: 2, files: ['src/cart.ts'] });
    expect(sources.get(ids[1]!)).toMatchObject({ commit: C1, files: ['src/auth.ts'] });
    // No coverage: nothing vouches for its code.
    expect(sources.has(ids[2]!)).toBe(false);
  });

  test('another Playwright version, or an unknown one, finds no source', async () => {
    const id = await idOf('adds to cart');
    expect((await reuse.findReuseSources(db as never, 1, [id], { playwrightVersion: '1.50.0' })).size).toBe(0);
    expect((await reuse.findReuseSources(db as never, 1, [id], { playwrightVersion: null })).size).toBe(0);
  });

  test('a source names the Playwright projects it passed in', async () => {
    const id = await idOf('adds to cart');
    const sources = await reuse.findReuseSources(db as never, 1, [id], FINGERPRINT);
    expect(sources.get(id)?.projects).toEqual(['chromium']);
  });

  test('the sources step names the commits to diff', async () => {
    expect(await reuse.getPlanSourceCommits(db as never, 1, 'full', FINGERPRINT)).toEqual({
      candidates: 6,
      commits: [{ commit: C1, tests: 2 }],
    });
  });

  test('a change to a file one test ran reuses the others and gives each test its reason', async () => {
    const { plan } = await reuse.decideRunPlan(db as never, 1, 'full', FINGERPRINT, [
      { commit: C1, changedFiles: ['src/auth.ts'], changes: [] },
    ]);
    const cart = await idOf('adds to cart');
    expect(plan.reused).toEqual([expect.objectContaining({ testCaseId: cart, sourceCommit: C1, sourceRunId: 2 })]);
    expect(plan.run).toHaveLength(5);
    expect(plan.reasons).toEqual({
      reused: 1,
      changed: 1,
      flaky: 1,
      'open-cluster': 1,
      'no-source': 1,
      'no-reuse-tag': 1,
    });
  });

  test('a change that maps to no test runs every test whose source is at that commit', async () => {
    const { plan } = await reuse.decideRunPlan(db as never, 1, 'full', FINGERPRINT, [
      { commit: C1, changedFiles: ['package-lock.json'], changes: [] },
    ]);
    expect(plan.reused).toEqual([]);
    expect(plan.reasons).toMatchObject({ widened: 2 });
  });

  test('a source commit without a diff runs its tests', async () => {
    const { plan } = await reuse.decideRunPlan(db as never, 1, 'full', FINGERPRINT, []);
    expect(plan.reused).toEqual([]);
    expect(plan.reasons).toMatchObject({ 'commit-unavailable': 2 });
  });

  test('no change at all reuses every test with a source', async () => {
    const { plan } = await reuse.decideRunPlan(db as never, 1, 'full', FINGERPRINT, [
      { commit: C1, changedFiles: [], changes: [] },
    ]);
    expect(plan.reasons).toMatchObject({ reused: 2 });
  });

  test('a plan skips each reused test by its test list line, in the projects its source ran, and runs the rest', async () => {
    const { plan } = await reuse.decideRunPlan(db as never, 1, 'full', FINGERPRINT, [
      { commit: C1, changedFiles: ['src/auth.ts'], changes: [] },
    ]);
    expect(plan.args).toEqual([]);
    expect(plan.reused[0]).toMatchObject({
      projects: ['chromium'],
      skip: ['[chromium] › shop.spec.ts › adds to cart'],
    });
  });

  test('a test of a spec file holding a serial group always runs', async () => {
    await db
      .update(schema.testRuns)
      .set({
        metadata: {
          scm: { commit: C1, branch: 'main', worktree: 'clean' },
          htmlReport: { rootDir: 'tests', serialFiles: ['tests/shop.spec.ts'] },
          piwiOrigin: { kind: 'ci' },
        },
      })
      .where(eq(schema.testRuns.id, 2));
    try {
      const { plan } = await reuse.decideRunPlan(db as never, 1, 'full', FINGERPRINT, [
        { commit: C1, changedFiles: [], changes: [] },
      ]);
      expect(plan.reused).toEqual([]);
      expect(plan.reasons).toMatchObject({ serial: 2 });
    } finally {
      await db
        .update(schema.testRuns)
        .set({
          metadata: {
            scm: { commit: C1, branch: 'main', worktree: 'clean' },
            htmlReport: { rootDir: 'tests', serialFiles: [] },
            piwiOrigin: { kind: 'ci' },
          },
        })
        .where(eq(schema.testRuns.id, 2));
    }
  });

  test('a stored plan reads back until it expires, in its own project only', async () => {
    const { plan } = await reuse.decideRunPlan(db as never, 1, 'full', FINGERPRINT, []);
    const now = new Date();
    const { id } = await reuse.storeRunPlan(db as never, 1, plan, { commit: C1, branch: 'main', createdBy: null }, now);
    expect((await reuse.getRunPlan(db as never, 1, id, now))?.plan.run).toEqual(plan.run);
    expect(await reuse.getRunPlan(db as never, 2, id, now)).toBeNull();
    expect(await reuse.getRunPlan(db as never, 1, id, new Date(now.getTime() + 25 * HOUR))).toBeNull();
  });

  test('skip lines name the describes, and a name a test list cannot state is never reused', () => {
    const test = (title: string, suitePath = '') => ({
      testCaseId: 1,
      filePath: './tests/a.spec.ts',
      suitePath,
      title,
      line: 1,
      avgDurationMs: null,
      locks: [],
    });
    expect(reuse.skipLines(test('pays', 'Cart\x1fCheckout'), ['chromium', 'firefox'], 'tests')).toEqual([
      '[chromium] › a.spec.ts › Cart › Checkout › pays',
      '[firefox] › a.spec.ts › Cart › Checkout › pays',
    ]);
    expect(reuse.skipLines(test('pays'), ['chromium'], '')).toEqual(['[chromium] › tests/a.spec.ts › pays']);
    const plain = { ...test('refunds'), testCaseId: 1 };
    const arrow = { ...test('a > b'), testCaseId: 2 };
    const shadowing = { ...test('Cart'), testCaseId: 3 };
    const inside = { ...test('pays', 'Cart'), testCaseId: 4 };
    const padded = { ...test('refunds '), testCaseId: 5 };
    expect([...reuse.unnameable([plain, arrow, shadowing, inside, padded])].sort()).toEqual([2, 3, 5]);
  });

  test('a finished run records the tests its plan skipped and it did not execute, once', async () => {
    const { plan } = await reuse.decideRunPlan(
      db as never,
      1,
      'full',
      FINGERPRINT,
      [{ commit: C1, changedFiles: ['src/auth.ts'], changes: [] }],
      new Date(),
      'clean',
    );
    const { id: planId } = await reuse.storeRunPlan(db as never, 1, plan, {
      commit: C1,
      branch: 'main',
      createdBy: null,
    });
    const cart = await idOf('adds to cart');
    const metadata = (commit: string) => ({ scm: { commit }, piwiPlan: { id: planId }, piwiOrigin: { kind: 'ci' } });

    // Run 10 at the plan's commit executed `logs in`, not the reused `adds to cart`.
    await db.insert(schema.testRuns).values({
      id: 10,
      projectId: 1,
      status: 'passed',
      startTime: new Date(),
      origin: 'ci',
      commit: C1,
      metadata: metadata(C1),
      totalTests: 1,
    });
    await persistRunCases(db as never, 1, 10, [execution('logs in', { files: ['src/auth.ts'] })]);
    expect(await reuse.attachRunPlan(db as never, 10, { projectId: 1, metadata: metadata(C1) })).toBe(1);
    expect(await reuse.attachRunPlan(db as never, 10, { projectId: 1, metadata: metadata(C1) })).toBe(1);
    const rows = await db.select().from(schema.reusedResults).where(eq(schema.reusedResults.runId, 10));
    expect(rows).toEqual([
      expect.objectContaining({ testCaseId: cart, projects: ['chromium'], sourceCommit: C1, sourceRunId: 2, planId }),
    ]);
    const [run] = await db
      .select({ reusedCount: schema.testRuns.reusedCount })
      .from(schema.testRuns)
      .where(eq(schema.testRuns.id, 10));
    expect(run!.reusedCount).toBe(1);

    // Run 11 executed the reused test anyway, and run 12 is at another commit: neither records it.
    for (const [id, commit, cases] of [
      [11, C1, [execution('adds to cart', { files: ['src/cart.ts'] })]],
      [12, C2, []],
    ] as const) {
      await db.insert(schema.testRuns).values({
        id,
        projectId: 1,
        status: 'passed',
        startTime: new Date(),
        origin: 'ci',
        commit,
        metadata: metadata(commit),
        totalTests: cases.length,
      });
      if (cases.length) await persistRunCases(db as never, 1, id, [...cases]);
      expect(await reuse.attachRunPlan(db as never, id, { projectId: 1, metadata: metadata(commit) })).toBe(0);
    }
    // A run of another project cannot claim the plan.
    expect(await reuse.attachRunPlan(db as never, 10, { projectId: 2, metadata: metadata(C1) })).toBe(0);
  });

  test('an unknown selection is a 404', async () => {
    await expect(reuse.decideRunPlan(db as never, 1, 'nope', FINGERPRINT, [])).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

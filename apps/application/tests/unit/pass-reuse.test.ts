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
    metadata: { scm: { commit, branch: 'main', worktree }, playwrightVersion: PW, piwiOrigin: { kind: 'ci' } },
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

  test('another Playwright version finds no source', async () => {
    const id = await idOf('adds to cart');
    const sources = await reuse.findReuseSources(db as never, 1, [id], { playwrightVersion: '1.50.0' });
    expect(sources.size).toBe(0);
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

  test('a stored plan reads back until it expires, and materializes only the tests to run', async () => {
    const { plan } = await reuse.decideRunPlan(db as never, 1, 'full', FINGERPRINT, [
      { commit: C1, changedFiles: ['src/auth.ts'], changes: [] },
    ]);
    const now = new Date();
    const { id } = await reuse.storeRunPlan(db as never, 1, plan, { commit: C1, branch: 'main', createdBy: null }, now);
    const stored = await reuse.getRunPlan(db as never, 1, id, now);
    expect(stored?.plan.run).toEqual(plan.run);
    expect(await reuse.getRunPlan(db as never, 2, id, now)).toBeNull();
    expect(await reuse.getRunPlan(db as never, 1, id, new Date(now.getTime() + 25 * HOUR))).toBeNull();

    const resolution = await reuse.materializePlan(db as never, 1, stored!.plan);
    expect(resolution?.tests.map((t) => t.testCaseId).sort()).toEqual([...plan.run].sort());
    expect(await reuse.materializePlan(db as never, 1, { ...plan, run: [] })).toBeNull();
  });

  test('an unknown selection is a 404', async () => {
    await expect(reuse.decideRunPlan(db as never, 1, 'nope', FINGERPRINT, [])).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

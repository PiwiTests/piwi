import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The reporter's balanced shards against a migrated SQLite database, with executions ingested through
 * `persistRunCases` like a reporter's: each listed test weighs its recorded duration in its Playwright project, and
 * the split of one listing is stored, so every shard reads the same one.
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

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set, so clear it before the modules under
// test load.
delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const split = await import('../../server/utils/shard-split');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

const HOUR = 3_600_000;
const COMMIT = 'c'.repeat(40);
const FILE = 'tests/shop.spec.ts';

let db: TempDb;
let close: () => Promise<void>;

function execution(title: string, project: string, duration: number, status: 'passed' | 'skipped' = 'passed') {
  return {
    title,
    filePath: FILE,
    status,
    duration,
    line: 1,
    column: 1,
    startedAt: Date.now(),
    workerIndex: 0,
    retries: 0,
    browser: { projectName: project, browserName: project },
  };
}

async function addRun(id: number, cases: ReturnType<typeof execution>[], hoursAgo: number): Promise<void> {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: new Date(Date.now() - hoursAgo * HOUR),
    branch: 'main',
    origin: 'ci',
    commit: COMMIT,
    playwrightVersion: '1.65.1',
    metadata: { scm: { commit: COMMIT, branch: 'main' }, piwiOrigin: { kind: 'ci' } },
    totalTests: cases.length,
  });
  await persistRunCases(db as never, 1, id, cases);
}

/** A listed test, as the reporter sends it. */
function listed(title: string, project: string, extra: Partial<Record<string, unknown>> = {}) {
  return { project, file: FILE, suitePath: [], title, ...extra };
}

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values([{ id: 1, name: 'shop', defaultBranch: 'main' }]);
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
  await addRun(
    1,
    [
      execution('checks out', 'chromium', 9_000),
      execution('checks out', 'firefox', 3_000),
      execution('adds to cart', 'chromium', 4_000),
      execution('logs in', 'chromium', 1_000),
      // A skipped result says nothing of how long the test runs.
      execution('browses', 'chromium', 0, 'skipped'),
    ],
    2,
  );
});

afterAll(async () => {
  await close();
});

describe('a shard split request', () => {
  test('needs a shard count of 2 or more and a listing of named tests', () => {
    const tests = [listed('logs in', 'chromium')];
    expect(() => split.parseShardSplitRequest({ shardTotal: 1, tests })).toThrow(/shardTotal/);
    expect(() => split.parseShardSplitRequest({ shardTotal: 2, tests: [] })).toThrow(/tests/);
    expect(() => split.parseShardSplitRequest({ shardTotal: 2, tests: [{ title: 'x' }] })).toThrow(/file and title/);
    expect(split.parseShardSplitRequest({ shardTotal: 2, commit: 'not a commit', tests })).toMatchObject({
      commit: '',
      shardTotal: 2,
      tests: [{ project: 'chromium', repeatEachIndex: 0, locks: [], group: null, skipped: false }],
    });
  });
});

describe('the split of a listing', () => {
  test('weighs each test by its duration in its project, else in every project, and a skipped test at nothing', async () => {
    const request = split.parseShardSplitRequest({
      commit: COMMIT,
      shardTotal: 2,
      tests: [
        listed('checks out', 'chromium'),
        listed('checks out', 'firefox'),
        // No result in webkit: the test's average over its projects, (9000 + 3000) / 2.
        listed('checks out', 'webkit'),
        listed('adds to cart', 'chromium'),
        listed('logs in', 'chromium', { skipped: true }),
        // Never ran, or only skipped: the median of the others (5000), which records no duration.
        listed('is new', 'chromium'),
        listed('browses', 'chromium'),
      ],
    });
    const result = await split.computeShardSplit(db as never, 1, request);
    expect(result.shards).toHaveLength(7);
    for (const shard of result.shards) expect([1, 2]).toContain(shard);
    expect(result.durationsMs.reduce((a, b) => a + b, 0)).toBe(9_000 + 3_000 + 6_000 + 4_000);
    // Heaviest first, each onto the lighter shard: 9000 → 1, 6000 → 2, 5000 → 2, 5000 → 1, 4000 → 2, 3000 → 1.
    expect(result.durationsMs).toEqual([9_000 + 3_000, 6_000 + 4_000]);
    expect(result.shards[4]).toBe(2);
  });

  test('keeps the tests of a group, and the holders of a lock, in one shard', async () => {
    const tests = [
      listed('checks out', 'chromium', { group: 0 }),
      listed('adds to cart', 'chromium', { group: 0 }),
      listed('checks out', 'firefox', { locks: ['db'] }),
      listed('logs in', 'chromium', { locks: ['db'] }),
      listed('is new', 'chromium'),
      listed('is newer', 'chromium'),
    ];
    const { shards } = await split.computeShardSplit(
      db as never,
      1,
      split.parseShardSplitRequest({ shardTotal: 3, tests }),
    );
    expect(shards[0]).toBe(shards[1]);
    expect(shards[2]).toBe(shards[3]);
    expect(new Set(shards).size).toBe(3);
  });

  test('is stored: every shard that lists the same tests at the same commit reads the first answer', async () => {
    const now = new Date();
    const tests = [listed('checks out', 'chromium'), listed('adds to cart', 'chromium'), listed('logs in', 'chromium')];
    const request = split.parseShardSplitRequest({ commit: COMMIT, shardTotal: 2, tests });
    const first = await split.getShardSplit(db as never, 1, request, now);
    expect(first!.shards).toEqual([1, 2, 2]);

    // A run lands between two shards' start, after which `logs in` is the longest test.
    await addRun(2, [execution('logs in', 'chromium', 40_000)], 1);
    const second = await split.getShardSplit(db as never, 1, request, new Date(now.getTime() + HOUR));
    expect(second!.shards).toEqual(first!.shards);
    const rows = await db.select().from(schema.shardSplits).where(eq(schema.shardSplits.projectId, 1));
    expect(rows).toHaveLength(1);

    // Another commit is another split, read with the new durations: `logs in` now averages 20500 ms.
    const other = split.parseShardSplitRequest({ commit: 'd'.repeat(40), shardTotal: 2, tests });
    expect((await split.getShardSplit(db as never, 1, other, now))!.shards).toEqual([2, 2, 1]);
  });

  test('expires after a day, and a stored one is deleted once expired', async () => {
    const tests = [listed('checks out', 'chromium'), listed('logs in', 'chromium')];
    const request = split.parseShardSplitRequest({ commit: 'e'.repeat(40), shardTotal: 2, tests });
    const now = new Date();
    const stored = await split.getShardSplit(db as never, 1, request, now);
    // SQLite keeps the second.
    expect(Math.floor(stored!.expiresAt.getTime() / 1000)).toBe(
      Math.floor((now.getTime() + split.SHARD_SPLIT_TTL_MS) / 1000),
    );

    const later = new Date(now.getTime() + split.SHARD_SPLIT_TTL_MS + HOUR);
    const other = split.parseShardSplitRequest({ commit: 'f'.repeat(40), shardTotal: 2, tests });
    await split.getShardSplit(db as never, 1, other, later);
    const commits = (await db.select({ commit: schema.shardSplits.commitSha }).from(schema.shardSplits)).map(
      (row) => row.commit,
    );
    expect(commits).toEqual(['f'.repeat(40)]);
  });

  test('keys a listing by every field of each test, in its order', async () => {
    const a = split.parseShardSplitRequest({ shardTotal: 2, tests: [listed('a', 'p'), listed('b', 'p')] }).tests;
    const b = split.parseShardSplitRequest({ shardTotal: 2, tests: [listed('b', 'p'), listed('a', 'p')] }).tests;
    const c = split.parseShardSplitRequest({
      shardTotal: 2,
      tests: [listed('a', 'p', { skipped: true }), listed('b', 'p')],
    }).tests;
    const hashes = await Promise.all([a, b, c].map(split.shardListingHash));
    expect(new Set(hashes).size).toBe(3);
  });

  test('answers nothing for a project that does not exist', async () => {
    const request = split.parseShardSplitRequest({ shardTotal: 2, tests: [listed('a', 'p')] });
    expect(await split.getShardSplit(db as never, 99, request)).toBeNull();
  });
});

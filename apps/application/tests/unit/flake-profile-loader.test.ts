import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the handler.
delete process.env.PIWI_DATABASE_URL;
const { getFlakeProfile, mayHaveFlakeSuspects } = await import('../../shared/handlers/flake-profile');
const { runOrigin } = await import('../../shared/run-eligibility');

let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date('2026-09-28T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const FLAKY = 1;
const NEIGHBOR = 2;
const PREVIOUS = 3;
const FAR = 4;

/**
 * Twelve runs of the flaky test (case 1), one attempt each. In runs 1–4 it
 * fails: `GET /api/cart` takes 2 s, the neighbor (case 2) overlaps it on
 * another shard, and case 3 ran just before it on its worker. In runs 5–12
 * it passes with a fast cart, case 3 runs before it on another worker, and
 * the neighbor runs after it. A probe run, a flake-lab run, a run on a feature
 * branch and a run older than the window fail too, and must be left out.
 */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);

  await db.insert(schema.projects).values([{ id: 1, name: 'Shop', defaultBranch: 'main' }]);
  await db.insert(schema.testCases).values([
    { id: FLAKY, projectId: 1, title: 'pays with a saved card', filePath: 'checkout.spec.ts' },
    { id: NEIGHBOR, projectId: 1, title: 'resets catalog', filePath: 'admin.spec.ts' },
    { id: PREVIOUS, projectId: 1, title: 'seeds the cart', filePath: 'cart.spec.ts' },
    { id: FAR, projectId: 1, title: 'unrelated', filePath: 'other.spec.ts' },
  ]);

  const runs: Array<typeof schema.testRuns.$inferInsert> = [];
  const executions: Array<typeof schema.testRunsCases.$inferInsert & { id: number }> = [];
  const requests: Array<typeof schema.networkRequests.$inferInsert> = [];
  let executionId = 1;
  const exec = (row: Omit<typeof schema.testRunsCases.$inferInsert, 'id'>) => {
    const id = executionId++;
    executions.push({ id, browserName: 'chromium', ...row });
    return id;
  };

  const addRun = (
    id: number,
    opts: { fails: boolean; ageDays: number; branch?: string; probe?: boolean; lab?: boolean },
  ) => {
    const start = NOW.getTime() - opts.ageDays * DAY;
    const metadata = opts.probe
      ? { piwiProbe: true }
      : opts.lab
        ? { piwiFlakeLab: { experimentId: 'exp-1', armId: 'delay-cart' } }
        : null;
    runs.push({
      id,
      projectId: 1,
      status: opts.fails ? 'failed' : 'passed',
      startTime: new Date(start),
      duration: 600_000,
      branch: opts.branch ?? 'main',
      environment: 'staging',
      metadata,
      origin: runOrigin(metadata),
    });
    const created = new Date(start);
    if (opts.fails) {
      exec({
        testRunId: id,
        testCaseId: PREVIOUS,
        status: 'passed',
        startedAt: start,
        duration: 4_000,
        workerIndex: 0,
        shardIndex: 1,
        createdAt: created,
      });
      const flaky = exec({
        testRunId: id,
        testCaseId: FLAKY,
        status: 'failed',
        startedAt: start + 5_000,
        duration: 6_000,
        workerIndex: 0,
        shardIndex: 1,
        createdAt: created,
      });
      const neighbor = exec({
        testRunId: id,
        testCaseId: NEIGHBOR,
        status: 'passed',
        startedAt: start + 7_000,
        duration: 3_000,
        workerIndex: 0,
        shardIndex: 2,
        createdAt: created,
      });
      requests.push(
        {
          testRunsCaseId: flaky,
          testRunId: id,
          method: 'GET',
          url: 'https://shop.test/api/cart',
          status: 200,
          duration: 2_000,
        },
        {
          testRunsCaseId: flaky,
          testRunId: id,
          method: 'POST',
          url: 'https://shop.test/api/products',
          status: 201,
          duration: 90,
        },
        {
          testRunsCaseId: neighbor,
          testRunId: id,
          method: 'PUT',
          url: 'https://shop.test/api/products/12',
          status: 200,
          duration: 80,
        },
        {
          testRunsCaseId: neighbor,
          testRunId: id,
          method: 'POST',
          url: 'https://shop.test/api/products',
          status: 200,
          duration: 80,
        },
      );
    } else {
      exec({
        testRunId: id,
        testCaseId: PREVIOUS,
        status: 'passed',
        startedAt: start,
        duration: 4_000,
        workerIndex: 1,
        shardIndex: 1,
        createdAt: created,
      });
      exec({
        testRunId: id,
        testCaseId: FAR,
        status: 'passed',
        startedAt: start,
        duration: 4_000,
        workerIndex: 0,
        shardIndex: 1,
        createdAt: created,
      });
      const flaky = exec({
        testRunId: id,
        testCaseId: FLAKY,
        status: 'passed',
        startedAt: start + 5_000,
        duration: 5_000,
        workerIndex: 0,
        shardIndex: 1,
        createdAt: created,
      });
      exec({
        testRunId: id,
        testCaseId: NEIGHBOR,
        status: 'passed',
        startedAt: start + 20_000,
        duration: 3_000,
        workerIndex: 0,
        shardIndex: 2,
        createdAt: created,
      });
      requests.push({
        testRunsCaseId: flaky,
        testRunId: id,
        method: 'GET',
        url: 'https://shop.test/api/cart',
        status: 200,
        duration: 150,
      });
    }
  };

  for (let i = 1; i <= 4; i++) addRun(i, { fails: true, ageDays: i });
  for (let i = 5; i <= 12; i++) addRun(i, { fails: false, ageDays: i });
  addRun(13, { fails: true, ageDays: 1, probe: true });
  addRun(14, { fails: true, ageDays: 1, branch: 'feature/x' });
  addRun(15, { fails: true, ageDays: 40 });
  addRun(16, { fails: true, ageDays: 1, lab: true });

  // A run started with run 1, whose execution on a worker and shard of the same
  // numbers starts between case 3 and the flaky attempt: it ran in another run,
  // so it is never the attempt's predecessor.
  const concurrentStart = NOW.getTime() - DAY;
  runs.push({
    id: 17,
    projectId: 1,
    status: 'passed',
    startTime: new Date(concurrentStart),
    duration: 600_000,
    branch: 'main',
    environment: 'staging',
    metadata: null,
  });
  exec({
    testRunId: 17,
    testCaseId: FAR,
    status: 'passed',
    startedAt: concurrentStart + 4_500,
    duration: 300,
    workerIndex: 0,
    shardIndex: 1,
    createdAt: new Date(concurrentStart),
  });

  await db.insert(schema.testRuns).values(runs);
  await db.insert(schema.testRunsCases).values(executions);
  await db.insert(schema.networkRequests).values(requests);
});

describe('getFlakeProfile', () => {
  test('reads the window the flaky leaderboard reads', async () => {
    const profile = (await getFlakeProfile(db as never, FLAKY, { now: NOW }))!;
    // Runs 1–12 only: the probe run, the flake-lab run, the feature branch and the 40-day-old run are left out.
    expect(profile.failures).toBe(4);
    expect(profile.passes).toBe(8);
  });

  test('finds the slow route, the neighbor alongside and the test before, from SQL', async () => {
    const profile = (await getFlakeProfile(db as never, FLAKY, { now: NOW }))!;
    const byKind = Object.fromEntries(profile.suspects.map((s) => [s.kind, s]));

    expect(byKind['slow-route']).toMatchObject({
      route: 'GET /api/cart',
      thresholdMs: 2_000,
      counts: { failuresWith: 4, failures: 4, passesWith: 0, passes: 8 },
    });
    expect(byKind.alongside).toMatchObject({
      testCaseId: NEIGHBOR,
      title: 'resets catalog',
      approximate: true,
      sharedRoutes: ['/api/products'],
      counts: { failuresWith: 4, failures: 4, passesWith: 0, passes: 8 },
    });
    expect(byKind.before).toMatchObject({
      testCaseId: PREVIOUS,
      title: 'seeds the cart',
      counts: { failuresWith: 4, failures: 4, passesWith: 0, passes: 8 },
    });
  });

  test('the summary view leaves out the shared routes', async () => {
    const profile = (await getFlakeProfile(db as never, FLAKY, { now: NOW, summary: true }))!;
    const alongside = profile.suspects.find((s) => s.kind === 'alongside')!;
    expect(alongside.title).toBe('resets catalog');
    expect(alongside.sharedRoutes).toEqual([]);
  });

  test('an unknown test case has no profile', async () => {
    expect(await getFlakeProfile(db as never, 999, { now: NOW })).toBeNull();
  });
});

describe('mayHaveFlakeSuspects', () => {
  const ONLY_FAILS = 5;
  const TWICE = 6;

  beforeAll(async () => {
    await db.insert(schema.testCases).values([
      { id: ONLY_FAILS, projectId: 1, title: 'always fails', filePath: 'broken.spec.ts' },
      { id: TWICE, projectId: 1, title: 'failed twice', filePath: 'rare.spec.ts' },
    ]);
    const attempt = (testRunId: number, testCaseId: number, status: string) => ({
      testRunId,
      testCaseId,
      status,
      duration: 1_000,
      createdAt: new Date(NOW.getTime() - (testRunId === 15 ? 40 : 1) * DAY),
    });
    await db.insert(schema.testRunsCases).values([
      // Fails in every run of the window: no pass to compare with.
      ...[1, 2, 3, 4].map((run) => attempt(run, ONLY_FAILS, 'failed')),
      // Fails twice in the window; the probe run, the flake-lab run, the feature
      // branch and the old run would make it six, but the profile does not read them.
      ...[1, 2].map((run) => attempt(run, TWICE, 'failed')),
      ...[5, 6, 7, 8].map((run) => attempt(run, TWICE, 'passed')),
      ...[13, 14, 15, 16].map((run) => attempt(run, TWICE, 'timedOut')),
    ]);
  });

  test('says yes when the window holds 3 failures and a pass', async () => {
    expect(await mayHaveFlakeSuspects(db as never, FLAKY, { now: NOW })).toBe(true);
  });

  test('says no, as the profile finds, without a pass or with fewer than 3 failures in the window', async () => {
    for (const id of [ONLY_FAILS, TWICE, NEIGHBOR]) {
      expect(await mayHaveFlakeSuspects(db as never, id, { now: NOW })).toBe(false);
      expect((await getFlakeProfile(db as never, id, { now: NOW }))!.suspects).toEqual([]);
    }
  });

  test('says no for an unknown test case', async () => {
    expect(await mayHaveFlakeSuspects(db as never, 999, { now: NOW })).toBe(false);
  });
});

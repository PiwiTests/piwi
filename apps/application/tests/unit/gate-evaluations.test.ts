import { describe, test, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { ScmCommitStatus, ScmEntityState } from '../../server/utils/scm/ScmProvider';

/**
 * Gate evaluations against an in-memory SQLite database: what each evaluation
 * stores, the opt-in `/gate` commit status, the pull-request feedback record,
 * and the sweep that reads the pull request's final state and counts overrides
 * and escapes.
 */

const scm = vi.hoisted(() => ({
  /** What the SCM reports per PR number; unlisted numbers are open. */
  prs: {} as Record<number, { state: ScmEntityState; updatedAt?: string | null } | 'throw'>,
  lookups: [] as number[],
  statuses: [] as Array<{ sha: string; status: ScmCommitStatus }>,
}));

vi.mock('../../server/utils/scm', () => ({
  resolveScmToken: async () => 'token',
  scmProviderForUrl: () => null,
  createScmProvider: async (url: string) =>
    url.includes('unsupported')
      ? null
      : {
          async fetchPullRequest(number: number) {
            scm.lookups.push(number);
            const pr = scm.prs[number] ?? { state: 'open' };
            if (pr === 'throw') throw new Error('SCM exploded');
            return { title: null, state: pr.state, author: null, url: null, updatedAt: pr.updatedAt ?? null };
          },
          async postCommitStatus(sha: string, status: ScmCommitStatus) {
            scm.statuses.push({ sha, status });
            return true;
          },
          async getDefaultBranch() {
            return null;
          },
        },
}));

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { recordGateEvaluation, postGateCommitStatus, gatePolicyHash, gateSource } =
  await import('../../server/utils/gate-evaluations');
const { refreshGatePullRequests } = await import('../../server/utils/gate-overrides');
const { recordPrFeedbackPost, readPrFeedbackPost } = await import('../../server/utils/scm/pr-feedback-posts');
const { listOutcomes, readOutcomeCounts } = await import('../../server/utils/outcomes');
const { setAppSetting } = await import('../../server/utils/app-settings');
const { getSetupStatus, getCapabilityEvidence } = await import('../../shared/handlers/setup-status');
const { runOrigin } = await import('../../shared/run-eligibility');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let runSeq = 0;

const T0 = Date.UTC(2026, 5, 1);
const HOUR = 3_600_000;
const REPO = 'https://github.com/acme/shop';

const FAILED = {
  passed: false,
  verdict: 'failed' as const,
  violations: [{ rule: 'max-new-regressions' as const, message: '1 new regression (limit 0)', actual: 1, limit: 0 }],
};
const PASSED = { passed: true, verdict: 'passed' as const, violations: [] };
const INCONCLUSIVE = { passed: false, verdict: 'inconclusive' as const, violations: [] };

interface RunSeed {
  branch?: string;
  prNumber?: number | null;
  startTime?: Date;
  origin?: string;
  incident?: boolean;
  repositoryUrl?: string;
  /** Cluster ids this run fails in. */
  failsIn?: number[];
}

async function insertRun(seed: RunSeed = {}): Promise<number> {
  const id = ++runSeq;
  const branch = seed.branch ?? 'feature/x';
  const metadata = {
    scm: {
      commit: `c${id}`,
      branch,
      remoteUrl: seed.repositoryUrl ?? REPO,
      ...(seed.prNumber != null ? { prNumber: seed.prNumber } : {}),
    },
    ...(seed.origin ? { piwiOrigin: { kind: seed.origin } } : {}),
    ...(seed.incident ? { incident: { rule: 'connection-refused', reason: 'staging refused', host: 'staging' } } : {}),
  };
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: seed.failsIn?.length ? 'failed' : 'passed',
    startTime: seed.startTime ?? new Date(T0 + id * HOUR),
    branch,
    metadata,
    origin: runOrigin(metadata),
  });
  for (const clusterId of seed.failsIn ?? []) {
    await db.insert(schema.testRunsCases).values({
      testRunId: id,
      testCaseId: 1,
      status: 'failed',
      duration: 1,
      failureClusterId: clusterId,
    });
  }
  return id;
}

async function evaluate(
  runId: number,
  result: typeof FAILED | typeof PASSED | typeof INCONCLUSIVE,
  opts: { clusterIds?: number[]; at?: Date } = {},
) {
  const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
  return recordGateEvaluation(db as never, {
    projectId: 1,
    runId,
    runMetadata: run!.metadata,
    policy: { maxNewRegressions: 0 },
    result,
    source: 'cli',
    clusterIds: opts.clusterIds ?? [],
    evaluatedAt: opts.at ?? new Date(run!.startTime.getTime() + 60_000),
  });
}

async function evaluationRow(id: number) {
  const [row] = await db.select().from(schema.gateEvaluations).where(eq(schema.gateEvaluations.id, id));
  return row!;
}

async function gateOutcomes() {
  return (await listOutcomes(db as never, { kind: 'gate' })).map((o) => ({
    subjectId: o.subjectId,
    outcome: o.outcome,
    runId: o.runId,
  }));
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds to cart' });
  await db.insert(schema.testRuns).values({ id: 999, projectId: 1, status: 'failed', startTime: new Date(T0) });
  for (const id of [7, 8]) {
    await db.insert(schema.failureClusters).values({
      id,
      projectId: 1,
      firstSeenRunId: 999,
      lastSeenRunId: 999,
      fingerprint: `fp${id}`,
      signature: `cluster ${id}`,
    });
  }
  runSeq = 0;
  scm.prs = {};
  scm.lookups = [];
  scm.statuses = [];
  delete process.env.PIWI_SITE_URL;
});

describe('storing an evaluation', () => {
  test('stores the verdict, the policy and its hash, and the pull request, and records the failed gate', async () => {
    const run = await insertRun({ prNumber: 42 });
    const stored = await evaluate(run, FAILED, { clusterIds: [8, 7, 7] });

    const row = await evaluationRow(stored.id);
    expect(row).toMatchObject({
      runId: run,
      commitSha: `c${run}`,
      prNumber: 42,
      passed: false,
      verdict: 'failed',
      source: 'cli',
      policy: { maxNewRegressions: 0 },
      policyHash: gatePolicyHash({ maxNewRegressions: 0 }),
      clusterIds: [7, 8],
      prState: null,
      overridden: false,
    });
    expect(row.violations).toEqual(FAILED.violations);
    expect(await gateOutcomes()).toEqual([{ subjectId: stored.id, outcome: 'suggested', runId: run }]);
  });

  test('stores an inconclusive verdict without recording an outcome', async () => {
    const run = await insertRun({ prNumber: 42, incident: true });
    const stored = await evaluate(run, INCONCLUSIVE);
    expect(await evaluationRow(stored.id)).toMatchObject({ verdict: 'inconclusive', passed: false });
    expect(await gateOutcomes()).toEqual([]);
  });

  test('a passing verdict records no outcome', async () => {
    const stored = await evaluate(await insertRun({ prNumber: 42 }), PASSED);
    expect(await evaluationRow(stored.id)).toMatchObject({ verdict: 'passed', passed: true });
    expect(await gateOutcomes()).toEqual([]);
  });

  test('takes the pull request from the feedback record when the CI provider named none', async () => {
    const run = await insertRun();
    await recordPrFeedbackPost(db as never, { projectId: 1, runId: run, repositoryUrl: REPO, prNumber: 9 });
    expect((await evaluate(run, FAILED)).prNumber).toBe(9);
  });

  test('the policy hash ignores key order and rules left off', () => {
    expect(gatePolicyHash({ maxFailed: 0, requireTags: ['smoke'] })).toBe(
      gatePolicyHash({ requireTags: ['smoke'], maxFailed: 0, failOnFlaky: false, maxLeaks: undefined }),
    );
    expect(gatePolicyHash({ maxFailed: 0 })).not.toBe(gatePolicyHash({ maxFailed: 1 }));
  });

  test('the source is `cli` only for `piwi gate`', () => {
    expect(gateSource('cli')).toBe('cli');
    expect(gateSource(undefined)).toBe('api');
    expect(gateSource('curl')).toBe('api');
  });
});

describe('the gate commit status', () => {
  async function post(runId: number, result: typeof FAILED | typeof PASSED | typeof INCONCLUSIVE) {
    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
    return postGateCommitStatus(db as never, {
      projectId: 1,
      runId,
      runMetadata: run!.metadata,
      runUrl: `https://piwi.example/test-runs/${runId}`,
      result,
    });
  }

  beforeEach(async () => {
    await setAppSetting(db as never, 'pr_feedback', { enabled: true, status: true, statusContext: 'piwi/tests' });
  });

  test('is off by default', async () => {
    expect(await post(await insertRun({ prNumber: 3 }), FAILED)).toBe(false);
    expect(scm.statuses).toEqual([]);
  });

  test('posts `<statusContext>/gate` once the project opts in, and records it', async () => {
    await db.update(schema.projects).set({ gateStatus: true }).where(eq(schema.projects.id, 1));
    const run = await insertRun({ prNumber: 3 });
    expect(await post(run, FAILED)).toBe(true);
    expect(scm.statuses).toEqual([
      {
        sha: `c${run}`,
        status: {
          state: 'failure',
          description: '1 new regression (limit 0)',
          targetUrl: `https://piwi.example/test-runs/${run}`,
          context: 'piwi/tests/gate',
        },
      },
    ]);
    expect(await readPrFeedbackPost(db as never, run)).toMatchObject({
      provider: 'github',
      prNumber: 3,
      statuses: ['piwi/tests/gate'],
    });
  });

  test('posts nothing for an inconclusive verdict, or with commit statuses off', async () => {
    await db.update(schema.projects).set({ gateStatus: true }).where(eq(schema.projects.id, 1));
    expect(await post(await insertRun({ incident: true }), INCONCLUSIVE)).toBe(false);
    await setAppSetting(db as never, 'pr_feedback', { enabled: true, status: false });
    expect(await post(await insertRun(), PASSED)).toBe(false);
    expect(scm.statuses).toEqual([]);
  });
});

describe('the pull-request feedback record', () => {
  test('adds up the statuses posted for a run and keeps the comment and its fixes', async () => {
    const run = await insertRun();
    const fix = {
      clusterId: 3,
      signature: 'sig',
      title: 'Checkout times out',
      verification: 'stopped-failing' as const,
      timeToResolutionMs: 1000,
      testCount: 2,
    };
    await recordPrFeedbackPost(db as never, {
      projectId: 1,
      runId: run,
      repositoryUrl: REPO,
      prNumber: 5,
      commentId: '991',
      statuses: ['piwi/tests'],
      fixes: [fix],
    });
    await recordPrFeedbackPost(db as never, {
      projectId: 1,
      runId: run,
      repositoryUrl: REPO,
      statuses: ['piwi/tests', 'piwi/tests/gate'],
    });
    expect(await readPrFeedbackPost(db as never, run)).toEqual({
      runId: run,
      provider: 'github',
      repositoryUrl: REPO,
      prNumber: 5,
      commentId: '991',
      statuses: ['piwi/tests', 'piwi/tests/gate'],
      fixes: [fix],
    });
  });

  test('Setup marks pull-request feedback active once something was posted, not from the setting alone', async () => {
    const active = async () =>
      (await getSetupStatus(db as never)).capabilities.find((c) => c.id === 'pr-feedback')?.active;
    await setAppSetting(db as never, 'pr_feedback', { enabled: true });
    expect(await active()).toBe(false);

    await recordPrFeedbackPost(db as never, {
      projectId: 1,
      runId: await insertRun(),
      repositoryUrl: REPO,
      statuses: ['piwi/tests'],
    });
    expect(await active()).toBe(true);
    expect((await getCapabilityEvidence(db as never, 1))['pr-feedback']).toBe(true);
    await db.insert(schema.projects).values({ id: 2, name: 'search' });
    expect((await getCapabilityEvidence(db as never, 2))['pr-feedback']).toBe(false);

    await setAppSetting(db as never, 'pr_feedback', { enabled: false });
    expect(await active()).toBe(false);
  });
});

describe('the pull-request state sweep', () => {
  const now = new Date(T0 + 100 * HOUR);

  test('a pull request merged despite the failed gate records one override', async () => {
    const run = await insertRun({ prNumber: 11 });
    const first = await evaluate(run, FAILED);
    const again = await evaluate(run, FAILED, { at: new Date(T0 + 3 * HOUR) });
    scm.prs[11] = { state: 'merged', updatedAt: new Date(T0 + 5 * HOUR).toISOString() };

    const sweep = await refreshGatePullRequests(db as never, { now });
    expect(sweep).toMatchObject({ checked: 1, merged: 1, overrides: 1 });
    expect(scm.lookups).toEqual([11]);
    expect(await evaluationRow(again.id)).toMatchObject({ prState: 'merged', overridden: true });
    expect(await evaluationRow(first.id)).toMatchObject({ prState: 'merged', overridden: false });
    expect(await gateOutcomes()).toEqual([
      { subjectId: first.id, outcome: 'suggested', runId: run },
      { subjectId: again.id, outcome: 'suggested', runId: run },
      { subjectId: again.id, outcome: 'rejected', runId: run },
    ]);

    // Settled: a later pass neither looks it up nor records it again.
    await refreshGatePullRequests(db as never, { now });
    expect(scm.lookups).toEqual([11]);
    expect((await gateOutcomes()).filter((o) => o.outcome === 'rejected')).toHaveLength(1);
  });

  test('a pull request fixed before the merge is no override', async () => {
    const failing = await insertRun({ prNumber: 12 });
    await evaluate(failing, FAILED);
    await evaluate(await insertRun({ prNumber: 12 }), PASSED);
    scm.prs[12] = { state: 'merged', updatedAt: new Date(T0 + 50 * HOUR).toISOString() };

    expect(await refreshGatePullRequests(db as never, { now })).toMatchObject({ merged: 1, overrides: 0 });
    expect((await gateOutcomes()).map((o) => o.outcome)).toEqual(['suggested']);
  });

  test('an inconclusive last evaluation, on an incident run, is no override', async () => {
    await evaluate(await insertRun({ prNumber: 13 }), FAILED);
    await evaluate(await insertRun({ prNumber: 13, incident: true }), INCONCLUSIVE);
    scm.prs[13] = { state: 'merged', updatedAt: new Date(T0 + 50 * HOUR).toISOString() };

    expect(await refreshGatePullRequests(db as never, { now })).toMatchObject({ merged: 1, overrides: 0 });
    expect((await gateOutcomes()).map((o) => o.outcome)).toEqual(['suggested']);
  });

  test('a pull request closed without merging records nothing', async () => {
    const stored = await evaluate(await insertRun({ prNumber: 14 }), FAILED);
    scm.prs[14] = { state: 'closed' };

    expect(await refreshGatePullRequests(db as never, { now })).toMatchObject({ closed: 1, overrides: 0 });
    expect(await evaluationRow(stored.id)).toMatchObject({ prState: 'closed', overridden: false });
    expect((await gateOutcomes()).map((o) => o.outcome)).toEqual(['suggested']);
  });

  test('an open pull request is checked again later, oldest check first', async () => {
    const older = await evaluate(await insertRun({ prNumber: 15 }), FAILED);
    const newer = await evaluate(await insertRun({ prNumber: 16 }), FAILED);

    await refreshGatePullRequests(db as never, { now, limit: 1 });
    expect(scm.lookups).toEqual([15]);
    expect(await evaluationRow(older.id)).toMatchObject({ prState: 'open', checkedAt: now });

    // The row never looked at goes first, then the least recently checked.
    const later = new Date(now.getTime() + HOUR);
    await refreshGatePullRequests(db as never, { now: later, limit: 1 });
    await refreshGatePullRequests(db as never, { now: new Date(later.getTime() + HOUR), limit: 1 });
    expect(scm.lookups).toEqual([15, 16, 15]);
    expect(await evaluationRow(newer.id)).toMatchObject({ prState: 'open', checkedAt: later });
  });

  test('a failed lookup leaves the row unsettled but checked', async () => {
    const stored = await evaluate(await insertRun({ prNumber: 17 }), FAILED);
    scm.prs[17] = 'throw';
    await refreshGatePullRequests(db as never, { now });
    expect(await evaluationRow(stored.id)).toMatchObject({ prState: null, checkedAt: now });
  });

  test('evaluations with no pull request, or a passing verdict, are not looked up', async () => {
    await evaluate(await insertRun(), FAILED);
    await evaluate(await insertRun({ prNumber: 18 }), PASSED);
    await refreshGatePullRequests(db as never, { now });
    expect(scm.lookups).toEqual([]);
  });
});

describe('escapes past the gate', () => {
  const mergedAt = new Date(T0 + 10 * HOUR);

  async function overrideOn(prNumber: number) {
    const run = await insertRun({ prNumber, failsIn: [7] });
    const stored = await evaluate(run, FAILED, { clusterIds: [7] });
    scm.prs[prNumber] = { state: 'merged', updatedAt: mergedAt.toISOString() };
    return { run, stored };
  }

  test('the gate fails, the PR is merged anyway, and the cluster regresses on main: one override and one escape', async () => {
    const { stored } = await overrideOn(20);
    // Failing on main before the merge says nothing about the merge.
    await insertRun({ branch: 'main', startTime: new Date(mergedAt.getTime() - HOUR), failsIn: [7] });
    await insertRun({ branch: 'main', startTime: new Date(mergedAt.getTime() + HOUR) });
    const escaped = await insertRun({
      branch: 'main',
      startTime: new Date(mergedAt.getTime() + 2 * HOUR),
      failsIn: [7],
    });
    await insertRun({ branch: 'main', startTime: new Date(mergedAt.getTime() + 3 * HOUR), failsIn: [7] });

    const sweep = await refreshGatePullRequests(db as never, { now: new Date(mergedAt.getTime() + 4 * HOUR) });
    expect(sweep).toMatchObject({ overrides: 1, escapes: 1 });
    expect(await evaluationRow(stored.id)).toMatchObject({ overridden: true, escapedRunId: escaped });

    const [regressed] = await listOutcomes(db as never, { kind: 'gate', outcomes: ['regressed'] });
    expect(regressed).toMatchObject({ subjectId: stored.id, runId: escaped });
    expect(regressed!.details).toMatchObject({ prNumber: 20, clusterId: 7, escapedRunId: escaped });

    const counts = await readOutcomeCounts(db as never, {
      projectIds: [1],
      fromDay: '2026-05-01',
      toDay: '2026-07-01',
      kinds: ['gate'],
    });
    const total = (outcome: string) => counts.filter((c) => c.outcome === outcome).reduce((n, c) => n + c.count, 0);
    expect({ overrides: total('rejected'), escapes: total('regressed') }).toEqual({ overrides: 1, escapes: 1 });

    // Counted once.
    await refreshGatePullRequests(db as never, { now: new Date(mergedAt.getTime() + 5 * HOUR) });
    expect(await listOutcomes(db as never, { kind: 'gate', outcomes: ['regressed'] })).toHaveLength(1);
  });

  test.each([
    ['a Flake Lab run', { origin: 'flake-lab' }],
    ['an environment incident', { incident: true }],
    ['a run of another branch', { branch: 'feature/y' }],
  ])('%s is no escape', async (_label, seed) => {
    const { stored } = await overrideOn(21);
    await insertRun({ branch: 'main', startTime: new Date(mergedAt.getTime() + HOUR), failsIn: [7], ...seed });

    expect(await refreshGatePullRequests(db as never, { now: new Date(mergedAt.getTime() + 2 * HOUR) })).toMatchObject({
      overrides: 1,
      escapes: 0,
    });
    expect(await evaluationRow(stored.id)).toMatchObject({ escapedRunId: null });
  });

  test('another cluster failing on main is no escape', async () => {
    await overrideOn(22);
    await insertRun({ branch: 'main', startTime: new Date(mergedAt.getTime() + HOUR), failsIn: [8] });
    expect(await refreshGatePullRequests(db as never, { now: new Date(mergedAt.getTime() + 2 * HOUR) })).toMatchObject({
      escapes: 0,
    });
  });
});

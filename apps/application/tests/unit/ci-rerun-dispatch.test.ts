import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { desc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const dispatched: Array<{ args: string; request: Record<string, unknown>; settings: unknown }> = [];
let answer: Record<string, unknown> = {};
/** The options each repository provider was opened with. */
const opened: Array<Record<string, unknown> | undefined> = [];
vi.mock('../../server/utils/scm', () => ({
  detectScmProvider: (url: string | null) => (url?.includes('gitlab') ? 'gitlab' : url ? 'github' : null),
  hasScmCredential: async () => true,
  createScmProvider: async (_url: string, _db: unknown, _projectId: number, options?: Record<string, unknown>) => {
    opened.push(options);
    return {
      provider: 'gitlab',
      dispatchRerun: async (settings: unknown, args: string, request: Record<string, unknown>) => {
        dispatched.push({ args, request, settings });
        return { url: 'https://ci.example/runs', ref: request.ref ?? 'main', ...answer };
      },
    };
  },
}));

const { ciDispatchAvailability, dispatchCi, rerunClusterInCi } = await import('../../server/utils/ci-rerun');
const { matchRunToCiDispatch } = await import('../../server/utils/ci-dispatches');
const { resolveCiRerunSettings } = await import('#shared/ci-rerun');
const { matchCiDispatch, CI_DISPATCH_CLOCK_SLACK_MS, CI_DISPATCH_MATCH_WINDOW_MS } =
  await import('#shared/ci-dispatches');
const { carryCiRerunOrigin, runOrigin } = await import('#shared/run-eligibility');
const { ciActionsFromLegacy, pickCiAction } = await import('#shared/ci-actions');
const { insertCredential, updateCredential } = await import('#shared/handlers/credentials');
const { sealCredentialSecret } = await import('../../server/utils/credentials');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

type Source = Parameters<typeof dispatchCi>[2]['source'];
type Actor = Parameters<typeof dispatchCi>[3];

/** Whether a place of project 1 (its first cluster by default) can dispatch, and the action it would use. */
async function availability(source: Source = { from: 'cluster', clusterId: 1 }) {
  return (await ciDispatchAvailability(db as never, 1, source, null))!;
}

/** A dispatch from a place of project 1, as a page sends it. */
function dispatch(source: Source, actor: Actor = { id: null, name: null }) {
  return dispatchCi(db as never, 1, { source, action: null, ref: null, inputs: null }, actor, {
    origin: 'page',
    viewerId: null,
  });
}

const GITHUB = 'https://github.com/acme/shop.git';
const GITLAB = 'https://gitlab.com/acme/shop.git';

async function seed(remoteUrl: string) {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  // The people the dispatches name, whom the credential log refers to.
  await db.insert(schema.users).values([
    { id: 1, username: 'ada', password: '', role: 'member' },
    { id: 7, username: 'ada7', password: '', role: 'member' },
  ]);
  await db.insert(schema.projects).values({
    id: 1,
    name: 'shop',
    // The run's repository, which the run pins as it starts.
    repositoryUrl: remoteUrl,
    ciRerun: {
      enabled: true,
      github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args', dispatchIdInput: 'piwi_dispatch' },
      gitlab: { ref: 'main', variableName: 'PIWI_RERUN_ARGS' },
    },
  });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'refunds' },
    { id: 3, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'empties' },
  ]);
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'failed',
    branch: 'feature/coupon',
    startTime: new Date('2026-09-01T10:00:00Z'),
    metadata: { scm: { remoteUrl, branch: 'feature/coupon' }, piwiOrigin: { kind: 'ci' } },
  });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp',
    signature: 'Error: declined',
    errorType: 'unknown',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
  });
  await db.insert(schema.testRunsCases).values([
    { testRunId: 1, testCaseId: 1, status: 'failed', line: 12, browserName: 'chromium', failureClusterId: 1 },
    { testRunId: 1, testCaseId: 2, status: 'failed', line: 30, browserName: 'chromium', failureClusterId: 1 },
  ]);
}

/** A CI run of the given tests (none for a run that has just started), started at `at`. */
async function finishedRun(id: number, metadata: Record<string, unknown>, testCaseIds: number[], at: number) {
  const runMetadata = { scm: { branch: 'feature/coupon' }, ...metadata };
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    branch: 'feature/coupon',
    isFullRun: 0,
    startTime: new Date(at),
    metadata: runMetadata,
    origin: runOrigin(runMetadata),
  });
  if (testCaseIds.length === 0) return;
  await db
    .insert(schema.testRunsCases)
    .values(testCaseIds.map((testCaseId) => ({ testRunId: id, testCaseId, status: 'passed' })));
}

/** The newest dispatch stored, with its time as `at`. */
async function lastDispatch() {
  const [row] = await db.select().from(schema.ciDispatches).orderBy(desc(schema.ciDispatches.createdAt)).limit(1);
  return { ...row!, at: row!.createdAt.getTime() } as Record<string, any>;
}

async function originOf(runId: number) {
  const [row] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
  return (row!.metadata as Record<string, any>).piwiOrigin;
}

beforeEach(() => {
  dispatched.length = 0;
  answer = {};
});

describe('a CI re-run dispatch', () => {
  test("runs each affected test at its line, on the cluster's branch, with the dispatch id", async () => {
    await seed(GITHUB);
    const outcome = await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' });
    expect(outcome.ok).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.args).toBe('"/tests/checkout.spec.ts:30" "/tests/checkout.spec.ts:12" --project="chromium"');
    expect(dispatched[0]!.request.ref).toBe('feature/coupon');
    const record = await lastDispatch();
    expect(dispatched[0]!.request.dispatchId).toBe(record.id);
    expect(record).toMatchObject({
      provider: 'github',
      ref: 'feature/coupon',
      files: ['tests/checkout.spec.ts'],
      byName: 'Ada',
    });
    // The dispatch cannot do without its credential: a refusal stops it, and its log names the action and the user.
    expect(opened.at(-1)).toMatchObject({ strict: true, credentialId: null, actor: { userId: 7 } });
    expect(dispatched[0]!.request.actionId).toBeTruthy();
  });

  test('carries the SCM credential the action names', async () => {
    await seed(GITHUB);
    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          actions: [
            {
              id: 'gh',
              name: 'Dispatch',
              target: { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args', credentialId: 5 },
              inputs: [],
              accepts: ['tests'],
            },
          ],
          defaults: { rerun: 'gh' },
        },
      })
      .where(eq(schema.projects.id, 1));
    expect((await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' })).ok).toBe(true);
    expect(opened.at(-1)).toMatchObject({ strict: true, credentialId: 5 });
    expect(dispatched.at(-1)!.request.actionId).toBe('gh');
  });

  test('is unavailable before the click when no affected test has a file path it can name', async () => {
    await seed(GITHUB);
    expect((await availability()).available).toBe(true);
    await db.update(schema.testCases).set({ filePath: '' });
    expect(await availability()).toMatchObject({
      available: false,
      reason: 'None of these tests has a file path a re-run can name.',
    });
  });

  test('dispatches nothing when no affected test has a file path the arguments can name', async () => {
    await seed(GITHUB);
    await db.update(schema.testCases).set({ filePath: '' });
    const outcome = await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' });
    expect(outcome).toMatchObject({
      ok: false,
      error: 'unavailable',
      message: 'None of these tests has a file path a re-run can name.',
    });
    expect(dispatched).toHaveLength(0);
  });

  test('keeps the pipeline id GitLab answers with', async () => {
    await seed(GITLAB);
    answer = { pipelineId: '9001' };
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    expect(await lastDispatch()).toMatchObject({ provider: 'gitlab', providerRunId: '9001' });
  });
});

describe('the run a CI re-run started', () => {
  test('is recognized by the dispatch id it carries, and stamped ci-rerun', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id } }, [1], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 2, 'finish')).toBe(id);
    expect(await originOf(2)).toEqual({ kind: 'ci-rerun', ref: id });
    expect((await lastDispatch()).runId).toBe(2);
  });

  test("is recognized by GitLab's pipeline id", async () => {
    await seed(GITLAB);
    answer = { pipelineId: '9001' };
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci' }, ci: { provider: 'GitLab CI', pipelineId: '9000' } }, [1, 2], at);
    expect(await matchRunToCiDispatch(db as never, 2, 'finish')).toBeNull();
    await finishedRun(3, { piwiOrigin: { kind: 'ci' }, ci: { provider: 'GitLab CI', pipelineId: '9001' } }, [1, 2], at);
    expect(await matchRunToCiDispatch(db as never, 3, 'finish')).toBe(id);
    expect((await originOf(3)).kind).toBe('ci-rerun');
  });

  test('links the dispatch to the build the run recorded', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    const ci = { provider: 'GitHub Actions', buildUrl: 'https://github.com/acme/shop/actions/runs/77' };
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id }, ci }, [1], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 2, 'finish')).toBe(id);
    expect((await lastDispatch()).url).toBe('https://github.com/acme/shop/actions/runs/77');
  });

  test('keeps the dispatch link when the recorded build URL is not http(s)', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id }, ci: { buildUrl: 'javascript:alert(1)' } }, [1], at);
    expect(await matchRunToCiDispatch(db as never, 2, 'finish')).toBe(id);
    expect((await lastDispatch()).url).toBe('https://ci.example/runs');
  });

  test('without an id, by its branch, start time and test files', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    // Another file ran too: not the re-run.
    await finishedRun(2, { piwiOrigin: { kind: 'ci' } }, [1, 3], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 2, 'finish')).toBeNull();
    // A local run of the same tests: not a CI run.
    await finishedRun(3, { piwiOrigin: { kind: 'local' } }, [1, 2], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 3, 'finish')).toBeNull();
    await finishedRun(4, { piwiOrigin: { kind: 'ci' } }, [1, 2], at + 120_000);
    expect(await matchRunToCiDispatch(db as never, 4, 'finish')).toBe(id);
    // Matched once only.
    await finishedRun(5, { piwiOrigin: { kind: 'ci' } }, [1, 2], at + 180_000);
    expect(await matchRunToCiDispatch(db as never, 5, 'finish')).toBeNull();
  });
});

describe('the dispatch record', () => {
  test('matches a run as it starts, by the dispatch id it carries, and ends with it', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id } }, [], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 2, 'start')).toBe(id);
    expect(await lastDispatch()).toMatchObject({ runId: 2, state: 'running' });
    expect(await originOf(2)).toEqual({ kind: 'ci-rerun', ref: id });
    expect(await matchRunToCiDispatch(db as never, 2, 'finish')).toBe(id);
    expect(await lastDispatch()).toMatchObject({ runId: 2, state: 'ended' });
  });

  test('keeps the ci-rerun stamp when the reporter’s last metadata says ci', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id } }, [], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 2, 'start')).toBe(id);
    // What /finish writes: the reporter's metadata, through the carry of the server's stamp.
    const [stored] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, 2));
    const reported = { scm: { branch: 'feature/coupon' }, piwiOrigin: { kind: 'ci', ref: id } };
    expect(carryCiRerunOrigin(reported, stored!.metadata)).toMatchObject({ piwiOrigin: { kind: 'ci-rerun', ref: id } });
    // A write that dropped it is stamped again when the run finishes.
    await db.update(schema.testRuns).set({ metadata: reported, origin: 'ci' }).where(eq(schema.testRuns.id, 2));
    expect(await matchRunToCiDispatch(db as never, 2, 'finish')).toBe(id);
    expect(await originOf(2)).toEqual({ kind: 'ci-rerun', ref: id });
    expect(await lastDispatch()).toMatchObject({ state: 'ended', runId: 2 });
  });

  test('lets a retry of the job answer a dispatch whose run was cancelled', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id } }, [], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 2, 'start')).toBe(id);
    await finishedRun(3, { piwiOrigin: { kind: 'ci', ref: id } }, [], at + 120_000);
    // While the first run lives, the dispatch is its.
    expect(await matchRunToCiDispatch(db as never, 3, 'start')).toBeNull();
    await db.update(schema.testRuns).set({ status: 'cancelled' }).where(eq(schema.testRuns.id, 2));
    expect(await matchRunToCiDispatch(db as never, 3, 'start')).toBe(id);
    expect(await lastDispatch()).toMatchObject({ state: 'running', runId: 3 });
  });

  test('matches a GitHub run as it starts by the run id GitHub answered, and links it', async () => {
    await seed(GITHUB);
    answer = { runId: '555', url: 'https://github.com/acme/shop/actions/runs/555' };
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    expect(await lastDispatch()).toMatchObject({
      providerRunId: '555',
      url: 'https://github.com/acme/shop/actions/runs/555',
    });
    await finishedRun(2, { piwiOrigin: { kind: 'ci' }, ci: { provider: 'GitHub Actions', runId: '554' } }, [], at);
    expect(await matchRunToCiDispatch(db as never, 2, 'start')).toBeNull();
    await finishedRun(3, { piwiOrigin: { kind: 'ci' }, ci: { provider: 'GitHub Actions', runId: '555' } }, [], at);
    expect(await matchRunToCiDispatch(db as never, 3, 'start')).toBe(id);
  });

  test('leaves the file match to the run’s finish', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci' } }, [1, 2], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 2, 'start')).toBeNull();
    expect(await matchRunToCiDispatch(db as never, 2, 'finish')).toBe(id);
    expect(await lastDispatch()).toMatchObject({ runId: 2, state: 'ended' });
  });

  test('refuses the same dispatch sent again within ten seconds, and answers the first', async () => {
    await seed(GITHUB);
    const first = await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' });
    const again = await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' });
    expect(first.ok).toBe(true);
    expect(again).toMatchObject({ ok: false, error: 'duplicate' });
    expect(again.ok === false && again.error === 'duplicate' && again.dispatch.id).toBe(first.ok && first.dispatch.id);
    expect(dispatched).toHaveLength(1);
    expect(await db.select().from(schema.ciDispatches)).toHaveLength(1);
  });

  test('refuses a dispatch left to the target’s branch while the same one waits on a named branch', async () => {
    await seed(GITHUB);
    const { claimCiDispatch } = await import('#shared/handlers/ci-dispatches');
    const row = {
      id: 'aaaaaaaaaaaaaaa1',
      projectId: 1,
      actionId: 'gh',
      actionName: 'gh',
      origin: 'page' as const,
      kind: 'tests' as const,
      sourceRunId: 1,
      clusterId: 1,
      testCaseId: null,
      provider: 'github' as const,
      preset: null,
      ref: 'main',
      inputs: {},
      args: 'a',
      files: null,
      tests: 1,
      byUserId: null,
      byName: null,
    };
    expect(await claimCiDispatch(db as never, row)).toEqual({ claimed: true });
    const again = await claimCiDispatch(db as never, { ...row, id: 'aaaaaaaaaaaaaaa2', ref: null });
    expect(again).toMatchObject({ claimed: false, existing: { id: 'aaaaaaaaaaaaaaa1' } });
    const other = await claimCiDispatch(db as never, { ...row, id: 'aaaaaaaaaaaaaaa3', ref: 'release' });
    expect(other).toEqual({ claimed: true });
  });

  test('stores the dispatch of one execution with its cluster', async () => {
    await seed(GITHUB);
    const [execution] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testCaseId, 1));
    expect((await dispatch({ from: 'execution', executionId: execution!.id, scope: 'test' })).ok).toBe(true);
    expect(await lastDispatch()).toMatchObject({ kind: 'tests', clusterId: 1, origin: 'page', tests: 1 });
  });

  test("matches a Flake Lab experiment's run by the test it is about, whose ref names the experiment", async () => {
    await seed(GITHUB);
    // A dispatch GitHub answered with no run id, whose run cannot carry the dispatch id either.
    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          actions: [
            {
              id: 'lab',
              name: 'Flake Lab',
              target: { type: 'github', workflow: 'lab.yml', ref: 'main', argsInput: 'args' },
              inputs: [],
              accepts: ['flakeLab'],
            },
          ],
          defaults: { flakeLab: 'lab' },
        },
      })
      .where(eq(schema.projects.id, 1));
    expect(
      (await dispatch({ from: 'flake-lab', testCaseId: 1, flakeLab: 'reproduce' }, { id: 1, name: 'Ada' })).ok,
    ).toBe(true);
    const { id, at } = await lastDispatch();
    expect(await lastDispatch()).toMatchObject({ kind: 'flakeLab', testCaseId: 1, files: null });
    await db.insert(schema.flakeExperiments).values({ id: 31, projectId: 1, testCaseId: 1, kind: 'reproduce' });
    const lab = { piwiOrigin: { kind: 'flake-lab', ref: '31' }, piwiFlakeLab: { experimentId: 31, armId: 1 } };
    // The same experiment on a developer's machine reports no CI: it never answers the dispatch.
    await finishedRun(2, lab, [], at + 30_000);
    expect(await matchRunToCiDispatch(db as never, 2, 'start')).toBeNull();
    await finishedRun(3, { ...lab, ci: { provider: 'GitHub Actions', runId: '9' } }, [], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 3, 'start')).toBe(id);
    // A lab run keeps its own origin.
    expect(await originOf(3)).toEqual({ kind: 'flake-lab', ref: '31' });
  });

  test('picks the action that started the failed run, and sends the values that run was sent with', async () => {
    await seed(GITHUB);
    const action = (id: string) => ({
      id,
      name: id,
      target: { type: 'github', workflow: `${id}.yml`, ref: 'main', argsInput: 'args' },
      inputs: [{ name: 'TARGET', kind: 'choice', options: ['staging', 'prod'], default: 'staging' }],
      accepts: ['tests'],
    });
    await db
      .update(schema.projects)
      .set({ ciRerun: { enabled: true, actions: [action('main'), action('nightly')], defaults: { rerun: 'main' } } })
      .where(eq(schema.projects.id, 1));
    // Run 1, the cluster's last run, was started by a dispatch of `nightly` on prod.
    await db.insert(schema.ciDispatches).values({
      id: 'aaaaaaaaaaaaaaaa',
      projectId: 1,
      actionId: 'nightly',
      origin: 'page',
      kind: 'suite',
      provider: 'github',
      args: '',
      inputs: { TARGET: 'prod' },
      state: 'ended',
      runId: 1,
      createdAt: new Date('2026-09-01T09:59:00Z'),
    });
    expect((await rerunClusterInCi(db as never, 1, { id: null, name: null })).ok).toBe(true);
    expect(dispatched.at(-1)!.request.inputs).toEqual({ TARGET: 'prod' });
    expect(await lastDispatch()).toMatchObject({ actionId: 'nightly', actionName: 'nightly' });
  });

  test('marks the dispatches no run answered within the window, and prunes the old ones', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    const { endUnreportedCiDispatches, pruneCiDispatches } = await import('../../server/utils/ci-dispatches');
    expect(await endUnreportedCiDispatches(db as never, new Date(at + 60_000))).toBe(0);
    expect(await endUnreportedCiDispatches(db as never, new Date(at + CI_DISPATCH_MATCH_WINDOW_MS + 1))).toBe(1);
    expect(await lastDispatch()).toMatchObject({ id, state: 'unreported' });
    expect(await pruneCiDispatches(db as never, 90, new Date(at + 89 * 86_400_000))).toBe(0);
    expect(await pruneCiDispatches(db as never, 90, new Date(at + 91 * 86_400_000))).toBe(1);
  });
});

describe('matchCiDispatch', () => {
  const base = {
    provider: 'github' as const,
    kind: 'tests' as const,
    ref: null,
    files: null,
    providerRunId: null,
    testCaseId: null,
    state: 'dispatched' as const,
    runId: null,
  };
  const run = {
    originRef: null,
    githubRunId: null,
    pipelineId: null,
    buildNumber: null,
    branch: 'main',
    startedAt: 1_000_000,
    files: ['tests/a.spec.ts'],
  };

  test("matches Bitbucket's build number, GitLab's pipeline id and GitHub's run id, before the files are known", () => {
    const bitbucket = { ...base, provider: 'bitbucket' as const, id: 'x', at: 0, providerRunId: '42' };
    expect(matchCiDispatch({ ...run, files: null, bitbucketBuildNumber: '42' }, [bitbucket])).toBe(bitbucket);
    expect(matchCiDispatch({ ...run, bitbucketBuildNumber: '41' }, [bitbucket])).toBeNull();
    const gitlab = { ...base, provider: 'gitlab' as const, id: 'y', at: 0, providerRunId: '9001' };
    expect(matchCiDispatch({ ...run, files: null, pipelineId: '9001' }, [gitlab])).toBe(gitlab);
    const github = { ...base, id: 'z', at: 0, providerRunId: '555', kind: 'suite' as const };
    expect(matchCiDispatch({ ...run, files: null, githubRunId: '555' }, [github])).toBe(github);
    expect(matchCiDispatch({ ...run, files: null, githubRunId: '556' }, [github])).toBeNull();
  });

  test('matches by the dispatch id first, and never a dispatch already matched or refused', () => {
    const open = { ...base, id: 'open', at: 900_000, ref: 'main', files: run.files };
    expect(matchCiDispatch({ ...run, files: null, originRef: 'open' }, [open])).toBe(open);
    expect(matchCiDispatch({ ...run, originRef: 'open' }, [{ ...open, runId: 3 }])).toBeNull();
    expect(matchCiDispatch({ ...run, originRef: 'open' }, [{ ...open, state: 'refused' as const }])).toBeNull();
  });

  test('matches by files only once they are known, never a whole suite or tagged tests, nor a GitHub dispatch that has its run id', () => {
    const rerun = { ...base, id: 'x', at: 900_000, ref: 'main', files: run.files };
    expect(matchCiDispatch({ ...run, files: null }, [rerun])).toBeNull();
    expect(matchCiDispatch(run, [rerun])).toBe(rerun);
    expect(matchCiDispatch(run, [{ ...rerun, kind: 'suite' as const }])).toBeNull();
    expect(matchCiDispatch(run, [{ ...rerun, kind: 'tags' as const }])).toBeNull();
    expect(matchCiDispatch(run, [{ ...rerun, providerRunId: '555' }])).toBeNull();
    expect(matchCiDispatch(run, [{ ...rerun, kind: 'flakeLab' as const }])).toMatchObject({ id: 'x' });
  });

  test("matches a Flake Lab run by its experiment's test and kind, made after the dispatch, on its branch", () => {
    const lab = { ...base, provider: 'ci-server' as const, kind: 'flakeLab' as const, id: 'lab', at: 900_000 };
    const ofTest = { ...lab, testCaseId: 12, ref: 'main', flakeLabKind: 'reproduce' as const };
    const experiment = { testCaseId: 12, kind: 'reproduce' as const, at: 950_000 };
    const labRun = { ...run, files: null, flakeLab: experiment };
    expect(matchCiDispatch(labRun, [ofTest])).toBe(ofTest);
    expect(matchCiDispatch({ ...labRun, flakeLab: { ...experiment, testCaseId: 13 } }, [ofTest])).toBeNull();
    expect(matchCiDispatch({ ...labRun, branch: 'release' }, [ofTest])).toBeNull();
    // A verify run never answers a reproduce dispatch, nor an experiment planned before the dispatch.
    expect(matchCiDispatch({ ...labRun, flakeLab: { ...experiment, kind: 'verify' } }, [ofTest])).toBeNull();
    expect(matchCiDispatch({ ...labRun, flakeLab: { ...experiment, at: 800_000 } }, [ofTest])).toBeNull();
    // A re-run of the same test is not the experiment's dispatch.
    expect(matchCiDispatch(labRun, [{ ...ofTest, kind: 'tests' as const }])).toBeNull();
  });

  test("matches each CI's run id only from a run that CI reported", () => {
    const bitbucket = { ...base, provider: 'bitbucket' as const, id: 'b', at: 0, providerRunId: '17' };
    // A Jenkins build #17 reports a build number, not Bitbucket's.
    expect(matchCiDispatch({ ...run, files: null, buildNumber: '17' }, [bitbucket])).toBeNull();
    expect(matchCiDispatch({ ...run, files: null, bitbucketBuildNumber: '17' }, [bitbucket])).toBe(bitbucket);
  });

  test("matches a CI server's build number with its branch and files, and its branch, time and files without one", () => {
    const numbered = {
      ...base,
      provider: 'ci-server' as const,
      id: 'x',
      at: 0,
      ref: 'main',
      providerRunId: '42',
      files: run.files,
    };
    expect(matchCiDispatch({ ...run, buildNumber: '42' }, [numbered])).toBe(numbered);
    expect(matchCiDispatch({ ...run, branch: 'release', buildNumber: '42' }, [numbered])).toBeNull();
    const unnumbered = { ...base, provider: 'ci-server' as const, id: 'y', at: 999_000, ref: 'main', files: run.files };
    expect(matchCiDispatch(run, [unnumbered])).toBe(unnumbered);
    expect(matchCiDispatch({ ...run, branch: 'other' }, [unnumbered])).toBeNull();
  });

  test('matches a CI server dispatch whose job runs its configured branch on any branch, and no other with none', () => {
    const fixed = { ...base, provider: 'ci-server' as const, id: 'x', at: 0, providerRunId: '42', files: run.files };
    expect(matchCiDispatch({ ...run, branch: 'release', buildNumber: '42' }, [fixed])).toBe(fixed);
    expect(matchCiDispatch({ ...run, branch: 'release' }, [{ ...fixed, providerRunId: null }])).toMatchObject({
      id: 'x',
    });
    // Bitbucket learns its branch only once sent, and a GitHub dispatch always names one.
    expect(matchCiDispatch(run, [{ ...fixed, provider: 'github' as const, providerRunId: null }])).toBeNull();
    expect(matchCiDispatch(run, [{ ...fixed, provider: 'bitbucket' as const, providerRunId: null }])).toBeNull();
  });

  test("leaves another job's build of the same number, and a build started before the dispatch", () => {
    const d = {
      ...base,
      provider: 'ci-server' as const,
      id: 'x',
      at: 1_000_000,
      ref: 'main',
      providerRunId: '57',
      files: ['tests/a.spec.ts'],
    };
    const nightly = { ...run, files: ['tests/a.spec.ts', 'tests/b.spec.ts'], buildNumber: '57' };
    expect(matchCiDispatch(nightly, [d])).toBeNull();
    const early = { ...run, buildNumber: '57', startedAt: 1_000_000 - CI_DISPATCH_CLOCK_SLACK_MS - 1 };
    expect(matchCiDispatch(early, [d])).toBeNull();
  });

  test('picks, by its build number, the dispatch a run answers among those of the same branch and files', () => {
    const older = {
      ...base,
      provider: 'ci-server' as const,
      id: 'older',
      at: 900_000,
      ref: 'main',
      providerRunId: '57',
      files: ['tests/a.spec.ts'],
    };
    const newer = { ...older, id: 'newer', at: 950_000, providerRunId: '58' };
    expect(matchCiDispatch({ ...run, buildNumber: '57' }, [older, newer])).toBe(older);
    expect(matchCiDispatch({ ...run, buildNumber: null }, [older, newer])).toBe(newer);
    // A CI clock a few seconds behind Piwi's still matches the build.
    expect(matchCiDispatch({ ...run, buildNumber: '57', startedAt: 895_000 }, [older])).toBe(older);
  });

  test('leaves a run started outside the window or before the dispatch', () => {
    const d = { ...base, id: 'x', at: 1_000_000, ref: 'main', files: ['tests/a.spec.ts'] };
    expect(matchCiDispatch({ ...run, startedAt: 999_000 }, [d])).toBeNull();
    expect(matchCiDispatch({ ...run, startedAt: 1_000_000 + CI_DISPATCH_MATCH_WINDOW_MS + 1 }, [d])).toBeNull();
    expect(matchCiDispatch({ ...run, startedAt: 1_000_500 }, [d])).toBe(d);
  });
});

describe('the re-run settings', () => {
  test('keep the optional dispatch id input for GitHub', () => {
    expect(
      resolveCiRerunSettings({
        enabled: true,
        github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args', dispatchIdInput: ' piwi_dispatch ' },
      }).github,
    ).toEqual({ workflow: 'e2e.yml', ref: 'main', inputName: 'args', dispatchIdInput: 'piwi_dispatch' });
    expect(
      resolveCiRerunSettings({ enabled: true, github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' } }).github,
    ).toEqual({ workflow: 'e2e.yml', ref: 'main', inputName: 'args' });
  });
});

describe('the Flake Lab target', () => {
  test('is kept when complete, dropped when empty', () => {
    expect(
      resolveCiRerunSettings({
        enabled: true,
        flakeLab: {
          github: { workflow: ' flake.yml ', inputName: 'piwi_flake' },
          gitlab: { variableName: '' },
          bitbucket: { pipeline: 'flake', variableName: '' },
        },
      }).flakeLab,
    ).toEqual({ github: { workflow: 'flake.yml', inputName: 'piwi_flake' } });
    expect(
      resolveCiRerunSettings({ enabled: true, flakeLab: { gitlab: { variableName: ' ' } } }).flakeLab,
    ).toBeUndefined();
  });

  test('becomes a Flake Lab action on the re-run target’s ref, the default for Flake Lab', () => {
    const settings = ciActionsFromLegacy(
      resolveCiRerunSettings({
        enabled: true,
        github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' },
        flakeLab: {
          github: { workflow: 'flake.yml', inputName: 'piwi_flake' },
          bitbucket: { pipeline: 'flake', variableName: 'FLAKE_ARGS' },
        },
      }),
    );
    const flake = settings.actions.filter((a) => a.accepts.includes('flakeLab'));
    expect(flake.map((a) => a.target)).toEqual([
      { type: 'github', workflow: 'flake.yml', ref: 'main', argsInput: 'piwi_flake' },
      { type: 'bitbucket', pipeline: 'flake', argsVariable: 'FLAKE_ARGS' },
    ]);
    expect(settings.defaults.flakeLab).toBe(flake[0]!.id);
    expect(pickCiAction(settings, 'flakeLab', { provider: 'github' }).action?.id).toBe(flake[0]!.id);
    expect(pickCiAction(settings, 'flakeLab', { provider: 'bitbucket' }).action?.id).toBe(flake[1]!.id);
    // GitLab has no Flake Lab target here.
    expect(pickCiAction(settings, 'flakeLab', { provider: 'gitlab' }).action).toBeNull();
    expect(pickCiAction({ ...settings, actions: [] }, 'flakeLab', { provider: 'github' }).action).toBeNull();
  });

  test('is unavailable until configured, then dispatches the flake command on the test’s branch', async () => {
    await seed(GITHUB);
    dispatched.length = 0;
    expect(await availability({ from: 'flake-lab', testCaseId: 1, flakeLab: 'reproduce' })).toMatchObject({
      available: false,
    });
    expect(
      await dispatch({ from: 'flake-lab', testCaseId: 1, flakeLab: 'verify' }, { id: 1, name: 'Ada' }),
    ).toMatchObject({
      ok: false,
      error: 'unavailable',
    });
    expect(dispatched).toHaveLength(0);

    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' },
          flakeLab: { github: { workflow: 'flake.yml', inputName: 'piwi_flake' } },
        },
      })
      .where(eq(schema.projects.id, 1));
    expect(await availability({ from: 'flake-lab', testCaseId: 1, flakeLab: 'reproduce' })).toEqual({
      available: true,
      reason: null,
      action: { id: 'flakelab-github', name: 'Flake Lab' },
    });
    const outcome = await dispatch({ from: 'flake-lab', testCaseId: 1, flakeLab: 'verify' }, { id: 1, name: 'Ada' });
    expect(outcome).toMatchObject({
      ok: true,
      dispatch: { provider: 'github', args: 'flake verify 1', ref: 'feature/coupon', byName: 'Ada' },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.args).toBe('flake verify 1');
    expect(dispatched[0]!.request.ref).toBe('feature/coupon');
    expect(dispatched[0]!.settings).toMatchObject({
      type: 'github',
      workflow: 'flake.yml',
      ref: 'main',
      argsInput: 'piwi_flake',
    });
    expect(
      await dispatch({ from: 'flake-lab', testCaseId: 404, flakeLab: 'reproduce' }, { id: 1, name: 'Ada' }),
    ).toMatchObject({
      error: 'not-found',
    });
  });
});

describe('a CI server dispatch', () => {
  let server: Server;
  let base: string;
  let status = 201;
  let failure = 'No such job';
  const received: Array<{ method: string; url: string; authorization?: string; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
        res.writeHead(status, { Location: `${base}queue/item/5/`, 'Content-Type': 'application/json' });
        res.end(status === 201 ? '' : JSON.stringify({ message: failure }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    received.length = 0;
    status = 201;
    failure = 'No such job';
    process.env.PIWI_CI_SERVER_URL = base;
    process.env.PIWI_CI_SERVER_USER = 'piwi-bot';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
  });

  afterEach(() => {
    delete process.env.PIWI_CI_SERVER_URL;
    delete process.env.PIWI_CI_SERVER_USER;
    delete process.env.PIWI_CI_SERVER_TOKEN;
  });

  const uses = () => db.select().from(schema.credentialUses);

  /** A credential shared with the project, its secret sealed for its destination. */
  async function teamCredential(over: { destination?: string; allowedInputs?: string[] | null } = {}) {
    const destination = over.destination ?? base;
    process.env.PIWI_SECRET_KEY = 'a'.repeat(64);
    try {
      return await insertCredential(
        db as never,
        {
          name: 'Team Jenkins',
          description: null,
          service: 'ci-server',
          user: 'team-bot',
          destination,
          scope: { allProjects: false, projectIds: [1] },
          allowedInputs: over.allowedInputs ?? null,
          customRequests: false,
          disabled: false,
        },
        sealCredentialSecret(destination, 'team-secret'),
        null,
      );
    } finally {
      delete process.env.PIWI_SECRET_KEY;
    }
  }

  async function useCiServer(ciServer: Record<string, unknown> | null, enabled = true) {
    await db
      .update(schema.projects)
      .set({ ciRerun: { enabled, via: 'ci-server', ...(ciServer ? { ciServer } : {}) } })
      .where(eq(schema.projects.id, 1));
  }

  test('is available without an SCM repository target, and names what is missing', async () => {
    await seed(GITHUB);
    await useCiServer(null);
    expect(await availability()).toMatchObject({
      available: false,
      reason: 'No CI action re-runs tests for this project.',
    });
    await useCiServer({ preset: 'jenkins', rerun: { job: 'polaris/e2e' } }, false);
    expect(await availability()).toMatchObject({
      available: false,
      reason: 'CI re-run is off for this project.',
    });
    await useCiServer({ preset: 'jenkins', rerun: { job: 'polaris/e2e' } });
    expect(await availability()).toEqual({
      available: true,
      reason: null,
      action: { id: 'rerun-ci-server', name: 'Re-run failed tests' },
    });
    delete process.env.PIWI_CI_SERVER_URL;
    expect(await availability()).toMatchObject({
      available: false,
      reason: 'No CI server is configured for this project.',
    });
  });

  test('is unavailable when the branch job has no branch to name', async () => {
    await seed(GITHUB);
    await db
      .update(schema.testRuns)
      .set({ branch: null, metadata: { scm: { remoteUrl: GITHUB }, piwiOrigin: { kind: 'ci' } } })
      .where(eq(schema.testRuns.id, 1));
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e/{branch}' } });
    expect((await availability()).reason).toBe('The path placeholder {{branchJob}} is empty');
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e/{branch}', ref: 'main' } });
    expect((await availability()).available).toBe(true);
  });

  test('refuses an http base URL on a host nobody listed', async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', baseUrl: 'http://jenkins.example.com/', rerun: { job: 'e2e' } });
    expect((await availability()).reason).toContain('https');
  });

  test('sends the Jenkins request with the instance credential, and records it', async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', rerun: { job: 'polaris/e2e' } });
    const outcome = await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' });
    expect(outcome.ok).toBe(true);
    expect(dispatched).toHaveLength(0);
    expect(received).toHaveLength(1);
    const record = await lastDispatch();
    expect(received[0]).toMatchObject({
      method: 'POST',
      url: '/job/polaris/job/e2e/buildWithParameters',
      authorization: `Basic ${Buffer.from('piwi-bot:instance-secret').toString('base64')}`,
    });
    const form = new URLSearchParams(received[0]!.body);
    expect(form.get('PIWI_RERUN_ARGS')).toBe(
      '"/tests/checkout.spec.ts:30" "/tests/checkout.spec.ts:12" --project="chromium"',
    );
    expect(form.get('PIWI_ORIGIN_REF')).toBe(record.id);
    expect(record).toMatchObject({
      provider: 'ci-server',
      preset: 'jenkins',
      url: `${base}job/polaris/job/e2e/`,
      // The job runs its configured branch, whatever the cluster's.
      ref: null,
      files: ['tests/checkout.spec.ts'],
      tests: 2,
      byName: 'Ada',
    });
    expect(await uses()).toEqual([
      expect.objectContaining({
        credentialName: 'CI server (environment)',
        feature: 'ci-dispatch',
        projectId: 1,
        userId: 7,
        subjectType: 'ci-action',
        subjectId: 'rerun-ci-server',
        destination: `${base}job/polaris/job/e2e/buildWithParameters`,
        result: 'ok',
        count: 1,
      }),
    ]);
  });

  /** An action with a fixed and a choice input on a Jenkins job, the default for re-runs. */
  async function useStagingAction(target: Record<string, unknown> = {}) {
    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          actions: [
            {
              id: 'staging',
              name: 'Staging',
              target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'e2e' }, ...target },
              inputs: [
                { name: 'TARGET_ENV', kind: 'fixed', value: 'staging' },
                { name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'full' },
              ],
              accepts: ['tests'],
            },
          ],
          defaults: { rerun: 'staging' },
        },
      })
      .where(eq(schema.projects.id, 1));
  }

  test('sends no input on the instance credential unless the operator listed it, and records the action', async () => {
    await seed(GITHUB);
    await useStagingAction();
    expect((await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' })).ok).toBe(true);
    expect(received[0]!.authorization).toBe(`Basic ${Buffer.from('piwi-bot:instance-secret').toString('base64')}`);
    const form = new URLSearchParams(received[0]!.body);
    expect(form.has('TARGET_ENV')).toBe(false);
    expect(form.has('SUITE')).toBe(false);
    expect(form.get('PIWI_RERUN_ARGS')).toContain('tests/checkout.spec.ts');
    expect(form.get('PIWI_ORIGIN_REF')).toBeTruthy();
    expect(await lastDispatch()).toMatchObject({ actionId: 'staging', provider: 'ci-server' });
  });

  test('sends the inputs PIWI_CI_SERVER_ALLOWED_INPUTS lists on the instance credential, and no others', async () => {
    await seed(GITHUB);
    await useStagingAction();
    process.env.PIWI_CI_SERVER_ALLOWED_INPUTS = ' TARGET_ENV , OTHER ';
    try {
      expect((await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' })).ok).toBe(true);
    } finally {
      delete process.env.PIWI_CI_SERVER_ALLOWED_INPUTS;
    }
    const form = new URLSearchParams(received[0]!.body);
    expect(form.get('TARGET_ENV')).toBe('staging');
    expect(form.has('SUITE')).toBe(false);
    expect(form.get('PIWI_RERUN_ARGS')).not.toContain('staging');
  });

  test('sends every input on the credential the action names, when it allows them all, and records the use', async () => {
    await seed(GITHUB);
    const id = await teamCredential();
    await useStagingAction({ credentialId: id });
    process.env.PIWI_SECRET_KEY = 'a'.repeat(64);
    try {
      expect(await availability()).toMatchObject({ available: true });
      expect((await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' })).ok).toBe(true);
    } finally {
      delete process.env.PIWI_SECRET_KEY;
    }
    expect(received[0]!.authorization).toBe(`Basic ${Buffer.from('team-bot:team-secret').toString('base64')}`);
    const form = new URLSearchParams(received[0]!.body);
    expect(form.get('TARGET_ENV')).toBe('staging');
    expect(form.get('SUITE')).toBe('full');
    expect(await uses()).toEqual([
      expect.objectContaining({ credentialId: id, credentialName: 'Team Jenkins', subjectId: 'staging', result: 'ok' }),
    ]);
    const [credential] = await db
      .select({ lastUsedAt: schema.credentials.lastUsedAt })
      .from(schema.credentials)
      .where(eq(schema.credentials.id, id));
    expect(credential!.lastUsedAt).not.toBeNull();
  });

  test('sends only the inputs the credential the action names lists', async () => {
    await seed(GITHUB);
    const id = await teamCredential({ allowedInputs: ['SUITE'] });
    await useStagingAction({ credentialId: id });
    process.env.PIWI_SECRET_KEY = 'a'.repeat(64);
    try {
      expect((await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' })).ok).toBe(true);
    } finally {
      delete process.env.PIWI_SECRET_KEY;
    }
    const form = new URLSearchParams(received[0]!.body);
    expect(form.has('TARGET_ENV')).toBe(false);
    expect(form.get('SUITE')).toBe('full');
  });

  test('refuses a credential outside its destination: unavailable before the click, and a dispatch sends nothing and records the refusal', async () => {
    await seed(GITHUB);
    const id = await teamCredential({ destination: 'https://ci.other.example/' });
    await useStagingAction({ credentialId: id, baseUrl: base });
    const before = await availability();
    expect(before).toMatchObject({ available: false });
    expect(before.reason).toContain('is sent only under https://ci.other.example/');
    expect(await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' })).toMatchObject({
      ok: false,
      error: 'unavailable',
      message: expect.stringContaining('is sent only under https://ci.other.example/'),
    });
    expect(received).toHaveLength(0);
    expect(await uses()).toEqual([
      expect.objectContaining({
        credentialId: id,
        userId: 7,
        result: 'refused',
        reason: expect.stringContaining('is sent only under'),
      }),
    ]);
  });

  test('refuses a disabled credential, and one no longer shared with the project', async () => {
    await seed(GITHUB);
    const id = await teamCredential();
    await useStagingAction({ credentialId: id });
    await updateCredential(db as never, id, { disabled: true });
    expect((await availability()).reason).toBe('The credential "Team Jenkins" is disabled.');
    await updateCredential(db as never, id, { disabled: false, scope: { allProjects: false, projectIds: [] } });
    expect((await availability()).reason).toBe('The credential "Team Jenkins" is not shared with this project.');

    // A re-run asked for anyway, as a route or the MCP tool asks for it, is refused by the credential and logged.
    const outcome = await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada', apiKeyId: null });
    expect(outcome).toEqual({
      ok: false,
      error: 'unavailable',
      message: 'The credential "Team Jenkins" is not shared with this project.',
    });
    expect(received).toHaveLength(0);
    const rows = await db.select().from(schema.credentialUses);
    expect(rows).toEqual([
      expect.objectContaining({ credentialId: id, feature: 'ci-dispatch', result: 'refused', projectId: 1, userId: 7 }),
    ]);
  });

  test('picks the action of the run’s environment', async () => {
    await seed(GITHUB);
    const action = (id: string, job: string, environment?: string) => ({
      id,
      name: id,
      target: { type: 'ci-server', preset: 'jenkins', fields: { job } },
      inputs: [],
      accepts: ['tests'],
      ...(environment ? { environment } : {}),
    });
    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          actions: [action('main', 'main-job'), action('staging', 'staging-job', 'staging')],
          defaults: { rerun: 'main' },
        },
      })
      .where(eq(schema.projects.id, 1));
    expect((await availability()).action).toEqual({ id: 'main', name: 'main' });
    await db.update(schema.testRuns).set({ environment: 'staging' }).where(eq(schema.testRuns.id, 1));
    expect((await availability()).action).toEqual({ id: 'staging', name: 'staging' });
    expect((await rerunClusterInCi(db as never, 1, { id: null, name: null })).ok).toBe(true);
    expect(received[0]!.url).toBe('/job/staging-job/buildWithParameters');
  });

  test('picks the action of the run’s environment by id, whatever label the run reported', async () => {
    await seed(GITHUB);
    const [environment] = await db
      .insert(schema.environments)
      .values({ projectId: 1, key: 'prod-eu', keyFold: 'prod-eu', name: 'Production EU', aliases: ['eu'] })
      .returning({ id: schema.environments.id });
    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          actions: [
            {
              id: 'main',
              name: 'main',
              target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'main-job' } },
              inputs: [],
              accepts: ['tests'],
            },
            {
              id: 'eu',
              name: 'eu',
              target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'eu-job' } },
              inputs: [],
              accepts: ['tests'],
              environment: 'prod-eu',
              environmentId: environment!.id,
            },
          ],
          defaults: { rerun: 'main' },
        },
      })
      .where(eq(schema.projects.id, 1));
    await db
      .update(schema.testRuns)
      .set({ environment: 'EU', environmentId: environment!.id })
      .where(eq(schema.testRuns.id, 1));
    expect((await availability()).action).toEqual({ id: 'eu', name: 'eu' });
  });

  test('sends the action the caller names instead of the default', async () => {
    await seed(GITHUB);
    const action = (id: string, job: string) => ({
      id,
      name: id,
      target: { type: 'ci-server', preset: 'jenkins', fields: { job } },
      inputs: [],
      accepts: ['tests'],
    });
    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          actions: [action('main', 'main-job'), action('nightly', 'nightly-job')],
          defaults: { rerun: 'main' },
        },
      })
      .where(eq(schema.projects.id, 1));
    expect((await rerunClusterInCi(db as never, 1, { id: null, name: null }, { actionId: 'nightly' })).ok).toBe(true);
    expect(received[0]!.url).toBe('/job/nightly-job/buildWithParameters');
    expect(await rerunClusterInCi(db as never, 1, { id: null, name: null }, { actionId: 'missing' })).toEqual({
      ok: false,
      error: 'not-found',
      message: 'This project has no CI action "missing".',
    });
  });

  test('sends no instance credential to a base URL a project set elsewhere', async () => {
    await seed(GITHUB);
    const other = base.replace('127.0.0.1', 'localhost');
    process.env.PIWI_CI_SERVER_HOSTS = 'localhost';
    await useCiServer({ preset: 'jenkins', baseUrl: other, rerun: { job: 'e2e' } });
    expect((await rerunClusterInCi(db as never, 1, { id: null, name: null })).ok).toBe(true);
    expect(received[0]!.authorization).toBeUndefined();
    delete process.env.PIWI_CI_SERVER_HOSTS;
  });

  test('fails without the secret when the server’s message repeats it', async () => {
    await seed(GITHUB);
    const id = await teamCredential();
    await useStagingAction({ credentialId: id });
    status = 401;
    failure = `Bad credentials team-bot:team-secret (${Buffer.from('team-bot:team-secret').toString('base64')})`;
    process.env.PIWI_SECRET_KEY = 'a'.repeat(64);
    let outcome: Awaited<ReturnType<typeof rerunClusterInCi>>;
    try {
      outcome = await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' });
    } finally {
      delete process.env.PIWI_SECRET_KEY;
    }
    expect(outcome).toMatchObject({ ok: false, error: 'dispatch-failed' });
    const message = outcome.ok ? '' : outcome.message;
    expect(message).toContain('The CI server answered 401');
    expect(message).not.toContain('team-secret');
    expect(message).not.toContain(Buffer.from('team-bot:team-secret').toString('base64'));
  });

  test("fails with the server's status and message", async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e' } });
    status = 404;
    expect(await rerunClusterInCi(db as never, 1, { id: null, name: null })).toEqual({
      ok: false,
      error: 'dispatch-failed',
      message: 'The CI server answered 404: No such job',
    });
    expect(await uses()).toEqual([
      expect.objectContaining({ userId: null, result: 'failed', reason: 'The CI server answered 404' }),
    ]);
    // The refusal is stored, with the server's words.
    expect(await lastDispatch()).toMatchObject({ state: 'refused', detail: 'The CI server answered 404: No such job' });
  });

  test('re-runs one execution, and the run it starts is matched and linked to its build', async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e' } });
    const [execution] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testCaseId, 1));
    expect((await dispatch({ from: 'execution', executionId: execution!.id, scope: 'test' })).ok).toBe(true);
    expect(new URLSearchParams(received[0]!.body).get('PIWI_RERUN_ARGS')).toBe(
      '"/tests/checkout.spec.ts:12" --project="chromium"',
    );
    const { id, at } = await lastDispatch();
    const ci = { provider: 'Jenkins', buildNumber: '88', buildUrl: `${base}job/e2e/88/` };
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id }, ci }, [1], at + 60_000);
    expect(await matchRunToCiDispatch(db as never, 2, 'finish')).toBe(id);
    expect(await lastDispatch()).toMatchObject({ runId: 2, url: `${base}job/e2e/88/` });
  });

  test('runs Flake Lab on its own job', async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e' } });
    expect(await availability({ from: 'flake-lab', testCaseId: 1, flakeLab: 'reproduce' })).toMatchObject({
      available: false,
      reason: 'No CI action runs Flake Lab for this project.',
      action: null,
    });
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e' }, flakeLab: { job: 'flake-lab' } });
    const outcome = await dispatch({ from: 'flake-lab', testCaseId: 1, flakeLab: 'reproduce' }, { id: 1, name: 'Ada' });
    expect(outcome).toMatchObject({ ok: true, dispatch: { provider: 'ci-server', args: 'flake 1' } });
    expect(received[0]!.url).toBe('/job/flake-lab/buildWithParameters');
    expect(new URLSearchParams(received[0]!.body).get('PIWI_RERUN_ARGS')).toBe('flake 1');
  });
});

describe('an action input a repository host reserves', () => {
  const action = (inputs: Array<Record<string, unknown>>, type: 'gitlab' | 'github') => ({
    id: 'reserved',
    name: 'Reserved',
    target:
      type === 'gitlab'
        ? { type: 'gitlab', ref: 'main', argsVariable: 'PIWI_RERUN_ARGS' }
        : { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args' },
    inputs,
    accepts: ['tests'],
  });
  const use = (inputs: Array<Record<string, unknown>>, type: 'gitlab' | 'github') =>
    db
      .update(schema.projects)
      .set({ ciRerun: { enabled: true, actions: [action(inputs, type)], defaults: { rerun: 'reserved' } } })
      .where(eq(schema.projects.id, 1));

  test('is refused at dispatch and reported as unavailable, and nothing is sent', async () => {
    await seed(GITLAB);
    await use([{ name: 'CI_JOB_TOKEN', kind: 'fixed', value: 'x' }], 'gitlab');
    const before = await availability();
    expect(before.available).toBe(false);
    expect(before.reason).toContain('CI_JOB_TOKEN');
    expect(await rerunClusterInCi(db as never, 1, { id: null, name: null })).toMatchObject({
      ok: false,
      error: 'unavailable',
    });
    expect(dispatched).toHaveLength(0);
  });

  test('is refused whatever its case, for an execution’s test too, and nothing is sent', async () => {
    await seed(GITLAB);
    await use([{ name: 'bitbucket_branch', kind: 'fixed', value: 'x' }], 'gitlab');
    const [execution] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testCaseId, 1));
    expect(await dispatch({ from: 'execution', executionId: execution!.id, scope: 'test' })).toMatchObject({
      ok: false,
      error: 'unavailable',
      message: expect.stringMatching(/bitbucket_branch/),
    });
    expect(dispatched).toHaveLength(0);
  });

  test('is refused whatever its case, and a name that merely contains the prefix is sent', async () => {
    await seed(GITLAB);
    await use([{ name: 'gitlab_user_login', kind: 'fixed', value: 'x' }], 'gitlab');
    expect((await availability()).available).toBe(false);
    await use([{ name: 'MY_CI_NAME', kind: 'fixed', value: 'x' }], 'gitlab');
    expect((await rerunClusterInCi(db as never, 1, { id: null, name: null })).ok).toBe(true);
    expect(dispatched[0]!.request.inputs).toEqual({ MY_CI_NAME: 'x' });
  });

  test('is allowed on GitHub, which reserves no names', async () => {
    await seed(GITHUB);
    await use([{ name: 'CI_ENV', kind: 'fixed', value: 'x' }], 'github');
    expect((await availability()).available).toBe(true);
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { testOutcomes } from '#shared/utils/test-counts';

/**
 * A `--repeat-each` run through the ingest routes: each repetition of a test is
 * a test result of its own, stored as its own execution, counted once in the
 * run's totals, and a test failed in the run when one of its repetitions failed.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  getCurrentUser: async () => null,
  isAuthEnabled: () => false,
}));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));

interface RouteEvent {
  params?: Record<string, string>;
  body: Record<string, unknown>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const events = (await import('../../server/api/test-runs/[id]/events.post')).default as unknown as Route;
const finish = (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Route;
const { runEventBus } = await import('../../server/utils/run-events');
const { computeRunCountsFromRows } = await import('../../server/utils/run-counts');
const { getProjectTestCases } = await import('#shared/handlers/projects');
const { getFailureGroups } = await import('#shared/handlers/test-runs');
const { getBranchFailures } = await import('../../server/utils/branch-failures');
const { pickExecution } = await import('../../server/routes/test-runs/[id]/locate.get');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

const PROJECT = 'repeat-each';
const ERROR = "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Pay' })";

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

/** One result of `pays` as the reporter sends it: its repetition, its retry and its outcome. */
function result(repeatEachIndex: number | undefined, status: string, retries = 0) {
  return {
    title: 'pays',
    location: 'tests/checkout.spec.ts:9:5',
    status,
    duration: 100,
    retries,
    ...(repeatEachIndex === undefined ? {} : { repeatEachIndex }),
    error: status === 'failed' ? ERROR : null,
    browser: { projectName: 'chromium' },
  };
}

/** `--repeat-each=3 --retries=0`: the second repetition fails. */
const REPEATED = [result(0, 'passed'), result(1, 'failed'), result(2, 'passed')];

async function executions(runId: number) {
  return db
    .select({
      id: schema.testRunsCases.id,
      testCaseId: schema.testRunsCases.testCaseId,
      browserName: schema.testRunsCases.browserName,
      repeatEachIndex: schema.testRunsCases.repeatEachIndex,
      retries: schema.testRunsCases.retries,
      status: schema.testRunsCases.status,
    })
    .from(schema.testRunsCases)
    .where(eq(schema.testRunsCases.testRunId, runId))
    .orderBy(asc(schema.testRunsCases.repeatEachIndex), asc(schema.testRunsCases.retries));
}

async function readRun(runId: number) {
  const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
  return run!;
}

function submitRun(testCases: unknown[], counts: Record<string, number>, extra: Record<string, unknown> = {}) {
  return submit({
    body: {
      projectName: PROJECT,
      status: 'failed',
      startTime: new Date().toISOString(),
      testCases,
      ...counts,
      ...extra,
    },
  });
}

describe('a submitted --repeat-each run', () => {
  test('stores each repetition, counts each in the run, and fails the test', async () => {
    const { runId } = await submitRun(REPEATED, { totalTests: 3, passedTests: 2, failedTests: 1 });

    const rows = await executions(runId);
    expect(rows.map((r) => [r.repeatEachIndex, r.retries, r.status])).toEqual([
      [0, 0, 'passed'],
      [1, 0, 'failed'],
      [2, 0, 'passed'],
    ]);
    expect(new Set(rows.map((r) => r.testCaseId)).size).toBe(1);
    expect(await readRun(runId)).toMatchObject({ totalTests: 3, passedTests: 2, failedTests: 1, flakyTests: 0 });
    expect(await computeRunCountsFromRows(db as never, runId)).toEqual({
      totalTests: 3,
      passedTests: 2,
      failedTests: 1,
      skippedTests: 0,
      didNotRunTests: 0,
      flakyTests: 0,
    });

    // The test's outcome in the run is its failed repetition, whichever ran last.
    expect(testOutcomes(rows).map((r) => [r.repeatEachIndex, r.status])).toEqual([[1, 'failed']]);
    const catalog = await getProjectTestCases(db as never, projectId);
    expect(catalog.items.map((t: any) => t.status)).toEqual(['failed']);
  });

  test("keeps each repetition's retries its own", async () => {
    // Repetition 0 fails, then passes on its retry; repetition 1 fails on both attempts.
    const { runId } = await submitRun(
      [result(0, 'failed', 0), result(0, 'passed', 1), result(1, 'failed', 0), result(1, 'failed', 1)],
      { totalTests: 2, passedTests: 1, failedTests: 1 },
    );

    expect(await executions(runId)).toHaveLength(4);
    expect(await computeRunCountsFromRows(db as never, runId)).toMatchObject({
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      flakyTests: 1,
    });
    expect(testOutcomes(await executions(runId)).map((r) => [r.repeatEachIndex, r.retries, r.status])).toEqual([
      [1, 1, 'failed'],
    ]);
  });

  test('a failure cluster is not flaky because another repetition passed', async () => {
    const { runId } = await submitRun(REPEATED, { totalTests: 3, passedTests: 2, failedTests: 1 });
    const groups = await getFailureGroups(db as never, runId);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ caseCount: 1, flaky: false });
    expect(groups[0]!.cases[0]).toMatchObject({ passedOnRetry: false });
  });
});

describe('a payload without the repetition', () => {
  test('is read as the first repetition, an older reporter its retries kept apart', async () => {
    const { runId } = await submitRun([result(undefined, 'failed', 0), result(undefined, 'passed', 1)], {
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
    });
    const rows = await executions(runId);
    expect(rows.map((r) => [r.repeatEachIndex, r.retries, r.status])).toEqual([
      [0, 0, 'failed'],
      [0, 1, 'passed'],
    ]);
    expect(await computeRunCountsFromRows(db as never, runId)).toMatchObject({
      totalTests: 1,
      passedTests: 1,
      flakyTests: 1,
    });
  });

  test('a value that is not a repetition index is read as the first one', async () => {
    const { runId } = await submitRun([{ ...result(0, 'passed'), repeatEachIndex: -2 }], { totalTests: 1 });
    expect((await executions(runId)).map((r) => r.repeatEachIndex)).toEqual([0]);
  });
});

describe('a streamed --repeat-each run', () => {
  async function startRun(totalTests: number) {
    const { runId, streamToken } = await start({ body: { projectName: PROJECT, totalTests } });
    return { runId: runId as number, streamToken: streamToken as string };
  }

  test('stores each repetition and publishes it with its execution', async () => {
    const { runId, streamToken } = await startRun(3);
    const published: Array<{ type: string; data: any }> = [];
    const unsubscribe = runEventBus.subscribe(runId, (event) => published.push(event as never));
    try {
      await events({
        params: { id: String(runId) },
        body: {
          streamToken,
          testCases: REPEATED.map((r) => ({ type: 'begin', title: r.title, location: r.location, ...r })),
        },
      });
      await events({
        params: { id: String(runId) },
        body: { streamToken, testCases: REPEATED.map((r) => ({ type: 'complete', ...r })) },
      });
    } finally {
      unsubscribe();
    }

    expect(published.filter((e) => e.type === 'test-begin').map((e) => e.data.repeatEachIndex)).toEqual([0, 1, 2]);
    const completed = published.filter((e) => e.type === 'test-completed').map((e) => e.data);
    expect(completed.map((d) => [d.repeatEachIndex, d.status])).toEqual([
      [0, 'passed'],
      [1, 'failed'],
      [2, 'passed'],
    ]);
    const rows = await executions(runId);
    expect(completed.map((d) => d.executionId)).toEqual(rows.map((r) => r.id));
    expect(published.filter((e) => e.type === 'run-progress').at(-1)!.data).toMatchObject({
      passedTests: 2,
      failedTests: 1,
    });
    // Every repetition has run, so none is still shown as running.
    expect(runEventBus.getRunningCases(runId)).toEqual([]);

    await finish({
      params: { id: String(runId) },
      body: { streamToken, status: 'failed', duration: 1000, totalTests: 3, passedTests: 2, failedTests: 1 },
    });
    expect(await readRun(runId)).toMatchObject({ status: 'failed', totalTests: 3, passedTests: 2, failedTests: 1 });
  });

  test('stores a batch sent twice once', async () => {
    const { runId, streamToken } = await startRun(3);
    const batch = {
      params: { id: String(runId) },
      body: { streamToken, testCases: REPEATED.map((r) => ({ type: 'complete', ...r })) },
    };
    await events(batch);
    await events(batch);
    expect(await executions(runId)).toHaveLength(3);
  });

  test('an older reporter streams without the repetition: its attempts are stored once each', async () => {
    const { runId, streamToken } = await startRun(1);
    const complete = (status: string, retries: number) => ({ type: 'complete', ...result(undefined, status, retries) });
    await events({ params: { id: String(runId) }, body: { streamToken, testCases: [complete('failed', 0)] } });
    await events({ params: { id: String(runId) }, body: { streamToken, testCases: [complete('passed', 1)] } });
    await events({ params: { id: String(runId) }, body: { streamToken, testCases: [complete('passed', 1)] } });
    expect((await executions(runId)).map((r) => [r.repeatEachIndex, r.retries])).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });
});

describe('the failure link of a repetition', () => {
  const candidate = (id: number, repeatEachIndex: number, status: string) => ({
    id,
    status,
    retries: 0,
    repeatEachIndex,
    browserName: 'chromium',
  });

  test('opens that repetition, the first one when the link names none', () => {
    const candidates = [candidate(1, 0, 'failed'), candidate(2, 1, 'passed'), candidate(3, 2, 'failed')];
    expect(pickExecution(candidates, 0, 'chromium', 2)?.id).toBe(3);
    expect(pickExecution(candidates, 0, 'chromium')?.id).toBe(1);
  });
});

describe('the branch failures of a run with repetitions', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 6, 10, minutes));
  const run = (id: number, minutes: number, kind: string, over: Record<string, unknown> = {}) => ({
    id,
    projectId,
    status: 'failed',
    branch: 'feature/pay',
    startTime: at(minutes),
    metadata: { piwiOrigin: { kind }, scm: { branch: 'feature/pay', commit: 'a1b2c3d' } },
    origin: kind,
    isFullRun: 0,
    totalTests: 3,
    ...over,
  });
  const execution = (id: number, testRunId: number, repeatEachIndex: number, status: string) => ({
    id,
    testRunId,
    testCaseId: 1,
    status,
    retries: 0,
    repeatEachIndex,
    browserName: 'chromium',
    line: 9,
    ...(status === 'failed' ? { error: ERROR } : {}),
  });

  beforeEach(async () => {
    await db.insert(schema.testCases).values({ id: 1, projectId, filePath: 'tests/checkout.spec.ts', title: 'pays' });
    await db.insert(schema.testRuns).values([run(1, 0, 'ci', { isFullRun: 1 }), run(2, 10, 'editor')]);
    await db.insert(schema.testRunsCases).values([
      // The complete CI run: two repetitions failed.
      execution(10, 1, 0, 'failed'),
      execution(11, 1, 1, 'passed'),
      execution(12, 1, 2, 'failed'),
      // A later editor run (Verify ×3): the second repetition still fails, after it ran first.
      execution(21, 2, 1, 'failed'),
      execution(20, 2, 0, 'passed'),
      execution(22, 2, 2, 'passed'),
    ]);
  });

  test('lists the test once, and a later run with a failed repetition keeps it failing', async () => {
    const baseline = await getBranchFailures(db as never, projectId, 'feature/pay');
    expect(baseline.failures.map((f) => f.testCaseId)).toEqual([1]);

    const overlaid = await getBranchFailures(db as never, projectId, 'feature/pay', { overlays: true });
    expect(overlaid.resolved).toEqual([]);
    expect(overlaid.failures.map((f) => [f.executionId, f.source])).toEqual([[21, 'overlay']]);
  });
});

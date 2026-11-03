import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import type { ImportedRunCase, ParsedBlobReport } from '../../server/utils/blob-report';
import type { ParsedTraceImport } from '../../server/utils/trace-import';
import { migrateToLatest } from './temp-db';
import { STORED_ATTEMPTS, expectedFinalFlags, finalAttemptBackfillSql } from './final-attempt-fixture';

/**
 * Each execution stores whether it is the final attempt of its run, test, Playwright project and repetition
 * (`final_attempt`), which a test's pages read its runs from. Every path that writes executions keeps it right when a
 * later attempt arrives, and when an attempt arrives after a later one: a batch, a streamed run, the imports and the
 * demo's ingest. A migration gives the executions stored before it theirs. A retry an older reporter sends without
 * its attempt history is given the one its result's stored and earlier attempts make, which the catalog and the test
 * page read its flakiness from, and an earlier attempt stored after it completes it. A batch sent again after its
 * request failed past its insert repairs both.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../app/demo/db.client', () => ({ getDemoDb: async () => state.db }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  getCurrentUser: async () => null,
  isAuthEnabled: () => false,
}));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));
// A request that fails after its insert: the next `settles` calls of `settleFinalAttempts` throw.
const failing = vi.hoisted(() => ({ settles: 0 }));
vi.mock('#shared/handlers/test-case-aggregates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#shared/handlers/test-case-aggregates')>();
  return {
    ...actual,
    settleFinalAttempts: async (...args: Parameters<typeof actual.settleFinalAttempts>) => {
      if (failing.settles > 0) {
        failing.settles--;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return actual.settleFinalAttempts(...args);
    },
  };
});

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
const { importBlobReportRun, importTraceRun } = await import('#shared/handlers/import-runs');
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { apiSetupTestRun, apiBeginTestRun, apiPostRunEvents } = await import('../../app/demo/api/reporter');
const { getTestCase, getTestCaseStabilityTrend } = await import('#shared/handlers/test-cases');
const { getTestRun } = await import('#shared/handlers/test-runs');
const { isFlakyExecution } = await import('#shared/utils/test-counts');
const { getProjectTestCases } = await import('#shared/handlers/projects');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

const PROJECT = 'final-attempts';

beforeEach(async () => {
  failing.settles = 0;
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

/** One attempt of a test as the reporter sends it, with its attempt history up to it. */
function attempt(title: string, statuses: string[], extra: Record<string, unknown> = {}) {
  const retries = statuses.length - 1;
  const status = statuses[retries]!;
  return {
    title,
    location: `tests/checkout.spec.ts:${title.length}:5`,
    status,
    duration: 100,
    retries,
    repeatEachIndex: 0,
    attempts: statuses.map((s, retry) => ({ retry, status: s, duration: 100, startedAt: null })),
    error: status === 'failed' ? 'Error: expect(received).toBe(expected)' : null,
    browser: { projectName: 'chromium' },
    ...extra,
  };
}

/** Each execution of a run as `<title> <project>#<repetition>/<retry>: final|earlier`, in a stable order. */
async function finalFlags(runId: number): Promise<string[]> {
  const rows = await db
    .select({
      title: schema.testCases.title,
      browserName: schema.testRunsCases.browserName,
      repeatEachIndex: schema.testRunsCases.repeatEachIndex,
      retries: schema.testRunsCases.retries,
      finalAttempt: schema.testRunsCases.finalAttempt,
    })
    .from(schema.testRunsCases)
    .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testRunsCases.testCaseId))
    .where(eq(schema.testRunsCases.testRunId, runId))
    .orderBy(
      asc(schema.testCases.title),
      asc(schema.testRunsCases.browserName),
      asc(schema.testRunsCases.repeatEachIndex),
      asc(schema.testRunsCases.retries),
    );
  return rows.map(
    (r) => `${r.title} ${r.browserName}#${r.repeatEachIndex}/${r.retries}: ${r.finalAttempt ? 'final' : 'earlier'}`,
  );
}

async function testCaseId(title: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.testCases.id })
    .from(schema.testCases)
    .where(eq(schema.testCases.title, title));
  return row!.id;
}

type Execution = ReturnType<typeof attempt> | Omit<ReturnType<typeof attempt>, 'attempts'>;

/** A streamed run through the server's ingest or the demo's, and how to send it one execution. */
const streams = {
  server: async () => {
    const { runId, streamToken } = await start({ body: { projectName: PROJECT, totalTests: 1 } });
    const send = (tc: Execution) =>
      events({ params: { id: String(runId) }, body: { streamToken, testCases: [{ type: 'complete', ...tc }] } });
    return { runId: runId as number, send };
  },
  demo: async () => {
    const run = { projectName: PROJECT, instanceId: 'ci-run-streamed' };
    const { runId, setupToken } = await apiSetupTestRun(run);
    const { streamToken } = await apiBeginTestRun(runId, { setupToken, totalTests: 1, ...run });
    const send = (tc: Execution) =>
      apiPostRunEvents(runId, { streamToken, testCases: [{ type: 'complete', ...tc } as never] });
    return { runId, send };
  },
};

/**
 * Whether each page reads test `title` flaky in run `runId`, its only run: the test page header and the catalog
 * (`flakyResultSql` on the stored final attempt), the run page (`isFlakyExecution` on the final attempt it lists)
 * and the Trend tab (`finalAttemptsOfRuns`).
 */
async function flakyReadings(runId: number, title: string) {
  const id = await testCaseId(title);
  const header = await getTestCase(db as never, id);
  const catalog = (await getProjectTestCases(db as never, projectId)).items.find((t: any) => t.id === id);
  const run = await getTestRun(db as never, runId);
  const [final] = run!.testCases
    .filter((tc: any) => tc.testCaseId === id)
    .sort((a: any, b: any) => (b.retries ?? 0) - (a.retries ?? 0));
  const trend = await getTestCaseStabilityTrend(db as never, id, { days: 2, granularity: 'day' });
  return {
    header: header!.flakyRuns === 1,
    recent: header!.recentFlakyRuns === 1,
    catalog: catalog?.status === 'flaky',
    runPage: isFlakyExecution(final),
    trend: trend.buckets.filter((b) => b.totalRuns > 0).map((b) => b.flakyRate === 1),
  };
}

/** Every page reading the test flaky, or none. */
function readEverywhere(flaky: boolean) {
  return { header: flaky, recent: flaky, catalog: flaky, runPage: flaky, trend: [flaky] };
}

describe('a batch', () => {
  test("marks each result's last attempt alone, in whatever order it lists them", async () => {
    const { runId } = await submit({
      body: {
        projectName: PROJECT,
        status: 'passed',
        startTime: new Date().toISOString(),
        testCases: [
          attempt('pays', ['failed', 'passed']),
          attempt('pays', ['failed']),
          attempt('pays', ['passed'], { browser: { projectName: 'firefox' } }),
          attempt('lists', ['passed'], { repeatEachIndex: 0 }),
          attempt('lists', ['failed'], { repeatEachIndex: 1 }),
          attempt('lists', ['failed', 'failed'], { repeatEachIndex: 1 }),
        ],
        totalTests: 4,
        passedTests: 3,
        failedTests: 1,
      },
    });
    expect(await finalFlags(runId)).toEqual([
      'lists chromium#0/0: final',
      'lists chromium#1/0: earlier',
      'lists chromium#1/1: final',
      'pays chromium#0/0: earlier',
      'pays chromium#0/1: final',
      'pays firefox#0/0: final',
    ]);
  });

  test('settles a retry the server stores after its first attempt, and a first attempt stored after its retry', async () => {
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId, status: 'running', startTime: new Date() })
      .returning();
    const store = (tc: ReturnType<typeof attempt>) =>
      persistRunCases(db as never, projectId, run!.id, [
        { ...tc, filePath: 'tests/checkout.spec.ts', line: 3, column: 5 },
      ]);
    await store(attempt('pays', ['failed']));
    expect(await finalFlags(run!.id)).toEqual(['pays chromium#0/0: final']);
    await store(attempt('pays', ['failed', 'passed']));
    await store(attempt('refunds', ['failed', 'passed']));
    await store(attempt('refunds', ['failed']));
    expect(await finalFlags(run!.id)).toEqual([
      'pays chromium#0/0: earlier',
      'pays chromium#0/1: final',
      'refunds chromium#0/0: earlier',
      'refunds chromium#0/1: final',
    ]);
  });
});

describe('a streamed run', () => {
  test('settles an attempt once its retry arrives, and an attempt that arrives after its retry', async () => {
    const { runId, streamToken } = await start({ body: { projectName: PROJECT, totalTests: 2 } });
    const send = (tc: ReturnType<typeof attempt>) =>
      events({ params: { id: String(runId) }, body: { streamToken, testCases: [{ type: 'complete', ...tc }] } });

    await send(attempt('pays', ['failed']));
    expect(await finalFlags(runId)).toEqual(['pays chromium#0/0: final']);
    await send(attempt('pays', ['failed', 'passed']));
    await send(attempt('refunds', ['failed', 'passed']));
    await send(attempt('refunds', ['failed']));
    expect(await finalFlags(runId)).toEqual([
      'pays chromium#0/0: earlier',
      'pays chromium#0/1: final',
      'refunds chromium#0/0: earlier',
      'refunds chromium#0/1: final',
    ]);
    expect(await getTestCase(db as never, await testCaseId('pays'))).toMatchObject({ totalRuns: 1, flakyRuns: 1 });
  });
});

/** The import port of the server, storing nothing but the executions. */
const importPort: Parameters<typeof importBlobReportRun>[1] = {
  persistRunCases: (database, project, testRunId, cases, options) =>
    persistRunCases(database as never, project, testRunId, cases as never, options),
  storeFile: async ({ entryName }) => ({ path: `stored/${entryName}`, size: 1 }),
  readTraceConsole: async () => null,
  parseErrorContext: () => ({ ariaSnapshot: null, testSource: null }),
  publishRunSubmitted: () => {},
  publishRollupUpdated: () => {},
};

/** A parsed blob report of one passed run holding `cases`. */
function blobReport(cases: ImportedRunCase[]): ParsedBlobReport {
  return {
    blobVersion: 2,
    playwrightVersion: '1.55.0',
    startTime: new Date('2026-09-30T10:00:00Z'),
    duration: 1000,
    status: 'passed',
    totalTests: 1,
    passedTests: 1,
    failedTests: 0,
    skippedTests: 0,
    didNotRunTests: 0,
    flakyTests: 1,
    shard: null,
    projectNames: ['chromium'],
    scm: null,
    runErrors: [],
    cases,
  };
}

describe('an import', () => {
  const port = importPort;

  test("of a trace makes the run's earlier trace of its test an earlier attempt", async () => {
    const trace = (importHash: string, status: string): Parameters<typeof importTraceRun>[2] => ({
      projectId,
      parsed: {
        case: { title: 'pays', filePath: 'checkout.spec.ts', status, line: 10, column: 5, browser: 'chromium' },
        startedAt: Date.parse('2026-09-30T10:00:00Z'),
        duration: 500,
        playwrightVersion: '1.55.0',
        rawFilePath: 'checkout.spec.ts',
      } satisfies ParsedTraceImport,
      bytes: new TextEncoder().encode(`trace ${importHash}`),
      importHash,
      importGroup: 'a'.repeat(64),
      source: 'trace.zip',
    });
    await importTraceRun(db as never, port, trace('1'.repeat(64), 'failed'));
    const { runId } = await importTraceRun(db as never, port, trace('2'.repeat(64), 'passed'));
    expect(await finalFlags(runId)).toEqual(['pays chromium#0/0: earlier', 'pays chromium#0/1: final']);
  });

  test("of a blob report marks each test's last attempt", async () => {
    const execution = (retries: number, status: string): ImportedRunCase => ({
      case: {
        title: 'pays',
        filePath: 'tests/checkout.spec.ts',
        status,
        retries,
        line: 10,
        column: 5,
        browser: 'chromium',
      },
      traces: [],
      attachments: [],
    });
    const parsed = blobReport([execution(1, 'passed'), execution(0, 'failed')]);
    const { runId } = await importBlobReportRun(db as never, port, {
      projectId,
      parsed,
      readEntry: async (name: string) => new TextEncoder().encode(name),
      importHash: 'b'.repeat(64),
      source: 'report.zip',
    });
    expect(await finalFlags(runId)).toEqual(['pays chromium#0/0: earlier', 'pays chromium#0/1: final']);
  });
});

describe("the demo's ingest", () => {
  test('settles an attempt once its retry arrives, and an attempt that arrives after its retry', async () => {
    const run = { projectName: PROJECT, instanceId: 'ci-run-1' };
    const { runId, setupToken } = await apiSetupTestRun(run);
    const { streamToken } = await apiBeginTestRun(runId, { setupToken, totalTests: 2, ...run });
    const send = (tc: ReturnType<typeof attempt>) =>
      apiPostRunEvents(runId, { streamToken, testCases: [{ type: 'complete', ...tc } as never] });

    await send(attempt('pays', ['failed']));
    expect(await finalFlags(runId)).toEqual(['pays chromium#0/0: final']);
    await send(attempt('pays', ['failed', 'passed']));
    await send(attempt('refunds', ['failed', 'passed']));
    await send(attempt('refunds', ['failed']));
    expect(await finalFlags(runId)).toEqual([
      'pays chromium#0/0: earlier',
      'pays chromium#0/1: final',
      'refunds chromium#0/0: earlier',
      'refunds chromium#0/1: final',
    ]);
  });
});

describe('a retry an older reporter sends without its attempt history', () => {
  /** One attempt as an older reporter sends it: no attempt history. */
  function bare(title: string, statuses: string[]) {
    const { attempts: _history, ...tc } = attempt(title, statuses);
    return tc;
  }

  /** The stored attempt history of each execution of a test, in retry order. */
  async function histories(title: string) {
    const rows = await db
      .select({ attempts: schema.testRunsCases.attempts })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testCaseId, await testCaseId(title)))
      .orderBy(asc(schema.testRunsCases.retries));
    return rows.map((row) => row.attempts);
  }

  test.each([
    ['passed', false],
    ['failed', true],
  ])('after a first attempt that %s, in an earlier batch of a streamed run, reads flaky: %s', async (first, flaky) => {
    const { runId, streamToken } = await start({ body: { projectName: PROJECT, totalTests: 1 } });
    const send = (tc: ReturnType<typeof bare>) =>
      events({ params: { id: String(runId) }, body: { streamToken, testCases: [{ type: 'complete', ...tc }] } });
    await send(bare('pays', [first]));
    await send(bare('pays', [first, 'passed']));

    const id = await testCaseId('pays');
    const runs = flaky ? 1 : 0;
    expect(await getTestCase(db as never, id)).toMatchObject({ totalRuns: 1, flakyRuns: runs, recentFlakyRuns: runs });
    const catalog = await getProjectTestCases(db as never, projectId);
    expect(catalog.items.find((t: any) => t.id === id)).toMatchObject({
      status: flaky ? 'flaky' : 'passed',
      flakyRuns: runs,
    });
    const trend = await getTestCaseStabilityTrend(db as never, id, { days: 2, granularity: 'day' });
    expect(trend.buckets.filter((b) => b.totalRuns > 0)).toMatchObject([{ totalRuns: 1, flakyRate: runs }]);
  });

  test("is given one from the batch's own earlier attempts, and a reported history is kept", async () => {
    const { runId } = await submit({
      body: {
        projectName: PROJECT,
        status: 'passed',
        startTime: new Date().toISOString(),
        testCases: [
          bare('pays', ['passed']),
          bare('pays', ['passed', 'passed']),
          bare('ships', ['failed']),
          attempt('ships', ['failed', 'passed'], {
            attempts: [{ retry: 1, status: 'passed', duration: 7, startedAt: null }],
          }),
        ],
        totalTests: 2,
        passedTests: 2,
      },
    });
    expect(runId).toBeGreaterThan(0);
    expect(await histories('pays')).toEqual([
      null,
      [
        { retry: 0, status: 'passed', duration: 100, startedAt: null },
        { retry: 1, status: 'passed', duration: 100, startedAt: null },
      ],
    ]);
    expect(await histories('ships')).toEqual([null, [{ retry: 1, status: 'passed', duration: 7, startedAt: null }]]);
  });

  test("is given one by the demo's ingest too", async () => {
    const run = { projectName: PROJECT, instanceId: 'ci-run-2' };
    const { runId, setupToken } = await apiSetupTestRun(run);
    const { streamToken } = await apiBeginTestRun(runId, { setupToken, totalTests: 1, ...run });
    const send = (tc: ReturnType<typeof bare>) =>
      apiPostRunEvents(runId, { streamToken, testCases: [{ type: 'complete', ...tc } as never] });
    await send(bare('pays', ['passed']));
    await send(bare('pays', ['passed', 'passed']));
    expect((await histories('pays'))[1]).toHaveLength(2);
    expect(await getTestCase(db as never, await testCaseId('pays'))).toMatchObject({ totalRuns: 1, flakyRuns: 0 });
  });

  describe.each(['server', 'demo'] as const)('and stored before an earlier attempt, by the %s ingest', (ingest) => {
    test('is given one once the earlier attempt is stored', async () => {
      const { runId, send } = await streams[ingest]();
      await send(bare('pays', ['passed', 'passed']));
      await send(bare('pays', ['passed']));

      expect(await histories('pays')).toEqual([
        null,
        [
          { retry: 0, status: 'passed', duration: 100, startedAt: null },
          { retry: 1, status: 'passed', duration: 100, startedAt: null },
        ],
      ]);
      expect(await flakyReadings(runId, 'pays')).toEqual(readEverywhere(false));
    });

    test('has its history completed by an attempt stored between', async () => {
      const { runId, send } = await streams[ingest]();
      await send(bare('pays', ['passed']));
      await send(bare('pays', ['passed', 'failed', 'passed']));
      await send(bare('pays', ['passed', 'failed']));

      expect((await histories('pays'))[2]).toEqual([
        { retry: 0, status: 'passed', duration: 100, startedAt: null },
        { retry: 1, status: 'failed', duration: 100, startedAt: null },
        { retry: 2, status: 'passed', duration: 100, startedAt: null },
      ]);
      expect(await flakyReadings(runId, 'pays')).toEqual(readEverywhere(true));
    });

    test('keeps a history the reporter sent whole', async () => {
      const { runId, send } = await streams[ingest]();
      const whole = [
        { retry: 0, status: 'failed', duration: 7, startedAt: null },
        { retry: 1, status: 'passed', duration: 7, startedAt: null },
      ];
      await send(attempt('pays', ['failed', 'passed'], { attempts: whole }));
      await send(bare('pays', ['failed']));

      expect((await histories('pays'))[1]).toEqual(whole);
      expect(await flakyReadings(runId, 'pays')).toEqual(readEverywhere(true));
    });
  });
});

describe('a batch sent again after its request failed past its insert', () => {
  describe.each(['server', 'demo'] as const)('by the %s ingest', (ingest) => {
    test('settles the final attempt it stored', async () => {
      const { runId, send } = await streams[ingest]();
      await send(attempt('pays', ['failed']));
      failing.settles = 1;
      await expect(send(attempt('pays', ['failed', 'passed']))).rejects.toThrow('SQLITE_BUSY');
      await send(attempt('pays', ['failed', 'passed']));

      expect(await finalFlags(runId)).toEqual(['pays chromium#0/0: earlier', 'pays chromium#0/1: final']);
      expect(await getTestCase(db as never, await testCaseId('pays'))).toMatchObject({
        totalRuns: 1,
        passedRuns: 1,
        failedRuns: 0,
        flakyRuns: 1,
      });
      expect(await flakyReadings(runId, 'pays')).toEqual(readEverywhere(true));
    });

    test('completes the history of a later retry stored before it', async () => {
      const bare = (statuses: string[]) => {
        const { attempts: _history, ...tc } = attempt('pays', statuses);
        return tc;
      };
      const { runId, send } = await streams[ingest]();
      await send(bare(['passed']));
      await send(bare(['passed', 'failed', 'passed']));
      failing.settles = 1;
      await expect(send(bare(['passed', 'failed']))).rejects.toThrow('SQLITE_BUSY');
      await send(bare(['passed', 'failed']));

      expect(await finalFlags(runId)).toEqual([
        'pays chromium#0/0: earlier',
        'pays chromium#0/1: earlier',
        'pays chromium#0/2: final',
      ]);
      expect(await flakyReadings(runId, 'pays')).toEqual(readEverywhere(true));
    });
  });
});

/** Each execution of test `title` in run `runId` as `<retry>: <passed after a failure>`, in retry order. */
async function verdicts(runId: number, title: string): Promise<string[]> {
  const rows = await db
    .select({ retries: schema.testRunsCases.retries, verdict: schema.testRunsCases.passedAfterFailure })
    .from(schema.testRunsCases)
    .where(and(eq(schema.testRunsCases.testRunId, runId), eq(schema.testRunsCases.testCaseId, await testCaseId(title))))
    .orderBy(asc(schema.testRunsCases.retries));
  return rows.map((r) => `${r.retries}: ${r.verdict}`);
}

/** The attempts of one test as a run reports them, and whether its result passed after a failure. */
const VERDICT_CASES: Array<[string, string[], boolean]> = [
  ['a serial group retried for another test, passed twice', ['passed', 'passed'], false],
  ['a test that did not run, then passed', ['didnotrun', 'passed'], false],
  ['a test skipped, then passed', ['skipped', 'passed'], false],
  ['a test that failed, then passed', ['failed', 'passed'], true],
  ['a test that timed out, then passed', ['timedOut', 'passed'], true],
];

describe('the verdict each execution stores', () => {
  /** Each attempt of `statuses`, with its history up to it, or without one as an older reporter sends it. */
  const attemptsOf = (statuses: string[], history: boolean) =>
    statuses.map((_, retry) => {
      const tc = attempt('pays', statuses.slice(0, retry + 1));
      if (history) return tc;
      const { attempts: _history, ...bare } = tc;
      return bare;
    });

  describe.each(['server', 'demo'] as const)('by the %s ingest of a streamed run', (ingest) => {
    test.each(VERDICT_CASES)('%s, with or without its history', async (_name, statuses, flaky) => {
      for (const history of [true, false]) {
        const { runId, send } = await streams[ingest]();
        for (const tc of attemptsOf(statuses, history)) await send(tc);
        expect(await verdicts(runId, 'pays')).toEqual(['0: false', `1: ${flaky}`]);
        expect(await flakyReadings(runId, 'pays')).toEqual(readEverywhere(flaky));
        await db.delete(schema.testRuns).where(eq(schema.testRuns.id, runId));
      }
    });

    test('of a final attempt stored before its failed one', async () => {
      const { runId, send } = await streams[ingest]();
      const [first, retry] = attemptsOf(['failed', 'passed'], false);
      await send(retry!);
      await send(first!);
      expect(await verdicts(runId, 'pays')).toEqual(['0: false', '1: true']);
    });

    test('of a retry stored before an earlier attempt that passed', async () => {
      const { runId, send } = await streams[ingest]();
      const [first, retry] = attemptsOf(['passed', 'passed'], false);
      await send(retry!);
      expect(await verdicts(runId, 'pays')).toEqual(['1: true']);
      await send(first!);
      expect(await verdicts(runId, 'pays')).toEqual(['0: false', '1: false']);
      expect(await flakyReadings(runId, 'pays')).toEqual(readEverywhere(false));
    });
  });

  test.each(VERDICT_CASES)('by a batch: %s', async (_name, statuses, flaky) => {
    const { runId } = await submit({
      body: {
        projectName: PROJECT,
        status: 'passed',
        startTime: new Date().toISOString(),
        testCases: attemptsOf(statuses, false),
        totalTests: 1,
        passedTests: 1,
      },
    });
    expect(await verdicts(runId, 'pays')).toEqual(['0: false', `1: ${flaky}`]);
    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
    expect(run!.flakyTests).toBe(flaky ? 1 : 0);
  });

  test.each(VERDICT_CASES)(
    'by a batch of final attempts only, with their history: %s',
    async (_name, statuses, flaky) => {
      const { runId } = await submit({
        body: {
          projectName: PROJECT,
          status: 'passed',
          startTime: new Date().toISOString(),
          testCases: [attempt('pays', statuses)],
          totalTests: 1,
          passedTests: 1,
        },
      });
      expect(await verdicts(runId, 'pays')).toEqual([`1: ${flaky}`]);
      const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
      expect(run!.flakyTests).toBe(flaky ? 1 : 0);
    },
  );

  test.each(VERDICT_CASES)('by a blob import: %s', async (_name, statuses, flaky) => {
    const { runId } = await importBlobReportRun(db as never, importPort, {
      projectId,
      parsed: blobReport(
        statuses.map((status, retries) => ({
          case: {
            title: 'pays',
            filePath: 'tests/checkout.spec.ts',
            status,
            retries,
            line: 10,
            column: 5,
            browser: 'chromium',
          },
          traces: [],
          attachments: [],
        })),
      ),
      readEntry: async (name: string) => new TextEncoder().encode(name),
      importHash: 'c'.repeat(64),
      source: 'report.zip',
    });
    expect(await verdicts(runId, 'pays')).toEqual(['0: false', `1: ${flaky}`]);
  });

  test.each(VERDICT_CASES)('by a trace import: %s', async (_name, statuses, flaky) => {
    let runId = 0;
    for (const [i, status] of statuses.entries()) {
      ({ runId } = await importTraceRun(db as never, importPort, {
        projectId,
        parsed: {
          case: { title: 'pays', filePath: 'checkout.spec.ts', status, line: 10, column: 5, browser: 'chromium' },
          startedAt: Date.parse('2026-09-30T10:00:00Z') + i * 1000,
          duration: 500,
          playwrightVersion: '1.55.0',
          rawFilePath: 'checkout.spec.ts',
        } satisfies ParsedTraceImport,
        bytes: new TextEncoder().encode(`trace ${i}`),
        importHash: String(i + 1).repeat(64),
        importGroup: 'd'.repeat(64),
        source: 'trace.zip',
      }));
    }
    expect(await verdicts(runId, 'pays')).toEqual(['0: false', `1: ${flaky}`]);
  });
});

const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));

describe('the final-attempt backfill', () => {
  test('marks the executions stored before it as finalAttempts reads them', async () => {
    const client = createClient({ url: ':memory:' });
    const migrated = drizzle(client, { schema });
    await migrateToLatest(migrated);
    await migrated.insert(schema.projects).values({ id: 1, name: 'backfill' });
    await migrated.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'a' },
      { id: 2, projectId: 1, filePath: 'b.spec.ts', title: 'b' },
    ]);
    await migrated
      .insert(schema.testRuns)
      .values([1, 2].map((id) => ({ id, projectId: 1, status: 'passed', startTime: new Date() })));
    await migrated
      .insert(schema.testRunsCases)
      .values(STORED_ATTEMPTS.map((row, i) => ({ ...row, id: i + 1, status: 'passed', finalAttempt: true })));

    await client.executeMultiple(finalAttemptBackfillSql(join(APP_DIR, 'server/database/migrations')));

    const rows = await migrated
      .select({ finalAttempt: schema.testRunsCases.finalAttempt })
      .from(schema.testRunsCases)
      .orderBy(asc(schema.testRunsCases.id));
    expect(rows.map((row) => row.finalAttempt)).toEqual(expectedFinalFlags());
  });
});

/** The TypeScript files of the code that writes executions: the server, the shared handlers and the demo. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) ? [path] : [];
  });
}

describe('the code that writes executions', () => {
  test('fills in the attempt histories and settles the final attempts of what it wrote', () => {
    const unsettled = ['server', 'shared', 'app/demo']
      .flatMap((dir) => sourceFiles(join(APP_DIR, dir)))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return (
          /\.insert\((?:schema\.)?testRunsCases\)/.test(text) &&
          !(text.includes('fillAttemptHistories(') && text.includes('settleFinalAttempts('))
        );
      })
      .map((file) => relative(APP_DIR, file));
    expect(unsettled).toEqual([]);
  });
});

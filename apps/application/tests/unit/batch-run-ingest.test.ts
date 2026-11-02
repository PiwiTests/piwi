import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { multipartEvent, type MultipartPart } from './multipart-event';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown, stored: new Map<string, Buffer>() }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db, getDialect: () => 'sqlite' }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  isAuthEnabled: () => false,
}));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    mkdir: async () => {},
    writeFile: async (path: string, data: Buffer) => void state.stored.set(path, data),
    deleteFile: async (path: string) => void state.stored.delete(path),
    deleteDirectory: async (path: string) => {
      for (const key of [...state.stored.keys()]) if (key.startsWith(`${path}/`)) state.stored.delete(key);
    },
  }),
}));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));
vi.mock('../../server/utils/persist-run-cases', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/persist-run-cases')>();
  return { ...mod, persistRunCases: vi.fn(mod.persistRunCases) };
});

interface RouteEvent {
  body: Record<string, unknown>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

type Route = (event: unknown) => Promise<Record<string, any>>;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const uploadRoute = (await import('../../server/api/test-runs/upload.post')).default as unknown as Route;
const upload = (parts: MultipartPart[]) => uploadRoute(multipartEvent(parts));
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { serializeRun } = await import('../../../../packages/reporter/src/internal/submit/serializer');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'batch-ingest';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  state.stored.clear();
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  testCaseCache.invalidate(project!.id);
  testSuiteCache.invalidate(project!.id);
  vi.mocked(persistRunCases).mockClear();
});

const field = (name: string, value: unknown): MultipartPart => ({
  name,
  data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});

/** A run of one passed test, as the reporter's batch body carries it. */
function runBody(extra: Record<string, unknown> = {}) {
  return {
    projectName: PROJECT,
    status: 'passed',
    startTime: '2026-10-31T23:00:00.000Z',
    duration: 1000,
    totalTests: 1,
    passedTests: 1,
    testCases: [{ title: 'pays', location: 'tests/pay.spec.ts:3:1', status: 'passed', duration: 10 }],
    ...extra,
  };
}

describe('a batch body', () => {
  test('as the reporter serializes it is stored, null and older-reporter fields included', async () => {
    const payload = {
      projectName: PROJECT,
      status: 'failed',
      startTime: '2026-10-31T23:00:00.000Z',
      duration: 1000,
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      skippedTests: 0,
      environment: undefined,
      metadata: { scm: { branch: 'main' } },
      instanceId: 'ci-1',
      testCases: [
        { title: 'pays', location: 'tests/pay.spec.ts:3:1', status: 'passed', duration: 10, retries: 0 },
        {
          title: 'refunds',
          location: 'tests/pay.spec.ts:9:1',
          status: 'timedOut',
          duration: 30_000,
          retries: 0,
          error: 'Test timeout of 30000ms exceeded.',
          browser: { projectName: 'chromium', browserName: 'chromium' },
          suitePath: ['payments'],
        },
      ],
    };
    const body = serializeRun(payload as never, { includeTestCases: true });
    // An older reporter named the browser by its project alone.
    (body.testCases as Array<Record<string, unknown>>)[0]!.browser = 'chromium';

    const { runId } = await submit({ body });
    expect(await db.select().from(schema.testRunsCases)).toHaveLength(2);
    const { testCases, projectName, ...testRun } = body;
    await upload([field('projectName', projectName), field('testRun', testRun), field('testCases', testCases)]);
    expect((await db.select().from(schema.testRuns)).map((run) => run.id)).toContain(runId);
    expect(await db.select().from(schema.testRunsCases)).toHaveLength(4);
  });

  test('with a test of an empty title is stored, as Playwright runs it', async () => {
    await submit({
      body: runBody({ testCases: [{ title: '', location: 'tests/pay.spec.ts:3:1', status: 'passed' }] }),
    });
    expect(await db.select().from(schema.testRunsCases)).toHaveLength(1);
  });

  test.each([
    ['testCases', { testCases: 'nope' }],
    ['status', { status: 'exploded' }],
    ['startTime', { startTime: 'not a date' }],
    ['duration', { duration: '1000' }],
    ['metadata', { metadata: 'ci' }],
    ['testCases[0]', { testCases: [null] }],
    ['testCases[0].title', { testCases: [{ location: 'tests/pay.spec.ts:3:1', status: 'passed' }] }],
    ['testCases[0].startedAt', { testCases: [{ title: 'pays', status: 'passed', startedAt: {} }] }],
    ['testCases[0].error', { testCases: [{ title: 'pays', status: 'failed', error: { message: 'boom' } }] }],
    ['testCases[0].suitePath', { testCases: [{ title: 'pays', status: 'passed', suitePath: 'payments' }] }],
  ])('with a wrong %s answers 400 naming it and stores nothing', async (name, extra) => {
    await expect(submit({ body: runBody(extra) })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(`Invalid ${name} (`),
    });
    expect(await db.select().from(schema.testRuns)).toEqual([]);
  });

  test('of /upload answers 400 naming the field of its testRun or testCases that is wrong, and stores nothing', async () => {
    const { testCases, projectName, ...testRun } = runBody();
    const send = (run: unknown, cases: unknown) =>
      upload([field('projectName', projectName), field('testRun', run), field('testCases', cases)]);

    await expect(send({ ...testRun, status: 'exploded' }, testCases)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Invalid testRun.status ('),
    });
    await expect(
      send(testRun, [...testCases, { title: 'adds', status: 'passed', retries: 'one' }]),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Invalid testCases[1].retries (') });
    expect(await db.select().from(schema.testRuns)).toEqual([]);
  });
});

describe("a batch run's suite setup steps", () => {
  const setupSteps = [
    { title: 'beforeAll hook', category: 'hook', startedAt: 1_793_000_000_000, duration: 1200, status: 'passed' },
  ];

  test('are stored from /submit and from /upload, as from /finish', async () => {
    const { runId: submitted } = await submit({ body: runBody({ setupSteps }) });
    const { testCases, projectName, ...testRun } = runBody({ setupSteps });
    const { runId: uploaded } = await upload([
      field('projectName', projectName),
      field('testRun', testRun),
      field('testCases', testCases),
    ]);

    const runs = await db
      .select({ id: schema.testRuns.id, setupSteps: schema.testRuns.setupSteps })
      .from(schema.testRuns);
    expect(runs).toEqual([
      { id: submitted, setupSteps },
      { id: uploaded, setupSteps },
    ]);
  });

  test("are stored from a shard's batch submission", async () => {
    const shard = (shardIndex: number) =>
      runBody({ setupSteps, instanceId: 'ci-9', shardIndex, shardTotal: 2, deliveryKey: undefined });
    const { runId } = await submit({ body: shard(1) });
    await submit({ body: shard(2) });

    const [run] = await db.select({ setupSteps: schema.testRuns.setupSteps }).from(schema.testRuns);
    expect(run).toEqual({ setupSteps });
    expect(runId).toBeGreaterThan(0);
  });
});

describe('a batch whose executions cannot be stored', () => {
  test('leaves no run from /submit, so the delivery sent again stores one run', async () => {
    const body = runBody({ deliveryKey: 'c0ffee00-0000-4000-8000-00000000000a' });
    vi.mocked(persistRunCases).mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    await expect(submit({ body })).rejects.toThrow('database is locked');
    expect(await db.select().from(schema.testRuns)).toEqual([]);

    const { runId } = await submit({ body });
    expect((await db.select().from(schema.testRuns)).map((run) => run.id)).toEqual([runId]);
    expect(await db.select().from(schema.testRunsCases)).toHaveLength(1);
  });

  test('leaves no run from /upload, nor the report it stored', async () => {
    const { testCases, projectName, ...testRun } = runBody();
    vi.mocked(persistRunCases).mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    await expect(
      upload([
        field('projectName', projectName),
        field('testRun', testRun),
        field('testCases', testCases),
        { name: 'htmlReport', filename: 'report.zip', data: Buffer.from('zip') },
      ]),
    ).rejects.toThrow('database is locked');

    expect(await db.select().from(schema.testRuns)).toEqual([]);
    expect(await db.select().from(schema.files)).toEqual([]);
    expect([...state.stored.keys()]).toEqual([]);
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq, ne } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { multipartEvent, type MultipartPart } from './multipart-event';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  isAuthEnabled: () => false,
}));
vi.mock('../../server/storage', () => ({ getStorage: () => ({ mkdir: async () => {}, writeFile: async () => {} }) }));
vi.mock('../../server/utils/trace-blobs', () => ({ upsertTraceBlob: vi.fn(), findTraceBlob: vi.fn() }));
vi.mock('../../server/utils/trace-fallback-evidence', () => ({ deriveTraceEvidence: vi.fn() }));
const runFinalizeSideEffects = vi.fn(async (_db: unknown, _id: number, _run: unknown) => {});
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects }));

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

type Handler = (event: FakeEvent) => Promise<{ status?: string }>;
const finish = (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Handler;
const uploadRoute = (await import('../../server/api/test-runs/upload.post')).default as unknown as (
  event: unknown,
) => Promise<unknown>;
const upload = ({ parts }: { parts: MultipartPart[] }) => uploadRoute(multipartEvent(parts));
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Handler;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Handler;
const uploadResults = (await import('../../server/api/test-runs/upload/results.post')).default as unknown as Handler;
const { settleFinalizingRun } = await import('../../server/utils/finalizing-runs');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
const lastEvent = new Date('2026-09-30T09:00:00Z');

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  runFinalizeSideEffects.mockClear();
  await db.insert(schema.projects).values({ id: 1, name: 'finalizing-project' });
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'running',
    startTime: new Date('2026-09-30T08:55:00Z'),
    updatedAt: lastEvent,
    streamToken: 'stream-token',
    metadata: { baseUrl: 'https://app.test' },
  });
});

const runRow = async () => (await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, 1)))[0]!;

const field = (name: string, value: unknown) => ({
  name,
  data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});

const finishWithPendingUploads = (body: Record<string, unknown> = {}) =>
  finish({
    params: { id: '1' },
    body: { streamToken: 'stream-token', status: 'passed', hasPendingUploads: true, totalTests: 1, ...body },
  });

describe('a run finishing with its report upload pending', () => {
  test('/finish stores the reported status on the run, beside its metadata', async () => {
    const result = await finishWithPendingUploads({ metadata: { ci: { provider: 'github' } } });

    const run = await runRow();
    expect(result.status).toBe('finalizing');
    expect(run.status).toBe('finalizing');
    expect(run.metadata).toEqual({ ci: { provider: 'github' }, pendingStatus: 'passed' });
    // The wait for the upload is measured from the finish, not from the last event.
    expect(run.updatedAt!.getTime()).toBeGreaterThan(lastEvent.getTime());
  });

  test('/finish without metadata keeps the metadata the run already has', async () => {
    await finishWithPendingUploads();

    expect((await runRow()).metadata).toEqual({ baseUrl: 'https://app.test', pendingStatus: 'passed' });
  });

  test('the report upload settles the run to the stored status, with the finish-time side effects', async () => {
    await finishWithPendingUploads({ metadata: { ci: { provider: 'github' } } });

    await upload({
      parts: [
        field('runId', '1'),
        field('projectName', 'finalizing-project'),
        field('testRun', { status: 'passed', startTime: '2026-09-30T08:55:00Z' }),
      ],
    });

    const run = await runRow();
    expect(run.status).toBe('passed');
    expect(run.metadata).toEqual({ ci: { provider: 'github' } });
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
    expect(runFinalizeSideEffects.mock.calls[0]![1]).toBe(1);
  });

  test('an upload after the run was settled leaves its status and fires nothing again', async () => {
    await finishWithPendingUploads({ status: 'failed' });
    await settleFinalizingRun(db as never, { id: 1, projectId: 1, metadata: (await runRow()).metadata });
    runFinalizeSideEffects.mockClear();

    await upload({
      parts: [
        field('runId', '1'),
        field('projectName', 'finalizing-project'),
        field('testRun', { status: 'failed', startTime: '2026-09-30T08:55:00Z' }),
      ],
    });

    expect((await runRow()).status).toBe('failed');
    expect(runFinalizeSideEffects).not.toHaveBeenCalled();
  });

  test('when the upload and the stale-run sweep settle the run at once, only one of them does', async () => {
    await finishWithPendingUploads();
    const { metadata } = await runRow();

    const results = await Promise.all([
      settleFinalizingRun(db as never, { id: 1, projectId: 1, metadata }),
      settleFinalizingRun(db as never, { id: 1, projectId: 1, metadata }),
    ]);

    expect(results.filter((status) => status !== null)).toEqual(['passed']);
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });
});

describe('a finalizing run when another run of its instance starts', () => {
  const reportUpload = () =>
    upload({
      parts: [
        field('runId', '1'),
        field('projectName', 'finalizing-project'),
        field('testRun', { status: 'passed', startTime: '2026-09-30T08:55:00Z' }),
      ],
    });

  beforeEach(async () => {
    await db.update(schema.testRuns).set({ instanceId: 'ci-42' }).where(eq(schema.testRuns.id, 1));
  });

  test.each([
    [
      'a streamed run',
      () =>
        start({ body: { projectName: 'finalizing-project', instanceId: 'ci-42', startTime: '2026-09-30T09:01:00Z' } }),
    ],
    [
      'a batch',
      () =>
        submit({
          body: {
            projectName: 'finalizing-project',
            instanceId: 'ci-42',
            status: 'passed',
            startTime: '2026-09-30T09:01:00Z',
          },
        }),
    ],
  ])('keeps its results: %s of the instance leaves it to its report upload', async (_other, other) => {
    await finishWithPendingUploads();

    await other();
    expect((await runRow()).status).toBe('finalizing');

    await reportUpload();
    expect((await runRow()).status).toBe('passed');
  });
});

describe('the batch upload a streamed run fell back to after its /finish', () => {
  /** The run's results as a batch delivery sends them, naming the run it streamed with `replacesRun`. */
  const batchRun = (replacesRun: unknown) => ({
    projectName: 'finalizing-project',
    instanceId: 'ci-42',
    status: 'passed',
    startTime: '2026-09-30T08:55:00Z',
    totalTests: 1,
    passedTests: 1,
    testCases: [],
    deliveryKey: 'delivery-key-of-the-batch-0001',
    ...(replacesRun === undefined ? {} : { replacesRun }),
  });

  const deliveries: Array<[string, (body: Record<string, unknown>) => Promise<unknown>]> = [
    ['/submit', (body) => submit({ body })],
    ['/upload/results', (body) => uploadResults({ body })],
    [
      '/upload',
      ({ testCases, ...testRun }) =>
        upload({
          parts: [field('projectName', 'finalizing-project'), field('testRun', testRun), field('testCases', testCases)],
        }),
    ],
  ];

  const otherRuns = () => db.select().from(schema.testRuns).where(ne(schema.testRuns.id, 1));

  beforeEach(async () => {
    await db.update(schema.testRuns).set({ instanceId: 'ci-42' }).where(eq(schema.testRuns.id, 1));
  });

  test.each(deliveries)(
    'a batch through %s that names the run with its stream token replaces it, finalizing as it is',
    async (_route, deliver) => {
      // The dashboard holds the run for its reports, but the answer to its /finish never reaches the reporter.
      await finishWithPendingUploads();

      await deliver(batchRun({ runId: 1, streamToken: 'stream-token' }));

      const replaced = await runRow();
      expect(replaced.status).toBe('cancelled');
      expect(replaced.streamToken).toBeNull();
      expect(await otherRuns()).toHaveLength(1);
      expect(runFinalizeSideEffects.mock.calls.map((call) => call[1])).not.toContain(1);
    },
  );

  test.each(deliveries)('a batch through %s with another token leaves the run to settle', async (_route, deliver) => {
    await finishWithPendingUploads();

    await deliver(batchRun({ runId: 1, streamToken: 'another-token' }));
    await deliver(batchRun(undefined));

    expect((await runRow()).status).toBe('finalizing');
  });

  test('a batch never replaces a sharded run, which its other shards share', async () => {
    await db.update(schema.testRuns).set({ shardTotal: 2, shardsFinished: 0 }).where(eq(schema.testRuns.id, 1));

    await submit({ body: { ...batchRun({ runId: 1, streamToken: 'stream-token' }), instanceId: 'ci-43' } });

    expect((await runRow()).status).toBe('running');
  });
});

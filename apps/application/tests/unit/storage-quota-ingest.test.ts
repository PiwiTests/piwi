/**
 * The storage quota at ingest: the size of the results each request brings joins its run's `results_bytes`, which the
 * storage total counts; at the quota every file is refused and results still come in, and past its ceiling every
 * request that would create a run is refused while the runs in progress go on.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { multipartEvent, type MultipartPart } from './multipart-event';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown, written: new Map<string, Buffer>() }));
vi.mock('../../server/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/database')>()),
  getDatabase: async () => state.db,
  getDialect: () => 'sqlite',
}));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  isAuthEnabled: () => false,
}));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    mkdir: async () => {},
    writeFile: async (path: string, data: Buffer) => void state.written.set(path, data),
  }),
}));
vi.mock('../../server/utils/trace-fallback-evidence', () => ({ deriveTraceEvidence: vi.fn() }));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/graph-ingest')>();
  return { ...mod, ingestRunGraph: async () => {}, ingestRequestGraph: async () => {} };
});

interface RouteEvent {
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', (event: RouteEvent, name: string) => event.headers?.[name]);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

type Route = (event: unknown) => Promise<Record<string, any>>;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const results = (await import('../../server/api/test-runs/upload/results.post')).default as unknown as Route;
const upload = (await import('../../server/api/test-runs/upload.post')).default as unknown as Route;
const events = (await import('../../server/api/test-runs/[id]/events.post')).default as unknown as Route;
const setup = (await import('../../server/api/test-runs/setup.post')).default as unknown as Route;
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const caseFiles = (await import('../../server/api/test-runs/[id]/case-files.post')).default as unknown as Route;
const begin = (await import('../../server/api/test-runs/[id]/begin.post')).default as unknown as Route;
const heartbeat = (await import('../../server/api/test-runs/[id]/heartbeat.post')).default as unknown as Route;
const finish = (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Route;
const { streamTokenDigest } = await import('../../server/utils/shard-tokens');
const { storageQuotaState, storageUsedBytes } = await import('../../server/utils/storage-quota');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'storage-quota-ingest';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  state.written.clear();
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
});

const testCase = (title: string, status = 'passed') => ({
  title,
  status,
  location: `tests/${title}.spec.ts:3:1`,
  duration: 20,
  retries: 0,
  browser: { name: 'chromium', projectName: 'chromium' },
});

/** A run's results, as the reporter sends them in one JSON body. */
const runResults = (overrides: Record<string, unknown> = {}) => ({
  projectName: PROJECT,
  status: 'passed',
  startTime: '2026-11-02T10:00:00Z',
  duration: 60_000,
  totalTests: 1,
  passedTests: 1,
  testCases: [testCase('pays')],
  ...overrides,
});

/** A JSON request, with the `Content-Length` the body-limit middleware requires. */
const json = (body: unknown, extra: Partial<RouteEvent> = {}): RouteEvent => ({
  body,
  ...extra,
  headers: { 'content-length': String(Buffer.byteLength(JSON.stringify(body))), ...extra.headers },
});

const field = (name: string, value: unknown): MultipartPart => ({
  name,
  data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});

const resultsBytesOf = async (runId: number) =>
  (await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId)))[0]!.resultsBytes;

describe('the results each request brings count toward the storage quota', () => {
  test('a submitted run counts its body', async () => {
    const request = json(runResults());
    const { runId } = await submit(request);
    expect(await resultsBytesOf(runId)).toBe(Number(request.headers!['content-length']));
    expect(await storageUsedBytes(db as never)).toBe(Number(request.headers!['content-length']));
  });

  test('a sharded run adds up the bodies of its shards', async () => {
    const shard = (shardIndex: number) => json(runResults({ instanceId: 'ci-9', shardTotal: 2, shardIndex }));
    const first = shard(1);
    const second = shard(2);
    const { runId } = await submit(first);
    expect((await submit(second)).runId).toBe(runId);
    expect(await resultsBytesOf(runId)).toBe(
      Number(first.headers!['content-length']) + Number(second.headers!['content-length']),
    );
  });

  test('results sent ahead of their files count their body', async () => {
    const request = json(runResults({ deliveryKey: 'delivery-key-of-the-run-0001' }));
    const { runId } = await results(request);
    expect(await resultsBytesOf(runId)).toBe(Number(request.headers!['content-length']));
  });

  test('an upload counts its results fields, not its files', async () => {
    const { projectName, testCases, ...run } = runResults();
    const parts = [field('projectName', projectName), field('testRun', run), field('testCases', testCases)];
    const { runId } = await upload(
      multipartEvent([...parts, { name: 'report_custom', filename: 'report.txt', data: Buffer.alloc(5000) }]),
    );
    expect(await resultsBytesOf(runId)).toBe(parts[1]!.data.length + parts[2]!.data.length);
  });

  test('a streamed run adds each events batch that stores results', async () => {
    const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
    const [run] = await db
      .insert(schema.testRuns)
      .values({
        projectId: project!.id,
        status: 'running',
        startTime: new Date(),
        streamToken: streamTokenDigest('the-stream-token'),
      })
      .returning();
    const batch = (type: string) =>
      json(
        { streamToken: 'the-stream-token', testCases: [{ ...testCase('pays'), type }] },
        { params: { id: String(run!.id) } },
      );
    await events(batch('begin'));
    expect(await resultsBytesOf(run!.id)).toBe(0);
    const complete = batch('complete');
    await events(complete);
    expect(await resultsBytesOf(run!.id)).toBe(Number(complete.headers!['content-length']));
  });
});

const QUOTA = 10 * 1024 * 1024;

/** The stored bytes, as the triggers would have counted them. */
const storeBytes = (bytes: number) => db.update(schema.storageTotals).set({ bytes });

/** Over the quota, the ceiling taken from the bytes stored then, and past it when `pastCeiling`. */
async function goOver({ pastCeiling = false } = {}) {
  await storeBytes(QUOTA);
  await storageQuotaState(db as never);
  if (pastCeiling) await storeBytes(QUOTA * 1.2);
}

const runsOf = () => db.select().from(schema.testRuns);

/** One test's screenshot, sent to a run as the reporter sends a test's files. */
const sendScreenshot = (runId: number, streamToken: string) =>
  caseFiles({
    params: { id: String(runId) },
    ...multipartEvent([
      field('streamToken', streamToken),
      field('testCase', {
        title: 'pays',
        location: 'tests/pays.spec.ts:3:1',
        retries: 0,
        repeatEachIndex: 0,
        suitePath: null,
        projectName: 'chromium',
      }),
      field('attach_meta', [{ name: 'screenshot', contentType: 'image/png', originalName: 'pays.png' }]),
      { name: 'attach_file', filename: 'pays.png', data: Buffer.from('pays screenshot') },
    ]),
  });

/** A whole run in one upload: its results, a trace, a screenshot and a report. */
const uploadWholeRun = (overrides: Record<string, unknown> = {}) => {
  const { projectName, testCases, ...run } = runResults(overrides);
  return upload(
    multipartEvent([
      field('projectName', projectName),
      field('testRun', run),
      field('testCases', testCases),
      { name: 'trace_0', filename: 'trace.zip', data: Buffer.from('not really a zip') },
      field('attach_meta_0', [{ name: 'screenshot', contentType: 'image/png', originalName: 'pays.png' }]),
      { name: 'attach_file_0', filename: 'pays.png', data: Buffer.from('pays screenshot') },
      { name: 'report_custom', filename: 'report.txt', data: Buffer.from('the report') },
    ]),
  );
};

describe('the storage quota at ingest', () => {
  beforeEach(() => {
    vi.stubEnv('PIWI_STORAGE_QUOTA_BYTES', String(QUOTA));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('at the quota, a test’s files are refused before any is stored, and its results still come in', async () => {
    const { runId, streamToken } = await results(json(runResults({ deliveryKey: 'delivery-key-of-the-run-0001' })));
    await goOver();

    await expect(sendScreenshot(runId, streamToken)).rejects.toMatchObject({
      statusCode: 409,
      data: { errorCode: 'STORAGE_QUOTA_FILES_REFUSED' },
      message: 'The storage quota is reached: files are not kept, results are.',
    });
    expect(state.written.size).toBe(0);
    // A wrong token still answers as it does below the quota.
    await expect(sendScreenshot(runId, 'not-the-token')).rejects.toMatchObject({ statusCode: 403 });

    expect(await submit(json(runResults({ instanceId: 'ci-2' })))).toMatchObject({ success: true });
    expect(await runsOf()).toHaveLength(2);
  });

  test('at the quota, an upload stores its results, skips every file and says how many, by kind on the run', async () => {
    await goOver();
    const answer = await uploadWholeRun();

    expect(answer).toMatchObject({
      success: true,
      reports: [],
      filesNotKept: { count: 3, errorCode: 'STORAGE_QUOTA_FILES_REFUSED' },
    });
    expect(await db.select().from(schema.testRunsCases)).toHaveLength(1);
    expect(await db.select().from(schema.files)).toEqual([]);
    expect(state.written.size).toBe(0);
    const [run] = await runsOf();
    expect((run!.metadata as Record<string, unknown>).ingestHealth).toEqual({
      tracesNotKept: 1,
      attachmentsNotKept: 1,
      reportsNotKept: 1,
    });
  });

  test('at the quota, the report of a held run is not kept, and the run settles all the same', async () => {
    const { runId } = await results(json(runResults({ deliveryKey: 'delivery-key-of-the-run-0002' })));
    await goOver();
    const answer = await upload(
      multipartEvent([
        field('runId', String(runId)),
        field('projectName', PROJECT),
        field('testRun', { status: 'already-submitted', startTime: '2026-11-02T10:00:00Z' }),
        { name: 'report_custom', filename: 'report.txt', data: Buffer.from('the report') },
      ]),
    );

    expect(answer).toMatchObject({ runId, filesNotKept: { count: 1, errorCode: 'STORAGE_QUOTA_FILES_REFUSED' } });
    const [run] = await runsOf();
    expect(run).toMatchObject({ status: 'passed', metadata: { ingestHealth: { reportsNotKept: 1 } } });
  });

  test('past the ceiling, every request that would create a run is refused, and the runs in progress go on', async () => {
    const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
    const [streaming] = await db
      .insert(schema.testRuns)
      .values({
        projectId: project!.id,
        status: 'running',
        startTime: new Date(),
        instanceId: 'ci-1',
        streamToken: streamTokenDigest('the-stream-token'),
      })
      .returning();
    const delivered = await submit(
      json(runResults({ instanceId: 'ci-0', deliveryKey: 'delivery-key-of-the-run-0003' })),
    );
    const firstShard = await submit(json(runResults({ instanceId: 'ci-9', shardTotal: 2, shardIndex: 1 })));
    const setUp = await setup(json({ projectName: PROJECT, instanceId: 'ci-5' }));
    await goOver({ pastCeiling: true });
    const before = await runsOf();

    const refused = { statusCode: 409, data: { errorCode: 'STORAGE_QUOTA_EXCEEDED' } };
    const sameInstance = { projectName: PROJECT, instanceId: 'ci-1' };
    await expect(setup(json(sameInstance))).rejects.toMatchObject(refused);
    await expect(start(json(sameInstance))).rejects.toMatchObject(refused);
    await expect(submit(json(runResults({ instanceId: 'ci-1' })))).rejects.toMatchObject(refused);
    await expect(
      results(json(runResults({ instanceId: 'ci-1', deliveryKey: 'delivery-key-of-the-run-0004' }))),
    ).rejects.toMatchObject(refused);
    await expect(uploadWholeRun({ instanceId: 'ci-1' })).rejects.toMatchObject(refused);
    await expect(submit(json(runResults({ instanceId: 'ci-8', shardTotal: 2, shardIndex: 1 })))).rejects.toMatchObject(
      refused,
    );
    // Nothing was created, and the instance's run in progress was not cancelled.
    expect(await runsOf()).toEqual(before);
    expect(state.written.size).toBe(0);

    // The run in progress takes its results, a shard joins its run, and a repeated delivery answers its run.
    const batch = json(
      { streamToken: 'the-stream-token', testCases: [{ ...testCase('pays'), type: 'complete' }] },
      { params: { id: String(streaming!.id) } },
    );
    expect(await events(batch)).toMatchObject({ success: true, processed: 1 });
    const onRun = (body: Record<string, unknown>) => json(body, { params: { id: String(streaming!.id) } });
    expect(await heartbeat(onRun({ streamToken: 'the-stream-token' }))).toMatchObject({ success: true });
    expect(await finish(onRun({ streamToken: 'the-stream-token', status: 'passed' }))).toMatchObject({
      status: 'passed',
    });
    const begun = await begin(json({ setupToken: setUp.setupToken }, { params: { id: String(setUp.runId) } }));
    expect(begun).toMatchObject({ success: true, streamToken: expect.any(String) });
    expect(await submit(json(runResults({ instanceId: 'ci-9', shardTotal: 2, shardIndex: 2 })))).toMatchObject({
      runId: firstShard.runId,
    });
    expect(
      await submit(json(runResults({ instanceId: 'ci-0', deliveryKey: 'delivery-key-of-the-run-0003' }))),
    ).toMatchObject({ runId: delivered.runId, duplicate: true });
  });
});

describe('the files a reporter did not send once the quota refused them', () => {
  /** The ingest health the reporter sends: what it did not send, beside its submit fallback. */
  const notKept = (traces: number, attachments = 0) => ({
    ingestHealth: { tracesNotKept: traces, attachmentsNotKept: attachments, submitFallback: { path: 'submit' } },
  });
  const healthOf = async (runId: number) =>
    ((await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId)))[0]!.metadata as Record<string, any>)
      ?.ingestHealth;

  test('join the run a submit, results ahead of their files or an upload creates', async () => {
    const submitted = await submit(json(runResults({ metadata: notKept(2) })));
    expect(await healthOf(submitted.runId)).toEqual({ tracesNotKept: 2, submitFallback: { path: 'submit' } });

    const held = await results(
      json(runResults({ instanceId: 'ci-4', deliveryKey: 'delivery-key-of-the-run-0005', metadata: notKept(1) })),
    );
    expect(await healthOf(held.runId)).toEqual({ tracesNotKept: 1, submitFallback: { path: 'submit' } });

    const { projectName, testCases, ...run } = runResults({ instanceId: 'ci-6', metadata: notKept(0, 4) });
    const uploaded = await upload(
      multipartEvent([field('projectName', projectName), field('testRun', run), field('testCases', testCases)]),
    );
    expect(await healthOf(uploaded.runId)).toEqual({ attachmentsNotKept: 4, submitFallback: { path: 'submit' } });
  });

  test('join a run uploaded in parts with the upload that settles it, and the files that upload skipped', async () => {
    const settle = (runId: number, report: boolean) =>
      upload(
        multipartEvent([
          field('runId', String(runId)),
          field('projectName', PROJECT),
          field('testRun', { status: 'already-submitted', startTime: '2026-11-02T10:00:00Z', metadata: notKept(3, 2) }),
          ...(report ? [{ name: 'report_custom', filename: 'report.txt', data: Buffer.from('the report') }] : []),
        ]),
      );
    const unreported = await results(json(runResults({ deliveryKey: 'delivery-key-of-the-run-0006' })));
    await settle(unreported.runId, false);
    expect(await healthOf(unreported.runId)).toEqual({ tracesNotKept: 3, attachmentsNotKept: 2 });

    vi.stubEnv('PIWI_STORAGE_QUOTA_BYTES', String(QUOTA));
    const reported = await results(
      json(runResults({ instanceId: 'ci-7', deliveryKey: 'delivery-key-of-the-run-0007' })),
    );
    await goOver();
    await settle(reported.runId, true);
    vi.unstubAllEnvs();
    expect(await healthOf(reported.runId)).toEqual({ tracesNotKept: 3, attachmentsNotKept: 2, reportsNotKept: 1 });
    expect((await runsOf()).map((run) => run.status)).toEqual(['passed', 'passed']);
  });

  test('join a streamed run at its finish, once, and each shard’s add up', async () => {
    const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
    const [streamed] = await db
      .insert(schema.testRuns)
      .values({
        projectId: project!.id,
        status: 'running',
        startTime: new Date(),
        streamToken: streamTokenDigest('the-stream-token'),
      })
      .returning();
    const finishBody = json(
      { streamToken: 'the-stream-token', status: 'passed', metadata: notKept(2, 1) },
      { params: { id: String(streamed!.id) } },
    );
    await finish(finishBody);
    // Sent again, it changes nothing: the run ended.
    await expect(finish(finishBody)).rejects.toMatchObject({ statusCode: 409, data: { errorCode: 'CONFLICT' } });
    expect(await healthOf(streamed!.id)).toEqual({
      tracesNotKept: 2,
      attachmentsNotKept: 1,
      submitFallback: { path: 'submit' },
    });

    for (const shardIndex of [1, 2]) {
      await submit(
        json(runResults({ instanceId: 'ci-3', shardTotal: 2, shardIndex, metadata: notKept(shardIndex * 3) })),
      );
    }
    const sharded = (await runsOf()).find((run) => run.instanceId === 'ci-3')!;
    expect(await healthOf(sharded.id)).toEqual({ tracesNotKept: 9, submitFallback: { path: 'submit' } });
  });
});

describe('without a quota', () => {
  test('reads nothing and refuses nothing', async () => {
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('read the database');
        },
      },
    );
    expect(await storageQuotaState(untouchable as never)).toBeNull();
    await storeBytes(QUOTA * 5);
    expect(await submit(json(runResults()))).toMatchObject({ success: true });
  });
});

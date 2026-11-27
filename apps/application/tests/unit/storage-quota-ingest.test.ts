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
import { describeIngestHealth, readIngestHealth } from '#shared/ingest-health';
import { buildBlobReport } from '../utils/blob-report-fixture';
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
const importRoute = (await import('../../server/api/test-runs/import.post')).default as unknown as Route;
const { streamTokenDigest } = await import('../../server/utils/shard-tokens');
const { storageQuotaState, storageUsedBytes } = await import('../../server/utils/storage-quota');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'storage-quota-ingest';
/** A project no request reported into yet. */
const NEW_PROJECT = 'storage-quota-ingest-new';

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
    const once = Number(complete.headers!['content-length']);
    expect(await resultsBytesOf(run!.id)).toBe(once);

    // Sent again, the batch stores nothing and adds nothing; one of whose two results is stored already adds half.
    await events(complete);
    expect(await resultsBytesOf(run!.id)).toBe(once);
    const half = json(
      {
        streamToken: 'the-stream-token',
        testCases: [
          { ...testCase('pays'), type: 'complete' },
          { ...testCase('ships'), type: 'complete' },
        ],
      },
      { params: { id: String(run!.id) } },
    );
    await events(half);
    expect(await resultsBytesOf(run!.id)).toBe(once + Math.round(Number(half.headers!['content-length']) / 2));
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

/** A blob report of one passed test, as a CI job saves it. */
const blobReport = (title: string) =>
  buildBlobReport({ tests: [{ testId: title, title, attempts: [{ status: 'passed' }] }] });

/** An import of `archive` into `projectName`, or a request with no archive part when `archive` is null. */
const importInto = (projectName: string, archive: Buffer | null) =>
  importRoute(
    multipartEvent([
      field('projectName', projectName),
      ...(archive ? [{ name: 'archive', filename: 'report.zip', data: archive }] : []),
    ]),
  );

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

  test('at the quota and past its ceiling, an archive imported already answers its run, any other is refused', async () => {
    const imported = await importInto(PROJECT, blobReport('pays'));
    expect(imported).toMatchObject({ status: 'imported' });

    await goOver();
    expect(await importInto(PROJECT, blobReport('pays'))).toMatchObject({ runId: imported.runId, status: 'duplicate' });
    await expect(importInto(PROJECT, blobReport('ships'))).rejects.toMatchObject({
      statusCode: 409,
      data: { errorCode: 'STORAGE_QUOTA_FILES_REFUSED' },
    });
    await expect(importInto(PROJECT, null)).rejects.toMatchObject({ statusCode: 400 });

    await storeBytes(QUOTA * 1.2);
    expect(await importInto(PROJECT, blobReport('pays'))).toMatchObject({ runId: imported.runId, status: 'duplicate' });
    await expect(importInto(PROJECT, blobReport('ships'))).rejects.toMatchObject({
      statusCode: 409,
      data: { errorCode: 'STORAGE_QUOTA_EXCEEDED' },
    });
    await expect(importInto(PROJECT, null)).rejects.toMatchObject({ statusCode: 400 });
    expect(await runsOf()).toHaveLength(1);
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
    // A run for a project that does not exist yet is a new run: refused before its project is created.
    const projectsBefore = await db.select().from(schema.projects);
    const elsewhere = { projectName: NEW_PROJECT, instanceId: 'ci-1' };
    await expect(setup(json(elsewhere))).rejects.toMatchObject(refused);
    await expect(start(json(elsewhere))).rejects.toMatchObject(refused);
    await expect(submit(json(runResults(elsewhere)))).rejects.toMatchObject(refused);
    await expect(
      results(json(runResults({ ...elsewhere, deliveryKey: 'delivery-key-of-the-run-0008' }))),
    ).rejects.toMatchObject(refused);
    await expect(uploadWholeRun(elsewhere)).rejects.toMatchObject(refused);
    await expect(submit(json(runResults({ ...elsewhere, shardTotal: 2, shardIndex: 1 })))).rejects.toMatchObject(
      refused,
    );
    await expect(importInto(NEW_PROJECT, blobReport('pays'))).rejects.toMatchObject(refused);
    expect(await db.select().from(schema.projects)).toEqual(projectsBefore);
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

/** The ingest health the reporter sends: what it did not send, beside its submit fallback. */
const notKept = (traces: number, attachments = 0, reports = 0) => ({
  ingestHealth: {
    tracesNotKept: traces,
    attachmentsNotKept: attachments,
    reportsNotKept: reports,
    submitFallback: { path: 'submit' },
  },
});
const metadataOf = async (runId: number) =>
  (await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId)))[0]!.metadata as Record<string, any>;
const healthOf = async (runId: number) => (await metadataOf(runId))?.ingestHealth;
/** What the run header says of the run's ingest. */
const notesOf = async (runId: number) => describeIngestHealth(readIngestHealth(await metadataOf(runId)));

describe('the files a reporter did not send once the quota refused them', () => {
  beforeEach(() => {
    vi.stubEnv('PIWI_STORAGE_QUOTA_BYTES', String(QUOTA));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** An upload to a run its reporter holds: a report, or none, and the files it says it did not send. */
  const uploadTo = (runId: number, metadata: Record<string, unknown>, report = false) =>
    upload(
      multipartEvent([
        field('runId', String(runId)),
        field('projectName', PROJECT),
        field('testRun', { status: 'already-submitted', startTime: '2026-11-02T10:00:00Z', metadata }),
        ...(report ? [{ name: 'report_custom', filename: 'report.txt', data: Buffer.from('the report') }] : []),
      ]),
    );

  test('join the run a submit, results ahead of their files or an upload creates', async () => {
    const submitted = await submit(json(runResults({ metadata: notKept(2) })));
    expect(await healthOf(submitted.runId)).toEqual({
      reporterNotKept: { tracesNotKept: 2 },
      submitFallback: { path: 'submit' },
    });

    const held = await results(
      json(runResults({ instanceId: 'ci-4', deliveryKey: 'delivery-key-of-the-run-0005', metadata: notKept(1) })),
    );
    expect(await healthOf(held.runId)).toEqual({
      reporterNotKept: { tracesNotKept: 1 },
      submitFallback: { path: 'submit' },
    });

    const { projectName, testCases, ...run } = runResults({ instanceId: 'ci-6', metadata: notKept(0, 4) });
    const uploaded = await upload(
      multipartEvent([field('projectName', projectName), field('testRun', run), field('testCases', testCases)]),
    );
    expect(await healthOf(uploaded.runId)).toEqual({
      reporterNotKept: { attachmentsNotKept: 4 },
      submitFallback: { path: 'submit' },
    });
  });

  test('join a run uploaded in parts from an upload after the one that settled it, once', async () => {
    const { runId } = await results(json(runResults({ deliveryKey: 'delivery-key-of-the-run-0006' })));
    // A report settles the run; the reporter then leaves out the files the quota refuses, and says so after.
    await uploadTo(runId, {}, true);
    expect((await runsOf())[0]!.status).toBe('passed');
    await goOver();
    await uploadTo(runId, notKept(3, 2, 1));
    expect(await healthOf(runId)).toEqual({
      reporterNotKept: { tracesNotKept: 3, attachmentsNotKept: 2, reportsNotKept: 1 },
    });
    // The same upload again changes nothing.
    await uploadTo(runId, notKept(3, 2, 1));
    expect(await healthOf(runId)).toEqual({
      reporterNotKept: { tracesNotKept: 3, attachmentsNotKept: 2, reportsNotKept: 1 },
    });
    expect(await notesOf(runId)).toEqual([
      '3 traces, 2 attachments and 1 report were not kept: the storage quota was reached',
    ]);
  });

  test('add the files an upload skipped to those its reporter did not send, in the run header', async () => {
    const { runId } = await results(json(runResults({ deliveryKey: 'delivery-key-of-the-run-0007' })));
    await goOver();
    // The first report settles the run and is not kept; the reporter leaves out the next one and says so after.
    await uploadTo(runId, {}, true);
    await uploadTo(runId, notKept(3, 2, 1));
    await uploadTo(runId, notKept(3, 2, 1));
    expect(await healthOf(runId)).toEqual({
      reportsNotKept: 1,
      reporterNotKept: { tracesNotKept: 3, attachmentsNotKept: 2, reportsNotKept: 1 },
    });
    expect(await notesOf(runId)).toEqual([
      '3 traces, 2 attachments and 2 reports were not kept: the storage quota was reached',
    ]);
  });

  test('join a streamed run as the larger of its finish’s counts and those of each upload after it', async () => {
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
    await finish(
      json(
        { streamToken: 'the-stream-token', status: 'passed', hasPendingUploads: true, metadata: notKept(2, 1) },
        { params: { id: String(streamed!.id) } },
      ),
    );
    expect(await healthOf(streamed!.id)).toEqual({
      reporterNotKept: { tracesNotKept: 2, attachmentsNotKept: 1 },
      submitFallback: { path: 'submit' },
    });

    // The reporter counts the whole run: its settling upload says what its finish said, and the report it left out.
    await uploadTo(streamed!.id, notKept(2, 1, 1));
    await uploadTo(streamed!.id, notKept(2, 1, 1));
    expect(await healthOf(streamed!.id)).toEqual({
      reporterNotKept: { tracesNotKept: 2, attachmentsNotKept: 1, reportsNotKept: 1 },
      submitFallback: { path: 'submit' },
    });
    expect((await runsOf())[0]!.status).toBe('passed');
    // A later upload with higher counts raises them; one with lower counts leaves them.
    await uploadTo(streamed!.id, notKept(2, 1, 3));
    await uploadTo(streamed!.id, notKept(1));
    expect((await healthOf(streamed!.id)).reporterNotKept).toEqual({
      tracesNotKept: 2,
      attachmentsNotKept: 1,
      reportsNotKept: 3,
    });
  });

  test('join a streamed run at its finish, once, and each shard’s add up, a shard sent again once', async () => {
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
      reporterNotKept: { tracesNotKept: 2, attachmentsNotKept: 1 },
      submitFallback: { path: 'submit' },
    });

    for (const shardIndex of [1, 1, 2]) {
      await submit(
        json(runResults({ instanceId: 'ci-3', shardTotal: 2, shardIndex, metadata: notKept(shardIndex * 3) })),
      );
    }
    const sharded = (await runsOf()).find((run) => run.instanceId === 'ci-3')!;
    expect(await healthOf(sharded.id)).toEqual({
      reporterNotKept: { tracesNotKept: 9 },
      submitFallback: { path: 'submit' },
    });
  });
});

describe('without a quota', () => {
  test('takes none of the counts of files a reporter says it did not send', async () => {
    const { runId } = await submit(json(runResults({ metadata: notKept(2, 1, 1) })));
    expect(await healthOf(runId)).toEqual({ submitFallback: { path: 'submit' } });

    const held = await results(
      json(runResults({ instanceId: 'ci-4', deliveryKey: 'delivery-key-of-the-run-0009', metadata: notKept(1) })),
    );
    await upload(
      multipartEvent([
        field('runId', String(held.runId)),
        field('projectName', PROJECT),
        field('testRun', { status: 'already-submitted', startTime: null, metadata: notKept(3, 2) }),
      ]),
    );
    expect(await healthOf(held.runId)).toEqual({ submitFallback: { path: 'submit' } });
  });

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

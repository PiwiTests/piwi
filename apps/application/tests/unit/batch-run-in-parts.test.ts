import { beforeEach, describe, expect, test, vi } from 'vitest';
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
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
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
// The feature-graph write runs after persistRunCases returns, off the request path: it has nothing to do here.
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/graph-ingest')>();
  return { ...mod, ingestRunGraph: async () => {}, ingestRequestGraph: async () => {} };
});

interface RouteEvent {
  params?: Record<string, string>;
  body?: unknown;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

type Route = (event: unknown) => Promise<Record<string, any>>;
const results = (await import('../../server/api/test-runs/upload/results.post')).default as unknown as Route;
const caseFiles = (await import('../../server/api/test-runs/[id]/case-files.post')).default as unknown as Route;
const upload = (await import('../../server/api/test-runs/upload.post')).default as unknown as Route;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const { runFinalizeSideEffects } = await import('../../server/utils/run-finalize-side-effects');
const { settleStaleFinalizingRuns, FINALIZING_TIMEOUT_MS } = await import('../../server/utils/stale-runs');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'batch-in-parts';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  state.written.clear();
  vi.mocked(runFinalizeSideEffects).mockClear();
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
});

const testCase = (title: string, status = 'failed') => ({
  title,
  status,
  location: `tests/${title}.spec.ts:3:1`,
  duration: 20,
  retries: 0,
  browser: { name: 'chromium', projectName: 'chromium' },
});

/** The results of a run, as the reporter sends them ahead of its files. */
const runResults = (overrides: Record<string, unknown> = {}) => ({
  projectName: PROJECT,
  status: 'failed',
  startTime: '2026-11-02T10:00:00Z',
  duration: 60_000,
  totalTests: 2,
  passedTests: 1,
  failedTests: 1,
  instanceId: 'ci-77',
  metadata: { ci: { provider: 'github' } },
  testCases: [testCase('pays'), testCase('ships', 'passed')],
  deliveryKey: 'delivery-key-of-the-run-0001',
  ...overrides,
});

const field = (name: string, value: unknown): MultipartPart => ({
  name,
  data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});

/** One test's screenshot, sent to the run as the reporter sends a test's files. */
const sendScreenshot = (runId: number, streamToken: string | null, title: string) =>
  caseFiles({
    params: { id: String(runId) },
    ...multipartEvent([
      ...(streamToken === null ? [] : [field('streamToken', streamToken)]),
      field('testCase', {
        title,
        location: `tests/${title}.spec.ts:3:1`,
        retries: 0,
        repeatEachIndex: 0,
        suitePath: null,
        projectName: 'chromium',
      }),
      field('attach_meta', [{ name: 'screenshot', contentType: 'image/png', originalName: `${title}.png` }]),
      { name: 'attach_file', filename: `${title}.png`, data: Buffer.from(`${title} screenshot`) },
    ]),
  });

/** The run's report, the last request of the run: it settles the run. */
const sendReport = (runId: number, report = true) =>
  upload(
    multipartEvent([
      field('runId', String(runId)),
      field('projectName', PROJECT),
      field('testRun', { status: 'already-submitted', startTime: '2026-11-02T10:00:00Z' }),
      ...(report ? [{ name: 'report_custom', filename: 'report.txt', data: Buffer.from('the report') }] : []),
    ]),
  );

/** The whole run in one multipart upload, its files with it, as the reporter sends it when no results answer came. */
const sendWholeRun = (screenshot = Buffer.from('pays screenshot')) => {
  const { projectName, testCases, ...run } = runResults();
  return upload(
    multipartEvent([
      field('projectName', projectName),
      field('testRun', run),
      field('testCases', testCases),
      field('attach_meta_0', [{ name: 'screenshot', contentType: 'image/png', originalName: 'pays.png' }]),
      { name: 'attach_file_0', filename: 'pays.png', data: screenshot },
      { name: 'report_custom', filename: 'report.txt', data: Buffer.from('the report') },
    ]),
  );
};

const runRow = async (runId: number) =>
  (await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId)))[0]!;

/** The results of a run stored three times over under one key, none of the answers reaching the reporter. */
async function resultsWithAnswersLost(): Promise<Array<Record<string, any>>> {
  const answers = [];
  for (let i = 0; i < 3; i++) answers.push(await results({ body: runResults() }));
  return answers;
}

/**
 * A repeat's answer names the run the lost answers held, with a new token, and leaves the repeat's own files unread;
 * that token alone then takes each test's files, and the report settles the run once, with its files.
 */
async function expectHeldRepeat(answers: Array<Record<string, any>>, again: Record<string, any>): Promise<void> {
  const runId = answers[0]!.runId;
  expect(again).toEqual({
    success: true,
    runId,
    projectId: answers[0]!.projectId,
    duplicate: true,
    runUrl: `/test-runs/${runId}`,
    streamToken: expect.any(String),
  });
  expect(answers.map((a) => a.streamToken)).not.toContain(again.streamToken);
  expect(await db.select().from(schema.testRuns)).toHaveLength(1);
  expect(await db.select().from(schema.files)).toHaveLength(0);
  expect(state.written.size).toBe(0);
  expect((await runRow(runId)).status).toBe('finalizing');
  expect(runFinalizeSideEffects).not.toHaveBeenCalled();

  await expect(sendScreenshot(runId, answers[2]!.streamToken, 'pays')).rejects.toMatchObject({ statusCode: 403 });
  for (const title of ['pays', 'ships']) {
    expect(await sendScreenshot(runId, again.streamToken, title)).toMatchObject({ success: true, attachments: 1 });
  }
  await sendReport(runId);

  const run = await runRow(runId);
  expect(run).toMatchObject({ status: 'failed', streamToken: null });
  expect(run.metadata).toEqual({ ci: { provider: 'github' } });
  expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  const stored = await db.select().from(schema.files).where(eq(schema.files.testRunId, runId));
  expect(stored.map((f) => f.type).sort()).toEqual(['attachment', 'attachment', 'report']);
  const executions = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, runId));
  expect(executions).toHaveLength(2);
}

describe('a batch run sent in parts: its results, then its files', () => {
  test('its results hold the run finalizing, with the status they carry waiting, and a token for its files', async () => {
    const answer = await results({ body: runResults() });

    expect(answer).toMatchObject({ success: true, runId: expect.any(Number), streamToken: expect.any(String) });
    const run = await runRow(answer.runId);
    expect(run).toMatchObject({ status: 'finalizing', totalTests: 2, failedTests: 1, instanceId: 'ci-77' });
    expect(run.metadata).toEqual({ ci: { provider: 'github' }, pendingStatus: 'failed' });
    // Kept as its digest, never as the token itself.
    expect(run.streamToken).toMatch(/^sha256:/);
    expect(run.streamToken).not.toContain(answer.streamToken);
    const executions = await db
      .select()
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testRunId, answer.runId));
    expect(executions).toHaveLength(2);
    // The finish-time side effects wait for the files.
    expect(runFinalizeSideEffects).not.toHaveBeenCalled();
  });

  test('each test files go with its token, and the report upload settles the run, which then takes no more', async () => {
    const { runId, streamToken } = await results({ body: runResults() });

    for (const title of ['pays', 'ships']) {
      expect(await sendScreenshot(runId, streamToken, title)).toMatchObject({ success: true, attachments: 1 });
    }
    await sendReport(runId);

    const run = await runRow(runId);
    expect(run.status).toBe('failed');
    expect(run.metadata).toEqual({ ci: { provider: 'github' } });
    expect(run.streamToken).toBeNull();
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
    const stored = await db.select().from(schema.files).where(eq(schema.files.testRunId, runId));
    expect(stored.map((f) => f.type).sort()).toEqual(['attachment', 'attachment', 'report']);

    await expect(sendScreenshot(runId, streamToken, 'pays')).rejects.toMatchObject({ statusCode: 409 });
  });

  test('an upload that carries no report settles the run all the same', async () => {
    const { runId } = await results({ body: runResults() });

    await sendReport(runId, false);

    expect((await runRow(runId)).status).toBe('failed');
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });

  test('takes the files of a held run with its own token only', async () => {
    const held = await results({ body: runResults() });
    const other = await results({
      body: runResults({ deliveryKey: 'delivery-key-of-the-run-0002', instanceId: 'ci-78' }),
    });

    await expect(sendScreenshot(held.runId, other.streamToken, 'pays')).rejects.toMatchObject({ statusCode: 403 });
    await expect(sendScreenshot(held.runId, null, 'pays')).rejects.toMatchObject({ statusCode: 401 });
    expect(state.written.size).toBe(0);
  });

  test('a repeated delivery answers with the run its first one held, and a new token in place of the first', async () => {
    const first = await results({ body: runResults() });
    const again = await results({ body: runResults() });

    expect(again).toEqual({
      success: true,
      runId: first.runId,
      projectId: first.projectId,
      duplicate: true,
      runUrl: `/test-runs/${first.runId}`,
      streamToken: expect.any(String),
    });
    expect(again.streamToken).not.toBe(first.streamToken);
    expect(await db.select().from(schema.testRuns)).toHaveLength(1);

    await expect(sendScreenshot(first.runId, first.streamToken, 'pays')).rejects.toMatchObject({ statusCode: 403 });
    expect(await sendScreenshot(first.runId, again.streamToken, 'pays')).toMatchObject({
      success: true,
      attachments: 1,
    });
    await sendReport(first.runId);
    expect((await runRow(first.runId)).status).toBe('failed');
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });

  test('a repeated delivery restarts the wait of the run it holds, so the sweep leaves its new token the full time', async () => {
    const first = await results({ body: runResults() });
    const resultsStored = new Date(Date.now() - FINALIZING_TIMEOUT_MS + 30_000);
    await db.update(schema.testRuns).set({ updatedAt: resultsStored }).where(eq(schema.testRuns.id, first.runId));

    const again = await results({ body: runResults() });

    expect(await settleStaleFinalizingRuns(db, Date.now() + 60_000)).toEqual([]);
    expect((await runRow(first.runId)).status).toBe('finalizing');
    expect(await sendScreenshot(first.runId, again.streamToken, 'pays')).toMatchObject({
      success: true,
      attachments: 1,
    });
  });

  test('a repeated delivery of a run that settled answers with the run, without a token', async () => {
    const first = await results({ body: runResults() });
    await sendReport(first.runId);

    const again = await results({ body: runResults() });

    expect(again).toEqual({
      success: true,
      runId: first.runId,
      projectId: first.projectId,
      duplicate: true,
      runUrl: `/test-runs/${first.runId}`,
    });
    expect((await runRow(first.runId)).streamToken).toBeNull();
  });

  test('a repeat in one upload of the run its results hold answers with a new token, and its files go with that', async () => {
    const answers = await resultsWithAnswersLost();

    await expectHeldRepeat(answers, await sendWholeRun());
  });

  test('a repeat as JSON of the run its results hold, its one upload refused, answers with a new token', async () => {
    const answers = await resultsWithAnswersLost();
    const limit = process.env.PIWI_IMPORT_MAX_BYTES;
    process.env.PIWI_IMPORT_MAX_BYTES = String(1024 * 1024);
    try {
      await expect(sendWholeRun(Buffer.alloc(1024 * 1024 + 1))).rejects.toMatchObject({ statusCode: 413 });
    } finally {
      if (limit === undefined) delete process.env.PIWI_IMPORT_MAX_BYTES;
      else process.env.PIWI_IMPORT_MAX_BYTES = limit;
    }

    await expectHeldRepeat(answers, await submit({ body: runResults() }));
  });

  test('a repeat as JSON of a run that settled, or of a run it stored itself, answers without a token', async () => {
    const held = await results({ body: runResults() });
    await sendReport(held.runId);
    expect(await submit({ body: runResults() })).toEqual({
      success: true,
      runId: held.runId,
      projectId: held.projectId,
      duplicate: true,
      runUrl: `/test-runs/${held.runId}`,
    });

    const own = runResults({ deliveryKey: 'delivery-key-of-the-run-0002', instanceId: 'ci-78' });
    const first = await submit({ body: own });
    expect(await submit({ body: own })).toEqual({
      success: true,
      runId: first.runId,
      projectId: first.projectId,
      duplicate: true,
      runUrl: `/test-runs/${first.runId}`,
    });
    expect(await db.select().from(schema.testRuns)).toHaveLength(2);
  });

  test('a repeat in one upload of a run that settled answers with the run, without a token', async () => {
    const first = await results({ body: runResults() });
    await sendReport(first.runId);

    const again = await sendWholeRun();

    expect(again).toEqual({
      success: true,
      runId: first.runId,
      projectId: first.projectId,
      duplicate: true,
      runUrl: `/test-runs/${first.runId}`,
    });
    expect((await runRow(first.runId)).streamToken).toBeNull();
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });

  test('a repeat in one upload of a run it stored itself answers without a token', async () => {
    const first = await sendWholeRun();
    const again = await sendWholeRun();

    expect(again).toEqual({
      success: true,
      runId: first.runId,
      projectId: first.projectId,
      duplicate: true,
      runUrl: `/test-runs/${first.runId}`,
    });
    expect(await db.select().from(schema.testRuns)).toHaveLength(1);
  });

  test('refuses a shard, whose run settles with its last shard: its results and files go in one upload', async () => {
    await expect(results({ body: runResults({ shardIndex: 1, shardTotal: 2 }) })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await db.select().from(schema.testRuns)).toHaveLength(0);
  });
});

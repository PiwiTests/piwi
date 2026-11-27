/**
 * What the ingest routes count toward the storage quota: the size of the results each request brings joins its run's
 * `results_bytes`, which the storage total counts.
 */
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
const { streamTokenDigest } = await import('../../server/utils/shard-tokens');
const { storageUsedBytes } = await import('../../server/utils/storage-quota');
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

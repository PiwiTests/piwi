import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { multipartEvent, type MultipartPart } from './multipart-event';

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
const { settleFinalizingRun } = await import('../../server/utils/finalizing-runs');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
const lastEvent = new Date('2026-09-30T09:00:00Z');

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
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

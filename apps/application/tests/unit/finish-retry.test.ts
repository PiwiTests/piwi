import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
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

type Handler = (event: FakeEvent) => Promise<{ success?: boolean; status?: string }>;
const finish = (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Handler;

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  runFinalizeSideEffects.mockClear();
  await db.insert(schema.projects).values({ id: 1, name: 'finish-retry-project' });
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'running',
    startTime: new Date('2026-09-30T08:55:00Z'),
    streamToken: 'stream-token',
  });
});

const runRow = async () => (await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, 1)))[0]!;

/** The reporter's `/finish`, as it sends it again when the first answer did not arrive. */
const finishRun = (body: Record<string, unknown> = {}) =>
  finish({ params: { id: '1' }, body: { streamToken: 'stream-token', status: 'passed', totalTests: 1, ...body } });

describe('a /finish sent again while the first is still running', () => {
  test('settles the run once, with one run of the finish-time side effects', async () => {
    const answers = await Promise.all([finishRun(), finishRun()]);

    expect(answers.map((answer) => answer.success)).toEqual([true, true]);
    expect((await runRow()).status).toBe('passed');
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });

  test('with its report upload pending, leaves the run finalizing once', async () => {
    const answers = await Promise.all([finishRun({ hasPendingUploads: true }), finishRun({ hasPendingUploads: true })]);

    expect(answers.map((answer) => answer.status)).toEqual(['finalizing', 'finalizing']);
    expect((await runRow()).status).toBe('finalizing');
    expect(runFinalizeSideEffects).not.toHaveBeenCalled();
  });
});

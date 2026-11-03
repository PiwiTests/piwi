import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { bodyLimitError, MAX_EVENT_BATCH_BYTES } from '../../server/utils/body-limit';
import { migrateToLatest } from './temp-db';

/**
 * The reporter's streaming routes that carry their token in the body: a run
 * that does not exist is refused before the body is read, and the largest
 * batch of events the reporter sends is within the route's cap.
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

const readBody = vi.fn(async (event: RouteEvent) => event.body);
vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', readBody);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);

type Route = (event: RouteEvent) => Promise<unknown>;
const routes: Record<string, Route> = {
  begin: (await import('../../server/api/test-runs/[id]/begin.post')).default as unknown as Route,
  events: (await import('../../server/api/test-runs/[id]/events.post')).default as unknown as Route,
  finish: (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Route,
  'live-resources': (await import('../../server/api/test-runs/[id]/live-resources.post')).default as unknown as Route,
};
const { StreamManager } = await import('../../../../packages/reporter/src/internal/streaming/stream-manager');
const { runEventBus } = await import('../../server/utils/run-events');
const { validateAndReviveRun } = await import('../../server/utils/revive-run');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId = 0;
let runId = 0;

/** A run of the test's project in `status`, sharded in two when `sharded`. */
async function insertRun(status: string, sharded = false): Promise<number> {
  const [run] = await db
    .insert(schema.testRuns)
    .values({
      projectId,
      status,
      startTime: new Date('2026-11-03T08:00:00Z'),
      ...(sharded ? { shardTotal: 2, shardsFinished: 0 } : {}),
    })
    .returning();
  return run!.id;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: 'stream-route-bodies' }).returning();
  projectId = project!.id;
  runId = await insertRun('running');
  readBody.mockClear();
});

describe('a streaming route that reads its token from the body', () => {
  test.each(Object.keys(routes))('%s refuses a run that does not exist before reading the body', async (name) => {
    const route = routes[name]!;
    await expect(route({ params: { id: String(runId + 1) }, body: { streamToken: 'x' } })).rejects.toMatchObject({
      statusCode: 404,
      message: 'Test run not found',
    });
    await expect(route({ params: { id: '12abc' }, body: { streamToken: 'x' } })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(readBody).not.toHaveBeenCalled();
  });

  test.each(Object.keys(routes))('%s reads the body of a run that exists, as before', async (name) => {
    await expect(routes[name]!({ params: { id: String(runId) }, body: {} })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(readBody).toHaveBeenCalledTimes(1);
  });
});

describe('a run the route does not take', () => {
  const STATUSES = [
    'initializing',
    'running',
    'finalizing',
    'interrupted',
    'cancelled',
    'passed',
    'failed',
    'timedout',
  ];
  /** Whether the route takes a run in `status`, as its own check after the body reads it. */
  const takes = (route: string, status: string, sharded: boolean) =>
    route === 'begin'
      ? status === 'initializing' || status === 'running' || (sharded && status === 'interrupted')
      : status === 'running' || status === 'interrupted';

  test.each(Object.keys(routes))(
    '%s refuses it with the 409 it answers after reading the body, without reading it',
    async (name) => {
      for (const sharded of [false, true]) {
        for (const status of STATUSES) {
          const id = await insertRun(status, sharded);
          readBody.mockClear();
          const answer = routes[name]!({ params: { id: String(id) }, body: {} });
          if (takes(name, status, sharded)) {
            // The body is read, and its missing token refused.
            await expect(answer, `${status}, sharded: ${sharded}`).rejects.toMatchObject({ statusCode: 401 });
            expect(readBody).toHaveBeenCalledTimes(1);
          } else {
            await expect(answer, `${status}, sharded: ${sharded}`).rejects.toMatchObject({
              statusCode: 409,
              message:
                name === 'begin'
                  ? 'Test run cannot be transitioned to running state'
                  : 'Test run is not in running state',
            });
            expect(readBody).not.toHaveBeenCalled();
          }
        }
      }
    },
  );

  test('the refusal is the one the stream token check gives a run in that status', async () => {
    for (const status of STATUSES.filter((status) => !takes('events', status, false))) {
      await expect(
        validateAndReviveRun(db as never, runId, { status, streamToken: 'token' }, 'token'),
      ).rejects.toMatchObject({ statusCode: 409, message: 'Test run is not in running state' });
    }
  });

  test.each(['events', 'live-resources'])(
    '%s reads the body of a run in the run cache, which the stream token check trusts',
    async (name) => {
      const id = await insertRun('passed');
      runEventBus.cacheRunState(id, { streamToken: 'sha256:x', projectId });
      try {
        await expect(routes[name]!({ params: { id: String(id) }, body: {} })).rejects.toMatchObject({
          statusCode: 401,
        });
        expect(readBody).toHaveBeenCalledTimes(1);
      } finally {
        runEventBus.clearRunState(id);
      }
    },
  );
});

describe('the largest batch of events the reporter sends', () => {
  test('is within the events route’s cap', async () => {
    const bodies: string[] = [];
    const http = {
      postJSON: async (_url: string, body: unknown) => {
        bodies.push(JSON.stringify(body));
        return {};
      },
    };
    const buffer = { load: () => [], clear: () => {}, append: () => {}, bindRun: () => {} };
    const sm = new StreamManager(
      http as never,
      buffer as never,
      {} as never,
      {} as never,
      {} as never,
      {
        streamingBatchSize: 1_000_000,
        streamingBatchDelay: 3_600_000,
      } as never,
    );
    Object.assign(sm, { _enabled: true, _runId: runId, _token: 'f'.repeat(64) });

    // The largest event the reporter streams: its JSON and a separator fill the room it keeps under the cap.
    const event = { type: 'complete', title: 'huge', location: 'a.spec.ts:1:1', status: 'failed', duration: 1 };
    const room = MAX_EVENT_BATCH_BYTES - 1024 - 1;
    const error = 'x'.repeat(room - Buffer.byteLength(JSON.stringify({ ...event, error: '' })));
    sm.queueEvent({ ...event, error } as never);
    await sm.drain();

    expect(sm.lostResults).toBe(false);
    expect(bodies).toHaveLength(1);
    const size = Buffer.byteLength(bodies[0]!);
    expect(size).toBeGreaterThan(MAX_EVENT_BATCH_BYTES - 1024);
    const path = `/api/test-runs/${runId}/events`;
    expect(bodyLimitError({ method: 'POST', path, contentType: 'application/json', contentLength: String(size) })).toBe(
      null,
    );
  });
});

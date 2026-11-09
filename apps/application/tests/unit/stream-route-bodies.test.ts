import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { bodyLimitError, MAX_EVENT_BATCH_BYTES } from '../../server/utils/body-limit';
import { durationStats } from '#shared/utils/stats';
import { RUN_TOKEN_HEADER } from '@piwitests/core/wire';
import { migrateToLatest } from './temp-db';

/**
 * The reporter's streaming routes that carry their token in the body: a run
 * that does not exist or that the route does not take, and a request whose
 * token header is missing or wrong for a run whose reporter sends it, are
 * refused before the body is read, and the largest batch of events the
 * reporter sends is within the route's cap.
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
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

const readBody = vi.fn(async (event: RouteEvent) => event.body);
vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', readBody);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', (event: RouteEvent, name: string) => event.headers?.[name.toLowerCase()]);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

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
const { sendsRunTokenHeader } = await import('../../server/utils/stream-auth');
const { streamTokenDigest } = await import('../../server/utils/shard-tokens');
const setup = (await import('../../server/api/test-runs/setup.post')).default as unknown as (
  event: RouteEvent,
) => Promise<{ runId: number; setupToken: string }>;
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId = 0;
let runId = 0;

/** A run of the test's project in `status`, sharded in two when `sharded`. */
async function insertRun(
  status: string,
  sharded = false,
  run: { reporterVersion?: string | null; token?: string } = {},
): Promise<number> {
  const [row] = await db
    .insert(schema.testRuns)
    .values({
      projectId,
      status,
      startTime: new Date('2026-11-03T08:00:00Z'),
      reporterVersion: run.reporterVersion ?? null,
      streamToken: run.token ? streamTokenDigest(run.token) : null,
      ...(sharded ? { shardTotal: 2, shardsFinished: 0 } : {}),
    })
    .returning();
  return row!.id;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: 'stream-route-bodies' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
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

describe('the run token header', () => {
  const TOKEN = 'a'.repeat(64);
  const header = (token: string) => ({ [RUN_TOKEN_HEADER.toLowerCase()]: token });
  /** The status each route takes a run in. */
  const takenStatus = (name: string) => (name === 'begin' ? 'initializing' : 'running');
  const tokenWord = (name: string) => (name === 'begin' ? 'setup' : 'stream');

  test('is sent by reporter 0.65.0 and later, a prerelease counting as its release', () => {
    for (const version of ['0.65.0', '0.65.0-beta.1', '0.65.1', '0.66.0', '1.0.0', '0.65.0+build.7']) {
      expect(sendsRunTokenHeader(version), version).toBe(true);
    }
    for (const version of ['0.64.0', '0.64.9', '0.64.99-rc.1', null, undefined, '', 'unknown', 'v0.65.0', '0.65']) {
      expect(sendsRunTokenHeader(version), String(version)).toBe(false);
    }
  });

  test.each(Object.keys(routes))(
    '%s refuses a run of reporter 0.65.0 without it, or with a wrong one, before reading the body',
    async (name) => {
      const id = await insertRun(takenStatus(name), false, { reporterVersion: '0.65.0', token: TOKEN });
      const params = { id: String(id) };
      for (const headers of [{}, header('')]) {
        await expect(routes[name]!({ params, headers, body: { streamToken: TOKEN } })).rejects.toMatchObject({
          statusCode: 401,
          message: `Missing ${tokenWord(name)} token`,
        });
      }
      await expect(
        routes[name]!({ params, headers: header('b'.repeat(64)), body: { streamToken: TOKEN } }),
      ).rejects.toMatchObject({ statusCode: 403, message: `Invalid ${tokenWord(name)} token` });
      expect(readBody).not.toHaveBeenCalled();

      // The right one: the body is read, and its own token checked as before.
      await expect(routes[name]!({ params, headers: header(TOKEN), body: {} })).rejects.toMatchObject({
        statusCode: 401,
      });
      expect(readBody).toHaveBeenCalledTimes(1);
    },
  );

  test.each(Object.keys(routes))(
    '%s reads the body of a run of an older or unknown reporter without it',
    async (name) => {
      for (const reporterVersion of ['0.64.0', null, 'unknown']) {
        const id = await insertRun(takenStatus(name), false, { reporterVersion, token: TOKEN });
        readBody.mockClear();
        await expect(routes[name]!({ params: { id: String(id) }, body: {} })).rejects.toMatchObject({
          statusCode: 401,
        });
        expect(readBody, String(reporterVersion)).toHaveBeenCalledTimes(1);
      }
    },
  );

  test.each(['events', 'live-resources'])('%s checks it against the run cache', async (name) => {
    const id = await insertRun('running', false, { reporterVersion: '0.65.0', token: TOKEN });
    runEventBus.cacheRunState(id, { streamToken: streamTokenDigest(TOKEN), projectId });
    try {
      const params = { id: String(id) };
      await expect(routes[name]!({ params, body: {} })).rejects.toMatchObject({ statusCode: 401 });
      await expect(routes[name]!({ params, headers: header('b'.repeat(64)), body: {} })).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(readBody).not.toHaveBeenCalled();
      await expect(routes[name]!({ params, headers: header(TOKEN), body: {} })).rejects.toMatchObject({
        statusCode: 401,
      });
      expect(readBody).toHaveBeenCalledTimes(1);
    } finally {
      runEventBus.clearRunState(id);
    }
  });
});

describe("a reporter's streamed run", () => {
  const result = { type: 'complete', title: 'pays', location: 'tests/pay.spec.ts:1:1', status: 'passed', duration: 10 };
  const timeline = { startedAt: 1_000_000, cpuPct: [[1000, 40]], memoryBytes: [], pages: [], workers: [] };

  /**
   * A run streamed as a reporter does: its global setup's `/setup`, then `begin`, a batch of events, a post of its
   * resources and `finish`, each with its token in the header when `withHeader`.
   */
  async function streamRun(setupVersion: string | undefined, version: string, withHeader: boolean) {
    const headers = (token: string) => (withHeader ? { [RUN_TOKEN_HEADER.toLowerCase()]: token } : {});
    const set = await setup({ body: { projectName: 'stream-route-bodies', reporterVersion: setupVersion } });
    const params = { id: String(set.runId) };
    const begun = (await routes.begin!({
      params,
      headers: headers(set.setupToken),
      body: { setupToken: set.setupToken, totalTests: 1, reporterVersion: version },
    })) as { streamToken: string };
    const streamToken = begun.streamToken;
    await routes.events!({ params, headers: headers(streamToken), body: { streamToken, testCases: [result] } });
    await routes['live-resources']!({
      params,
      headers: headers(streamToken),
      body: { streamToken, shardIndex: null, reset: true, timeline },
    });
    // The run cache is gone after a restart: each route then reads the run.
    runEventBus.clearRunState(set.runId);
    await routes.events!({ params, headers: headers(streamToken), body: { streamToken, testCases: [] } });
    const finished = await routes.finish!({
      params,
      headers: headers(streamToken),
      body: { streamToken, status: 'passed', duration: 10, totalTests: 1, passedTests: 1, durations: [10] },
    });
    const cases = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, set.runId));
    return { runId: set.runId, finished, cases };
  }

  test('of reporter 0.65.0, with the header, is delivered', async () => {
    const { finished, cases } = await streamRun('0.65.0', '0.65.0', true);
    expect(finished).toMatchObject({ success: true, status: 'passed' });
    expect(cases).toHaveLength(1);
  });

  test('sharded, of reporter 0.65.0, each shard with its own tokens in the header, is delivered', async () => {
    const shards = { instanceId: 'ci-9', shardTotal: 2 };
    const header = (token: string) => ({ [RUN_TOKEN_HEADER.toLowerCase()]: token });
    const set = [1, 2].map(
      async (shardIndex) =>
        await setup({ body: { projectName: 'stream-route-bodies', reporterVersion: '0.65.0', ...shards, shardIndex } }),
    );
    const [first, second] = [await set[0]!, await set[1]!];
    expect(second.runId).toBe(first.runId);
    const params = { id: String(first.runId) };
    for (const [shardIndex, { setupToken }] of [first, second].entries()) {
      const { streamToken } = (await routes.begin!({
        params,
        headers: header(setupToken),
        body: { setupToken, totalTests: 1, reporterVersion: '0.65.0', ...shards, shardIndex: shardIndex + 1 },
      })) as { streamToken: string };
      // Another shard's token is not this one's: refused before the body.
      await expect(
        routes.events!({ params, headers: header('b'.repeat(64)), body: { streamToken, testCases: [] } }),
      ).rejects.toMatchObject({ statusCode: 403 });
      runEventBus.clearRunState(first.runId);
      await routes.events!({
        params,
        headers: header(streamToken),
        body: { streamToken, testCases: [{ ...result, title: `shard ${shardIndex + 1}`, shardIndex: shardIndex + 1 }] },
      });
      await routes.finish!({
        params,
        headers: header(streamToken),
        body: { streamToken, status: 'passed', duration: 10, ...shards, shardIndex: shardIndex + 1, durations: [10] },
      });
    }
    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, first.runId));
    expect(run).toMatchObject({ status: 'passed', shardsFinished: 2 });
    expect(
      await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, first.runId)),
    ).toHaveLength(2);
  });

  test('of an older reporter, without the header, is delivered', async () => {
    const { finished, cases } = await streamRun(undefined, '0.64.0', false);
    expect(finished).toMatchObject({ success: true, status: 'passed' });
    expect(cases).toHaveLength(1);
  });
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

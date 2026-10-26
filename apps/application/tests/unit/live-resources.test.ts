import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import {
  LIVE_SERIES_CAP,
  applyLiveResources,
  applyLiveResourcesToParts,
  liveResourcesSnapshot,
  sanitizeLiveResources,
} from '#shared/live-resources';
import type { SeriesPoint, WireLiveResources } from '#shared/types';

/**
 * A live run's resources: the posts a reporter sends while someone watches
 * the run, merged into the series the workers timeline draws, by the server
 * (kept until the run ends, streamed to its viewers) and by the run page alike.
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

interface RouteEvent {
  params?: Record<string, string>;
  body: Record<string, unknown>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const liveResources = (await import('../../server/api/test-runs/[id]/live-resources.post')).default as unknown as Route;
const { runEventBus } = await import('../../server/utils/run-events');

function post(
  parts: Partial<WireLiveResources> & { timeline?: Partial<WireLiveResources['timeline']> } = {},
): WireLiveResources {
  return {
    shardIndex: null,
    reset: false,
    memoryCapacityBytes: null,
    memoryKind: null,
    ...parts,
    timeline: { startedAt: 1_000_000, cpuPct: [], memoryBytes: [], pages: [], workers: [], ...parts.timeline },
  };
}

describe('applyLiveResources', () => {
  const first = post({
    reset: true,
    memoryCapacityBytes: 8e9,
    memoryKind: 'pss',
    timeline: {
      cpuPct: [
        [1000, 40],
        [2000, 60],
      ],
      memoryBytes: [[1000, 5e8]],
      pages: [{ worker: 0, points: [[1200, 1]] }],
      workers: [{ worker: 0, cpuCores: [[1000, 0.5]], memoryBytes: [[1000, 2e8]] }],
    },
  });

  test('a post with every point starts the series, and a later one adds the points read after them', () => {
    const part = applyLiveResources(
      applyLiveResources(null, first),
      post({
        timeline: {
          // The first point repeats one already held: dropped.
          cpuPct: [
            [2000, 60],
            [3000, 70],
          ],
          pages: [
            {
              worker: 0,
              points: [
                [1200, 1],
                [2500, 0],
              ],
            },
          ],
          workers: [{ worker: 1, cpuCores: [[3000, 1]], memoryBytes: [] }],
        },
      }),
    );
    expect(part).toEqual({
      shardIndex: null,
      memoryCapacityBytes: 8e9,
      memoryKind: 'pss',
      timeline: {
        startedAt: 1_000_000,
        cpuPct: [
          [1000, 40],
          [2000, 60],
          [3000, 70],
        ],
        memoryBytes: [[1000, 5e8]],
        pages: [
          {
            worker: 0,
            points: [
              [1200, 1],
              [2500, 0],
            ],
          },
        ],
        workers: [
          { worker: 0, cpuCores: [[1000, 0.5]], memoryBytes: [[1000, 2e8]] },
          { worker: 1, cpuCores: [[3000, 1]], memoryBytes: [] },
        ],
      },
    });
  });

  test('a post with every point replaces what was held', () => {
    const part = applyLiveResources(
      applyLiveResources(null, first),
      post({ reset: true, timeline: { cpuPct: [[500, 10]] } }),
    );
    expect(part.timeline.cpuPct).toEqual([[500, 10]]);
    expect(part.timeline.workers).toEqual([]);
  });

  test('a long run keeps its whole span at a coarser step', () => {
    let part = applyLiveResources(null, first);
    for (let i = 0; i < 30; i++) {
      const cpuPct = Array.from({ length: 100 }, (_, j): SeriesPoint => [3000 + (i * 100 + j) * 1000, 50]);
      part = applyLiveResources(part, post({ timeline: { cpuPct } }));
    }
    expect(part.timeline.cpuPct.length).toBeLessThanOrEqual(LIVE_SERIES_CAP);
    expect(part.timeline.cpuPct[0]![0]).toBe(1000);
    expect(part.timeline.cpuPct.at(-1)![0]).toBeGreaterThan(2_900_000);
  });

  test('each reporter of a sharded run keeps its own part, in shard order', () => {
    const parts = applyLiveResourcesToParts(
      applyLiveResourcesToParts([], post({ reset: true, shardIndex: 2, timeline: { cpuPct: [[1, 2]] } })),
      post({ reset: true, shardIndex: 1, timeline: { cpuPct: [[1, 3]] } }),
    );
    expect(parts.map((p) => p.shardIndex)).toEqual([1, 2]);
    expect(liveResourcesSnapshot(parts[0]!)).toMatchObject({ shardIndex: 1, reset: true });
  });
});

describe('sanitizeLiveResources', () => {
  test('rebuilds a post within the report’s bounds and refuses one with no series', () => {
    expect(sanitizeLiveResources({ timeline: { startedAt: 5, cpuPct: [] } })).toBeNull();
    expect(sanitizeLiveResources('nope')).toBeNull();
    const clean = sanitizeLiveResources({
      shardIndex: -1,
      reset: 'yes',
      memoryKind: 'heap',
      memoryCapacityBytes: Infinity,
      timeline: {
        startedAt: 5,
        cpuPct: [
          [1, 250],
          ['x', 2],
          [2, 30],
        ],
      },
    });
    expect(clean).toEqual({
      shardIndex: null,
      reset: false,
      memoryCapacityBytes: null,
      memoryKind: null,
      timeline: {
        startedAt: 5,
        cpuPct: [
          [1, 100],
          [2, 30],
        ],
        memoryBytes: [],
        pages: [],
        workers: [],
      },
    });
  });
});

describe('POST /api/test-runs/:id/live-resources', () => {
  type Db = ReturnType<typeof drizzle<typeof schema>>;
  let db: Db;
  const runs: number[] = [];

  beforeEach(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    state.db = db;
  });

  afterEach(() => {
    for (const id of runs) runEventBus.cleanup(id);
    runs.length = 0;
  });

  async function startRun(projectName = 'live-resources') {
    const { runId, streamToken } = await start({ body: { projectName, totalTests: 2 } });
    runs.push(runId as number);
    return { runId: runId as number, streamToken: streamToken as string };
  }

  const send = (runId: number, body: Record<string, unknown>) => liveResources({ params: { id: String(runId) }, body });

  test('keeps the posts, streams each to the run’s viewers and replays them to a late one', async () => {
    const { runId, streamToken } = await startRun();
    expect(await send(runId, { streamToken, ...post({ reset: true, timeline: { cpuPct: [[1000, 40]] } }) })).toEqual({
      watched: false,
    });

    const published: Array<{ type: string; data: any }> = [];
    const unsubscribe = runEventBus.subscribe(runId, (event) => published.push(event as never));
    try {
      expect(await send(runId, { streamToken, ...post({ timeline: { cpuPct: [[2000, 60]] } }) })).toEqual({
        watched: true,
      });
    } finally {
      unsubscribe();
    }
    expect(published).toEqual([
      expect.objectContaining({ type: 'resources', data: expect.objectContaining({ reset: false }) }),
    ]);
    expect(runEventBus.getLiveResources(runId)[0]!.timeline.cpuPct).toEqual([
      [1000, 40],
      [2000, 60],
    ]);

    runEventBus.cleanup(runId);
    expect(runEventBus.getLiveResources(runId)).toEqual([]);
  });

  test('asks for every point when it holds nothing for the reporter', async () => {
    const { runId, streamToken } = await startRun();
    expect(await send(runId, { streamToken, ...post({ timeline: { cpuPct: [[2000, 60]] } }) })).toEqual({
      watched: false,
      resync: true,
    });
    expect(runEventBus.getLiveResources(runId)).toEqual([]);
  });

  test('refuses a wrong token, and keeps nothing for a project that declined resources', async () => {
    const { runId } = await startRun();
    await expect(
      send(runId, { streamToken: 'wrong', ...post({ reset: true, timeline: { cpuPct: [[1, 1]] } }) }),
    ).rejects.toMatchObject({
      statusCode: 403,
    });

    const declined = await startRun('declines-resources');
    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, declined.runId));
    await db
      .update(schema.projects)
      .set({ capabilities: { resources: 'declined' } })
      .where(eq(schema.projects.id, run!.projectId));
    expect(
      await send(declined.runId, {
        streamToken: declined.streamToken,
        ...post({ reset: true, timeline: { cpuPct: [[1, 1]] } }),
      }),
    ).toEqual({ watched: false, declined: true });
    expect(runEventBus.getLiveResources(declined.runId)).toEqual([]);
  });
});

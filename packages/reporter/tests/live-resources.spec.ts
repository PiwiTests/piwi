import { describe, it, expect, vi } from 'vitest';
import type { SeriesPoint } from '@piwitests/core/wire';
import { LiveResources, type LiveStream } from '../src/internal/streaming/live-resources.js';
import { HttpError, type HttpClient } from '../src/internal/transport/http-client.js';
import type { ResourceCensus } from '../src/internal/capture/resource-ledger.js';
import type { RunSampler, RunSamples } from '../src/internal/collect/process-sampler.js';

const STARTED_AT = 1_000_000;

const ref = (id: string) => ({ id, file: 'tests/cart.spec.ts', suite: [], title: `title ${id}` });

const page = (id: number, at: number) => ({
  id,
  kind: 'page' as const,
  parent: null,
  at,
  phase: 'test' as const,
  fixture: null,
  test: ref('t1'),
  site: 'tests/cart.spec.ts:4',
});

function census(worker: number, pid: number, at: number, parts: Partial<ResourceCensus> = {}): ResourceCensus {
  return { v: 1, worker, pid, at, test: ref(`t${at}`), born: [], closed: [], open: [], ...parts };
}

/** A sampler whose series the test grows by hand. */
function fakeSampler(samples: RunSamples): RunSampler {
  return {
    timedSeries: () => ({
      ...samples,
      cpuPct: [...samples.cpuPct],
      memoryBytes: [...samples.memoryBytes],
      workers: samples.workers.map((w) => ({ ...w, cpuCores: [...w.cpuCores], memoryBytes: [...w.memoryBytes] })),
    }),
    liveMemory: () => ({ capacityBytes: 8e9, kind: 'pss' as const }),
  } as unknown as RunSampler;
}

function setup(options: { answer?: (body: any) => unknown; watched?: boolean | null } = {}) {
  const samples: RunSamples = {
    startedAt: STARTED_AT,
    cpuPct: [
      [1000, 40],
      [2000, 60],
    ],
    memoryBytes: [[1000, 5e8]],
    workers: [{ pid: 4242, cpuCores: [[1000, 0.5]], memoryBytes: [[1000, 2e8]] }],
  };
  const censuses: ResourceCensus[] = [];
  const posts: any[] = [];
  const stream: LiveStream & { isWatched: boolean | null } = {
    enabled: true,
    runId: 7,
    token: 'tok',
    auth: null,
    isWatched: options.watched === undefined ? true : options.watched,
    noteWatched: vi.fn(),
  };
  const httpClient = {
    postJSON: vi.fn(async (url: string, body: any) => {
      expect(url).toBe('/api/test-runs/7/live-resources');
      posts.push(body);
      return options.answer ? options.answer(body) : { watched: true };
    }),
  } as unknown as HttpClient;
  const live = new LiveResources(stream, httpClient, {
    sampler: fakeSampler(samples),
    censuses: () => censuses,
    shardIndex: null,
    runStartedAt: STARTED_AT,
  });
  return { live, samples, censuses, posts, stream, httpClient };
}

describe('LiveResources', () => {
  it('posts nothing while nobody watches the run, or before the stream opens', async () => {
    const unwatched = setup({ watched: false });
    expect(unwatched.live.tick()).toBeNull();
    const unknown = setup({ watched: null });
    expect(unknown.live.tick()).toBeNull();
    const closed = setup();
    (closed.stream as { enabled: boolean }).enabled = false;
    expect(closed.live.tick()).toBeNull();
    expect(unwatched.posts.length + unknown.posts.length + closed.posts.length).toBe(0);
  });

  it('posts every point first, then only the points read since the last post', async () => {
    const { live, samples, censuses, posts, stream } = setup();
    censuses.push(census(0, 4242, STARTED_AT + 1500, { born: [page(1, STARTED_AT + 1200)], open: [{ id: 1 } as any] }));
    await live.tick();
    expect(posts[0]).toMatchObject({
      streamToken: 'tok',
      shardIndex: null,
      reset: true,
      memoryCapacityBytes: 8e9,
      memoryKind: 'pss',
      timeline: {
        startedAt: STARTED_AT,
        cpuPct: [
          [1000, 40],
          [2000, 60],
        ],
        memoryBytes: [[1000, 5e8]],
        // The worker's page is still open: no closing point at its last census while the run goes on.
        pages: [{ worker: 0, points: [[1200, 1]] }],
        workers: [{ worker: 0, cpuCores: [[1000, 0.5]], memoryBytes: [[1000, 2e8]] }],
      },
    });
    expect(stream.noteWatched).toHaveBeenCalledWith({ watched: true });

    samples.cpuPct.push([3000, 70]);
    samples.workers[0]!.cpuCores.push([3000, 1.5]);
    await live.tick();
    expect(posts[1]).toMatchObject({
      reset: false,
      timeline: {
        cpuPct: [[3000, 70]],
        memoryBytes: [],
        pages: [],
        workers: [{ worker: 0, cpuCores: [[3000, 1.5]], memoryBytes: [] }],
      },
    });

    // Nothing new: no post.
    expect(live.tick()).toBeNull();
    expect(posts).toHaveLength(2);
  });

  it('sends each worker’s pages whole when a census came in', async () => {
    const { live, censuses, posts } = setup();
    censuses.push(census(0, 4242, STARTED_AT + 1500, { born: [page(1, STARTED_AT + 1200)] }));
    await live.tick();
    censuses.push(census(0, 4242, STARTED_AT + 2500, { closed: [{ id: 1, at: STARTED_AT + 2400 } as any] }));
    await live.tick();
    expect(posts[1].timeline.pages).toEqual([
      {
        worker: 0,
        points: [
          [1200, 1],
          [2400, 0],
        ],
      },
    ]);
  });

  it('leaves out a worker process no census names yet', async () => {
    const { live, posts } = setup();
    await live.tick();
    expect(posts[0].timeline.workers).toEqual([]);
  });

  it('sends every point again when the dashboard lost them', async () => {
    const answers: unknown[] = [{ watched: true }, { watched: true, resync: true }, { watched: true }];
    const { live, samples, posts } = setup({ answer: () => answers.shift() });
    await live.tick();
    samples.cpuPct.push([3000, 70]);
    await live.tick();
    samples.cpuPct.push([4000, 80]);
    await live.tick();
    expect(posts[2].reset).toBe(true);
    expect(posts[2].timeline.cpuPct).toEqual([
      [1000, 40],
      [2000, 60],
      [3000, 70],
      [4000, 80],
    ]);
  });

  it('keeps the points of a failed post for the next one', async () => {
    let fail = true;
    const { live, samples, posts } = setup({
      answer: () => {
        if (fail) throw new Error('socket hang up');
        return { watched: true };
      },
    });
    await live.tick();
    fail = false;
    samples.cpuPct.push([3000, 70]);
    await live.tick();
    expect(posts[1].reset).toBe(true);
    expect(posts[1].timeline.cpuPct).toHaveLength(3);
  });

  it('stops on a dashboard without the route, and on a project that declined resources', async () => {
    const old = setup({
      answer: () => {
        throw new HttpError(404, 'Not found');
      },
    });
    await old.live.tick();
    old.samples.cpuPct.push([3000, 70]);
    expect(old.live.tick()).toBeNull();

    const declined = setup({ answer: () => ({ watched: false, declined: true }) });
    await declined.live.tick();
    declined.samples.cpuPct.push([3000, 70]);
    expect(declined.live.tick()).toBeNull();
    expect(declined.stream.noteWatched).not.toHaveBeenCalled();
  });

  it('keeps a long gap within the caps the dashboard accepts', async () => {
    const { live, samples, posts } = setup();
    samples.cpuPct = Array.from({ length: 2000 }, (_, i): SeriesPoint => [i * 1000, 50]);
    await live.tick();
    expect(posts[0].timeline.cpuPct.length).toBeLessThanOrEqual(600);
  });
});

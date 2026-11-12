import { describe, expect, it, vi } from 'vitest';
import type { RunVideos } from '#shared/handlers/run-videos';

/** The video review reads the run's video list through a per-run cache, so opening it again does not ask again. */

vi.stubGlobal('$fetch', vi.fn());
const { createRunVideosCache } = await import('../../app/utils/run-videos-cache');

const list = (n: number): RunVideos => ({ executions: [], truncated: false, videoCount: n }) as unknown as RunVideos;

describe('createRunVideosCache', () => {
  it('asks once for a run however often it is read', async () => {
    const fetcher = vi.fn(async (runId: number) => list(runId));
    const cache = createRunVideosCache(fetcher);
    const [a, b] = await Promise.all([cache.read(1), cache.read(1)]);
    expect(await cache.read(1)).toBe(a);
    expect(b).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps one list for each run', async () => {
    const fetcher = vi.fn(async (runId: number) => list(runId));
    const cache = createRunVideosCache(fetcher);
    expect((await cache.read(1)).videoCount).toBe(1);
    expect((await cache.read(2)).videoCount).toBe(2);
    await cache.read(1);
    expect(fetcher.mock.calls.map(([id]) => id)).toEqual([1, 2]);
  });

  it('asks again once the list is old', async () => {
    let at = 0;
    const fetcher = vi.fn(async (runId: number) => list(runId));
    const cache = createRunVideosCache(fetcher, () => at);
    await cache.read(1);
    at = 4 * 60 * 1000;
    await cache.read(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    at = 6 * 60 * 1000;
    await cache.read(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read: the next one asks again', async () => {
    const fetcher = vi
      .fn<(runId: number) => Promise<RunVideos>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(list(1));
    const cache = createRunVideosCache(fetcher);
    await expect(cache.read(1)).rejects.toThrow('offline');
    expect((await cache.read(1)).videoCount).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a few runs, the oldest going first', async () => {
    const fetcher = vi.fn(async (runId: number) => list(runId));
    const cache = createRunVideosCache(fetcher);
    for (const id of [1, 2, 3, 4, 5]) await cache.read(id);
    await cache.read(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
    await cache.read(1);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});

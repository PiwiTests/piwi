import { describe, expect, it, vi } from 'vitest';
import type { VideoActionsResponse } from '#shared/video-actions';

/** The marks under the player read an execution's actions through a cache, so moving along a reel does not ask again. */

vi.stubGlobal('$fetch', vi.fn());
const { createVideoActionsCache } = await import('../../app/utils/video-actions-cache');

const answer = (total: number): VideoActionsResponse => ({
  source: 'steps',
  timing: 'start',
  actions: [],
  total,
  capped: false,
});

describe('createVideoActionsCache', () => {
  it('asks once for an execution however often it is read', async () => {
    const fetcher = vi.fn(async (id: number) => answer(id));
    const cache = createVideoActionsCache(fetcher);
    const [a, b] = await Promise.all([cache.read(1), cache.read(1)]);
    expect(await cache.read(1)).toBe(a);
    expect(b).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps one answer for each execution', async () => {
    const fetcher = vi.fn(async (id: number) => answer(id));
    const cache = createVideoActionsCache(fetcher);
    expect((await cache.read(1)).total).toBe(1);
    expect((await cache.read(2)).total).toBe(2);
    await cache.read(1);
    expect(fetcher.mock.calls.map(([id]) => id)).toEqual([1, 2]);
  });

  it('asks again once the answer is old', async () => {
    let at = 0;
    const fetcher = vi.fn(async (id: number) => answer(id));
    const cache = createVideoActionsCache(fetcher, () => at);
    await cache.read(1);
    at = 4 * 60 * 1000;
    await cache.read(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    at = 6 * 60 * 1000;
    await cache.read(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValue(answer(1));
    const cache = createVideoActionsCache(fetcher);
    await expect(cache.read(1)).rejects.toThrow('503');
    await Promise.resolve();
    expect((await cache.read(1)).total).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('forgets the oldest executions past its limit', async () => {
    const fetcher = vi.fn(async (id: number) => answer(id));
    const cache = createVideoActionsCache(fetcher);
    for (let id = 1; id <= 25; id++) await cache.read(id);
    await cache.read(1);
    expect(fetcher).toHaveBeenCalledTimes(26);
    await cache.read(25);
    expect(fetcher).toHaveBeenCalledTimes(26);
  });
});

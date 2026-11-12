import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { LIVE_FRAME_BYTE_RATE, decodeLiveMessage, readLiveWorkerPost } from '@piwitests/core/live-view';
import { INSPECT_MASKED, LiveByteBudget, LiveInspect } from '../src/internal/capture/live-inspect.js';

/**
 * Inspect's producer apart from a run: a project that masks elements gets why no snapshot goes, and no trace is read
 * nor started for it; the bytes a second the live view's frames and Inspect share.
 */

const ID = { shard: null, worker: 1, slot: 0 };

afterEach(() => {
  vi.useRealTimers();
});

describe('Inspect of a page', () => {
  it('sends why no snapshot goes for a project that masks elements, or masks this reporter cannot read', async () => {
    for (const masks of [["getByLabel('IBAN')"], null]) {
      const posted: Uint8Array[] = [];
      // A page Inspect never touches: no trace is read nor started.
      const page = new Proxy({} as Page, {
        get: () => {
          throw new Error('the page was read');
        },
      });
      const inspect = new LiveInspect(page, {
        id: ID,
        test: () => 'pays',
        masks: () => masks,
        post: async (body) => {
          posted.push(body);
          return 200;
        },
        budget: new LiveByteBudget(),
        sent: new Set(),
      });
      await inspect.open();
      await inspect.close();
      expect(posted).toHaveLength(1);
      const message = decodeLiveMessage(posted[0]!, { maxData: 0 });
      expect(typeof message === 'string' ? message : readLiveWorkerPost(message)).toEqual({
        type: 'snapshot',
        ...ID,
        refused: INSPECT_MASKED,
        test: 'pays',
      });
    }
  });
});

describe('the live view’s bytes a second', () => {
  it('hold Inspect back by what the frames and its own posts took, a second at most', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const budget = new LiveByteBudget();
    expect(budget.wait()).toBe(0);
    budget.spend(LIVE_FRAME_BYTE_RATE / 4);
    expect(budget.wait()).toBe(250);
    vi.advanceTimersByTime(100);
    expect(budget.wait()).toBe(150);
    budget.spend(LIVE_FRAME_BYTE_RATE * 10);
    expect(budget.wait()).toBe(1000);
    vi.advanceTimersByTime(20_000);
    expect(budget.wait()).toBe(0);
  });
});

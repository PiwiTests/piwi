import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LIVE_HEARTBEAT,
  LIVE_STREAM_TYPE,
  encodeLiveViewerMessage,
  type LiveViewerMessage,
  type LiveWorkerId,
} from '@piwitests/core/live-view';
import { LiveWatch, liveWatchQuery, sameWorker, type LiveWatchState } from '../../app/utils/live-watch';

/**
 * The run page's one watch of a live run: it opens as something is wanted (a full view in the query, or tiles alone
 * and the full view asked once open), reads the stream's live messages across chunks, changes what it shows by a POST
 * naming the watch, opens again after a drop, and stays closed after the instance refused it or ended it, until the
 * page asks again.
 */

const URL = '/api/test-runs/7/live-view/watch';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
const LANE: LiveWorkerId = { shard: null, worker: 0, slot: 0 };
const OTHER: LiveWorkerId = { shard: null, worker: 1, slot: 1 };

/** A fake instance: each GET a stream the test writes to, each POST answered with `postStatus`. */
function instance() {
  const gets: Array<{ url: string; write: (bytes: Uint8Array) => void; close: () => void }> = [];
  const posts: Array<Record<string, unknown>> = [];
  let getStatus = 200;
  let postStatus = 200;
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response('{}', { status: postStatus });
    }
    expect((init!.headers as Record<string, string>).Accept).toBe(LIVE_STREAM_TYPE);
    if (getStatus !== 200) return new Response('{}', { status: getStatus });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    gets.push({ url, write: (bytes) => controller.enqueue(bytes), close: () => controller.close() });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetcher,
    gets,
    posts,
    refuseGets: (status: number) => (getStatus = status),
    refusePosts: (status: number) => (postStatus = status),
  };
}

function watcher() {
  const fake = instance();
  const heard: LiveViewerMessage[] = [];
  const states: LiveWatchState[] = [];
  const refused: Array<{ focus: LiveWorkerId; status: number | null }> = [];
  const watch = new LiveWatch(
    URL,
    {
      message: (message) => heard.push(message),
      state: (state) => states.push(state),
      focusRefused: (focus, status) => refused.push({ focus, status }),
    },
    fake.fetcher,
  );
  return { ...fake, watch, heard, states, refused };
}

/** Let the stream's reads and the posts go on. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

const HELLO = encodeLiveViewerMessage({ type: 'hello', watch: 'abcdefghijklmnopqrstuv' });

afterEach(() => {
  vi.useRealTimers();
});

describe('the run page’s watch', () => {
  test('names a full view in its query alone without tiles, and its size', () => {
    expect(String(liveWatchQuery({ focus: { shard: 2, worker: 3, slot: 1 }, tiles: false, size: null }))).toBe(
      'worker=3&shard=2&slot=1',
    );
    expect(String(liveWatchQuery({ focus: LANE, tiles: true, size: { width: 900, height: 600 } }))).toBe(
      'tiles=1&width=900&height=600',
    );
    expect(sameWorker({ shard: null, worker: 0, slot: 1 }, { shard: null, worker: 4, slot: 1 })).toBe(true);
    expect(sameWorker({ shard: null, worker: 0 }, { shard: null, worker: 0, slot: 1 })).toBe(true);
    expect(sameWorker({ shard: 1, worker: 0 }, { shard: 2, worker: 0 })).toBe(false);
  });

  test('reads its messages across chunks, and says it is open once the instance names it', async () => {
    const { watch, gets, heard, states } = watcher();
    watch.want({ focus: LANE, tiles: false, size: null });
    await settle();
    expect(gets.map((get) => get.url)).toEqual([`${URL}?worker=0&slot=0`]);
    expect(states.at(-1)).toEqual({ kind: 'connecting', again: false });
    const frame = encodeLiveViewerMessage({ type: 'frame', ...LANE, image: JPEG, call: null, test: 'pays' });
    const all = new Uint8Array([...HELLO, ...LIVE_HEARTBEAT, ...frame]);
    for (let at = 0; at < all.length; at += 5) gets[0]!.write(all.subarray(at, at + 5));
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'open' });
    expect(heard).toEqual([{ type: 'frame', ...LANE, image: JPEG, call: null, test: 'pays' }]);
    watch.close();
    expect(states.at(-1)).toEqual({ kind: 'idle' });
  });

  test('changes what it shows on the same stream, saying what changed alone', async () => {
    const { watch, gets, posts } = watcher();
    watch.want({ focus: null, tiles: true, size: null });
    await settle();
    expect(gets.map((get) => get.url)).toEqual([`${URL}?tiles=1`]);
    // Asked before the instance named the watch: it goes once it did.
    watch.want({ focus: LANE, tiles: true, size: null });
    await settle();
    expect(posts).toEqual([]);
    gets[0]!.write(HELLO);
    await settle();
    expect(posts).toEqual([{ watch: 'abcdefghijklmnopqrstuv', focus: LANE }]);
    watch.want({ focus: LANE, tiles: true, size: { width: 900, height: 600 } });
    await settle();
    watch.want({ focus: OTHER, tiles: false, size: { width: 900, height: 600 } });
    await settle();
    watch.want({ focus: OTHER, tiles: false, size: { width: 900, height: 600 } });
    await settle();
    expect(posts.slice(1)).toEqual([
      { watch: 'abcdefghijklmnopqrstuv', width: 900, height: 600 },
      { watch: 'abcdefghijklmnopqrstuv', focus: OTHER, tiles: false },
    ]);
    expect(gets).toHaveLength(1);
    watch.close();
  });

  test('hears a full view the instance refuses, and asks for it again once the page does', async () => {
    const { watch, gets, posts, refused, refusePosts } = watcher();
    watch.want({ focus: null, tiles: true, size: null });
    await settle();
    gets[0]!.write(HELLO);
    await settle();
    refusePosts(404);
    watch.want({ focus: OTHER, tiles: true, size: null });
    await settle();
    expect(refused).toEqual([{ focus: OTHER, status: 404 }]);
    expect(posts).toHaveLength(1);
    // The full view of a worker whose test ended is asked anew.
    refusePosts(200);
    watch.want({ focus: LANE, tiles: true, size: null });
    await settle();
    gets[0]!.write(encodeLiveViewerMessage({ type: 'end', ...LANE, reason: 'test-ended' }));
    await settle();
    watch.want({ focus: LANE, tiles: true, size: null });
    await settle();
    expect(posts.slice(1)).toEqual([
      { watch: 'abcdefghijklmnopqrstuv', focus: LANE },
      { watch: 'abcdefghijklmnopqrstuv', focus: LANE },
    ]);
    watch.close();
  });

  test('stays closed once the instance refused it or ended it, until the page asks again', async () => {
    const { watch, gets, states, refused, refuseGets } = watcher();
    refuseGets(429);
    watch.want({ focus: LANE, tiles: false, size: null });
    await settle();
    expect(refused).toEqual([{ focus: LANE, status: 429 }]);
    expect(states.at(-1)).toEqual({ kind: 'closed', status: 429, reason: null });
    watch.want({ focus: OTHER, tiles: false, size: null });
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'closed', status: 429, reason: null });
    refuseGets(200);
    watch.resume();
    await settle();
    expect(gets.map((get) => get.url)).toEqual([`${URL}?worker=1&slot=1`]);
    gets[0]!.write(new Uint8Array([...HELLO, ...encodeLiveViewerMessage({ type: 'end', reason: 'run-ended' })]));
    gets[0]!.close();
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'closed', status: null, reason: 'run-ended' });
    watch.want({ focus: null, tiles: true, size: null });
    await settle();
    expect(gets).toHaveLength(1);
  });

  test('opens again after a drop, waiting a little, and gives up after a few tries in a row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watch, gets, states } = watcher();
    watch.want({ focus: null, tiles: true, size: null });
    await settle();
    gets[0]!.write(HELLO);
    gets[0]!.close();
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'connecting', again: true });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(gets).toHaveLength(2);
    // Opened again: its tries count afresh. Five drops in a row before the instance names it give up.
    gets[1]!.write(HELLO);
    for (let drop = 0; drop < 6; drop++) {
      gets.at(-1)!.close();
      await settle();
      vi.advanceTimersByTime(16_000);
      await settle();
    }
    expect(states.at(-1)).toEqual({ kind: 'closed', status: null, reason: null });
    expect(gets).toHaveLength(7);
  });
});

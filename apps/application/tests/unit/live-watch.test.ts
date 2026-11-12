import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LIVE_HEARTBEAT,
  LIVE_STREAM_TYPE,
  encodeLiveViewerMessage,
  type LiveViewerMessage,
  type LiveWorkerId,
} from '@piwitests/core/live-view';
import {
  LiveWatch,
  STALL_MS,
  STEADY_MS,
  heldLayers,
  liveWatchQuery,
  readLiveWatchShown,
  sameWorker,
  type LiveWatchState,
} from '../../app/utils/live-watch';

/**
 * The run page's one watch of a live run: it opens as something is wanted (a full view in the query, or tiles alone
 * and the full view asked once open), reads the stream's live messages across chunks, changes what it shows by a POST
 * naming the watch and holds what the instance answers it shows, asks for the layers the lane panel shows and the
 * page's text as the panel asks, asks again for a change that failed and opens the stream again after repeated
 * failures, opens again after a drop or a stream that brings nothing, and stays closed after the instance refused it or
 * ended it, until the page asks again.
 */

const URL = '/api/test-runs/7/live-view/watch';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
const LANE: LiveWorkerId = { shard: null, worker: 0, slot: 0 };
const OTHER: LiveWorkerId = { shard: null, worker: 1, slot: 1 };

/**
 * A fake instance: each GET a stream the test writes to, each POST answered with what the watch shows then (its layers
 * left out while `sayLayers` is off), a full view refused (404, the rest applied) while `refuseFocus`, or a failure
 * (`failPosts`: a status with no state, or `null` for no answer).
 */
function instance() {
  const gets: Array<{
    url: string;
    write: (bytes: Uint8Array) => void;
    close: () => void;
    aborted: () => boolean;
    cancelled: () => boolean;
  }> = [];
  const posts: Array<Record<string, unknown>> = [];
  let getStatus = 200;
  let refuseFocus = false;
  let failure: number | null | undefined;
  let saysLayers = true;
  let shown: { focus: unknown; tiles: boolean; width: number; height: number; layers?: unknown } = {
    focus: null,
    tiles: false,
    width: 640,
    height: 400,
  };
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      if (failure === null) throw new TypeError('Failed to fetch');
      if (failure !== undefined) return new Response('{}', { status: failure });
      const focusRefused = refuseFocus && !!body.focus;
      shown = {
        focus: focusRefused ? null : 'focus' in body ? body.focus : shown.focus,
        tiles: typeof body.tiles === 'boolean' ? body.tiles : shown.tiles,
        width: typeof body.width === 'number' ? body.width : shown.width,
        height: typeof body.height === 'number' ? body.height : shown.height,
        ...(saysLayers ? { layers: Array.isArray(body.layers) ? body.layers : (shown.layers ?? []) } : {}),
      };
      return focusRefused
        ? new Response(JSON.stringify({ statusCode: 404, data: { errorCode: 'NOT_FOUND', watch: shown } }), {
            status: 404,
          })
        : new Response(JSON.stringify({ success: true, watch: shown }), { status: 200 });
    }
    expect((init!.headers as Record<string, string>).Accept).toBe(LIVE_STREAM_TYPE);
    if (getStatus !== 200) return new Response('{}', { status: getStatus });
    const query = new globalThis.URL(url, 'http://x').searchParams;
    const worker = query.get('worker');
    shown = {
      focus: worker === null ? null : { shard: null, worker: Number(worker), slot: Number(query.get('slot')) },
      tiles: query.get('tiles') === '1',
      width: 640,
      height: 400,
      layers: query.get('layers')?.split(',') ?? [],
    };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => void (controller = c),
      cancel: () => void (cancelled = true),
    });
    init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    gets.push({
      url,
      write: (bytes) => controller.enqueue(bytes),
      close: () => controller.close(),
      aborted: () => !!init?.signal?.aborted,
      cancelled: () => cancelled,
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetcher,
    gets,
    posts,
    refuseGets: (status: number) => (getStatus = status),
    refuseFocus: (on: boolean) => (refuseFocus = on),
    sayLayers: (on: boolean) => (saysLayers = on),
    failPosts: (status: number | null | undefined) => (failure = status),
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

const WATCH = 'abcdefghijklmnopqrstuv';
const HELLO = encodeLiveViewerMessage({ type: 'hello', watch: WATCH });

afterEach(() => {
  vi.useRealTimers();
});

describe('the run page’s watch', () => {
  test('names a full view in its query alone without tiles, and its size', () => {
    expect(
      String(liveWatchQuery({ focus: { shard: 2, worker: 3, slot: 1 }, tiles: false, size: null, layers: [] })),
    ).toBe('worker=3&shard=2&slot=1');
    expect(String(liveWatchQuery({ focus: LANE, tiles: true, size: { width: 900, height: 600 }, layers: [] }))).toBe(
      'tiles=1&width=900&height=600',
    );
    expect(sameWorker({ shard: null, worker: 0, slot: 1 }, { shard: null, worker: 4, slot: 1 })).toBe(true);
    expect(sameWorker({ shard: null, worker: 0 }, { shard: null, worker: 0, slot: 1 })).toBe(true);
    expect(sameWorker({ shard: 1, worker: 0 }, { shard: 2, worker: 0 })).toBe(false);
  });

  test('reads its messages across chunks, and says it is open once the instance names it', async () => {
    const { watch, gets, heard, states } = watcher();
    watch.want({ focus: LANE, tiles: false, size: null, layers: [] });
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
    watch.want({ focus: null, tiles: true, size: null, layers: [] });
    await settle();
    expect(gets.map((get) => get.url)).toEqual([`${URL}?tiles=1`]);
    // Asked before the instance named the watch: it goes once it did.
    watch.want({ focus: LANE, tiles: true, size: null, layers: [] });
    await settle();
    expect(posts).toEqual([]);
    gets[0]!.write(HELLO);
    await settle();
    expect(posts).toEqual([{ watch: 'abcdefghijklmnopqrstuv', focus: LANE }]);
    watch.want({ focus: LANE, tiles: true, size: { width: 900, height: 600 }, layers: [] });
    await settle();
    watch.want({ focus: OTHER, tiles: false, size: { width: 900, height: 600 }, layers: [] });
    await settle();
    watch.want({ focus: OTHER, tiles: false, size: { width: 900, height: 600 }, layers: [] });
    await settle();
    expect(posts.slice(1)).toEqual([
      { watch: 'abcdefghijklmnopqrstuv', width: 900, height: 600 },
      { watch: 'abcdefghijklmnopqrstuv', focus: OTHER, tiles: false },
    ]);
    expect(gets).toHaveLength(1);
    watch.close();
  });

  test('asks for the layers the lane panel shows, in its query and its changes, and the page’s text as asked', async () => {
    const { watch, gets, posts } = watcher();
    watch.want({ focus: LANE, tiles: false, size: null, layers: ['filmstrip', 'events'] });
    await settle();
    // In the order a worker lists them, whatever the order asked.
    expect(gets.map((get) => new globalThis.URL(get.url, 'http://x').searchParams.get('layers'))).toEqual([
      'events,filmstrip',
    ]);
    // The text asked before the instance named the watch goes once it did, with the layers that take it.
    watch.want({ focus: LANE, tiles: false, size: null, layers: ['events', 'text', 'filmstrip'] });
    watch.askText();
    await settle();
    expect(posts).toEqual([]);
    gets[0]!.write(HELLO);
    await settle();
    expect(posts).toEqual([{ watch: WATCH, layers: ['events', 'text', 'filmstrip'], text: true }]);
    // Asked again: the text alone.
    watch.askText();
    await settle();
    expect(posts.at(-1)).toEqual({ watch: WATCH, text: true });
    // The text no longer shown: a text asked goes nowhere, and the layers change.
    watch.want({ focus: LANE, tiles: false, size: null, layers: ['filmstrip'] });
    watch.askText();
    await settle();
    expect(posts.slice(2)).toEqual([{ watch: WATCH, layers: ['filmstrip'] }]);
    watch.close();
  });

  test('asks a stream that opens with the text for the page’s text, and holds as asked the layers an answer leaves out', async () => {
    const { watch, gets, posts, sayLayers } = watcher();
    watch.want({ focus: LANE, tiles: false, size: null, layers: ['text'] });
    await settle();
    gets[0]!.write(HELLO);
    await settle();
    expect(posts).toEqual([{ watch: WATCH, text: true }]);
    sayLayers(false);
    watch.want({ focus: LANE, tiles: false, size: null, layers: ['events', 'text'] });
    await settle();
    watch.want({ focus: LANE, tiles: false, size: null, layers: ['events', 'text'] });
    await settle();
    expect(posts.slice(1)).toEqual([{ watch: WATCH, layers: ['events', 'text'] }]);
    watch.close();
  });

  test('asks for Inspect in its query and its changes, and names its watch by the id the stream opened with', async () => {
    const { watch, gets, posts } = watcher();
    watch.want({ focus: LANE, tiles: false, size: null, layers: [], inspect: true });
    await settle();
    expect(new globalThis.URL(gets[0]!.url, 'http://x').searchParams.get('inspect')).toBe('1');
    expect(watch.id).toBeNull();
    gets[0]!.write(HELLO);
    await settle();
    expect(watch.id).toBe(WATCH);
    expect(posts).toEqual([]);
    watch.want({ focus: LANE, tiles: false, size: null, layers: [] });
    await settle();
    expect(posts).toEqual([{ watch: WATCH, inspect: false }]);
    watch.want({ focus: LANE, tiles: false, size: null, layers: [], inspect: true });
    await settle();
    expect(posts.at(-1)).toEqual({ watch: WATCH, inspect: true });
    expect(readLiveWatchShown({ watch: { focus: null, tiles: false, width: 640, height: 400 } })?.inspect).toBeNull();
    watch.close();
    expect(watch.id).toBeNull();
  });

  test('holds the layers a worker posts beside its call log, in its order, as the instance says them', () => {
    expect(heldLayers(['filmstrip', 'calls', 'events'])).toEqual(['events', 'filmstrip']);
    const watch = { focus: null, tiles: false, width: 640, height: 400 };
    expect(readLiveWatchShown({ watch: { ...watch, layers: ['filmstrip', 'text', 'pixels'] } })?.layers).toEqual([
      'text',
      'filmstrip',
    ]);
    expect(readLiveWatchShown({ watch })?.layers).toBeNull();
  });

  test('hears a full view the instance refuses, and asks for it again once the page does', async () => {
    const { watch, gets, posts, refused, refuseFocus } = watcher();
    watch.want({ focus: null, tiles: true, size: null, layers: [] });
    await settle();
    gets[0]!.write(HELLO);
    await settle();
    refuseFocus(true);
    // Refused, the full view goes; the size asked with it is what the instance says it shows, not asked again.
    watch.want({ focus: OTHER, tiles: true, size: { width: 900, height: 600 }, layers: [] });
    await settle();
    expect(refused).toEqual([{ focus: OTHER, status: 404 }]);
    expect(posts).toEqual([{ watch: 'abcdefghijklmnopqrstuv', focus: OTHER, width: 900, height: 600 }]);
    watch.want({ focus: null, tiles: true, size: { width: 900, height: 600 }, layers: [] });
    await settle();
    expect(posts).toHaveLength(1);
    // The full view of a worker whose test ended is asked anew.
    refuseFocus(false);
    watch.want({ focus: LANE, tiles: true, size: null, layers: [] });
    await settle();
    gets[0]!.write(encodeLiveViewerMessage({ type: 'end', ...LANE, reason: 'test-ended' }));
    await settle();
    watch.want({ focus: LANE, tiles: true, size: null, layers: [] });
    await settle();
    expect(posts.slice(1)).toEqual([
      { watch: 'abcdefghijklmnopqrstuv', focus: LANE },
      { watch: 'abcdefghijklmnopqrstuv', focus: LANE },
    ]);
    watch.close();
  });

  test('asks again for a change the instance did not take, then opens the stream again with the whole ask', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watch, gets, posts, states, failPosts } = watcher();
    watch.want({ focus: null, tiles: true, size: null, layers: [] });
    await settle();
    gets[0]!.write(HELLO);
    await settle();
    // No answer, then an error: the size is not shown yet, and asked again a little later.
    failPosts(null);
    watch.want({ focus: null, tiles: true, size: { width: 900, height: 600 }, layers: [] });
    await settle();
    failPosts(503);
    vi.advanceTimersByTime(500);
    await settle();
    expect(posts).toHaveLength(2);
    // It goes through: the watch shows what the instance says.
    failPosts(undefined);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(posts).toHaveLength(3);
    watch.want({ focus: null, tiles: true, size: { width: 900, height: 600 }, layers: [] });
    await settle();
    expect(posts).toHaveLength(3);
    // A change that keeps failing: the stream opens again, its query asking for the whole of what the page wants.
    failPosts(500);
    watch.want({ focus: LANE, tiles: false, size: { width: 900, height: 600 }, layers: [] });
    for (const wait of [0, 500, 1000, 2000]) {
      vi.advanceTimersByTime(wait);
      await settle();
    }
    expect(posts).toHaveLength(7);
    expect(states.at(-1)).toEqual({ kind: 'connecting', again: true });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(gets.map((get) => get.url).at(-1)).toBe(`${URL}?worker=0&slot=0&width=900&height=600`);
    // A watch the instance no longer holds is opened again at once.
    gets.at(-1)!.write(HELLO);
    await settle();
    failPosts(404);
    watch.want({ focus: OTHER, tiles: false, size: { width: 900, height: 600 }, layers: [] });
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'connecting', again: true });
    watch.close();
  });

  test('drops a stream that brings nothing, not even its heartbeat, and opens it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watch, gets, states } = watcher();
    watch.want({ focus: LANE, tiles: false, size: null, layers: [] });
    await settle();
    gets[0]!.write(HELLO);
    await settle();
    vi.advanceTimersByTime(STALL_MS - 1000);
    gets[0]!.write(LIVE_HEARTBEAT);
    await settle();
    vi.advanceTimersByTime(STALL_MS - 1000);
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'open' });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'connecting', again: true });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(gets).toHaveLength(2);
    watch.close();
  });

  test('stays closed once the instance refused it or ended it, until the page asks again', async () => {
    const { watch, gets, states, refused, refuseGets } = watcher();
    refuseGets(429);
    watch.want({ focus: LANE, tiles: false, size: null, layers: [] });
    await settle();
    expect(refused).toEqual([{ focus: LANE, status: 429 }]);
    expect(states.at(-1)).toEqual({ kind: 'closed', status: 429, reason: null });
    watch.want({ focus: OTHER, tiles: false, size: null, layers: [] });
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
    watch.want({ focus: null, tiles: true, size: null, layers: [] });
    await settle();
    expect(gets).toHaveLength(1);
  });

  test('drops a stream that breaks its framing, letting it go, and gives up on one that breaks each time it opens', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watch, gets, states } = watcher();
    watch.want({ focus: LANE, tiles: false, size: null, layers: ['text'] });
    await settle();
    // A header longer than a reader takes: the stream is let go, its request aborted, and opened again.
    const broken = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    gets[0]!.write(HELLO);
    gets[0]!.write(broken);
    await settle();
    expect(gets[0]!.cancelled()).toBe(true);
    expect(gets[0]!.aborted()).toBe(true);
    expect(states.at(-1)).toEqual({ kind: 'connecting', again: true });
    // Each stream says hello and breaks again: a hello alone counts no stream that held, and the watch gives up.
    for (let drop = 0; drop < 5; drop++) {
      vi.advanceTimersByTime(16_000);
      await settle();
      gets.at(-1)!.write(HELLO);
      gets.at(-1)!.write(broken);
      await settle();
    }
    expect(states.at(-1)).toEqual({ kind: 'closed', status: null, reason: null });
    expect(gets).toHaveLength(6);
  });

  test('opens again after a drop, waiting a little, and gives up after a few tries in a row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watch, gets, states } = watcher();
    watch.want({ focus: null, tiles: true, size: null, layers: [] });
    await settle();
    gets[0]!.write(HELLO);
    gets[0]!.close();
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'connecting', again: true });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(gets).toHaveLength(2);
    // Opened again and held a while: its tries count afresh, five more, then it gives up.
    gets[1]!.write(HELLO);
    await settle();
    vi.advanceTimersByTime(STEADY_MS);
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

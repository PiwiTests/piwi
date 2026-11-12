import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_HEARTBEAT,
  LIVE_STREAM_TYPE,
  encodeLiveViewerMessage,
  type LiveViewerMessage,
} from '@piwitests/core/live-view';
import { CI_WATCH_SIZE, CiLaneWatch, base64Of, type CiViewer } from '../../src/background/ci-watch';
import type { ConnectionSettings } from '../../src/shared/connection-settings';
import type { CiWatchEnd, RunsCiFrame, RunsCiLane } from '../../src/shared/runs';

const settings: ConnectionSettings = {
  instanceUrl: 'https://piwi.example',
  projectMappings: [{ urlPattern: 'https://app.example/*', projectId: 7, projectLabel: '' }],
  serverMappings: [],
  serverProjects: [],
  serverSyncedAt: 0,
  connectedAs: '',
};

/** A watch's stream the test writes live messages to. */
function liveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return {
    response: new Response(body, { headers: { 'content-type': LIVE_STREAM_TYPE } }),
    send: (message: LiveViewerMessage) => controller.enqueue(encodeLiveViewerMessage(message)),
    beat: () => controller.enqueue(LIVE_HEARTBEAT),
    close: () => controller.close(),
  };
}

function viewer() {
  const frames: RunsCiFrame[] = [];
  const ended: Array<RunsCiLane & { why: CiWatchEnd }> = [];
  const it: CiViewer = {
    frame: (frame) => frames.push(frame),
    ended: (lane, why) => ended.push({ ...lane, why }),
  };
  return { it, frames, ended };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function watcher() {
  const opened: Array<{
    runId: number;
    query: URLSearchParams;
    signal: AbortSignal;
    stream: ReturnType<typeof liveStream>;
  }> = [];
  const posted: Array<{ runId: number; body: Record<string, unknown> }> = [];
  let target: { followed?: boolean; watchable: boolean; worker: number | null } | null = { watchable: true, worker: 3 };
  let answer: () => Promise<Response> = async () => new Response(null, { status: 204 });
  const watch = new CiLaneWatch({
    settings: async () => settings,
    target: () => target,
    open: async (_settings, runId, query, signal) => {
      const stream = liveStream();
      opened.push({ runId, query, signal, stream });
      return stream.response;
    },
    change: async (_settings, runId, body) => {
      posted.push({ runId, body });
      return answer();
    },
    idleMs: 5_000,
  });
  return {
    watch,
    opened,
    posted,
    setTarget: (next: typeof target) => (target = next),
    setAnswer: (next: () => Promise<Response>) => (answer = next),
  };
}

const LANE: RunsCiLane = { runId: 78, shard: null, lane: 1 };

describe('the watch of a CI lane', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens one watch of the run on the lane’s worker, its images going to the windows that watch it', async () => {
    vi.useFakeTimers();
    const { watch, opened } = watcher();
    const a = viewer();
    expect(await watch.watch(a.it, LANE, true)).toEqual({ ok: true, message: '' });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.runId).toBe(78);
    expect(Object.fromEntries(opened[0]!.query)).toEqual({
      worker: '3',
      slot: '1',
      width: String(CI_WATCH_SIZE.width),
      height: String(CI_WATCH_SIZE.height),
    });
    const s = opened[0]!.stream;
    s.send({ type: 'hello', watch: 'watch-0123456789ab' });
    s.send({
      type: 'frame',
      shard: null,
      worker: 3,
      slot: 1,
      image: JPEG,
      call: { title: 'Click', box: null } as never,
      test: 'pays',
    });
    // Another lane's image is not this one's.
    s.send({ type: 'frame', shard: null, worker: 4, slot: 2, image: JPEG, call: null, test: 'other' });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.frames).toEqual([{ ...LANE, data: base64Of(JPEG), test: 'pays', call: 'Click' }]);
    // A second window of the same lane shares the watch.
    const b = viewer();
    await watch.watch(b.it, LANE, true);
    expect(opened).toHaveLength(1);
    s.send({ type: 'refused', shard: null, worker: 3, slot: 1, message: 'The page is too heavy.' });
    await vi.advanceTimersByTimeAsync(200);
    expect(b.frames).toEqual([{ ...LANE, refused: 'The page is too heavy.' }]);
    // The watch ends with its last window, which hears nothing it did not ask.
    watch.leave(a.it);
    expect(opened[0]!.signal.aborted).toBe(false);
    await watch.watch(b.it, LANE, false);
    expect(opened[0]!.signal.aborted).toBe(true);
    expect(watch.watching()).toBeNull();
    expect([...a.ended, ...b.ended]).toEqual([]);
  });

  it('shows another lane of the run on the same watch, and opens a new one for another run', async () => {
    vi.useFakeTimers();
    const { watch, opened, posted } = watcher();
    const a = viewer();
    const b = viewer();
    await watch.watch(a.it, LANE, true);
    opened[0]!.stream.send({ type: 'hello', watch: 'watch-0123456789ab' });
    await vi.advanceTimersByTimeAsync(0);
    await watch.watch(b.it, LANE, true);
    const other = { ...LANE, lane: 0 };
    expect(await watch.watch(b.it, other, true)).toEqual({ ok: true, message: '' });
    expect(opened).toHaveLength(1);
    expect(posted).toEqual([
      {
        runId: 78,
        body: { watch: 'watch-0123456789ab', focus: { worker: 3, shard: null, slot: 0 }, ...CI_WATCH_SIZE },
      },
    ]);
    // The window that watched the lane before hears it moved.
    expect(a.ended).toEqual([{ ...LANE, why: 'moved' }]);
    expect(watch.watching()).toEqual(other);
    await watch.watch(b.it, { runId: 79, shard: 2, lane: 0 }, true);
    expect(opened).toHaveLength(2);
    expect(opened[0]!.signal.aborted).toBe(true);
    expect(opened[1]!.query.get('shard')).toBe('2');
  });

  it('says why it ended: the instance’s end, its silence, its close, the run leaving the list', async () => {
    vi.useFakeTimers();
    const { watch, opened } = watcher();
    const a = viewer();
    await watch.watch(a.it, LANE, true);
    opened[0]!.stream.send({ type: 'end', reason: 'run-ended' });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.ended).toEqual([{ ...LANE, why: 'run-ended' }]);
    expect(opened[0]!.signal.aborted).toBe(true);

    await watch.watch(a.it, LANE, true);
    opened[1]!.stream.beat();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(a.ended).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(a.ended[1]).toEqual({ ...LANE, why: 'silent' });

    await watch.watch(a.it, LANE, true);
    opened[2]!.stream.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.ended[2]).toEqual({ ...LANE, why: 'closed' });

    await watch.watch(a.it, LANE, true);
    // The end of another lane's view is not this watch's.
    opened[3]!.stream.send({ type: 'end', reason: 'worker-left', shard: null, worker: 9, slot: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.ended).toHaveLength(3);
    watch.runLeft(78);
    expect(a.ended[3]).toEqual({ ...LANE, why: 'run-ended' });
  });

  it('refuses a lane it cannot watch, saying why, and passes on the instance’s own refusal', async () => {
    const { watch, setTarget } = watcher();
    const a = viewer();
    setTarget(null);
    expect(await watch.watch(a.it, LANE, true)).toMatchObject({ ok: false, ci: 'unlisted' });
    setTarget({ watchable: false, worker: 3 });
    expect(await watch.watch(a.it, LANE, true)).toMatchObject({ ok: false, ci: 'unwatchable' });
    setTarget({ watchable: true, worker: null });
    expect(await watch.watch(a.it, LANE, true)).toMatchObject({ ok: false, ci: 'no-test' });

    const refusing = new CiLaneWatch({
      settings: async () => settings,
      target: () => ({ watchable: true, worker: 1 }),
      open: async () => Response.json({ message: 'Too many people watch this run' }, { status: 429 }),
      change: async () => new Response(null),
    });
    expect(await refusing.watch(a.it, LANE, true)).toEqual({
      ok: false,
      message: 'Too many people watch this run.',
      ci: 'refused',
    });
    const silent = new CiLaneWatch({
      settings: async () => settings,
      target: () => ({ watchable: true, worker: 1 }),
      open: async () => new Response('nope', { status: 503 }),
      change: async () => new Response(null),
    });
    expect(await silent.watch(a.it, LANE, true)).toEqual({ ok: false, message: '', ci: 'refused', status: 503 });
    const older = new CiLaneWatch({
      settings: async () => settings,
      target: () => ({ watchable: true, worker: 1 }),
      open: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      change: async () => new Response(null),
    });
    expect(await older.watch(a.it, LANE, true)).toMatchObject({ ok: false, ci: 'older' });
    const offline = new CiLaneWatch({
      settings: async () => settings,
      target: () => ({ watchable: true, worker: 1 }),
      open: async () => {
        throw new TypeError('Failed to fetch');
      },
      change: async () => new Response(null),
    });
    expect(await offline.watch(a.it, LANE, true)).toMatchObject({ ok: false, ci: 'offline' });
    expect(offline.watching()).toBeNull();
    expect(a.ended).toEqual([]);
  });

  it('paces the images to each window, the latest waiting', async () => {
    vi.useFakeTimers();
    const { watch, opened } = watcher();
    const a = viewer();
    await watch.watch(a.it, LANE, true);
    const s = opened[0]!.stream;
    for (const test of ['one', 'two', 'three']) {
      s.send({ type: 'frame', shard: null, worker: 3, slot: 1, image: JPEG, call: null, test });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(a.frames.map((f) => ('test' in f ? f.test : null))).toEqual(['one']);
    await vi.advanceTimersByTimeAsync(100);
    expect(a.frames.map((f) => ('test' in f ? f.test : null))).toEqual(['one', 'three']);
  });
});

describe('a watch asked while another ask is on its way', () => {
  it('answers a window that joins a watch still opening as the instance answers it', async () => {
    let release!: (response: Response) => void;
    const watch = new CiLaneWatch({
      settings: async () => settings,
      target: () => ({ watchable: true, worker: 3 }),
      open: () => new Promise<Response>((resolve) => (release = resolve)),
      change: async () => new Response(null, { status: 204 }),
    });
    const a = viewer();
    const b = viewer();
    const asked = watch.watch(a.it, LANE, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const joined = watch.watch(b.it, LANE, true);
    release(Response.json({ message: 'No' }, { status: 403 }));
    const refusal = { ok: false, message: 'No.', ci: 'refused' };
    expect(await asked).toEqual(refusal);
    expect(await joined).toEqual(refusal);
    expect(watch.watching()).toBeNull();
  });

  it('lets a window’s stop win over its watch still reading the settings', async () => {
    let opens = 0;
    const watch = new CiLaneWatch({
      settings: () => new Promise((resolve) => setTimeout(() => resolve(settings), 5)),
      target: () => ({ watchable: true, worker: 3 }),
      open: async () => {
        opens++;
        return liveStream().response;
      },
      change: async () => new Response(null, { status: 204 }),
    });
    const a = viewer();
    const on = watch.watch(a.it, LANE, true);
    expect(await watch.watch(a.it, LANE, false)).toEqual({ ok: true, message: '' });
    await on;
    expect(opens).toBe(0);
    expect(watch.watching()).toBeNull();
  });

  it('refuses a lane of a run listed but not followed now without saying the run ended', async () => {
    const { watch, setTarget } = watcher();
    const a = viewer();
    setTarget({ followed: false, watchable: false, worker: null });
    expect(await watch.watch(a.it, LANE, true)).toMatchObject({ ok: false, ci: 'unfollowed' });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vue from 'vue';
import { buildReel, focusReel, type Reel, type ReelExecution } from '#shared/video-reel';

/** `useReelPlayer` on fake `<video>` elements: what its moves do when a load, a click or a pause cuts across them. */

const mounted: Array<() => void> = [];
vi.stubGlobal('ref', vue.ref);
vi.stubGlobal('reactive', vue.reactive);
vi.stubGlobal('computed', vue.computed);
vi.stubGlobal('watch', vue.watch);
vi.stubGlobal('nextTick', vue.nextTick);
vi.stubGlobal('onMounted', (fn: () => void) => mounted.push(fn));
vi.stubGlobal('onBeforeUnmount', () => {});
vi.stubGlobal('useRuntimeConfig', () => ({ app: { baseURL: '/' } }));
vi.mock('~/utils', () => ({ fileApiUrl: (path: string) => `/files/${path}` }));

const { useReelPlayer } = await import('../../app/composables/useReelPlayer');

type PlayMode = 'resolve' | 'pending' | 'reject';

class FakeVideo extends EventTarget {
  srcValue: string | null = null;
  preload = '';
  readyState = 0;
  currentTime = 0;
  seeking = false;
  paused = true;
  ended = false;
  duration = 5;
  playMode: PlayMode = 'resolve';
  /** Starts of a load: a `src` set, or a `load()` call. */
  loads = 0;
  plays = 0;
  private pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  set src(value: string) {
    this.srcValue = value;
    this.readyState = 0;
    this.loads++;
  }
  hasAttribute(name: string) {
    return name === 'src' && this.srcValue != null;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.srcValue = null;
  }
  load() {
    this.loads++;
    this.readyState = 0;
  }
  pause() {
    this.paused = true;
  }
  play(): Promise<void> {
    this.plays++;
    if (this.playMode === 'resolve') {
      this.paused = false;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.pending.push({
        resolve: () => {
          this.paused = false;
          resolve();
        },
        reject,
      });
    });
  }
  settlePlay(how: 'resolve' | 'reject') {
    for (const p of this.pending.splice(0)) {
      if (how === 'resolve') p.resolve();
      else p.reject(new Error('NotAllowedError'));
    }
  }
}

const T0 = 1_700_000_000_000;

/** Tests of one worker, each 1 s long, with a video starting where the test does. */
function execution(id: number): ReelExecution {
  return {
    executionId: id,
    testCaseId: id,
    title: `test ${id}`,
    filePath: 'tests/a.spec.ts',
    line: id,
    column: 1,
    status: 'passed',
    retries: 0,
    repeatEachIndex: 0,
    browserName: 'chromium',
    passedAfterFailure: false,
    shardIndex: null,
    parallelIndex: 0,
    workerIndex: 0,
    startedAt: T0 + id * 2000,
    durationMs: 1000,
    createPageEndMs: T0 + id * 2000 + 55,
    video: { id, path: `p/${id}.webm`, contentType: 'video/webm', size: 10 },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(count = 3, tweak: (e: ReelExecution) => ReelExecution = (e) => e) {
  const [reel] = buildReel(
    Array.from({ length: count }, (_, i) => tweak(execution(i + 1))),
    'worker',
  );
  return setupReel(reel!);
}

function setupReel(reel: Reel, startAt?: number) {
  mounted.length = 0;
  const player = useReelPlayer(vue.ref(reel), startAt == null ? undefined : vue.ref(startAt));
  const els = [new FakeVideo(), new FakeVideo()];
  els.forEach((el, slot) => {
    player.bind(slot as 0 | 1, el as unknown as HTMLVideoElement);
    const handlers = player.events(slot as 0 | 1) as Record<string, () => void>;
    for (const [name, handler] of Object.entries(handlers)) el.addEventListener(name.slice(2).toLowerCase(), handler);
  });
  for (const fn of mounted) fn();
  els.forEach((el) => (el.readyState = 4));
  return { player, els: els as [FakeVideo, FakeVideo] };
}

/** Plays the first test, then moves the playing video past its test's end, so the player starts moving on. */
async function playToTheEnd(el: FakeVideo) {
  el.currentTime = 1.2;
  el.dispatchEvent(new Event('timeupdate'));
  await flush();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useReelPlayer', () => {
  it('loads each video once on mount: the first on show, the next in the other element', () => {
    const { els } = setup();
    expect(els[0].loads).toBe(1);
    expect(els[1].loads).toBe(1);
    expect(els[0].srcValue).toBe('/files/p/1.webm');
    expect(els[1].srcValue).toBe('/files/p/2.webm');
  });

  describe('a move that a newer one replaced', () => {
    it('leaves a video that is loading and was replaced unmarked when the new one fails to load', async () => {
      const { player, els } = setup();
      els[1].readyState = 0;
      void player.seekTo(1, 0);
      await flush();
      void player.seekTo(2, 0);
      await flush();
      // The element now holds the third test's video, and that one is the one that fails.
      els[1].dispatchEvent(new Event('error'));
      await flush();
      expect([...player.failed]).toEqual([2]);
    });

    it('does not mark a video failed when its play() is interrupted by a newer move', async () => {
      const { player, els } = setup();
      void player.seekTo(0, 0);
      await flush();
      els[1].playMode = 'pending';
      await playToTheEnd(els[0]);
      expect(els[1].plays).toBe(1);
      void player.seekTo(2, 0);
      await flush();
      els[1].settlePlay('reject');
      await flush();
      expect(player.failed.size).toBe(0);
    });
  });

  it('does not count a refused play() as a failed video, and holds on the finished test', async () => {
    const { player, els } = setup();
    void player.seekTo(0, 0);
    await flush();
    els[1].playMode = 'pending';
    await playToTheEnd(els[0]);
    els[1].settlePlay('reject');
    await flush();
    expect(player.failed.size).toBe(0);
    expect(player.front.value).toBe(0);
    expect(player.current.value).toBe(0);
    expect(player.playing.value).toBe(false);
  });

  it('marks a video failed on its own error event, and moves on to the next', async () => {
    const { player, els } = setup();
    void player.seekTo(0, 0);
    await flush();
    els[1].dispatchEvent(new Event('error'));
    await flush();
    expect([...player.failed]).toEqual([1]);
  });

  it('keeps a pause that comes while the next video is still loading', async () => {
    const { player, els } = setup();
    void player.seekTo(0, 0);
    await flush();
    els[1].readyState = 0;
    await playToTheEnd(els[0]);
    expect(els[1].plays).toBe(0);

    player.togglePlay();
    els[1].dispatchEvent(new Event('loadeddata'));
    await flush();

    expect(els[1].plays).toBe(0);
    expect(player.front.value).toBe(0);
    expect(player.current.value).toBe(0);
    expect(player.playing.value).toBe(false);
  });

  it('does not leave a refused play() on resume unhandled', async () => {
    const { player, els } = setup();
    void player.seekTo(0, 0);
    await flush();
    player.togglePlay();
    expect(player.playing.value).toBe(false);
    els[0].playMode = 'reject';
    els[0].plays = 0;
    player.togglePlay();
    await flush();
    expect(els[0].plays).toBe(1);
    expect(player.playing.value).toBe(false);
  });

  it('does not wait for canplay: a next video that stays at readyState 1 starts after a pause of 4 s', async () => {
    const { player, els } = setup();
    void player.seekTo(0, 0);
    await flush();
    els[1].readyState = 1;
    await playToTheEnd(els[0]);
    expect(els[1].plays).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(els[1].plays).toBe(1);
    expect(player.front.value).toBe(1);
    expect(player.current.value).toBe(1);
  });

  it('starts the next video as soon as its first frame is there', async () => {
    const { player, els } = setup();
    void player.seekTo(0, 0);
    await flush();
    els[1].readyState = 0;
    await playToTheEnd(els[0]);
    expect(els[1].plays).toBe(0);
    els[1].readyState = 2;
    els[1].dispatchEvent(new Event('loadeddata'));
    await flush();
    expect(player.current.value).toBe(1);
    expect(player.playing.value).toBe(true);
  });

  describe('the play button across a swap', () => {
    /** The front video reaches its end: the element pauses itself, then fires `ended`. */
    const ends = (el: FakeVideo) => {
      el.currentTime = el.duration;
      el.ended = true;
      el.paused = true;
      el.dispatchEvent(new Event('pause'));
      el.dispatchEvent(new Event('ended'));
    };

    it('stays playing through the pause an ending video fires, and after the swap', async () => {
      const { player, els } = setup();
      void player.seekTo(0, 0);
      await flush();
      expect(player.playing.value).toBe(true);

      els[1].readyState = 0;
      ends(els[0]);
      await flush();
      // The next video is still loading: the reel is on its way, not paused.
      expect(player.playing.value).toBe(true);
      expect(player.front.value).toBe(0);

      els[1].readyState = 2;
      els[1].dispatchEvent(new Event('loadeddata'));
      await flush();
      expect(player.front.value).toBe(1);
      expect(player.current.value).toBe(1);
      expect(player.playing.value).toBe(true);
    });

    it('stays paused when Pause is pressed during a pending advance, and the advance never lands', async () => {
      const { player, els } = setup();
      void player.seekTo(0, 0);
      await flush();
      els[1].readyState = 0;
      ends(els[0]);
      await flush();
      expect(player.playing.value).toBe(true);

      player.togglePlay();
      expect(player.playing.value).toBe(false);
      els[1].readyState = 2;
      els[1].dispatchEvent(new Event('loadeddata'));
      await flush();
      // The ended video's own late events do not start a new advance either.
      els[0].dispatchEvent(new Event('timeupdate'));
      els[0].dispatchEvent(new Event('ended'));
      await flush();

      expect(els[1].plays).toBe(0);
      expect(player.front.value).toBe(0);
      expect(player.current.value).toBe(0);
      expect(player.playing.value).toBe(false);
    });

    it('goes on to the next video when Play is pressed after that, and never replays the one that ended', async () => {
      const { player, els } = setup();
      void player.seekTo(0, 0);
      await flush();
      els[1].readyState = 0;
      ends(els[0]);
      await flush();
      player.togglePlay();
      expect(player.playing.value).toBe(false);
      const playsOfFirst = els[0].plays;

      els[1].readyState = 4;
      player.togglePlay();
      await flush();

      expect(els[0].plays).toBe(playsOfFirst);
      expect(els[0].currentTime).toBe(els[0].duration);
      expect(els[1].plays).toBe(1);
      expect(player.front.value).toBe(1);
      expect(player.current.value).toBe(1);
      expect(player.playing.value).toBe(true);
    });

    it('moves on, rather than replaying, when Play is pressed on a test whose end has passed', async () => {
      const { player, els } = setup();
      void player.seekTo(0, 0);
      await flush();
      els[1].playMode = 'pending';
      await playToTheEnd(els[0]);
      els[1].settlePlay('reject');
      await flush();
      // Autoplay refused the next video: the reel holds on the finished test, paused.
      expect(player.playing.value).toBe(false);
      const playsOfFirst = els[0].plays;

      els[1].playMode = 'resolve';
      player.togglePlay();
      await flush();

      expect(els[0].plays).toBe(playsOfFirst);
      expect(player.current.value).toBe(1);
      expect(player.playing.value).toBe(true);
    });
  });

  describe('a test with no start time', () => {
    it('plays its whole video: it is not over before the video says how long it is', async () => {
      const { player, els } = setup(2, (e) => ({ ...e, startedAt: null, createPageEndMs: null }));
      void player.seekTo(0, 0);
      await flush();
      els[0].currentTime = 0.1;
      els[0].dispatchEvent(new Event('timeupdate'));
      await flush();
      expect(player.current.value).toBe(0);
      expect(els[1].plays).toBe(0);

      els[0].dispatchEvent(new Event('loadedmetadata'));
      els[0].currentTime = 5;
      els[0].dispatchEvent(new Event('timeupdate'));
      await flush();
      expect(player.current.value).toBe(1);
    });
  });

  describe('a reel that starts at one of its tests', () => {
    const fileOf = (count: number) =>
      Array.from({ length: count }, (_, i) => execution(i + 1)).map((e) => ({
        ...e,
        parallelIndex: e.executionId % 2,
      }));

    it('loads the test it starts at, and the one after it, and plays that test first', async () => {
      const all = fileOf(4);
      const { reel } = focusReel(all, all[1]!, 'file')!;
      const { player, els } = setupReel(reel, 1);
      expect(player.current.value).toBe(1);
      expect(els[0].srcValue).toBe('/files/p/2.webm');
      expect(els[1].srcValue).toBe('/files/p/3.webm');
      player.togglePlay();
      await flush();
      expect(player.current.value).toBe(1);
      expect(els[0].plays).toBe(1);
      expect(player.ticked.value).toEqual([true, false, false, false]);
    });

    it('starts at the first video when the wanted test has none', () => {
      const all = fileOf(3);
      all[1] = { ...all[1]!, video: null };
      const { reel } = focusReel(all, all[0]!, 'file')!;
      const { player } = setupReel(reel, 1);
      expect(player.current.value).toBe(0);
    });
  });

  describe('a single test of its file', () => {
    // The span of one test in its video: the reel has the file's other tests beside it, none of them played.
    const file = () => Array.from({ length: 3 }, (_, i) => execution(i + 1));

    it('holds one video, and no other test of the file is loaded', () => {
      const all = file();
      const { reel, focusIndex } = focusReel(all, all[1]!, 'test')!;
      const { player, els } = setupReel(reel, focusIndex);
      expect(player.current.value).toBe(1);
      expect(els[0].srcValue).toBe('/files/p/2.webm');
      expect(els[1].srcValue).toBeNull();
    });

    it('stops at the end of the test and plays no other test', async () => {
      const all = file();
      const { reel, focusIndex } = focusReel(all, all[1]!, 'test')!;
      const { player, els } = setupReel(reel, focusIndex);
      player.togglePlay();
      await flush();
      expect(player.playing.value).toBe(true);
      els[0].currentTime = 0.5;
      els[0].dispatchEvent(new Event('timeupdate'));
      await flush();
      expect(player.playing.value).toBe(true);
      expect(player.ticked.value).toEqual([false, false, false]);

      // The test is 1 s long in a video that runs on in its frozen tail: the player stops at the test's end.
      els[0].currentTime = 1.1;
      els[0].dispatchEvent(new Event('timeupdate'));
      await flush();

      expect(els[0].paused).toBe(true);
      expect(player.playing.value).toBe(false);
      expect(player.finished.value).toBe(true);
      expect(player.current.value).toBe(1);
      expect(els[1].plays).toBe(0);
      expect(player.ticked.value).toEqual([false, true, false]);
    });

    it('plays the test again from its start when Play is pressed after it ended', async () => {
      const all = file();
      const { reel, focusIndex } = focusReel(all, all[1]!, 'test')!;
      const { player, els } = setupReel(reel, focusIndex);
      player.togglePlay();
      await flush();
      els[0].currentTime = 1.1;
      els[0].dispatchEvent(new Event('timeupdate'));
      await flush();
      expect(player.finished.value).toBe(true);

      player.togglePlay();
      await flush();

      expect(player.finished.value).toBe(false);
      expect(player.playing.value).toBe(true);
      expect(player.current.value).toBe(1);
      expect(els[0].currentTime).toBe(0);
    });

    it('stops at the end of an earlier attempt that is not on the run list', async () => {
      const all = file();
      const earlier = {
        ...all[1]!,
        executionId: 20,
        retries: 0,
        status: 'failed',
        video: { id: 20, path: 'p/20.webm', contentType: 'video/webm', size: 10 },
      };
      const final = { ...all[1]!, retries: 1 };
      const { reel, focusIndex } = focusReel([all[0]!, final, all[2]!], earlier, 'test')!;
      const { player, els } = setupReel(reel, focusIndex);
      expect(els[0].srcValue).toBe('/files/p/20.webm');
      player.togglePlay();
      await flush();
      els[0].currentTime = 1.1;
      els[0].dispatchEvent(new Event('timeupdate'));
      await flush();
      expect(player.finished.value).toBe(true);
      expect(els[0].paused).toBe(true);
    });
  });
});

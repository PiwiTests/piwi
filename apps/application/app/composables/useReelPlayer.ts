/**
 * Plays a video reel (`buildReel`) on two `<video>` elements: one shows the playing test's video, the other holds the
 * next one, loaded and waiting. Playback moves to the next test while the playing one is in its frozen tail, after the
 * test's end and before the file's, by showing the other element. The visible element's `src` never changes during
 * playback. Only the playing and the next video have a `src`.
 *
 * Where playback stands comes from `requestVideoFrameCallback`, which reports every frame as it is shown, with
 * `timeupdate` where a browser has none.
 */
import { tickedEntries, type Reel } from '#shared/video-reel';
import { fileApiUrl } from '~/utils';

type Slot = 0 | 1;

export function useReelPlayer(reel: Ref<Reel | null>) {
  const baseURL = useRuntimeConfig().app.baseURL;
  const els: Array<HTMLVideoElement | null> = [null, null];
  /** The reel entry each element holds, null when it holds none. */
  const held: Array<number | null> = [null, null];
  let hasFrameCallback = false;
  let moving = false;
  let token = 0;

  /** The element on show. */
  const front = ref<Slot>(0);
  /** The entry the front element plays; null before a reel has a video. */
  const current = ref<number | null>(null);
  /** How far the front element has played, in ms of video. */
  const positionMs = ref(0);
  const playing = ref(false);
  /** Set once the viewer has played or sought, so a reel shows no ticks before. */
  const started = ref(false);
  /** The whole reel is played to its end. */
  const finished = ref(false);
  /** The entries whose video failed to load. */
  const failed = reactive(new Set<number>());
  /** The length of each loaded video, in ms. */
  const videoLengths = reactive(new Map<number, number>());

  const entries = computed(() => reel.value?.entries ?? []);

  /** The entries with a video that has not failed. */
  function playable(): number[] {
    return entries.value.flatMap((e, i) => (e.execution.video && !failed.has(i) ? [i] : []));
  }
  function nextVideo(after: number): number | null {
    return playable().find((i) => i > after) ?? null;
  }
  function srcOf(index: number): string {
    const video = entries.value[index]!.execution.video!;
    return fileApiUrl(video.path, video.contentType, baseURL);
  }

  /** Where entry `index` ends in its video, in ms: the end of its test, held to the length of the video. */
  function lengthOf(index: number): number {
    return Math.min(entries.value[index]?.lengthMs ?? 0, videoLengths.get(index) ?? Infinity);
  }
  const endMs = computed(() => (current.value == null ? 0 : lengthOf(current.value)));
  const endPassed = computed(() => started.value && positionMs.value >= endMs.value);

  /** Ticks change only as a test's end passes, so the checklist does not render on every frame. */
  const ticked = computed(() => {
    if (!reel.value || current.value == null || !started.value) return entries.value.map(() => false);
    return tickedEntries(reel.value, {
      index: current.value,
      videoMs: endPassed.value ? endMs.value : -1,
      endMs: endMs.value,
    });
  });
  /** How far through the playing test's video, 0 to 1. */
  const progress = computed(() => (endMs.value > 0 ? Math.min(1, positionMs.value / endMs.value) : 0));
  /** No video of the reel can be played. */
  const unplayable = computed(() => {
    const total = entries.value.filter((e) => e.execution.video).length;
    return total > 0 && failed.size >= total;
  });

  function setHeld(slot: Slot, entry: number | null) {
    const el = els[slot];
    if (!el || held[slot] === entry) return;
    held[slot] = entry;
    if (entry == null) {
      el.removeAttribute('src');
    } else {
      el.src = srcOf(entry);
      el.preload = 'auto';
    }
    el.load();
  }

  function once(el: HTMLVideoElement, event: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        el.removeEventListener(event, done);
        el.removeEventListener('error', fail);
        resolve();
      };
      const fail = () => {
        el.removeEventListener(event, done);
        el.removeEventListener('error', fail);
        reject(new Error('video failed to load'));
      };
      el.addEventListener(event, done);
      el.addEventListener('error', fail);
    });
  }

  /** Loads the video after `index` in the element that is not on show. */
  function preloadNext(index: number) {
    const hidden = (1 - front.value) as Slot;
    const next = nextVideo(index);
    if (next != null) setHeld(hidden, next);
    else if (held[hidden] != null && held[hidden] !== index) setHeld(hidden, null);
  }

  function markFailed(index: number) {
    if (failed.has(index)) return;
    failed.add(index);
    if (current.value === index && held[front.value] === index) {
      const next = nextVideo(index);
      if (next != null) void seekTo(next, 0);
      else playing.value = false;
    } else if (current.value != null) {
      const hidden = (1 - front.value) as Slot;
      if (held[hidden] === index) {
        held[hidden] = null;
        preloadNext(current.value);
      }
    }
  }

  /** Plays entry `index` from `ms` of its video. */
  async function seekTo(index: number, ms = 0) {
    const entry = entries.value[index];
    if (!entry?.execution.video || failed.has(index)) return;
    const mine = ++token;
    started.value = true;
    finished.value = false;
    moving = true;
    const onShow = held[front.value] === index;
    const slot: Slot = onShow ? front.value : ((1 - front.value) as Slot);
    if (!onShow && held[slot] !== index) setHeld(slot, index);
    const el = els[slot];
    if (!el) return;
    try {
      if (el.readyState < 1) await once(el, 'loadedmetadata');
      if (mine !== token) return;
      el.currentTime = ms / 1000;
      if (el.seeking) await once(el, 'seeked');
      if (mine !== token) return;
    } catch {
      moving = false;
      markFailed(index);
      return;
    }
    if (!onShow) {
      els[front.value]?.pause();
      front.value = slot;
    }
    current.value = index;
    positionMs.value = ms;
    await el.play().catch(() => undefined);
    if (mine !== token) return;
    playing.value = !el.paused;
    moving = false;
    preloadNext(index);
  }

  /** Plays entry `index` from the point `fraction` (0 to 1) of the way through its test. */
  function seekToFraction(index: number, fraction: number) {
    void seekTo(index, Math.min(1, Math.max(0, fraction)) * lengthOf(index));
  }

  /** Moves on to the next test's video, now that the playing test is over. */
  async function advance(index: number) {
    if (moving) return;
    moving = true;
    const next = nextVideo(index);
    if (next == null) {
      els[front.value]?.pause();
      playing.value = false;
      finished.value = true;
      moving = false;
      return;
    }
    const hidden = (1 - front.value) as Slot;
    setHeld(hidden, next);
    const el = els[hidden];
    if (!el) {
      moving = false;
      return;
    }
    const mine = token;
    try {
      if (el.readyState < 3) await once(el, 'canplay');
      if (mine !== token) return;
      el.currentTime = 0;
      await el.play();
    } catch {
      moving = false;
      markFailed(next);
      if (current.value === index) void advance(index);
      return;
    }
    if (mine !== token) return;
    els[front.value]?.pause();
    front.value = hidden;
    current.value = next;
    moving = false;
    preloadNext(next);
    onFrame();
  }

  function onFrame() {
    const el = els[front.value];
    const index = held[front.value];
    if (!el || index == null || index !== current.value) return;
    positionMs.value = el.currentTime * 1000;
    if (!moving && positionMs.value >= lengthOf(index)) void advance(index);
  }

  function togglePlay() {
    const el = els[front.value];
    if (!el || current.value == null) return;
    if (finished.value || (!started.value && el.paused)) {
      const first = finished.value ? playable()[0] : current.value;
      if (first != null) void seekTo(first, 0);
    } else if (el.paused) {
      started.value = true;
      void el.play().then(() => (playing.value = true));
    } else {
      el.pause();
      playing.value = false;
    }
  }

  /** Holds a `<video>` element; its frames drive the player. */
  function bind(slot: Slot, el: HTMLVideoElement | null) {
    if (els[slot] === el) return;
    els[slot] = el;
    if (!el || !('requestVideoFrameCallback' in el)) return;
    hasFrameCallback = true;
    const watchFrames = () => {
      if (els[slot] !== el) return;
      if (front.value === slot) onFrame();
      el.requestVideoFrameCallback(watchFrames);
    };
    el.requestVideoFrameCallback(watchFrames);
  }

  /** The events of the element in `slot`. */
  const events = (slot: Slot) => ({
    onError: () => {
      const index = held[slot];
      if (index != null) markFailed(index);
    },
    onLoadedmetadata: () => {
      const index = held[slot];
      const length = els[slot]?.duration;
      if (index != null && length != null && Number.isFinite(length)) videoLengths.set(index, length * 1000);
    },
    onTimeupdate: () => {
      if (!hasFrameCallback && front.value === slot) onFrame();
    },
    onSeeked: () => {
      if (front.value === slot) onFrame();
    },
    onEnded: () => {
      const index = held[slot];
      if (front.value !== slot || index == null || index !== current.value) return;
      // The last frame a callback saw can sit just short of the end; the video is over.
      positionMs.value = Math.max(positionMs.value, (els[slot]?.duration ?? 0) * 1000);
      void advance(index);
    },
    onPause: () => {
      if (front.value === slot && !moving) playing.value = false;
    },
    onPlay: () => {
      if (front.value === slot) playing.value = true;
    },
  });

  /** Starts over on a reel: its first video is loaded, shown and waiting, with nothing ticked. */
  function reset() {
    token++;
    moving = false;
    for (const slot of [0, 1] as const) els[slot]?.pause();
    failed.clear();
    videoLengths.clear();
    started.value = false;
    finished.value = false;
    playing.value = false;
    positionMs.value = 0;
    const first = playable()[0] ?? null;
    current.value = first;
    held[0] = held[1] = null;
    for (const slot of [0, 1] as const) {
      els[slot]?.removeAttribute('src');
      els[slot]?.load();
    }
    front.value = 0;
    if (first != null) {
      setHeld(0, first);
      preloadNext(first);
    }
  }

  watch(reel, () => nextTick(reset), { immediate: true });
  onMounted(reset);
  onBeforeUnmount(() => {
    token++;
    for (const slot of [0, 1] as const) {
      els[slot]?.pause();
      els[slot]?.removeAttribute('src');
      els[slot]?.load();
      held[slot] = null;
    }
  });

  return {
    front,
    current,
    playing,
    started,
    finished,
    ticked,
    progress,
    endMs,
    unplayable,
    failed,
    lengthOf,
    seekTo,
    seekToFraction,
    togglePlay,
    bind,
    events,
  };
}

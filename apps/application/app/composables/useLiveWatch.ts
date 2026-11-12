import { liveWorkerKey, type LiveCall, type LiveViewerMessage, type LiveWorkerId } from '@piwitests/core/live-view';
import { LiveWatch, sameWorker, type LiveWatchState } from '~/utils/live-watch';

/** A worker's latest image on the run page, as its tile shows it, or why none shows. */
export interface LiveTile {
  id: LiveWorkerId;
  /** The image's object URL, which this page holds until the next image of the worker replaces it. */
  url: string | null;
  /** The image's bytes, for a full view of the worker that opens on it. */
  image: Uint8Array | null;
  call: LiveCall | null;
  test: string | null;
  /** Why no image shows now. */
  refused: string | null;
}

/** What the full view hears of the watch: a message of its worker, its refusal, or how the watch stands. */
export type LiveFocusEvent =
  | { kind: 'message'; message: LiveViewerMessage }
  | { kind: 'refused'; status: number | null }
  | { kind: 'state'; state: LiveWatchState };

/**
 * The run page's one watch of its live run (`LiveWatch`): every running worker's tile while **Watch all** is on, and
 * the full view of the worker the lane panel shows (`show`), at the size it shows it (`resize`), on one connection.
 * The tiles keep each worker's latest image alone, in this page's memory, until the worker leaves (`keep`) or the watch
 * closes.
 */
export function useLiveWatch(runId: () => number) {
  const baseURL = useRuntimeConfig().app.baseURL;
  const tiles = ref(false);
  const focus = shallowRef<LiveWorkerId | null>(null);
  const size = shallowRef<{ width: number; height: number } | null>(null);
  const state = shallowRef<LiveWatchState>({ kind: 'idle' });
  const images = shallowRef<Record<string, LiveTile>>({});
  /** The full view's listener, and the token it holds the focus by. */
  let listener: { token: number; hear: (event: LiveFocusEvent) => void } | null = null;
  let tokens = 0;

  const forFocus = (id: LiveWorkerId | undefined): boolean =>
    !!listener && !!focus.value && (id === undefined || sameWorker(focus.value, id));

  /** Keep `message` as its worker's tile: its image, or why none shows. */
  function keepTile(message: Extract<LiveViewerMessage, { type: 'frame' } | { type: 'refused' }>): void {
    const key = liveWorkerKey(message);
    const before = images.value[key];
    if (before?.url && message.type === 'frame') URL.revokeObjectURL(before.url);
    const id = {
      shard: message.shard,
      worker: message.worker,
      ...(message.slot === undefined ? {} : { slot: message.slot }),
    };
    const tile: LiveTile =
      message.type === 'frame'
        ? {
            id,
            url: URL.createObjectURL(new Blob([message.image as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })),
            image: markRaw(message.image),
            call: message.call,
            test: message.test,
            refused: null,
          }
        : {
            id,
            url: before?.url ?? null,
            image: before?.image ?? null,
            call: null,
            test: null,
            refused: message.message,
          };
    images.value = { ...images.value, [key]: tile };
  }

  const live = import.meta.client
    ? new LiveWatch(`${baseURL.replace(/\/$/, '')}/api/test-runs/${runId()}/live-view/watch`, {
        message(message) {
          if (message.type === 'frame' || message.type === 'refused') keepTile(message);
          const worker: LiveWorkerId | undefined =
            message.type === 'hello' || message.worker === undefined
              ? undefined
              : {
                  shard: message.shard ?? null,
                  worker: message.worker,
                  ...(message.slot === undefined ? {} : { slot: message.slot }),
                };
          if (message.type !== 'hello' && forFocus(worker)) listener!.hear({ kind: 'message', message });
          // Its full view ended, or the whole watch: the full view shows no more, and tiles show again as asked.
          if (message.type === 'end' && (worker === undefined || (focus.value && sameWorker(focus.value, worker)))) {
            focus.value = null;
          }
        },
        state(next) {
          state.value = next;
          listener?.hear({ kind: 'state', state: next });
        },
        focusRefused(refused, status) {
          if (!focus.value || !sameWorker(focus.value, refused)) return;
          focus.value = null;
          listener?.hear({ kind: 'refused', status });
        },
      })
    : null;

  const asked = () => ({ focus: focus.value, tiles: tiles.value, size: size.value });
  watch([focus, size, tiles], () => live?.want(asked()));

  /** Open the watch again, after it closed saying why, as the page asks: what it wants shown now. */
  function resume(): void {
    live?.want(asked());
    live?.resume();
  }

  /** Show every worker's tile, or stop: a watch that closed opens again as they are asked for. */
  function watchAll(on: boolean): void {
    tiles.value = on;
    if (on) resume();
  }

  /** Forget the tiles of the workers that left the run's live view (`keys`, the ones still in it). */
  function keep(keys: Iterable<string>): void {
    const still = new Set(keys);
    const kept: Record<string, LiveTile> = {};
    for (const [key, tile] of Object.entries(images.value)) {
      if (still.has(key)) kept[key] = tile;
      else if (tile.url) URL.revokeObjectURL(tile.url);
    }
    if (Object.keys(kept).length !== Object.keys(images.value).length) images.value = kept;
  }

  /**
   * Show `worker` in full, its messages to `hear`, until the function returned is called; one full view at a time, a
   * later one taking its place.
   */
  function show(worker: LiveWorkerId, hear: (event: LiveFocusEvent) => void): () => void {
    const token = ++tokens;
    listener = { token, hear };
    focus.value = { ...worker };
    resume();
    return () => {
      if (listener?.token !== token) return;
      listener = null;
      focus.value = null;
    };
  }

  /** The full view shows its image at `next`, in device pixels. */
  function resize(next: { width: number; height: number }): void {
    if (size.value?.width !== next.width || size.value?.height !== next.height) size.value = next;
  }

  /** The latest image of a worker, by `liveWorkerKey`, for a full view that opens on it. */
  function latest(id: LiveWorkerId): LiveTile | null {
    return images.value[liveWorkerKey(id)] ?? null;
  }

  onBeforeUnmount(() => {
    live?.close();
    keep([]);
  });

  return { tiles, focus, state, images, show, resize, keep, latest, resume, watchAll };
}

export type LiveWatchHandle = ReturnType<typeof useLiveWatch>;

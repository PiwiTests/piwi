/**
 * The trace's screencast on the failure timeline: its frames placed on the
 * timeline's clock, the frame the page showed at a moment, and the frame each
 * tile of the Screen lane shows. Pure, so the timeline card and the unit tests
 * share one set of rules.
 */
import type { TraceFramesResponse } from '~~/types/api';

/** One frame on the timeline's clock. */
export interface PlacedFrame {
  /** When the page painted it, in ms after the timeline's `origin`. */
  at: number;
  /** Its name in the trace, which the frame route serves. */
  name: string;
  width: number;
  height: number;
}

export interface PlacedFramePage {
  pageId: string;
  frames: PlacedFrame[];
}

/**
 * A trace whose test started further than this from the execution's own start
 * was recorded at another time than the execution (a fixture, a trace attached
 * again), so its frames are placed by that start instead of the wall clock.
 */
export const RECORDED_APART_MS = 60_000;

/** How many pages get a lane of their own; a test that opens more shows its first ones. */
export const MAX_SCREEN_LANES = 3;

/**
 * Each page's frames on the timeline's clock (`origin` in epoch ms, `testStart`
 * in ms after it). Frames stay where the wall clock puts them, unless the trace
 * was recorded apart from the execution: then the trace's test start lands on
 * the execution's.
 */
export function placeTraceFrames(
  response: TraceFramesResponse | null | undefined,
  clock: { origin: number; testStart: number },
): PlacedFramePage[] {
  if (response?.status !== 'ok') return [];
  const start = response.startEpochMs;
  const apart = start != null && Math.abs(start - clock.origin - clock.testStart) > RECORDED_APART_MS;
  const offset = apart ? clock.testStart - start : -clock.origin;
  return response.pages
    .filter((page) => page.frames.length > 0)
    .map((page) => ({
      pageId: page.pageId,
      frames: page.frames.map((f) => ({ at: f.epochMs + offset, name: f.name, width: f.width, height: f.height })),
    }));
}

/** The frame the page showed at `at`: the last one painted by then, or -1 before the first. Frames in time order. */
export function frameIndexAt(frames: readonly PlacedFrame[], at: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.at <= at) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The frame each of `count` tiles across the window shows: the one on screen at the tile's middle, or -1. */
export function frameTiles(
  frames: readonly PlacedFrame[],
  window: { start: number; end: number },
  count: number,
): number[] {
  const span = Math.max(0, window.end - window.start);
  return Array.from({ length: Math.max(0, count) }, (_, i) =>
    frameIndexAt(frames, window.start + ((i + 0.5) / count) * span),
  );
}

/** The pages' width over height, from their first frame that records a size; 4:3 without one, held to 1:2 … 3:1. */
export function frameAspect(pages: readonly PlacedFramePage[]): number {
  const sized = pages.flatMap((p) => p.frames).find((f) => f.width > 0 && f.height > 0);
  const ratio = sized ? sized.width / sized.height : 4 / 3;
  return Math.min(3, Math.max(0.5, ratio));
}

/**
 * The trace's screencast on the failure timeline: its frames placed on the
 * timeline's clock, the frame the page showed at a moment, and the frame each
 * tile of the Screen lane shows. Pure, so the timeline card and the unit tests
 * share one set of rules.
 */
import type { TraceFramesResponse } from '~~/types/api';

/** One frame on the timeline's clock. */
export interface PlacedFrame {
  /** When the trace recorded it, in ms after the timeline's `origin`. */
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

/** What the page panel shows the page for: a step (before or after it), an event of the list, or a moment. */
export type PageSubject =
  | { kind: 'step'; key: string; label: string; at: number; end: number; failed: boolean; phase: 'before' | 'after' }
  | { kind: 'event'; key: string; label: string; at: number; event: 'network' | 'console' | 'dialogs' | 'backend' }
  | { kind: 'moment'; at: number; label: string | null };

/** The moment a subject shows: a step's start before it, its end after it (the failing step's ends at the failure). */
export function subjectMoment(subject: PageSubject, failureAt: number): number {
  if (subject.kind !== 'step') return subject.at;
  if (subject.phase === 'before') return subject.at;
  return subject.failed ? Math.max(subject.at, Math.min(subject.end, failureAt)) : subject.end;
}

/**
 * The page in front at a moment: of the pages with a frame by then, the one
 * that painted last. Null before any page painted.
 */
export function pageInFront(pages: readonly PlacedFramePage[], at: number): { page: number; frame: number } | null {
  let best: { page: number; frame: number } | null = null;
  pages.forEach((p, page) => {
    const frame = frameIndexAt(p.frames, at);
    if (frame < 0) return;
    if (!best || p.frames[frame]!.at > pages[best.page]!.frames[best.frame]!.at) best = { page, frame };
  });
  return best;
}

/** How the list shows the page: a panel beside it, a card on hover, or a column of thumbnails. */
export const PAGE_VIEWS = ['panel', 'hover', 'thumbs'] as const;
export type PageView = (typeof PAGE_VIEWS)[number];

/** A stored page view, the side panel for anything else. */
export function parsePageView(raw: unknown): PageView {
  return PAGE_VIEWS.find((view) => view === raw) ?? 'panel';
}

/** The shortest step a "no new frame" line speaks for: a faster one ends before its own effect is painted. */
export const UNCHANGED_STEP_MIN_MS = 1_000;

/**
 * A step's page before it ran and after it, and whether the page in front
 * painted no new frame in between: said only of a step of at least
 * {@link UNCHANGED_STEP_MIN_MS}, and never of a `sampled` frame list, which
 * leaves frames out.
 */
export function stepFrames(
  pages: readonly PlacedFramePage[],
  step: Extract<PageSubject, { kind: 'step' }>,
  failureAt: number,
  sampled = false,
): {
  before: { page: number; frame: number } | null;
  after: { page: number; frame: number } | null;
  unchanged: boolean;
} {
  const before = pageInFront(pages, subjectMoment({ ...step, phase: 'before' }, failureAt));
  const afterAt = subjectMoment({ ...step, phase: 'after' }, failureAt);
  const after = pageInFront(pages, afterAt);
  const unchanged =
    !sampled &&
    afterAt - step.at >= UNCHANGED_STEP_MIN_MS &&
    before != null &&
    after != null &&
    before.page === after.page &&
    before.frame === after.frame;
  return { before, after, unchanged };
}

/** A frame's width over height held to 3:4 … 3:1, so a phone-sized page never towers over its panel. */
export function clampFrameAspect(ratio: number): number {
  return Math.min(3, Math.max(0.75, ratio));
}

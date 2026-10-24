import type { PauseRecord } from '../capture/pause-at.js';

/**
 * The time a test spent stopped at Piwi's pause bar, out of its steps. A stop
 * holds a Playwright call before it runs, so the call's step and every step
 * around it last as long as the person looked at the page, and every step
 * after it starts that much later; the test runner already leaves that time
 * out of the test's duration. Taking it out of the steps too keeps the
 * durations, the slowest step and the timeline's hook sections to the test's
 * own time.
 */

/** A Playwright step as the reporter reads it. */
interface StepLike {
  startTime?: Date | number;
  duration: number;
  steps?: StepLike[];
}

/** The stops a test's `piwi-pauses` attachment lists; none for a missing or unreadable one. */
export function readPauses(body: Buffer | undefined): PauseRecord[] {
  if (!body) return [];
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(value)) return [];
    return value.filter(
      (p): p is PauseRecord =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as PauseRecord).location === 'string' &&
        typeof (p as PauseRecord).startedAt === 'number' &&
        typeof (p as PauseRecord).duration === 'number',
    );
  } catch {
    return [];
  }
}

function startOf(step: StepLike): number | null {
  if (step.startTime instanceof Date) return step.startTime.getTime();
  return typeof step.startTime === 'number' ? step.startTime : null;
}

/** The spans the test stood stopped, `[start, end]` in epoch ms, in order, overlapping stops joined. */
function stoppedSpans(pauses: readonly PauseRecord[]): Array<[number, number]> {
  const spans: Array<[number, number]> = pauses
    .filter((p) => p.duration > 0)
    .map((p) => [p.startedAt, p.startedAt + p.duration] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const joined: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = joined[joined.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else joined.push([start, end]);
  }
  return joined;
}

/** How long the test stood stopped before `at`, in ms. */
function stoppedBefore(spans: ReadonlyArray<[number, number]>, at: number): number {
  let ms = 0;
  for (const [start, end] of spans) ms += Math.max(0, Math.min(at, end) - start);
  return ms;
}

/**
 * `steps` on the test's own clock: each step loses the time the test stood stopped while it ran, and starts earlier
 * by the time it stood stopped before it began, so a step that ran across a stop (the held call's, the steps around
 * it, a wait started before it) lasts its own time and the steps after a stop fit the test's duration. The steps no
 * stop moved are returned as they are, and `steps` itself is never changed.
 */
export function withoutPausedTime<T extends StepLike>(steps: T[], pauses: readonly PauseRecord[]): T[] {
  const spans = stoppedSpans(pauses);
  if (spans.length === 0) return steps;
  const move = <S extends StepLike>(step: S): S => {
    const children = step.steps?.length ? copy(step.steps) : step.steps;
    const start = startOf(step);
    const before = start === null ? 0 : stoppedBefore(spans, start);
    // An unfinished step (duration -1) keeps its duration.
    const during = start === null ? 0 : stoppedBefore(spans, start + Math.max(0, step.duration)) - before;
    if (before === 0 && during === 0 && children === step.steps) return step;
    const moved: S = { ...step, steps: children };
    if (during > 0) moved.duration = Math.max(0, step.duration - during);
    if (start !== null && before > 0) {
      moved.startTime = step.startTime instanceof Date ? new Date(start - before) : start - before;
    }
    return moved;
  };
  const copy = <S extends StepLike>(list: S[]): S[] => {
    const moved = list.map(move);
    return moved.some((step, i) => step !== list[i]) ? moved : list;
  };
  return copy(steps);
}

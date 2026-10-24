import * as path from 'node:path';
import type { PauseRecord } from '../capture/pause-at.js';

/**
 * The time a test spent stopped at Piwi's pause bar, out of its steps. A stop
 * holds a Playwright call before it runs, so the call's step and every step
 * around it last as long as the person looked at the page; the test runner
 * already leaves that time out of the test's duration. Taking it out of the
 * steps too keeps the durations, the slowest step and the timeline's hook
 * sections to the test's own time.
 */

/** A Playwright step as the reporter reads it. */
interface StepLike {
  location?: { file: string; line: number };
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

/**
 * The steps from the outermost to the step of the call `pause` held: the deepest step at the stop's file and line
 * that was running for the whole stop. Empty when none was.
 */
function pausedChain(steps: StepLike[], pause: PauseRecord, file: string, line: number): StepLike[] {
  let found: StepLike[] = [];
  const visit = (list: StepLike[], above: StepLike[]) => {
    for (const step of list) {
      const chain = [...above, step];
      const start = startOf(step);
      if (
        step.location?.file === file &&
        step.location.line === line &&
        start !== null &&
        start <= pause.startedAt &&
        start + step.duration >= pause.startedAt + pause.duration &&
        chain.length > found.length
      ) {
        found = chain;
      }
      if (step.steps?.length) visit(step.steps, chain);
    }
  };
  visit(steps, []);
  return found;
}

/**
 * `steps` with the time each stop held a call taken out of the call's step and every step around it. A stop no step
 * matches is left out; the steps no stop touched are returned as they are, and `steps` itself is never changed.
 * Call sites are relative to `cwd`, the working directory the test worker shares with the reporter.
 */
export function withoutPausedTime<T extends StepLike>(
  steps: T[],
  pauses: readonly PauseRecord[],
  cwd: string = process.cwd(),
): T[] {
  const taken = new Map<StepLike, number>();
  for (const pause of pauses) {
    const m = /^(.+):(\d+):\d+$/.exec(pause.location);
    if (!m) continue;
    for (const step of pausedChain(steps, pause, path.resolve(cwd, m[1]!), Number(m[2]))) {
      taken.set(step, (taken.get(step) ?? 0) + pause.duration);
    }
  }
  if (taken.size === 0) return steps;
  const copy = <S extends StepLike>(list: S[]): S[] =>
    list.map((step) => {
      const ms = taken.get(step);
      if (ms === undefined) return step;
      const children = step.steps?.length ? copy(step.steps) : step.steps;
      return { ...step, duration: Math.max(0, step.duration - ms), steps: children };
    });
  return copy(steps);
}

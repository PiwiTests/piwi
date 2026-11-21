import type { LiveCall, LiveStop } from '@piwitests/core/live-view';
import type { TestStop, TestStopReason } from '@piwitests/core/wire';
import { clockTime, heldForWords } from '@piwitests/run-model/ci';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import { liveWorkerKey, type LiveWorkerState } from '#shared/live-view';
import type { TestCaseResult } from '~~/types/api';
import { currentRows, rowLiveWorker } from './live-row-worker';

/**
 * What a stopped test says of its stop, by its reason, on the run page and in the desktop app's tray: one sentence per
 * reason, `other` for a reason of a newer reporter. A failure held for a look names it so.
 */
export const STOP_WORDS: Record<TestStopReason, string> = {
  breakpoint: 'Stopped at a breakpoint',
  step: 'Stopped after a step',
  pause: 'Paused',
  'run-to': 'Stopped at the line it ran to',
  'page-pause': 'Stopped at page.pause()',
  failure: 'Held at its failure',
  other: 'Stopped',
};

/**
 * The words for a stop's reason as any source names it: a failed CI test held for its controllers (`held`) reads as
 * the run model's held failure, and a reason this page does not know as `other`'s.
 */
export function stopWords(reason: string): string {
  if (reason === 'held') return englishRunSpeaker.say('runs_stateFailed');
  return reason in STOP_WORDS ? STOP_WORDS[reason as TestStopReason] : STOP_WORDS.other;
}

/**
 * For whom a failed CI test is held, and until when (`Held for Ana · until 12:05`), as the instance names the
 * controllers watching it (none when it knows no names), in the run model's words (`heldForWords`); null for a held
 * stop that says no end.
 */
export function heldStopWords(
  stop: { until?: number },
  heldFor: readonly string[],
  clock: (time: number) => string = clockTime,
): string | null {
  return heldForWords(stop.until, heldFor, englishRunSpeaker, clock);
}

/** How long a stop stands before its row and its lane panel say for how long. */
export const STOOD_FOR_MS = 60_000;

/**
 * How long a stop has stood, in whole minutes as ms, once it stood `STOOD_FOR_MS`; null before, and for a stop whose
 * producer cannot tell when it began (`since` null).
 */
export function stopStoodMs(since: number | null | undefined, now: number): number | null {
  if (!since || now - since < STOOD_FOR_MS) return null;
  return Math.floor((now - since) / 60_000) * 60_000;
}

/**
 * A stop as a test's row and its worker's lane panel show it: why, at which call, and since when (null when unknown);
 * for a failed CI test held for its controllers (`held`), when its hold ends, for whom, and whether its worker can be
 * let go (`holds`).
 */
export interface ShownStop {
  reason: string;
  call: LiveCall;
  since: number | null;
  held?: { until?: number; heldFor: string[]; holds: boolean };
}

/**
 * The stop a running test stands at, from the two sources that say it: the live view's (`live`, its worker's `paused`)
 * and the one its reporter told (`told`, the row's `liveStop`). Where both stand, the reason and the call are the live
 * view's and the time is the told stop's; either alone is the stop. A held CI failure carries its hold, with its live
 * worker's (`worker`) controllers and whether it can be let go. Null for neither.
 */
export function testStop(
  live: LiveStop | null | undefined,
  told: TestStop | null | undefined,
  worker?: Pick<LiveWorkerState, 'heldFor' | 'holds'> | null,
): ShownStop | null {
  if (live) {
    const stop: ShownStop = { reason: live.reason, call: live.call, since: told?.since ?? null };
    if (live.reason !== 'held') return stop;
    const until = live.until === undefined ? {} : { until: live.until };
    return { ...stop, held: { ...until, heldFor: worker?.heldFor ?? [], holds: worker?.holds === true } };
  }
  if (told)
    return { reason: told.reason, call: { title: told.title, file: told.file, line: told.line }, since: told.since };
  return null;
}

/**
 * The stop of the test a watched worker runs now (`testStop`), read as that test's row reads it: the worker's live
 * view stop for its running row (`rowLiveWorker`) and the row's told stop; for a worker with no running row, its live
 * view stop alone.
 */
export function watchedStop(
  rows: readonly TestCaseResult[],
  workers: Readonly<Record<string, LiveWorkerState>>,
  watched: { shard: number | null; worker: number },
): ShownStop | null {
  const key = liveWorkerKey(watched);
  const current = currentRows(rows);
  const row = current.get(key);
  if (!row) return testStop(workers[key]?.paused, null, workers[key]);
  const worker = rowLiveWorker(current, workers, row);
  return testStop(worker?.paused, row.liveStop, worker);
}

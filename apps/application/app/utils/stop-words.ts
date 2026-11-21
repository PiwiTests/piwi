import type { LiveCall, LiveStop } from '@piwitests/core/live-view';
import type { TestStop, TestStopReason } from '@piwitests/core/wire';
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

/** The words for a stop's reason as any source names it: one this page does not know reads as `other`'s. */
export function stopWords(reason: string): string {
  return reason in STOP_WORDS ? STOP_WORDS[reason as TestStopReason] : STOP_WORDS.other;
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

/** A stop as a test's row and its worker's lane panel show it: why, at which call, and since when (null when unknown). */
export interface ShownStop {
  reason: string;
  call: LiveCall;
  since: number | null;
}

/**
 * The stop a running test stands at, from the two sources that say it: the live view's (`live`, its worker's `paused`)
 * and the one its reporter told (`told`, the row's `liveStop`). Where both stand, the reason and the call are the live
 * view's and the time is the told stop's; either alone is the stop. Null for neither.
 */
export function testStop(live: LiveStop | null | undefined, told: TestStop | null | undefined): ShownStop | null {
  if (live) return { reason: live.reason, call: live.call, since: told?.since ?? null };
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
  if (!row) return testStop(workers[key]?.paused, null);
  return testStop(rowLiveWorker(current, workers, row)?.paused, row.liveStop);
}

import type { TestStopReason } from '@piwitests/core/wire';
import { englishRunSpeaker } from '@piwitests/run-model/words';

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

/** A time of day as this page's clock reads it: hours and minutes. */
function clockTime(time: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(time);
}

/**
 * For whom a failed CI test is held, and until when (`Held for Ana · until 12:05`), as the instance names the
 * controllers watching it (none when it knows no names); null for a held stop that says no end.
 */
export function heldStopWords(
  stop: { until?: number },
  heldFor: readonly string[],
  clock: (time: number) => string = clockTime,
): string | null {
  if (stop.until === undefined) return null;
  const time = clock(stop.until);
  return heldFor.length
    ? englishRunSpeaker.say('runs_heldFor', { names: englishRunSpeaker.list(heldFor), time })
    : englishRunSpeaker.say('runs_heldUntil', { time });
}

import type { TestStopReason } from '@piwitests/core/wire';

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

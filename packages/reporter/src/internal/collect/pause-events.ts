import type { TestStepEvent } from '@piwitests/core/wire';
import type { PauseRecord } from '../capture/pause-at.js';

/**
 * The stops a test made at Piwi's pause bar, as the dashboard reads them. A
 * stop holds a Playwright call before it runs: the call's step, the steps
 * around it and every timestamp after it stay on the clock they were measured
 * on, and each stop travels with the test's step events, so the timelines draw
 * it as a paused band and the step statistics leave its time out
 * (`collectStepMetrics`). The test runner already leaves it out of the test's
 * duration.
 */

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

/**
 * Each stop as a step event (`category: 'pause'`): the call it held as the title, why it stopped as the status, and
 * its call site.
 */
export function pauseStepEvents(pauses: readonly PauseRecord[]): TestStepEvent[] {
  return pauses.map((pause) => ({
    title: typeof pause.title === 'string' ? pause.title : '',
    category: 'pause',
    startedAt: pause.startedAt,
    duration: Math.max(0, pause.duration),
    status: typeof pause.reason === 'string' ? pause.reason : 'breakpoint',
    location: pause.location,
  }));
}

import { formatLongDuration } from './index';

/**
 * What a run's Tests list says before its first test: its global setup until the run knows its tests (they load after
 * it, with the run's `begin`), then that they start, with how long since the run began once the page counts it.
 */
export function beforeFirstTestText(total: number | null | undefined, elapsedMs: number | null): string {
  const what = total ? `Starting ${total} ${total === 1 ? 'test' : 'tests'}` : 'Global setup';
  return elapsedMs === null ? what : `${what} · ${formatLongDuration(Math.max(0, elapsedMs))}`;
}

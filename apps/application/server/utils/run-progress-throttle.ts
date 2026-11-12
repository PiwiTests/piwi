import type { RunProgressBroadcast } from './run-events';

/** The shortest time between two tallies of one run on the instance stream (`/api/stream`) and the demo's. */
export const RUN_PROGRESS_INTERVAL_MS = 2_000;

/** A throttle of values by key, as `keyedThrottle` returns it. */
export interface KeyedThrottle<K, V> {
  /** Send `value` now when its key sent nothing in the last interval, else hold it, in place of the one held. */
  push(key: K, value: V): void;
  /** Send the key's held value now, and start its next value afresh. */
  flush(key: K): void;
  /** Drop every held value and timer. */
  dispose(): void;
}

/**
 * At most one value per key every `intervalMs`: the first at once, then the latest one pushed during the interval,
 * sent as the interval ends, which starts the next.
 */
export function keyedThrottle<K, V>(intervalMs: number, send: (key: K, value: V) => void): KeyedThrottle<K, V> {
  const windows = new Map<K, { timer: ReturnType<typeof setTimeout>; held: { value: V } | null }>();
  const open = (key: K) => {
    const timer = setTimeout(() => {
      const held = windows.get(key)?.held;
      windows.delete(key);
      if (!held) return;
      send(key, held.value);
      open(key);
    }, intervalMs);
    windows.set(key, { timer, held: null });
  };
  return {
    push(key, value) {
      const window = windows.get(key);
      if (window) {
        window.held = { value };
        return;
      }
      send(key, value);
      open(key);
    },
    flush(key) {
      const window = windows.get(key);
      if (!window) return;
      clearTimeout(window.timer);
      windows.delete(key);
      if (window.held) send(key, window.held.value);
    },
    dispose() {
      for (const window of windows.values()) clearTimeout(window.timer);
      windows.clear();
    },
  };
}

/** Runs' tallies, at most one per run every `RUN_PROGRESS_INTERVAL_MS`, its latest winning. */
export function runProgressThrottle(
  send: (progress: RunProgressBroadcast) => void,
): KeyedThrottle<number, RunProgressBroadcast> {
  return keyedThrottle<number, RunProgressBroadcast>(RUN_PROGRESS_INTERVAL_MS, (_runId, progress) => send(progress));
}

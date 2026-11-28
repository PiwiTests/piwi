import { getCurrentScope, onScopeDispose, readonly, shallowRef, type Ref } from 'vue';

/** How often the clock of every shown stop's duration ticks. */
const STOP_CLOCK_MS = 10_000;

const now = shallowRef(Date.now());
let readers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The one clock every shown stop's duration reads (`stopStoodMs`), the rows' and the lane panel's alike, so they turn
 * over to the next minute together. It ticks in the browser while something reads it; a server render reads the time
 * it renders at.
 */
export function useStopClock(): Readonly<Ref<number>> {
  if (import.meta.server) return shallowRef(Date.now());
  if (readers === 0) now.value = Date.now();
  if (getCurrentScope()) {
    if (readers++ === 0) timer = setInterval(() => (now.value = Date.now()), STOP_CLOCK_MS);
    onScopeDispose(() => {
      if (--readers > 0 || !timer) return;
      clearInterval(timer);
      timer = null;
    });
  }
  return readonly(now);
}

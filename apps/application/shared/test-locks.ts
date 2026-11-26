/**
 * Test locks as Playwright declares them (`lock:` on a test or a `describe`). A lock name is a shared resource whose
 * holders never run at once, except Playwright's built-in `-exclusive-` lock (1.65): its holder runs only while no
 * other test runs, so it excludes every test, not only the other holders of its name.
 */

/** Playwright's built-in lock whose holder runs alone. */
export const EXCLUSIVE_LOCK = '-exclusive-';

/** Whether a lock name is Playwright's built-in `-exclusive-` lock. */
export function isExclusiveLock(lock: string): boolean {
  return lock === EXCLUSIVE_LOCK;
}

/** A lock as a page names it: `Runs alone` for the exclusive lock, its own name for any other. */
export function lockLabel(lock: string): string {
  return isExclusiveLock(lock) ? 'Runs alone' : lock;
}

/** What a lock does, for its tooltip. */
export function lockDescription(lock: string): string {
  return isExclusiveLock(lock)
    ? `No other test runs while this one does (Playwright's built-in ${EXCLUSIVE_LOCK} lock)`
    : `Lock ${lock}: only one holder runs at a time`;
}

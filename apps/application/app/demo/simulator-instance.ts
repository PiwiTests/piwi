/**
 * The page load a simulated run belongs to. Each page load streams its runs under its own instance id
 * (`demo-simulator:<page>`, a shard adding `|<label>`) and holds a Web Lock named after its page for as long as it is
 * open, so any tab can tell the runs a live page is still streaming from the runs a closed or reloaded page left behind.
 */

export const DEMO_SIMULATOR_INSTANCE_ID = 'demo-simulator';
const PAGE_LOCK_PREFIX = 'piwi-demo-simulator-page:';

let pageId: string | null = null;
let pageLock: Promise<boolean> | null = null;

function currentPageId(): string {
  pageId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return pageId;
}

/** The instance id this page load's simulated runs report. */
export function simulatorInstanceId(): string {
  return `${DEMO_SIMULATOR_INSTANCE_ID}:${currentPageId()}`;
}

/**
 * The page load a simulated run's instance id names: `''` for an id that names none, which no live page holds, and
 * null for a run the simulator did not send.
 */
export function simulatorPageOf(instanceId: string | null | undefined): string | null {
  if (!instanceId) return null;
  const base = instanceId.split('|')[0]!;
  if (base === DEMO_SIMULATOR_INSTANCE_ID) return '';
  return base.startsWith(`${DEMO_SIMULATOR_INSTANCE_ID}:`) ? base.slice(DEMO_SIMULATOR_INSTANCE_ID.length + 1) : null;
}

/**
 * Holds this page load's lock until the page is gone. Resolves true once it is held, false where the browser has no
 * Web Locks.
 */
export function holdSimulatorPage(): Promise<boolean> {
  pageLock ??= new Promise<boolean>((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.locks) return resolve(false);
    navigator.locks
      .request(PAGE_LOCK_PREFIX + currentPageId(), () => {
        resolve(true);
        return new Promise<never>(() => {});
      })
      .catch(() => resolve(false));
  });
  return pageLock;
}

/** The page loads open in any tab of the demo, this one included, or null where the browser cannot tell. */
export async function liveSimulatorPages(): Promise<string[] | null> {
  if (!(await holdSimulatorPage())) return null;
  try {
    const { held = [] } = await navigator.locks.query();
    return held.flatMap((lock) =>
      lock.name?.startsWith(PAGE_LOCK_PREFIX) ? [lock.name.slice(PAGE_LOCK_PREFIX.length)] : [],
    );
  } catch {
    return null;
  }
}

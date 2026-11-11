/**
 * A worker's stop as a surface that follows a run reads it (`@piwitests/core/run-hub`): what the stop takes from the
 * surface, whether its worker's lane can be watched and whether a lane's frame shows the worker as it is now, a point
 * of an image of the stopped page in the page's pixels, and where the stop stands, its error, its test's and its run's
 * names, and what a surface says of it as it comes, as text.
 */
import type { HubAction, HubSession, HubStop, HubTest, HubWorker } from '@piwitests/core/run-hub';
import type { RunSpeaker } from './words';

/** The actions in the test's window, which the pause bar shows, or a viewer drives through a headless stop's view. */
export const IN_WINDOW = ['pick', 'record', 'assert', 'assert-region'] as const;

/**
 * What a stop takes from the surface (`stop.intents`, as the hub tells each connection): its live view, the input on
 * it while the surface watches it, Pick on the image, the actions in the test's window where the pause bar shows or
 * while the surface watches the view, Mock a request, End the test but at a failure. From a service that predates it,
 * what the worker's reporter takes where the pause bar shows, and Mock a request at any stop: no live view.
 */
export function stopIntents(worker: Pick<HubWorker, 'intents'>, stop: Pick<HubStop, 'bar' | 'intents'>): HubAction[] {
  if (stop.intents) return stop.intents;
  return worker.intents.filter(
    (what) => what === 'mock' || (stop.bar && (IN_WINDOW as readonly string[]).includes(what)),
  );
}

/**
 * The actions in the test's window a stop no pause bar shows takes from the surface once it watches the stop (`view`,
 * or its worker's lane), while it does not: those the worker's reporter takes, shown held, saying to watch first. None
 * at a stop the bar shows, at one the surface watches, at one that cannot be watched (`watchable`: the stop takes
 * `view`, or its lane can be watched), and from a service that predates `stop.intents`.
 */
export function heldUntilWatched(
  worker: Pick<HubWorker, 'intents'>,
  stop: Pick<HubStop, 'bar' | 'intents'>,
  watchable: boolean,
): Array<(typeof IN_WINDOW)[number]> {
  if (stop.bar || !stop.intents || !watchable) return [];
  const taken = stop.intents;
  return IN_WINDOW.filter((what) => worker.intents.includes(what) && !taken.includes(what));
}

/**
 * Whether a worker's lane can be watched while it runs (Watch): `watch` at a hub whose features list `lanes`, the
 * worker's reporter listing `watch`; `outdated` for a reporter that does not, at such a hub; null at a hub that
 * predates it, where a stop's own view (`view`) is all there is.
 */
export function laneWatchOf(
  hub: { lanes: boolean } | undefined,
  worker: Pick<HubWorker, 'intents'>,
): 'watch' | 'outdated' | null {
  if (!hub?.lanes) return null;
  return worker.intents.includes('watch') ? 'watch' : 'outdated';
}

/**
 * Whether a frame of a lane shows where its worker stands now: sent by that worker, of the stop it stands at, or, while
 * it runs, of its running test. Another one (taken before a Step, a Resume, a test that ended, or by the worker
 * Playwright replaced) shows dimmed until the next frame comes.
 */
export function laneFrameNow(
  frame: { worker: number; test: string | null; since: string | null },
  worker: Pick<HubWorker, 'worker' | 'state' | 'test' | 'stop'> | undefined,
): boolean {
  if (!worker || frame.worker !== worker.worker) return false;
  if (worker.state === 'stopped') return !!worker.stop && frame.since === worker.stop.since;
  if (worker.state === 'between') return false;
  return frame.since === null && !!worker.test && frame.test === worker.test.id;
}

/**
 * A point of an image of a stopped page, from where the pointer is on it to CSS pixels of the page's viewport: the
 * image is shown scaled to `shown` (its content box, the border left out), and names the viewport it shows
 * (`viewport`). Kept within the viewport, at a hundredth of a pixel; null for an image shown at no size.
 */
export function pagePoint(
  offset: { x: number; y: number },
  shown: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  if (!(shown.width > 0) || !(shown.height > 0) || !(viewport.width > 0) || !(viewport.height > 0)) return null;
  const at = (value: number, size: number, page: number) =>
    Math.round(Math.min(Math.max((value * page) / size, 0), page - 0.01) * 100) / 100;
  return { x: at(offset.x, shown.width, viewport.width), y: at(offset.y, shown.height, viewport.height) };
}

/** A `file:` URI as a path with `/` separators: `/home/me/shop/tests/cart.spec.ts`, `C:/shop/tests/cart.spec.ts`. */
function uriPath(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return null;
    const path = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** A file of the run, relative to the run's folder when it is inside it, else as its whole path. */
export function runFile(uri: string, root: string | null): string {
  const path = uriPath(uri);
  if (path === null) return uri;
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return path.slice(base.length + 1);
  return path;
}

/** Where a stop stands, as text: `tests/pages/cart.page.ts:13`, with the 1-based line. */
export function stopPlace(stop: Pick<HubStop, 'uri' | 'line'>, root: string | null): string {
  return `${runFile(stop.uri, root)}:${stop.line + 1}`;
}

/**
 * The error a failure's stop names: its `error`, else, from a service or a reporter that predates it, read from its
 * title, which the reporter makes of `Failed: ` and the error's first line, which Playwright starts with the error's
 * name (`Error: expect(locator).toBeVisible() failed`).
 */
export function stopError(stop: Pick<HubStop, 'error' | 'title'>): string {
  return stop.error ?? stop.title.replace(/^Failed:\s*(?:Error:\s*)?/, '');
}

/** A test's name: its `describe` blocks' titles, then its own. */
export function testName(test: Pick<HubTest, 'title'>): string {
  return test.title.join(' › ');
}

/** A run's name: its Piwi project, else its folder, else the word for a run. */
export function runName(session: Pick<HubSession, 'project' | 'label'>, speaker: RunSpeaker): string {
  return session.project ?? session.label ?? speaker.say('runs_run');
}

/** What a surface says of a stop as it comes: the test (its name, else the run's), and where it failed or stopped. */
export function stopSaid(
  session: Pick<HubSession, 'project' | 'label' | 'root'>,
  worker: Pick<HubWorker, 'test'>,
  stop: Pick<HubStop, 'reason' | 'uri' | 'line'>,
  speaker: RunSpeaker,
): string {
  const test = worker.test ? testName(worker.test) : runName(session, speaker);
  const place = stopPlace(stop, session.root);
  return speaker.say(stop.reason === 'failure' ? 'runs_announceFailed' : 'runs_announceStopped', { test, place });
}

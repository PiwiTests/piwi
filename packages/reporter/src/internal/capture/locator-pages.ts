/**
 * The page each locator call ran on, recorded by the capture fixtures and
 * attached as `piwi-locator-pages`. The locator wrapper calls
 * {@link LocatorPageLog.record} at the start of every action and assertion
 * with the call site, the chain as Playwright prints it and the page's URL;
 * only the page's origin and its normalized key (`/orders/:id`) are kept, never
 * the query, the hash or a raw id.
 *
 * "On arrival" says no locator interaction happened on the page since its last
 * main-frame navigation, so the element was there as the page loaded rather
 * than after the test opened a menu or a dialog. The count lives per page, so
 * the capture fixtures and a fixtures file that wraps locators itself share it
 * through {@link noteNavigation} and {@link noteLocatorCall}.
 */
import { pageKey } from '@piwitests/core/page-key';
import type { LocatorPageUse } from '@piwitests/core/wire';

/** Entries kept per test; a loop over hundreds of pages stops adding here. */
export const MAX_LOCATOR_PAGE_ENTRIES = 1000;
/** Longer chains are skipped, as the locator index skips them. */
const MAX_LOCATOR_CHARS = 1000;

/** Locator methods that do not change the page: what the element looks like after them is what it was before. */
const NON_INTERACTIONS: ReadonlySet<string> = new Set(['waitFor']);

/** Locator interactions on each page since its last main-frame navigation. */
const interactions = new WeakMap<object, number>();

/** A main-frame navigation, full or same-document: the page starts over. */
export function noteNavigation(page: object): void {
  interactions.set(page, 0);
}

/** Whether a call starting now on `page` is on arrival: no locator interaction there since it loaded. */
export function isOnArrival(page: object): boolean {
  return (interactions.get(page) ?? 0) === 0;
}

/**
 * A locator call starts on `page`: returns whether it is on arrival, and counts
 * it when it is an interaction (every action but `waitFor`; assertions are not).
 */
export function noteLocatorCall(page: object, method: string, assertion = false): boolean {
  const arrival = isOnArrival(page);
  if (!assertion && !NON_INTERACTIONS.has(method)) interactions.set(page, (interactions.get(page) ?? 0) + 1);
  return arrival;
}

/** The origin and key of a page URL; null for anything that is not an http(s) page. */
export function pageOf(url: string): { origin: string; page: string } | null {
  const key = pageKey(url);
  if (key === null) return null;
  try {
    const origin = new URL(url).origin;
    return origin && origin !== 'null' ? { origin, page: key } : null;
  } catch {
    return null;
  }
}

export class LocatorPageLog {
  private readonly entries = new Map<string, LocatorPageUse>();

  /** Record one call. Silently skipped without a call site, off an http(s) page, or past the limits. */
  record(call: { location: string | null; locator: string; url: string; arrival: boolean }): void {
    if (!call.location || !call.locator || call.locator.length > MAX_LOCATOR_CHARS) return;
    const where = pageOf(call.url);
    if (!where) return;
    const key = `${call.location}\x00${call.locator}\x00${where.origin}\x00${where.page}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.arrival ||= call.arrival;
      return;
    }
    if (this.entries.size >= MAX_LOCATOR_PAGE_ENTRIES) return;
    this.entries.set(key, { location: call.location, locator: call.locator, ...where, arrival: call.arrival });
  }

  get size(): number {
    return this.entries.size;
  }

  /** The entries in the order the calls first happened. */
  list(): LocatorPageUse[] {
    return [...this.entries.values()];
  }
}

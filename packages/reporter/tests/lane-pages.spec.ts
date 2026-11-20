import { chromium, type Browser, type Page } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  laneCalled,
  lanePage,
  lanePageNow,
  laneSawPage,
  laneStopped,
  laneTestBegan,
  laneTestEnded,
  laneWentOn,
  onLanePage,
} from '../src/internal/capture/lane-feed.js';

/**
 * The page the worker's lane shows for its test, which the run page's live view and the editor's lane view show: the
 * `page` fixture's page for a test that has one; for a test without it, the page its latest call landed on, whichever
 * context it belongs to, and before its first call, or once that page closed, the page the browser opened last that
 * is still open, a `beforeAll`'s included. A stop's page shows while the worker stands at it.
 */

/** A page as the lane reads it: whether it is closed, and its close. */
function fakePage(name: string): Page & { close(): Promise<void>; name: string } {
  let closed = false;
  const onClose = new Set<() => void>();
  const page = {
    name,
    isClosed: () => closed,
    once: (event: string, listener: () => void) => {
      if (event === 'close') onClose.add(listener);
      return page;
    },
    off: (event: string, listener: () => void) => {
      if (event === 'close') onClose.delete(listener);
      return page;
    },
    close: async () => {
      closed = true;
      for (const listener of onClose) {
        onClose.delete(listener);
        listener();
      }
    },
  };
  return page as unknown as Page & { close(): Promise<void>; name: string };
}

/** The pages each test opened, closed after it so the next one starts with none. */
let pages: Array<ReturnType<typeof fakePage>> = [];

function opened(name: string): ReturnType<typeof fakePage> {
  const page = fakePage(name);
  pages.push(page);
  laneSawPage(page);
  return page;
}

afterEach(async () => {
  await laneTestEnded();
  for (const page of pages) await page.close();
  pages = [];
});

describe('the page the lane shows', () => {
  it('shows a test without the `page` fixture the page of its latest call, whichever context it is in', async () => {
    // A serial group's `beforeAll` opens one page per portal: no test runs yet, so none shows.
    const admin = opened('admin');
    const customer = opened('customer');
    expect(lanePageNow()).toBeNull();

    laneTestBegan('t1');
    // Before its first call, the page opened last.
    expect(lanePageNow()).toBe(customer);
    laneCalled(admin);
    expect(lanePageNow()).toBe(admin);
    laneCalled(customer);
    expect(lanePageNow()).toBe(customer);
    await laneTestEnded();
    expect(lanePageNow()).toBeNull();

    // The next test of the group starts again from the page opened last, and follows its own calls.
    laneTestBegan('t2');
    expect(lanePageNow()).toBe(customer);
    laneCalled(admin);
    expect(lanePageNow()).toBe(admin);
  });

  it('shows a page opened after the test’s first call once a call lands on it, and the page opened last as that one closes', async () => {
    const first = opened('first');
    laneTestBegan('t1');
    laneCalled(first);
    // A popup the call opened shows only once a call lands on it.
    const popup = opened('popup');
    expect(lanePageNow()).toBe(first);
    laneCalled(popup);
    expect(lanePageNow()).toBe(popup);
    // The popup closes: the page opened last that is still open shows.
    await popup.close();
    expect(lanePageNow()).toBe(first);
    await first.close();
    expect(lanePageNow()).toBeNull();
  });

  it('shows a test’s `page` fixture whatever page its calls land on', async () => {
    const other = opened('other');
    laneTestBegan('t1');
    const fixture = opened('fixture');
    lanePage(fixture);
    laneCalled(other);
    expect(lanePageNow()).toBe(fixture);
  });

  it('ignores a call on a page the browser did not open, and a call between two tests', async () => {
    const known = opened('known');
    laneCalled(known);
    laneTestBegan('t1');
    expect(lanePageNow()).toBe(known);
    const later = opened('later');
    expect(lanePageNow()).toBe(later);
    // A page of a browser the test launched itself, which the capture fixtures never saw.
    laneCalled(fakePage('unseen'));
    expect(lanePageNow()).toBe(later);
  });

  it('shows a stop’s page while the worker stands at it', async () => {
    const admin = opened('admin');
    const customer = opened('customer');
    laneTestBegan('t1');
    laneCalled(admin);
    laneStopped(1, customer);
    expect(lanePageNow()).toBe(customer);
    laneWentOn(1);
    expect(lanePageNow()).toBe(admin);
  });

  it('tells its listeners outside the Playwright call that changed the page it shows', async () => {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      type Wrap = (run: (zone: { internal?: unknown }) => Promise<void>, options: object) => Promise<void>;
      const wrap = (page as unknown as { _wrapApiCall: Wrap })._wrapApiCall.bind(page);
      laneTestBegan('t1');
      // The zone of a call each listener makes: an internal one of its own, never the call that told the lane.
      const zones: Array<{ internal?: unknown }> = [];
      const unhear = onLanePage(() => void wrap(async (zone) => void zones.push(zone), { internal: true }));
      try {
        // As `browser.newPage()` tells the lane of its page, inside its own call.
        await wrap(async () => laneSawPage(page), { title: 'Create page' });
      } finally {
        unhear();
      }
      expect(zones).toEqual([expect.objectContaining({ internal: true })]);
    } finally {
      await browser?.close();
    }
  }, 30_000);

  it('tells its listeners each time the page it shows changes, a close included', async () => {
    const admin = opened('admin');
    const customer = opened('customer');
    const heard: Array<string | null> = [];
    const unhear = onLanePage(() => heard.push((lanePageNow() as unknown as { name: string } | null)?.name ?? null));
    try {
      laneTestBegan('t1');
      laneCalled(customer);
      laneCalled(admin);
      laneCalled(admin);
      await admin.close();
      expect(heard).toEqual(['customer', 'admin', 'customer']);
    } finally {
      unhear();
    }
  });
});

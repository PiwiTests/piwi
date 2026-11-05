import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  holdInOneTab,
  TAB_LEASE_RENEW_MS,
  TAB_LEASE_SETTLE_MS,
  TAB_LEASE_STALE_MS,
  type TabLeaseHost,
} from '../../app/utils/tab-lease';

type Listener = (event: { key?: string | null; persisted?: boolean }) => void;

/** One browser's `localStorage`, shared by its tabs, which tells every other tab of a change, as browsers do. */
class Browser {
  values = new Map<string, string>();
  tabs: Tab[] = [];
  changed(by: Tab, key: string) {
    for (const tab of this.tabs) if (tab !== by) tab.fire('storage', { key });
  }
}

/** A tab of that browser; a frozen tab runs no timer, as a browser may freeze a hidden one. */
class Tab {
  listeners = new Map<string, Listener[]>();
  frozen = false;
  held = vi.fn();
  lost = vi.fn();
  stop: () => void = () => {};
  constructor(readonly browser: Browser) {
    browser.tabs.push(this);
  }
  host(): TabLeaseHost {
    const { browser } = this;
    return {
      storage: {
        getItem: (key) => browser.values.get(key) ?? null,
        setItem: (key, value) => {
          browser.values.set(key, value);
          browser.changed(this, key);
        },
        removeItem: (key) => {
          browser.values.delete(key);
          browser.changed(this, key);
        },
      },
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(() => !this.frozen && fn(), ms),
      setInterval: (fn, ms) => setInterval(() => !this.frozen && fn(), ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      on: (type, listener) => this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]),
    };
  }
  fire(type: string, event: { key?: string | null; persisted?: boolean }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.stop = holdInOneTab({ key: 'lease', held: this.held, lost: this.lost }, this.host());
    return this;
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('holdInOneTab', () => {
  test('one tab of the browser holds the lease, the first to take it', () => {
    const browser = new Browser();
    const first = new Tab(browser).open();
    const second = new Tab(browser).open();
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    expect(first.held).toHaveBeenCalledOnce();
    expect(second.held).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TAB_LEASE_STALE_MS * 2);
    expect(second.held).not.toHaveBeenCalled();
  });

  test('a tab whose write another tab overwrote while it settled does not hold it', () => {
    const browser = new Browser();
    const first = new Tab(browser).open();
    // Another tab read the empty lease too, and wrote after this one.
    browser.values.set('lease', JSON.stringify({ id: 'another tab', at: Date.now() }));
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    expect(first.held).not.toHaveBeenCalled();
  });

  test('the next tab takes it as soon as the holder’s page goes away', () => {
    const browser = new Browser();
    const first = new Tab(browser).open();
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    const second = new Tab(browser).open();
    first.fire('pagehide', {});
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    expect(second.held).toHaveBeenCalledOnce();
  });

  test('a holder frozen past the stale delay loses it, and is told so when it runs again', () => {
    const browser = new Browser();
    const first = new Tab(browser).open();
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    const second = new Tab(browser).open();
    first.frozen = true;
    vi.advanceTimersByTime(TAB_LEASE_STALE_MS + TAB_LEASE_RENEW_MS);
    expect(second.held).toHaveBeenCalledOnce();
    first.frozen = false;
    vi.advanceTimersByTime(TAB_LEASE_RENEW_MS);
    expect(first.lost).toHaveBeenCalledOnce();
  });

  test('a hidden holder that renews once a minute keeps it', () => {
    const browser = new Browser();
    const first = new Tab(browser).open();
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    const second = new Tab(browser).open();
    for (let minute = 0; minute < 5; minute++) {
      first.frozen = true;
      vi.advanceTimersByTime(60_000 - TAB_LEASE_RENEW_MS);
      first.frozen = false;
      vi.advanceTimersByTime(TAB_LEASE_RENEW_MS);
    }
    expect(second.held).not.toHaveBeenCalled();
    expect(first.lost).not.toHaveBeenCalled();
  });

  test('every tab holds it when the browser refuses localStorage', () => {
    const held = vi.fn();
    const host = new Tab(new Browser()).host();
    host.storage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {},
    };
    holdInOneTab({ key: 'lease', held, lost: () => {} }, host);
    expect(held).toHaveBeenCalledOnce();
  });
});

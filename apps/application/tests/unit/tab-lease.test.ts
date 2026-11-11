import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  holdInOneTab,
  TAB_LEASE_RENEW_MS,
  TAB_LEASE_SETTLE_MS,
  TAB_LEASE_STALE_MS,
  type TabLeaseHost,
} from '../../app/utils/tab-lease';

type Listener = (event: { key?: string | null; persisted?: boolean }) => void;

/**
 * One browser's `localStorage`, shared by its tabs, which tells every other tab of a change, as browsers do. With a
 * `lag`, another tab sees a write that much later, as a tab in another process may, and in the storage's own order: a
 * write that reaches a tab after a later one changes nothing it sees.
 */
class Browser {
  values = new Map<string, string>();
  tabs: Tab[] = [];
  lag = 0;
  /** How many writes the storage has taken. */
  writes = 0;
  /** The keys a full storage refuses to write; it still reads and removes. */
  refuses: (key: string) => boolean = () => false;
  /** Store `value` for `by` (`undefined` removes it), and tell every other tab. */
  write(by: Tab, key: string, value: string | undefined) {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    const order = ++this.writes;
    by.see(key, value, order);
    for (const tab of this.tabs) {
      if (tab === by) continue;
      if (this.lag === 0) {
        tab.fire('storage', { key });
        continue;
      }
      setTimeout(() => {
        tab.see(key, value, order);
        tab.fire('storage', { key });
      }, this.lag);
    }
  }
}

/**
 * A tab of that browser. A frozen tab runs no timer and hears no event until it runs again, as a browser may freeze a
 * hidden one.
 */
class Tab {
  listeners = new Map<string, Listener[]>();
  /** What this tab sees of the storage while the browser lags, and the order of the write it last saw of each key. */
  seen = new Map<string, string>();
  orders = new Map<string, number>();
  /** The events a frozen tab heard, given to it as it runs again. */
  private heard: Array<[string, { key?: string | null; persisted?: boolean }]> = [];
  private isFrozen = false;
  get frozen(): boolean {
    return this.isFrozen;
  }
  set frozen(frozen: boolean) {
    this.isFrozen = frozen;
    if (!frozen) for (const [type, event] of this.heard.splice(0)) this.fire(type, event);
  }
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
        getItem: (key) => (browser.lag === 0 ? browser.values : this.seen).get(key) ?? null,
        setItem: (key, value) => {
          if (browser.refuses(key)) throw new Error('QuotaExceededError');
          browser.write(this, key, value);
        },
        removeItem: (key) => browser.write(this, key, undefined),
      },
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(() => !this.frozen && fn(), ms),
      setInterval: (fn, ms) => setInterval(() => !this.frozen && fn(), ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      on: (type, listener) => this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]),
    };
  }
  see(key: string, value: string | undefined, order: number) {
    if (order <= (this.orders.get(key) ?? 0)) return;
    this.orders.set(key, order);
    if (value === undefined) this.seen.delete(key);
    else this.seen.set(key, value);
  }
  fire(type: string, event: { key?: string | null; persisted?: boolean }) {
    if (this.isFrozen) {
      this.heard.push([type, event]);
      return;
    }
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.stop = holdInOneTab({ key: 'lease', held: this.held, lost: this.lost }, this.host());
    return this;
  }
}

/** Whether the tab holds the lease now: told it holds it once more than told it lost it. */
const holds = (tab: Tab): boolean => tab.held.mock.calls.length > tab.lost.mock.calls.length;

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

  test('tabs that took it before seeing each other’s write agree on the first long before the next renewal', () => {
    const browser = new Browser();
    browser.lag = TAB_LEASE_SETTLE_MS * 2;
    const first = new Tab(browser).open();
    vi.advanceTimersByTime(1);
    const tabs = [first, new Tab(browser).open(), new Tab(browser).open()];
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    expect(tabs.filter(holds)).toHaveLength(3);
    vi.advanceTimersByTime(TAB_LEASE_RENEW_MS / 2);
    expect(tabs.filter(holds)).toEqual([first]);
    vi.advanceTimersByTime(TAB_LEASE_STALE_MS * 2);
    expect(tabs.filter(holds)).toEqual([first]);
    expect(first.lost).not.toHaveBeenCalled();
  });

  test('two holders that each see the other’s write keep one of them', () => {
    const browser = new Browser();
    browser.lag = TAB_LEASE_SETTLE_MS * 2;
    const tabs = [new Tab(browser).open(), new Tab(browser).open()];
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    expect(tabs.filter(holds)).toHaveLength(2);
    vi.advanceTimersByTime(TAB_LEASE_STALE_MS * 2);
    expect(tabs.filter(holds)).toHaveLength(1);
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
    expect(first.lost).not.toHaveBeenCalled();
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

  test('every tab holds it when the storage takes the probe but refuses the lease', () => {
    const browser = new Browser();
    browser.refuses = (key) => key === 'lease';
    const first = new Tab(browser).open();
    const second = new Tab(browser).open();
    expect(first.held).toHaveBeenCalledOnce();
    expect(second.held).toHaveBeenCalledOnce();
  });

  test('a tab holding over a refused claim keeps it beside another tab’s stale lease', () => {
    const browser = new Browser();
    browser.values.set('lease', JSON.stringify({ id: 'a crashed tab', at: Date.now() - TAB_LEASE_STALE_MS - 1 }));
    browser.refuses = (key) => key === 'lease';
    const tab = new Tab(browser).open();
    vi.advanceTimersByTime(TAB_LEASE_RENEW_MS * 6);
    expect(tab.held).toHaveBeenCalledOnce();
    expect(tab.lost).not.toHaveBeenCalled();
  });

  test('the next tab holds it when the holder leaves a storage that has filled up since', () => {
    const browser = new Browser();
    const first = new Tab(browser).open();
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    const second = new Tab(browser).open();
    browser.refuses = () => true;
    first.fire('pagehide', {});
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    expect(second.held).toHaveBeenCalledOnce();
  });

  test('a holder whose storage refuses the release gives it up quietly', () => {
    const tab = new Tab(new Browser());
    const host = tab.host();
    holdInOneTab({ key: 'lease', held: tab.held, lost: tab.lost }, host);
    vi.advanceTimersByTime(TAB_LEASE_SETTLE_MS);
    expect(tab.held).toHaveBeenCalledOnce();
    const removeItem = vi.fn(() => {
      throw new Error('SecurityError');
    });
    host.storage.removeItem = removeItem;
    expect(() => tab.fire('pagehide', {})).not.toThrow();
    expect(removeItem).toHaveBeenCalledWith('lease');
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

import { beforeEach, describe, expect, it } from 'vitest';
import {
  bareLocator,
  getLocatorHistory,
  HistoryCursor,
  LOCATOR_HISTORY_KEY,
  rememberLocator,
  withHistoryEntry,
} from '../../src/shared/locator-console.js';

function fakeChromeStorage(store: Record<string, unknown>) {
  return {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  };
}

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = fakeChromeStorage(store);
});

describe('withHistoryEntry', () => {
  it('adds the expression as the newest entry', () => {
    expect(withHistoryEntry(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('moves an expression kept earlier to the end rather than keeping it twice', () => {
    expect(withHistoryEntry(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
  });

  it('lets the oldest go past the limit', () => {
    expect(withHistoryEntry(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });
});

describe('the history in session storage', () => {
  it('keeps what is remembered, trimmed, and nothing blank', async () => {
    expect(await getLocatorHistory()).toEqual([]);
    await rememberLocator("  getByRole('button')  ");
    await rememberLocator('   ');
    await rememberLocator("getByTestId('total')");
    expect(await getLocatorHistory()).toEqual(["getByRole('button')", "getByTestId('total')"]);
    expect(store[LOCATOR_HISTORY_KEY]).toEqual(["getByRole('button')", "getByTestId('total')"]);
  });

  it('reads only the strings of what is stored', async () => {
    store[LOCATOR_HISTORY_KEY] = ['a', 3, null, 'b'];
    expect(await getLocatorHistory()).toEqual(['a', 'b']);
    store[LOCATOR_HISTORY_KEY] = 'a';
    expect(await getLocatorHistory()).toEqual([]);
  });
});

describe('HistoryCursor', () => {
  it('walks back with Up and forward with Down, then gives the typed text back', () => {
    const cursor = new HistoryCursor(['a', 'b', 'c']);
    expect(cursor.older('typed')).toBe('c');
    expect(cursor.older('c')).toBe('b');
    expect(cursor.older('b')).toBe('a');
    expect(cursor.older('a')).toBeNull();
    expect(cursor.newer('a')).toBe('b');
    expect(cursor.newer('b')).toBe('c');
    expect(cursor.newer('c')).toBe('typed');
    expect(cursor.newer('typed')).toBeNull();
  });

  it('passes over the entry the field already shows', () => {
    const cursor = new HistoryCursor(['a', 'b']);
    expect(cursor.older('b')).toBe('a');
    expect(cursor.newer('a')).toBe('b');
  });

  it('does nothing on an empty history, or with only the text shown', () => {
    expect(new HistoryCursor([]).older('x')).toBeNull();
    expect(new HistoryCursor(['x']).older('x')).toBeNull();
  });

  it('starts over at the field after a reset', () => {
    const cursor = new HistoryCursor(['a']);
    expect(cursor.older('')).toBe('a');
    cursor.reset(['a', 'b']);
    expect(cursor.older('typed')).toBe('b');
  });
});

describe('bareLocator', () => {
  it('drops the page the console accepts before a locator', () => {
    expect(bareLocator("page.getByRole('button')")).toBe("getByRole('button')");
    expect(bareLocator("await page.getByText('Hi')")).toBe("getByText('Hi')");
    expect(bareLocator(" this.page.locator('#a') ")).toBe("locator('#a')");
    expect(bareLocator("getByTestId('page.x')")).toBe("getByTestId('page.x')");
  });
});

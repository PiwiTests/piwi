import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { keepRunWhere, keptRunWhere } from '~/utils/run-where';

/** A browser's storage, in memory. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

describe('the last Where of the run dialog', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('reads back an app, a CI action and This computer, per project', () => {
    keepRunWhere(1, 'app:7');
    keepRunWhere(2, 'ci:rerun');
    keepRunWhere(3, 'local');
    expect(keptRunWhere(1)).toBe('app:7');
    expect(keptRunWhere(2)).toBe('ci:rerun');
    expect(keptRunWhere(3)).toBe('local');
    expect(keptRunWhere(4)).toBeNull();
  });

  test('ignores what is no Where', () => {
    localStorage.setItem('piwi-run-where', JSON.stringify({ 1: 'locally', 2: 'ci:', 3: 42, 4: 'local' }));
    expect(keptRunWhere(1)).toBeNull();
    expect(keptRunWhere(2)).toBeNull();
    expect(keptRunWhere(3)).toBeNull();
    expect(keptRunWhere(4)).toBe('local');
  });

  test('reads nothing from storage that is not JSON, or cannot be read', () => {
    localStorage.setItem('piwi-run-where', '{');
    expect(keptRunWhere(1)).toBeNull();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => keepRunWhere(1, 'local')).not.toThrow();
    expect(keptRunWhere(1)).toBeNull();
  });
});

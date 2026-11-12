import { afterEach, describe, expect, test, vi } from 'vitest';
import { TtlCache } from '../../server/utils/ttl-cache';

afterEach(() => {
  vi.useRealTimers();
});

describe('TtlCache', () => {
  test('returns a value until its time to live passes', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(1000);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('a full cache drops an expired entry before the oldest', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(1000, 3);
    cache.set('a', 1);
    vi.advanceTimersByTime(600);
    cache.set('b', 2);
    cache.set('c', 3);
    vi.advanceTimersByTime(500);
    cache.set('d', 4);
    expect([cache.get('a'), cache.get('b'), cache.get('c'), cache.get('d')]).toEqual([undefined, 2, 3, 4]);
  });

  test('a key set again counts as the newest, so a full cache drops another entry first', () => {
    const cache = new TtlCache<number>(60_000, 4);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('a', 10);
    cache.set('d', 4);
    cache.set('e', 5);
    expect([cache.get('a'), cache.get('b'), cache.get('c'), cache.get('d'), cache.get('e')]).toEqual([
      10,
      undefined,
      3,
      4,
      5,
    ]);
  });

  test('setting a key that is already there at capacity drops nothing', () => {
    const cache = new TtlCache<number>(60_000, 3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('b', 20);
    expect(cache.size).toBe(3);
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual([1, 20, 3]);
  });

  test('setting a key again restarts its time to live', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(1000);
    cache.set('a', 1);
    vi.advanceTimersByTime(800);
    cache.set('a', 2);
    vi.advanceTimersByTime(800);
    expect(cache.get('a')).toBe(2);
  });
});

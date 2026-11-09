import { describe, expect, it } from 'vitest';
import { createShownNotifications } from '../../app/utils/desktop-notifications';

describe('the desktop shim’s shown notifications', () => {
  it('finds a notification by the id it was given until it is removed', () => {
    const shown = createShownNotifications<string>(10, 41);
    const first = shown.add('run #12 failed');
    const second = shown.add('cluster #3 diagnosed');
    expect([first, second]).toEqual([41, 42]);
    expect(shown.get(first)).toBe('run #12 failed');
    shown.remove(first);
    expect(shown.get(first)).toBeUndefined();
    expect(shown.get(second)).toBe('cluster #3 diagnosed');
  });

  it('forgets the oldest past its limit', () => {
    const shown = createShownNotifications<number>(2, 1);
    const ids = [shown.add(1), shown.add(2), shown.add(3)];
    expect(shown.get(ids[0]!)).toBeUndefined();
    expect(ids.slice(1).map((id) => shown.get(id))).toEqual([2, 3]);
  });

  it('keeps every id a positive 32-bit integer, as the notification plugin takes', () => {
    const shown = createShownNotifications<string>(10, 2 ** 31 - 1);
    expect([shown.add('a'), shown.add('b')]).toEqual([2 ** 31 - 1, 1]);
    for (let i = 0; i < 20; i++) {
      const id = createShownNotifications<string>().add('x');
      expect(Number.isInteger(id) && id >= 1 && id <= 2 ** 31 - 1).toBe(true);
    }
  });
});

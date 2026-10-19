import { describe, test, expect } from 'vitest';
import { endOfLocalDay, localDateInputValue } from '../../app/utils/local-date';

/** A date picked in a date input is a day of the viewer's own calendar, whatever their time zone. */
describe('local dates', () => {
  test('a picked day ends at its last instant in the local time zone', () => {
    const end = endOfLocalDay('2026-10-19')!;
    expect([end.getFullYear(), end.getMonth(), end.getDate()]).toEqual([2026, 9, 19]);
    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([23, 59, 59, 999]);
    expect(endOfLocalDay('19/10/2026')).toBeNull();
    expect(endOfLocalDay('')).toBeNull();
  });

  test('today is the local calendar day, so it can be picked and still lasts until midnight', () => {
    const lateEvening = new Date(2026, 9, 19, 23, 30);
    expect(localDateInputValue(lateEvening)).toBe('2026-10-19');
    expect(endOfLocalDay(localDateInputValue(lateEvening))!.getTime()).toBeGreaterThan(lateEvening.getTime());
  });
});

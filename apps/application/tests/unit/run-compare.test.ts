import { describe, expect, test } from 'vitest';
import { compareOrder } from '../../app/utils/run-compare';

describe('compareOrder', () => {
  test('takes the run that started later as the newer one, whatever its id', () => {
    // Run 90 is an import of a report from before run 12 started.
    const imported = { id: 90, startTime: '2026-10-01T08:00:00Z' };
    const recent = { id: 12, startTime: '2026-10-20T08:00:00Z' };
    expect(compareOrder(imported, recent)).toEqual({ newer: recent, older: imported });
    expect(compareOrder(recent, imported)).toEqual({ newer: recent, older: imported });
  });

  test('gives a tie on the start time to the higher id', () => {
    const a = { id: 3, startTime: new Date('2026-10-20T08:00:00Z') };
    const b = { id: 4, startTime: new Date('2026-10-20T08:00:00Z') };
    expect(compareOrder(a, b)).toEqual({ newer: b, older: a });
  });
});

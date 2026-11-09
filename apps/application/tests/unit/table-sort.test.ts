import { describe, expect, test } from 'vitest';
import { sortRows } from '../../app/utils/table-sort';

interface Run {
  id: number;
  status: string;
  duration: number | null;
}

const runs: Run[] = [
  { id: 1, status: 'passed', duration: 90_000 },
  { id: 2, status: 'failed', duration: null },
  { id: 3, status: 'passed', duration: 5_000 },
  { id: 4, status: 'interrupted', duration: 40_000 },
];
const VALUES = { status: (r: Run) => r.status, duration: (r: Run) => r.duration };

describe('sortRows', () => {
  test('sorts every row before a page is cut from them', () => {
    // A table showing two runs a page: sorted by duration, its first page holds the two longest of the four.
    const longest = sortRows(runs, [{ id: 'duration', desc: true }], VALUES).slice(0, 2);
    expect(longest.map((r) => r.id)).toEqual([1, 4]);
  });

  test('puts a row with no value last in both directions, and keeps the order of equal rows', () => {
    expect(sortRows(runs, [{ id: 'duration', desc: false }], VALUES).map((r) => r.id)).toEqual([3, 4, 1, 2]);
    expect(sortRows(runs, [{ id: 'duration', desc: true }], VALUES).map((r) => r.id)).toEqual([1, 4, 3, 2]);
    expect(sortRows(runs, [{ id: 'status', desc: false }], VALUES).map((r) => r.id)).toEqual([2, 4, 1, 3]);
  });

  test('keeps the rows as they are with no sort, or one on a column it cannot read', () => {
    expect(sortRows(runs, [], VALUES)).toEqual(runs);
    expect(sortRows(runs, [{ id: 'browsers', desc: true }], VALUES)).toEqual(runs);
  });
});

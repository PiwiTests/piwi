/**
 * The order starred projects give the pages (`app/utils/project-stars.ts`):
 * starred first, each part in its own order, and Home's Project health keeping
 * its tendency order within each part; and the browser's star list as the
 * cookie may hold it.
 */
import { describe, expect, test } from 'vitest';
import {
  MAX_BROWSER_STARS,
  orderProjectHealth,
  parseStarredIds,
  starredFirst,
  type HealthOrderProject,
} from '~/utils/project-stars';

describe('starredFirst', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

  test('puts the starred items first, each part in the order it came', () => {
    expect(starredFirst(items, new Set([4, 2]), (i) => i.id).map((i) => i.id)).toEqual([2, 4, 1, 3]);
  });

  test('keeps the order with no star, or a star on an item not listed', () => {
    expect(starredFirst(items, new Set(), (i) => i.id).map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(starredFirst(items, new Set([9]), (i) => i.id).map((i) => i.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('orderProjectHealth', () => {
  const project = (id: number, tendency: HealthOrderProject['tendency'], day: number | null): HealthOrderProject => ({
    id,
    tendency,
    latestFullRun: day === null ? null : { startTime: new Date(Date.UTC(2026, 10, day)) },
  });
  const projects = [
    project(1, 'passing', 3),
    project(2, 'failing', 1),
    project(3, 'unknown', null),
    project(4, 'flaky', 2),
    project(5, 'failing', 4),
    project(6, 'passing', 5),
  ];

  test('without stars: failing, flaky, passing, unknown, the newest full run first within one', () => {
    expect(orderProjectHealth(projects, new Set())).toEqual({
      projects: [5, 2, 4, 6, 1, 3].map((id) => projects.find((p) => p.id === id)),
      starredCount: 0,
    });
  });

  test('starred projects lead, each part in that order', () => {
    const { projects: ordered, starredCount } = orderProjectHealth(projects, new Set([1, 3, 2]));
    expect(ordered.map((p) => p.id)).toEqual([2, 1, 3, 5, 4, 6]);
    expect(starredCount).toBe(3);
  });

  test('a star on a project the list does not hold counts nothing', () => {
    expect(orderProjectHealth(projects, new Set([42])).starredCount).toBe(0);
  });
});

describe('parseStarredIds', () => {
  test('keeps whole positive ids, each once, in order', () => {
    expect(parseStarredIds([3, 1, 3, 0, -2, 1.5, '4', null, 7])).toEqual([3, 1, 7]);
  });

  test('reads anything but a list as no star', () => {
    expect(parseStarredIds('3,1')).toEqual([]);
    expect(parseStarredIds(null)).toEqual([]);
    expect(parseStarredIds({ 0: 3 })).toEqual([]);
  });

  test('keeps at most the cap', () => {
    const many = Array.from({ length: MAX_BROWSER_STARS + 5 }, (_, i) => i + 1);
    expect(parseStarredIds(many)).toHaveLength(MAX_BROWSER_STARS);
  });
});

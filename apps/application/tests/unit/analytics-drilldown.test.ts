import { describe, expect, test } from 'vitest';
import {
  bucketDrill,
  bucketRange,
  drillDownHref,
  drillQueryKey,
  metricDrillList,
  parseDrillQuery,
  singleProjectOf,
} from '../../app/utils/analytics-drilldown';

describe('analytics drill-down', () => {
  test('a link carries the scope keys the project lists read', () => {
    const href = drillDownHref('runs', 3, {
      period: 'last-30d',
      environments: 'staging',
      fullRunsOnly: 'false',
      projects: '3',
      tags: 'critical',
    });
    const url = new URL(href, 'http://x');
    expect(url.pathname).toBe('/projects/3');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tab: 'runs',
      period: 'last-30d',
      environments: 'staging',
      fullRunsOnly: 'false',
      source: 'analytics',
    });
  });

  test('a bucket narrows the period to its UTC days, and the clusters open on a status', () => {
    const url = new URL(
      drillDownHref('clusters', 1, { period: 'last-90d' }, { range: bucketRange('2026-09-07', 7), status: 'open' }),
      'http://x',
    );
    expect(url.searchParams.get('tab')).toBe('failure-clusters');
    expect(url.searchParams.get('period')).toBe('2026-09-07..2026-09-13');
    expect(url.searchParams.get('tz')).toBe('UTC');
    expect(url.searchParams.get('status')).toBe('open');
    expect(bucketRange('2026-02-01', 30)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(bucketRange('2026-02-01', 1)).toEqual({ from: '2026-02-01', to: '2026-02-01' });
  });

  test('tiles and buckets link only with one project in scope', () => {
    expect(singleProjectOf({ projects: '4' })).toBe(4);
    expect(singleProjectOf({ projects: '4,5' })).toBeNull();
    expect(singleProjectOf({})).toBeNull();
    expect(bucketDrill({ projects: '4,5' }, 1)).toBeNull();
    expect(bucketDrill({ projects: '4' }, 1)!('2026-09-01')).toContain('/projects/4?tab=runs');
    expect(metricDrillList('median-time-to-fix')).toBe('clusters');
    expect(metricDrillList('flaky-tests')).toBe('flaky');
  });

  test('a project list reads the address back, resolving the period', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const scope = parseDrillQuery(
      { source: 'analytics', period: '2026-09-07..2026-09-13', tz: 'UTC', environments: 'staging', status: 'open' },
      { now, timeZone: 'Europe/Paris' },
    )!;
    expect(scope.environments).toEqual(['staging']);
    expect(scope.defaultBranchOnly).toBe(true);
    expect(scope.fullRunsOnly).toBe(true);
    expect(scope.status).toBe('open');
    expect(new Date(scope.period!.from).toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(new Date(scope.period!.to).toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(parseDrillQuery({ period: 'last-7d' }, { now, timeZone: 'UTC' })).toBeNull();
    expect(
      parseDrillQuery({ source: 'analytics', allBranches: 'true' }, { now, timeZone: 'UTC' })!.defaultBranchOnly,
    ).toBe(false);
  });

  test('a drill-down stays the same drill-down when the page changes a tab, a list page or a search', () => {
    const drilled = { source: 'analytics', period: 'last-30d', environments: 'staging', tab: 'runs' };
    expect(drillQueryKey({ ...drilled, tab: 'tests', page: '2', q: 'checkout' })).toBe(drillQueryKey(drilled));
    expect(drillQueryKey({ ...drilled, period: 'last-7d' })).not.toBe(drillQueryKey(drilled));
    expect(drillQueryKey({ ...drilled, branches: 'develop' })).not.toBe(drillQueryKey(drilled));
    expect(drillQueryKey({ period: 'last-30d', tab: 'runs' })).toBeNull();
  });
});

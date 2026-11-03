import { describe, test, expect } from 'vitest';
import { analyticsScopeToQuery, parseAnalyticsScope } from '../../shared/analytics/scope';
import {
  DEFAULT_ANALYTICS_SCOPE_STATE,
  decodeScopeCookie,
  queryHasScope,
  scopeFromState,
  stateFromScope,
} from '../../shared/analytics/scope-state';

describe('the scope keeps reading today’s URL keys', () => {
  test('days, projects, environments, branches and fullRunsOnly', () => {
    const scope = parseAnalyticsScope(
      new URLSearchParams('days=90&projects=1,2&environments=staging&branches=main,release&fullRunsOnly=false'),
    );
    expect(scope).toMatchObject({
      period: { kind: 'rolling', days: 90 },
      projectIds: [1, 2],
      environments: ['staging'],
      branches: ['main', 'release'],
      defaultBranchOnly: false,
      fullRunsOnly: false,
    });
  });

  test('3650 days is All time, and period wins over days', () => {
    expect(parseAnalyticsScope({ days: '3650' }).period).toEqual({ kind: 'all' });
    expect(parseAnalyticsScope({ days: '7', period: 'last-month' }).period).toEqual({
      kind: 'calendar',
      unit: 'month',
      offset: 1,
    });
  });

  test('without branches the default-branch policy is on, and allBranches turns it off', () => {
    expect(parseAnalyticsScope({}).defaultBranchOnly).toBe(true);
    expect(parseAnalyticsScope({ allBranches: 'true' }).defaultBranchOnly).toBe(false);
  });
});

describe('the new keys', () => {
  test('parse and write back identically', () => {
    const query = {
      period: '2026-08-01..2026-08-31',
      compare: 'year',
      by: 'week',
      projects: '3',
      projectTags: 'payments',
      allBranches: 'true',
      sel: 'smoke',
      tags: 'critical,checkout',
      owner: 'team-a',
      priority: 'critical',
      q: 'login',
      quarantined: 'false',
      browsers: 'webkit',
    };
    const scope = parseAnalyticsScope(query);
    expect(scope).toMatchObject({
      period: { kind: 'range', from: '2026-08-01', to: '2026-08-31' },
      comparison: { kind: 'year' },
      granularity: 'week',
      projectTags: ['payments'],
      defaultBranchOnly: false,
      selection: 'smoke',
      tests: {
        tags: ['critical', 'checkout'],
        owner: ['team-a'],
        priority: ['critical'],
        text: 'login',
        quarantined: false,
      },
      browsers: ['webkit'],
    });
    expect(analyticsScopeToQuery(scope)).toEqual(query);
  });

  test('ignores a malformed selection key and unknown priorities, strips @ from tags', () => {
    const scope = parseAnalyticsScope({ sel: 'Not A Key!', priority: 'urgent', tags: '@smoke' });
    expect(scope.selection).toBeUndefined();
    expect(scope.tests).toEqual({ tags: ['smoke'] });
  });

  test('reads at most 100 file globs of at most 500 characters, dropping the rest', () => {
    const many = Array.from({ length: 120 }, (_, i) => `tests/${i}.spec.ts`);
    expect(parseAnalyticsScope({ files: many.join(',') }).tests).toEqual({ files: many.slice(0, 100) });
    const long = `tests/${'*'.repeat(495)}`;
    expect(parseAnalyticsScope({ files: `${long},a.spec.ts` }).tests).toEqual({ files: ['a.spec.ts'] });
    expect(parseAnalyticsScope({ files: long }).tests).toBeUndefined();
  });

  test('tz and locale travel with widget requests only', () => {
    const scope = parseAnalyticsScope({ tz: 'Europe/Paris', locale: 'fr-FR' });
    expect(scope.timeZone).toBe('Europe/Paris');
    expect(queryHasScope({ tz: 'Europe/Paris' })).toBe(false);
    expect(queryHasScope({ days: '7' })).toBe(true);
  });
});

describe('the piwi-analytics-scope cookie', () => {
  test('today’s cookie opens on the same scope', () => {
    const state = decodeScopeCookie(
      JSON.stringify({ days: 90, projectIds: [1, 2], environments: [], branches: [], fullRunsOnly: true }),
    );
    expect(state).toMatchObject({ period: 'last-90d', projectIds: [1, 2], fullRunsOnly: true, allBranches: false });
    const scope = scopeFromState(state);
    expect(scope).toMatchObject({ period: { kind: 'rolling', days: 90 }, projectIds: [1, 2], defaultBranchOnly: true });
  });

  test('a cookie that names branches keeps them, so the branch default never overrides them', () => {
    const scope = scopeFromState(
      decodeScopeCookie({
        days: 30,
        projectIds: [],
        environments: ['prod'],
        branches: ['develop'],
        fullRunsOnly: false,
      }),
    );
    expect(scope).toMatchObject({
      branches: ['develop'],
      defaultBranchOnly: false,
      environments: ['prod'],
      fullRunsOnly: false,
    });
  });

  test('a URI-encoded cookie decodes too', () => {
    const encoded = encodeURIComponent(JSON.stringify({ days: 7, projectIds: [3] }));
    expect(decodeScopeCookie(encoded)).toMatchObject({ period: 'last-7d', projectIds: [3] });
  });

  test('All time and garbage', () => {
    expect(decodeScopeCookie(JSON.stringify({ days: 3650 })).period).toBe('all');
    expect(decodeScopeCookie('not json')).toEqual(DEFAULT_ANALYTICS_SCOPE_STATE);
    expect(decodeScopeCookie(undefined)).toEqual(DEFAULT_ANALYTICS_SCOPE_STATE);
  });

  test('state and scope round-trip', () => {
    const scope = parseAnalyticsScope({
      period: 'release-1',
      compare: 'previous-unit',
      sel: 'smoke',
      browsers: 'firefox',
    });
    expect(scopeFromState(stateFromScope(scope))).toEqual(scope);
  });
});

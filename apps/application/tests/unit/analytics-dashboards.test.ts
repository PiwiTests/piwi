import { describe, expect, test } from 'vitest';
import {
  applyWidgetScope,
  BUILTIN_DASHBOARDS,
  OVERVIEW_DASHBOARD,
  resolveDashboard,
  UNAVAILABLE_WIDGET,
  type DashboardDefinition,
} from '#shared/analytics/dashboards';
import { ANALYTICS_BANDS, ANALYTICS_WIDGETS } from '#shared/analytics/registry';
import { DEFAULT_ANALYTICS_SCOPE } from '#shared/analytics/scope';

/** The ten widgets the analytics page showed before it became a dashboard, in band order. */
const LEGACY_WIDGETS = [
  'portfolio',
  'insights',
  'pass-rate-heatmap',
  'cluster-landscape',
  'flaky-leaderboard',
  'wasted-time',
  'regression-velocity',
  'ci-time-trend',
  'browser-matrix',
  'slow-endpoints',
];

describe('the Overview dashboard', () => {
  test('keeps the four bands with their titles and descriptions', () => {
    expect(OVERVIEW_DASHBOARD.bands.map((b) => [b.title, b.description])).toEqual(
      ANALYTICS_BANDS.map((b) => [b.label, b.description]),
    );
  });

  test('keeps the ten widgets in the same order, bands and widths, and adds the tiles, the trend, three trend widgets and the hand-back outcomes', () => {
    const placed = OVERVIEW_DASHBOARD.bands.flatMap((band, i) =>
      band.widgets.map((w) => ({ type: w.type, size: w.size, band: ANALYTICS_BANDS[i]!.id })),
    );
    const legacy = placed.filter((w) => LEGACY_WIDGETS.includes(w.type));
    expect(legacy.map((w) => w.type)).toEqual(LEGACY_WIDGETS);
    for (const w of legacy) {
      const meta = ANALYTICS_WIDGETS.find((m) => m.id === w.type)!;
      expect([w.size, w.band], w.type).toEqual([meta.size, meta.band]);
    }
    expect(placed.filter((w) => !LEGACY_WIDGETS.includes(w.type)).map((w) => w.type)).toEqual([
      'stats',
      'time-to-fix',
      'handbacks',
      'metric',
      'suite-growth',
      'flaky-debt',
    ]);
  });

  test('uses the analytics default scope', () => {
    expect(OVERVIEW_DASHBOARD.scope).toEqual(DEFAULT_ANALYTICS_SCOPE);
  });
});

describe('resolveDashboard', () => {
  test('every built-in dashboard resolves with every widget available', () => {
    for (const dashboard of BUILTIN_DASHBOARDS) {
      const widgets = resolveDashboard(dashboard.definition).flatMap((b) => b.widgets);
      expect(
        widgets.every((w) => w.available),
        dashboard.key,
      ).toBe(true);
      expect(new Set(widgets.map((w) => w.key)).size, `${dashboard.key} keys are unique`).toBe(widgets.length);
    }
  });

  test('no built-in dashboard repeats a section title as the title of a widget in it', () => {
    const repeated = BUILTIN_DASHBOARDS.flatMap((dashboard) =>
      resolveDashboard(dashboard.definition).flatMap((band) =>
        band.widgets.filter((w) => w.title === band.title).map((w) => `${dashboard.key}: ${band.title} / ${w.key}`),
      ),
    );
    expect(repeated).toEqual([]);
  });

  test('fills option defaults and the registry title', () => {
    const [band] = resolveDashboard({
      v: 1,
      scope: DEFAULT_ANALYTICS_SCOPE,
      bands: [{ title: 'A', widgets: [{ key: 'm', type: 'metric', size: 'full' }] }],
    });
    expect(band!.widgets[0]).toMatchObject({
      available: true,
      title: 'Metric',
      options: { metric: 'test-pass-rate', display: 'line', comparison: true, markers: true },
    });
  });

  test('a removed widget or refused options degrade to a notice', () => {
    const definition = {
      v: 1,
      scope: DEFAULT_ANALYTICS_SCOPE,
      bands: [
        {
          title: 'A',
          widgets: [
            { key: 'gone', type: 'no-such-widget', size: 'half' },
            { key: 'bad', type: 'metric', size: 'half', options: { metric: 'nope' } },
          ],
        },
      ],
    } as unknown as DashboardDefinition;
    const [gone, bad] = resolveDashboard(definition)[0]!.widgets;
    expect(gone).toMatchObject({ available: false, reason: UNAVAILABLE_WIDGET });
    expect(bad).toMatchObject({ available: false, title: 'Metric' });
  });
});

describe('applyWidgetScope', () => {
  const base = { ...DEFAULT_ANALYTICS_SCOPE, projectIds: [1, 2], environments: ['prod'] };

  test('replaces the period and narrows the filters, never widening them', () => {
    const scope = applyWidgetScope(base, {
      period: { kind: 'rolling', days: 7 },
      projectIds: [2, 3],
      browsers: ['webkit'],
      fullRunsOnly: false,
    });
    expect(scope.period).toEqual({ kind: 'rolling', days: 7 });
    expect(scope.projectIds).toEqual([2]);
    expect(scope.environments).toEqual(['prod']);
    expect(scope.browsers).toEqual(['webkit']);
    expect(scope.fullRunsOnly).toBe(true);
  });

  test('without an override the dashboard scope is used as is', () => {
    expect(applyWidgetScope(base, undefined)).toBe(base);
  });

  test('an environment list narrows picked environments or every environment, never the default environments', () => {
    const pinned = { environments: ['production'] };
    const byDefault = applyWidgetScope({ ...DEFAULT_ANALYTICS_SCOPE }, pinned);
    expect(byDefault.environments).toBeUndefined();
    expect(byDefault.allEnvironments).toBeUndefined();
    expect(applyWidgetScope({ ...DEFAULT_ANALYTICS_SCOPE, allEnvironments: true }, pinned).environments).toEqual([
      'production',
    ]);
    expect(applyWidgetScope({ ...base, environments: ['prod', 'production'] }, pinned).environments).toEqual([
      'production',
    ]);
    // Disjoint lists match nothing rather than every environment.
    expect(applyWidgetScope(base, pinned).environments).toEqual(['\u0000']);
  });
});

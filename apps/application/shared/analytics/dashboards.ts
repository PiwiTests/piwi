/**
 * Dashboards: named arrangements of widgets in bands, with a default scope.
 *
 * The analytics page renders the built-in Overview; a quality report renders
 * any dashboard as a document (`shared/reports/collect.ts`), and the
 * executive, engineering, team and gaps digest dashboards exist for that. Built-in dashboards are defined
 * here in code and can only be duplicated; saved dashboards reuse the same
 * definition shape.
 */
import { z } from 'zod';
import type { AnalyticsScope } from './scope';
import { analyticsScopeToQuery, DEFAULT_ANALYTICS_SCOPE, parseAnalyticsScope } from './scope';
import { encodePeriod, type PeriodSpec } from './period';
import {
  getAnalyticsWidget,
  isAnalyticsWidgetId,
  parseWidgetOptions,
  WidgetOptionsError,
  type AnalyticsWidgetId,
} from './registry';

export interface DashboardWidget {
  /** Stable inside the dashboard: URLs and edits address it. */
  key: string;
  /** An entry of the widget registry. */
  type: AnalyticsWidgetId;
  /** Replaces the registry title. */
  title?: string;
  size: 'full' | 'half';
  /** Checked against the widget's options schema. */
  options?: Record<string, unknown>;
  /** May replace the period; may only narrow the filters. */
  scope?: Partial<AnalyticsScope>;
}

export interface DashboardBand {
  title: string;
  description?: string;
  widgets: DashboardWidget[];
}

export interface DashboardDefinition {
  v: 1;
  /** Default filters, period, comparison and granularity. */
  scope: AnalyticsScope;
  bands: DashboardBand[];
}

export const OVERVIEW_DASHBOARD: DashboardDefinition = {
  v: 1,
  scope: {
    period: { kind: 'rolling', days: 30 },
    comparison: { kind: 'previous' },
    granularity: 'auto',
    defaultBranchOnly: true,
    fullRunsOnly: true,
  },
  bands: [
    {
      title: 'Where things stand',
      description: 'The state of every project right now.',
      widgets: [
        {
          key: 'headline',
          type: 'stats',
          size: 'full',
          options: {
            metrics: [
              'test-pass-rate',
              'run-success-rate',
              'flaky-tests',
              'wasted-ci-minutes',
              'open-failure-causes',
              'median-time-to-fix',
            ],
          },
        },
        { key: 'portfolio', type: 'portfolio', size: 'full' },
        { key: 'insights', type: 'insights', size: 'half' },
        { key: 'heatmap', type: 'pass-rate-heatmap', size: 'half' },
      ],
    },
    {
      title: 'Where the pain is',
      description: 'What is costing you the most time and attention.',
      widgets: [
        { key: 'clusters', type: 'cluster-landscape', size: 'half' },
        { key: 'flaky', type: 'flaky-leaderboard', size: 'half' },
        { key: 'wasted', type: 'wasted-time', size: 'half' },
        { key: 'time-to-fix', type: 'time-to-fix', size: 'half' },
        { key: 'handbacks', type: 'handbacks', size: 'full' },
      ],
    },
    {
      title: 'Which way it is going',
      description: 'Movement over the selected period.',
      widgets: [
        {
          key: 'pass-rate-trend',
          type: 'metric',
          size: 'full',
          title: 'Pass rate over time',
          options: { metric: 'test-pass-rate', display: 'line' },
        },
        { key: 'regressions', type: 'regression-velocity', size: 'half' },
        { key: 'ci-time', type: 'ci-time-trend', size: 'half' },
        { key: 'suite-growth', type: 'suite-growth', size: 'half' },
        { key: 'flaky-debt', type: 'flaky-debt', size: 'half' },
      ],
    },
    {
      title: 'Detail',
      description: 'Breakdowns to reach for once you know what you are chasing.',
      widgets: [
        { key: 'browsers', type: 'browser-matrix', size: 'half' },
        { key: 'endpoints', type: 'slow-endpoints', size: 'full' },
      ],
    },
  ],
};

/** The report's opening: the verdict, the six tiles, the trend, the changes, what is being done and the risks. */
const REPORT_SUMMARY_BANDS: DashboardBand[] = [
  {
    title: 'Where things stand',
    description: 'The state of the projects in scope, against the comparison period.',
    widgets: [
      { key: 'verdict', type: 'verdict', size: 'full' },
      {
        key: 'headline',
        type: 'stats',
        size: 'full',
        options: {
          metrics: [
            'test-pass-rate',
            'run-success-rate',
            'flaky-tests',
            'wasted-ci-minutes',
            'open-failure-causes',
            'suite-size',
          ],
          companions: { 'open-failure-causes': 'median-time-to-fix' },
        },
      },
    ],
  },
  {
    title: 'Which way it is going',
    description: 'Movement over the period.',
    widgets: [
      {
        key: 'trend',
        type: 'metric',
        size: 'full',
        title: 'Pass rate over time',
        options: { metric: 'test-pass-rate', display: 'line' },
      },
      { key: 'changes', type: 'insights', size: 'full', title: 'What changed' },
    ],
  },
  {
    title: 'What is being done',
    description: 'Fixes, triage and the risks still open.',
    widgets: [
      { key: 'progress', type: 'progress', size: 'half' },
      { key: 'risks', type: 'risks', size: 'half' },
    ],
  },
];

/** For stakeholders: plain words, no locators, no stack traces. */
export const EXECUTIVE_DASHBOARD: DashboardDefinition = {
  v: 1,
  scope: { ...OVERVIEW_DASHBOARD.scope },
  bands: REPORT_SUMMARY_BANDS,
};

/** For the team that owns the suite: the executive report, then the analytics page in reading order. */
export const ENGINEERING_DASHBOARD: DashboardDefinition = {
  v: 1,
  scope: { ...OVERVIEW_DASHBOARD.scope },
  bands: [
    ...REPORT_SUMMARY_BANDS,
    {
      title: 'Where the pain is',
      description: 'What is costing the most time and attention.',
      widgets: [
        { key: 'flaky', type: 'flaky-leaderboard', size: 'full' },
        { key: 'clusters', type: 'cluster-landscape', size: 'full' },
        { key: 'wasted', type: 'wasted-time', size: 'full' },
        { key: 'ownership', type: 'ownership', size: 'full' },
        { key: 'handbacks', type: 'handbacks', size: 'full' },
      ],
    },
    {
      title: 'Trends',
      description: 'Regressions, CI time, combined coverage and the tests that moved over the period.',
      widgets: [
        { key: 'regressions', type: 'regression-velocity', size: 'half' },
        { key: 'ci-time', type: 'ci-time-trend', size: 'half' },
        { key: 'coverage-trend', type: 'coverage-trend', size: 'full' },
        { key: 'movers', type: 'movers', size: 'full' },
      ],
    },
    {
      title: 'Detail',
      description: 'Environments, browsers and shared endpoints.',
      widgets: [
        { key: 'environments', type: 'environment-comparison', size: 'full' },
        { key: 'browsers', type: 'browser-matrix', size: 'full' },
        { key: 'endpoints', type: 'slow-endpoints', size: 'full' },
      ],
    },
    {
      title: 'Scenario gaps',
      description: 'What the tests do not reach yet, from the Test Map.',
      widgets: [{ key: 'gaps', type: 'scenario-gaps', size: 'full', title: 'Where the gaps stand' }],
    },
  ],
};

/**
 * The engineering dashboard for one team: the same widgets, and a schedule
 * sets the owner test filter, so each team receives the numbers of its own
 * tests.
 */
export const TEAM_DASHBOARD: DashboardDefinition = {
  v: 1,
  scope: { ...OVERVIEW_DASHBOARD.scope },
  bands: ENGINEERING_DASHBOARD.bands,
};

/** The Test Map's weekly digest: the top new gaps of each project, then where the gaps stand. */
export const GAPS_DIGEST_DASHBOARD: DashboardDefinition = {
  v: 1,
  scope: { ...OVERVIEW_DASHBOARD.scope, period: { kind: 'rolling', days: 7 } },
  bands: [
    {
      title: 'New scenario gaps',
      description: 'The top new gaps of each project in the period.',
      widgets: [{ key: 'new-gaps', type: 'new-gaps', size: 'full', title: 'Top new gaps by project' }],
    },
    {
      title: 'Where the gaps stand',
      description: 'Open gaps by class and by feature, and the gaps closed.',
      widgets: [{ key: 'gaps', type: 'scenario-gaps', size: 'full' }],
    },
  ],
};

export type BuiltinDashboardKey = 'overview' | 'executive' | 'engineering' | 'team' | 'gaps-digest';

export interface BuiltinDashboard {
  key: BuiltinDashboardKey;
  name: string;
  description: string;
  definition: DashboardDefinition;
  /**
   * What the dashboard needs from the scope: `owner`, an owner test filter (the
   * team dashboard); `test-map`, the Test Map active in a project of the scope.
   */
  requires?: 'owner' | 'test-map';
}

export const BUILTIN_DASHBOARDS: readonly BuiltinDashboard[] = [
  {
    key: 'overview',
    name: 'Overview',
    description: 'The analytics page: every widget, in its four bands.',
    definition: OVERVIEW_DASHBOARD,
  },
  {
    key: 'executive',
    name: 'Executive',
    description: 'For stakeholders: a verdict, six numbers, the trend, what is being done and the risks.',
    definition: EXECUTIVE_DASHBOARD,
  },
  {
    key: 'engineering',
    name: 'Engineering',
    description:
      'For the team that owns the suite: the executive report, then flaky tests, clusters, ownership, movers and detail.',
    definition: ENGINEERING_DASHBOARD,
  },
  {
    key: 'team',
    name: 'Team',
    description: 'The engineering dashboard for one team: only the tests an owner holds.',
    definition: TEAM_DASHBOARD,
    requires: 'owner',
  },
  {
    key: 'gaps-digest',
    name: 'Gaps digest',
    description: 'The Test Map’s weekly digest: the top new scenario gaps of each project, then where the gaps stand.',
    definition: GAPS_DIGEST_DASHBOARD,
    requires: 'test-map',
  },
];

/**
 * The built-in dashboards a scope can render: the team dashboard needs an
 * owner test filter, the gaps digest a Test Map that is not declined.
 */
export function offeredDashboards(opts: { hasOwner: boolean; testMapHidden: boolean }): BuiltinDashboard[] {
  return BUILTIN_DASHBOARDS.filter(
    (d) => (d.requires !== 'owner' || opts.hasOwner) && (d.requires !== 'test-map' || !opts.testMapHidden),
  );
}

export function isBuiltinDashboardKey(value: unknown): value is BuiltinDashboardKey {
  return typeof value === 'string' && BUILTIN_DASHBOARDS.some((d) => d.key === value);
}

export function getBuiltinDashboard(key: BuiltinDashboardKey): BuiltinDashboard {
  return BUILTIN_DASHBOARDS.find((d) => d.key === key)!;
}

// ── Validation ───────────────────────────────────────────────────────────────

/** A widget ready to render: title resolved, options checked and defaulted. */
export type ResolvedDashboardWidget =
  | {
      key: string;
      available: true;
      type: AnalyticsWidgetId;
      title: string;
      size: 'full' | 'half';
      options: Record<string, unknown>;
      scope?: Partial<AnalyticsScope>;
    }
  | { key: string; available: false; title: string; size: 'full' | 'half'; reason: string };

export interface ResolvedDashboardBand {
  title: string;
  description?: string;
  widgets: ResolvedDashboardWidget[];
}

export const UNAVAILABLE_WIDGET = 'This widget is no longer available.';

/**
 * Check a definition against the widget registry: every known widget gets its
 * registry title unless it has its own and its options defaulted; a widget a
 * later release removed, or with options its schema refuses, renders as a
 * notice instead of breaking the dashboard.
 */
export function resolveDashboard(definition: DashboardDefinition): ResolvedDashboardBand[] {
  return definition.bands.map((band) => ({
    title: band.title,
    ...(band.description ? { description: band.description } : {}),
    widgets: band.widgets.map((widget): ResolvedDashboardWidget => {
      const type = widget.type as unknown;
      if (!isAnalyticsWidgetId(type)) {
        return {
          key: widget.key,
          available: false,
          title: widget.title ?? 'Widget',
          size: widget.size,
          reason: UNAVAILABLE_WIDGET,
        };
      }
      const title = widget.title ?? getAnalyticsWidget(type).title;
      try {
        return {
          key: widget.key,
          available: true,
          type,
          title,
          size: widget.size,
          options: parseWidgetOptions(type, widget.options ?? {}),
          ...(widget.scope ? { scope: widget.scope } : {}),
        };
      } catch (error) {
        if (!(error instanceof WidgetOptionsError)) throw error;
        return { key: widget.key, available: false, title, size: widget.size, reason: error.message };
      }
    }),
  }));
}

/** A project id no project carries: a filter narrowed to nothing still filters. */
const NO_PROJECT = 0;
/** A value no environment, branch, tag or browser carries. */
const NO_VALUE = '\u0000';

function narrowList<T>(base: T[] | undefined, override: T[] | undefined, none: T): T[] | undefined {
  if (!override || override.length === 0) return base;
  if (!base || base.length === 0) return override;
  const both = base.filter((v) => override.includes(v));
  // Disjoint lists match nothing: an empty list would read as "no filter", which widens.
  return both.length > 0 ? both : [none];
}

/**
 * A widget's scope: its own period, comparison and granularity replace the
 * dashboard's; its filters only narrow (a list filter intersects, a test
 * filter applies when the dashboard has none), so what a dashboard covers can
 * be read off its scope bar.
 */
export function applyWidgetScope(base: AnalyticsScope, override: Partial<AnalyticsScope> | undefined): AnalyticsScope {
  if (!override) return base;
  const scope: AnalyticsScope = {
    ...base,
    period: override.period ?? base.period,
    comparison: override.comparison ?? base.comparison,
    granularity: override.granularity ?? base.granularity,
    defaultBranchOnly: base.defaultBranchOnly || override.defaultBranchOnly === true,
    fullRunsOnly: base.fullRunsOnly || override.fullRunsOnly === true,
  };
  if (override.projectIds) scope.projectIds = narrowList(base.projectIds, override.projectIds, NO_PROJECT);
  const lists = ['projectTags', 'environments', 'browsers'] as const;
  for (const key of lists) {
    const value = narrowList(base[key], override[key], NO_VALUE);
    if (value) scope[key] = value;
  }
  // A branch list narrows an explicit branch list or every branch, never the default-branch policy.
  const basePolicy = !base.branches?.length && base.defaultBranchOnly;
  if (override.branches?.length && !basePolicy) {
    scope.branches = narrowList(base.branches, override.branches, NO_VALUE);
    scope.defaultBranchOnly = false;
  }
  if (!base.selection && override.selection) scope.selection = override.selection;
  if (!base.tests && override.tests) scope.tests = override.tests;
  return scope;
}

/** The default scope of a dashboard, falling back to the analytics default. */
export function dashboardScope(definition: DashboardDefinition): AnalyticsScope {
  return { ...DEFAULT_ANALYTICS_SCOPE, ...definition.scope };
}

// ── Checking a definition from outside ───────────────────────────────────────

export class DashboardDefinitionError extends Error {}

/** The scope keys a dashboard stores; the viewer's time zone and locale are request context, never stored. */
const STORED_SCOPE_KEYS = [
  'period',
  'comparison',
  'granularity',
  'projectIds',
  'projectTags',
  'environments',
  'branches',
  'defaultBranchOnly',
  'fullRunsOnly',
  'selection',
  'tests',
  'browsers',
] as const satisfies readonly (keyof AnalyticsScope)[];

function roundTripScope(raw: Record<string, unknown>, where: string): AnalyticsScope {
  const known: Record<string, unknown> = {};
  for (const key of STORED_SCOPE_KEYS) if (raw[key] !== undefined) known[key] = raw[key];
  let parsed: AnalyticsScope;
  try {
    parsed = parseAnalyticsScope(analyticsScopeToQuery({ ...DEFAULT_ANALYTICS_SCOPE, ...known } as AnalyticsScope));
  } catch {
    throw new DashboardDefinitionError(`${where}: the scope is not valid`);
  }
  if (known.period !== undefined && encodePeriod(parsed.period) !== encodePeriod(known.period as PeriodSpec)) {
    throw new DashboardDefinitionError(`${where}: the period is not valid`);
  }
  delete parsed.timeZone;
  delete parsed.locale;
  return parsed;
}

function asRecord(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DashboardDefinitionError(`${where}: the scope must be an object`);
  }
  return raw as Record<string, unknown>;
}

/** A dashboard's default scope, checked, with the defaults filled in. */
export function normalizeDashboardScope(raw: unknown, where = 'Dashboard'): AnalyticsScope {
  return roundTripScope(asRecord(raw ?? {}, where), where);
}

/** A widget's scope override, checked: only the keys it sets are kept. */
export function normalizeScopeOverride(raw: unknown, where: string): Partial<AnalyticsScope> | undefined {
  if (raw == null) return undefined;
  const record = asRecord(raw, where);
  const parsed = roundTripScope(record, where);
  const out: Partial<AnalyticsScope> = {};
  for (const key of STORED_SCOPE_KEYS) {
    if (record[key] === undefined) continue;
    (out as Record<string, unknown>)[key] = parsed[key];
  }
  if (record.branches !== undefined) out.defaultBranchOnly = parsed.defaultBranchOnly;
  return Object.keys(out).length > 0 ? out : undefined;
}

export const DASHBOARD_LIMITS = { bands: 12, widgets: 40, name: 80, description: 280, title: 80 } as const;

const WIDGET_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const definitionShape = z.object({
  v: z.literal(1),
  scope: z.unknown().optional(),
  bands: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(DASHBOARD_LIMITS.title),
        description: z.string().trim().max(DASHBOARD_LIMITS.description).optional(),
        widgets: z.array(
          z.object({
            key: z.string().regex(WIDGET_KEY_PATTERN, 'lower-case letters, digits and dashes'),
            type: z.string(),
            title: z.string().trim().min(1).max(DASHBOARD_LIMITS.title).optional(),
            size: z.enum(['full', 'half']),
            options: z.record(z.string(), z.unknown()).optional(),
            scope: z.unknown().optional(),
          }),
        ),
      }),
    )
    .max(DASHBOARD_LIMITS.bands),
});

/** One widget from outside, checked against the registry and its options schema, defaults filled in. */
export function parseDashboardWidget(raw: unknown, where = 'Widget'): DashboardWidget {
  const shape = definitionShape.shape.bands.element.shape.widgets.element.safeParse(raw);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    throw new DashboardDefinitionError(`${where}: ${issue?.path.join('.') || 'widget'} ${issue?.message ?? ''}`.trim());
  }
  const widget = shape.data;
  if (!isAnalyticsWidgetId(widget.type)) {
    throw new DashboardDefinitionError(`${where}: unknown widget type '${widget.type}'`);
  }
  let options: Record<string, unknown>;
  try {
    options = parseWidgetOptions(widget.type, widget.options ?? {});
  } catch (error) {
    if (error instanceof WidgetOptionsError) throw new DashboardDefinitionError(`${where}: ${error.message}`);
    throw error;
  }
  const scope = normalizeScopeOverride(widget.scope, where);
  return {
    key: widget.key,
    type: widget.type,
    ...(widget.title ? { title: widget.title } : {}),
    size: widget.size,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(scope ? { scope } : {}),
  };
}

/**
 * A definition from outside (a save, an import), checked: the structure, the
 * scope, every widget against the registry and its options schema. Widget
 * keys are unique inside the dashboard. Throws `DashboardDefinitionError`.
 */
export function parseDashboardDefinition(raw: unknown): DashboardDefinition {
  const shape = definitionShape.safeParse(raw);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    throw new DashboardDefinitionError(
      `Invalid dashboard: ${issue?.path.join('.') || 'definition'} ${issue?.message ?? ''}`.trim(),
    );
  }
  const total = shape.data.bands.reduce((n, b) => n + b.widgets.length, 0);
  if (total > DASHBOARD_LIMITS.widgets) {
    throw new DashboardDefinitionError(`A dashboard holds at most ${DASHBOARD_LIMITS.widgets} widgets`);
  }
  const keys = new Set<string>();
  const bands = shape.data.bands.map((band, b) => ({
    title: band.title,
    ...(band.description ? { description: band.description } : {}),
    widgets: band.widgets.map((w, i) => {
      const widget = parseDashboardWidget(w, `Band ${b + 1}, widget ${i + 1}`);
      if (keys.has(widget.key)) throw new DashboardDefinitionError(`The widget key '${widget.key}' is used twice`);
      keys.add(widget.key);
      return widget;
    }),
  }));
  return { v: 1, scope: normalizeDashboardScope(shape.data.scope ?? {}), bands };
}

/** Every widget of a definition, in order. */
export function dashboardWidgets(definition: DashboardDefinition): DashboardWidget[] {
  return definition.bands.flatMap((b) => b.widgets);
}

/** A widget key not used in the definition yet, derived from the widget type. */
export function nextWidgetKey(definition: DashboardDefinition, type: string): string {
  const used = new Set(dashboardWidgets(definition).map((w) => w.key));
  const base = type.slice(0, 36);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

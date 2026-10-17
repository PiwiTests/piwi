/**
 * Single source of truth for every cross-project analytics widget.
 *
 * Each entry describes one widget: a data handler in `shared/handlers/analytics`
 * (keyed by `id`), a page component, and a mapping to the document blocks of
 * a quality report (`shared/reports/widget-documents.ts`). Dashboards
 * (`shared/analytics/dashboards.ts`) place widgets in bands; the generic
 * `GET /api/widgets/[widget]` route dispatches by `id`. Adding a widget
 * means: one entry here, one handler file, one component, one document
 * mapping. No routing changes on either the server or the demo mirror.
 *
 * `band` is the widget's home band: the band of the Overview dashboard it
 * belongs to, and the group it is listed under when a widget is picked.
 */
import { z } from 'zod';
import type { CapabilityId } from '#shared/capabilities';
import { DIMENSIONS, getMetric, METRICS, type DimensionId, type MetricId } from './metrics';

export type AnalyticsBandId = 'health' | 'pain' | 'trends' | 'detail';

export const ANALYTICS_BANDS: { id: AnalyticsBandId; label: string; description: string }[] = [
  { id: 'health', label: 'Where things stand', description: 'The state of every project right now.' },
  { id: 'pain', label: 'Where the pain is', description: 'What is costing you the most time and attention.' },
  { id: 'trends', label: 'Which way it is going', description: 'Movement over the selected period.' },
  { id: 'detail', label: 'Detail', description: 'Breakdowns to reach for once you know what you are chasing.' },
];

export interface AnalyticsWidgetMeta {
  id: string;
  /** Card title (sentence case). */
  title: string;
  /** One sentence on what the widget shows, for the widget picker. */
  description: string;
  /** Lucide icon for the card header. */
  icon: string;
  /** Layout hint: `full` spans the grid, `half` shares a row on wide screens. */
  size: 'full' | 'half';
  /** Which band the widget belongs to — decides where it renders. */
  band: AnalyticsBandId;
  /**
   * Whether the widget narrows to a test filter (a selection, test predicates,
   * browsers). One that cannot says so in its subtitle when a test filter is set.
   */
  testFilters: boolean;
  /** A widget that only makes sense for one project; unset for the cross-project widgets. */
  requires?: 'single-project';
  /**
   * The widget's options, checked and defaulted by this schema wherever a
   * dashboard places the widget. Unset: the widget takes no options.
   */
  options?: z.ZodType;
  /**
   * The capability the widget follows in each project of the scope: a project
   * that declined it is left out, and with none left the widget is not shown.
   */
  capability?: CapabilityId;
}

/**
 * The metrics a widget can show: the catalog minus the Test Map metrics, which
 * the scenario-gaps widget reads.
 */
export const WIDGET_METRIC_IDS = METRICS.filter((m) => m.grain !== 'gap').map((m) => m.id) as [MetricId, ...MetricId[]];

const metricIdSchema = z.enum(WIDGET_METRIC_IDS);

export const DEFAULT_STAT_METRICS: MetricId[] = [
  'test-pass-rate',
  'run-success-rate',
  'flaky-tests',
  'wasted-ci-minutes',
  'open-failure-causes',
  'median-time-to-fix',
];

export const statsOptionsSchema = z.object({
  metrics: z.array(metricIdSchema).min(1).max(8).default(DEFAULT_STAT_METRICS),
  /** A second metric shown under a tile, keyed by the tile's metric. */
  companions: z.partialRecord(metricIdSchema, metricIdSchema).default({}),
});

export const METRIC_DISPLAYS = ['stat', 'line', 'bar', 'table', 'heatmap'] as const;

const DIMENSION_IDS = DIMENSIONS.map((d) => d.id) as [DimensionId, ...DimensionId[]];

const RUN_BREAKDOWNS: DimensionId[] = ['project', 'project-tag', 'environment', 'branch', 'run-kind'];
const EXECUTION_BREAKDOWNS: DimensionId[] = [
  ...RUN_BREAKDOWNS,
  'browser',
  'test-tag',
  'owner',
  'priority',
  'feature',
  'spec-directory',
];
const CLUSTER_BREAKDOWNS: DimensionId[] = ['project', 'project-tag', 'error-type', 'cluster-status', 'assignee'];
const QUARANTINE_BREAKDOWNS: DimensionId[] = ['project', 'project-tag', 'owner', 'test-tag'];

/**
 * The breakdowns the metric widget can compute for a metric: the ones its
 * catalog entry lists that its source can cut (run and test dimensions for the
 * scalar metrics and flaky tests, cluster dimensions for the failure-cause
 * metrics, test owners and tags for the quarantine).
 */
export function metricBreakdowns(id: MetricId): DimensionId[] {
  const def = getMetric(id);
  if (def.grain === 'handback') return [];
  const supported =
    def.grain === 'cluster'
      ? CLUSTER_BREAKDOWNS
      : id === 'quarantine-debt'
        ? QUARANTINE_BREAKDOWNS
        : def.source === 'rollup' || id === 'flaky-tests'
          ? EXECUTION_BREAKDOWNS
          : [];
  return def.dimensions.filter((d) => supported.includes(d));
}

export const metricOptionsSchema = z.object({
  metric: metricIdSchema.default('test-pass-rate'),
  /** `stat` one number; `line` and `bar` over time, or one bar per group with a breakdown; `table`; `heatmap` groups by buckets. */
  display: z.enum(METRIC_DISPLAYS).default('line'),
  /** Cut the metric by a dimension of the catalog; the top groups are shown, the rest as *Other*. */
  breakdown: z.enum(DIMENSION_IDS).optional(),
  /** How many groups a breakdown shows before *Other*. */
  top: z.number().int().min(5).max(25).default(10),
  /** Draw the comparison period as a faint line, and show the change. */
  comparison: z.boolean().default(true),
  /** Draw the period's timeline markers on the line. */
  markers: z.boolean().default(true),
  /** Draw the project's target on the metric, with one project in scope that sets one. */
  target: z.boolean().default(true),
});

export const LIST_SOURCES = ['runs', 'failure-clusters', 'flaky-tests', 'scenario-gaps'] as const;

export const listOptionsSchema = z.object({
  /** What the list shows, matching the scope: runs, failure causes, flaky tests or scenario gaps. */
  source: z.enum(LIST_SOURCES).default('runs'),
  limit: z.number().int().min(5).max(25).default(10),
});

export const markersOptionsSchema = z.object({
  /** Marker categories to show; empty shows every category the period draws. */
  categories: z.array(z.string().max(40)).max(20).default([]),
});

export const TEXT_MAX_LENGTH = 10_000;

export const textOptionsSchema = z.object({
  /** A note in Markdown; raw HTML is escaped. */
  markdown: z.string().max(TEXT_MAX_LENGTH).default(''),
});

export const singleProjectOptionsSchema = z.object({
  limit: z.number().int().min(5).max(25).default(10),
});

export const ownershipOptionsSchema = z.object({
  /** How many owners the table lists before the *Unowned* row. */
  limit: z.number().int().min(5).max(25).default(10),
});

export const environmentComparisonOptionsSchema = z.object({
  /** How many environments are compared, the least healthy first. */
  limit: z.number().int().min(2).max(25).default(8),
});

/** The most tests a movers direction lists. */
export const MOVERS_MAX_ROWS = 25;

export const moversOptionsSchema = z.object({
  /** How many tests each direction lists (became flaky, stopped being flaky, slower, faster). */
  limit: z.number().int().min(5).max(MOVERS_MAX_ROWS).default(10),
});

export type StatsOptions = z.infer<typeof statsOptionsSchema>;
export type MetricOptions = z.infer<typeof metricOptionsSchema>;

export const ANALYTICS_WIDGETS = [
  {
    id: 'stats',
    title: 'Headline numbers',
    description: 'A row of numbers from the metric catalog, each with its change.',
    icon: 'i-lucide-gauge',
    size: 'full',
    band: 'health',
    testFilters: true,
    options: statsOptionsSchema,
  },
  {
    id: 'verdict',
    title: 'Verdict',
    description: 'One sentence on how things stand, built by rules from the numbers.',
    icon: 'i-lucide-scale',
    size: 'full',
    band: 'health',
    testFilters: true,
  },
  {
    id: 'narrative',
    title: 'Narrative',
    description:
      'Three paragraphs written by the configured AI model from the report’s numbers, in scheduled quality reports that turn it on; the rule-based verdict elsewhere.',
    icon: 'i-lucide-sparkles',
    size: 'full',
    band: 'health',
    testFilters: true,
  },
  {
    id: 'metric',
    title: 'Metric',
    description: 'One metric as a number, a line, bars, a table or a heatmap, optionally broken down.',
    icon: 'i-lucide-chart-spline',
    size: 'full',
    band: 'trends',
    testFilters: true,
    options: metricOptionsSchema,
  },
  {
    id: 'progress',
    title: 'Fixes and triage',
    description: 'Failure causes fixed, assigned and ticketed, quarantine releases, auto-heal pull requests.',
    icon: 'i-lucide-list-checks',
    size: 'half',
    band: 'pain',
    testFilters: false,
  },
  {
    id: 'handbacks',
    title: 'Hand-back outcomes',
    description:
      'What became of what Piwi handed back: locator heals, auto-heal pull requests, AI diagnoses, gate verdicts, verified flake fixes.',
    icon: 'i-lucide-undo-2',
    size: 'full',
    band: 'pain',
    testFilters: false,
  },
  {
    id: 'risks',
    title: 'Risks',
    description: 'Missed targets, metrics moving the wrong way, failing projects, old failure causes, quarantine debt.',
    icon: 'i-lucide-triangle-alert',
    size: 'half',
    band: 'pain',
    testFilters: false,
  },
  {
    id: 'portfolio',
    title: 'Portfolio health',
    description: 'Every project: pass rate and its change, flaky volume, open failure causes, latest run.',
    icon: 'i-lucide-table-properties',
    size: 'full',
    band: 'health',
    testFilters: true,
  },
  {
    id: 'insights',
    title: 'Insights',
    description: 'Findings over the period, ranked by severity.',
    icon: 'i-lucide-lightbulb',
    size: 'half',
    band: 'health',
    testFilters: true,
  },
  {
    id: 'pass-rate-heatmap',
    title: 'Pass rate heatmap',
    description: 'Pass rate per project and day.',
    icon: 'i-lucide-grid-3x3',
    size: 'half',
    band: 'health',
    testFilters: true,
  },
  {
    id: 'cluster-landscape',
    title: 'Failure clusters',
    description: 'The biggest and oldest open failure clusters.',
    icon: 'i-lucide-layers',
    size: 'half',
    band: 'pain',
    testFilters: false,
  },
  {
    id: 'flaky-leaderboard',
    title: 'Flakiest tests',
    description: 'The flakiest tests across projects, by wasted CI impact.',
    icon: 'i-lucide-repeat',
    size: 'half',
    band: 'pain',
    testFilters: true,
  },
  {
    id: 'wasted-time',
    title: 'Wasted CI time',
    description: 'Minutes spent in waits and in failed attempts, over time and per project.',
    icon: 'i-lucide-hourglass',
    size: 'half',
    band: 'pain',
    testFilters: true,
  },
  {
    id: 'regression-velocity',
    title: 'Regression velocity',
    description: 'New regressions and newly flaky tests per bucket.',
    icon: 'i-lucide-git-pull-request-arrow',
    size: 'half',
    band: 'trends',
    testFilters: true,
  },
  {
    id: 'ci-time-trend',
    title: 'CI time',
    description: 'Minutes of CI the runs consumed, over time.',
    icon: 'i-lucide-timer',
    size: 'half',
    band: 'trends',
    testFilters: true,
  },
  {
    id: 'browser-matrix',
    title: 'Browser matrix',
    description: 'Pass rate per project and browser.',
    icon: 'i-lucide-monitor-smartphone',
    size: 'half',
    band: 'detail',
    testFilters: true,
  },
  {
    id: 'slow-endpoints',
    title: 'Slow endpoints',
    description: 'Backend calls captured during tests, by latency.',
    icon: 'i-lucide-gauge',
    size: 'full',
    band: 'detail',
    testFilters: true,
  },
  {
    id: 'suite-growth',
    title: 'Suite growth',
    description: 'How many tests the suite has over time, and the share skipped or not run.',
    icon: 'i-lucide-sprout',
    size: 'half',
    band: 'trends',
    testFilters: true,
  },
  {
    id: 'coverage-trend',
    title: 'Coverage trend',
    description: 'The share of lines every suite ran together, unit and end-to-end, over time.',
    icon: 'i-lucide-scan-line',
    size: 'half',
    band: 'trends',
    testFilters: false,
    capability: 'coverage',
  },
  {
    id: 'flaky-debt',
    title: 'Flaky debt',
    description: 'Flaky occurrences per run, distinct flaky tests and the quarantine, over time.',
    icon: 'i-lucide-repeat-2',
    size: 'half',
    band: 'trends',
    testFilters: true,
  },
  {
    id: 'time-to-fix',
    title: 'Time to fix',
    description: 'Failure causes opened and fixed, the median time to fix, fixes that held, open causes by age.',
    icon: 'i-lucide-wrench',
    size: 'half',
    band: 'pain',
    testFilters: false,
  },
  {
    id: 'ownership',
    title: 'Ownership',
    description: 'One row per owner: open failure causes, flaky tests, wasted CI minutes, median time to fix.',
    icon: 'i-lucide-users',
    size: 'full',
    band: 'pain',
    testFilters: false,
    options: ownershipOptionsSchema,
  },
  {
    id: 'environment-comparison',
    title: 'Environment comparison',
    description: 'Pass rate and run success per environment, side by side and over time.',
    icon: 'i-lucide-server',
    size: 'full',
    band: 'detail',
    testFilters: true,
    options: environmentComparisonOptionsSchema,
  },
  {
    id: 'movers',
    title: 'Movers',
    description: 'Tests that became flaky, stopped being flaky, or got slower or faster by more than 25 %.',
    icon: 'i-lucide-arrow-up-down',
    size: 'full',
    band: 'detail',
    testFilters: true,
    options: moversOptionsSchema,
  },
  {
    id: 'scenario-gaps',
    title: 'Scenario gaps',
    description: 'Open Test Map gaps by class and feature, gaps closed, accepted but unwritten.',
    icon: 'i-lucide-map',
    size: 'full',
    band: 'detail',
    testFilters: false,
    capability: 'test-map',
  },
  {
    id: 'new-gaps',
    title: 'New scenario gaps',
    description: 'The top new scenario gaps of each project in the period.',
    icon: 'i-lucide-map-pin-plus',
    size: 'full',
    band: 'detail',
    testFilters: false,
    capability: 'test-map',
  },
  {
    id: 'list',
    title: 'List',
    description: 'The latest runs, open failure causes, flakiest tests or open scenario gaps.',
    icon: 'i-lucide-list',
    size: 'half',
    band: 'detail',
    testFilters: false,
    options: listOptionsSchema,
  },
  {
    id: 'markers',
    title: 'Timeline markers',
    description: 'The timeline markers of the period: releases, deploys, incidents.',
    icon: 'i-lucide-flag',
    size: 'half',
    band: 'trends',
    testFilters: false,
    options: markersOptionsSchema,
  },
  {
    id: 'text',
    title: 'Note',
    description: 'A note in Markdown.',
    icon: 'i-lucide-text',
    size: 'full',
    band: 'health',
    testFilters: false,
    options: textOptionsSchema,
  },
  {
    id: 'spec-health',
    title: 'Spec health',
    description: 'Pass and flaky rates per spec directory of one project.',
    icon: 'i-lucide-heart-pulse',
    size: 'full',
    band: 'detail',
    testFilters: false,
    requires: 'single-project',
    options: singleProjectOptionsSchema,
  },
  {
    id: 'slow-tests',
    title: 'Slowest tests',
    description: 'The slowest tests of one project’s recent runs.',
    icon: 'i-lucide-snail',
    size: 'half',
    band: 'detail',
    testFilters: false,
    requires: 'single-project',
    options: singleProjectOptionsSchema,
  },
  {
    id: 'performance-trend',
    title: 'Performance trend',
    description: 'Run and test durations of one project over the period.',
    icon: 'i-lucide-trending-up',
    size: 'full',
    band: 'trends',
    testFilters: false,
    requires: 'single-project',
  },
  {
    id: 'timeout-opportunities',
    title: 'Timeout opportunities',
    description: 'Tests whose timeout is far above their real duration, in one project.',
    icon: 'i-lucide-alarm-clock',
    size: 'full',
    band: 'detail',
    testFilters: false,
    requires: 'single-project',
    options: singleProjectOptionsSchema,
  },
  {
    id: 'selection-health',
    title: 'Selection health',
    description: 'How one project’s selections resolve, and the tests none selects.',
    icon: 'i-lucide-list-filter',
    size: 'full',
    band: 'detail',
    testFilters: false,
    requires: 'single-project',
  },
] as const satisfies readonly AnalyticsWidgetMeta[];

export type AnalyticsWidgetId = (typeof ANALYTICS_WIDGETS)[number]['id'];

const WIDGET_IDS = new Set<string>(ANALYTICS_WIDGETS.map((w) => w.id));

export function isAnalyticsWidgetId(value: unknown): value is AnalyticsWidgetId {
  return typeof value === 'string' && WIDGET_IDS.has(value);
}

const WIDGETS_BY_ID = new Map<string, AnalyticsWidgetMeta>(ANALYTICS_WIDGETS.map((w) => [w.id, w]));

export function getAnalyticsWidget(id: AnalyticsWidgetId): AnalyticsWidgetMeta {
  return WIDGETS_BY_ID.get(id)!;
}

export class WidgetOptionsError extends Error {}

/**
 * A widget's options, checked against its schema with the defaults filled in.
 * Throws `WidgetOptionsError` on options the schema refuses; a widget without
 * a schema takes none and gets `{}`.
 */
export function parseWidgetOptions(id: AnalyticsWidgetId, raw: unknown): Record<string, unknown> {
  const schema = getAnalyticsWidget(id).options;
  if (!schema) return {};
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new WidgetOptionsError(
      `Invalid options for ${id}: ${issue?.path.join('.') || 'options'} ${issue?.message ?? ''}`.trim(),
    );
  }
  return result.data as Record<string, unknown>;
}

/** Read the `options` query value (JSON) of a widget request; empty when absent. */
export function widgetOptionsFromQuery(raw: unknown): unknown {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new WidgetOptionsError('The options query value is not valid JSON');
  }
}

/**
 * Each widget's mapping from its data to document blocks: what a widget
 * becomes in a quality report. Keyed by the registry union, so registering a
 * widget without its mapping is a compile error, the way the handler map and
 * the page's component map are.
 */
import type { AnalyticsWidgetId } from '#shared/analytics/registry';
import type {
  AnalyticsBreakdownGroup,
  AnalyticsBrowserMatrix,
  AnalyticsCiTimeTrend,
  AnalyticsClusterLandscape,
  AnalyticsFlakyRow,
  AnalyticsHeatmap,
  AnalyticsInsight,
  AnalyticsMarker,
  AnalyticsMetricValue,
  AnalyticsMetricWidget,
  AnalyticsNewGaps,
  AnalyticsPortfolioRow,
  AnalyticsProgress,
  AnalyticsHandbacks,
  AnalyticsRegressionVelocity,
  AnalyticsRisks,
  AnalyticsScenarioGaps,
  AnalyticsSlowEndpoints,
  AnalyticsStats,
  AnalyticsSuiteGrowth,
  AnalyticsCoverageTrend,
  AnalyticsFlakyDebt,
  AnalyticsTimeToFix,
  AnalyticsOwnership,
  AnalyticsEnvironmentComparison,
  AnalyticsEnvironmentRow,
  AnalyticsMovers,
  AnalyticsTileTarget,
  AnalyticsVerdict,
  AnalyticsWastedTime,
  AnalyticsEvents,
  AnalyticsList,
  AnalyticsNote,
  AnalyticsProjectAnalysis,
} from '#shared/analytics/types';
import type { TimeoutOpportunity } from '#shared/analytics/timeout-hygiene';
import type { SelectionAnalytics } from '#shared/handlers/selection-analytics';
import type { PerformanceTrendData, SlowTestsData, SpecHealthData } from '#shared/handlers/analytics/project-analyses';
import type { MetricId, MetricUnit } from '#shared/analytics/metrics';
import { NONE_KEY } from '#shared/handlers/analytics/metric-breakdown';
import type { ValueFormatter } from './format';
import type { ReportSentences } from './sentences';
import type { ReportBlock, ReportCellValue, ReportRow, ReportSeries, ReportTile, ReportTone } from './types';

export interface DocumentContext {
  f: ValueFormatter;
  s: ReportSentences;
  /** Absolute base of the dashboard, for links; null leaves rows unlinked. */
  baseUrl: string | null;
  /** The period's timeline markers. */
  markers: AnalyticsMarker[];
  /** Whether trend widgets draw the markers. */
  drawMarkers: boolean;
}

/** A widget's blocks; none when the widget has nothing to show for the scope, and the report leaves it out. */
type Mapper = (data: any, ctx: DocumentContext, options: Record<string, unknown>) => ReportBlock[];

const TOP_ROWS = 10;
const HEATMAP_COLUMNS = 8;

function link(ctx: DocumentContext, path: string | null | undefined): string | null {
  return ctx.baseUrl && path ? `${ctx.baseUrl}${path}` : null;
}

/** A table cell: its text in the report language and, for a number or a day, the value a spreadsheet keeps. */
interface Cell {
  text: string;
  value: ReportCellValue | null;
}

/** A number in its unit, formatted as `ctx.f.value` writes it. */
function num(
  ctx: DocumentContext,
  value: number | null,
  unit: MetricUnit,
  precision = 0,
  currency?: string | null,
): Cell {
  return {
    text: ctx.f.value(value, unit, precision, currency),
    value:
      value === null || !Number.isFinite(value)
        ? null
        : { number: value, unit, precision, ...(currency ? { currency } : {}) },
  };
}

function metricCell(ctx: DocumentContext, v: AnalyticsMetricValue): Cell {
  return num(ctx, v.value, v.unit, v.precision, v.currency);
}

/** A metric's change, formatted as `ctx.f.delta` writes it; `empty` without one. */
function deltaCell(
  ctx: DocumentContext,
  metric: Pick<AnalyticsMetricValue, 'unit' | 'delta' | 'deltaPct' | 'precision'>,
  empty: string,
): Cell {
  const text = ctx.f.delta(metric) ?? empty;
  if (metric.delta === null) return { text, value: null };
  if (metric.unit === 'percent') return { text, value: { number: metric.delta, unit: 'points', precision: 1 } };
  if (metric.deltaPct !== null) return { text, value: { number: metric.deltaPct, unit: 'change', precision: 0 } };
  return { text, value: { number: metric.delta, unit: 'count', precision: metric.precision } };
}

/** A day (`YYYY-MM-DD` or an instant, read in UTC) shown as `text`. */
function dayCell(date: string, text: string): Cell {
  return {
    text,
    value: { date: new Date(date.length === 10 ? `${date}T12:00:00Z` : date).toISOString().slice(0, 10) },
  };
}

/** A table row: the cells' text, and the values of those that carry one. */
function row(cells: Record<string, string | Cell>, link?: string | null): ReportRow {
  const out: ReportRow = { cells: {} };
  const values: Record<string, ReportCellValue> = {};
  for (const [key, cell] of Object.entries(cells)) {
    if (typeof cell === 'string') {
      out.cells[key] = cell;
    } else {
      out.cells[key] = cell.text;
      if (cell.value) values[key] = cell.value;
    }
  }
  if (Object.keys(values).length > 0) out.values = values;
  if (link !== undefined) out.link = link;
  return out;
}

function toneOf(trend: AnalyticsMetricValue['trend']): ReportTone {
  return trend === 'better' ? 'good' : trend === 'worse' ? 'bad' : 'neutral';
}

function metricText(v: AnalyticsMetricValue, ctx: DocumentContext): string {
  return ctx.f.value(v.value, v.unit, v.precision, v.currency);
}

function tile(
  v: AnalyticsMetricValue,
  ctx: DocumentContext,
  companion?: AnalyticsMetricValue | null,
  target?: AnalyticsTileTarget | null,
): ReportTile {
  const label = ctx.s.metricLabel(v.metric, v.label);
  const notes: string[] = [];
  if (companion) {
    const value = metricText(companion, ctx);
    notes.push(
      companion.unit === 'money'
        ? value
        : `${ctx.s.metricLabel(companion.metric, companion.label)}${ctx.s.colon}${value}`,
    );
  }
  if (target) {
    const value = target.target === null ? null : ctx.f.value(target.target, v.unit, v.precision, v.currency);
    notes.push(ctx.s.tileTarget(target, value));
  }
  const note = notes.length > 0 ? notes.join(' · ') : null;
  return {
    metric: v.metric,
    label,
    value: metricText(v, ctx),
    change: ctx.f.delta(v),
    tone: toneOf(v.trend),
    note,
    definition: ctx.s.metricDefinition(v.metric, v.definition),
  };
}

/** A marker's label; across several projects it leads with the project, joined as the report's language joins them. */
function markerLabel(m: AnalyticsMarker, ctx: DocumentContext): string {
  return m.ownLabel !== undefined && m.label !== m.ownLabel && m.projectName
    ? `${m.projectName}${ctx.s.colon}${m.ownLabel}`
    : m.label;
}

function markersOf(ctx: DocumentContext): Array<{ date: string; label: string }> {
  if (!ctx.drawMarkers) return [];
  return ctx.markers.map((m) => ({
    date: new Date(m.occurredAt).toISOString().slice(0, 10),
    label: markerLabel(m, ctx),
  }));
}

/** Each suite's or area's line in the coverage trend, after the accent of every suite together. */
const SUITE_SERIES_COLORS = ['#e69f00', '#009e73', '#d55e00', '#cc79a7', '#56b4e9'];

function seriesBlock(
  unit: string,
  max: number | null,
  series: ReportSeries[],
  format: (value: number | null) => string,
  ctx: DocumentContext,
  summary: string | null,
): ReportBlock {
  return {
    kind: 'series',
    unit,
    max,
    series: series.map((s) => ({ ...s, formatted: s.points.map((p) => format(p.value)) })),
    markers: markersOf(ctx),
    summary,
  };
}

function name(row: { name?: string; label?: string | null; projectName?: string; projectLabel?: string | null }) {
  return row.label || row.projectLabel || row.name || row.projectName || '';
}

/**
 * A breakdown group's label in the report language: the groups Piwi names
 * (*Other*, no owner, full runs…) are translated, the names from the data kept.
 */
function groupLabel(g: AnalyticsBreakdownGroup, dimension: string, ctx: DocumentContext): string {
  if (g.other) return g.rest === undefined ? g.label : `${ctx.s.title('Other')} (${ctx.f.number(g.rest)})`;
  return g.key === NONE_KEY || dimension === 'run-kind' || dimension === 'cluster-status'
    ? ctx.s.title(g.label)
    : g.label;
}

/** A single-project analysis answers nothing outside one project, and the report leaves it out. */
function analysed<T>(data: AnalyticsProjectAnalysis<T>, map: (value: T) => ReportBlock[]): ReportBlock[] {
  return data.project ? map(data.data) : [];
}

export const WIDGET_DOCUMENTS: Record<AnalyticsWidgetId, Mapper> = {
  list: (data: AnalyticsList, ctx) =>
    data.items.length === 0
      ? []
      : [
          {
            kind: 'table',
            columns: [
              { key: 'title', label: ctx.s.title('Name') },
              { key: 'project', label: ctx.s.labels.projects },
              { key: 'detail', label: ctx.s.title('Detail') },
            ],
            rows: data.items.map((item) => ({
              cells: { ...ctx.s.listItem(item, ctx.f), project: item.projectName },
              link: link(ctx, item.href),
            })),
          },
        ],

  markers: (data: AnalyticsEvents, ctx) =>
    data.markers.length === 0
      ? []
      : [
          {
            kind: 'list',
            items: data.markers.map((m) => ({
              text: `${ctx.f.date(new Date(m.occurredAt).toISOString())} · ${markerLabel(m, ctx)}`,
              detail: m.description,
            })),
          },
        ],

  text: (data: AnalyticsNote) => (data.markdown.trim() ? [{ kind: 'text', text: data.markdown }] : []),

  'spec-health': (data: AnalyticsProjectAnalysis<SpecHealthData>, ctx) =>
    analysed(data, (health) => [
      {
        kind: 'table',
        columns: [
          { key: 'spec', label: ctx.s.title('Spec directory') },
          { key: 'pass', label: ctx.s.metricLabel('test-pass-rate', 'Test pass rate'), align: 'right' },
          { key: 'flaky', label: ctx.s.title('Flaky'), align: 'right' },
          { key: 'tests', label: '#', align: 'right' },
        ],
        rows: health.specs.map((spec) =>
          row({
            spec: spec.prefix,
            pass: num(ctx, spec.passRate * 100, 'percent', 0),
            flaky: num(ctx, spec.flakyRate * 100, 'percent', 0),
            tests: num(ctx, spec.testCount, 'count'),
          }),
        ),
      },
    ]),

  'slow-tests': (data: AnalyticsProjectAnalysis<SlowTestsData>, ctx) =>
    analysed(data, (tests) => [
      {
        kind: 'table',
        columns: [
          { key: 'title', label: ctx.s.title('Test') },
          { key: 'avg', label: ctx.s.title('Average'), align: 'right' },
        ],
        rows: tests.map((t) =>
          row({ title: t.title, avg: num(ctx, t.avgDuration, 'ms', 0) }, link(ctx, `/test-cases/${t.id}`)),
        ),
      },
    ]),

  'performance-trend': (data: AnalyticsProjectAnalysis<PerformanceTrendData>, ctx) =>
    analysed(data, (runs) =>
      runs.length === 0
        ? []
        : [
            seriesBlock(
              'ms',
              null,
              [
                {
                  label: ctx.s.metricLabel('average-run-duration', 'Run duration'),
                  points: runs.map((r) => ({
                    date: new Date(r.startTime).toISOString().slice(0, 10),
                    value: r.duration ?? null,
                  })),
                  color: 'accent',
                },
              ],
              (value) => ctx.f.value(value, 'ms', 0),
              ctx,
              null,
            ),
          ],
    ),

  'timeout-opportunities': (data: AnalyticsProjectAnalysis<TimeoutOpportunity[]>, ctx) =>
    analysed(data, (rows) =>
      rows.length === 0
        ? []
        : [
            {
              kind: 'table',
              columns: [
                { key: 'title', label: ctx.s.title('Test') },
                { key: 'timeout', label: ctx.s.title('Timeout'), align: 'right' },
                { key: 'p95', label: 'p95', align: 'right' },
                { key: 'recommended', label: ctx.s.title('Suggested'), align: 'right' },
              ],
              rows: rows.map((r) =>
                row({
                  title: r.title,
                  timeout: num(ctx, r.timeout, 'ms', 0),
                  p95: num(ctx, r.p95, 'ms', 0),
                  recommended: num(ctx, r.recommendedTimeout, 'ms', 0),
                }),
              ),
            },
          ],
    ),

  'selection-health': (data: AnalyticsProjectAnalysis<SelectionAnalytics>, ctx) =>
    analysed(data, (health) => [
      {
        kind: 'table',
        columns: [
          { key: 'name', label: ctx.s.title('Selection') },
          { key: 'tests', label: '#', align: 'right' },
          { key: 'warnings', label: ctx.s.title('Warnings'), align: 'right' },
        ],
        rows: health.selections.map((sel) =>
          row({
            name: `${sel.name} (${sel.key})`,
            tests: num(ctx, sel.resolvedCount, 'count'),
            warnings: num(ctx, sel.warnings.length, 'count'),
          }),
        ),
      },
    ]),

  stats: (data: AnalyticsStats, ctx) => [
    { kind: 'stats', tiles: data.tiles.map((t) => tile(t, ctx, t.companion, t.target)) },
  ],

  verdict: (data: AnalyticsVerdict, ctx) => [{ kind: 'text', text: ctx.s.verdict(data.facts, ctx.f), tone: data.tone }],
  // The rule-based verdict; a schedule that turns the narrative on replaces it (`applyNarrative`).
  narrative: (data: AnalyticsVerdict, ctx) => [
    { kind: 'text', text: ctx.s.verdict(data.facts, ctx.f), tone: data.tone },
  ],

  metric: (data: AnalyticsMetricWidget, ctx, options) => {
    const v = data.value;
    if (data.display === 'stat') return [{ kind: 'stats', tiles: [tile(v, ctx)] }];
    const label = ctx.s.metricLabel(v.metric, v.label);
    const format = (value: number | null) => ctx.f.value(value, v.unit, v.precision, v.currency);
    if (data.breakdown) {
      const blocks: ReportBlock[] = [];
      const lines = data.breakdown.groups.filter((g) => g.points && !g.other);
      if (data.display === 'line' && lines.length > 0) {
        blocks.push(
          seriesBlock(
            v.unit,
            v.unit === 'percent' ? 100 : null,
            lines.map((g) => ({ label: groupLabel(g, data.breakdown!.dimension, ctx), points: g.points! })),
            format,
            { ...ctx, drawMarkers: ctx.drawMarkers && options.markers !== false },
            null,
          ),
        );
      }
      blocks.push({
        kind: 'table',
        columns: [
          { key: 'group', label: ctx.s.title(data.breakdown.label) },
          { key: 'value', label, align: 'right' },
          { key: 'change', label: ctx.s.title('Change'), align: 'right' },
        ],
        rows: data.breakdown.groups.map((g) =>
          row({
            group: groupLabel(g, data.breakdown!.dimension, ctx),
            value: metricCell(ctx, g.value),
            change: deltaCell(ctx, g.value, ''),
          }),
        ),
      });
      return blocks;
    }
    if (data.display === 'table') {
      return [
        {
          kind: 'table',
          columns: [
            { key: 'date', label: ctx.s.title('Date') },
            { key: 'value', label, align: 'right' },
          ],
          rows: data.points.map((p) =>
            row({
              date: dayCell(p.date, ctx.f.day(p.date)),
              value: num(ctx, p.value, v.unit, v.precision, v.currency),
            }),
          ),
        },
      ];
    }
    const series: ReportSeries[] = [{ label, points: data.points, color: 'accent' }];
    if (data.previousPoints?.some((p) => p.value !== null)) {
      series.push({ label: data.comparisonLabel ?? ctx.s.labels.previous, points: data.previousPoints, faint: true });
    }
    const change = ctx.f.delta(v);
    return [
      seriesBlock(
        v.unit,
        v.unit === 'percent' ? 100 : null,
        series,
        (value) => ctx.f.value(value, v.unit, v.precision, v.currency),
        { ...ctx, drawMarkers: ctx.drawMarkers && options.markers !== false },
        `${label}${ctx.s.colon}${metricText(v, ctx)}${change ? ` (${change})` : ''}`,
      ),
    ];
  },

  progress: (data: AnalyticsProgress, ctx) => {
    const blocks: ReportBlock[] = [{ kind: 'list', items: ctx.s.progress(data, ctx.f).map((text) => ({ text })) }];
    if (data.recentFixes.length > 0) {
      blocks.push({
        kind: 'table',
        columns: [
          { key: 'cause', label: ctx.s.title('Failure cause') },
          { key: 'project', label: ctx.s.labels.projects },
          { key: 'fixed', label: ctx.s.labels.date, align: 'right' },
        ],
        rows: data.recentFixes.map((fix) =>
          row(
            { cause: fix.title, project: fix.projectName, fixed: dayCell(fix.fixedAt, ctx.f.date(fix.fixedAt)) },
            link(ctx, `/failure-clusters/${fix.id}`),
          ),
        ),
      });
    }
    return blocks;
  },

  handbacks: (data: AnalyticsHandbacks, ctx) => {
    const lines = ctx.s.handbacks(data, ctx.f);
    if (lines.length === 0) return [{ kind: 'text', text: ctx.s.labels.noData }];
    return [{ kind: 'list', items: lines.map((line) => ({ text: `${line.label}${ctx.s.colon}${line.text}` })) }];
  },

  risks: (data: AnalyticsRisks, ctx) => {
    const lines = ctx.s.risks(data, ctx.f);
    if (lines.length === 0) return [{ kind: 'text', text: ctx.s.labels.noData }];
    return [{ kind: 'list', items: lines.map((text) => ({ text, tone: 'bad' as const })) }];
  },

  insights: (data: AnalyticsInsight[], ctx) => {
    if (data.length === 0) return [{ kind: 'text', text: ctx.s.labels.noData }];
    return [
      {
        kind: 'list',
        items: data.map((i) => {
          // Written again from the rule's facts in the report language; the English sentences otherwise.
          const text = i.facts ? ctx.s.insight(i.facts, ctx.f) : { message: i.message, detail: i.detail };
          return {
            text: text.message,
            detail: text.detail ?? null,
            tone: i.severity === 'positive' ? 'good' : i.severity === 'info' ? 'neutral' : 'bad',
            link: link(ctx, i.to),
          };
        }),
      },
    ];
  },

  portfolio: (data: AnalyticsPortfolioRow[], ctx) => [
    {
      kind: 'table',
      columns: [
        { key: 'project', label: ctx.s.labels.projects },
        { key: 'passRate', label: ctx.s.metricLabel('test-pass-rate', 'Test pass rate'), align: 'right' },
        { key: 'change', label: ctx.s.labels.change, align: 'right' },
        { key: 'runs', label: ctx.s.metricLabel('runs', 'Runs'), align: 'right' },
        { key: 'flaky', label: ctx.s.metricLabel('flaky-occurrences', 'Flaky occurrences'), align: 'right' },
        { key: 'open', label: ctx.s.metricLabel('open-failure-causes', 'Open failure causes'), align: 'right' },
        ...(data.some((row) => row.targets?.length)
          ? [{ key: 'targets', label: ctx.s.labels.targets, align: 'right' as const }]
          : []),
      ],
      rows: data.map((p) =>
        row(
          {
            project: name(p),
            passRate: num(ctx, p.passRate, 'percent', 1),
            change: deltaCell(ctx, { unit: 'percent', delta: p.passRateDelta, deltaPct: null, precision: 1 }, '—'),
            runs: num(ctx, p.runCount, 'count'),
            flaky: num(ctx, p.flakyTests, 'count'),
            open: num(ctx, p.openClusters, 'count'),
            targets: targetCount(p.targets ?? [], ctx),
          },
          link(ctx, `/projects/${p.projectId}`),
        ),
      ),
    },
  ],

  'pass-rate-heatmap': (data: AnalyticsHeatmap, ctx) => {
    const start = Math.max(0, data.buckets.length - HEATMAP_COLUMNS);
    const buckets = data.buckets.slice(start);
    return [
      {
        kind: 'table',
        columns: [
          { key: 'project', label: ctx.s.labels.projects },
          ...buckets.map((b, i) => ({ key: `b${i}`, label: ctx.f.date(b), align: 'right' as const })),
        ],
        rows: data.rows.map((r) =>
          row({
            project: name(r),
            ...Object.fromEntries(r.cells.slice(start).map((cell, i) => [`b${i}`, num(ctx, cell, 'percent', 0)])),
          }),
        ),
      },
    ];
  },

  'cluster-landscape': (data: AnalyticsClusterLandscape, ctx) => [
    {
      kind: 'stats',
      tiles: [
        plainTile(ctx.s.metricLabel('open-failure-causes', 'Open failure causes'), ctx.f.number(data.totalOpen)),
        plainTile(
          ctx.s.metricLabel('failure-causes-fixed', 'Failure causes fixed'),
          ctx.f.number(data.resolvedInPeriod),
        ),
      ],
    },
    {
      kind: 'table',
      columns: [
        { key: 'cause', label: ctx.s.title('Failure cause') },
        { key: 'project', label: ctx.s.labels.projects },
        { key: 'occurrences', label: '#', align: 'right' },
        { key: 'age', label: ctx.s.title('Age'), align: 'right' },
      ],
      rows: data.clusters.slice(0, TOP_ROWS).map((c) =>
        row(
          {
            cause: c.title || c.signature,
            project: name(c),
            occurrences: num(ctx, c.occurrences, 'count'),
            age: num(ctx, c.ageDays, 'days', 0),
          },
          link(ctx, `/failure-clusters/${c.id}`),
        ),
      ),
    },
  ],

  'flaky-leaderboard': (data: AnalyticsFlakyRow[], ctx) => [
    {
      kind: 'table',
      columns: [
        { key: 'test', label: ctx.s.labels.testFilter },
        { key: 'project', label: ctx.s.labels.projects },
        { key: 'flips', label: ctx.s.title('Status flips'), align: 'right' },
        { key: 'wasted', label: ctx.s.metricLabel('wasted-ci-minutes', 'Wasted CI minutes'), align: 'right' },
      ],
      rows: data.slice(0, TOP_ROWS).map((t) =>
        row(
          {
            test: t.title,
            project: name(t),
            flips: `${ctx.f.number(t.alternations)} / ${ctx.f.number(t.totalRuns)}`,
            wasted: num(ctx, t.wastedCiMinutes, 'minutes'),
          },
          link(ctx, `/test-cases/${t.testCaseId}`),
        ),
      ),
    },
  ],

  'wasted-time': (data: AnalyticsWastedTime, ctx) => {
    const total = data.totalWaitMinutes + data.totalFailedExecMinutes;
    const cost = data.cost ? ` (${ctx.f.value(data.cost.amount, 'money', 2, data.cost.currency)})` : '';
    const blocks: ReportBlock[] = [
      seriesBlock(
        'minutes',
        null,
        [
          {
            label: ctx.s.title('Wait steps'),
            points: data.points.map((p) => ({ date: p.date, value: p.waitMinutes })),
            color: 'didnotrun',
          },
          {
            label: ctx.s.title('Failed attempts'),
            points: data.points.map((p) => ({ date: p.date, value: p.failedExecMinutes })),
            color: 'failed',
          },
        ],
        (value) => (value === null ? '—' : ctx.f.minutes(value)),
        { ...ctx, drawMarkers: false },
        `${ctx.s.metricLabel('wasted-ci-minutes', 'Wasted CI minutes')}${ctx.s.colon}${ctx.f.minutes(total)}${cost}`,
      ),
    ];
    if (data.byProject.length > 0) {
      blocks.push({
        kind: 'table',
        columns: [
          { key: 'project', label: ctx.s.labels.projects },
          { key: 'wasted', label: ctx.s.metricLabel('wasted-ci-minutes', 'Wasted CI minutes'), align: 'right' },
        ],
        rows: data.byProject.map((p) =>
          row(
            { project: name(p), wasted: num(ctx, p.waitMinutes + p.failedExecMinutes, 'minutes') },
            link(ctx, `/projects/${p.projectId}`),
          ),
        ),
      });
    }
    return blocks;
  },

  'regression-velocity': (data: AnalyticsRegressionVelocity, ctx) => [
    seriesBlock(
      'count',
      null,
      [
        {
          label: ctx.s.metricLabel('new-regressions', 'New regressions'),
          points: data.points.map((p) => ({ date: p.date, value: p.regressions })),
          color: 'failed',
        },
        {
          label: ctx.s.metricLabel('newly-flaky', 'Newly flaky'),
          points: data.points.map((p) => ({ date: p.date, value: p.newFlaky })),
          color: 'flaky',
        },
      ],
      (value) => (value === null ? '—' : ctx.f.number(value)),
      ctx,
      `${ctx.s.metricLabel('new-regressions', 'New regressions')}${ctx.s.colon}${ctx.f.number(data.totalRegressions)}, ${ctx.s.metricLabel('newly-flaky', 'Newly flaky')}${ctx.s.colon}${ctx.f.number(data.totalNewFlaky)}`,
    ),
  ],

  'ci-time-trend': (data: AnalyticsCiTimeTrend, ctx) => [
    seriesBlock(
      'minutes',
      null,
      [
        {
          label: ctx.s.metricLabel('ci-time', 'CI time'),
          points: data.points.map((p) => ({ date: p.date, value: p.totalMinutes })),
          color: 'running',
        },
      ],
      (value) => (value === null ? '—' : ctx.f.minutes(value)),
      ctx,
      `${ctx.s.metricLabel('ci-time', 'CI time')}${ctx.s.colon}${ctx.f.minutes(data.totalMinutes)}, ${ctx.f.number(data.runCount)} ${ctx.s.metricLabel('runs', 'Runs').toLowerCase()}`,
    ),
  ],

  'browser-matrix': (data: AnalyticsBrowserMatrix, ctx) => [
    {
      kind: 'table',
      columns: [
        { key: 'project', label: ctx.s.labels.projects },
        ...data.browsers.map((b, i) => ({
          key: `b${i}`,
          // Executions without a browser name are counted under `unknown`.
          label: b === 'unknown' ? ctx.s.title('Unknown browser') : b,
          align: 'right' as const,
        })),
      ],
      rows: data.rows.map((r) =>
        row({
          project: name(r),
          ...Object.fromEntries(r.cells.map((cell, i) => [`b${i}`, num(ctx, cell, 'percent', 0)])),
        }),
      ),
    },
  ],

  'slow-endpoints': (data: AnalyticsSlowEndpoints, ctx) => [
    {
      kind: 'table',
      columns: [
        { key: 'route', label: ctx.s.title('Endpoint') },
        { key: 'p90', label: 'p90', align: 'right' },
        { key: 'requests', label: '#', align: 'right' },
        { key: 'errors', label: ctx.s.title('Errors'), align: 'right' },
      ],
      rows: data.endpoints.slice(0, TOP_ROWS).map((e) =>
        row({
          route: `${e.method} ${e.route}`,
          p90: num(ctx, e.p90Ms, 'ms', 0),
          requests: num(ctx, e.requests, 'count'),
          errors: num(ctx, e.errorRate, 'percent', 1),
        }),
      ),
    },
  ],

  'suite-growth': (data: AnalyticsSuiteGrowth, ctx) => {
    if (data.suiteSize === null) return [{ kind: 'text', text: ctx.s.labels.noData }];
    const size = ctx.s.metricLabel('suite-size', 'Suite size');
    const delta = data.delta === null ? '' : ` (${data.delta > 0 ? '+' : ''}${ctx.f.number(data.delta)})`;
    return [
      seriesBlock(
        'count',
        null,
        [{ label: size, points: data.points.map((p) => ({ date: p.date, value: p.suiteSize })), color: 'accent' }],
        (value) => (value === null ? '—' : ctx.f.number(value)),
        ctx,
        `${size}${ctx.s.colon}${ctx.f.number(data.suiteSize)}${delta}`,
      ),
      seriesBlock(
        'percent',
        null,
        [
          {
            label: ctx.s.title('Skipped'),
            points: data.points.map((p) => ({ date: p.date, value: p.skippedPct })),
            color: 'skipped',
          },
          {
            label: ctx.s.title('Did not run'),
            points: data.points.map((p) => ({ date: p.date, value: p.didNotRunPct })),
            color: 'didnotrun',
          },
        ],
        (value) => ctx.f.value(value, 'percent', 1),
        { ...ctx, drawMarkers: false },
        `${ctx.s.title('Skipped')}${ctx.s.colon}${ctx.f.value(data.skippedPct, 'percent', 1)}, ${ctx.s.title('Did not run')}${ctx.s.colon}${ctx.f.value(data.didNotRunPct, 'percent', 1)}`,
      ),
    ];
  },

  'coverage-trend': (data: AnalyticsCoverageTrend, ctx) => {
    // No project with coverage: the report leaves the widget out.
    if (data.projects === 0 || data.linePercent === null) return [];
    const label = ctx.s.title('Line coverage');
    const delta = ctx.f.delta({ unit: 'percent', delta: data.delta, deltaPct: null, precision: 1 });
    const suites = data.series.map((suite, i) => ({
      label: suite.name,
      points: suite.points.map((p) => ({ date: p.date, value: p.linePercent })),
      color: SUITE_SERIES_COLORS[i % SUITE_SERIES_COLORS.length],
    }));
    const bySuite = data.series.map((suite) => ` · ${suite.name} ${ctx.f.value(suite.linePercent, 'percent', 1)}`);
    return [
      seriesBlock(
        'percent',
        100,
        [
          { label, points: data.points.map((p) => ({ date: p.date, value: p.linePercent })), color: 'accent' },
          ...suites,
        ],
        (value) => ctx.f.value(value, 'percent', 1),
        ctx,
        `${label}${ctx.s.colon}${ctx.f.value(data.linePercent, 'percent', 1)}${delta ? ` (${delta})` : ''}${bySuite.join('')}`,
      ),
    ];
  },

  'flaky-debt': (data: AnalyticsFlakyDebt, ctx) => {
    if (data.points.length === 0) return [{ kind: 'text', text: ctx.s.labels.noData }];
    const perRun = ctx.s.title('Flaky occurrences per run');
    const change =
      data.flakyPerRun !== null && data.previousFlakyPerRun !== null
        ? ` (${ctx.f.delta({ unit: 'count', delta: Math.round((data.flakyPerRun - data.previousFlakyPerRun) * 10) / 10, deltaPct: null, precision: 1 }) ?? ''})`
        : '';
    return [
      seriesBlock(
        'count',
        null,
        [{ label: perRun, points: data.points.map((p) => ({ date: p.date, value: p.flakyPerRun })), color: 'flaky' }],
        (value) => (value === null ? '—' : ctx.f.number(value, 1)),
        ctx,
        `${perRun}${ctx.s.colon}${data.flakyPerRun === null ? '—' : ctx.f.number(data.flakyPerRun, 1)}${change}`,
      ),
      seriesBlock(
        'count',
        null,
        [
          {
            label: ctx.s.metricLabel('flaky-tests', 'Flaky tests'),
            points: data.points.map((p) => ({ date: p.date, value: p.flakyTests })),
            color: 'flaky',
            faint: true,
          },
          {
            label: ctx.s.metricLabel('quarantine-debt', 'Quarantine debt'),
            points: data.points.map((p) => ({ date: p.date, value: p.quarantined })),
            color: 'accent',
          },
        ],
        (value) => (value === null ? '—' : ctx.f.number(value)),
        { ...ctx, drawMarkers: false },
        `${ctx.s.metricLabel('flaky-tests', 'Flaky tests')}${ctx.s.colon}${ctx.f.number(data.flakyTests)}, ${ctx.s.metricLabel('quarantine-debt', 'Quarantine debt')}${ctx.s.colon}${ctx.f.number(data.quarantined)}`,
      ),
    ];
  },

  'time-to-fix': (data: AnalyticsTimeToFix, ctx) => {
    const open = data.openByAge.reduce((sum, g) => sum + g.count, 0);
    if (data.opened === 0 && data.fixed === 0 && open === 0) return [{ kind: 'text', text: ctx.s.labels.noData }];
    const blocks: ReportBlock[] = [
      {
        kind: 'stats',
        tiles: [
          plainTile(
            ctx.s.metricLabel('median-time-to-fix', 'Median time to fix'),
            ctx.f.value(data.medianDays, 'days', 1),
          ),
          plainTile(ctx.s.title('p90 time to fix'), ctx.f.value(data.p90Days, 'days', 1)),
          plainTile(
            ctx.s.metricLabel('fixes-that-held', 'Fixes that held'),
            ctx.f.value(data.fixesHeldPct, 'percent', 1),
          ),
          plainTile(ctx.s.metricLabel('failure-causes-opened', 'Failure causes opened'), ctx.f.number(data.opened)),
          plainTile(ctx.s.metricLabel('failure-causes-fixed', 'Failure causes fixed'), ctx.f.number(data.fixed)),
        ],
      },
      seriesBlock(
        'count',
        null,
        [
          {
            label: ctx.s.metricLabel('failure-causes-opened', 'Failure causes opened'),
            points: data.points.map((p) => ({ date: p.date, value: p.opened })),
            color: 'failed',
          },
          {
            label: ctx.s.metricLabel('failure-causes-fixed', 'Failure causes fixed'),
            points: data.points.map((p) => ({ date: p.date, value: p.fixed })),
            color: 'passed',
          },
        ],
        (value) => (value === null ? '—' : ctx.f.number(value)),
        ctx,
        null,
      ),
    ];
    if (open > 0) {
      blocks.push({
        kind: 'table',
        columns: [
          { key: 'age', label: ctx.s.title('Age') },
          { key: 'count', label: ctx.s.metricLabel('open-failure-causes', 'Open failure causes'), align: 'right' },
        ],
        rows: data.openByAge.map((g) => row({ age: ctx.s.title(g.label), count: num(ctx, g.count, 'count') })),
      });
    }
    return blocks;
  },

  ownership: (data: AnalyticsOwnership, ctx) =>
    data.rows.length === 0
      ? [{ kind: 'text', text: ctx.s.labels.noData }]
      : [
          {
            kind: 'table',
            columns: [
              { key: 'owner', label: ctx.s.title('Owner') },
              { key: 'open', label: ctx.s.metricLabel('open-failure-causes', 'Open failure causes'), align: 'right' },
              { key: 'flaky', label: ctx.s.metricLabel('flaky-tests', 'Flaky tests'), align: 'right' },
              { key: 'wasted', label: ctx.s.metricLabel('wasted-ci-minutes', 'Wasted CI minutes'), align: 'right' },
              { key: 'ttf', label: ctx.s.metricLabel('median-time-to-fix', 'Median time to fix'), align: 'right' },
            ],
            rows: data.rows.map((r) =>
              row({
                owner: r.owner ?? ctx.s.title('Unowned'),
                open: num(ctx, r.openClusters, 'count'),
                flaky: num(ctx, r.flakyTests, 'count'),
                wasted: num(ctx, r.wastedMinutes, 'minutes'),
                ttf: num(ctx, r.medianTimeToFixDays, 'days', 1),
              }),
            ),
          },
        ],

  'environment-comparison': (data: AnalyticsEnvironmentComparison, ctx) => {
    if (data.rows.length === 0) return [{ kind: 'text', text: ctx.s.labels.noData }];
    const passRate = ctx.s.metricLabel('test-pass-rate', 'Test pass rate');
    // Runs without an environment are grouped under a label Piwi writes.
    const environment = (r: AnalyticsEnvironmentRow) => (r.environment === NONE_KEY ? ctx.s.title(r.label) : r.label);
    const blocks: ReportBlock[] = [
      {
        kind: 'table',
        columns: [
          { key: 'environment', label: ctx.s.title('Environment') },
          { key: 'passRate', label: passRate, align: 'right' },
          { key: 'change', label: ctx.s.labels.change, align: 'right' },
          { key: 'success', label: ctx.s.metricLabel('run-success-rate', 'Run success rate'), align: 'right' },
          { key: 'runs', label: ctx.s.metricLabel('runs', 'Runs'), align: 'right' },
        ],
        rows: data.rows.map((r) =>
          row({
            environment: environment(r),
            passRate: metricCell(ctx, r.passRate),
            change: deltaCell(ctx, r.passRate, '—'),
            success: metricCell(ctx, r.runSuccessRate),
            runs: num(ctx, r.runs, 'count'),
          }),
        ),
      },
    ];
    if (data.rows.length > 1) {
      blocks.unshift(
        seriesBlock(
          'percent',
          100,
          data.rows.map((r) => ({ label: environment(r), points: r.points })),
          (value) => ctx.f.value(value, 'percent', 1),
          ctx,
          null,
        ),
      );
    }
    return blocks;
  },

  movers: (data: AnalyticsMovers, ctx) => {
    if (!data.comparisonLabel || data.groups.length === 0) return [{ kind: 'text', text: ctx.s.labels.noData }];
    return data.groups.map((group) => ({
      kind: 'table' as const,
      columns: [
        { key: 'test', label: ctx.s.title(group.label) },
        { key: 'project', label: ctx.s.labels.projects },
        { key: 'before', label: ctx.s.labels.previous, align: 'right' as const },
        { key: 'after', label: ctx.s.title('Now'), align: 'right' as const },
      ],
      rows: group.items.map((m) => {
        const duration = group.kind === 'slower' || group.kind === 'faster';
        const show = (v: number) => (duration ? num(ctx, v, 'ms', 0) : num(ctx, v * 100, 'percent', 0));
        return row(
          { test: m.title, project: m.projectName, before: show(m.before), after: show(m.after) },
          link(ctx, `/test-cases/${m.testCaseId}`),
        );
      }),
    }));
  },

  'scenario-gaps': (data: AnalyticsScenarioGaps, ctx) => {
    if (data.projects === 0) return [];
    const open = data.byClass.reduce((sum, c) => sum + c.count, 0);
    const blocks: ReportBlock[] = [
      {
        kind: 'stats',
        tiles: [
          plainTile(ctx.s.metricLabel('open-scenario-gaps', 'Open scenario gaps'), ctx.f.number(open)),
          plainTile(ctx.s.metricLabel('gaps-closed', 'Gaps closed'), ctx.f.number(data.closed)),
          plainTile(
            ctx.s.metricLabel('accepted-but-unwritten', 'Accepted but unwritten'),
            ctx.f.number(data.acceptedUnwritten),
          ),
          plainTile(
            ctx.s.metricLabel('open-resilience-findings', 'Open resilience findings'),
            ctx.f.number(data.findings),
          ),
        ],
      },
    ];
    if (data.byClass.length > 0) {
      blocks.push({
        kind: 'table',
        columns: [
          { key: 'class', label: ctx.s.labels.gapClass },
          { key: 'count', label: ctx.s.labels.count, align: 'right' },
        ],
        rows: data.byClass.map((c) => row({ class: ctx.s.gapClass(c.class), count: num(ctx, c.count, 'count') })),
      });
    }
    if (data.byFeature.length > 0) {
      blocks.push({
        kind: 'table',
        columns: [
          { key: 'feature', label: ctx.s.labels.feature },
          { key: 'project', label: ctx.s.labels.projects },
          { key: 'worst', label: ctx.s.labels.gapClass },
          { key: 'count', label: ctx.s.labels.count, align: 'right' },
        ],
        rows: data.byFeature.map((f) =>
          row(
            {
              feature: f.feature,
              project: f.projectName,
              worst: f.worstClass ? ctx.s.gapClass(f.worstClass) : '—',
              count: num(ctx, f.count, 'count'),
            },
            link(ctx, `/projects/${f.projectId}?tab=gaps`),
          ),
        ),
      });
    }
    return blocks;
  },

  'new-gaps': (data: AnalyticsNewGaps, ctx) => {
    if (data.projects === 0) return [];
    if (data.items.length === 0) return [{ kind: 'text', text: ctx.s.labels.noData }];
    return [
      {
        kind: 'table',
        columns: [
          { key: 'gap', label: ctx.s.title('Scenario gaps') },
          { key: 'project', label: ctx.s.labels.projects },
          { key: 'class', label: ctx.s.labels.gapClass },
          { key: 'score', label: ctx.s.labels.score, align: 'right' },
        ],
        rows: data.items.flatMap((p) =>
          p.gaps.map((g) =>
            row(
              {
                gap: ctx.s.gapTitle(g.detector, g.title),
                project: p.projectName,
                class: ctx.s.gapClass(g.class),
                score: num(ctx, g.score, 'count', 3),
              },
              link(ctx, `/projects/${p.projectId}?tab=gaps`),
            ),
          ),
        ),
      },
    ];
  },
};

/** A project's targets met over those judged ("2 / 3"); a dash without targets. */
function targetCount(targets: AnalyticsPortfolioRow['targets'], ctx: DocumentContext): string {
  const judged = targets.filter((t) => t.met !== null);
  if (judged.length === 0) return '—';
  return `${ctx.f.number(judged.filter((t) => t.met).length)} / ${ctx.f.number(judged.length)}`;
}

function plainTile(label: string, value: string): ReportTile {
  return { label, value, change: null, tone: 'neutral', note: null, definition: null };
}

/** The metrics a widget's blocks define, for the report footer. */
export function widgetMetrics(type: AnalyticsWidgetId, options: Record<string, unknown>): MetricId[] {
  if (type === 'stats') {
    const metrics = (options.metrics as MetricId[] | undefined) ?? [];
    const companions = Object.values((options.companions as Record<string, MetricId> | undefined) ?? {});
    return [...metrics, ...companions];
  }
  if (type === 'metric') return [(options.metric as MetricId | undefined) ?? 'test-pass-rate'];
  if (type === 'verdict' || type === 'narrative')
    return ['test-pass-rate', 'failure-causes-fixed', 'open-failure-causes', 'wasted-ci-minutes'];
  if (type === 'wasted-time') return ['wasted-ci-minutes'];
  if (type === 'ci-time-trend') return ['ci-time'];
  if (type === 'suite-growth') return ['suite-size'];
  if (type === 'time-to-fix') {
    return [
      'median-time-to-fix',
      'fixes-that-held',
      'failure-causes-opened',
      'failure-causes-fixed',
      'open-failure-causes',
    ];
  }
  if (type === 'ownership') return ['open-failure-causes', 'flaky-tests', 'wasted-ci-minutes', 'median-time-to-fix'];
  if (type === 'environment-comparison') return ['test-pass-rate', 'run-success-rate', 'runs'];
  if (type === 'flaky-debt') return ['flaky-occurrences', 'flaky-tests', 'quarantine-debt'];
  if (type === 'regression-velocity') return ['new-regressions', 'newly-flaky'];
  if (type === 'portfolio' || type === 'pass-rate-heatmap' || type === 'browser-matrix') return ['test-pass-rate'];
  if (type === 'scenario-gaps') {
    return ['open-scenario-gaps', 'gaps-closed', 'accepted-but-unwritten', 'open-resilience-findings'];
  }
  if (type === 'handbacks') {
    return [
      'heal-adoption',
      'heal-pr-merge-rate',
      'diagnosis-helpful-rate',
      'diagnosis-verified-rate',
      'gate-blocked-merges',
      'gate-overrides',
      'flakes-verified-fixed',
    ];
  }
  return [];
}

/** Widgets whose lists name tests, so they reach back only as far as retention keeps runs. */
export const IDENTITY_WIDGETS = new Set<AnalyticsWidgetId>([
  'flaky-leaderboard',
  'stats',
  'browser-matrix',
  'movers',
  'ownership',
  'flaky-debt',
]);

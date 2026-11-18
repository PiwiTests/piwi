/**
 * The report bundle: the data behind one quality report, the way
 * `ExportBundle` is the data behind an offline export. Every output format
 * (the in-app view, HTML, PDF, Markdown, JSON, CSV, Excel) renders the same bundle,
 * and renderers draw blocks, never widgets, so a new widget is reportable
 * without a renderer change.
 *
 * Every string a block carries is already formatted in the report language;
 * run-derived text (titles, branch names, error excerpts) is data and each
 * renderer escapes it.
 */
import type { AnalyticsScope } from '#shared/analytics/scope';
import type { MetricDef, MetricUnit } from '#shared/analytics/metrics';
import type { VerdictTone } from '#shared/analytics/types';
import type { ReportLanguage } from './languages';

export type ReportTone = 'good' | 'bad' | 'neutral';

export interface ReportTile {
  /** The catalog metric the tile shows; absent on snapshots generated before tiles named it. */
  metric?: string;
  label: string;
  value: string;
  /** The change against the comparison period, formatted; null without one. */
  change: string | null;
  /** Whether the change is good or bad news for this metric. */
  tone: ReportTone;
  /** A second number under the value (the cost, the median time to fix). */
  note: string | null;
  /** The metric's definition, for a tooltip or a footnote. */
  definition: string | null;
}

export interface ReportSeries {
  label: string;
  points: Array<{ date: string; value: number | null }>;
  /** A comparison line, drawn faint and dashed. */
  faint?: boolean;
  /** A palette key or a `#rrggbb` color; renderers fall back to the accent. */
  color?: string;
}

export interface ReportColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
}

/**
 * A table cell's value for a spreadsheet, beside its formatted text: a number
 * in its unit (`points` and `change` are the signed changes the formatter
 * writes `+2.1 pts` and `+12%`), or a `YYYY-MM-DD` day. Absent on text cells
 * and on snapshots generated before rows carried values.
 */
export type ReportCellValue =
  | { number: number; unit: MetricUnit | 'points' | 'change'; precision: number; currency?: string | null }
  | { date: string };

export interface ReportRow {
  cells: Record<string, string>;
  values?: Record<string, ReportCellValue>;
  link?: string | null;
}

export type ReportBlock =
  | { kind: 'stats'; tiles: ReportTile[] }
  | {
      kind: 'series';
      unit: string;
      /** Upper bound of the value axis (100 for a percentage), or null to fit the data. */
      max: number | null;
      /** How a value reads (`97.8%`), one per series point, for tables and tooltips. */
      series: Array<ReportSeries & { formatted: string[] }>;
      /** Markers inside the period, as dates. */
      markers: Array<{ date: string; label: string }>;
      /** One line summing the series up. */
      summary: string | null;
    }
  | { kind: 'table'; columns: ReportColumn[]; rows: ReportRow[] }
  | { kind: 'list'; items: Array<{ text: string; detail?: string | null; tone?: ReportTone; link?: string | null }> }
  | { kind: 'text'; text: string; tone?: VerdictTone };

export interface ReportWidget {
  key: string;
  /** The registry widget it was rendered from, or null for a widget no longer available. */
  type: string | null;
  title: string;
  blocks: ReportBlock[];
  /** Things the reader should know about this widget ("not narrowed by the test filter"). */
  notes: string[];
}

export interface ReportBand {
  title: string;
  description: string | null;
  widgets: ReportWidget[];
}

export interface ReportPeriod {
  from: string;
  to: string;
  label: string;
}

export interface TargetVerdict {
  projectId: number;
  project: string;
  metric: string;
  /** The target over the report's period (a weekly target scaled to it). */
  target: number;
  actual: number | null;
  /** Null when the period has nothing to judge the target on. */
  met: boolean | null;
  /** The verdict as one line in the report language. */
  text: string;
}

export interface ReportBundle {
  generatedAt: string;
  piwiVersion: string | null;
  /** Back to the analytics page with the scope. */
  sourceUrl: string | null;
  /** "All projects, Last 30 days" */
  title: string;
  language: ReportLanguage;
  /** How dates and numbers were formatted. */
  locale: string;
  timeZone: string;
  scope: AnalyticsScope;
  /**
   * The scope in words: projects by name, branch policy, environment policy, run kind, test filter. A bundle stored
   * without `environments` names no environment policy.
   */
  scopeText: { projects: string; branches: string; environments?: string; runs: string; tests: string | null };
  period: ReportPeriod;
  comparison: ReportPeriod | null;
  dashboard: { ref: string; name: string };
  verdict: { tone: VerdictTone; sentence: string };
  /** In dashboard order; each band a section of the document. */
  bands: ReportBand[];
  /** Targets met and missed, per project in scope that sets targets. */
  targets: TargetVerdict[];
  /** The catalog entries the report used, for the footer. */
  definitions: Array<Pick<MetricDef, 'id' | 'label' | 'definition'>>;
  limits: string[];
}

export const REPORT_FORMATS = ['json', 'html', 'pdf', 'md', 'csv', 'xlsx'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function isReportFormat(value: unknown): value is ReportFormat {
  return typeof value === 'string' && (REPORT_FORMATS as readonly string[]).includes(value);
}

/** Whether a widget shows the verdict; otherwise renderers put it under the title. */
export function hasVerdictWidget(bundle: Pick<ReportBundle, 'bands'>): boolean {
  return reportWidgets(bundle).some(
    (w) =>
      w.type === 'verdict' ||
      // A narrative that fell back to the rule-based verdict carries it, toned.
      (w.type === 'narrative' && w.blocks.some((b) => b.kind === 'text' && b.tone)),
  );
}

/** Every widget of a bundle, in document order. */
export function reportWidgets(bundle: Pick<ReportBundle, 'bands'>): ReportWidget[] {
  return bundle.bands.flatMap((band) => band.widgets);
}

/**
 * How the analytics widgets print a metric value: the shared report formatter
 * in English with the viewer's locale, so the page and the quality report read
 * the same numbers, and the one coloring rule for a change (better in the
 * passed color, worse in the failed color).
 */
import type { AnalyticsMetricValue, AnalyticsStatTile } from '#shared/analytics/types';
import { makeFormatter, type ValueFormatter } from '#shared/reports/format';
import { getMetric } from '#shared/analytics/metrics';
import type { ProjectTargetVerdict } from '#shared/analytics/targets';
import { STATUS_PALETTE } from '@piwitests/run-ui/status-palette';
import { passRateTextClass } from './pass-rate';

export function metricFormatter(): ValueFormatter {
  return makeFormatter('en', viewerLocale());
}

export function formatMetric(value: AnalyticsMetricValue, f = metricFormatter()): string {
  return f.value(value.value, value.unit, value.precision, value.currency);
}

/** Why a rate shows no value: fewer items than its sample floor (`3 of the 10 needed`); null otherwise. */
export function sampleNote(value: AnalyticsMetricValue): string | null {
  const sample = value.sample;
  if (value.value !== null || !sample || sample.size >= sample.min) return null;
  return `Too few to rate: ${sample.size} of the ${sample.min} needed`;
}

/** Text utility for a change: the passed color when it is good news, the failed color when bad. */
export function metricTrendClass(trend: AnalyticsMetricValue['trend']): string {
  if (trend === 'better') return STATUS_PALETTE.passed.text;
  if (trend === 'worse') return STATUS_PALETTE.failed.text;
  return 'text-muted';
}

/** Text utility for the value itself: the pass-rate scale for a pass rate, none otherwise. */
export function metricValueClass(value: AnalyticsMetricValue): string {
  return value.metric === 'test-pass-rate' || value.metric === 'run-success-rate' ? passRateTextClass(value.value) : '';
}

/** Text utility for a target verdict: the passed color when met, the failed color when missed. */
export function targetClass(met: boolean | null): string {
  if (met === true) return STATUS_PALETTE.passed.text;
  if (met === false) return STATUS_PALETTE.failed.text;
  return 'text-muted';
}

/** A tile's target mark: "Target ≥ 98% · missed" for one project, "2 of 3 projects meet the target" across projects. */
export function tileTargetText(
  tile: Pick<AnalyticsStatTile, 'target' | 'unit' | 'precision' | 'currency'>,
  f = metricFormatter(),
): string | null {
  const t = tile.target;
  if (!t) return null;
  if (t.target !== null) {
    const sign = t.direction === 'min' ? '≥' : '≤';
    const verdict = t.met > 0 ? 'met' : t.missed > 0 ? 'missed' : 'nothing to judge yet';
    return `Target ${sign} ${f.value(t.target, tile.unit, tile.precision, tile.currency)} · ${verdict}`;
  }
  const judged = t.met + t.missed;
  if (judged === 0) return 'Target set, nothing to judge yet';
  return `${t.met} of ${judged} ${judged === 1 ? 'project meets' : 'projects meet'} the target`;
}

/** Whether a tile's target reads as met, missed or neither. */
export function tileTargetMet(tile: Pick<AnalyticsStatTile, 'target'>): boolean | null {
  const t = tile.target;
  if (!t || t.met + t.missed === 0) return null;
  return t.missed === 0;
}

/** A project's targets in a few words ("2 of 3 met") and whether all of them are; null without targets. */
export function projectTargetsSummary(
  targets: ProjectTargetVerdict[],
): { text: string; met: boolean | null; detail: string } | null {
  if (targets.length === 0) return null;
  const judged = targets.filter((t) => t.met !== null);
  const met = judged.filter((t) => t.met).length;
  const detail = targets
    .map((t) => `${getMetric(t.metric).label}: ${t.met === null ? 'nothing to judge yet' : t.met ? 'met' : 'missed'}`)
    .join('\n');
  if (judged.length === 0) return { text: 'Not judged yet', met: null, detail };
  return { text: `${met} of ${judged.length} met`, met: met === judged.length, detail };
}

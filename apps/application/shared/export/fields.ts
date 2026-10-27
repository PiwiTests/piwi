/**
 * The facts an export states, and how they are formatted.
 *
 * Both renderers read these lists, so the HTML report and the Markdown export
 * describe the same run — a field added here shows up in both.
 */
import { pausedOverlap, type PauseSpan } from '@piwitests/core/step-analysis';
import type { ExportBundle, ExportCase } from './types';

/** A label/value pair; `null` values are dropped by the renderers. */
export type Fact = [string, string | null];

export function fmtDuration(ms: unknown): string {
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60_000);
  return `${m}m ${Math.round((n % 60_000) / 1000)}s`;
}

/**
 * A step's duration as the exports write it, with the time the test stood paused at Piwi's pause bar while it ran
 * (`pauses`, the execution's stops in epoch ms): `7.3s, 6.3s of it paused`.
 */
export function fmtStepDuration(step: { startTime?: unknown; duration?: unknown }, pauses: unknown): string {
  const spans = Array.isArray(pauses) ? (pauses as PauseSpan[]) : [];
  const paused = spans.length ? pausedOverlap(step.startTime, step.duration, spans) : 0;
  const duration = fmtDuration(step.duration);
  return paused > 0 ? `${duration}, ${fmtDuration(paused)} of it paused` : duration;
}

export function fmtBytes(bytes: unknown): string {
  const n = typeof bytes === 'number' ? bytes : Number(bytes);
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtDate(value: unknown): string | null {
  if (value == null) return null;
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function caseFacts(exportCase: ExportCase): Fact[] {
  const d = exportCase.detail as Record<string, any>;
  const run = (d.testRun ?? {}) as Record<string, any>;
  const browser = (d.browser ?? {}) as Record<string, any>;

  return [
    ['Duration', fmtDuration(d.duration)],
    ['Retries', d.retries != null ? String(d.retries) : null],
    ['Started', fmtDate(d.startedAt)],
    ['Run', run.id != null ? `#${run.id}` : null],
    ['Browser', browser.projectName ?? browser.browserName ?? null],
    ['Worker', d.workerIndex != null ? String(d.workerIndex) : null],
    ['Shard', d.shardIndex != null ? String(d.shardIndex) : null],
    ['New regression', d.isNewRegression ? 'yes' : null],
    ['Newly flaky', d.isNewFlaky ? 'yes' : null],
    ['Wasted time', d.wastedTimeMs ? fmtDuration(d.wastedTimeMs) : null],
    ['Slowest step', d.slowestStep ? `${d.slowestStep} (${fmtDuration(d.slowestStepDuration)})` : null],
  ];
}

export function clusterFacts(cluster: Record<string, any>): Fact[] {
  return [
    ['Signature', cluster.signature ?? null],
    ['Error type', cluster.errorType ?? null],
    ['Selector', cluster.selector ?? null],
    ['Status', cluster.status ?? null],
    ['Occurrences', cluster.occurrences != null ? String(cluster.occurrences) : null],
    ['Affected tests', cluster.affectedTests != null ? String(cluster.affectedTests) : null],
    ['First seen', fmtDate(cluster.firstSeenAt)],
    ['Last seen', fmtDate(cluster.lastSeenAt)],
    ['Triage note', cluster.triageNote ?? null],
  ];
}

export function diagnosisFacts(diagnosis: Record<string, any>): Fact[] {
  const det = (diagnosis.details ?? {}) as Record<string, any>;
  return [
    ['Category', diagnosis.category ?? null],
    ['Confidence', diagnosis.confidence ?? null],
    ['Severity', det.severity != null ? String(det.severity) : null],
    ['Affected area', det.affectedArea != null ? String(det.affectedArea) : null],
  ];
}

/** True when a diagnosis has a result worth rendering. */
export function hasDiagnosis(diagnosis: Record<string, any> | null): boolean {
  return Boolean(diagnosis && diagnosis.status === 'completed');
}

export function projectLabel(bundle: ExportBundle): string | null {
  return bundle.project ? bundle.project.label || bundle.project.name : null;
}

export const OMISSION_REASONS: Record<string, string> = {
  'too-large': 'larger than the per-file inline limit',
  'budget-exhausted': 'the export size budget was reached',
  unreadable: 'the file could not be read from storage',
  'html-format': 'not embeddable in a single HTML file — use the ZIP export',
  'pdf-format': 'not embeddable in a PDF — use the ZIP or HTML export',
};

/** One console entry as a single line, shared by both renderers and the ZIP log. */
export function consoleLine(entry: Record<string, any>): string {
  return `[${entry.type ?? 'log'}] ${entry.text ?? ''}`;
}

/**
 * The facts an export states, and how they are formatted.
 *
 * Both renderers read these lists, so the HTML report and the Markdown export
 * describe the same run — a field added here shows up in both.
 */
import { pausedOverlap, type PauseSpan } from '@piwitests/core/step-analysis';
import { stripAnsi } from '#shared/error-fingerprint';
import { errorLines, runSegments, type OutcomeSegment } from '#shared/notifications/message-parts';
import type { StatusColorKey } from '#shared/status-colors';
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Oct 28, 2026, 13:04 UTC`: a moment in UTC, so every reader of the file sees the same time. */
export function fmtDate(value: unknown): string | null {
  if (value == null) return null;
  const d = new Date(value as string | number);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function caseFacts(exportCase: ExportCase): Fact[] {
  const d = exportCase.detail as Record<string, any>;
  const run = (d.testRun ?? {}) as Record<string, any>;
  const browser = (d.browser ?? {}) as Record<string, any>;

  return [
    ['Duration', fmtDuration(d.duration)],
    ['Retries', d.retries != null ? String(d.retries) : null],
    ['Started', fmtDate(d.startedAt ?? run.startTime)],
    ['Browser', browser.projectName ?? browser.browserName ?? null],
    ['Worker', d.workerIndex != null ? String(d.workerIndex) : null],
    ['Shard', d.shardIndex != null ? String(d.shardIndex) : null],
    ['New regression', d.isNewRegression ? 'yes' : null],
    ['Newly flaky', d.isNewFlaky ? 'yes' : null],
    ['Wasted time', d.wastedTimeMs ? fmtDuration(d.wastedTimeMs) : null],
    ['Slowest step', d.slowestStep ? `${d.slowestStep} (${fmtDuration(d.slowestStepDuration)})` : null],
  ];
}

/**
 * A status as the outcome color it is drawn in, matching the dashboard: timed-out and interrupted read as failed, an
 * open cluster too, and a test that did not run as a warning.
 */
export function statusTone(value: unknown): StatusColorKey {
  const v = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (v === 'passed' || v === 'resolved') return 'passed';
  if (v === 'flaky') return 'flaky';
  if (v === 'didnotrun' || v === 'snoozed') return 'didnotrun';
  if (v === 'skipped' || v === 'ignored') return 'skipped';
  return 'failed';
}

/** The run an execution belongs to: its number, branch, environment, commit and CI build. */
export function runFacts(exportCase: ExportCase): Fact[] {
  const run = ((exportCase.detail as Record<string, any>).testRun ?? {}) as Record<string, any>;
  const scm = (run.metadata?.scm ?? {}) as Record<string, any>;
  const ci = (run.metadata?.ci ?? {}) as Record<string, any>;
  const sha = typeof (run.commit ?? scm.commit) === 'string' ? String(run.commit ?? scm.commit).slice(0, 7) : null;
  const message = typeof scm.commitMessage === 'string' ? scm.commitMessage.split('\n')[0]!.trim() : '';
  const commit = sha ? [sha, message, scm.author ? `(${scm.author})` : ''].filter(Boolean).join(' ') : null;
  const build = ci.provider ? `${ci.provider}${ci.buildNumber ? ` #${ci.buildNumber}` : ''}` : null;
  return [
    ['Run', run.id != null ? `#${run.id}` : null],
    ['Branch', run.branch ?? scm.branch ?? null],
    ['Environment', run.environment ?? null],
    ['Commit', commit],
    ['CI build', build],
    ['Playwright', run.playwrightVersion ?? null],
  ];
}

/** How the tests of an execution's run ended, by outcome, or null when the run is not attached. */
export function runOutcome(exportCase: ExportCase): { segments: OutcomeSegment[]; total: number } | null {
  const run = (exportCase.detail as Record<string, any>).testRun as Record<string, any> | undefined;
  const total = Number(run?.totalTests ?? 0);
  if (!run || !(total > 0)) return null;
  const segments = runSegments({
    totalTests: total,
    passedTests: Number(run.passedTests ?? 0),
    failedTests: Number(run.failedTests ?? 0),
    flakyTests: Number(run.flakyTests ?? 0),
    skippedTests: Number(run.skippedTests ?? 0),
    didNotRunTests: Number(run.didNotRunTests ?? 0),
  });
  return { segments, total };
}

/** A test's full name: its describe blocks, then its title. */
export function casePath(exportCase: ExportCase): string | null {
  const d = exportCase.detail as Record<string, any>;
  const suite = Array.isArray(d.suitePath) ? (d.suitePath as unknown[]).map(String).filter(Boolean) : [];
  return suite.length ? [...suite, String(d.title ?? exportCase.title)].join(' › ') : null;
}

/** The one-line reading of an execution's failure (`Test timed out after 30 s while clicking …`), when Piwi made one. */
export function caseHeadline(exportCase: ExportCase): { headline: string; detail: string | null } | null {
  const verdict = (exportCase.detail as Record<string, any>).verdict as Record<string, any> | null | undefined;
  if (!verdict?.headline) return null;
  return { headline: String(verdict.headline), detail: verdict.detail ? String(verdict.detail) : null };
}

/** A label beside an execution's title; `news` marks what is new about the failure. */
export interface CaseLabel {
  text: string;
  news: boolean;
}

/** The labels beside an execution's title: what is new about it, its owner and its tags. */
export function caseLabels(exportCase: ExportCase): CaseLabel[] {
  const d = exportCase.detail as Record<string, any>;
  const owner = d.verdict?.owner?.name ?? d.testMeta?.owner ?? null;
  const tags = Array.isArray(d.tags) ? (d.tags as unknown[]).map(String) : [];
  const label = (text: string | null, news = false): CaseLabel | null => (text ? { text, news } : null);
  return [
    label(d.isNewRegression ? 'New regression' : null, true),
    label(d.isNewFlaky ? 'Newly flaky' : null, true),
    label(d.quarantined ? 'Quarantined' : null),
    label(owner ? String(owner) : null),
    ...tags.map((tag) => label(tag)),
  ].filter((l): l is CaseLabel => l !== null);
}

/** A cluster's latest failure in one line, from its headline's parts. */
export function clusterHeadline(cluster: Record<string, any>): string | null {
  const parts = cluster.latestHeadline?.parts as Array<{ text?: unknown }> | undefined;
  const text = parts
    ?.map((p) => String(p.text ?? ''))
    .join('')
    .trim();
  return text || null;
}

/** A cluster's occurrences in its recent runs, oldest first. */
export function clusterOccurrences(cluster: Record<string, any>): Array<{ runId: number; count: number }> {
  const series = Array.isArray(cluster.occurrenceSeries) ? (cluster.occurrenceSeries as Record<string, any>[]) : [];
  return series
    .map((p) => ({ runId: Number(p.runId), count: Number(p.occurrences ?? 0), at: new Date(p.startedAt).getTime() }))
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .map(({ runId, count }) => ({ runId, count }));
}

/** What a line of an error is: its first line, the expected or received value, the call log, a stack frame, or the rest. */
export type ErrorRowKind = 'head' | 'expected' | 'received' | 'log' | 'stack' | 'body';

/** An error's lines, each with its kind, so a renderer colors the values and fades the call log and the stack. */
export function errorRows(text: string): Array<{ text: string; kind: ErrorRowKind }> {
  let inLog = false;
  return errorLines(stripAnsi(text)).map(({ text: line, kind }) => {
    if (kind !== 'body') return { text: line, kind };
    if (/^\s*Call log:/.test(line)) inLog = true;
    else if (!line.trim()) inLog = false;
    if (/^\s+at\s/.test(line)) return { text: line, kind: 'stack' };
    if (inLog || /^-{3,}$/.test(line.trim())) return { text: line, kind: 'log' };
    return { text: line, kind: 'body' };
  });
}

/**
 * Where each step sits on the test's timeline, as fractions of it: `offset` from
 * the first step's start and `width` its duration. Without start times, every
 * bar starts at 0 and is as long as its share of the longest step.
 */
export function stepBars(steps: Record<string, any>[]): Array<{ offset: number; width: number }> {
  const timed = steps.every((s) => Number.isFinite(Number(s.startTime)) && Number.isFinite(Number(s.duration)));
  if (timed && steps.length) {
    const start = Math.min(...steps.map((s) => Number(s.startTime)));
    const end = Math.max(...steps.map((s) => Number(s.startTime) + Number(s.duration)));
    const span = end - start;
    if (span > 0) {
      return steps.map((s) => ({
        offset: (Number(s.startTime) - start) / span,
        width: Math.max(0, Number(s.duration)) / span,
      }));
    }
  }
  const longest = Math.max(1, ...steps.map((s) => Number(s.duration) || 0));
  return steps.map((s) => ({ offset: 0, width: Math.max(0, Number(s.duration) || 0) / longest }));
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

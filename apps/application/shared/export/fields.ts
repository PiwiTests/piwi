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
import { testLabel } from '#shared/utils/test-label';
import type { ExportBundle, ExportCase, ExportRun, ExportRunTest } from './types';

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
  const browser = (d.browser ?? {}) as Record<string, any>;

  return [
    ['Duration', fmtDuration(d.duration)],
    ['Retries', d.retries != null ? String(d.retries) : null],
    ['Started', fmtDate(d.startedAt)],
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
 * A test's, a run's or a cluster's status as the outcome color it is drawn in, as the dashboard's `statusPaletteKey`
 * draws it: timed-out and interrupted read as failed, a pass on a retry as flaky, a run in progress as running, an
 * open cluster as failed and a resolved one as passed, and any other status as skipped.
 */
export function statusTone(value: unknown, retries?: number | null): StatusColorKey {
  const v = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (v === 'passed') return (retries ?? 0) > 0 ? 'flaky' : 'passed';
  if (v === 'failed' || v === 'timedout' || v === 'interrupted' || v === 'open') return 'failed';
  if (v === 'resolved') return 'passed';
  if (v === 'flaky') return 'flaky';
  if (v === 'fixme') return 'fixme';
  if (v === 'didnotrun') return 'didnotrun';
  if (v === 'running' || v === 'initializing' || v === 'finalizing') return 'running';
  return 'skipped';
}

/** A run's context: its number, branch, environment, commit and CI build. */
export function runFacts(run: Record<string, any>): Fact[] {
  const scm = (run.metadata?.scm ?? {}) as Record<string, any>;
  const ci = (run.metadata?.ci ?? {}) as Record<string, any>;
  const sha = typeof (run.commit ?? scm.commit) === 'string' ? String(run.commit ?? scm.commit).slice(0, 7) : null;
  const message = typeof scm.commitMessage === 'string' ? scm.commitMessage.split('\n')[0]!.trim() : '';
  const commit = sha ? [sha, message, scm.author ? `(${scm.author})` : ''].filter(Boolean).join(' ') : null;
  const number = ci.buildNumber ?? ci.runNumber ?? ci.pipelineId ?? null;
  const build = ci.provider ? `${ci.provider}${number ? ` #${number}` : ''}` : null;
  return [
    ['Run', run.id != null ? `#${run.id}` : null],
    ['Branch', run.branch ?? scm.branch ?? null],
    ['Environment', run.environment ?? null],
    ['Commit', commit],
    ['CI build', build],
    ['Playwright', run.playwrightVersion ?? null],
  ];
}

/** How a run's tests ended, by outcome, or null for a run that counted none. */
export function runTestsByOutcome(
  run: Record<string, any> | null | undefined,
): { segments: OutcomeSegment[]; total: number } | null {
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

/** A test's full name: its describe blocks, then its title as the dashboard shows it. */
export function casePath(exportCase: ExportCase): string | null {
  const d = exportCase.detail as Record<string, any>;
  const suite = Array.isArray(d.suitePath) ? (d.suitePath as unknown[]).map(String).filter(Boolean) : [];
  if (!suite.length) return null;
  const title =
    typeof d.title === 'string' ? testLabel({ title: d.title, displayTitle: d.displayTitle }) : exportCase.title;
  return [...suite, title].join(' › ');
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

/** The labels beside an execution's title: what is new about it, its owner (`Owner @team`) and its tags. */
export function caseLabels(exportCase: ExportCase): CaseLabel[] {
  const d = exportCase.detail as Record<string, any>;
  const owner = d.verdict?.owner?.name ?? d.testMeta?.owner ?? null;
  const tags = Array.isArray(d.tags) ? (d.tags as unknown[]).map(String) : [];
  const label = (text: string | null, news = false): CaseLabel | null => (text ? { text, news } : null);
  return [
    label(d.isNewRegression ? 'New regression' : null, true),
    label(d.isNewFlaky ? 'Newly flaky' : null, true),
    label(d.quarantined ? 'Quarantined' : null),
    label(owner ? `Owner ${String(owner)}` : null),
    ...tags.map((tag) => label(tag)),
  ].filter((l): l is CaseLabel => l !== null);
}

/** A cluster's latest failure in one line, from its headline's parts, with the detail under it. */
export function clusterHeadline(cluster: Record<string, any>): { headline: string; detail: string | null } | null {
  const parts = cluster.latestHeadline?.parts;
  if (!Array.isArray(parts)) return null;
  const headline = (parts as Array<{ text?: unknown }>)
    .map((p) => String(p?.text ?? ''))
    .join('')
    .trim();
  const detail = cluster.latestHeadline?.detail;
  return headline ? { headline, detail: typeof detail === 'string' && detail.trim() ? detail.trim() : null } : null;
}

/** A cluster's state in one sentence (`Fixed in run #62 and verified, still marked open.`), when Piwi made one. */
export function clusterState(cluster: Record<string, any>): string | null {
  const sentence = cluster.clusterState?.sentence;
  return typeof sentence === 'string' && sentence.trim() ? sentence.trim() : null;
}

/** A cluster's owner, when one is known. */
export function clusterOwner(cluster: Record<string, any>): string | null {
  const name = cluster.owner?.name;
  return typeof name === 'string' && name ? name : null;
}

/** A cluster's occurrences in its recent runs, oldest first. */
export function clusterOccurrences(cluster: Record<string, any>): Array<{ runId: number; count: number }> {
  const series = Array.isArray(cluster.occurrenceSeries) ? (cluster.occurrenceSeries as Record<string, any>[]) : [];
  return series
    .map((p) => ({ runId: Number(p.runId), count: Number(p.occurrences ?? 0), at: new Date(p.startedAt).getTime() }))
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .map(({ runId, count }) => ({ runId, count }));
}

/** The recent runs of a cluster in words: `Failed in 8 of the last 12 runs`, or null with fewer than two runs. */
export function clusterOccurrencesText(points: Array<{ count: number }>): string | null {
  if (points.length < 2) return null;
  return `Failed in ${points.filter((p) => p.count > 0).length} of the last ${points.length} runs`;
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
    let start = Infinity;
    let end = -Infinity;
    for (const s of steps) {
      start = Math.min(start, Number(s.startTime));
      end = Math.max(end, Number(s.startTime) + Number(s.duration));
    }
    const span = end - start;
    if (span > 0) {
      return steps.map((s) => ({
        offset: (Number(s.startTime) - start) / span,
        width: Math.max(0, Number(s.duration)) / span,
      }));
    }
  }
  let longest = 1;
  for (const s of steps) longest = Math.max(longest, Number(s.duration) || 0);
  return steps.map((s) => ({ offset: 0, width: Math.max(0, Number(s.duration) || 0) / longest }));
}

// ── A whole run ──────────────────────────────────────────────────────────────

/** A run's tests in one sentence: `2 of 12 tests failed, 1 flaky`, `All 12 tests passed`. */
export function runHeadline(run: Record<string, any>): string | null {
  const total = Number(run.totalTests ?? 0);
  if (!(total > 0)) return null;
  const failed = Number(run.failedTests ?? 0);
  const passed = Number(run.passedTests ?? 0);
  const flaky = Number(run.flakyTests ?? 0);
  const didNotRun = Number(run.didNotRunTests ?? 0);
  const tests = total === 1 ? 'test' : 'tests';
  const flakyPart = flaky > 0 ? `, ${flaky} flaky` : '';
  if (failed > 0) return `${failed} of ${total} ${tests} failed${flakyPart}`;
  if (didNotRun > 0) return `${didNotRun} of ${total} ${tests} did not run${flakyPart}`;
  if (passed === total) return `All ${total} ${tests} passed${flakyPart}`;
  return `${passed} of ${total} ${tests} passed${flakyPart}`;
}

/** The tests of a run that took longest, longest first. */
export function slowestTests(tests: ExportRunTest[], count = 10): ExportRunTest[] {
  return tests
    .filter((t) => t.duration != null && t.duration > 0)
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, count);
}

/** A run's figures: when it started, how long it ran, its tests and its slowest test. */
export function runSummaryFacts(run: ExportRun): Fact[] {
  const d = run.detail as Record<string, any>;
  const slowest = slowestTests(run.tests, 1)[0];
  return [
    ['Started', fmtDate(d.startTime)],
    ['Duration', d.duration != null ? fmtDuration(d.duration) : null],
    ['Tests', String(Number(d.totalTests ?? 0) || run.tests.length)],
    ['Shards', d.shardTotal ? String(d.shardTotal) : null],
    ['Slowest test', slowest ? `${slowest.title} (${fmtDuration(slowest.duration)})` : null],
  ];
}

/** A test of a run as its outcome reads in a list: a pass on a retry is flaky. */
export function runTestStatus(test: ExportRunTest): string {
  return test.flaky ? 'flaky' : test.status;
}

/** A status as words: `didn't run`, `timed out`; any other reads as written. */
export function statusLabel(status: string): string {
  if (status === 'didnotrun') return "didn't run";
  if (status === 'timedout' || status === 'timedOut') return 'timed out';
  return status;
}

/** A run test's duration, or a dash for a test that took no time (one that did not run). */
export function runTestDuration(test: ExportRunTest): string {
  return test.duration ? fmtDuration(test.duration) : '—';
}

/** One root cause of a run's failures, with the failing results it holds. */
export interface RunFailureGroup {
  title: string;
  /** The failure cluster's status, or null for the failures no cluster holds. */
  status: string | null;
  isNew: boolean;
  diagnosis: string | null;
  tests: ExportRunTest[];
}

/** A run's failing results by root cause: each failure cluster, then the failures no cluster holds. */
export function runFailureGroups(run: ExportRun): RunFailureGroup[] {
  const byId = new Map(run.tests.map((t) => [t.executionId, t]));
  const grouped = new Set<number>();
  const groups: RunFailureGroup[] = run.groups.map((g) => {
    const tests = g.executionIds.map((id) => byId.get(id)).filter((t): t is ExportRunTest => Boolean(t));
    for (const t of tests) grouped.add(t.executionId);
    return { title: g.title, status: g.status, isNew: g.isNew, diagnosis: g.diagnosis, tests };
  });
  const rest = run.tests.filter((t) => statusTone(t.status) === 'failed' && !grouped.has(t.executionId));
  return [
    ...groups.filter((g) => g.tests.length),
    ...(rest.length ? [{ title: 'Not grouped', status: null, isNew: false, diagnosis: null, tests: rest }] : []),
  ];
}

/** Where a run's test result ran: its browser, and its repetition in a run that repeats its tests. */
export function runTestWhere(test: Pick<ExportRunTest, 'browser' | 'repetition'>): string {
  return [test.browser, test.repetition ? `repetition ${test.repetition}` : null].filter(Boolean).join(' · ');
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

/**
 * What every channel of a notification says about an event, before it is
 * drawn: its tone and headline, a run's tests by outcome, what its history
 * says, and a failing test's name, location, code lines and error lines. The
 * email draws them in HTML, Slack in Block Kit, Teams in an Adaptive Card.
 */
import { durationApprox, durationShort } from '#shared/relative-time';
import { parseSourceSnippet } from '#shared/source-snippet';
import type { StatusColorKey } from '#shared/status-colors';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { STUCK_FACTOR, STUCK_FLOOR_MS, STUCK_HISTORY } from '#shared/stuck-tests';
import {
  clusterOutcome,
  failureTargetPath,
  notificationTargetPath,
  type AutoHealPrOpenedPayload,
  type BugLooksFixedPayload,
  type ClusterFixedPayload,
  type ClusterNewPayload,
  type ClusterRegressedPayload,
  type DiagnosisCompletedPayload,
  type EnvironmentIncidentPayload,
  type FailureSource,
  type HistoryOutcome,
  type NotificationEvent,
  type NotificationPayload,
  type RunFinishedPayload,
  type RunHistoryEntry,
  type TestStuckPayload,
  type TopFailure,
} from '#shared/notification-events';

/** What a message is about, for its colors: an outcome, or the brand for news that is neither good nor bad. */
export type Tone = 'failed' | 'passed' | 'warning' | 'flaky' | 'brand';

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `3 runs`, `1 passing run`. */
function runs(n: number, adjective = ''): string {
  return `${n} ${adjective ? `${adjective} ` : ''}run${n === 1 ? '' : 's'}`;
}

// ── Headline ──────────────────────────────────────────────────────────────────

export interface EventHeadline {
  tone: Tone;
  /** What kind of message this is, and where from: `Run failed · checkout`. */
  label: string;
  /** The headline: `figure` is the number that matters, which a channel sets large; empty when there is none. */
  lead: string;
  figure: string;
  rest: string;
  /** Short facts under the headline: `out of 214`, `Run #12`, `main`, `staging`, `8m 32s`. */
  details: string[];
}

/** The headline as one line of text. */
export function headlineText(h: Pick<EventHeadline, 'lead' | 'figure' | 'rest'>): string {
  return `${h.lead}${h.figure}${h.rest}`;
}

/** Where a run comes from: `Run #12`, its branch, its environment and, unless left out, its duration. */
export function runParts(
  p: { runId: number; branch?: string; environment?: string; durationMs?: number },
  withDuration = true,
): string[] {
  const parts = [`Run #${p.runId}`];
  if (p.branch) parts.push(p.branch);
  if (p.environment) parts.push(p.environment);
  if (withDuration && p.durationMs) parts.push(durationShort(p.durationMs));
  return parts;
}

/** Whether a run event's run failed, passed or stopped early. */
export function runOutcome(event: NotificationEvent, p: RunFinishedPayload): 'failed' | 'passed' | 'interrupted' {
  if (event === 'run.interrupted' || p.status === 'interrupted') return 'interrupted';
  if (p.failedTests > 0 || p.status === 'failed' || p.status === 'timedout') return 'failed';
  return 'passed';
}

/** The tone an event is drawn in. */
export function eventTone(event: NotificationEvent, payload: NotificationPayload): Tone {
  switch (event) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted': {
      const outcome = runOutcome(event, payload as RunFinishedPayload);
      return outcome === 'interrupted' ? 'warning' : outcome;
    }
    case 'cluster.new':
    case 'cluster.regressed':
      return 'failed';
    case 'cluster.fixed':
    case 'bug.looks_fixed':
      return 'passed';
    case 'flakiness.spike':
      return 'flaky';
    case 'perf.regression':
    case 'environment.incident':
    case 'test.stuck':
      return 'warning';
    case 'diagnosis.completed':
    case 'auto_heal.pr_opened':
      return 'brand';
  }
}

const INCIDENT_RULES: Record<string, string> = {
  'host-unreachable': 'The application could not be reached',
  'browser-crash': 'The browser crashed',
  'cross-project': 'Several projects failed the same way',
};

/** A cluster's title when it adds something to its signature. */
export function clusterTitle(p: { title?: string | null; signature: string }): string | null {
  return p.title && p.title !== p.signature ? p.title : null;
}

function runHeadline(event: NotificationEvent, p: RunFinishedPayload): EventHeadline {
  const outcome = runOutcome(event, p);
  const tone = eventTone(event, p);
  const tests = (n: number) => (n === 1 ? 'test' : 'tests');
  const defaultBranch = event === 'run.failed.default_branch';
  if (outcome === 'interrupted') {
    const reported = runSegments(p)
      .filter((s) => s.key !== NOT_REPORTED)
      .reduce((sum, s) => sum + s.count, 0);
    return {
      tone,
      label: `${defaultBranch ? 'Default branch broken' : 'Run interrupted'} · ${p.projectName}`,
      lead: 'The run stopped before the end',
      figure: '',
      rest: '',
      details: [`${reported} of ${plural(p.totalTests, 'test')} reported`, ...runParts(p)],
    };
  }
  if (outcome === 'failed') {
    const label = `${defaultBranch ? 'Default branch broken' : 'Run failed'} · ${p.projectName}`;
    return p.failedTests > 0
      ? {
          tone,
          label,
          lead: '',
          figure: String(p.failedTests),
          rest: ` ${tests(p.failedTests)} failed`,
          details: [`out of ${p.totalTests}`, ...runParts(p)],
        }
      : {
          tone,
          label,
          lead: 'The run failed',
          figure: '',
          rest: '',
          details: [`${plural(p.totalTests, 'test')} reported`, ...runParts(p)],
        };
  }
  const label = `Run passed · ${p.projectName}`;
  if (p.totalTests <= 0)
    return { tone, label, lead: 'The run passed', figure: '', rest: '', details: ['no tests', ...runParts(p)] };
  const retried = p.flakyTests > 0 ? [`${p.flakyTests} only on a retry`] : [];
  return p.passedTests === p.totalTests && p.flakyTests === 0
    ? {
        tone,
        label,
        lead: 'All ',
        figure: String(p.totalTests),
        rest: ` ${tests(p.totalTests)} passed`,
        details: runParts(p),
      }
    : {
        tone,
        label,
        lead: '',
        figure: String(p.passedTests),
        rest: ` ${tests(p.passedTests)} passed`,
        details: [...retried, ...(p.passedTests < p.totalTests ? [`out of ${p.totalTests}`] : []), ...runParts(p)],
      };
}

/** The headline of an event, the same in every channel. */
export function eventHeadline(event: NotificationEvent, payload: NotificationPayload): EventHeadline {
  const tone = eventTone(event, payload);
  const text = (label: string, lead: string, details: Array<string | null | undefined> = []): EventHeadline => ({
    tone,
    label,
    lead,
    figure: '',
    rest: '',
    details: details.filter((d): d is string => Boolean(d)),
  });
  switch (event) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted':
      return runHeadline(event, payload as RunFinishedPayload);
    case 'flakiness.spike': {
      const p = payload as RunFinishedPayload;
      const share = p.totalTests > 0 ? `${((p.flakyTests / p.totalTests) * 100).toFixed(1)}% of the run` : null;
      return {
        tone,
        label: `Flakiness spike · ${p.projectName}`,
        lead: '',
        figure: String(p.flakyTests),
        rest: ` flaky ${p.flakyTests === 1 ? 'test' : 'tests'}`,
        details: [...(share ? [share] : []), ...runParts(p)],
      };
    }
    case 'perf.regression': {
      const p = payload as RunFinishedPayload;
      const comparison =
        p.durationMs != null && p.baselineDurationMs != null
          ? `${durationShort(p.durationMs)}, against a usual ${durationShort(p.baselineDurationMs)}`
          : null;
      const details = [...(comparison ? [comparison] : []), ...runParts(p, false)];
      const label = `Performance regression · ${p.projectName}`;
      return p.regressionPct != null
        ? { tone, label, lead: '', figure: `+${Math.round(p.regressionPct)}%`, rest: ' slower', details }
        : { ...text(label, 'Slower than usual'), details };
    }
    case 'cluster.new': {
      const p = payload as ClusterNewPayload;
      const affected = p.affectedCases ?? 0;
      const label = `New failure cluster · ${p.projectName}`;
      const details = [clusterTitle(p)];
      return affected > 0
        ? {
            ...text(label, '', details),
            figure: String(affected),
            rest: affected === 1 ? ' test fails the same way' : ' tests fail the same way',
          }
        : text(label, 'A new way to fail', details);
    }
    case 'cluster.fixed': {
      const p = payload as ClusterFixedPayload;
      return text(`Fixed · ${p.projectName}`, clusterOutcome('cluster.fixed', p).headline, [clusterTitle(p)]);
    }
    case 'cluster.regressed': {
      const p = payload as ClusterRegressedPayload;
      return text(`Fix regressed · ${p.projectName}`, 'The fix did not hold', [clusterTitle(p)]);
    }
    case 'environment.incident': {
      const p = payload as EnvironmentIncidentPayload;
      return text(
        `Environment incident · ${p.projectName}`,
        INCIDENT_RULES[p.rule] ?? 'The environment failed',
        runParts(p),
      );
    }
    case 'diagnosis.completed': {
      const p = payload as DiagnosisCompletedPayload;
      return text('AI diagnosis', 'The diagnosis is ready', [
        p.category,
        p.confidence ? `${p.confidence} confidence` : null,
      ]);
    }
    case 'auto_heal.pr_opened': {
      const p = payload as AutoHealPrOpenedPayload;
      return {
        ...text(`Auto-heal · ${p.projectName}`, 'Pull request ', [
          `${plural(p.editCount, 'locator edit')} on ${p.branch}`,
        ]),
        figure: `#${p.prNumber}`,
        rest: ' is open',
      };
    }
    case 'test.stuck': {
      const p = payload as TestStuckPayload;
      return text(`Stuck? · ${p.projectName}`, 'A test may be stuck', [
        p.testTitle,
        `${durationShort(p.elapsedMs)}, against ${durationShort(p.usualMs)} at most usually`,
        ...runParts(p),
      ]);
    }
    case 'bug.looks_fixed': {
      const p = payload as BugLooksFixedPayload;
      const label = `Bug looks fixed · ${p.projectName}`;
      const [first] = p.tests;
      if (p.tests.length === 1 && first) {
        return text(label, first.bugId ? `Bug #${first.bugId} looks fixed` : 'A bug looks fixed', runParts(p));
      }
      return { ...text(label, '', runParts(p)), figure: String(p.tests.length), rest: ' bugs look fixed' };
    }
  }
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

export interface OutcomeSegment {
  key: StatusColorKey;
  label: string;
  count: number;
}

/** The color of the tests a run counted but never reported: an interrupted run's unreached tests. */
const NOT_REPORTED: StatusColorKey = 'fixme';

/**
 * A run's tests split by outcome, in the dashboard's order, empty outcomes
 * left out. Flaky tests are a part of the passed ones, counted apart from them.
 * The tests a run counted but never reported (an interrupted run stops before
 * them) come last, as not reported.
 */
export function runSegments(counts: {
  totalTests?: number;
  passedTests: number;
  failedTests: number;
  flakyTests: number;
  skippedTests?: number;
  didNotRunTests?: number;
}): OutcomeSegment[] {
  const reported: OutcomeSegment[] = [
    { key: 'passed', label: 'passed', count: Math.max(0, (counts.passedTests ?? 0) - (counts.flakyTests ?? 0)) },
    { key: 'failed', label: 'failed', count: counts.failedTests ?? 0 },
    { key: 'flaky', label: 'flaky', count: counts.flakyTests ?? 0 },
    { key: 'skipped', label: 'skipped', count: counts.skippedTests ?? 0 },
    { key: 'didnotrun', label: "didn't run", count: counts.didNotRunTests ?? 0 },
  ];
  const sum = reported.reduce((total, s) => total + s.count, 0);
  const missing = (counts.totalTests ?? 0) - sum;
  return [...reported, { key: NOT_REPORTED, label: 'not reported', count: missing }].filter((s) => s.count > 0);
}

/**
 * `92%`, `3.3%`: whole from 10%, one decimal below. A share that is neither
 * all nor nothing never reads as `100%` or `0%`.
 */
export function percent(count: number, total: number): string {
  if (total <= 0) return '0%';
  const pct = (count / total) * 100;
  if (count > 0 && pct < 0.1) return '<0.1%';
  if (count < total && pct >= 99.5) return `${Math.min(99.9, Math.floor(pct * 10) / 10)}%`;
  const tenths = Math.round(pct * 10) / 10;
  return `${tenths >= 10 ? Math.round(pct) : tenths.toFixed(1)}%`;
}

/** The segments in words: `197 passed (92%) · 7 failed (3.3%)`. */
export function outcomeText(segments: OutcomeSegment[], total: number): string {
  if (total <= 0) return 'No tests';
  return segments.map((s) => `${s.count} ${s.label} (${percent(s.count, total)})`).join(' · ');
}

/** The colored square emoji of each outcome, for the channels that draw with text. */
export const OUTCOME_SQUARES: Record<StatusColorKey, string> = {
  passed: '🟩',
  failed: '🟥',
  flaky: '🟪',
  skipped: '⬜',
  fixme: '⬛',
  didnotrun: '🟧',
  running: '🟦',
};

/**
 * The segments as a bar of `width` squares, each outcome as many squares as
 * its share (largest remainders first), and at least one when it has a test.
 */
export function outcomeSquares(segments: OutcomeSegment[], total: number, width = 20): string {
  if (total <= 0 || segments.length === 0) return '';
  const exact = segments.map((s) => (s.count / total) * width);
  const counts = exact.map((x) => Math.max(1, Math.floor(x)));
  let left = width - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest);
  for (let k = 0; left > 0 && k < order.length; k++, left--) counts[order[k]!.i]!++;
  while (left < 0) {
    const widest = counts.indexOf(Math.max(...counts));
    counts[widest]!--;
    left++;
  }
  return segments.map((s, i) => OUTCOME_SQUARES[s.key].repeat(counts[i]!)).join('');
}

// ── History ───────────────────────────────────────────────────────────────────

/** A run's status as an outcome color: interrupted in the did-not-run amber. */
export function runStatusKey(status: string): StatusColorKey {
  if (status === 'passed') return 'passed';
  if (status === 'failed' || status === 'timedout') return 'failed';
  if (status === 'interrupted') return 'didnotrun';
  return 'skipped';
}

function isFailingRun(entry: RunHistoryEntry): boolean {
  return runStatusKey(entry.status) === 'failed';
}

/** How many entries at the end of a list in a row match, the last one included. */
function streak<T>(items: T[], match: (item: T) => boolean): number {
  let n = 0;
  for (let i = items.length - 1; i >= 0 && match(items[i]!); i--) n++;
  return n;
}

/** `Last 10 runs on main in staging`: what a history covers. */
export function historyLabel(history: RunHistoryEntry[], scope: { branch?: string; environment?: string }): string {
  return `Last ${runs(history.length)}${scope.branch ? ` on ${scope.branch}` : ''}${scope.environment ? ` in ${scope.environment}` : ''}`;
}

/**
 * What the history says about the last run: a first failure after a green
 * streak, a failure that keeps going, a return to green. Null with no earlier
 * run, and for a run that neither passed nor failed.
 */
export function historySentence(history: RunHistoryEntry[]): string | null {
  const current = history[history.length - 1];
  if (!current || history.length < 2) return null;
  const earlier = history.slice(0, -1);
  if (isFailingRun(current)) {
    const failing = streak(history, isFailingRun);
    if (failing > 1) {
      return failing === history.length
        ? `Failed in all of the last ${runs(failing)}`
        : `Failing for ${runs(failing)} in a row`;
    }
    const green = streak(earlier, (e) => e.status === 'passed');
    if (green === earlier.length) return `First failure in the last ${runs(history.length)}`;
    return green > 0 ? `First failure after ${runs(green, 'passing')}` : null;
  }
  if (current.status === 'passed') {
    const red = streak(earlier, isFailingRun);
    if (red > 0 && red === earlier.length) return `First pass in the last ${runs(history.length)}`;
    if (red > 0) return `Back to green after ${runs(red, 'failing')}`;
    const green = streak(history, (e) => e.status === 'passed');
    if (green < 2) return null;
    return green === history.length ? `Green in all of the last ${runs(green)}` : `Passing for ${runs(green)} in a row`;
  }
  return null;
}

/** The history as squares, one per run, oldest first. */
export function historySquares(history: RunHistoryEntry[]): string {
  return history.map((e) => OUTCOME_SQUARES[runStatusKey(e.status)]).join('');
}

const RUN_SYMBOLS: Record<StatusColorKey, string> = {
  passed: '✓',
  failed: '✗',
  flaky: '~',
  skipped: '-',
  fixme: '-',
  didnotrun: '!',
  running: '…',
};

/** The history in plain text: one symbol per run, then its sentence. */
export function historyText(history: RunHistoryEntry[]): string {
  if (history.length < 2) return '';
  const sentence = historySentence(history);
  return `Last ${runs(history.length)}: ${history.map((e) => RUN_SYMBOLS[runStatusKey(e.status)]).join(' ')}${sentence ? ` (${sentence})` : ''}`;
}

/**
 * What a test's own history says about its failure in the last run, and
 * whether that failure is new: only the runs that ran it count (a skipped or
 * did-not-run result is no pass), and the failure is new when the last of them
 * passed.
 */
export function testHistorySentence(outcomes: HistoryOutcome[]): { text: string; isNew: boolean } | null {
  if (outcomes[outcomes.length - 1] !== 'failed') return null;
  const ran = outcomes.slice(0, -1).filter((o) => o === 'passed' || o === 'flaky' || o === 'failed');
  if (ran.length === 0) return { text: 'No earlier result here', isNew: false };
  const failing = streak([...ran, 'failed'], (o) => o === 'failed');
  if (failing > 1) return { text: `Failed the last ${failing} times it ran`, isNew: false };
  const before = ran.filter((o) => o === 'failed').length;
  if (before > 0) return { text: `Also failed ${before} of the ${ran.length} times it ran before`, isNew: false };
  return {
    text: ran.length === 1 ? 'Passed the previous time it ran' : `Passed the ${ran.length} times it ran before`,
    isNew: true,
  };
}

/** A test's history as squares: its outcome in each run, a white square where it did not run. */
export function testHistorySquares(outcomes: HistoryOutcome[]): string {
  return outcomes.map((o) => (o ? OUTCOME_SQUARES[o] : '▫️')).join('');
}

// ── A failing test ────────────────────────────────────────────────────────────

/** A failing test's full name: its describe blocks, then its title. */
export function testPath(failure: Pick<TopFailure, 'title' | 'suitePath'>): string {
  return [...(failure.suitePath ?? []), failure.title].join(' › ');
}

/** Where a test is declared: `tests/a.spec.ts:12`. */
export function testLocation(failure: Pick<TopFailure, 'filePath' | 'line'>): string | null {
  if (!failure.filePath) return null;
  return failure.line != null ? `${failure.filePath}:${failure.line}` : failure.filePath;
}

/** Whether an error's first line already says what its headline says (`Error: page.goto: …` under `page.goto: …`). */
export function repeatsHeadline(excerpt: string | undefined, headline: string): boolean {
  const first = excerpt
    ?.split('\n')[0]
    ?.replace(/^\w*Error:\s*/, '')
    .trim();
  return Boolean(first && first.startsWith(headline.trim()));
}

/** The headline worth showing above a failure's error: none when the error's first line already says it. */
export function failureHeadline(failure: Pick<TopFailure, 'headline' | 'errorExcerpt'>): string | null {
  return failure.headline && !repeatsHeadline(failure.errorExcerpt, failure.headline) ? failure.headline : null;
}

export interface CodeRow {
  line: number;
  code: string;
  failing: boolean;
}

/**
 * Whether a failure's source is its test's own file. The reporter writes a
 * stack frame's path from the working directory and a test's from the
 * Playwright config's folder, so either can end with the other.
 */
export function sourceIsTestFile(failure: Pick<TopFailure, 'source' | 'filePath'>): boolean {
  const a = failure.source?.file;
  const b = failure.filePath;
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** How many leading spaces every non-blank line shares. */
function commonIndent(lines: string[]): number {
  const indents = lines.filter((line) => line.trim()).map((line) => /^ */.exec(line)![0].length);
  return indents.length ? Math.min(...indents) : 0;
}

/**
 * A captured snippet's numbered lines, without the indentation they share, so
 * the code keeps a narrow message's width. Rows that are not numbered lines (a
 * caret under the failing line) are left out.
 */
export function codeRows(source: FailureSource): CodeRow[] {
  const rows = parseSourceSnippet(source.snippet).filter((row) => row.line != null);
  const indent = commonIndent(rows.map((row) => row.code));
  return rows.map((row) => ({ line: row.line!, code: row.code.slice(indent), failing: row.failing }));
}

/** The rows as text, each behind its line number, the failing one marked: `› 42 │ code`. */
export function codeRowsText(rows: CodeRow[]): string {
  const width = Math.max(...rows.map((row) => String(row.line).length));
  return rows
    .map((row) => `${row.failing ? '›' : ' '} ${String(row.line).padStart(width)} │ ${row.code}`.trimEnd())
    .join('\n');
}

/** What a line of a Playwright error is: its first line, the expected value, the received one, or the rest. */
export type ErrorLineKind = 'head' | 'expected' | 'received' | 'body';

export function errorLines(excerpt: string): Array<{ text: string; kind: ErrorLineKind }> {
  return excerpt.split('\n').map((text, i) => {
    if (/^\s*Expected\b/.test(text)) return { text, kind: 'expected' };
    if (/^\s*Received\b/.test(text)) return { text, kind: 'received' };
    return { text, kind: i === 0 ? 'head' : 'body' };
  });
}

/** The labels shown beside a failing test's name: whether its failure is new, its project and its owner. */
export function failureMeta(failure: TopFailure): { isNew: boolean; story: string | null; labels: string[] } {
  const story = failure.history ? testHistorySentence(failure.history) : null;
  return {
    isNew: Boolean(story?.isNew),
    story: story?.text ?? null,
    labels: [failure.browserName, failure.owner].filter((label): label is string => Boolean(label)),
  };
}

// ── Digests ───────────────────────────────────────────────────────────────────

/** A digest message lists at most this many notifications; the rest are counted. */
export const DIGEST_ITEMS_LIMIT = 20;

/** The run whose tests a digest item draws by outcome, for the events about a whole run that carry its counts. */
export function digestRun(event: NotificationEvent, payload: NotificationPayload): RunFinishedPayload | null {
  if (!event.startsWith('run.') && event !== 'flakiness.spike') return null;
  const run = payload as RunFinishedPayload;
  return run.totalTests > 0 && run.passedTests != null ? run : null;
}

// ── Links, facts, sentences and actions ───────────────────────────────────────

/** Links into the dashboard, from its public address. */
export class DashboardLinks {
  constructor(readonly site: string) {}
  run = (runId: number) => `${this.site}/test-runs/${runId}`;
  cluster = (clusterId: number) => `${this.site}/failure-clusters/${clusterId}`;
  path = (path: string) => `${this.site}${path}`;
  /** A failing test's execution, else its history, else the run. */
  failure = (failure: TopFailure, runId: number) => {
    const path = failureTargetPath(failure);
    return path ? this.path(path) : this.run(runId);
  };
  bugReport = (bugId: number) => `${this.site}/bug-reports/${bugId}`;
  execution = (executionId: number) => `${this.site}/test-run-cases/${executionId}`;
}

/** One fact about an event: a label, a value, and where the value leads. */
export interface Fact {
  label: string;
  value: string;
  url?: string;
  /** The value is code (a commit, a branch, a host): set in a monospace font. */
  code?: boolean;
  /** Words after the value: a commit's subject and author. */
  note?: string;
}

function runFact(links: DashboardLinks, p: { runId: number; branch?: string }): Fact {
  return { label: 'Run', value: `#${p.runId}${p.branch ? ` on ${p.branch}` : ''}`, url: links.run(p.runId) };
}

function knownIssueFact(knownIssue?: { key: string; url: string }): Fact[] {
  return knownIssue ? [{ label: 'Tracked in', value: knownIssue.key, url: knownIssue.url }] : [];
}

function commitNote(message?: string, author?: string): string | undefined {
  const note = [message, author ? `by ${author}` : ''].filter(Boolean).join(' ');
  return note || undefined;
}

/** The facts an event's message lists, in every channel. */
export function eventFacts(event: NotificationEvent, payload: NotificationPayload, links: DashboardLinks): Fact[] {
  switch (event) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted':
    case 'flakiness.spike':
    case 'perf.regression': {
      const p = payload as RunFinishedPayload;
      const facts: Fact[] = [];
      if (p.commit) {
        facts.push({
          label: 'Commit',
          value: p.commit.sha.slice(0, 7),
          url: p.commit.url,
          code: true,
          note: commitNote(p.commit.message, p.commit.author),
        });
      }
      if (p.ciUrl) facts.push({ label: 'CI build', value: 'Open the build', url: p.ciUrl });
      if (event.startsWith('run.') && runOutcome(event, p) === 'failed' && p.owners?.length) {
        facts.push({ label: 'Owners', value: p.owners.join(', ') });
      }
      return facts;
    }
    case 'cluster.new': {
      const p = payload as ClusterNewPayload;
      return [
        runFact(links, p),
        ...knownIssueFact(p.knownIssue),
        ...(p.owners?.length ? [{ label: 'Owners', value: p.owners.join(', ') }] : []),
      ];
    }
    case 'cluster.fixed': {
      const p = payload as ClusterFixedPayload;
      const { triageNote } = clusterOutcome('cluster.fixed', p);
      const facts: Fact[] = [];
      if (p.commit) {
        facts.push({
          label: 'Fixed by',
          value: p.commit.slice(0, 7),
          code: true,
          note: commitNote(undefined, p.fixAuthor?.name),
        });
      } else if (p.fixAuthor) facts.push({ label: 'Fixed by', value: p.fixAuthor.name });
      if (p.timeToResolutionMs) facts.push({ label: 'Time to fix', value: durationApprox(p.timeToResolutionMs) });
      if (p.testCount) facts.push({ label: 'Tests', value: plural(p.testCount, 'test') });
      if (p.healPr) {
        facts.push({ label: 'Pull request', value: `#${p.healPr.number}, opened by auto-heal`, url: p.healPr.url });
      }
      facts.push(runFact(links, p), ...knownIssueFact(p.knownIssue));
      if (triageNote) facts.push({ label: 'Triage', value: triageNote });
      return facts;
    }
    case 'cluster.regressed': {
      const p = payload as ClusterRegressedPayload;
      const { triageNote } = clusterOutcome('cluster.regressed', p);
      return [
        ...(p.fixAuthor ? [{ label: 'Fix by', value: p.fixAuthor.name }] : []),
        ...knownIssueFact(p.knownIssue),
        ...(triageNote ? [{ label: 'Triage', value: triageNote }] : []),
      ];
    }
    case 'environment.incident': {
      const p = payload as EnvironmentIncidentPayload;
      return [
        runFact(links, p),
        ...(p.host ? [{ label: 'Host', value: p.host, code: true }] : []),
        { label: 'Failed', value: `${p.failedTests} of ${plural(p.totalTests, 'test')}` },
      ];
    }
    case 'test.stuck': {
      const p = payload as TestStuckPayload;
      const where = [p.browserName, p.workerIndex != null ? `worker ${p.workerIndex}` : null].filter(Boolean);
      return [
        runFact(links, p),
        ...(p.location ? [{ label: 'Test', value: p.location, code: true }] : []),
        ...(where.length ? [{ label: 'Running in', value: where.join(', ') }] : []),
        ...(p.owners?.length ? [{ label: 'Owners', value: p.owners.join(', ') }] : []),
        ...(p.ciUrl ? [{ label: 'CI build', value: 'Open the build', url: p.ciUrl }] : []),
      ];
    }
    case 'auto_heal.pr_opened': {
      const p = payload as AutoHealPrOpenedPayload;
      return [
        { label: 'Pull request', value: `#${p.prNumber}`, url: p.prUrl },
        { label: 'Branch', value: p.branch, code: true },
        { label: 'Edits', value: plural(p.editCount, 'locator edit') },
      ];
    }
    case 'diagnosis.completed':
    case 'bug.looks_fixed':
      return [];
  }
}

/**
 * What an event means, in sentences, the same in every channel. Code is set
 * between backticks; a channel without inline code shows them as they are.
 */
export function eventSentences(event: NotificationEvent, payload: NotificationPayload): string[] {
  switch (event) {
    case 'flakiness.spike': {
      const p = payload as RunFinishedPayload;
      return [
        `${plural(p.flakyTests, 'test')} failed at least once, then passed on a retry. A retry hides the failure from the run's verdict, not from the time it costs.`,
      ];
    }
    case 'perf.regression':
      return ['The usual time is the median of the last runs on the same branch and environment.'];
    case 'cluster.new': {
      const p = payload as ClusterNewPayload;
      return [
        (p.affectedCases ?? 0) > 1
          ? `${p.affectedCases} tests of run #${p.runId} failed with the same error, one no earlier run produced, so Piwi grouped them in one cluster.`
          : `A test of run #${p.runId} failed with an error no earlier run produced.`,
      ];
    }
    case 'cluster.fixed':
      return [
        (payload as ClusterFixedPayload).verification === 'diagnosis-verified'
          ? 'The commits since the last failure changed a file the diagnosis named, and every affected test passes again.'
          : 'Every test that failed with this error passes again.',
      ];
    case 'cluster.regressed': {
      const p = payload as ClusterRegressedPayload;
      return [
        p.fixLandedRunId != null
          ? `The fix landed in run #${p.fixLandedRunId}, and the error is back in run #${p.runId}.`
          : `The error is back in run #${p.runId}.`,
      ];
    }
    case 'environment.incident': {
      const p = payload as EnvironmentIncidentPayload;
      return [
        p.reason,
        ...(p.otherProjects > 0
          ? [`${plural(p.otherProjects, 'other project')} saw the same failure at the same time.`]
          : []),
        INCIDENT_NOTE,
      ];
    }
    case 'test.stuck':
      return [
        `The test has run more than ${STUCK_FACTOR} times as long as its longest pass among its last ${STUCK_HISTORY}, and over ${STUCK_FLOOR_MS / 60_000} minutes. It is still running: the run page shows the step it is in, and its live view, when the project has it on, what it waits for.`,
      ];
    case 'auto_heal.pr_opened': {
      const p = payload as AutoHealPrOpenedPayload;
      return [
        `Auto-heal rewrote the broken locators of run #${p.runId} in a pull request. Review it like any other change before merging it.`,
      ];
    }
    case 'bug.looks_fixed': {
      const p = payload as BugLooksFixedPayload;
      const one = p.tests.length === 1;
      return [
        `${one ? 'A test marked' : 'Tests marked'} \`test.fail()\` passed in run #${p.runId}: the ${one ? 'bug it reproduces' : 'bugs they reproduce'} no longer ${one ? 'shows' : 'show'}. Confirm the fix, then remove \`test.fail()\` so the test guards against a return.`,
      ];
    }
    default:
      return [];
  }
}

/** What an environment incident changes in Piwi's verdicts. */
export const INCIDENT_NOTE = 'Left out of flaky scores, baselines, fix verification and the gate (inconclusive).';

export interface MessageAction {
  label: string;
  url: string;
}

/** The longest button address Slack accepts. */
const ACTION_URL_MAX = 3000;

/**
 * The buttons of an event's message, the main one first: normalized http(s)
 * addresses within the length every channel accepts.
 */
export function eventActions(
  event: NotificationEvent,
  payload: NotificationPayload,
  links: DashboardLinks,
): MessageAction[] {
  return actionsOf(event, payload, links).flatMap((a) => {
    const url = safeHttpUrl(a.url) ? new URL(a.url).href : null;
    return url && url.length <= ACTION_URL_MAX ? [{ label: a.label, url }] : [];
  });
}

function actionsOf(event: NotificationEvent, payload: NotificationPayload, links: DashboardLinks): MessageAction[] {
  switch (event) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted':
    case 'flakiness.spike':
    case 'perf.regression': {
      const p = payload as RunFinishedPayload;
      return [
        { label: 'Open the run', url: links.run(p.runId) },
        ...(p.ciUrl ? [{ label: 'Open the CI build', url: p.ciUrl }] : []),
      ];
    }
    case 'cluster.new':
    case 'cluster.regressed': {
      const p = payload as ClusterNewPayload | ClusterRegressedPayload;
      return [
        { label: 'Open the cluster', url: links.cluster(p.clusterId) },
        { label: 'Open the run', url: links.run(p.runId) },
      ];
    }
    case 'cluster.fixed':
      return [{ label: 'Open the cluster', url: links.cluster((payload as ClusterFixedPayload).clusterId) }];
    case 'environment.incident':
    case 'bug.looks_fixed':
      return [{ label: 'Open the run', url: links.run((payload as EnvironmentIncidentPayload).runId) }];
    case 'test.stuck': {
      const p = payload as TestStuckPayload;
      return [
        { label: 'Open the test in its run', url: links.path(notificationTargetPath(event, p)!) },
        ...(p.ciUrl ? [{ label: 'Open the CI build', url: p.ciUrl }] : []),
      ];
    }
    case 'diagnosis.completed': {
      const p = payload as DiagnosisCompletedPayload;
      const path = notificationTargetPath(event, p);
      return [{ label: 'Open the diagnosis', url: path ? links.path(path) : links.cluster(p.clusterId) }];
    }
    case 'auto_heal.pr_opened': {
      const p = payload as AutoHealPrOpenedPayload;
      return [
        { label: 'Review the pull request', url: p.prUrl },
        { label: 'Open the run', url: links.run(p.runId) },
      ];
    }
  }
}

/** How many failing tests a run has, each counted once however many of its repetitions failed. */
export function failingTests(p: RunFinishedPayload): number {
  return p.failingTestCount ?? p.failedTests;
}

/** How many failing tests a run has beyond the ones its payload names. */
export function moreFailures(p: RunFinishedPayload): number {
  return Math.max(0, failingTests(p) - (p.topFailures?.length ?? 0));
}

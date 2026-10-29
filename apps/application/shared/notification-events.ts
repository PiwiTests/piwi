import { extractMessageHead, stripAnsi } from '#shared/error-fingerprint';
import { describeFailureText } from '#shared/describe-failure';
import { parseSourceSnippet } from '#shared/source-snippet';
import { splitSuitePath } from '#shared/utils/suites';

/** All notification event keys supported by the subscription system. */
export const NOTIFICATION_EVENTS = [
  'run.finished',
  'run.failed',
  'run.failed.default_branch',
  'run.interrupted',
  'cluster.new',
  'cluster.fixed',
  'cluster.regressed',
  'flakiness.spike',
  'perf.regression',
  'diagnosis.completed',
  'auto_heal.pr_opened',
  'bug.looks_fixed',
  'environment.incident',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/**
 * The events a new subscription starts with, and the events the desktop app
 * notifies on for a project whose events nobody chose.
 */
export const DEFAULT_SUBSCRIPTION_EVENTS: readonly NotificationEvent[] = ['run.failed', 'environment.incident'];

/**
 * Whether the desktop app leaves an event to its own notification: a `run.*`
 * event of a run it started (`desktop`). Its bisect steps and reproductions
 * send no run event at all.
 */
export function isDesktopAppRunEvent(type: string, origin: string | undefined): boolean {
  return type.startsWith('run.') && origin === 'desktop';
}

const EVENT_LABELS: Partial<Record<NotificationEvent, string>> = {
  'auto_heal.pr_opened': 'Auto-heal › PR opened',
  'bug.looks_fixed': 'Bug › looks fixed',
  'environment.incident': 'Environment incident',
};

/** How the subscription pickers name an event. */
export function notificationEventLabel(event: string): string {
  return EVENT_LABELS[event as NotificationEvent] ?? event.replace(/\./g, ' › ');
}

/**
 * A report schedule's delivery: queued in the notification outbox by the
 * `reports:schedule` task, one row per channel. Not a member of
 * {@link NOTIFICATION_EVENTS}: a quality report arrives on its schedule's
 * clock, so it is never something to subscribe to.
 */
export const REPORT_READY_EVENT = 'report.ready';

export interface ReportReadyPayload {
  snapshotId: number;
  scheduleId: number;
  /** The last day the report covers, `YYYY-MM-DD` in the schedule's time zone. */
  periodEnd: string;
  /** The snapshot's share link token, encrypted at rest; set when the schedule includes a share link. */
  shareToken?: string;
}

/** How many failing tests to embed in a run notification. */
export const TOP_FAILURES_LIMIT = 3;
/** Max characters kept from an error message embedded in a notification. */
export const ERROR_EXCERPT_MAX = 300;
/** How many runs a run notification's history holds, the run itself included. */
export const RUN_HISTORY_LIMIT = 10;
/** Source lines kept before and after the failing line of a {@link FailureSource}. */
export const SOURCE_LINES_BEFORE = 4;
export const SOURCE_LINES_AFTER = 2;
/** How many prior completed runs the perf-regression baseline is computed from. */
export const PERF_BASELINE_RUNS = 5;
/** Minimum prior runs required before a perf-regression baseline is trusted. */
export const PERF_BASELINE_MIN_RUNS = 2;
/** How much slower than baseline (percent) a run must be to emit perf.regression. */
export const PERF_REGRESSION_MIN_PCT = 20;

/** The source lines around the line a failure threw at, as the reporter captured them. */
export interface FailureSource {
  /** Project-relative path of the file the lines come from: the test file, or a helper it called. */
  file: string;
  /** The 1-based line the failure threw at. */
  line: number;
  /** Rows `<marker><line no> | <code>`, `>` on the failing line (`shared/source-snippet.ts`). */
  snippet: string;
}

/** A test's outcome in one run: a status key of `STATUS_COLORS`, or null when the run did not report the test. */
export type HistoryOutcome = 'passed' | 'flaky' | 'failed' | 'skipped' | 'didnotrun' | null;

/** A single failing test embedded in a run notification for debugging context. */
export interface TopFailure {
  title: string;
  filePath?: string;
  /** The describe blocks the test is declared in, outermost first. */
  suitePath?: string[];
  /** The line the test is declared on. */
  line?: number;
  /** The Playwright project the test failed in (`chromium`). */
  browserName?: string;
  /** The test's owner, from `piwi:owner` or CODEOWNERS. */
  owner?: string;
  /** The one-line failure headline (`getByLabel('Email') was not found on the page — fill timed out after 10 s`). */
  headline?: string;
  /** The error's message head, ANSI-stripped and capped at {@link ERROR_EXCERPT_MAX} characters. */
  errorExcerpt?: string;
  /** The code around the line the failure threw at, cut to a few lines. */
  source?: FailureSource;
  /** The test's outcome in each run of the payload's `history`, in the same order. */
  history?: HistoryOutcome[];
  testCaseId?: number;
  executionId?: number;
}

/** One run of a run notification's history. */
export interface RunHistoryEntry {
  runId: number;
  status: string;
  failedTests: number;
}

/** The commit a run tested, as the reporter recorded it. */
export interface RunCommit {
  sha: string;
  message?: string;
  author?: string;
  /** The commit's page on the project's repository host. */
  url?: string;
}

/**
 * The branch and environment of the run an event comes from. Every payload of a
 * {@link RUN_SCOPED_EVENTS} event carries them when the run reported them.
 */
export interface RunScope {
  branch?: string;
  environment?: string;
}

export interface RunFinishedPayload extends RunScope {
  runId: number;
  projectId: number;
  projectName: string;
  status: string;
  totalTests: number;
  failedTests: number;
  /** Passed tests, flaky ones included. */
  passedTests: number;
  flakyTests: number;
  skippedTests?: number;
  didNotRunTests?: number;
  isDefaultBranch?: boolean;
  flakinessRate?: number; // 0-1
  /** Duration of the run in milliseconds. */
  durationMs?: number;
  /** Median duration (ms) of the prior runs a perf regression was measured against. */
  baselineDurationMs?: number;
  /** How much slower this run is than the baseline, in percent. */
  regressionPct?: number;
  topFailures?: TopFailure[];
  /**
   * How many failing tests `topFailures` was chosen from: each test once per
   * Playwright project, however many of its repetitions failed, where
   * `failedTests` counts every failed repetition.
   */
  failingTestCount?: number;
  /**
   * Distinct owners of the run's failing tests — from `piwi:owner` where a test
   * declares one, otherwise CODEOWNERS. Lets a subscription route a run only to
   * the team responsible for what broke.
   */
  owners?: string[];
  /** The commit the run tested. */
  commit?: RunCommit;
  /** The CI build that ran the tests. */
  ciUrl?: string;
  /** What launched the run, as `test_runs.origin` stores it: `ci`, `local`, `desktop`, `reproduce`, … */
  origin?: string;
  /**
   * The last {@link RUN_HISTORY_LIMIT} runs on the run's branch and environment
   * that send notifications, oldest first, this run last.
   */
  history?: RunHistoryEntry[];
}

export interface ClusterNewPayload extends RunScope {
  clusterId: number;
  projectId: number;
  projectName: string;
  signature: string;
  /** Display name — the AI title when one exists, else the deterministic title. */
  title?: string | null;
  runId: number;
  sampleErrorExcerpt?: string;
  affectedCases?: number;
  /** The tracker issue the cluster is known by, named in the message when set. */
  knownIssue?: { key: string; url: string };
  /** Distinct owners of the tests that failed into the cluster in this run, resolved as for {@link RunFinishedPayload}. */
  owners?: string[];
}

/**
 * Trim, strip ANSI colour codes, and cap a text so it can be embedded in a
 * notification payload (and rendered in email/Slack) without bloating it.
 * Returns undefined for empty input.
 */
export function truncateExcerpt(text?: string | null, max: number = ERROR_EXCERPT_MAX): string | undefined {
  if (!text) return undefined;
  const clean = stripAnsi(text).trim();
  if (!clean) return undefined;
  return clean.length > max ? clean.slice(0, max).trimEnd() + '…' : clean;
}

/** A message head that says nothing but that a timeout elapsed. */
const BARE_TIMEOUT_RE = /^(?:\w*Error:\s*)?(?:[\w.]+:\s*)?(?:Test )?[Tt]imeout(?: of)? \d+m?s exceeded\.?$/;
/** Call-log lines that say where Playwright was when the timeout hit. */
const CALL_LOG_STATE_RE = /^\s*-\s*((?:waiting for|locator resolved to)\b.*)$/;

/**
 * The part of an error worth quoting outward — in a notification, a
 * pull-request comment, a digest: the message head (the lines before the
 * Playwright call log and the stack trace, at most five), with the last
 * `waiting for …` / `locator resolved to …` call-log line appended when the
 * head is only a bare timeout. ANSI codes are stripped and the result is
 * capped at `max` characters. Returns undefined for empty input.
 */
export function errorExcerpt(text?: string | null, max: number = ERROR_EXCERPT_MAX): string | undefined {
  if (!text) return undefined;
  const clean = stripAnsi(text).trim();
  if (!clean) return undefined;
  let head = extractMessageHead(clean) || clean.split('\n')[0]!.trim();
  if (BARE_TIMEOUT_RE.test(head)) {
    const state = lastCallLogState(clean);
    if (state) head = `${head}\n${state}`;
  }
  return truncateExcerpt(head, max);
}

function lastCallLogState(text: string): string | null {
  const start = text.indexOf('Call log:');
  if (start === -1) return null;
  let last: string | null = null;
  for (const line of text.slice(start).split('\n')) {
    const match = CALL_LOG_STATE_RE.exec(line);
    if (match) last = match[1]!.trim();
  }
  return last;
}

/**
 * Dashboard path for one failing test: the execution with its evidence when
 * the payload carries one, otherwise the test's history page.
 */
export function failureTargetPath(failure: Pick<TopFailure, 'testCaseId' | 'executionId'>): string | null {
  if (failure.executionId != null) return `/test-run-cases/${failure.executionId}`;
  if (failure.testCaseId != null) return `/test-cases/${failure.testCaseId}`;
  return null;
}

/** Raw failing-case row shape consumed by {@link buildTopFailures}. */
export interface TopFailureInput {
  title: string;
  filePath?: string | null;
  /** The describe blocks, `\x1f`-delimited as stored. */
  suitePath?: string | null;
  line?: number | null;
  browserName?: string | null;
  owner?: string | null;
  error?: string | null;
  /** The whole captured snippet; {@link buildTopFailures} cuts it. */
  source?: FailureSource | null;
  history?: HistoryOutcome[] | null;
  testCaseId?: number | null;
  executionId?: number | null;
}

/** The longest code line a payload keeps; a longer one ends in an ellipsis. */
export const SOURCE_LINE_MAX = 200;

function capLine(code: string): string {
  return code.length > SOURCE_LINE_MAX ? `${code.slice(0, SOURCE_LINE_MAX - 1)}…` : code;
}

/**
 * The rows of a captured snippet from {@link SOURCE_LINES_BEFORE} lines before
 * its `>`-marked line to {@link SOURCE_LINES_AFTER} lines after it, with the
 * caret row under a kept line, each line cut to {@link SOURCE_LINE_MAX}
 * characters. Null when no row is marked.
 */
export function cutSourceSnippet(snippet: string): string | null {
  const rows = parseSourceSnippet(stripAnsi(snippet));
  const failing = rows.find((row) => row.failing)?.line;
  if (failing == null) return null;
  const kept: string[] = [];
  let keepingRow = false;
  for (const row of rows) {
    if (row.line != null)
      keepingRow = row.line >= failing - SOURCE_LINES_BEFORE && row.line <= failing + SOURCE_LINES_AFTER;
    if (keepingRow) kept.push(`${row.gutter}${capLine(row.code)}`.trimEnd());
  }
  return kept.join('\n');
}

/**
 * Map raw failing-case rows to the compact {@link TopFailure} shape embedded in
 * run notifications: capped to `limit` entries, each error described by its
 * headline and cut to its {@link errorExcerpt}, its source cut by
 * {@link cutSourceSnippet}.
 */
export function buildTopFailures(rows: TopFailureInput[], limit: number = TOP_FAILURES_LIMIT): TopFailure[] {
  return rows.slice(0, limit).map((r) => {
    const failure: TopFailure = { title: r.title };
    if (r.filePath) failure.filePath = r.filePath;
    const suitePath = splitSuitePath(r.suitePath);
    if (suitePath.length) failure.suitePath = suitePath;
    if (r.line != null) failure.line = r.line;
    if (r.browserName) failure.browserName = r.browserName;
    if (r.owner) failure.owner = r.owner;
    if (r.testCaseId != null) failure.testCaseId = r.testCaseId;
    if (r.executionId != null) failure.executionId = r.executionId;
    const headline = describeFailureText(r.error)?.headline;
    if (headline) failure.headline = headline;
    const excerpt = errorExcerpt(r.error);
    if (excerpt) failure.errorExcerpt = excerpt;
    const snippet = r.source ? cutSourceSnippet(r.source.snippet) : null;
    if (r.source && snippet) failure.source = { file: r.source.file, line: r.source.line, snippet };
    if (r.history?.length) failure.history = r.history;
    return failure;
  });
}

/**
 * The author of a fixing commit, resolved through the SCM provider when a token
 * exists. Lets the fix outcome reach the person who did the work directly — by
 * email when the address belongs to a registered Piwi user, and as a targeted
 * browser notification for that user — on top of the normal subscription
 * routing. Absent when no token is configured or the host exposes no email.
 */
export interface FixAuthor {
  name: string;
  email: string;
}

/** An auto-heal pull request, named on the fix it landed. */
export interface HealPrRef {
  number: number;
  url: string;
  /** The heal action that opened it. */
  actionId: number;
}

/** A cluster whose every affected test passed again. */
export interface ClusterFixedPayload extends RunScope {
  clusterId: number;
  projectId: number;
  projectName: string;
  signature: string;
  /** The cluster's display title when it has one. */
  title?: string | null;
  /** The run in which the fix landed. */
  runId: number;
  /** `diagnosis-verified` when the commits since the last failure touched a file the diagnosis named. */
  verification: 'stopped-failing' | 'diagnosis-verified';
  commit?: string | null;
  timeToResolutionMs?: number | null;
  /** Tests that were failing and now pass. */
  testCount?: number;
  /** True when this verdict also moved the triage status from open to resolved. */
  resolved?: boolean;
  /** Author of the fixing commit ({@link commit}), when it could be resolved. */
  fixAuthor?: FixAuthor;
  /** The tracker issue the cluster is known by, named in the message when set. */
  knownIssue?: { key: string; url: string };
  /** The auto-heal pull request whose commit (its `Piwi-Heal` trailer) landed the fix. */
  healPr?: HealPrRef;
}

/** A cluster with a recorded fix that is failing again. */
export interface ClusterRegressedPayload extends RunScope {
  clusterId: number;
  projectId: number;
  projectName: string;
  signature: string;
  title?: string | null;
  /** The run that failed the cluster again. */
  runId: number;
  /** The run the fix had landed in. */
  fixLandedRunId: number | null;
  /** True when this verdict also moved the triage status from resolved back to open. */
  reopened?: boolean;
  /** Author of the fix that did not hold, when it could be resolved. */
  fixAuthor?: FixAuthor;
  /** The tracker issue the cluster is known by, named in the message when set. */
  knownIssue?: { key: string; url: string };
}

export interface DiagnosisCompletedPayload {
  clusterId: number;
  /** For a diagnosis of one failure in the cluster: that execution, which the notification opens. */
  executionId?: number;
  projectId: number;
  /** Epoch ms of this completion — distinguishes re-diagnoses of the same cluster. */
  completedAt?: number;
  summary?: string | null;
  rootCause?: string | null;
  category?: string | null;
  confidence?: string | null;
}

export interface AutoHealPrOpenedPayload {
  projectId: number;
  projectName: string;
  /** The run whose failures triggered the heal. */
  runId: number;
  prNumber: number;
  prUrl: string;
  branch: string;
  /** How many locator edits the PR carries. */
  editCount: number;
}

/** One `test.fail()` test that passed: the bug it reproduces looks fixed. */
export interface LooksFixedTest {
  title: string;
  filePath: string;
  executionId: number;
  testCaseId: number;
  /** The Piwi bug report the test names with `piwi:bug`. */
  bugId?: number;
  /** The ticket the test names with `piwi:link`. */
  link?: string;
}

export interface BugLooksFixedPayload extends RunScope {
  projectId: number;
  projectName: string;
  runId: number;
  tests: LooksFixedTest[];
}

/**
 * A run flagged as an environment incident: its failures come from the
 * environment under test, so it sends this one event in place of the run's
 * failure, flakiness, performance and new-cluster events.
 */
export interface EnvironmentIncidentPayload extends RunScope {
  runId: number;
  projectId: number;
  projectName: string;
  status: string;
  totalTests: number;
  failedTests: number;
  isDefaultBranch?: boolean;
  /** What launched the run, as for {@link RunFinishedPayload}. */
  origin?: string;
  /** The rule that flagged the run (`host-unreachable`, `browser-crash`, `cross-project`). */
  rule: string;
  /** One sentence: how many tests failed, and reaching which host. */
  reason: string;
  /** The app's host the failures were reaching, when one stood out. */
  host?: string;
  /** How many other projects saw the same host or error fail within the window. */
  otherProjects: number;
  /**
   * The same value for every run of one incident across projects: a channel
   * that hears from several of them receives one message.
   */
  incidentKey: string;
}

export type NotificationPayload =
  | RunFinishedPayload
  | ClusterNewPayload
  | ClusterFixedPayload
  | ClusterRegressedPayload
  | DiagnosisCompletedPayload
  | AutoHealPrOpenedPayload
  | BugLooksFixedPayload
  | EnvironmentIncidentPayload;

/** Per-subscription delivery filters, stored as JSON on the subscription row. */
export interface SubscriptionFilters {
  /** Only deliver events from runs on these branches; `*` matches any characters (`release/*`). */
  branches?: string[];
  /** Only deliver events from runs in these environments; `*` matches any characters. */
  environments?: string[];
  tags?: string[];
  statuses?: string[];
  defaultBranchOnly?: boolean;
  /** Only deliver when one of these owns a failing test behind the event ({@link OWNER_SCOPED_EVENTS}). */
  owners?: string[];
  /** Minimum flakiness rate (0-1) for flakiness.spike deliveries. */
  flakinessThreshold?: number;
  /** Minimum slowdown percent for perf.regression deliveries. */
  perfRegressionPct?: number;
}

/**
 * Events that come from one run and carry its {@link RunScope}: the branch and
 * environment filters apply to them. `auto_heal.pr_opened` names the pull
 * request's branch, and `diagnosis.completed` is about a cluster across runs.
 */
export const RUN_SCOPED_EVENTS: ReadonlySet<NotificationEvent> = new Set<NotificationEvent>([
  'run.finished',
  'run.failed',
  'run.failed.default_branch',
  'run.interrupted',
  'flakiness.spike',
  'perf.regression',
  'cluster.new',
  'cluster.fixed',
  'cluster.regressed',
  'bug.looks_fixed',
  'environment.incident',
]);

/**
 * Events whose payload names the owners of the tests behind it: the owners
 * filter applies to them, and one with no owner is not delivered to an
 * owner-scoped subscription.
 */
export const OWNER_SCOPED_EVENTS: ReadonlySet<NotificationEvent> = new Set<NotificationEvent>([
  'run.finished',
  'run.failed',
  'run.failed.default_branch',
  'flakiness.spike',
  'perf.regression',
  'cluster.new',
]);

/**
 * Whether a branch or environment name matches one of the patterns: an exact
 * name, or a pattern where `*` matches any run of characters, `/` included.
 */
export function matchesNamePattern(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes('*')) return pattern === name;
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}$`).test(name);
  });
}

/** Whether an event/payload passes a subscription's delivery filters. */
export function passesSubscriptionFilters(
  filters: SubscriptionFilters | null | undefined,
  event: NotificationEvent,
  payload: NotificationPayload,
): boolean {
  if (!filters) return true;

  const runPayload = payload as RunFinishedPayload;

  if (RUN_SCOPED_EVENTS.has(event)) {
    // A run that reported no branch (or environment) is on none of the listed ones.
    const { branch, environment } = payload as RunScope;
    if (filters.branches?.length && !(branch && matchesNamePattern(branch, filters.branches))) return false;
    if (filters.environments?.length && !(environment && matchesNamePattern(environment, filters.environments))) {
      return false;
    }
  }
  if (filters.defaultBranchOnly && event.startsWith('run.')) {
    if (!runPayload.isDefaultBranch) return false;
  }
  if (filters.statuses?.length && event.startsWith('run.') && runPayload.status) {
    if (!filters.statuses.includes(runPayload.status)) return false;
  }
  if (filters.owners?.length && OWNER_SCOPED_EVENTS.has(event)) {
    // No owner on the payload means nothing failed, or ownership could not be
    // resolved. Either way an owner-scoped subscription has nothing to say.
    const owners = (payload as { owners?: string[] }).owners ?? [];
    if (!owners.some((owner) => filters.owners!.includes(owner))) return false;
  }
  // An incident is about the environment, not anyone's tests: a subscription
  // scoped to owners does not hear about it.
  if (filters.owners?.length && event === 'environment.incident') return false;
  if (filters.flakinessThreshold != null && event === 'flakiness.spike') {
    const rate = runPayload.flakinessRate ?? 0;
    if (rate < filters.flakinessThreshold) return false;
  }
  if (filters.perfRegressionPct != null && event === 'perf.regression') {
    const pct = runPayload.regressionPct ?? 0;
    if (pct < filters.perfRegressionPct) return false;
  }

  return true;
}

/**
 * A subscription's filters in words, one entry per filter set: what the
 * subscription lists show under each row. Empty when nothing is filtered.
 */
export function describeSubscriptionFilters(filters: SubscriptionFilters | null | undefined): string[] {
  if (!filters) return [];
  const parts: string[] = [];
  if (filters.branches?.length) parts.push(`Branch: ${filters.branches.join(', ')}`);
  if (filters.environments?.length) parts.push(`Environment: ${filters.environments.join(', ')}`);
  if (filters.defaultBranchOnly) parts.push('Default branch only');
  if (filters.statuses?.length) parts.push(`Status: ${filters.statuses.join(', ')}`);
  if (filters.owners?.length) parts.push(`Owner: ${filters.owners.join(', ')}`);
  if (filters.flakinessThreshold != null) parts.push(`Flakiness ≥ ${Math.round(filters.flakinessThreshold * 100)}%`);
  if (filters.perfRegressionPct != null) parts.push(`Slowdown ≥ ${filters.perfRegressionPct}%`);
  return parts;
}

/**
 * Idempotency key for one logical notification to one channel. Keyed on the
 * entity the event is about — the run for run-scoped events, the cluster for
 * cluster.new (one run can surface several new clusters), the cluster plus the
 * run for cluster.fixed / cluster.regressed (a cluster can be fixed and regress
 * more than once), the cluster plus completion time for
 * diagnosis.completed (the same cluster can be re-diagnosed), and the incident
 * for environment.incident (one incident can flag runs in several projects).
 */
export function buildNotificationDedupeKey(
  event: NotificationEvent,
  payload: NotificationPayload,
  channelId: number,
): string {
  if (event === 'cluster.new') {
    const p = payload as ClusterNewPayload;
    return `${event}:c${p.clusterId}:${channelId}`;
  }
  if (event === 'cluster.fixed' || event === 'cluster.regressed') {
    const p = payload as ClusterFixedPayload;
    return `${event}:c${p.clusterId}:r${p.runId}:${channelId}`;
  }
  if (event === 'diagnosis.completed') {
    const p = payload as DiagnosisCompletedPayload;
    const execution = p.executionId ? `:e${p.executionId}` : '';
    return `${event}:c${p.clusterId}${execution}:${p.completedAt ?? 'x'}:${channelId}`;
  }
  if (event === 'environment.incident') {
    const p = payload as EnvironmentIncidentPayload;
    return `${event}:${p.incidentKey}:${channelId}`;
  }
  const runId = (payload as RunFinishedPayload).runId;
  return `${event}:r${runId ?? 'x'}:${channelId}`;
}

/**
 * Perf-regression baseline: the median duration of prior completed runs, and how
 * much slower the current run is. Returns null when there are fewer than
 * {@link PERF_BASELINE_MIN_RUNS} usable prior durations or the current duration
 * is not positive.
 */
export function computePerfBaseline(
  priorDurationsMs: number[],
  currentDurationMs: number,
): { baselineDurationMs: number; regressionPct: number } | null {
  const usable = priorDurationsMs.filter((d) => d > 0);
  if (currentDurationMs <= 0 || usable.length < PERF_BASELINE_MIN_RUNS) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const baselineDurationMs = sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  if (baselineDurationMs <= 0) return null;
  const regressionPct = ((currentDurationMs - baselineDurationMs) / baselineDurationMs) * 100;
  return { baselineDurationMs, regressionPct };
}

/** Dashboard path the notification links to, or null when it has no target. */
export function notificationTargetPath(event: NotificationEvent, payload: NotificationPayload): string | null {
  if (event === 'diagnosis.completed' && (payload as DiagnosisCompletedPayload).executionId) {
    return `/test-run-cases/${(payload as DiagnosisCompletedPayload).executionId}`;
  }
  if (
    event === 'cluster.new' ||
    event === 'cluster.fixed' ||
    event === 'cluster.regressed' ||
    event === 'diagnosis.completed'
  ) {
    const clusterId = (payload as ClusterNewPayload).clusterId;
    return clusterId ? `/failure-clusters/${clusterId}` : null;
  }
  const runId = (payload as RunFinishedPayload).runId;
  return runId ? `/test-runs/${runId}` : null;
}

/** What a `cluster.fixed` / `cluster.regressed` verdict says: its headline, and the triage change it made, if any. */
export function clusterOutcome(
  event: 'cluster.fixed' | 'cluster.regressed',
  payload: ClusterFixedPayload | ClusterRegressedPayload,
): { headline: string; triageNote: string | null } {
  if (event === 'cluster.fixed') {
    const p = payload as ClusterFixedPayload;
    return {
      headline: p.verification === 'diagnosis-verified' ? 'Diagnosis verified' : 'Cluster stopped failing',
      triageNote: p.resolved ? 'Triage status set to resolved.' : null,
    };
  }
  return {
    headline: 'Fix regressed',
    triageNote: (payload as ClusterRegressedPayload).reopened ? 'Triage status set back to open.' : null,
  };
}

/** Subject / title line for each event type. */
export function renderEventSubject(event: NotificationEvent, payload: NotificationPayload): string {
  switch (event) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch': {
      const p = payload as RunFinishedPayload;
      return `Test run ${p.status} — ${p.projectName}${p.branch ? ` (${p.branch})` : ''}`;
    }
    case 'run.interrupted': {
      const p = payload as RunFinishedPayload;
      return `Test run interrupted — ${p.projectName}${p.branch ? ` (${p.branch})` : ''}`;
    }
    case 'cluster.new': {
      const p = payload as ClusterNewPayload;
      return `New failure cluster — ${p.projectName}`;
    }
    case 'cluster.fixed':
    case 'cluster.regressed': {
      const p = payload as ClusterFixedPayload | ClusterRegressedPayload;
      return `${clusterOutcome(event, p).headline} — ${p.projectName}`;
    }
    case 'flakiness.spike': {
      const p = payload as RunFinishedPayload;
      return `Flakiness spike — ${p.projectName}`;
    }
    case 'perf.regression': {
      const p = payload as RunFinishedPayload;
      const pct = p.regressionPct != null ? ` (+${Math.round(p.regressionPct)}% slower)` : '';
      return `Performance regression — ${p.projectName}${pct}`;
    }
    case 'diagnosis.completed': {
      return 'Diagnosis complete';
    }
    case 'auto_heal.pr_opened': {
      const p = payload as AutoHealPrOpenedPayload;
      return `Auto-heal opened PR #${p.prNumber} — ${p.projectName}`;
    }
    case 'environment.incident': {
      const p = payload as EnvironmentIncidentPayload;
      return `Environment incident — ${p.projectName}${p.host ? ` (${p.host})` : ''}`;
    }
    case 'bug.looks_fixed': {
      const p = payload as BugLooksFixedPayload;
      const [first] = p.tests;
      if (p.tests.length === 1 && first) {
        const what = first.bugId ? `Bug #${first.bugId} looks fixed` : 'A bug looks fixed';
        return `${what} — ${p.projectName}`;
      }
      return `${p.tests.length} bugs look fixed — ${p.projectName}`;
    }
  }
}

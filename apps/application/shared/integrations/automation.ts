/**
 * The rules for the writes Piwi makes to a tracker on its own, without a person
 * clicking: when a failure is filed automatically, and which runs the automatic
 * comments, transitions and description updates react to.
 *
 * - **Run scope** — branches (names, `*` patterns, or the project's default
 *   branch whatever its name) and environments. A run outside a scope is
 *   invisible to what the scope governs: it neither counts toward a threshold
 *   nor triggers a write.
 * - **Automatic-creation rules** — a run scope, optional test tags, and three
 *   thresholds counted only in that scope: failures, distinct runs, and days
 *   since the first counted failure. The first rule a failure meets files it;
 *   a failure that meets none yet waits.
 * - **Guards** — a cluster that is not open, is snoozed, is already tracked,
 *   shows flakiness, or whose owner matches no route (when routes exist and
 *   unmatched owners are not filed) is never filed automatically.
 *
 * Pure and provider-neutral: the server reads the facts from its database
 * (`server/utils/integrations/automation.ts`), the demo from its own, and both
 * decide here, so every tracker follows the same rules.
 */
import { matchesNamePattern } from '#shared/notification-events';
import { runEnvironmentMatches, type RunEnvironmentSelectable } from '#shared/environments';
import { sha256Hex } from '#shared/utils/hash';
import { pickOwnerRoute, type OwnerRoute } from './owner-routes';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Patterns, tags or labels one list keeps. */
const MAX_LIST_ITEMS = 20;
/** Rules one binding keeps. */
export const MAX_AUTO_CREATE_RULES = 10;

// ── Run scope ────────────────────────────────────────────────────────────────

/** Which runs a rule or the automatic write-backs follow. */
export interface TrackerRunScope {
  /** Branch names or `*` patterns (`release/*`). */
  branches: string[];
  /** The project's default branch, whatever it is named. */
  defaultBranch: boolean;
  /**
   * Environment keys, labels or `*` patterns, matched against the run's environment ignoring case
   * (`runEnvironmentMatches`); every environment when empty.
   */
  environments: string[];
}

/** Every run: no branch and no environment named. */
export const ANY_RUN_SCOPE: TrackerRunScope = { branches: [], defaultBranch: false, environments: [] };

/** The run fields a scope reads: its branch, and its label and the key and aliases of its environment. */
export interface ScopedRun extends RunEnvironmentSelectable {
  branch: string | null;
  environment: string | null;
  isDefaultBranch: boolean;
}

/**
 * Whether a run is in a scope. With no branch named and the default branch
 * off, every branch is in it; otherwise the run's branch is the default
 * branch (when that is on) or matches a pattern. With environments named, the
 * run's environment is one of them (`runEnvironmentMatches`). A run that
 * reported no branch (or environment) matches no named one.
 */
export function runInScope(scope: TrackerRunScope, run: ScopedRun): boolean {
  const anyBranch = scope.branches.length === 0 && !scope.defaultBranch;
  const branchMatches =
    anyBranch ||
    (scope.defaultBranch && run.isDefaultBranch) ||
    (run.branch != null && scope.branches.length > 0 && matchesNamePattern(run.branch, scope.branches));
  if (!branchMatches) return false;
  if (scope.environments.length === 0) return true;
  return runEnvironmentMatches(run, scope.environments);
}

/** Trim, drop empties, cap length and count, and dedupe a list of strings. */
export function normalizeList(value: unknown, maxLength = 100): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.slice(0, maxLength));
  return [...new Set(cleaned)].slice(0, MAX_LIST_ITEMS);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Normalize an arbitrary (possibly untrusted) scope. */
export function resolveRunScope(raw: unknown): TrackerRunScope {
  const r = (raw ?? {}) as Partial<Record<keyof TrackerRunScope, unknown>>;
  return {
    branches: normalizeList(r.branches),
    defaultBranch: r.defaultBranch === true,
    environments: normalizeList(r.environments),
  };
}

/** A scope in words, for the settings form and the preview: "the default branch, release/* in staging". */
export function describeRunScope(scope: TrackerRunScope): string {
  const branches = [...(scope.defaultBranch ? ['the default branch'] : []), ...scope.branches];
  const where = branches.length ? branches.join(', ') : 'every branch';
  return scope.environments.length ? `${where} in ${scope.environments.join(', ')}` : where;
}

// ── Automatic creation ───────────────────────────────────────────────────────

/** One automatic-creation rule: the runs it counts, the tests it covers, and its thresholds. */
export interface AutoCreateRule extends TrackerRunScope {
  /** Only failures of a test carrying one of these tags (`@` optional); every test when empty. */
  tags: string[];
  /** Occurrences counted in the rule's runs. */
  minOccurrences: number;
  /** Distinct runs, among the rule's runs, in which it failed. */
  minRuns: number;
  /** Days since the first failure the rule counted. */
  minDays: number;
  /** Labels added to an issue this rule files. */
  labels: string[];
}

/** The rule a fresh binding starts with: twice, in two runs, on the default branch. */
export const DEFAULT_AUTO_CREATE_RULE: AutoCreateRule = {
  branches: [],
  defaultBranch: true,
  environments: [],
  tags: [],
  minOccurrences: 2,
  minRuns: 2,
  minDays: 0,
  labels: [],
};

/** Automatic creation for one project binding. */
export interface AutoCreatePolicy {
  /** Master switch, off by default. */
  enabled: boolean;
  /** Checked in order: the first rule a failure meets files it. */
  rules: AutoCreateRule[];
  /** Leave out a failure whose tests show flakiness. */
  skipFlaky: boolean;
  /** Issues filed automatically per project in any 24 hours. */
  dailyCap: number;
  /** File clusters whose owner matches no route into the binding's default project. */
  routeUnmatchedToDefault: boolean;
}

export const DEFAULT_AUTO_CREATE: AutoCreatePolicy = {
  enabled: false,
  rules: [DEFAULT_AUTO_CREATE_RULE],
  skipFlaky: true,
  dailyCap: 5,
  routeUnmatchedToDefault: false,
};

/** Normalize an arbitrary (possibly untrusted) rule onto the defaults. */
export function resolveAutoCreateRule(raw: unknown): AutoCreateRule {
  const r = (raw ?? {}) as Partial<Record<keyof AutoCreateRule, unknown>>;
  const d = DEFAULT_AUTO_CREATE_RULE;
  const branches = normalizeList(r.branches);
  return {
    branches,
    // Left unset, a rule that names no branch follows the default branch.
    defaultBranch: r.defaultBranch === undefined ? branches.length === 0 : r.defaultBranch === true,
    environments: normalizeList(r.environments),
    tags: [...new Set(normalizeList(r.tags).map((tag) => tag.replace(/^@/, '')))].filter(Boolean),
    minOccurrences: clampInt(r.minOccurrences, 1, 1000, d.minOccurrences),
    minRuns: clampInt(r.minRuns, 1, 100, d.minRuns),
    minDays: clampInt(r.minDays, 0, 90, d.minDays),
    labels: normalizeList(r.labels),
  };
}

/**
 * Normalize an arbitrary (possibly untrusted) policy onto the defaults. A
 * stored policy without `rules` keeps its thresholds at the top level; they
 * become one rule on the default branch.
 */
export function resolveAutoCreate(raw: unknown): AutoCreatePolicy {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawRules = Array.isArray(r.rules) ? r.rules : [{ minOccurrences: r.minOccurrences, minRuns: r.minRuns }];
  return {
    enabled: r.enabled === true,
    rules: rawRules.slice(0, MAX_AUTO_CREATE_RULES).map(resolveAutoCreateRule),
    skipFlaky: r.skipFlaky !== false,
    dailyCap: clampInt(r.dailyCap, 0, 1000, DEFAULT_AUTO_CREATE.dailyCap),
    routeUnmatchedToDefault: r.routeUnmatchedToDefault === true,
  };
}

/** One run in which a cluster failed, as the rules count it. */
export interface ClusterFailureRun extends ScopedRun {
  runId: number;
  /** When the run started, epoch ms. */
  startedAt: number | null;
  /** The cluster's failing executions in the run. */
  occurrences: number;
}

/** What the rules read about one cluster. */
export interface AutoCreateFacts {
  /** The triage status: `open`, `resolved` or `ignored`. */
  status: string;
  snoozed: boolean;
  /**
   * A tracker issue still tracks the cluster (a Done one does not, unless a
   * regression reopens it), or a filing for it waits on the tracker.
   */
  tracked: boolean;
  /** An affected test passed on a retry, or every one passed at the commit the cluster failed at. */
  flaky: boolean;
  /** The tags of the affected tests. */
  tags: string[];
  /** The cluster's assignee, else its owner, when known. */
  owner: string | null;
  /** The runs it failed in. */
  failures: ClusterFailureRun[];
}

export type AutoCreateThreshold = 'occurrences' | 'runs' | 'days';

/** How far a cluster is along one rule, counted in the rule's runs. */
export interface AutoCreateProgress {
  ruleIndex: number;
  occurrences: number;
  runs: number;
  /** Whole days since the first counted failure. */
  days: number;
  firstFailureAt: number | null;
  /** The distinct branches and environments of the counted runs, newest first. */
  branches: string[];
  environments: string[];
  /** The thresholds not met yet; empty when the rule files the cluster. */
  unmet: AutoCreateThreshold[];
}

/** Why an issue was filed without a person: what its rule counted, and where. */
export type AutomaticFiling = Omit<AutoCreateProgress, 'unmet'>;

/** The filing record of a rule's progress. */
export function automaticFiling(progress: AutoCreateProgress): AutomaticFiling {
  const { unmet: _unmet, ...filing } = progress;
  return filing;
}

/** Why a cluster is not filed automatically, whatever its counts. */
export type AutoCreateSkip = 'disabled' | 'not-open' | 'snoozed' | 'tracked' | 'flaky' | 'no-route' | 'no-rule';

export type AutoCreateDecision =
  | { verdict: 'file'; progress: AutoCreateProgress }
  | { verdict: 'wait'; progress: AutoCreateProgress }
  | { verdict: 'skip'; reason: AutoCreateSkip };

/** A tag as rules compare it: no leading `@`, lower case. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^@/, '').toLowerCase();
}

/** Whether a rule's tags let the cluster's tests in: any shared tag, or no tag named. */
export function tagsMatch(ruleTags: string[], testTags: string[]): boolean {
  if (ruleTags.length === 0) return true;
  const have = new Set(testTags.map(normalizeTag));
  return ruleTags.some((tag) => have.has(normalizeTag(tag)));
}

/** Distinct non-empty values, newest run first. */
function distinctNewestFirst(failures: ClusterFailureRun[], pick: (f: ClusterFailureRun) => string | null): string[] {
  const ordered = [...failures].sort((a, b) => b.runId - a.runId);
  return [...new Set(ordered.map(pick).filter((v): v is string => !!v))];
}

/** A cluster's counts under one rule, or null when the rule counts none of its failures. */
export function ruleProgress(
  rule: AutoCreateRule,
  ruleIndex: number,
  failures: ClusterFailureRun[],
  now: number,
): AutoCreateProgress | null {
  const counted = failures.filter((f) => runInScope(rule, f));
  if (counted.length === 0) return null;
  const runs = new Set(counted.map((f) => f.runId)).size;
  const occurrences = counted.reduce((sum, f) => sum + f.occurrences, 0);
  const starts = counted.map((f) => f.startedAt).filter((t): t is number => t != null);
  const firstFailureAt = starts.length ? Math.min(...starts) : null;
  const days = firstFailureAt != null ? Math.max(0, Math.floor((now - firstFailureAt) / DAY_MS)) : 0;
  const unmet: AutoCreateThreshold[] = [];
  if (occurrences < rule.minOccurrences) unmet.push('occurrences');
  if (runs < rule.minRuns) unmet.push('runs');
  if (days < rule.minDays) unmet.push('days');
  return {
    ruleIndex,
    occurrences,
    runs,
    days,
    firstFailureAt,
    branches: distinctNewestFirst(counted, (f) => f.branch),
    environments: distinctNewestFirst(counted, (f) => f.environment),
    unmet,
  };
}

/**
 * Whether a cluster is filed automatically now. The guards come first, then
 * the rules in order: a rule whose tags let the cluster in and that counts at
 * least one of its failures either files it (every threshold met) or makes it
 * wait. With `currentRunId`, the run being processed, a rule acts only when it
 * counts that run: a failure that met a rule on `main` is not filed by a run on
 * a feature branch.
 */
export function evaluateAutoCreate(
  policy: AutoCreatePolicy,
  routes: OwnerRoute[],
  facts: AutoCreateFacts,
  opts: { now: number; currentRunId?: number | null },
): AutoCreateDecision {
  const skip = (reason: AutoCreateSkip): AutoCreateDecision => ({ verdict: 'skip', reason });
  if (!policy.enabled) return skip('disabled');
  if (facts.status !== 'open') return skip('not-open');
  if (facts.snoozed) return skip('snoozed');
  if (facts.tracked) return skip('tracked');
  if (routes.length > 0 && !policy.routeUnmatchedToDefault && !pickOwnerRoute(routes, facts.owner)) {
    return skip('no-route');
  }
  if (policy.skipFlaky && facts.flaky) return skip('flaky');

  let waiting: AutoCreateProgress | null = null;
  for (const [index, rule] of policy.rules.entries()) {
    if (!tagsMatch(rule.tags, facts.tags)) continue;
    if (opts.currentRunId != null) {
      const current = facts.failures.some((f) => f.runId === opts.currentRunId && runInScope(rule, f));
      if (!current) continue;
    }
    const progress = ruleProgress(rule, index, facts.failures, opts.now);
    if (!progress) continue;
    if (progress.unmet.length === 0) return { verdict: 'file', progress };
    waiting ??= progress;
  }
  return waiting ? { verdict: 'wait', progress: waiting } : skip('no-rule');
}

const SKIP_TEXT: Record<AutoCreateSkip, string> = {
  disabled: 'Automatic creation is off',
  'not-open': 'Resolved or ignored',
  snoozed: 'Snoozed',
  tracked: 'Already tracked by an issue',
  flaky: 'Looks flaky: a test passed on a retry, or passed at the commit it failed at',
  'no-route': 'Its owner matches no owner route',
  'no-rule': 'No rule counts its runs or its tests',
};

function plural(count: number, one: string, other: string): string {
  return `${count} ${count === 1 ? one : other}`;
}

/** A rule in words, for the settings form: "After 2 occurrences in 2 runs, on the default branch". */
export function describeAutoCreateRule(rule: AutoCreateRule): string {
  const counts = `${plural(rule.minOccurrences, 'occurrence', 'occurrences')} in ${plural(rule.minRuns, 'run', 'runs')}`;
  const days = rule.minDays > 0 ? ` over ${plural(rule.minDays, 'day', 'days')}` : '';
  const tags = rule.tags.length ? `, for tests tagged ${rule.tags.map((tag) => `@${tag}`).join(', ')}` : '';
  return `After ${counts}${days}, on ${describeRunScope(rule)}${tags}`;
}

/** A decision in words, for the settings preview: what Piwi does with the cluster, and why. */
export function describeAutoCreateDecision(decision: AutoCreateDecision, policy: AutoCreatePolicy): string {
  if (decision.verdict === 'skip') return SKIP_TEXT[decision.reason];
  const p = decision.progress;
  const rule = policy.rules[p.ruleIndex];
  const label = `rule ${p.ruleIndex + 1}`;
  if (decision.verdict === 'file') {
    const counted = `${plural(p.occurrences, 'occurrence', 'occurrences')} in ${plural(p.runs, 'run', 'runs')}`;
    return `Meets ${label}: ${counted}${p.days > 0 ? ` over ${plural(p.days, 'day', 'days')}` : ''}`;
  }
  const missing: string[] = [];
  if (rule && p.unmet.includes('occurrences'))
    missing.push(`${p.occurrences} of ${plural(rule.minOccurrences, 'occurrence', 'occurrences')}`);
  if (rule && p.unmet.includes('runs')) missing.push(`${p.runs} of ${plural(rule.minRuns, 'run', 'runs')}`);
  if (rule && p.unmet.includes('days')) missing.push(`${p.days} of ${plural(rule.minDays, 'day', 'days')}`);
  return `Waiting on ${label}: ${missing.join(', ')}`;
}

// ── Notes and description updates ───────────────────────────────────────────

/** How often a ticket hears about new occurrences, at most. */
export type NoteInterval = 'day' | 'week';
export const NOTE_INTERVALS: readonly NoteInterval[] = ['day', 'week'];

export function toNoteInterval(value: unknown): NoteInterval {
  return value === 'week' ? 'week' : 'day';
}

/**
 * The window a note belongs to, one note per window: the UTC date for a day
 * (`2026-10-08`), the ISO 8601 week for a week (`2026-W41`).
 */
export function noteWindow(interval: NoteInterval, at: Date): string {
  if (interval === 'day') return at.toISOString().slice(0, 10);
  // The ISO week of a date is the week of its Thursday; week 1 holds the year's first Thursday.
  const thursday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * What a tracker link remembers of the title and description Piwi wrote, so an
 * update replaces them only while nobody edited them in the tracker.
 */
export interface WrittenIssueRecord {
  /** {@link descriptionDigest} of the description as the tracker returned it after Piwi wrote it. */
  descriptionDigest: string;
  /** {@link documentDigest} of the document Piwi sent: an update that would send the same is skipped. */
  documentDigest: string;
  /** The title as the tracker stored it. */
  title: string | null;
  /** The title Piwi sent. */
  sourceTitle: string;
}

/** A digest of a document Piwi builds, to tell whether an update would change anything. */
export function documentDigest(document: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(document));
}

/**
 * A digest of a description's text that ignores whitespace: what Piwi wrote is
 * compared with what the tracker holds before a description is replaced, so an
 * edit made in the tracker is never overwritten.
 */
export function descriptionDigest(text: string): Promise<string> {
  return sha256Hex(text.replace(/\s+/g, ''));
}

/**
 * The clue engine: a small, deterministic, rule-based correlation pass over one
 * failing execution's evidence. Each rule looks at facts the dashboard already
 * stores — the parsed error, the failure timeline, the network requests, the
 * ARIA snapshot, the locator-healing result, the app state, the environment
 * diff, the run's sibling and same-worker executions, and the cluster's fix
 * history — and, when its signal is present, emits a ranked, cited *clue*: a
 * one-line finding that points the reader (and the model) straight at the
 * correlation the raw error never spells out.
 *
 * Pure assembly over rows the caller has already loaded, so the server route,
 * the demo mirror, the AI-context builder and the MCP tools all build the same
 * clues. It never throws: a missing input simply disables the rules that need
 * it, and the ranked list is capped so the card and the prompt stay readable.
 *
 * Every citation's `section` uses the ids of `#shared/diagnosis-sections`, so a
 * clue doubles as an entry in the evidence list the AI result already renders —
 * a click on a citation reveals the same section the model's citations point to.
 */
import type { ParsedPlaywrightError, CallLogState } from '#shared/error-parse';
import type { FailureTimeline } from '#shared/failure-timeline';
import { leadStart, TIMELINE_WINDOW_LEAD_MS, timelinePauseSpans } from '#shared/failure-timeline';
import { pausedOverlap, type PauseSpan } from '@piwitests/core/step-analysis';
import type { LocatorHealingResult } from '#shared/locator-healing.types';
import type { PageStateLike } from '#shared/page-state';
import { ariaTextPreferJson } from '#shared/aria-json';
import { intervalsOverlap } from '#shared/lock-overlap';
import { requestRouteKey } from '#shared/utils/route';

/** The environment-diff facts the engine reads — the pure subset of the server result. */
export interface FailureClueEnvironmentDiff {
  status: 'ok' | 'no-baseline' | 'not-found';
  /** Changed keys only; empty means the environment matched the last pass. */
  entries?: Array<{ key: string; label?: string | null }> | null;
}

/** The page-diff facts the engine reads — the change (if any) at the failing locator's node. */
export interface FailureCluePageDiff {
  /** The hunk the failing locator maps to, or null when the locator maps to no change. */
  locatorChange: { type: string; role: string; name: string | null; oldName?: string | null } | null;
}

/** The rule that produced a clue — stable ids, used for ordering and tests. */
export type FailureClueRule =
  | 'failed-request-before-failure'
  | 'slow-request-overlapping-failure'
  | 'console-mentions-target'
  | 'dialog-open-on-failure'
  | 'backend-error-attached'
  | 'element-renamed'
  | 'page-structure-changed'
  | 'element-present-but-blocked'
  | 'wrong-page'
  | 'worker-pollution'
  | 'lock-holder-failed'
  | 'lock-cross-shard'
  | 'timeout-budget'
  | 'environment-changed'
  | 'browser-specific'
  | 'known-flake-suspect';

/** How strongly a clue points at the cause; drives ranking and the strength chip. */
export type FailureClueStrength = 'strong' | 'medium' | 'weak';

/** A known combination of clues on one execution, chained into one sentence. */
export type FailureStoryId =
  | 'blocked-by-pending-request'
  | 'renamed'
  | 'removed'
  | 'wrong-page'
  | 'polluted-worker'
  | 'backend-error'
  | 'timing';

/**
 * One story: several clues on the same execution that together name the cause,
 * chained into a single plain sentence. The UI leads with it and folds the
 * member clues under it; when no combination matches, `story` is null and the
 * top clue stands alone.
 */
export interface FailureStory {
  id: FailureStoryId;
  /** One plain sentence built from the member clues' own data. */
  sentence: string;
  /** The ids of the clues that form the story, in the order they are chained. */
  clueIds: string[];
  /** The strongest member's strength. */
  strength: FailureClueStrength;
}

/** The clues for one execution, plus the story that chains them when one matches. */
export interface FailureCluesReport {
  clues: FailureClue[];
  story: FailureStory | null;
}

/**
 * Environment-diff keys that describe the content the test drives — a change in
 * one of these can plausibly explain a content failure. Tool versions
 * (Playwright, reporter, Node), color scheme and the naturally-varying
 * placement keys are excluded, so they never lift `environment-changed` above
 * weak on their own.
 */
const ENVIRONMENT_CONTENT_KEYS = new Set<string>([
  'browserName',
  'channel',
  'viewport',
  'locale',
  'timezoneId',
  'environment',
  'baseUrl',
  'baseURL',
]);

/** A pointer from a clue to the evidence section that backs it. */
export interface FailureClueCitation {
  /** A `#shared/diagnosis-sections` id — the same ids the AI citations use. */
  section: string;
  /** Index within that section's list, when the clue points at one entry. */
  index?: number;
}

export interface FailureClue {
  /** Stable, unique per execution (the rule id, suffixed when a rule fires twice). */
  id: string;
  rule: FailureClueRule;
  strength: FailureClueStrength;
  /** The finding in a few words. */
  title: string;
  /** The supporting detail — names, values, and the timing when anchored. */
  detail: string;
  citations: FailureClueCitation[];
  /** When anchored in time: ms relative to the execution start (the timeline origin). */
  at?: number;
}

/** One network request, as the handler loads it (epoch ms `startTime`). */
export interface FailureClueNetworkRequest {
  method?: string | null;
  url?: string | null;
  status?: number | null;
  duration?: number | null;
  startTime?: number | null;
  serverLogs?: Array<{ level?: string | null; message?: string | null; timestamp?: number | null }> | null;
  /** Why the request failed without a response (`net::ERR_CONNECTION_RESET`). */
  failure?: string | null;
}

/** One console entry in the execution, with its epoch-ms timestamp. */
export interface FailureClueConsoleEntry {
  type?: string | null;
  text?: string | null;
  timestamp?: number | null;
}

/** One browser dialog observed via its close event. */
export interface FailureClueDialog {
  type?: string | null;
  message?: string | null;
  defaultValue?: string | null;
  closedAt?: number | null;
}

/** One sibling execution of the same test in this run, on a given browser. */
export interface FailureClueBrowserPeer {
  browser?: string | null;
  browserName?: string | null;
  status?: string | null;
}

/** One execution on the same worker in this run, ordered by `startedAt`. */
export interface FailureClueWorkerExecution {
  id: number;
  testCaseId: number;
  title?: string | null;
  status?: string | null;
  /** Epoch ms; used only to order executions around this one. */
  startedAt?: number | null;
}

/**
 * One execution in this run that held at least one lock — the raw material for
 * the two lock rules (previous holder failed, cross-shard overlap).
 */
export interface FailureClueLockHolder {
  id: number;
  title?: string | null;
  status?: string | null;
  /** Epoch ms; orders holders and bounds the cross-shard overlap window. */
  startedAt?: number | null;
  duration?: number | null;
  shardIndex?: number | null;
  locks: string[];
}

/**
 * One suspect of the test's flake profile, as the clue reads it: which failing
 * executions show it, and the counts behind it.
 */
export interface FailureClueFlakeSuspect {
  kind: 'slow-route' | 'failed-route' | 'alongside' | 'before' | 'load' | 'project';
  label: string;
  counts: { failuresWith: number; failures: number; passesWith: number; passes: number };
  route?: string;
  thresholdMs?: number;
  title?: string;
  project?: string;
  executionIds: number[];
  /**
   * The flake-lab arm that reproduced this suspect in the test's latest
   * experiment testing it, when it did: the strong form of the clue.
   */
  reproduced?: {
    label: string;
    matchingFailures: number;
    runs: number;
    controlMatchingFailures: number;
    controlRuns: number;
    pValue: number | null;
  } | null;
}

/** The cluster's recorded fix history, when this failure belongs to a cluster. */
export interface FailureClueClusterFix {
  fixCommit?: string | null;
  fixLandedRunId?: number | null;
  fixVerification?: string | null;
}

export interface FailureClueInput {
  /** This execution's id and identity — anchors the worker/browser rules. */
  execution: {
    id: number;
    testCaseId: number;
    status?: string | null;
    duration?: number | null;
    browser?: string | null;
    browserName?: string | null;
    startedAt?: number | null;
    /** Lock names this execution held; anchors the two lock rules. */
    locks?: string[] | null;
    /** This execution's shard, when the run was sharded. */
    shardIndex?: number | null;
  };
  parsedError: ParsedPlaywrightError | null;
  timeline: FailureTimeline | null;
  healing: LocatorHealingResult | null;
  ariaSnapshot: string | null;
  /** The failure-time aria tree as JSON (Playwright ≥ 1.63), preferred over the YAML. */
  ariaSnapshotJson?: string | null;
  appState: PageStateLike | null;
  environmentDiff: FailureClueEnvironmentDiff | null;
  /** The structural page diff against the last green sample, when one exists. */
  pageDiff?: FailureCluePageDiff | null;
  networkRequests: FailureClueNetworkRequest[];
  consoleLogs: FailureClueConsoleEntry[];
  /** Browser dialogs observed during this execution (Playwright ≥ 1.63). */
  dialogs?: FailureClueDialog[] | null;
  /** Sibling executions of this test in this run, one per browser. */
  browserPeers: FailureClueBrowserPeer[];
  /** Executions on the same worker in this run, ordered by `startedAt`. */
  workerExecutions: FailureClueWorkerExecution[];
  /** Executions in this run that held a lock, for the two lock rules. Empty when this execution holds none. */
  lockHolders?: FailureClueLockHolder[];
  cluster: FailureClueClusterFix | null;
  /** Effective per-test timeout in ms; 0/nullish disables the budget rule. */
  timeout: number | null;
  /** The slow-request threshold; defaults to 1500 ms. */
  slowRequestMs?: number | null;
  /** The test's flake suspects, ranked; empty or absent when the test is not flaky. */
  flakeSuspects?: FailureClueFlakeSuspect[] | null;
}

/** The most a clue list ever carries — keeps the card and the prompt readable. */
const MAX_CLUES = 8;

const DEFAULT_SLOW_REQUEST_MS = 1500;
/**
 * How far past the failure a failed request may be recorded as ending: the
 * capture stamps a response when its body is read, a few ms after the test
 * already saw its status.
 */
const REQUEST_END_SLACK_MS = 250;

/** Rule precedence for the final tiebreak, in the order the rules are declared. */
const RULE_ORDER: FailureClueRule[] = [
  'failed-request-before-failure',
  'slow-request-overlapping-failure',
  'console-mentions-target',
  'dialog-open-on-failure',
  'backend-error-attached',
  'element-renamed',
  'page-structure-changed',
  'element-present-but-blocked',
  'wrong-page',
  'worker-pollution',
  'lock-holder-failed',
  'lock-cross-shard',
  'timeout-budget',
  'environment-changed',
  'browser-specific',
  'known-flake-suspect',
];

const STRENGTH_RANK: Record<FailureClueStrength, number> = { strong: 0, medium: 1, weak: 2 };

/** Call-log states that mean the element resolved but could not be acted on. */
const BLOCKED_STATES = new Set<CallLogState>(['not-enabled', 'hidden', 'not-visible', 'intercepts-pointer']);

/** Path prefixes that mean the test ended somewhere other than the app it drives. */
const WRONG_PAGE_PATHS = ['/login', '/signin', '/auth', '/error', '/404', '/not-found'];

const FAILED_PEER_STATUSES = new Set(['failed', 'timedout', 'timedOut', 'interrupted']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The pathname of a captured URL, tolerant of relative or malformed values. */
function pathOf(url: string | null | undefined): string | null {
  const raw = str(url).trim();
  if (!raw) return null;
  try {
    return new URL(raw, 'http://x').pathname || null;
  } catch {
    const noQuery = raw.split(/[?#]/)[0] ?? raw;
    const afterHost = noQuery.replace(/^[a-z]+:\/\/[^/]+/i, '');
    return afterHost.startsWith('/') ? afterHost : `/${afterHost}`;
  }
}

/**
 * The method and path of a step that is itself an HTTP call — Playwright titles
 * an APIRequestContext request with its method and URL (`POST https://…/seed`).
 * A URL whose scheme was dropped (`host.tld/path`) keeps only its path. Null
 * for any other step.
 */
function apiCallOf(label: string): { method: string; path: string } | null {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+"?([^\s"]+)"?$/i.exec(label.trim());
  if (!match) return null;
  const url = match[2]!;
  const withScheme = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(url) ? `http://${url}` : url;
  const path = pathOf(withScheme);
  return path ? { method: match[1]!.toUpperCase(), path } : null;
}

/** Seconds with one decimal, as the clues write them: `1.1`. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/**
 * `, 4.0 s of it paused`: how much of the stretch from `at` to `failureAt` the
 * test stood stopped at Piwi's pause bar; empty under 100 ms.
 */
function pausedPart(at: number, failureAt: number, pauses: readonly PauseSpan[]): string {
  const paused = pausedOverlap(at, failureAt - at, pauses);
  return paused >= 100 ? `, ${seconds(paused)} s of it paused` : '';
}

/**
 * How long before the failure the anchor happened (`1.1 s before the failure`,
 * with how much of it the test stood paused); under 100 ms, and up to the
 * request slack after it, `just before the failure`; empty when the anchor is
 * later than that.
 */
function formatLead(at: number, failureAt: number, pauses: readonly PauseSpan[]): string {
  const lead = failureAt - at;
  if (!Number.isFinite(lead) || lead < -REQUEST_END_SLACK_MS) return '';
  if (lead < 100) return 'just before the failure';
  return `${seconds(lead)} s before the failure${pausedPart(at, failureAt, pauses)}`;
}

/** A short, single-line form of the failing locator's identity. */
interface LocatorTarget {
  /** The accessible name / text the locator was built around, as the test wrote it. */
  name: string | null;
  /** The same name lower-cased, to match case-insensitively. */
  nameNeedle: string | null;
  /** The role, when the error names one. */
  role: string | null;
  /** The test id, when the error names one. */
  testId: string | null;
}

/** Pull the name/role/testId the failing locator was built from. */
function readLocatorTarget(parsed: ParsedPlaywrightError | null): LocatorTarget {
  const locator = parsed?.leafLocator ?? parsed?.locator ?? null;
  if (!locator) return { name: null, nameNeedle: null, role: null, testId: null };
  const role = /getByRole\(\s*['"`]([^'"`]+)['"`]/.exec(locator)?.[1] ?? null;
  const name =
    /\bname:\s*['"`]([^'"`]+)['"`]/.exec(locator)?.[1] ??
    /getBy(?:Text|Label|Placeholder|AltText|Title)\(\s*['"`]([^'"`]+)['"`]/.exec(locator)?.[1] ??
    null;
  const testId = /getByTestId\(\s*['"`]([^'"`]+)['"`]/.exec(locator)?.[1] ?? null;
  return { name, nameNeedle: name ? name.toLowerCase() : null, role, testId };
}

/** "7 of this test's 8 failures and 3 of its 44 passes". */
function suspectCounts(c: FailureClueFlakeSuspect['counts']): string {
  return `${c.failuresWith} of this test's ${c.failures} failures and ${c.passesWith} of its ${c.passes} passes`;
}

/** "; a lab run reproduced it: 3 of 4 under delay GET /api/cart 1.8 s, against 0 of 10 without, p = 0.011". */
function reproducedText(lab: NonNullable<FailureClueFlakeSuspect['reproduced']>): string {
  const p = lab.pValue == null ? '' : lab.pValue < 0.001 ? ', p < 0.001' : `, p = ${lab.pValue.toFixed(3)}`;
  return `; a lab run reproduced it: ${lab.matchingFailures} of ${lab.runs} under ${lab.label}, against ${lab.controlMatchingFailures} of ${lab.controlRuns} without${p}`;
}

/** The clue for a flake suspect this execution shows, in the words of its kind; strong once a lab run reproduced it. */
function knownFlakeSuspectClue(suspect: FailureClueFlakeSuspect, requests: FailureClueNetworkRequest[]): FailureClue {
  const lab = suspect.reproduced;
  const counts = suspectCounts(suspect.counts) + (lab ? reproducedText(lab) : '');
  const base = {
    id: 'known-flake-suspect',
    rule: 'known-flake-suspect' as const,
    strength: lab ? ('strong' as const) : ('weak' as const),
    title: lab ? `A reproduced flake cause: ${suspect.label}` : `A known flake suspect: ${suspect.label}`,
  };
  if (suspect.kind === 'slow-route' || suspect.kind === 'failed-route') {
    const route = suspect.route ?? '';
    const matches = requests
      .map((req, index) => ({ req, index }))
      .filter((m) => requestRouteKey(m.req.method, m.req.url) === route);
    const slowest = matches.sort((a, b) => (b.req.duration ?? 0) - (a.req.duration ?? 0))[0];
    const citations = [{ section: 'networkRequests', ...(slowest ? { index: slowest.index } : {}) }];
    if (suspect.kind === 'slow-route') {
      const took = slowest?.req.duration != null ? ` took ${(slowest.req.duration / 1000).toFixed(1)} s` : ' was slow';
      const threshold = suspect.thresholdMs != null ? ` (${Math.floor(suspect.thresholdMs / 100) / 10} s or more)` : '';
      return { ...base, detail: `${route}${took}; it is slow${threshold} in ${counts}.`, citations };
    }
    return { ...base, detail: `${route} failed; it fails in ${counts}.`, citations };
  }
  const citations = [{ section: 'recurrenceFlakiness' }];
  const title = suspect.title ?? 'another test';
  switch (suspect.kind) {
    case 'alongside':
      return { ...base, detail: `"${title}" was running at the same time; it runs alongside in ${counts}.`, citations };
    case 'before':
      return { ...base, detail: `"${title}" ran just before on this worker; it does in ${counts}.`, citations };
    case 'load':
      return { ...base, detail: `${suspect.label} during this attempt, as in ${counts}.`, citations };
    default:
      return { ...base, detail: `It ran on ${suspect.project ?? 'this project'}, as in ${counts}.`, citations };
  }
}

export function buildFailureClues(input: FailureClueInput): FailureCluesReport {
  const clues: FailureClue[] = [];
  const add = (clue: FailureClue) => clues.push(clue);

  // Structured facts captured as clues are emitted, so the story sentence reads
  // real values (element, method, path, durations, console lead) without
  // re-parsing the clue prose.
  const facts: {
    blockedState?: string;
    slowRequest?: { method: string; path: string; durSec: string };
    failedRequest?: { method: string; path: string; statusText: string };
    consoleLeadSec?: string | null;
    /** `, 4.0 s of it paused` when the test stood stopped at Piwi's pause bar between the console entry and the failure. */
    consoleLeadPaused?: string;
    reachableLocator?: string | null;
    renamed?: { role: string; oldName: string | null; newName: string | null };
    removed?: { role: string; name: string | null };
    wrongPage?: { endedPath: string; expected: string | null; via: 'request' | 'dialog' | null };
    worker?: { title: string; workerLabel: string | null };
    backend?: { method: string; path: string; logLine: string };
    timing?: { pct: number };
  } = {};

  const timeline = input.timeline;
  const origin = timeline?.origin ?? null;
  const failureAt = timeline ? timeline.failureAt : null;
  // The stops at Piwi's pause bar, on the timeline's clock. A step's time and a lead before the failure are the test's
  // own: the time stopped is left out of them.
  const pauses = timelinePauseSpans(timeline);
  const slowMs =
    isFiniteNumber(input.slowRequestMs) && input.slowRequestMs > 0 ? input.slowRequestMs : DEFAULT_SLOW_REQUEST_MS;
  const parsed = input.parsedError;

  // Requests positioned in the timeline frame (ms relative to origin), keeping
  // the raw index so a citation can point back at the network card entry.
  const positionedRequests =
    origin != null
      ? input.networkRequests.map((req, index) => {
          const startAt = isFiniteNumber(req.startTime) ? req.startTime - origin : null;
          const dur = isFiniteNumber(req.duration) && req.duration >= 0 ? req.duration : 0;
          return { req, index, startAt, endAt: startAt != null ? startAt + dur : null, dur };
        })
      : [];

  const windowStart = timeline ? timeline.window.start : null;
  const windowEnd = timeline ? timeline.window.end : null;
  const inWindow = (at: number | null): boolean =>
    at != null && windowStart != null && windowEnd != null && at >= windowStart && at <= windowEnd;

  // ── failed-request-before-failure (strong) ─────────────────────────────────
  // A 5xx/aborted request that ended within the lead window before the failure.
  if (failureAt != null) {
    const leadFrom = leadStart(failureAt, TIMELINE_WINDOW_LEAD_MS, pauses);
    const failedRequests = positionedRequests
      .filter((p) => {
        const status = isFiniteNumber(p.req.status) ? p.req.status : 0;
        const bad = status >= 500 || status <= 0;
        return bad && p.endAt != null && p.endAt <= failureAt + REQUEST_END_SLACK_MS && p.endAt >= leadFrom;
      })
      .sort((a, b) => (b.endAt ?? 0) - (a.endAt ?? 0));
    failedRequests.slice(0, 2).forEach((p, i) => {
      const method = str(p.req.method) || 'GET';
      const path = pathOf(p.req.url) ?? str(p.req.url) ?? '(unknown)';
      const status = isFiniteNumber(p.req.status) ? p.req.status : 0;
      const failure = str(p.req.failure);
      const statusText = failure ? `failed with ${failure}` : status <= 0 ? 'was aborted' : `returned ${status}`;
      const lead = p.endAt != null && failureAt != null ? formatLead(p.endAt, failureAt, pauses) : '';
      if (i === 0) facts.failedRequest = { method, path, statusText };
      add({
        id: i === 0 ? 'failed-request-before-failure' : `failed-request-before-failure-${i}`,
        rule: 'failed-request-before-failure',
        strength: 'strong',
        title: `${method} ${path} ${statusText}`,
        detail: `${method} ${path} ${statusText}${lead ? `, ${lead}` : ''}.`,
        citations: [{ section: 'networkRequests', index: p.index }],
        ...(p.endAt != null ? { at: p.endAt } : {}),
      });
    });
  }

  // ── slow-request-overlapping-failure (medium) ──────────────────────────────
  // A request slower than the threshold that was in flight during the failed step
  // while the test ran it, not only while it stood stopped at Piwi's pause bar.
  // When the failed step is the test's own HTTP call (an APIRequestContext
  // request), the step waited on that call: page requests in flight meanwhile
  // are unrelated, so the slow request is the step itself, timed without its stops.
  const failedStep = timeline?.failedStep ?? null;
  const failedStepOwnMs = failedStep ? Math.max(0, failedStep.duration - (failedStep.paused ?? 0)) : null;
  const ownCall = failedStep ? apiCallOf(failedStep.label) : null;
  if (failedStep && ownCall) {
    if (failedStepOwnMs! >= slowMs) {
      const durSec = seconds(failedStepOwnMs!);
      facts.slowRequest = { method: ownCall.method, path: ownCall.path, durSec };
      add({
        id: 'slow-request-overlapping-failure',
        rule: 'slow-request-overlapping-failure',
        strength: 'medium',
        title: `${ownCall.method} ${ownCall.path} took ${durSec} s`,
        detail: `The failed step is the test's own ${ownCall.method} ${ownCall.path} call, and it took ${durSec} s.`,
        citations: [{ section: 'steps' }],
        at: failedStep.at,
      });
    }
  } else if (failedStep && positionedRequests.length > 0) {
    const stepStart = failedStep.at;
    const stepEnd = failedStep.at + failedStep.duration;
    /** Whether the request was in flight while the step ran, outside the stops. */
    const whileRunning = (startAt: number, endAt: number): boolean => {
      const from = Math.max(startAt, stepStart);
      const overlap = Math.min(endAt, stepEnd) - from;
      return overlap <= 0 || pausedOverlap(from, overlap, pauses) < overlap;
    };
    const slow = positionedRequests
      .filter(
        (p) =>
          p.startAt != null &&
          p.endAt != null &&
          p.dur >= slowMs &&
          p.startAt <= stepEnd &&
          p.endAt >= stepStart &&
          whileRunning(p.startAt, p.endAt),
      )
      .sort((a, b) => b.dur - a.dur);
    const p = slow[0];
    if (p) {
      const method = str(p.req.method) || 'GET';
      const path = pathOf(p.req.url) ?? str(p.req.url) ?? '(unknown)';
      facts.slowRequest = { method, path, durSec: (p.dur / 1000).toFixed(1) };
      add({
        id: 'slow-request-overlapping-failure',
        rule: 'slow-request-overlapping-failure',
        strength: 'medium',
        title: `${method} ${path} was still in flight`,
        detail: `${method} ${path} took ${(p.dur / 1000).toFixed(1)} s and was still in flight during the failed step.`,
        citations: [{ section: 'networkRequests', index: p.index }],
        ...(p.startAt != null ? { at: p.startAt } : {}),
      });
    }
  }

  // ── console-mentions-target (strong error / medium warning) ────────────────
  // A console entry in the window that names the failing locator or route.
  const target = readLocatorTarget(parsed);
  const routePath = pathOf(input.appState?.url) ?? pathOf(parsed?.url);
  const needles = [target.name, target.testId, routePath].filter((n): n is string => Boolean(n && n.length >= 3));
  if (needles.length > 0 && input.consoleLogs.length > 0 && origin != null) {
    const match = input.consoleLogs
      .map((entry, index) => ({ entry, index, at: isFiniteNumber(entry.timestamp) ? entry.timestamp - origin : null }))
      .filter((c) => inWindow(c.at))
      .find((c) => {
        const text = str(c.entry.text).toLowerCase();
        return needles.some((n) => text.includes(n.toLowerCase()));
      });
    if (match) {
      const type = str(match.entry.type).toLowerCase();
      const isError = type === 'error';
      const isWarning = type === 'warning' || type === 'warn';
      if (isError || isWarning) {
        const ledBy = match.at != null && failureAt != null && failureAt - match.at > 0;
        facts.consoleLeadSec = ledBy ? seconds(failureAt! - match.at!) : null;
        facts.consoleLeadPaused = ledBy ? pausedPart(match.at!, failureAt!, pauses) : '';
        add({
          id: 'console-mentions-target',
          rule: 'console-mentions-target',
          strength: isError ? 'strong' : 'medium',
          title: `Console ${isError ? 'error' : 'warning'} names the failing target`,
          detail: `A console ${isError ? 'error' : 'warning'} in the failure window mentions ${
            target.name ? `"${target.name}"` : (target.testId ?? routePath)
          }: "${str(match.entry.text).slice(0, 140)}".`,
          citations: [{ section: 'console', index: match.index }],
          ...(match.at != null ? { at: match.at } : {}),
        });
      }
    }
  }

  // ── dialog-open-on-failure (strong) ────────────────────────────────────────
  // A browser dialog closed around the failure moment — it was open, and a native
  // dialog blocks the page until dismissed, so the action could not proceed.
  const dialogs = input.dialogs ?? [];
  if (origin != null && dialogs.length > 0) {
    const positioned = dialogs
      .map((d, index) => ({ d, index, at: isFiniteNumber(d.closedAt) ? d.closedAt - origin : null }))
      .filter((p) => inWindow(p.at));
    const hit = positioned[positioned.length - 1];
    if (hit) {
      const type = str(hit.d.type) || 'dialog';
      const message = str(hit.d.message);
      add({
        id: 'dialog-open-on-failure',
        rule: 'dialog-open-on-failure',
        strength: 'strong',
        title: `A ${type} dialog was open when the action failed`,
        detail: `A browser ${type} dialog${
          message ? ` ("${message.slice(0, 140)}")` : ''
        } was open around the failure — a native dialog blocks the page until it is dismissed, so the action could not proceed.`,
        citations: [{ section: 'dialogs', index: hit.index }],
        ...(hit.at != null ? { at: hit.at } : {}),
      });
    }
  }

  // ── backend-error-attached (strong) ────────────────────────────────────────
  // A request in the window whose backend logs carry an error-level entry.
  if (origin != null) {
    for (const p of positionedRequests) {
      if (!inWindow(p.startAt) && !inWindow(p.endAt)) continue;
      const logs = Array.isArray(p.req.serverLogs) ? p.req.serverLogs : [];
      const errorLog = logs.find((l) => str(l?.level).toLowerCase() === 'error');
      if (errorLog) {
        const method = str(p.req.method) || 'GET';
        const path = pathOf(p.req.url) ?? str(p.req.url) ?? '(unknown)';
        facts.backend = { method, path, logLine: str(errorLog.message).slice(0, 140) };
        add({
          id: 'backend-error-attached',
          rule: 'backend-error-attached',
          strength: 'strong',
          title: `Backend error on ${method} ${path}`,
          detail: `The backend logged an error while serving ${method} ${path}: "${str(errorLog.message).slice(0, 140)}".`,
          citations: [{ section: 'serverLogs', index: p.index }],
          ...(p.startAt != null ? { at: p.startAt } : {}),
        });
        break;
      }
    }
  }

  // ── element-renamed (strong) ───────────────────────────────────────────────
  // Healing found the element under a new identity, or flagged the stored name
  // as stale while still recommending a fix.
  const healing = input.healing;
  if (healing) {
    const renamed =
      healing.source === 'diff-rename' ||
      healing.source === 'element-match' ||
      (healing.priorNameMayBeStale === true && healing.recommendation?.recommended != null);
    if (renamed) {
      const rec = healing.recommendation?.recommended;
      facts.reachableLocator = rec?.locator ?? null;
      add({
        id: 'element-renamed',
        rule: 'element-renamed',
        strength: 'strong',
        title: 'The element was renamed or moved',
        detail:
          healing.source === 'diff-rename' && healing.diffRename && rec
            ? `This change renamed \`${healing.diffRename.before}\` to \`${healing.diffRename.after}\` in ${healing.diffRename.file}:${healing.diffRename.line}; the same locator with the new text is \`${rec.locator}\`.`
            : rec
              ? `The failing locator no longer matches; the same element is now reachable as \`${rec.locator}\`.`
              : 'The failing locator no longer matches — the element it named appears to have been renamed or moved.',
        citations: [{ section: 'locatorHealing' }],
      });
    }
  }

  // ── page-structure-changed (strong) ────────────────────────────────────────
  // The page diff against the last green sample shows the failing locator's node
  // was removed or renamed — a structural change that explains the broken locator.
  const locatorChange = input.pageDiff?.locatorChange;
  if (locatorChange && (locatorChange.type === 'removed' || locatorChange.type === 'renamed')) {
    const node = locatorChange.name ? `${locatorChange.role} "${locatorChange.name}"` : locatorChange.role;
    if (locatorChange.type === 'renamed') {
      facts.renamed = { role: locatorChange.role, oldName: locatorChange.oldName ?? null, newName: locatorChange.name };
    } else {
      facts.removed = { role: locatorChange.role, name: locatorChange.name };
    }
    add({
      id: 'page-structure-changed',
      rule: 'page-structure-changed',
      // A rename or removal only explains the failure when the locator never
      // resolved; if it resolved (and failed later), the structure change is
      // context, not cause, so it stays medium.
      strength: parsed?.isLocatorResolutionFailure ? 'strong' : 'medium',
      title: 'The page structure changed near the failing locator',
      detail:
        locatorChange.type === 'renamed'
          ? `Since the last passing run the ${locatorChange.role} the locator names was renamed from "${locatorChange.oldName}" to "${locatorChange.name}".`
          : `Since the last passing run the ${node} the locator names was removed from the page.`,
      citations: [{ section: 'pageDiff' }],
    });
  }

  // ── element-present-but-blocked (strong) ───────────────────────────────────
  // The call log says the element resolved but was not actionable, and the ARIA
  // snapshot still shows one with the failing role and name.
  if (parsed && BLOCKED_STATES.has(parsed.lastState)) {
    const aria = str(ariaTextPreferJson(input.ariaSnapshotJson, input.ariaSnapshot)).toLowerCase();
    const roleName = target.role ? target.role.toLowerCase() : null;
    const nameNeedle = target.nameNeedle;
    const present =
      aria.length > 0 &&
      (!roleName || aria.includes(roleName)) &&
      (!nameNeedle || aria.includes(nameNeedle)) &&
      (roleName != null || nameNeedle != null);
    if (present) {
      const stateLabel: Record<string, string> = {
        'not-enabled': 'disabled',
        hidden: 'hidden',
        'not-visible': 'not visible',
        'intercepts-pointer': 'covered by another element',
      };
      const label = stateLabel[parsed.lastState] ?? parsed.lastState;
      facts.blockedState = label;
      add({
        id: 'element-present-but-blocked',
        rule: 'element-present-but-blocked',
        strength: 'strong',
        title: `The element is present but ${label}`,
        detail: `The ${target.role ?? 'element'}${target.name ? ` "${target.name}"` : ''} is in the accessibility tree, but the action failed because it was ${label} — not because it was missing.`,
        citations: [{ section: 'ariaSnapshot' }, { section: 'executionError' }],
      });
    }
  }

  // ── wrong-page (strong) ────────────────────────────────────────────────────
  // The page ended on an auth/error route, or somewhere other than the last
  // navigation the test asked for — when nothing the test did after it (a click,
  // a submitted form) could have moved the page on. Where the captured app state
  // carries no URL, the last navigation step's own `params.url` stands in for
  // where it ended.
  const navigation = lastNavigation(timeline);
  const lastNav = navigation?.path ?? null;
  const endedPath = pathOf(input.appState?.url) ?? lastNav;
  if (endedPath) {
    const onKnownWrong = WRONG_PAGE_PATHS.find((p) => endedPath === p || endedPath.startsWith(`${p}/`));
    const driftedFromNav = lastNav && !navigation?.actedAfter && pathsDiffer(endedPath, lastNav);
    if (onKnownWrong || driftedFromNav) {
      facts.wrongPage = { endedPath, expected: driftedFromNav ? lastNav : null, via: null };
      add({
        id: 'wrong-page',
        rule: 'wrong-page',
        strength: 'strong',
        title: `The test ended on ${endedPath}`,
        detail: onKnownWrong
          ? `At the moment of failure the page was on ${endedPath} — an authentication or error page, not the app under test.`
          : `At the moment of failure the page was on ${endedPath}, not ${lastNav} where the last navigation went.`,
        citations: [{ section: 'appState' }],
      });
    }
  }

  // ── worker-pollution (medium) ──────────────────────────────────────────────
  // The execution that ran just before this one on the same worker failed.
  if (input.workerExecutions.length > 1) {
    const ordered = [...input.workerExecutions]
      .filter((e) => isFiniteNumber(e.startedAt))
      .sort((a, b) => (a.startedAt as number) - (b.startedAt as number));
    const selfIdx = ordered.findIndex((e) => e.id === input.execution.id);
    const previous = selfIdx > 0 ? ordered[selfIdx - 1] : null;
    if (previous && FAILED_PEER_STATUSES.has(str(previous.status))) {
      facts.worker = { title: str(previous.title) || 'the previous test', workerLabel: null };
      add({
        id: 'worker-pollution',
        rule: 'worker-pollution',
        strength: 'medium',
        title: 'The previous test on this worker failed',
        detail: `"${str(previous.title) || 'the previous test'}" ran just before this one on the same worker and ${
          str(previous.status) === 'timedout' || str(previous.status) === 'timedOut' ? 'timed out' : 'failed'
        } — shared state it left behind is a classic cross-test cause.`,
        citations: [{ section: 'runContext' }],
      });
    }
  }

  // ── lock rules ─────────────────────────────────────────────────────────────
  // Both read the run's lock-holding executions. They only apply when this
  // execution itself declared a lock.
  const selfLocks = (input.execution.locks ?? []).filter((l) => typeof l === 'string' && l.length > 0);
  const lockHolders = input.lockHolders ?? [];
  if (selfLocks.length > 0 && lockHolders.length > 0) {
    const selfStart = isFiniteNumber(input.execution.startedAt) ? input.execution.startedAt : null;

    // ── lock-holder-failed (strong) ──────────────────────────────────────────
    // The previous holder of a lock this test holds, in this run, failed or
    // timed out — a named shared resource left in a bad state.
    if (selfStart != null) {
      for (const lock of selfLocks) {
        const priors = lockHolders
          .filter(
            (h) =>
              h.id !== input.execution.id &&
              h.locks.includes(lock) &&
              isFiniteNumber(h.startedAt) &&
              (h.startedAt as number) < selfStart,
          )
          .sort((a, b) => (b.startedAt as number) - (a.startedAt as number));
        const previous = priors[0];
        if (previous && FAILED_PEER_STATUSES.has(str(previous.status))) {
          add({
            id: `lock-holder-failed:${lock}`,
            rule: 'lock-holder-failed',
            strength: 'strong',
            title: `The previous holder of lock "${lock}" failed`,
            detail: `"${str(previous.title) || 'the previous holder'}" held lock "${lock}" just before this test and ${
              str(previous.status) === 'timedout' || str(previous.status) === 'timedOut' ? 'timed out' : 'failed'
            } — only one holder runs at a time, so state it left behind in that shared resource is a likely cause.`,
            citations: [{ section: 'runContext' }],
          });
          break; // one lock-holder clue is enough; the strongest lock leads.
        }
      }
    }

    // ── lock-cross-shard (medium) ────────────────────────────────────────────
    // A lock this test holds was held at the same wall-clock time on a
    // different shard — shards are separate processes and never coordinate, so
    // the lock's guarantee did not hold across machines.
    const selfEnd =
      selfStart != null && isFiniteNumber(input.execution.duration) ? selfStart + input.execution.duration : null;
    const selfShard = input.execution.shardIndex ?? null;
    if (selfStart != null && selfEnd != null && selfShard != null) {
      for (const lock of selfLocks) {
        const overlap = lockHolders.find((h) => {
          if (h.id === input.execution.id || !h.locks.includes(lock)) return false;
          if (h.shardIndex == null || h.shardIndex === selfShard) return false;
          if (!isFiniteNumber(h.startedAt) || !isFiniteNumber(h.duration)) return false;
          const hStart = h.startedAt as number;
          const hEnd = hStart + (h.duration as number);
          return intervalsOverlap(selfStart, selfEnd, hStart, hEnd);
        });
        if (overlap) {
          add({
            id: `lock-cross-shard:${lock}`,
            rule: 'lock-cross-shard',
            strength: 'medium',
            title: `Lock "${lock}" was held on two shards at once`,
            detail: `Shard ${selfShard} and shard ${overlap.shardIndex} both held lock "${lock}" at the same time. Locks only serialize within one \`playwright test\` process, so sharded runs do not coordinate — the classic "passes on one machine" flake.`,
            citations: [{ section: 'runContext' }],
          });
          break;
        }
      }
    }
  }

  // ── timeout-budget (medium) ────────────────────────────────────────────────
  // The failed step, or the whole execution, spent most of the timeout budget.
  // The runner holds the test timeout while the test stands stopped at Piwi's
  // pause bar, so the step's time is its own, its stops left out; the
  // execution's duration already leaves them out.
  const timeout = isFiniteNumber(input.timeout) && input.timeout > 0 ? input.timeout : null;
  if (timeout) {
    const stepDur = failedStepOwnMs;
    const execDur = isFiniteNumber(input.execution.duration) ? input.execution.duration : null;
    const stepRatio = stepDur != null ? stepDur / timeout : 0;
    const execRatio = execDur != null ? execDur / timeout : 0;
    if (stepRatio >= 0.8 || execRatio >= 0.95) {
      const pct = Math.round(Math.max(stepRatio, execRatio) * 100);
      facts.timing = { pct };
      add({
        id: 'timeout-budget',
        rule: 'timeout-budget',
        strength: 'medium',
        title: `The failure used ${pct}% of the timeout budget`,
        detail:
          stepRatio >= 0.8
            ? `The failed step ran ${Math.round(stepRatio * 100)}% of the ${timeout} ms timeout — a slow operation, not necessarily a wrong one.`
            : `The execution used ${Math.round(execRatio * 100)}% of the ${timeout} ms timeout before failing.`,
        citations: [{ section: 'steps' }],
        ...(failedStep ? { at: failedStep.at } : {}),
      });
    }
  }

  // ── environment-changed (medium / weak) ────────────────────────────────────
  // The same-environment baseline differs from this run's environment.
  const envDiff = input.environmentDiff;
  if (envDiff && envDiff.status === 'ok' && envDiff.entries && envDiff.entries.length > 0) {
    // Medium only when something the test actually drives changed (browser,
    // viewport, locale, timezone, base URL or the environment label). A tool
    // version bump or a color-scheme flip alone stays weak and never outranks a
    // content clue.
    const hasContentChange = envDiff.entries.some((e) => ENVIRONMENT_CONTENT_KEYS.has(e.key));
    const shown = envDiff.entries
      .slice(0, 3)
      .map((e) => e.label ?? e.key)
      .join(', ');
    add({
      id: 'environment-changed',
      rule: 'environment-changed',
      strength: hasContentChange ? 'medium' : 'weak',
      title: 'The environment changed since the last pass',
      detail: `Compared to the last passing run in the same environment: ${shown}.`,
      citations: [{ section: 'environmentDiff' }],
    });
  }

  // ── browser-specific (medium) ──────────────────────────────────────────────
  // The same test passed on at least one other browser in this run.
  const selfBrowser = input.execution.browser ?? input.execution.browserName ?? null;
  const passedElsewhere = input.browserPeers.filter(
    (peer) =>
      str(peer.status) === 'passed' &&
      (peer.browser ?? peer.browserName ?? null) !== selfBrowser &&
      (peer.browser ?? peer.browserName ?? null) != null,
  );
  if (passedElsewhere.length > 0) {
    const names = passedElsewhere.map((p) => str(p.browser) || str(p.browserName)).filter(Boolean);
    add({
      id: 'browser-specific',
      rule: 'browser-specific',
      strength: 'medium',
      title: 'The test passed on another browser',
      detail: `The same test passed on ${names.join(', ') || 'another browser'} in this run — the failure is browser-specific, not a universal break.`,
      citations: [{ section: 'browserDistribution' }],
    });
  }

  // ── known-flake-suspect (weak; strong once reproduced) ────────────────────
  // This failure shows a factor the test's history ranks as a flake suspect,
  // and a flake-lab experiment may have reproduced it.
  // A suspect a lab run reproduced outranks a higher-ranked one nobody tested.
  const shown = (input.flakeSuspects ?? []).filter((sus) => sus.executionIds.includes(input.execution.id));
  const suspect = shown.find((sus) => sus.reproduced) ?? shown[0];
  if (suspect) add(knownFlakeSuspectClue(suspect, input.networkRequests));

  // The fact that a fix landed before and did not hold is not a clue about the
  // cause; it belongs to the verdict's `since.fixedBefore` and the situation
  // sentence, so it is not emitted here.

  // Chain the clues into a story before ranking, so the tie-break can lift a
  // clue that belongs to the story above one that does not.
  const story = buildStory(clues, facts, target, parsed);
  const storyMembers = story ? new Set(story.clueIds) : null;

  // Rank: strength first, then story membership (a clue in the story leads),
  // then proximity to the failure moment (anchored clues closest to the failure
  // win; unanchored clues sort after them), then the fixed rule order. Cap so
  // the card and the prompt stay readable.
  const ruleRank = new Map(RULE_ORDER.map((r, i) => [r, i]));
  clues.sort((a, b) => {
    const strengthDelta = STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength];
    if (strengthDelta !== 0) return strengthDelta;
    if (storyMembers) {
      const aStory = storyMembers.has(a.id);
      const bStory = storyMembers.has(b.id);
      if (aStory !== bStory) return aStory ? -1 : 1;
    }
    const aAnchored = a.at != null && failureAt != null;
    const bAnchored = b.at != null && failureAt != null;
    if (aAnchored && bAnchored) {
      const proximity = Math.abs(failureAt! - a.at!) - Math.abs(failureAt! - b.at!);
      if (proximity !== 0) return proximity;
    } else if (aAnchored !== bAnchored) {
      return aAnchored ? -1 : 1;
    }
    return (ruleRank.get(a.rule) ?? 99) - (ruleRank.get(b.rule) ?? 99);
  });

  return { clues: clues.slice(0, MAX_CLUES), story };
}

type StoryFacts = {
  blockedState?: string;
  slowRequest?: { method: string; path: string; durSec: string };
  failedRequest?: { method: string; path: string; statusText: string };
  consoleLeadSec?: string | null;
  consoleLeadPaused?: string;
  reachableLocator?: string | null;
  renamed?: { role: string; oldName: string | null; newName: string | null };
  removed?: { role: string; name: string | null };
  wrongPage?: { endedPath: string; expected: string | null; via: 'request' | 'dialog' | null };
  worker?: { title: string; workerLabel: string | null };
  backend?: { method: string; path: string; logLine: string };
  timing?: { pct: number };
};

/**
 * Look for a known combination of clues on this execution and, when one is
 * found, chain its members into a single plain sentence built from the facts
 * the member clues captured. Returns null when no combination matches — the UI
 * then falls back to the top clue on its own.
 */
function buildStory(
  clues: FailureClue[],
  facts: StoryFacts,
  target: LocatorTarget,
  parsed: ParsedPlaywrightError | null,
): FailureStory | null {
  const has = (rule: FailureClueRule) => clues.some((c) => c.rule === rule);
  const idsOf = (rules: FailureClueRule[]) =>
    rules.flatMap((rule) => clues.filter((c) => c.rule === rule).map((c) => c.id));
  const strongestOf = (ids: string[]): FailureClueStrength => {
    const members = clues.filter((c) => ids.includes(c.id));
    return members.reduce<FailureClueStrength>(
      (best, c) => (STRENGTH_RANK[c.strength] < STRENGTH_RANK[best] ? c.strength : best),
      'weak',
    );
  };
  const make = (id: FailureStoryId, rules: FailureClueRule[], sentence: string): FailureStory => {
    const clueIds = idsOf(rules);
    return { id, sentence, clueIds, strength: strongestOf(clueIds) };
  };

  const elementLabel =
    target.role && target.name
      ? `the ${target.role} "${target.name}"`
      : target.name
        ? `"${target.name}"`
        : target.role
          ? `the ${target.role}`
          : 'the element';
  const action = str(parsed?.action) || 'action';

  // blocked-by-pending-request
  if (
    has('element-present-but-blocked') &&
    (has('slow-request-overlapping-failure') || has('failed-request-before-failure'))
  ) {
    const state = facts.blockedState ?? 'blocked';
    let because: string;
    if (facts.slowRequest) {
      because = `${facts.slowRequest.method} ${facts.slowRequest.path} was still in flight (${facts.slowRequest.durSec} s)`;
    } else if (facts.failedRequest) {
      because = `${facts.failedRequest.method} ${facts.failedRequest.path} ${facts.failedRequest.statusText}`;
    } else {
      because = 'a request never resolved';
    }
    const rules: FailureClueRule[] = [
      'element-present-but-blocked',
      facts.slowRequest ? 'slow-request-overlapping-failure' : 'failed-request-before-failure',
    ];
    let sentence = `${cap(elementLabel)} stayed ${state} because ${because}`;
    if (has('console-mentions-target')) {
      rules.push('console-mentions-target');
      sentence += facts.consoleLeadSec
        ? `; the console said so ${facts.consoleLeadSec} s before the ${action} gave up${facts.consoleLeadPaused ?? ''}`
        : `; the console said so before the ${action} gave up`;
    }
    return make('blocked-by-pending-request', rules, `${sentence}.`);
  }

  // renamed
  if (has('element-renamed') && has('page-structure-changed') && facts.renamed) {
    const r = facts.renamed;
    const reachable = facts.reachableLocator ? `; it is reachable as ${facts.reachableLocator}` : '';
    return make(
      'renamed',
      ['element-renamed', 'page-structure-changed'],
      `The ${r.role} the locator names was renamed from "${r.oldName ?? '?'}" to "${r.newName ?? '?'}" since the last pass${reachable}.`,
    );
  }

  // removed
  if (has('page-structure-changed') && !has('element-renamed') && facts.removed) {
    const r = facts.removed;
    const node = r.name ? `${r.role} "${r.name}"` : r.role;
    return make('removed', ['page-structure-changed'], `The ${node} is no longer on the page since the last pass.`);
  }

  // wrong-page
  if (has('wrong-page') && (has('failed-request-before-failure') || has('dialog-open-on-failure'))) {
    const via = has('failed-request-before-failure') ? 'the request' : 'the dialog';
    const rules: FailureClueRule[] = [
      'wrong-page',
      has('failed-request-before-failure') ? 'failed-request-before-failure' : 'dialog-open-on-failure',
    ];
    const ended = facts.wrongPage?.endedPath ?? 'another page';
    const expected = facts.wrongPage?.expected ? ` instead of ${facts.wrongPage.expected}` : '';
    return make('wrong-page', rules, `The test ended on ${ended}${expected} after ${via}.`);
  }

  // polluted-worker
  if (has('worker-pollution')) {
    const rules: FailureClueRule[] = ['worker-pollution'];
    if (has('lock-holder-failed')) rules.push('lock-holder-failed');
    const title = facts.worker?.title ?? 'the previous test';
    return make(
      'polluted-worker',
      rules,
      `The previous test on this worker ("${title}") failed and left state behind.`,
    );
  }

  // backend-error
  if (
    has('backend-error-attached') &&
    (has('failed-request-before-failure') || has('slow-request-overlapping-failure')) &&
    facts.backend
  ) {
    const rules: FailureClueRule[] = [
      'backend-error-attached',
      has('failed-request-before-failure') ? 'failed-request-before-failure' : 'slow-request-overlapping-failure',
    ];
    return make(
      'backend-error',
      rules,
      `${facts.backend.method} ${facts.backend.path} failed on the server: "${facts.backend.logLine}".`,
    );
  }

  // timing
  if (has('timeout-budget') && has('slow-request-overlapping-failure') && facts.timing && facts.slowRequest) {
    return make(
      'timing',
      ['timeout-budget', 'slow-request-overlapping-failure'],
      `The step used ${facts.timing.pct} % of the timeout waiting on ${facts.slowRequest.path}.`,
    );
  }

  return null;
}

/** Capitalize the first letter of a sentence fragment. */
function cap(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** An API request step (`request.get(…)`), by its category or its HTTP-method title. */
const API_REQUEST_LABEL_RE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|FETCH)\b/;

/**
 * The path of the last navigation step the test performed, from the timeline,
 * and whether the test clicked or typed successfully after it (an action that
 * can move the page on). A navigation step's own `params.url` (the full URL
 * newer Playwright records) is read first; otherwise the URL is parsed out of
 * the step label. An API request is not a navigation.
 */
function lastNavigation(timeline: FailureTimeline | null): { path: string | null; actedAfter: boolean } | null {
  if (!timeline) return null;
  const steps = timeline.lanes.steps;
  let actedAfter = false;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.category === 'api' || API_REQUEST_LABEL_RE.test(step.label)) continue;
    if (typeof step.params?.url === 'string' && step.params.url.length > 0) {
      return { path: pathOf(step.params.url), actedAfter };
    }
    const label = step.label;
    const m = /(?:goto|waitForURL)\(\s*['"`]([^'"`]+)['"`]/.exec(label) ?? /https?:\/\/[^\s'"`)]+/.exec(label);
    if (m) return { path: pathOf(m[1] ?? m[0]), actedAfter };
    if ((step.category === 'action' || step.category === 'input') && !step.failed) actedAfter = true;
  }
  return null;
}

/** Two paths differ once trailing slashes are ignored. */
function pathsDiffer(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  return norm(a) !== norm(b);
}

/**
 * Scenario gaps — proposing tests that do not exist yet from the feature graph
 * plus history. The detectors are pure functions over pre-loaded data so the
 * demo runs the same code; the orchestrators load that data and upsert the
 * `scenario_gaps` ledger, preserving triage across recomputation.
 *
 * Honest by construction: every "no test in this run" is paired with the count
 * from recent history, and the word used is *observed reach*, never coverage.
 */

import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  min,
  ne,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import {
  failureClusters,
  graphEdges,
  graphNodes,
  networkRequests,
  quarantinedTests,
  scenarioGaps,
  testCases,
  testFunctions,
  testRuns,
  testRunsCases,
  bugReports,
  locatorSnapshots,
  locatorUsages,
  projects,
} from '../../server/database/schema';
import {
  collectOwnOrigins,
  controlNodeKey,
  createDeclaredMatcher,
  fileRouteTarget,
  isOwnOriginRequest,
  originsFromDocumentRequests,
  parseRouteNodeKey,
  projectRouteOrigins,
  routeNodeKey,
  runBaseUrls,
  filePageTarget,
  linkNodeKey,
  routeKeyMatchesTarget,
  pageKeyMatchesTarget,
  templateAccessibleName,
} from '../graph';
import { LOCATING_METHODS, isInteractionAction, tryParseLocatorChain, type LocatorArg } from '../locator-chain';
import {
  scoreTargetMatch,
  urlMatches,
  type FunctionParamSource,
  type FunctionPatternStep,
  type MatchCandidate,
} from '@piwitests/core/function-match';
import { PATH_ANCHOR_HOST } from '@piwitests/core/page-key';
import { notLabRun } from './probes';
import { INVESTIGATION_RUN_ORIGINS, runOriginIn } from '../run-eligibility';
import { finalAttempts } from '../utils/test-counts';
import { projectDefaultBranch } from '../../server/utils/scm/stored-default-branch';
import { RETIRED_DETECTORS } from './detector-precision';
import type { DiffAnchor } from '@piwitests/core/diff-anchors';
import { predictLocatorBreaks, type PredictLocatorBreaksOptions } from '@piwitests/core/locator-break';
import type { LocatorIndex } from '@piwitests/core/locator-index';
import type { DrizzleDB } from './db';
import type { ChangeReach } from './change-coverage';
import { recordOutcome } from '../../server/utils/outcomes';
import { suggestionHash, type HandbackActor } from '../handback-outcomes';

// ── Vocabulary ───────────────────────────────────────────────────────────────

export type GapKind = 'gap' | 'finding';
export type GapClass = 'blind-spot' | 'false-comfort' | 'fragile' | 'unhandled' | 'degraded';
export type GapStatus = 'open' | 'snoozed' | 'dismissed' | 'accepted' | 'closed';

/** The window of recent runs every honest evidence line is measured against. */
export const HISTORY_WINDOW_RUNS = 30;
/** A route must be seen at least this many times before "always success" is a claim. */
const SUCCESS_ONLY_MIN_OBSERVATIONS = 5;
/** Each exposure factor is clamped here so a missing input can never zero a row. */
export const FACTOR_FLOOR = 0.1;

// ── Detected + scored shapes ─────────────────────────────────────────────────

/** A gap a detector proposes, before exposure ranking. */
export interface DetectedGap {
  detector: string;
  kind: GapKind;
  class: GapClass;
  /** Stable identity within `(project, detector)` so triage survives recompute. */
  key: string;
  title: string;
  evidence: string[];
  /** 0–1 — how strongly the evidence says this is a real gap. */
  confidence: number;
  testCaseId?: number | null;
  ticket?: string | null;
  /** The failure cluster this gap is about, when it is cluster-shaped. */
  failureClusterId?: number | null;
  /** Files whose churn/age/escape define exposure, when the gap is file-shaped. */
  files?: string[];
  /** `piwi:priority` observed around the subject, when known. */
  priority?: string | null;
}

/** The exposure factors behind a gap's rank, each in `[0.1, 1]`. */
export interface ExposureFactors {
  churn: number;
  age: number;
  escapeHistory: number;
  priority: number;
}

export interface ScoredGap extends DetectedGap {
  factors: ExposureFactors;
  score: number;
}

/** Per-file exposure inputs the server computes from the SCM providers. */
export interface FileExposure {
  /** Commits touching the file in the last 90 days. */
  churn?: number;
  /** Age of the file's first commit, in days. */
  ageDays?: number;
  /** True when the file appears in a cluster's first-bad or fixing commit. */
  escaped?: boolean;
}

export interface ExposureInputs {
  /** Keyed by file path; absent files fall back to the neutral floor. */
  files?: Map<string, FileExposure>;
}

// ── Exposure scoring (pure) ──────────────────────────────────────────────────

function clampFactor(value: number): number {
  if (!Number.isFinite(value)) return FACTOR_FLOOR;
  return Math.max(FACTOR_FLOOR, Math.min(1, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Map a `piwi:priority` tag to its exposure factor. */
export function priorityFactor(priority: string | null | undefined): number {
  switch (priority) {
    case 'critical':
      return 1;
    case 'high':
      return 0.7;
    case 'medium':
      return 0.4;
    case 'low':
      return 0.2;
    default:
      return FACTOR_FLOOR;
  }
}

/** Commits in 90 days → a churn factor; ~12+ commits saturates. */
function churnFactor(commits: number | undefined): number {
  if (!commits || commits <= 0) return FACTOR_FLOOR;
  return clampFactor(commits / 12);
}

/** Older files rank up — escaped defects concentrate in old, churned code. */
function ageFactor(ageDays: number | undefined): number {
  if (!ageDays || ageDays <= 0) return FACTOR_FLOOR;
  return clampFactor(ageDays / 365);
}

/**
 * Fold a gap's per-file exposure and observed priority into the four factors.
 * A file-shaped gap draws churn, age and escape from its files; a gap with no
 * file mapping keeps those at the floor, so it can never outrank a changed file.
 */
export function exposureFactorsFor(gap: DetectedGap, inputs: ExposureInputs): ExposureFactors {
  let churn = FACTOR_FLOOR;
  let age = FACTOR_FLOOR;
  let escapeHistory = FACTOR_FLOOR;

  const files = gap.files ?? [];
  for (const file of files) {
    const fx = inputs.files?.get(file);
    if (!fx) continue;
    churn = Math.max(churn, churnFactor(fx.churn));
    age = Math.max(age, ageFactor(fx.ageDays));
    if (fx.escaped) escapeHistory = 1;
  }

  return {
    churn,
    age,
    escapeHistory,
    priority: priorityFactor(gap.priority),
  };
}

/**
 * exposure = geometric mean of the four factors; gap score = exposure ×
 * confidence. The geometric mean reads on the same scale as one factor
 * (`[0.1, 1]`), so a score does not collapse toward `0.1⁴` and `minScore` stays
 * meaningful. It is a monotonic transform of the raw product, so it ranks gaps
 * of equal confidence the same way the product would.
 */
export function scoreGap(gap: DetectedGap, factors: ExposureFactors): number {
  const product = factors.churn * factors.age * factors.escapeHistory * factors.priority;
  const exposure = product <= 0 ? 0 : Math.pow(product, 1 / 4);
  return clamp01(gap.confidence) * exposure;
}

/** Attach exposure factors and a score to a detected gap. */
export function rankGap(gap: DetectedGap, inputs: ExposureInputs): ScoredGap {
  const factors = exposureFactorsFor(gap, inputs);
  return { ...gap, factors, score: scoreGap(gap, factors) };
}

/**
 * Rank a resilience finding by exposure × severity, never the protection
 * formula. The finding carries its severity in `confidence` (unhandled 1.0,
 * degraded 0.5); `exposure` is a proxy in [0.1, 1] (how much the route matters).
 */
export function rankFinding(gap: DetectedGap, exposure: number): ScoredGap {
  const exposureFactor = clampFactor(exposure);
  const factors: ExposureFactors = {
    churn: FACTOR_FLOOR,
    age: FACTOR_FLOOR,
    escapeHistory: FACTOR_FLOOR,
    priority: exposureFactor,
  };
  return { ...gap, factors, score: clamp01(gap.confidence) * exposureFactor };
}

// ── Detectors (pure) ─────────────────────────────────────────────────────────

/** Observed statuses of one route pattern over the recent window. */
export interface RouteStat {
  key: string;
  method: string;
  pattern: string;
  count: number;
  statuses: number[];
  priority?: string | null;
  /** Documented response codes from a declared manifest/OpenAPI, when known. */
  documentedCodes?: number[];
}

/**
 * Success only — a route whose observed statuses are all 2xx/3xx, so its error
 * paths were never exercised. Blind spot. Strengthened when a declared manifest
 * documents error codes the route never returned under test: the evidence names
 * them and the next step is the error path per documented code.
 */
export function detectSuccessOnly(routes: RouteStat[], windowRuns = HISTORY_WINDOW_RUNS): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const route of routes) {
    if (route.count < SUCCESS_ONLY_MIN_OBSERVATIONS) continue;
    const statuses = [...new Set(route.statuses)].sort((a, b) => a - b);
    if (statuses.length === 0) continue;
    if (!statuses.every((s) => s >= 200 && s < 400)) continue;

    const observed = new Set(statuses);
    const documentedErrors = [...new Set(route.documentedCodes ?? [])]
      .filter((c) => c >= 400 && !observed.has(c))
      .sort((a, b) => a - b);

    const range =
      statuses.length === 1 ? `always ${statuses[0]}` : `only ${statuses[0]}–${statuses[statuses.length - 1]}`;
    const base = `Observed ${route.count} times over the last ${windowRuns} runs, ${range} — observed reach, no error path exercised.`;
    const evidence =
      documentedErrors.length > 0
        ? [base, `Documents ${documentedErrors.join(', ')} — never returned under test.`]
        : [base];
    gaps.push({
      detector: 'success-only',
      kind: 'gap',
      class: 'blind-spot',
      key: route.key,
      title:
        documentedErrors.length > 0
          ? `${route.method} ${route.pattern}: documented ${documentedErrors.join('/')} never tested`
          : `${route.method} ${route.pattern}: no error path under test`,
      evidence,
      confidence: clamp01(route.count / (SUCCESS_ONLY_MIN_OBSERVATIONS * 4) + (documentedErrors.length > 0 ? 0.3 : 0)),
      priority: route.priority ?? null,
    });
  }
  return gaps;
}

/** A declared route/page node and how many tests reach it. */
export interface DeclaredNode {
  nodeKind: 'route' | 'page';
  nodeKey: string;
  origin: 'manifest' | 'openapi';
  reachCount: number;
  /** Documented response codes, for a route declared via OpenAPI. */
  documentedCodes?: number[];
  priority?: string | null;
}

/**
 * Declared, never hit — a node the application declares (a manifest or OpenAPI
 * route, a declared page) that no test reaches. Blind spot. The origin is named
 * so "declared and never observed" is never confused with "never observed at
 * all".
 */
export function detectDeclaredNeverHit(nodes: DeclaredNode[], windowRuns = HISTORY_WINDOW_RUNS): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const node of nodes) {
    if (node.reachCount > 0) continue;
    const where = node.origin === 'openapi' ? 'OpenAPI' : 'the manifest';
    const codes =
      node.nodeKind === 'route' && node.documentedCodes?.length
        ? ` · documents ${[...new Set(node.documentedCodes)].sort((a, b) => a - b).join(', ')}`
        : '';
    gaps.push({
      detector: 'declared-never-hit',
      kind: 'gap',
      class: 'blind-spot',
      key: `${node.nodeKind}:${node.nodeKey}`,
      title: `Declared ${node.nodeKind} ${node.nodeKey} — never reached`,
      evidence: [`Declared in ${where} · 0 tests in ${windowRuns} runs${codes} — observed reach.`],
      confidence: 0.7,
      priority: node.priority ?? null,
    });
  }
  return gaps;
}

/** Why a test's reach is not trusted. */
export type UntrustedReason = 'flaky' | 'quarantined' | 'skipped' | 'did-not-run';

/** How an untrusted test is named in evidence. */
const UNTRUSTED_LABEL: Record<UntrustedReason | 'untrusted', string> = {
  flaky: 'flaky',
  quarantined: 'quarantined',
  skipped: 'skipped',
  'did-not-run': 'did not run',
  untrusted: 'untrusted',
};

/** The untrusted tests an evidence line names; the rest are counted. */
const UNTRUSTED_NAMED = 3;

/** A node's reach — which test cases observably exercise it. */
export interface NodeReach {
  nodeKind: string;
  nodeKey: string;
  /**
   * Distinct test cases reaching this node, each with its display title.
   * `trusted` is false for a flaky, quarantined or currently-skipped test, and
   * `untrustedReason` says which; absent counts as trusted, so pure callers need
   * not set it.
   */
  tests: Array<{
    testCaseId: number;
    title: string;
    priority?: string | null;
    trusted?: boolean;
    untrustedReason?: UntrustedReason;
  }>;
}

/**
 * Single covering test — a node reached by exactly one *trusted* test, or by
 * tests none of which is trusted. Fragile: one flaky test away from no coverage
 * at all. Flaky, quarantined and skipped tests are not trusted reach, so a
 * trusted test plus a flaky one is single, not double, and a node only untrusted
 * tests reach is named with the reason each is not trusted.
 */
export function detectSingleCoveringTest(nodes: NodeReach[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const node of nodes) {
    const trustedTests = node.tests.filter((t) => t.trusted !== false);
    if (trustedTests.length === 0 && node.tests.length > 0) {
      gaps.push(untrustedOnlyGap(node));
      continue;
    }
    if (trustedTests.length !== 1) continue;
    const only = trustedTests[0]!;
    gaps.push({
      detector: 'single-covering-test',
      kind: 'gap',
      class: 'fragile',
      key: `${node.nodeKind}:${node.nodeKey}`,
      title: `Only one test reaches ${node.nodeKind} ${nodeLabel(node.nodeKind, node.nodeKey)}`,
      evidence: [`Only ${only.title} reaches this — observed reach. A second scenario would make it resilient.`],
      confidence: 0.5,
      testCaseId: only.testCaseId,
      priority: only.priority ?? null,
    });
  }
  return gaps;
}

/** The gap for a node only untrusted tests reach, naming each test and why it is not trusted. */
function untrustedOnlyGap(node: NodeReach): DetectedGap {
  // Highest priority first, then by title and id, so the evidence and the draft's
  // starting test are the same on every recompute.
  const tests = [...node.tests].sort(
    (a, b) =>
      priorityFactor(b.priority) - priorityFactor(a.priority) ||
      a.title.localeCompare(b.title) ||
      a.testCaseId - b.testCaseId,
  );
  const named = tests
    .slice(0, UNTRUSTED_NAMED)
    .map((t) => `${t.title} (${UNTRUSTED_LABEL[t.untrustedReason ?? 'untrusted']})`);
  if (tests.length > UNTRUSTED_NAMED) named.push(`${tests.length - UNTRUSTED_NAMED} more`);
  const list = named.length === 1 ? named[0]! : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return {
    detector: 'single-covering-test',
    kind: 'gap',
    class: 'fragile',
    key: `${node.nodeKind}:${node.nodeKey}`,
    title: `No trusted test reaches ${node.nodeKind} ${nodeLabel(node.nodeKind, node.nodeKey)}`,
    evidence: [
      `Only ${list} ${tests.length === 1 ? 'reaches' : 'reach'} this — observed reach. A trusted scenario would make it resilient.`,
    ],
    confidence: 0.6,
    testCaseId: tests[0]!.testCaseId,
    priority: tests[0]!.priority ?? null,
  };
}

/** A node with its first- and last-seen runs and reach count. */
export interface NodeDrift {
  nodeKind: string;
  nodeKey: string;
  firstSeenRunId: number | null;
  reachCount: number;
  priority?: string | null;
}

/**
 * A node's name in a gap title. Link keys carry their own `link:` prefix, which
 * the title's kind word already says.
 */
function nodeLabel(kind: string, key: string): string {
  return key.startsWith(`${kind}:`) ? key.slice(kind.length + 1) : key;
}

/**
 * Surface drift — a node first seen in the latest run that no test reaches: new
 * surface the suite does not exercise yet. A new node a test already reaches is
 * covered, not drift. Features are derived from test tags, not surface, so they
 * never drift; and the run that built the project's graph first
 * (`firstGraphRunId`) has nothing to compare with, so every node it saw is the
 * baseline, not drift.
 */
export function detectSurfaceDrift(
  nodes: NodeDrift[],
  latestRunId: number | null,
  firstGraphRunId: number | null = null,
): DetectedGap[] {
  if (latestRunId == null || latestRunId === firstGraphRunId) return [];
  const gaps: DetectedGap[] = [];
  for (const node of nodes) {
    if (node.firstSeenRunId !== latestRunId) continue;
    if (node.nodeKind === 'feature' || node.reachCount > 0) continue;
    gaps.push({
      detector: 'surface-drift',
      kind: 'gap',
      class: 'blind-spot',
      key: `${node.nodeKind}:${node.nodeKey}`,
      title: `New ${node.nodeKind} ${nodeLabel(node.nodeKind, node.nodeKey)} — confirm it is tested`,
      evidence: [`Appeared in run #${latestRunId}; no test reaches it yet — observed reach.`],
      confidence: 0.4,
      priority: node.priority ?? null,
    });
  }
  return gaps;
}

/** One changed file and whether a test reached it, by the rule of change coverage. */
export interface ChangedFileReach {
  filePath: string;
  additions: number;
  deletions: number;
  reach: ChangeReach;
  /** How many changed lines the head commit's coverage counts, when it counts some. */
  lines?: { changed: number } | null;
  ticket?: string | null;
}

/**
 * Changed, unreached — a changed file Piwi can observe that no test reached, in
 * this run or the recent window, and no suite of the head commit's coverage
 * ran a changed line of: an uncovered change. Blind spot, reported per ticket
 * at change time. A file reached only in the window is a narrowed run, and one
 * nothing can observe says nothing; neither opens a gap.
 */
export function detectChangedUnreached(
  files: ChangedFileReach[],
  runId: number,
  windowRuns = HISTORY_WINDOW_RUNS,
): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const file of files) {
    if (file.reach !== 'unreached') continue;
    const evidence = [
      `+${file.additions} −${file.deletions} · no test in run #${runId} or in the last ${windowRuns} runs — observed reach.`,
    ];
    if (file.lines) {
      const n = file.lines.changed;
      evidence.push(`None of its ${n} changed ${n === 1 ? 'line' : 'lines'} ran in the head commit's coverage.`);
    }
    gaps.push({
      detector: 'changed-unreached',
      kind: 'gap',
      class: 'blind-spot',
      key: file.filePath,
      title: `${file.filePath} changed but not reached`,
      evidence,
      confidence: 0.9,
      files: [file.filePath],
      ticket: file.ticket ?? null,
    });
  }
  return gaps;
}

/**
 * Close the open and snoozed *changed, unreached* gaps of `filePaths`: files a
 * test now reaches by the rule of change coverage. Returns how many closed.
 */
export async function closeReachedChangedFiles(
  db: DrizzleDB,
  projectId: number,
  runId: number | null,
  filePaths: string[],
): Promise<number> {
  if (filePaths.length === 0) return 0;
  const now = new Date();
  let closed = 0;
  for (let i = 0; i < filePaths.length; i += 100) {
    const rows = await db
      .update(scenarioGaps)
      .set({ status: 'closed', closedAt: now, closedByRunId: runId, updatedAt: now })
      .where(
        and(
          eq(scenarioGaps.projectId, projectId),
          eq(scenarioGaps.detector, 'changed-unreached'),
          inArray(scenarioGaps.status, ['open', 'snoozed']),
          inArray(scenarioGaps.key, filePaths.slice(i, i + 100)),
        ),
      )
      .returning({ id: scenarioGaps.id });
    closed += rows.length;
  }
  return closed;
}

// ── Graph and outcome detectors (pure) ───────────────────────────────────────

/** A control node and how the suite touches it. */
export interface ControlReach {
  key: string;
  /** Number of pages that contain this control. */
  pageCount: number;
  /** Distinct tests whose locators target it. */
  reachCount: number;
  /** Of those, the tests recorded only by hand (a covered-by), not observed. */
  manualReachCount?: number;
  /** Tests that operated an element the locator index could not name on a page holding it. */
  unresolvedTests?: number;
}

/**
 * Control nobody exercises — a control the suite has seen on a page but no
 * locator ever targets. Blind spot. Requires the project to have some observed
 * control reach: with no observed test→control edge anywhere, every inventoried
 * control would flag, so the detector stays silent until reach exists to
 * compare against. A covering test recorded by hand does not count as observed.
 * A control on a page where a test operated an element the locator index could
 * not name is not raised: that locator may have targeted it.
 */
export function detectControlNobodyExercises(controls: ControlReach[]): DetectedGap[] {
  if (!controls.some((c) => c.reachCount - (c.manualReachCount ?? 0) > 0)) return [];
  const gaps: DetectedGap[] = [];
  for (const c of controls) {
    if (c.reachCount > 0) continue;
    if (c.pageCount === 0) continue;
    if ((c.unresolvedTests ?? 0) > 0) continue;
    gaps.push({
      detector: 'control-nobody-exercises',
      kind: 'gap',
      class: 'blind-spot',
      key: `control:${c.key}`,
      title: `No test exercises control ${c.key}`,
      evidence: [`On ${c.pageCount} page${c.pageCount === 1 ? '' : 's'} · no locator targets it — observed reach.`],
      confidence: clamp01(0.3 + Math.min(0.5, c.pageCount / 10)),
    });
  }
  return gaps;
}

/** A page node, whether a test reached it, and how many pages link to it. */
export interface PageLinkReach {
  key: string;
  reached: boolean;
  linkedFrom: number;
}

/**
 * Reachable, unvisited — a page linked from other pages that no test ever
 * navigates to. Blind spot.
 */
export function detectReachableUnvisited(pages: PageLinkReach[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const p of pages) {
    if (p.reached || p.linkedFrom === 0) continue;
    gaps.push({
      detector: 'reachable-unvisited',
      kind: 'gap',
      class: 'blind-spot',
      key: `page:${p.key}`,
      title: `${p.key} is linked but never visited`,
      evidence: [
        `Linked from ${p.linkedFrom} page${p.linkedFrom === 1 ? '' : 's'} · never navigated to — observed reach.`,
      ],
      confidence: clamp01(0.4 + Math.min(0.4, p.linkedFrom / 10)),
    });
  }
  return gaps;
}

/**
 * All probe outcomes for one route, aggregated across the tests that probed it.
 * Several tests can probe one route with opposite outcomes, so the outcomes are
 * kept per test and reduced deterministically rather than letting the last edge
 * in database order decide.
 */
export interface CheckOutcome {
  routeKey: string;
  /** True when at least one trusted test noticed a probe on this route. */
  noticed: boolean;
  /** The tests whose probe went unnoticed, each with the fault it saw. */
  notNoticed: Array<{ testCaseId: number; title: string; fault: string | null }>;
  /** Exposure proxy — how many tests reach the node. */
  exposure: number;
}

/** A node must be at least this exposed for a not-noticed probe to be a gap. */
const NOT_NOTICED_MIN_EXPOSURE = 1;

/**
 * Not noticed — a probe made a route return garbage and every test still passed.
 * The most dangerous class: the catalog says it is covered. False comfort. A
 * route that any trusted test noticed is checked, so it is never a gap even when
 * another test did not notice; a gap names the tests that did not.
 */
export function detectNotNoticed(checks: CheckOutcome[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const c of checks) {
    if (c.noticed || c.notNoticed.length === 0) continue;
    if (c.exposure < NOT_NOTICED_MIN_EXPOSURE) continue;
    const tests = [...c.notNoticed].sort((a, b) => a.testCaseId - b.testCaseId);
    const fault = tests[0]!.fault ? ` (${tests[0]!.fault})` : '';
    const names = tests.map((t) => t.title).join(', ');
    gaps.push({
      detector: 'not-noticed',
      kind: 'gap',
      class: 'false-comfort',
      key: `route:${c.routeKey}`,
      title: `Tests pass when ${c.routeKey} breaks`,
      evidence: [
        `A probe${fault} on ${c.routeKey} did not make ${names} fail — assert the effect the request should have.`,
      ],
      confidence: 0.8,
    });
  }
  return gaps;
}

/** A dependency node and how the suite probes it. */
export interface DependencyProbeStatus {
  dependencyKey: string;
  /** Route keys whose handlers call this dependency. */
  calledByRoutes: string[];
  /** True when any test has a `checks` edge on this dependency. */
  probed: boolean;
}

/**
 * Unprobed dependency — a dependency a handler calls that no probe has ever
 * checked. False comfort (a prior): the suite reaches the routes that call it,
 * but no test has been shown to fail when the dependency does.
 */
export function detectUnprobedDependency(deps: DependencyProbeStatus[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const d of deps) {
    if (d.probed || d.calledByRoutes.length === 0) continue;
    gaps.push({
      detector: 'unprobed-dependency',
      kind: 'gap',
      class: 'false-comfort',
      key: `dependency:${d.dependencyKey}`,
      title: `${d.dependencyKey} is never probed`,
      evidence: [
        `Called by ${d.calledByRoutes.length} route${d.calledByRoutes.length === 1 ? '' : 's'} · no probe has checked what happens when it fails — schedule a dependency probe.`,
      ],
      confidence: clamp01(0.3 + Math.min(0.4, d.calledByRoutes.length / 10)),
    });
  }
  return gaps;
}

/** One server-probe resilience signal: what the app did while a fault was applied. */
export interface ResilienceSignal {
  routeKey: string;
  dependency?: string | null;
  handled: 'degraded' | 'unhandled';
  testTitle: string;
  testCaseId?: number | null;
  /** How many tests reach the route — the exposure proxy the finding ranks by. */
  exposure?: number;
}

/**
 * Not handled — a resilience finding, not a suite gap: under a server-injected
 * fault the application did not degrade gracefully (unhandled) or degraded
 * visibly (degraded), whether or not a test noticed. Ranked by exposure ×
 * severity, so `confidence` carries the severity (unhandled 1.0, degraded 0.5)
 * and never the protection formula.
 */
export function detectNotHandled(signals: ResilienceSignal[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const s of signals) {
    if (s.handled !== 'degraded' && s.handled !== 'unhandled') continue;
    const target = s.dependency ? `${s.dependency} (via ${s.routeKey})` : s.routeKey;
    const verb = s.handled === 'unhandled' ? 'did not handle' : 'degraded under';
    gaps.push({
      detector: 'not-handled',
      kind: 'finding',
      class: s.handled,
      key: s.dependency ? `dependency:${s.dependency} @ ${s.routeKey}` : `route:${s.routeKey}`,
      title: `${target}: ${s.handled} failure`,
      evidence: [
        `A server probe made ${target} fail; the application ${verb} it (${s.testTitle}) — an error-state scenario is missing.`,
      ],
      // Severity as confidence so the exposure × confidence score is exposure × severity.
      confidence: s.handled === 'unhandled' ? 1 : 0.5,
      testCaseId: s.testCaseId ?? null,
    });
  }
  return gaps;
}

/** A feature's observed coverage across the test matrix. */
export interface MatrixFeature {
  feature: string;
  priority?: string | null;
  /** Observed browser names. */
  browsers: string[];
  /** Observed viewport classes (e.g. `desktop`, `mobile`). */
  viewports: string[];
  /** Observed environments. */
  environments: string[];
  /** Flag name → the states it was observed in (e.g. `['on']`). */
  flags: Record<string, string[]>;
}

/** The project-wide dimensions a feature's coverage is judged against. */
export interface MatrixContext {
  browsers: string[];
  viewports: string[];
  environments: string[];
}

/**
 * Matrix — a feature exercised on only one axis of a dimension the project
 * covers elsewhere: one browser, one viewport class, one environment, or a flag
 * seen in only one state. Fragile. Only critical and high-priority features are
 * flagged, so the matrix does not drown a project in low-value combinations.
 */
export function detectMatrix(features: MatrixFeature[], ctx: MatrixContext): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const f of features) {
    const rank = PRIORITY_RANK[(f.priority ?? '').toLowerCase()] ?? 0;
    if (rank < PRIORITY_RANK.high!) continue; // critical/high only
    const missing: string[] = [];
    if (ctx.browsers.length > 1 && f.browsers.length === 1) missing.push(`${f.browsers[0]} only`);
    if (ctx.viewports.length > 1 && f.viewports.length === 1) missing.push(`${f.viewports[0]} viewport only`);
    if (ctx.environments.length > 1 && f.environments.length === 1)
      missing.push(`${f.environments[0]} environment only`);
    for (const [flag, states] of Object.entries(f.flags)) {
      if (states.length === 1) missing.push(`flag ${flag} only ${states[0]}`);
    }
    if (missing.length === 0) continue;
    gaps.push({
      detector: 'matrix',
      kind: 'gap',
      class: 'fragile',
      key: `feature:${f.feature}`,
      title: `${f.feature}: thin test matrix`,
      evidence: [`${f.priority ?? 'high'} · ${missing.join(' · ')} — add the missing Playwright project.`],
      confidence: 0.5,
      priority: f.priority ?? null,
    });
  }
  return gaps;
}

/** A tracker bug and whether a failure cluster is already linked to it. */
export interface EscapedDefectInput {
  key: string;
  title: string;
  labels: string[];
  /** True when a failure cluster already links this bug. */
  hasLinkedCluster: boolean;
  /** The feature the bug was matched to (by label, feature name or title words), if any. */
  matchedFeature?: string | null;
}

/**
 * Escaped defect — a tracker bug with no linked failure cluster: a defect that
 * escaped the suite. Blind spot. Feeds escape history, so the area it names ranks
 * higher next time. The matching (label / feature / title words) is done by the
 * loader; this scores the unlinked ones.
 */
export function detectEscapedDefect(bugs: EscapedDefectInput[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const bug of bugs) {
    if (bug.hasLinkedCluster) continue;
    const feature = bug.matchedFeature ? ` · ${bug.matchedFeature}` : '';
    gaps.push({
      detector: 'escaped-defect',
      kind: 'gap',
      class: 'blind-spot',
      key: `ticket:${bug.key}`,
      title: `${bug.key} escaped the suite: ${bug.title}`,
      evidence: [
        `${bug.key} · no failure cluster links it${feature} — a scenario for this issue would catch it next time.`,
      ],
      confidence: 0.6,
    });
  }
  return gaps;
}

/** A bug report still open: a defect that reached someone before any test caught it. */
export interface ReportedBugInput {
  id: number;
  title: string;
  /** The page it was reported on, as the Test Map keys pages. */
  pageKey: string | null;
}

/**
 * Escaped defects reported from Piwi Picker, one blind spot per page: every
 * open report is a bug the suite let through on that page, so the page ranks
 * higher until a test names each report (`piwi:bug`), which moves it on.
 */
export function detectReportedBugEscapes(reports: ReportedBugInput[]): DetectedGap[] {
  const byPage = new Map<string, ReportedBugInput[]>();
  for (const report of reports) {
    if (!report.pageKey) continue;
    byPage.set(report.pageKey, [...(byPage.get(report.pageKey) ?? []), report]);
  }
  return [...byPage.entries()].map(([page, list]) => ({
    detector: 'escaped-defect',
    kind: 'gap',
    class: 'blind-spot',
    key: `page:${page}`,
    title:
      list.length === 1
        ? `A reported bug escaped the suite on ${page}: ${list[0]!.title}`
        : `${list.length} reported bugs escaped the suite on ${page}`,
    evidence: list.map(
      (r) => `Bug report #${r.id}: ${r.title} — no test names it yet; commit its failing test (piwi:bug ${r.id}).`,
    ),
    confidence: Math.min(1, 0.6 + 0.1 * (list.length - 1)),
  }));
}

/** A test and the set of nodes it reaches, each with whether it was seen recently. */
export interface TestReachRecency {
  testCaseId: number;
  title: string;
  /** Nodes this test reaches; empty means it reaches nothing observable. */
  reachedNodes: Array<{ seenRecently: boolean }>;
  priority?: string | null;
}

/**
 * Orphan test — a test whose every reached node vanished from the recent window.
 * Fragile: it may be exercising surface that no longer exists.
 */
export function detectOrphanTest(tests: TestReachRecency[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const t of tests) {
    if (t.reachedNodes.length === 0) continue;
    if (t.reachedNodes.some((n) => n.seenRecently)) continue;
    gaps.push({
      detector: 'orphan-test',
      kind: 'gap',
      class: 'fragile',
      key: `test:${t.testCaseId}`,
      title: `${t.title} reaches only vanished surface`,
      evidence: [
        `All ${t.reachedNodes.length} node${t.reachedNodes.length === 1 ? '' : 's'} it reaches disappeared from recent runs — retire or repoint it.`,
      ],
      confidence: 0.4,
      testCaseId: t.testCaseId,
      priority: t.priority ?? null,
    });
  }
  return gaps;
}

/** A failure cluster whose fix later regressed. */
export interface RegressedCluster {
  clusterId: number;
  title: string;
  fixCommit?: string | null;
  daysSinceFix?: number | null;
}

/** Fix did not hold — a cluster that was fixed and then regressed. Fragile. */
export function detectFixDidNotHold(clusters: RegressedCluster[]): DetectedGap[] {
  return clusters.map((c) => ({
    detector: 'fix-did-not-hold',
    kind: 'gap' as const,
    class: 'fragile' as const,
    key: `cluster:${c.clusterId}`,
    title: `A fix for "${c.title}" did not hold`,
    evidence: [
      c.fixCommit
        ? `Fixed in ${c.fixCommit.slice(0, 7)}${c.daysSinceFix != null ? ` · regressed ${c.daysSinceFix} day${c.daysSinceFix === 1 ? '' : 's'} later` : ' · regressed since'} — a regression test would pin it.`
        : `Fixed once and regressed — a regression test would pin it.`,
    ],
    confidence: 0.6,
    failureClusterId: c.clusterId,
  }));
}

/** A test's phantom status: skipped/fixme/did-not-run/blocked for how long. */
export interface PhantomTest {
  testCaseId: number;
  title: string;
  /** 'skipped' | 'didnotrun' | 'fixme' | 'blocked'. */
  reason: string;
  daysStale: number;
}

/** A phantom is only reported once it has been stale this long. */
const PHANTOM_MIN_DAYS = 30;

/**
 * Phantom coverage — a test skipped, fixme, did-not-run or blocked for over a
 * month. Fragile: it discounts every node it used to reach. Also lowers the
 * reach factor of those nodes (handled by the caller).
 */
export function detectPhantomCoverage(tests: PhantomTest[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const t of tests) {
    if (t.daysStale < PHANTOM_MIN_DAYS) continue;
    gaps.push({
      detector: 'phantom-coverage',
      kind: 'gap',
      class: 'fragile',
      key: `test:${t.testCaseId}`,
      title: `${t.title} has not really run in ${t.daysStale} days`,
      evidence: [`${t.reason} ${t.daysStale} days · it no longer protects the nodes it used to reach.`],
      confidence: clamp01(0.3 + Math.min(0.5, t.daysStale / 120)),
      testCaseId: t.testCaseId,
    });
  }
  return gaps;
}

/** A passing execution that logged an error the suite ignored. */
export interface PassedWithError {
  testCaseId: number;
  title: string;
  /** What the application reported, e.g. 'run #42 · POST /api/audit returned 500'. */
  detail: string;
}

/**
 * Passed with errors — a test passed while a console error, a backend Error log
 * or a background 5xx went unremarked. False comfort.
 */
export function detectPassedWithErrors(execs: PassedWithError[]): DetectedGap[] {
  return execs.map((e) => ({
    detector: 'passed-with-errors',
    kind: 'gap' as const,
    class: 'false-comfort' as const,
    key: `test:${e.testCaseId}`,
    title: `${e.title} passed with errors`,
    evidence: [`Passed · ${e.detail} — nothing in the test failed on it; assert the flow ends without errors.`],
    confidence: 0.6,
    testCaseId: e.testCaseId,
  }));
}

/** A catalog method and whether any test calls it, plus whether its page is reached. */
export interface CatalogMethodReach {
  module: string;
  name: string;
  /** How the title names it, `cartPage.applyCoupon`; the bare name when absent. */
  label?: string;
  callCount: number;
  pageReachedBy: number;
}

/**
 * Catalog method, no test calls — a page-object method the catalog owns that no
 * test calls, on a page the suite reaches. The cheapest gap: the steps exist.
 */
export function detectCatalogMethodNoTestCalls(methods: CatalogMethodReach[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const m of methods) {
    if (m.callCount > 0) continue;
    if (m.pageReachedBy === 0) continue;
    gaps.push({
      detector: 'catalog-method-no-test-calls',
      kind: 'gap',
      class: 'blind-spot',
      key: `catalog:${m.module}#${m.name}`,
      title: `${m.label ?? m.name} is never called`,
      evidence: [
        `${m.module} · ${m.name} · page reached by ${m.pageReachedBy}, called by 0 — the cheapest gap, its steps already exist.`,
      ],
      confidence: 0.5,
    });
  }
  return gaps;
}

/** A cluster diagnosis and whether its cause maps to any affected test's identity. */
export interface IncidentalCatchInput {
  clusterId: number;
  causeFile: string;
  /** The test that caught it, for the evidence line. */
  catcherTitle: string;
  /** True when the cause file appears in an affected test's title, tags, feature or reach. */
  causeInAffectedIdentity: boolean;
}

/**
 * Incidental catch — a cluster's diagnosed cause is in a file none of the tests
 * that failed are actually about; they caught it by accident. Fragile.
 */
export function detectIncidentalCatch(inputs: IncidentalCatchInput[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const i of inputs) {
    if (i.causeInAffectedIdentity) continue;
    gaps.push({
      detector: 'incidental-catch',
      kind: 'gap',
      class: 'fragile',
      key: `cluster:${i.clusterId}`,
      title: `${i.causeFile} is caught only incidentally`,
      evidence: [
        `Cause ${i.causeFile} · caught by ${i.catcherTitle}, which is not about it — a targeted regression test would pin it.`,
      ],
      confidence: 0.45,
      files: [i.causeFile],
      failureClusterId: i.clusterId,
    });
  }
  return gaps;
}

/** A page and its assertion strength: tests on it and how many assert on data. */
export interface AssertionLightPage {
  pageKey: string;
  testCount: number;
  /** Tests with a data (non-visibility) `expect` on this page. */
  dataAssertions: number;
}

/**
 * Assertion-light — tests reach a page but none makes a data assertion on it.
 * The false-comfort prior before a probe runs.
 */
export function detectAssertionLight(pages: AssertionLightPage[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const p of pages) {
    if (p.testCount === 0 || p.dataAssertions > 0) continue;
    gaps.push({
      detector: 'assertion-light',
      kind: 'gap',
      class: 'false-comfort',
      key: `page:${p.pageKey}`,
      title: `${p.pageKey} is asserted only by visibility`,
      evidence: [
        `${p.testCount} test${p.testCount === 1 ? '' : 's'} assert${p.testCount === 1 ? 's' : ''} on this page, only that elements are present — check a value (a text, a count, a field), or schedule a probe.`,
      ],
      confidence: 0.4,
    });
  }
  return gaps;
}

/** Matchers that check an element is there, not what it shows. */
const PRESENCE_MATCHERS = new Set(['toBeVisible', 'toBeHidden', 'toBeAttached', 'toBeInViewport']);

/** The text a locator's last locating call finds its element by, when it is a string. */
function locatorText(target: string): string | null {
  const calls = tryParseLocatorChain(target)?.calls.filter((c) => LOCATING_METHODS.has(c.method)) ?? [];
  const call = calls[calls.length - 1];
  if (!call) return null;
  if (call.method === 'getByRole') {
    const options = call.args[1]?.type === 'object' ? call.args[1].entries : [];
    return stringArg(options.find(([k]) => k === 'name')?.[1]);
  }
  return ['getByText', 'getByLabel', 'getByTitle', 'getByAltText', 'getByPlaceholder'].includes(call.method)
    ? stringArg(call.args[0])
    : null;
}

/**
 * Per page, the tests that assert on it and how many of them check a value. An
 * `expect` on presence alone (visible, hidden, attached, in the viewport, or
 * their negations) is the light kind, unless the element is found by a text
 * holding a number (`getByText('Total: $42.00')`), which names a value the page
 * computed. Any other matcher, and any read of the element the index cannot name
 * (a count, an evaluate, a text read), counts as a value check. A page no test
 * asserts on is a step of a journey, not a light assertion, and is left out, and
 * so is a page the graph does not hold.
 */
export function assertionLightPages(
  uses: ReadonlyArray<{ testCaseId: number; action: string; page: string; target?: string }>,
  graphPages: ReadonlySet<string>,
): AssertionLightPage[] {
  const presence = new Map<string, Set<number>>();
  const value = new Map<string, Set<number>>();
  const add = (map: Map<string, Set<number>>, page: string, id: number) => {
    let set = map.get(page);
    if (!set) map.set(page, (set = new Set()));
    set.add(id);
  };
  for (const u of uses) {
    if (!u.page || !graphPages.has(u.page)) continue;
    if (isInteractionAction(u.action) || u.action === 'waitFor') continue;
    const matcher = u.action.startsWith('expect.') ? u.action.slice('expect.'.length).replace(/^not\./, '') : null;
    const namesValue = !!u.target && /\d/.test(locatorText(u.target) ?? '');
    if (matcher && PRESENCE_MATCHERS.has(matcher) && !namesValue) add(presence, u.page, u.testCaseId);
    else add(value, u.page, u.testCaseId);
  }
  return [...presence].map(([pageKey, tests]) => ({
    pageKey,
    testCount: new Set([...tests, ...(value.get(pageKey) ?? [])]).size,
    dataAssertions: value.get(pageKey)?.size ?? 0,
  }));
}

/** A catalog entry as the catalog detector reads it. */
export interface CatalogEntryReachInput {
  module: string;
  name: string;
  kind: string;
  receiver: string | null;
  urlPattern: string | null;
  steps: FunctionPatternStep[];
  paramSources: FunctionParamSource[];
}

/** What the last locating call of a chain says about its element, for a catalog step's target to match. */
function locatorMatchCandidate(locator: string): MatchCandidate | null {
  const calls = tryParseLocatorChain(locator)?.calls.filter((c) => LOCATING_METHODS.has(c.method)) ?? [];
  const call = calls[calls.length - 1];
  if (!call) return null;
  const first = stringArg(call.args[0]);
  if (!first) return null;
  const candidate: MatchCandidate = { role: null, testId: null, accessibleName: null, text: null };
  if (call.method === 'getByRole') {
    const options = call.args[1]?.type === 'object' ? call.args[1].entries : [];
    return { ...candidate, role: first, accessibleName: stringArg(options.find(([k]) => k === 'name')?.[1]) };
  }
  if (call.method === 'getByTestId') return { ...candidate, testId: first };
  if (call.method === 'getByText') return { ...candidate, text: first };
  if (['getByLabel', 'getByPlaceholder', 'getByTitle', 'getByAltText'].includes(call.method)) {
    return { ...candidate, accessibleName: first };
  }
  return null;
}

/** Whether a catalog step's action is the one a locator use records. */
function catalogActionMatches(step: FunctionPatternStep['action'], action: string): boolean {
  if (step === 'assertVisible') return action === 'expect.toBeVisible';
  if (step === 'assert') return action.startsWith('expect');
  if (step === 'click' || step === 'press') return action === 'click' || action === 'press';
  return action === step;
}

/** The URL a page key stands for, for a catalog entry's URL pattern. */
function pageKeyUrl(pageKey: string): string {
  return `http://${PATH_ANCHOR_HOST}${pageKey.startsWith('/') ? '' : '/'}${pageKey}`;
}

/**
 * Whether a catalog URL pattern matches a page, read the one way for every
 * caller: against the page's own URL when the graph holds one (so a pattern
 * naming an origin matches), else against its path, anchored. A page of another
 * site is keyed with its origin, which is its URL.
 */
export function catalogPatternMatchesPage(pattern: string | null, pageKey: string, url?: string | null): boolean {
  if (!pattern) return true;
  if (/^https?:/.test(pageKey)) return urlMatches(pattern, pageKey);
  return (!!url && urlMatches(pattern, url)) || urlMatches(pattern, pageKeyUrl(pageKey));
}

/**
 * Per catalog method or helper, how many tests call it and how many reach a
 * page its URL pattern matches. A test calls it when one of its locator uses on
 * the default branch does what one of the method's steps does, on an element
 * that step names by test id or by name, on a page the pattern matches (or an
 * unknown page). A step whose target comes from a parameter names no element,
 * so a method without a fixed step gets no decision and is left out, and so are
 * fixtures, which no test calls. Uses are folded to their distinct target,
 * action and page first, so the work grows with what the suite does, not how
 * often.
 */
export function resolveCatalogMethodReach(
  entries: ReadonlyArray<CatalogEntryReachInput>,
  uses: ReadonlyArray<{ testCaseId: number; target: string; action: string; page: string }>,
  pages: ReadonlyArray<{ key: string; url?: string | null; tests: ReadonlySet<number> }>,
): CatalogMethodReach[] {
  const urlOf = new Map(pages.map((p) => [p.key, p.url ?? null]));
  type UseGroup = { action: string; page: string; candidate: MatchCandidate; tests: Set<number> };
  const groups = new Map<string, UseGroup>();
  const candidateOf = new Map<string, MatchCandidate | null>();
  for (const u of uses) {
    if (!candidateOf.has(u.target)) candidateOf.set(u.target, locatorMatchCandidate(u.target));
    const candidate = candidateOf.get(u.target);
    if (!candidate) continue;
    const id = `${u.target}\x00${u.action}\x00${u.page}`;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { action: u.action, page: u.page, candidate, tests: new Set() }));
    group.tests.add(u.testCaseId);
  }
  // A step naming a test id or a role can only match an element with that test id or role.
  const byTestId = new Map<string, UseGroup[]>();
  const byRole = new Map<string, UseGroup[]>();
  const index = (map: Map<string, UseGroup[]>, key: string | null, group: UseGroup) => {
    if (!key) return;
    const list = map.get(key.toLowerCase()) ?? [];
    list.push(group);
    map.set(key.toLowerCase(), list);
  };
  for (const group of groups.values()) {
    index(byTestId, group.candidate.testId, group);
    index(byRole, group.candidate.role, group);
  }
  const all = [...groups.values()];
  const groupsFor = (target: FunctionPatternStep['target']): UseGroup[] =>
    target.testId
      ? (byTestId.get(target.testId.toLowerCase()) ?? [])
      : target.role
        ? (byRole.get(target.role.toLowerCase()) ?? [])
        : all;

  const out: CatalogMethodReach[] = [];
  for (const entry of entries) {
    if (entry.kind === 'fixture') continue;
    const fixed = entry.steps.filter((step, i) => {
      if (step.action === 'goto') return false;
      const from = new Set(entry.paramSources.filter((s) => s.stepIndex === i).map((s) => s.from));
      return Boolean((step.target.testId && !from.has('testId')) || (step.target.name && !from.has('text')));
    });
    if (fixed.length === 0) continue;
    const onPage = new Map<string, boolean>();
    const matches = (page: string) => {
      let hit = onPage.get(page);
      if (hit === undefined)
        onPage.set(page, (hit = catalogPatternMatchesPage(entry.urlPattern, page, urlOf.get(page))));
      return hit;
    };
    const callers = new Set<number>();
    for (const step of fixed) {
      for (const group of groupsFor(step.target)) {
        if (!catalogActionMatches(step.action, group.action)) continue;
        if (group.page && !matches(group.page)) continue;
        if (scoreTargetMatch(step.target, group.candidate) < 0.6) continue;
        for (const id of group.tests) callers.add(id);
      }
    }
    const reachers = new Set<number>();
    for (const page of pages) if (matches(page.key)) for (const id of page.tests) reachers.add(id);
    out.push({
      module: entry.module,
      name: entry.name,
      label: entry.receiver ? `${entry.receiver}.${entry.name}` : entry.name,
      callCount: callers.size,
      pageReachedBy: reachers.size,
    });
  }
  return out;
}

// ── Change-time detectors (pure) ─────────────────────────────────────────────

/** A commit or ticket intent and whether any test matches its words. */
export interface IntentInput {
  /** The intent text (commit/PR title). */
  title: string;
  ticket?: string | null;
  /** True when a test title, tag or feature matched the intent's words. */
  matchedByTest: boolean;
  files?: string[];
}

/**
 * Intent without a test — a commit or PR whose words match no test title, tag or
 * feature. Blind spot, reported at change time.
 */
export function detectIntentWithoutTest(intents: IntentInput[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const i of intents) {
    if (i.matchedByTest) continue;
    gaps.push({
      detector: 'intent-without-test',
      kind: 'gap',
      class: 'blind-spot',
      key: `intent:${i.ticket ?? i.title}`,
      title: `No test mentions "${i.title}"`,
      evidence: [
        `${i.title} · no test title, tag or feature matches — a regression test drafted from the diff and message.`,
      ],
      confidence: 0.4,
      ticket: i.ticket ?? null,
      files: i.files,
    });
  }
  return gaps;
}

/** A hunk that adds a thrown error or status code to a route's handler. */
export interface NewErrorPathInput {
  routeKey: string;
  addedStatus: number;
  filePath: string;
}

/**
 * New error path — a hunk adds a thrown error or a status to a handler with a
 * route node, and that status was never observed. Blind spot.
 */
export function detectNewErrorPath(inputs: NewErrorPathInput[]): DetectedGap[] {
  return inputs.map((i) => ({
    detector: 'new-error-path',
    kind: 'gap' as const,
    class: 'blind-spot' as const,
    key: `route:${i.routeKey}:${i.addedStatus}`,
    title: `${i.routeKey} gains a ${i.addedStatus} nobody tests`,
    evidence: [`Adds ${i.addedStatus} to ${i.routeKey} · never observed — a scenario for that code.`],
    confidence: 0.55,
    files: [i.filePath],
  }));
}

/** A hunk that adds a control to a template whose page the suite reaches. */
export interface NewControlInput {
  pageKey: string;
  control: string;
  filePath: string;
  pageReached: boolean;
}

/** New control — a hunk adds a field/button/menu item to a reached page. Blind spot. */
export function detectNewControl(inputs: NewControlInput[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const i of inputs) {
    if (!i.pageReached) continue;
    gaps.push({
      detector: 'new-control',
      kind: 'gap',
      class: 'blind-spot',
      key: `control:${i.pageKey}:${i.control}`,
      title: `New control ${i.control} on ${i.pageKey}`,
      evidence: [`Adds ${i.control} on ${i.pageKey} · a scenario that exercises it.`],
      confidence: 0.5,
      files: [i.filePath],
    });
  }
  return gaps;
}

/** A prediction handed to locator healing — not a gap. */
export interface LocatorBreakPrediction {
  detector: 'locator-break-ahead';
  /** The removed anchor: `attribute=value` for an attribute, the string otherwise. */
  removedAttr: string;
  filePath: string;
  callSites: string[];
  evidence: string;
}

/**
 * Locator break ahead — a diff removes or renames a string the index's
 * locators find elements by. One prediction per anchor, with the call sites
 * of every chain it breaks, from `predictLocatorBreaks`. A prediction handed
 * to locator healing as a pre-flight, not a scenario gap.
 */
export function detectLocatorBreakAhead(
  anchors: DiffAnchor[],
  index: LocatorIndex,
  options: PredictLocatorBreaksOptions = {},
): LocatorBreakPrediction[] {
  const byAnchor = new Map<DiffAnchor, Set<string>>();
  for (const b of predictLocatorBreaks(anchors, index, options)) {
    const sites = byAnchor.get(b.anchor) ?? new Set<string>();
    for (const use of b.uses) for (const site of use.callSites) sites.add(site);
    byAnchor.set(b.anchor, sites);
  }
  return [...byAnchor].map(([anchor, sites]) => {
    const callSites = [...sites];
    const removed = anchor.attribute ? `${anchor.attribute}=${anchor.before}` : anchor.before;
    return {
      detector: 'locator-break-ahead' as const,
      removedAttr: removed,
      filePath: anchor.file,
      callSites,
      evidence: `${anchor.after === undefined ? 'Removes' : 'Renames'} ${removed} · ${callSites.length} call site${callSites.length === 1 ? '' : 's'} — heal before the run fails.`,
    };
  });
}

// ── Loaders + orchestration (impure) ─────────────────────────────────────────

const PRIORITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** The higher-priority tag among a set, or null when none is set. */
function maxPriority(
  ids: Iterable<number>,
  meta: Map<number, { title: string; priority: string | null }>,
): string | null {
  let best: string | null = null;
  for (const id of ids) {
    const p = meta.get(id)?.priority ?? null;
    if (p && (best == null || (PRIORITY_RANK[p] ?? 0) > (PRIORITY_RANK[best] ?? 0))) best = p;
  }
  return best;
}

/**
 * Ids of a project's most recent real runs, newest first. Lab runs (probes,
 * flake experiments) are excluded — their injected faults must never enter the detectors' history
 * window.
 */
async function loadRecentRunIds(db: DrizzleDB, projectId: number, limit: number): Promise<number[]> {
  const rows = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), notLabRun(testRuns.origin)))
    .orderBy(desc(testRuns.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Title + priority for a set of test cases. */
async function loadTestMeta(
  db: DrizzleDB,
  ids: number[],
): Promise<Map<number, { title: string; priority: string | null }>> {
  const meta = new Map<number, { title: string; priority: string | null }>();
  if (ids.length === 0) return meta;
  const rows = await db
    .select({ id: testCases.id, title: testCases.title, priority: testCases.priority })
    .from(testCases)
    .where(inArray(testCases.id, ids));
  for (const r of rows) meta.set(r.id, { title: r.title, priority: r.priority ?? null });
  return meta;
}

/** The most recent per-case execution status for each of the given test cases. */
async function latestExecutionStatus(db: DrizzleDB, ids: number[]): Promise<Map<number, string>> {
  const status = new Map<number, string>();
  if (ids.length === 0) return status;
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const maxRows = await db
      .select({ testCaseId: testRunsCases.testCaseId, maxId: sql<number>`max(${testRunsCases.id})` })
      .from(testRunsCases)
      .where(inArray(testRunsCases.testCaseId, slice))
      .groupBy(testRunsCases.testCaseId);
    const maxIds = maxRows.map((r) => Number(r.maxId)).filter((n) => Number.isFinite(n));
    if (maxIds.length === 0) continue;
    const rows = await db
      .select({ id: testRunsCases.id, testCaseId: testRunsCases.testCaseId, status: testRunsCases.status })
      .from(testRunsCases)
      .where(inArray(testRunsCases.id, maxIds));
    for (const r of rows) if (r.testCaseId != null) status.set(r.testCaseId, r.status.toLowerCase());
  }
  return status;
}

/**
 * Test cases whose reach is not trusted: a flaky test (a classified root cause),
 * a quarantined test (an active quarantine), or one whose most recent execution
 * was skipped or did-not-run. Such a test is a fragile single cover, never a
 * second trusted one, so single-covering-test discounts it.
 */
async function loadUntrustedTests(
  db: DrizzleDB,
  projectId: number,
  ids: number[],
): Promise<Map<number, UntrustedReason>> {
  // Later reasons win: a test that did not run says more than a quarantine, and a
  // quarantine more than a flaky classification.
  const untrusted = new Map<number, UntrustedReason>();
  if (ids.length === 0) return untrusted;
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const flaky = await db
      .select({ id: testCases.id })
      .from(testCases)
      .where(
        and(eq(testCases.projectId, projectId), inArray(testCases.id, slice), isNotNull(testCases.flakyRootCause)),
      );
    for (const r of flaky) untrusted.set(r.id, 'flaky');
    const quarantined = await db
      .select({ id: quarantinedTests.testCaseId })
      .from(quarantinedTests)
      .where(
        and(
          eq(quarantinedTests.projectId, projectId),
          inArray(quarantinedTests.testCaseId, slice),
          isNull(quarantinedTests.releasedAt),
        ),
      );
    for (const r of quarantined) untrusted.set(r.id, 'quarantined');
  }
  for (const [id, status] of await latestExecutionStatus(db, ids)) {
    if (status === 'skipped') untrusted.set(id, 'skipped');
    else if (status === 'didnotrun' || status === 'didnot-run') untrusted.set(id, 'did-not-run');
  }
  return untrusted;
}

/**
 * The run that first built the project's graph: the earliest first-seen run of
 * its observed, canonical surface, pruned nodes included, so a later sweep does
 * not move it. Features (written by the recompute), declared nodes (stamped on
 * ingest) and code-reach files are not observed surface.
 */
async function loadFirstGraphRunId(db: DrizzleDB, projectId: number): Promise<number | null> {
  const [row] = await db
    .select({ first: min(graphNodes.firstSeenRunId) })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.projectId, projectId),
        isNull(graphNodes.branch),
        ne(graphNodes.kind, 'feature'),
        notInArray(graphNodes.origin, ['manifest', 'openapi']),
        not(and(eq(graphNodes.kind, 'file'), eq(graphNodes.origin, 'coverage'))!),
      ),
    );
  return row?.first ?? null;
}

/**
 * Observed route statuses over the recent window, one row per pattern, kept only
 * for patterns the graph holds as route nodes. Route nodes are written on ingest
 * from the run's own origin alone, so this reuses that own-origin filter and a
 * third-party beacon's raw `network_requests` never becomes a success-only gap.
 */
async function loadRouteStats(
  db: DrizzleDB,
  runIds: number[],
  routeNodeKeys: Set<string>,
): Promise<Map<string, RouteStat>> {
  const stats = new Map<string, RouteStat>();
  if (runIds.length === 0 || routeNodeKeys.size === 0) return stats;
  const rows = await db
    .select({
      method: networkRequests.method,
      url: networkRequests.normalizedUrl,
      status: networkRequests.status,
      c: count(),
    })
    .from(networkRequests)
    .where(inArray(networkRequests.testRunId, runIds))
    .groupBy(networkRequests.method, networkRequests.normalizedUrl, networkRequests.status);

  for (const r of rows) {
    if (!r.url) continue;
    const key = routeNodeKey(r.method, r.url);
    if (!routeNodeKeys.has(key)) continue;
    const { method, pattern } = parseRouteNodeKey(key);
    const entry = stats.get(key) ?? { key, method, pattern, count: 0, statuses: [], priority: null };
    entry.count += Number(r.c);
    entry.statuses.push(r.status);
    stats.set(key, entry);
  }
  return stats;
}

/** Server log levels that report an error. */
const ERROR_LOG_LEVELS = new Set(['error', 'critical', 'fatal']);

/** The browser's own console line for a failed response, which only repeats its status. */
const RESOURCE_ERROR_TEXT = /^Failed to load resource\b/;

/** The errors one passing execution reported, as the detector's evidence names them. */
export interface PassedExecutionErrors {
  runId: number;
  /** 5xx responses from the project's routes, by route key. */
  serverErrors: Array<{ route: string; status: number }>;
  /** Routes whose response carried a backend log at error level. */
  backendErrors: string[];
  consoleErrors: number;
}

/** The evidence detail for a passing execution's errors, or null when it reported none. */
export function passedWithErrorsDetail(e: PassedExecutionErrors): string | null {
  const parts: string[] = [];
  const statuses = new Map<string, number>();
  for (const s of e.serverErrors) if (!statuses.has(s.route)) statuses.set(s.route, s.status);
  const shown = [...statuses].slice(0, 2).map(([route, status]) => `${route} returned ${status}`);
  if (statuses.size > 2) shown.push(`${statuses.size - 2} more 5xx`);
  parts.push(...shown);
  const backend = [...new Set(e.backendErrors)];
  if (backend.length > 0) {
    parts.push(
      `the backend logged an error on ${backend[0]}${backend.length > 1 ? ` and ${backend.length - 1} more` : ''}`,
    );
  }
  if (e.consoleErrors > 0) {
    parts.push(`the page logged ${e.consoleErrors} console error${e.consoleErrors === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? `run #${e.runId} · ${parts.join(' · ')}` : null;
}

/**
 * The tests whose newest final attempt on the default branch, in the window,
 * passed while the application reported an error: a 5xx from one of the
 * graph's routes, a backend log at error level on one of its responses, or a
 * console error from the page. A console line from another origin's script and
 * the browser's own failed-resource line are not the application's errors. A
 * response no server sent (the test's route handler fulfilled it) is no 5xx of
 * the application, and a test that fulfilled a failing one meant to see the page
 * fail, so its console errors are not counted either.
 */
async function loadPassedWithErrors(
  db: DrizzleDB,
  projectId: number,
  routeNodeKeys: Set<string>,
): Promise<Array<{ testCaseId: number; errors: PassedExecutionErrors }>> {
  const defaultBranch = await projectDefaultBranch(db, projectId);
  const [project] = await db
    .select({ routeOrigins: projects.routeOrigins })
    .from(projects)
    .where(eq(projects.id, projectId));
  // The default branch's newest runs, whatever other branches ran since; a run with no branch counts on it.
  const runs = await db
    .select({ id: testRuns.id, metadata: testRuns.metadata })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        notLabRun(testRuns.origin),
        not(runOriginIn(testRuns.origin, INVESTIGATION_RUN_ORIGINS)),
        or(eq(testRuns.branch, defaultBranch), isNull(testRuns.branch), eq(testRuns.branch, '')),
      ),
    )
    .orderBy(desc(testRuns.id))
    .limit(HISTORY_WINDOW_RUNS);
  if (runs.length === 0) return [];
  const runById = new Map(runs.map((r) => [r.id, r]));

  // The newest run each test ran in decides; only its final attempts are read.
  const attempts = await db
    .select({
      id: testRunsCases.id,
      testRunId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      retries: testRunsCases.retries,
      status: testRunsCases.status,
    })
    .from(testRunsCases)
    .where(inArray(testRunsCases.testRunId, [...runById.keys()]));
  const newestRun = new Map<number, number>();
  for (const a of attempts) {
    if (a.testCaseId == null) continue;
    newestRun.set(a.testCaseId, Math.max(newestRun.get(a.testCaseId) ?? 0, a.testRunId));
  }
  const finals = finalAttempts(
    attempts.filter(
      (a): a is typeof a & { testCaseId: number } =>
        a.testCaseId != null && newestRun.get(a.testCaseId) === a.testRunId,
    ),
  );
  // A test that fails on any browser is a failure, not a pass with errors; a skip is neither.
  const failedTests = new Set(
    finals.filter((a) => !['passed', 'skipped', 'didnotrun'].includes(a.status.toLowerCase())).map((a) => a.testCaseId),
  );
  const passing = finals.filter((a) => a.status.toLowerCase() === 'passed' && !failedTests.has(a.testCaseId));
  if (passing.length === 0) return [];

  const byExecution = new Map(
    passing.map((a) => [
      a.id,
      {
        testCaseId: a.testCaseId,
        errors: { runId: a.testRunId, serverErrors: [], backendErrors: [], consoleErrors: 0 } as PassedExecutionErrors,
      },
    ]),
  );
  const ids = [...byExecution.keys()];

  // The application's own origins, for a console error's source: the run's
  // `baseURL`s and the project's allowlist, else the execution's own page loads,
  // else the origins of its requests the graph holds as routes.
  const runOrigins = new Map<number, Set<string>>();
  const seenOrigins = new Map<number, Set<string>>();
  const ownOrigins = async (executionId: number, runId: number): Promise<Set<string>> => {
    let origins = runOrigins.get(runId);
    if (!origins) {
      origins = collectOwnOrigins(
        runBaseUrls(runById.get(runId)?.metadata),
        projectRouteOrigins(project?.routeOrigins),
      );
      runOrigins.set(runId, origins);
    }
    if (origins.size > 0) return origins;
    // A run's executions share its origins: the first one found serves the rest of the run.
    const found = seenOrigins.get(runId);
    if (found) return found;
    const requests = await db
      .select({
        method: networkRequests.method,
        url: networkRequests.url,
        normalizedUrl: networkRequests.normalizedUrl,
        resourceType: networkRequests.resourceType,
      })
      .from(networkRequests)
      .where(eq(networkRequests.testRunsCaseId, executionId));
    let fromRequests = originsFromDocumentRequests(requests);
    if (fromRequests.size === 0) {
      fromRequests = collectOwnOrigins(
        requests
          .filter((r) => r.normalizedUrl && routeNodeKeys.has(routeNodeKey(r.method, r.normalizedUrl)))
          .map((r) => r.url),
      );
    }
    if (fromRequests.size > 0) seenOrigins.set(runId, fromRequests);
    return fromRequests;
  };

  const mocksFailure = new Set<number>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const consoleRows = await db
      .select({ id: testRunsCases.id, consoleLogs: testRunsCases.consoleLogs })
      .from(testRunsCases)
      .where(and(inArray(testRunsCases.id, slice), isNotNull(testRunsCases.consoleLogs)));
    for (const row of consoleRows) {
      const entry = byExecution.get(row.id)!;
      const sources: string[] = [];
      for (const log of parseJsonArray(row.consoleLogs)) {
        const l = log as { type?: unknown; text?: unknown; location?: unknown } | null;
        if (l?.type !== 'error' || (typeof l.text === 'string' && RESOURCE_ERROR_TEXT.test(l.text))) continue;
        sources.push(typeof l.location === 'string' ? l.location.replace(/(:\d+){1,2}$/, '') : '');
      }
      if (sources.length === 0) continue;
      const origins = sources.some((src) => /^https?:/.test(src))
        ? await ownOrigins(row.id, entry.errors.runId)
        : new Set<string>();
      entry.errors.consoleErrors += sources.filter(
        (src) => !/^https?:/.test(src) || isOwnOriginRequest(src, origins),
      ).length;
    }
    const requestRows = await db
      .select({
        caseId: networkRequests.testRunsCaseId,
        method: networkRequests.method,
        url: networkRequests.normalizedUrl,
        status: networkRequests.status,
        serverLogs: networkRequests.serverLogs,
        fulfilled: networkRequests.fulfilled,
      })
      .from(networkRequests)
      .where(
        and(
          inArray(networkRequests.testRunsCaseId, slice),
          or(gte(networkRequests.status, 500), isNotNull(networkRequests.serverLogs)),
        ),
      );
    for (const r of requestRows) {
      if (r.fulfilled && r.status >= 500) mocksFailure.add(r.caseId);
      if (!r.url) continue;
      const route = routeNodeKey(r.method, r.url);
      if (!routeNodeKeys.has(route)) continue;
      const entry = byExecution.get(r.caseId)!;
      if (r.status >= 500 && !r.fulfilled) entry.errors.serverErrors.push({ route, status: r.status });
      const logged = parseJsonArray(r.serverLogs).some((log) =>
        ERROR_LOG_LEVELS.has(String((log as { level?: unknown } | null)?.level ?? '').toLowerCase()),
      );
      if (logged) entry.errors.backendErrors.push(route);
    }
  }
  // A test that fulfilled a failing response itself meant to see the page fail:
  // the console errors that follow are its own doing. Its backend logs stand.
  for (const id of mocksFailure) byExecution.get(id)!.errors.consoleErrors = 0;

  // One execution per test: a test that passed on several browsers reports its first with errors.
  const out = new Map<number, PassedExecutionErrors>();
  for (const { testCaseId, errors } of byExecution.values()) {
    if (out.has(testCaseId) || passedWithErrorsDetail(errors) === null) continue;
    out.set(testCaseId, errors);
  }
  return [...out].map(([testCaseId, errors]) => ({ testCaseId, errors }));
}

/** The project's catalog entries as the catalog detector reads them; a row whose steps do not parse is left out. */
async function loadCatalogEntries(db: DrizzleDB, projectId: number): Promise<CatalogEntryReachInput[]> {
  const rows = await db
    .select({
      module: testFunctions.module,
      name: testFunctions.name,
      kind: testFunctions.kind,
      receiver: testFunctions.receiver,
      urlPattern: testFunctions.urlPattern,
      steps: testFunctions.steps,
      paramSources: testFunctions.paramSources,
    })
    .from(testFunctions)
    .where(eq(testFunctions.projectId, projectId));
  return rows.flatMap((r) => {
    const steps = parseJsonArray(r.steps).filter(
      (s): s is FunctionPatternStep =>
        !!s &&
        typeof s === 'object' &&
        typeof (s as FunctionPatternStep).action === 'string' &&
        !!(s as FunctionPatternStep).target,
    );
    if (steps.length === 0) return [];
    return [{ ...r, steps, paramSources: parseJsonArray(r.paramSources) as FunctionParamSource[] }];
  });
}

/** A JSON array column, parsed when stored as text; anything else reads as empty. */
function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Recompute a project's project-wide gaps (success-only, single-covering-test,
 * surface-drift) from the graph and history, rank them by exposure, and upsert
 * the ledger — preserving triage and closing gaps that no longer hold. Change-
 * time detectors (changed-unreached) run in the change-coverage path instead.
 *
 * The `scenario_gaps` ledger is project-wide and has no branch dimension, so a
 * branch recompute must never write to it: a pull request's reach could
 * otherwise close a canonical gap permanently, and a PR-only node could become a
 * project-wide gap. A branch recompute is therefore a ledger no-op — the
 * canonical ledger reflects the default branch alone, and the pull-request
 * surfaces (the "Uncovered changes" section) read branch reach without
 * persisting it into this ledger.
 */
export async function computeScenarioGaps(
  db: DrizzleDB,
  projectId: number,
  options: { exposure?: ExposureInputs; branch?: string | null; closeTriaged?: boolean } = {},
): Promise<{ upserted: number; closed: number }> {
  if (options.branch) return { upserted: 0, closed: 0 };
  const recentIds = await loadRecentRunIds(db, projectId, HISTORY_WINDOW_RUNS);
  const latestRunId = recentIds[0] ?? null;
  // A background recompute (the nightly sweep) never closes a gap the team
  // deliberately snoozed or accepted: only a run that actually re-covers the
  // subject should retire that verdict, so the sweep closes open gaps only.
  const closeStatuses: GapStatus[] = options.closeTriaged === false ? ['open'] : ['open', 'snoozed', 'accepted'];

  // Wake timed snoozes whose wake time has passed before detecting, so a lapsed
  // snooze re-enters detection this run rather than hiding the gap forever.
  await reopenExpiredSnoozes(db, projectId);

  // Canonical rows only (branch null): the branch guard above already returned,
  // so a project-wide recompute reads the default-branch graph and never a pull
  // request's branch-tagged nodes or edges.
  const nodeBranchScope = isNull(graphNodes.branch);
  const edgeBranchScope = isNull(graphEdges.branch);

  // The controls and links the tests' locators target, from the locator index,
  // and the pages where a test operated an element the index could not name.
  const indexedUses = await loadIndexedLocatorUses(db, projectId);
  const unresolvedByPage = await syncControlReach(db, projectId, indexedUses);

  // Reach edges → which test cases reach which nodes. Code reach's `coverage`
  // edges and `file` nodes (every file a test executed) stay out of the node
  // detectors: they are no surface of their own to drift or to be covered once.
  const reachRows = await db
    .select({
      toKind: graphEdges.toKind,
      toKey: graphEdges.toKey,
      fromKey: graphEdges.fromKey,
      origin: graphEdges.origin,
    })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, 'reaches'),
        ne(graphEdges.origin, 'coverage'),
        edgeBranchScope,
      ),
    );

  const reachByNode = new Map<string, Set<number>>();
  // Node → tests whose only reach edge is a manual one (a covered-by), not observed.
  const manualReachByNode = new Map<string, Set<number>>();
  const testIds = new Set<number>();
  for (const r of reachRows) {
    const id = Number(r.fromKey);
    if (!Number.isFinite(id)) continue;
    testIds.add(id);
    const nodeKey = `${r.toKind}\x00${r.toKey}`;
    const set = reachByNode.get(nodeKey) ?? new Set<number>();
    set.add(id);
    reachByNode.set(nodeKey, set);
    if (r.origin === 'manual') {
      const manual = manualReachByNode.get(nodeKey) ?? new Set<number>();
      manual.add(id);
      manualReachByNode.set(nodeKey, manual);
    }
  }

  const meta = await loadTestMeta(db, [...testIds]);
  const untrustedTests = await loadUntrustedTests(db, projectId, [...testIds]);

  // Node first-seen for surface drift. Pruned (soft-deleted) nodes are excluded
  // so vanished surface neither reaches detectors nor re-flags as drift.
  const nodeRows = await db
    .select({
      kind: graphNodes.kind,
      key: graphNodes.key,
      origin: graphNodes.origin,
      attrs: graphNodes.attrs,
      firstSeenRunId: graphNodes.firstSeenRunId,
      lastSeenRunId: graphNodes.lastSeenRunId,
    })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.projectId, projectId),
        nodeBranchScope,
        isNull(graphNodes.prunedAt),
        not(and(eq(graphNodes.kind, 'file'), eq(graphNodes.origin, 'coverage'))!),
      ),
    );

  // Documented response codes a declared (manifest/OpenAPI) route carries in its attrs.
  const documentedByRoute = new Map<string, number[]>();
  for (const node of nodeRows) {
    if (node.kind !== 'route') continue;
    const responses = (node.attrs as { responses?: unknown } | null)?.responses;
    if (Array.isArray(responses)) {
      const codes = responses.filter((c): c is number => Number.isInteger(c));
      if (codes.length > 0) documentedByRoute.set(node.key, codes);
    }
  }

  // The declared routes and pages, and the declared node serving each observed
  // key: a declared `/blog/{slug}` serves the `/blog/hello-world` a test called,
  // which its key alone cannot line up with. A node a test reached before the
  // manifest declared it keeps origin `observed` but carries the declared attrs,
  // so it still competes as the closest pattern.
  const declaredSurface = nodeRows.filter(
    (n): n is typeof n & { kind: 'route' | 'page'; origin: 'manifest' | 'openapi' } =>
      (n.kind === 'route' || n.kind === 'page') && (n.origin === 'manifest' || n.origin === 'openapi'),
  );
  const declaredFor = createDeclaredMatcher(
    nodeRows.filter(
      (n) =>
        (n.kind === 'route' || n.kind === 'page') &&
        (n.origin === 'manifest' ||
          n.origin === 'openapi' ||
          (n.attrs as { declared?: unknown } | null)?.declared === true),
    ),
  );

  // Route patterns the graph holds as nodes — the own-origin set success-only reads.
  const routeNodeKeys = new Set(nodeRows.filter((n) => n.kind === 'route').map((n) => n.key));
  const routeStats = await loadRouteStats(db, recentIds, routeNodeKeys);

  // The routes whose documented codes apply to a route: its own, and the declared
  // route serving it.
  const documentingRoutes = (key: string) => {
    const serving = declaredFor('route', key);
    return documentedByRoute.has(key) && !serving.includes(key) ? [key, ...serving] : serving;
  };

  // The statuses observed across every route a declared route serves, so a code
  // `/users/nobody` returned is not named untested on `/users/alice`.
  const statusesByDeclared = new Map<string, Set<number>>();
  for (const [key, stat] of routeStats) {
    for (const declared of documentingRoutes(key)) {
      const set = statusesByDeclared.get(declared) ?? new Set<number>();
      for (const status of stat.statuses) set.add(status);
      statusesByDeclared.set(declared, set);
    }
  }

  // Attach the priority observed around each route pattern and the codes the
  // declared route serving it documents but none of its requests returned.
  for (const [key, stat] of routeStats) {
    stat.priority = maxPriority(reachByNode.get(`route\x00${key}`) ?? [], meta);
    const serving = documentingRoutes(key);
    const returned = new Set(serving.flatMap((d) => [...(statusesByDeclared.get(d) ?? [])]));
    const documented = [...new Set(serving.flatMap((d) => documentedByRoute.get(d) ?? []))].filter(
      (code) => !returned.has(code),
    );
    if (documented.length > 0) stat.documentedCodes = documented;
  }

  // A declared node's reach: its own, plus that of every observed node it serves.
  // Kept apart from `reachByNode`, so the other detectors never count one surface
  // twice, once as observed and once as declared.
  const declaredReach = new Map<string, Set<number>>();
  for (const [nodeKey, ids] of reachByNode) {
    const sep = nodeKey.indexOf('\x00');
    const kind = nodeKey.slice(0, sep);
    if (kind !== 'route' && kind !== 'page') continue;
    for (const key of declaredFor(kind, nodeKey.slice(sep + 1))) {
      const id = `${kind}\x00${key}`;
      const set = declaredReach.get(id) ?? new Set<number>();
      for (const testId of ids) set.add(testId);
      declaredReach.set(id, set);
    }
  }

  // Declared nodes (manifest/OpenAPI) with no test reaching them — the declared-
  // never-hit blind spots. Origin sticks to a node's first write, so a declared
  // route the suite later exercises keeps its origin but gains a reaches edge and
  // is skipped here by reachCount.
  const declaredNodes: DeclaredNode[] = [];
  for (const node of declaredSurface) {
    const nodeKey = `${node.kind}\x00${node.key}`;
    const ids = new Set([...(reachByNode.get(nodeKey) ?? []), ...(declaredReach.get(nodeKey) ?? [])]);
    declaredNodes.push({
      nodeKind: node.kind,
      nodeKey: node.key,
      origin: node.origin,
      reachCount: ids.size,
      documentedCodes: documentedByRoute.get(node.key),
      priority: maxPriority(ids, meta),
    });
  }

  // Wake "until the node changes" snoozes whose subject node's edge shape has
  // changed since they were snoozed.
  await reopenChangedNodeSnoozes(db, projectId);

  const nodeReach: NodeReach[] = [];
  const nodeDrift: NodeDrift[] = [];
  for (const node of nodeRows) {
    const ids = reachByNode.get(`${node.kind}\x00${node.key}`) ?? new Set<number>();
    nodeReach.push({
      nodeKind: node.kind,
      nodeKey: node.key,
      tests: [...ids].map((id) => ({
        testCaseId: id,
        title: meta.get(id)?.title ?? `test ${id}`,
        priority: meta.get(id)?.priority ?? null,
        trusted: !untrustedTests.has(id),
        untrustedReason: untrustedTests.get(id),
      })),
    });
    // Declared nodes (manifest/OpenAPI) carry their own "declared, never hit"
    // detector and are stamped with the latest run on ingest, so they must never
    // feed surface drift — a newly documented route is not drift.
    if (node.origin !== 'manifest' && node.origin !== 'openapi') {
      nodeDrift.push({
        nodeKind: node.kind,
        nodeKey: node.key,
        firstSeenRunId: node.firstSeenRunId ?? null,
        reachCount: ids.size,
        priority: maxPriority(ids, meta),
      });
    }
  }

  // Breadth edges the graph detectors read: contains (page → control), links
  // (page → page), checks (probe outcomes), handled-by and calls.
  const breadthEdges = await db
    .select({
      kind: graphEdges.kind,
      fromKind: graphEdges.fromKind,
      fromKey: graphEdges.fromKey,
      toKind: graphEdges.toKind,
      toKey: graphEdges.toKey,
      evidence: graphEdges.evidence,
    })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        inArray(graphEdges.kind, ['contains', 'links', 'checks', 'calls', 'handled-by']),
        edgeBranchScope,
      ),
    );

  const pagesByControl = new Map<string, Set<string>>(); // control key → containing pages
  const linkSourcesByPage = new Map<string, Set<string>>(); // target page → source pages
  // Every checks edge per route, kept per probing test so opposite outcomes on
  // one route are reduced deterministically rather than overwriting each other.
  const checksByRoute = new Map<string, Array<{ testKey: string; outcome: string; fault: string | null }>>();
  const routesByHandler = new Map<string, Set<string>>(); // handler key → routes handled by it
  const dependenciesByHandler = new Map<string, Set<string>>(); // handler key → dependencies it calls
  const probedDependencies = new Set<string>(); // dependency keys with any checks edge
  for (const e of breadthEdges) {
    if (e.kind === 'contains' && e.toKind === 'control') {
      const set = pagesByControl.get(e.toKey) ?? new Set<string>();
      set.add(e.fromKey);
      pagesByControl.set(e.toKey, set);
    } else if (e.kind === 'links' && e.toKind === 'page') {
      const set = linkSourcesByPage.get(e.toKey) ?? new Set<string>();
      set.add(e.fromKey);
      linkSourcesByPage.set(e.toKey, set);
    } else if (e.kind === 'handled-by' && e.fromKind === 'route' && e.toKind === 'handler') {
      const set = routesByHandler.get(e.toKey) ?? new Set<string>();
      set.add(e.fromKey);
      routesByHandler.set(e.toKey, set);
    } else if (e.kind === 'calls' && e.fromKind === 'handler' && e.toKind === 'dependency') {
      const set = dependenciesByHandler.get(e.fromKey) ?? new Set<string>();
      set.add(e.toKey);
      dependenciesByHandler.set(e.fromKey, set);
    } else if (e.kind === 'checks' && e.toKind === 'dependency') {
      probedDependencies.add(e.toKey);
    } else if (e.kind === 'checks' && e.toKind === 'route') {
      const ev = (e.evidence ?? {}) as { outcome?: string; fault?: string };
      if (ev.outcome) {
        const list = checksByRoute.get(e.toKey) ?? [];
        list.push({ testKey: e.fromKey, outcome: ev.outcome, fault: ev.fault ?? null });
        checksByRoute.set(e.toKey, list);
      }
    }
  }

  // Dependency probe status: each dependency, the routes whose handlers call it,
  // and whether any probe has checked it — the unprobed-dependency detector.
  const routesByDependency = new Map<string, Set<string>>();
  for (const [handler, deps] of dependenciesByHandler) {
    const routes = routesByHandler.get(handler) ?? new Set<string>();
    for (const dep of deps) {
      const set = routesByDependency.get(dep) ?? new Set<string>();
      for (const r of routes) set.add(r);
      routesByDependency.set(dep, set);
    }
  }
  const dependencyProbeStatus: DependencyProbeStatus[] = [...routesByDependency].map(([dependencyKey, routes]) => ({
    dependencyKey,
    calledByRoutes: [...routes],
    probed: probedDependencies.has(dependencyKey),
  }));

  // Node recency for orphan tests: a node last seen inside the recent window.
  const recentSet = new Set(recentIds);
  const nodeSeenRecently = new Map<string, boolean>();
  for (const node of nodeRows) {
    nodeSeenRecently.set(`${node.kind}\x00${node.key}`, recentSet.has(node.lastSeenRunId ?? -1));
  }

  // Tests that operated an unnamed element on a page holding the control: any
  // of them may have exercised it.
  const unresolvedTestsByControl = new Map<string, Set<number>>();
  for (const [control, pages] of pagesByControl) {
    const tests = new Set<number>();
    for (const page of pages) for (const id of unresolvedByPage.get(page) ?? []) tests.add(id);
    if (tests.size > 0) unresolvedTestsByControl.set(control, tests);
  }

  const controlReach: ControlReach[] = [];
  const pageLinkReach: PageLinkReach[] = [];
  for (const node of nodeRows) {
    const nodeKey = `${node.kind}\x00${node.key}`;
    const reachCount = reachByNode.get(nodeKey)?.size ?? 0;
    if (node.kind === 'control') {
      controlReach.push({
        key: node.key,
        pageCount: pagesByControl.get(node.key)?.size ?? 0,
        reachCount,
        manualReachCount: manualReachByNode.get(nodeKey)?.size ?? 0,
        unresolvedTests: unresolvedTestsByControl.get(node.key)?.size ?? 0,
      });
    } else if (node.kind === 'page') {
      pageLinkReach.push({
        key: node.key,
        reached: reachCount > 0,
        linkedFrom: linkSourcesByPage.get(node.key)?.size ?? 0,
      });
    }
  }

  const checkOutcomes: CheckOutcome[] = [...checksByRoute].map(([routeKey, edges]) => ({
    routeKey,
    // A flaky, quarantined or skipped test's notice is no evidence the route is checked.
    noticed: edges.some((e) => e.outcome === 'noticed' && !untrustedTests.has(Number(e.testKey))),
    notNoticed: edges
      .filter((e) => e.outcome === 'not-noticed')
      .map((e) => {
        const id = Number(e.testKey);
        return {
          testCaseId: Number.isFinite(id) ? id : -1,
          title: meta.get(id)?.title ?? `test ${e.testKey}`,
          fault: e.fault,
        };
      }),
    exposure: reachByNode.get(`route\x00${routeKey}`)?.size ?? 0,
  }));

  // Orphan tests: for each test, the recency of every node it reaches.
  const reachedByTest = new Map<number, Array<{ seenRecently: boolean }>>();
  for (const [nodeKey, ids] of reachByNode) {
    const seenRecently = nodeSeenRecently.get(nodeKey) ?? false;
    for (const id of ids) {
      const list = reachedByTest.get(id) ?? [];
      list.push({ seenRecently });
      reachedByTest.set(id, list);
    }
  }
  const testReachRecency: TestReachRecency[] = [...reachedByTest].map(([testCaseId, reachedNodes]) => ({
    testCaseId,
    title: meta.get(testCaseId)?.title ?? `test ${testCaseId}`,
    reachedNodes,
    priority: meta.get(testCaseId)?.priority ?? null,
  }));

  // Fix did not hold: clusters whose fix later regressed.
  const regressedRows = await db
    .select({
      id: failureClusters.id,
      title: failureClusters.title,
      fixCommit: failureClusters.fixCommit,
      fixLandedAt: failureClusters.fixLandedAt,
    })
    .from(failureClusters)
    .where(and(eq(failureClusters.projectId, projectId), eq(failureClusters.fixVerification, 'regressed')));
  const regressedClusters: RegressedCluster[] = regressedRows.map((c) => {
    const landed = c.fixLandedAt instanceof Date ? c.fixLandedAt.getTime() : Number(c.fixLandedAt) || 0;
    return {
      clusterId: c.id,
      title: c.title ?? 'a failure',
      fixCommit: c.fixCommit ?? null,
      daysSinceFix: landed > 0 ? Math.max(0, Math.round((Date.now() - landed) / 86_400_000)) : null,
    };
  });

  // Escaped defects: the project's bug reports that no test names yet.
  const openReports: ReportedBugInput[] = (
    await db
      .select({ id: bugReports.id, title: bugReports.title, pageKey: bugReports.pageKey })
      .from(bugReports)
      .where(and(eq(bugReports.projectId, projectId), eq(bugReports.status, 'open')))
  ).map((r) => ({ id: r.id, title: r.title, pageKey: r.pageKey }));

  // Passing tests the application reported an error under, on the default branch.
  const passedWithErrors = await loadPassedWithErrors(db, projectId, routeNodeKeys);
  const passedMeta = await loadTestMeta(
    db,
    passedWithErrors.map((p) => p.testCaseId).filter((id) => !meta.has(id)),
  );
  const passedExecutions: PassedWithError[] = passedWithErrors.map((p) => ({
    testCaseId: p.testCaseId,
    title: (meta.get(p.testCaseId) ?? passedMeta.get(p.testCaseId))?.title ?? `test ${p.testCaseId}`,
    detail: passedWithErrorsDetail(p.errors)!,
  }));

  // Assertions and catalog calls, from the default branch's locator index.
  const graphPages = nodeRows.filter((n) => n.kind === 'page');
  const assertionPages = assertionLightPages(indexedUses, new Set(graphPages.map((n) => n.key)));
  const catalogReach = resolveCatalogMethodReach(
    await loadCatalogEntries(db, projectId),
    indexedUses,
    graphPages.map((n) => {
      const url = (n.attrs as { url?: unknown } | null)?.url;
      return {
        key: n.key,
        url: typeof url === 'string' && url ? url : null,
        tests: reachByNode.get(`page\x00${n.key}`) ?? new Set<number>(),
      };
    }),
  );

  const detected = [
    ...detectReportedBugEscapes(openReports),
    ...detectSuccessOnly([...routeStats.values()]),
    ...detectSingleCoveringTest(
      // A control another test may have operated through an unnamed locator is not known to be single-covered.
      nodeReach.filter(
        (n) =>
          n.nodeKind !== 'control' ||
          [...(unresolvedTestsByControl.get(n.nodeKey) ?? [])].every((id) => n.tests.some((t) => t.testCaseId === id)),
      ),
    ),
    ...detectSurfaceDrift(nodeDrift, latestRunId, await loadFirstGraphRunId(db, projectId)),
    ...detectControlNobodyExercises(controlReach),
    ...detectReachableUnvisited(pageLinkReach),
    ...detectNotNoticed(checkOutcomes),
    ...detectOrphanTest(testReachRecency),
    ...detectFixDidNotHold(regressedClusters),
    ...detectDeclaredNeverHit(declaredNodes),
    ...detectUnprobedDependency(dependencyProbeStatus),
    ...detectPassedWithErrors(passedExecutions),
    ...detectAssertionLight(assertionPages),
    ...detectCatalogMethodNoTestCalls(catalogReach),
  ];

  // A gap on a route, a handler or a dependency is exposed through the handler
  // files behind it, ranked by the commits the default branch recorded on them.
  const handlerFilesOf = (subject: GapSubject): string[] => {
    if (subject.kind === 'handler') return [subject.key];
    if (subject.kind === 'route') {
      return [...routesByHandler].filter(([, routes]) => routes.has(subject.key)).map(([handler]) => handler);
    }
    if (subject.kind === 'dependency') {
      return [...dependenciesByHandler].filter(([, deps]) => deps.has(subject.key)).map(([handler]) => handler);
    }
    return [];
  };
  for (const gap of detected) {
    if (gap.files?.length) continue;
    const files = handlerFilesOf(subjectFromGapKey(gap.key));
    if (files.length > 0) gap.files = files;
  }
  const handlerFiles = [...new Set(detected.flatMap((g) => g.files ?? []))];
  const exposure: ExposureInputs = {
    files: new Map([
      ...(await loadRecordedFileExposure(db, projectId, handlerFiles)),
      ...(options.exposure?.files ?? []),
    ]),
  };
  const scored = detected.map((gap) => rankGap(gap, exposure));

  const invert = (byTarget: Map<string, Set<string>>) => {
    const out = new Map<string, Set<string>>();
    for (const [target, sources] of byTarget) {
      for (const source of sources) {
        let set = out.get(source);
        if (!set) out.set(source, (set = new Set()));
        set.add(target);
      }
    }
    return out;
  };
  const controlsByPage = invert(pagesByControl);
  const linksByPage = invert(linkSourcesByPage);
  await syncFeatureNodes(
    db,
    projectId,
    {
      reachByNode,
      controlsByPage,
      linksByPage,
      declaredRoutes: nodeRows
        .filter((n) => n.kind === 'route' && (n.origin === 'manifest' || n.origin === 'openapi'))
        .map((n) => n.key),
    },
    latestRunId,
  );

  const upserted = await upsertScenarioGaps(db, projectId, scored, { runId: latestRunId });
  const closed = await closeMissingGaps(
    db,
    projectId,
    [
      'success-only',
      'single-covering-test',
      'surface-drift',
      'control-nobody-exercises',
      'reachable-unvisited',
      'not-noticed',
      'orphan-test',
      'fix-did-not-hold',
      'declared-never-hit',
      'unprobed-dependency',
      'escaped-defect',
      'passed-with-errors',
      'assertion-light',
      'catalog-method-no-test-calls',
    ],
    scored,
    latestRunId,
    closeStatuses,
  );
  const closedChanged = await closeReachedChangedUnreached(db, projectId, latestRunId, reachByNode, closeStatuses);
  const closedRetired = await closeRetiredDetectorGaps(db, projectId);
  return { upserted, closed: closed + closedChanged + closedRetired };
}

/**
 * Close the open, snoozed and accepted rows of retired detectors. No run closed
 * them, so `closed_by_run_id` stays empty; a dismissed row keeps its verdict.
 */
async function closeRetiredDetectorGaps(db: DrizzleDB, projectId: number): Promise<number> {
  const now = new Date();
  const closed = await db
    .update(scenarioGaps)
    .set({ status: 'closed', closedAt: now, closedByRunId: null, updatedAt: now })
    .where(
      and(
        eq(scenarioGaps.projectId, projectId),
        inArray(scenarioGaps.detector, RETIRED_DETECTORS),
        inArray(scenarioGaps.status, ['open', 'snoozed', 'accepted']),
      ),
    )
    .returning({ id: scenarioGaps.id });
  return closed.length;
}

// ── Exposure from recorded changes ───────────────────────────────────────────

/** True when two repo paths name one file: equal, or one a path suffix of the other (a monorepo prefix). */
function samePathOrSuffix(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** True when two commit ids name one commit, a short id matching its full one. */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * Churn and escape history of `files` from what the graph recorded: the
 * default branch's `changes` edges (kept for ninety days), each a run's diff
 * from its baseline to its head commit. Churn counts the distinct diffs that
 * touched a file, a diff being its base, so the runs of a red streak, each
 * diffed again from the same green run, count once. A file is escaped when a
 * diff that touched it ends on a failure cluster's fixing commit: the diff that
 * landed the fix, which holds every change since the last green run. A file
 * matches its recorded path exactly or, failing that, the one recorded path it
 * is a suffix of; a key two recorded paths end with names neither. Age needs
 * the file's history from the source control provider, so it is left out.
 */
async function loadRecordedFileExposure(
  db: DrizzleDB,
  projectId: number,
  files: string[],
): Promise<Map<string, FileExposure>> {
  const out = new Map<string, FileExposure>();
  if (files.length === 0) return out;
  const changes = await db
    .select({ commit: graphEdges.fromKey, file: graphEdges.toKey, evidence: graphEdges.evidence })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, 'changes'),
        eq(graphEdges.fromKind, 'commit'),
        eq(graphEdges.toKind, 'file'),
        isNull(graphEdges.branch),
      ),
    );
  if (changes.length === 0) return out;
  const byPath = new Map<string, { diffs: Set<string>; heads: Set<string> }>();
  for (const c of changes) {
    const base = (c.evidence as { base?: unknown } | null)?.base;
    const entry = byPath.get(c.file) ?? { diffs: new Set<string>(), heads: new Set<string>() };
    entry.diffs.add(typeof base === 'string' && base ? `base:${base}` : `head:${c.commit}`);
    entry.heads.add(c.commit);
    byPath.set(c.file, entry);
  }
  const fixCommits = (
    await db
      .select({ fixCommit: failureClusters.fixCommit })
      .from(failureClusters)
      .where(and(eq(failureClusters.projectId, projectId), isNotNull(failureClusters.fixCommit)))
  )
    .map((c) => c.fixCommit!)
    .filter(Boolean);

  const paths = [...byPath.keys()];
  for (const file of files) {
    const matches = byPath.has(file) ? [file] : paths.filter((path) => samePathOrSuffix(path, file));
    if (matches.length !== 1) continue;
    const entry = byPath.get(matches[0]!)!;
    out.set(file, {
      churn: entry.diffs.size,
      escaped: [...entry.heads].some((commit) => fixCommits.some((fix) => sameCommit(commit, fix))),
    });
  }
  return out;
}

// ── Control reach from the locator index ─────────────────────────────────────

/** Roles a label, a placeholder or a title names. */
const LABELED_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'spinbutton',
  'slider',
]);

/** The graph node a locator names: a control or link by role and name, or only a name. */
export type LocatorNodeTarget =
  | { by: 'role'; kind: 'control' | 'link'; key: string; role: string; name: string; exact: boolean }
  | { by: 'name'; name: string; exact: boolean };

function stringArg(arg: LocatorArg | undefined): string | null {
  return arg?.type === 'string' && arg.value.trim() ? arg.value : null;
}

function exactOption(arg: LocatorArg | undefined): boolean {
  if (arg?.type !== 'object') return false;
  const exact = arg.entries.find(([k]) => k === 'exact')?.[1];
  return exact?.type === 'boolean' && exact.value;
}

/**
 * The node the last locating call of a chain names. `getByRole` with a string
 * name keys a control (`role:name`) or, for a link, a link node; a label,
 * placeholder or title names a control without its role. `exact` is the call's
 * own option. A regex name, a test id or a CSS selector names nothing here.
 */
export function locatorNodeTarget(locator: string): LocatorNodeTarget | null {
  const calls = tryParseLocatorChain(locator)?.calls.filter((c) => LOCATING_METHODS.has(c.method)) ?? [];
  const call = calls[calls.length - 1];
  if (!call) return null;
  if (call.method === 'getByRole') {
    const role = stringArg(call.args[0]);
    const options = call.args[1]?.type === 'object' ? call.args[1].entries : [];
    const name = stringArg(options.find(([k]) => k === 'name')?.[1]);
    if (!role || !name) return null;
    const exact = exactOption(call.args[1]);
    return role === 'link'
      ? { by: 'role', kind: 'link', key: linkNodeKey(name), role, name, exact }
      : { by: 'role', kind: 'control', key: controlNodeKey(role, name), role: role.toLowerCase(), name, exact };
  }
  if (call.method === 'getByLabel' || call.method === 'getByPlaceholder' || call.method === 'getByTitle') {
    const name = stringArg(call.args[0]);
    return name ? { by: 'name', name, exact: exactOption(call.args[1]) } : null;
  }
  return null;
}

/** One locator use of a test, with the ranked alternatives its call site's snapshot recorded. */
export interface LocatorReachUse {
  testCaseId: number;
  /** The last locating call of the chain (`getByLabel('Email')`). */
  target: string;
  /** `click`, `fill`, `expect.toBeVisible`, … */
  action: string;
  /** The page key the call ran on, '' when unknown. */
  page?: string;
  /** Alternative locators for the same element, best first. */
  alternatives?: string[];
  /** When the index last saw the use, and in which run. */
  lastSeenAt?: Date;
  lastSeenRunId?: number | null;
}

/** A test's reach to a control or link, and whether it acted on the element or only read or asserted on it. */
export interface LocatorControlReach {
  testCaseId: number;
  kind: 'control' | 'link';
  key: string;
  action: 'operated' | 'checked';
  /** 1 for a role and name in the test's own chain, lower when inferred. */
  confidence: number;
  /** The newest use behind it, when the uses say. */
  lastSeenAt?: Date;
  lastSeenRunId?: number | null;
}

/** The reach a set of locator uses resolves to, and the interactions that name no known node. */
export interface ResolvedControlReach {
  reach: LocatorControlReach[];
  /** Uses that operated an element the graph has no node for, or that several nodes could be. */
  unresolved: LocatorReachUse[];
}

/** The one key whose templated name holds `name`, case-insensitively, as Playwright matches a name by default. */
function uniqueNameMatch(keys: string[], name: string): string | null {
  const needle = templateAccessibleName(name).toLowerCase();
  const hits = keys.filter((key) =>
    key
      .slice(key.indexOf(':') + 1)
      .toLowerCase()
      .includes(needle),
  );
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Resolve locator uses to the control and link nodes of the graph. A use maps
 * through, in order: its own `getByRole` and name (confidence 1); the first
 * role-and-name alternative its snapshot recorded (0.9); the one node of its
 * role whose name holds the locator's name, as Playwright matches a name without
 * `exact` (0.8); a label, placeholder or title that exactly one labeled control
 * carries (0.8), or holds (0.7). A use that maps to no known node reaches
 * nothing, so no edge points at a node the inventory never saw; an interaction
 * among those is listed as unresolved.
 */
export function resolveControlReach(
  uses: LocatorReachUse[],
  nodes: { controls: ReadonlySet<string>; links: ReadonlySet<string> },
): ResolvedControlReach {
  const known = (kind: 'control' | 'link', key: string) => (kind === 'control' ? nodes.controls : nodes.links).has(key);
  const byRole = new Map<string, string[]>(); // role (or `link`) → node keys
  for (const key of nodes.controls) {
    const role = key.slice(0, key.indexOf(':'));
    byRole.set(role, [...(byRole.get(role) ?? []), key]);
  }
  byRole.set('link', [...nodes.links]);
  const labeled = [...nodes.controls].filter((key) => LABELED_ROLES.has(key.slice(0, key.indexOf(':'))));
  const byName = new Map<string, string[]>();
  for (const key of labeled) {
    const name = key.slice(key.indexOf(':') + 1);
    byName.set(name, [...(byName.get(name) ?? []), key]);
  }

  const out = new Map<string, LocatorControlReach>();
  const unresolved: LocatorReachUse[] = [];
  for (const use of uses) {
    let hit: { kind: 'control' | 'link'; key: string; confidence: number } | null = null;
    const own = locatorNodeTarget(use.target);
    if (own?.by === 'role' && known(own.kind, own.key)) hit = { kind: own.kind, key: own.key, confidence: 1 };
    for (const alt of hit ? [] : (use.alternatives ?? [])) {
      const target = locatorNodeTarget(alt);
      if (target?.by === 'role' && known(target.kind, target.key)) {
        hit = { kind: target.kind, key: target.key, confidence: 0.9 };
        break;
      }
    }
    if (!hit && own?.by === 'role' && !own.exact) {
      const key = uniqueNameMatch(byRole.get(own.kind === 'link' ? 'link' : own.role) ?? [], own.name);
      if (key) hit = { kind: own.kind, key, confidence: 0.8 };
    }
    if (!hit && own?.by === 'name') {
      const exact = byName.get(templateAccessibleName(own.name)) ?? [];
      if (exact.length === 1) hit = { kind: 'control', key: exact[0]!, confidence: 0.8 };
      else if (exact.length === 0 && !own.exact) {
        const key = uniqueNameMatch(labeled, own.name);
        if (key) hit = { kind: 'control', key, confidence: 0.7 };
      }
    }
    const action = isInteractionAction(use.action) ? 'operated' : 'checked';
    if (!hit) {
      if (action === 'operated') unresolved.push(use);
      continue;
    }

    const id = `${use.testCaseId}\x00${hit.kind}\x00${hit.key}`;
    const prev = out.get(id);
    const newer = use.lastSeenAt && (!prev?.lastSeenAt || use.lastSeenAt > prev.lastSeenAt);
    out.set(id, {
      testCaseId: use.testCaseId,
      kind: hit.kind,
      key: hit.key,
      action: prev?.action === 'operated' || action === 'operated' ? 'operated' : 'checked',
      confidence: Math.max(prev?.confidence ?? 0, hit.confidence),
      ...(newer
        ? { lastSeenAt: use.lastSeenAt, lastSeenRunId: use.lastSeenRunId ?? null }
        : prev?.lastSeenAt
          ? { lastSeenAt: prev.lastSeenAt, lastSeenRunId: prev.lastSeenRunId ?? null }
          : {}),
    });
  }
  return { reach: [...out.values()], unresolved };
}

/** `[file, line]` of a `file:line:col` or `file:line` location, slashes normalized. */
function fileAndLine(location: string): [string, string] {
  const loc = location.replace(/\\/g, '/');
  const m = /^(.*):(\d+):\d+$/.exec(loc) ?? /^(.*):(\d+)$/.exec(loc);
  return m ? [m[1]!, m[2]!] : [loc, ''];
}

/**
 * True when a snapshot's captured location is on the line of the use's
 * project-relative call site. The stack a snapshot reads and a step's location
 * can differ by column, and the snapshot's path can be absolute.
 */
function sameCallLine(location: string, callSite: string): boolean {
  const [fileA, lineA] = fileAndLine(location);
  const [fileB, lineB] = fileAndLine(callSite);
  if (!lineA || lineA !== lineB) return false;
  return fileA === fileB || fileA.endsWith(`/${fileB}`) || fileB.endsWith(`/${fileA}`);
}

/**
 * True when a snapshot recorded the use's own locating call: the same method
 * and, when both have one, the same first string argument. A helper's line is
 * shared by every locator passed through it, so the line alone names no call.
 */
function sameUsedCall(snapshot: { usedMethod: string; usedArgs: unknown }, target: string): boolean {
  const call = tryParseLocatorChain(target)
    ?.calls.filter((c) => LOCATING_METHODS.has(c.method))
    .at(-1);
  if (!call || call.method !== snapshot.usedMethod) return false;
  const own = stringArg(call.args[0]);
  let args: unknown = snapshot.usedArgs;
  try {
    if (typeof args === 'string') args = JSON.parse(args);
  } catch {
    return false;
  }
  const first = Array.isArray(args) && typeof args[0] === 'string' ? args[0] : null;
  return own == null || first == null || own === first;
}

/** How long a locator use keeps a test's reach to a control: as long as the graph keeps a reaches edge unseen. */
const LOCATOR_REACH_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/** One distinct locator use of a test on the default branch, from the locator index. */
interface IndexedLocatorUse {
  testCaseId: number;
  target: string;
  action: string;
  callSite: string;
  /** The page key the call ran on, '' when unknown. */
  page: string;
  lastSeenAt: Date | number | string | null;
  lastSeenRunId: number | null;
}

/** The default branch's locator uses the index saw within the reach age, one row per distinct use. */
async function loadIndexedLocatorUses(
  db: DrizzleDB,
  projectId: number,
  now: Date = new Date(),
): Promise<IndexedLocatorUse[]> {
  return db
    .select({
      testCaseId: locatorUsages.testCaseId,
      target: locatorUsages.target,
      action: locatorUsages.action,
      callSite: locatorUsages.callSite,
      page: locatorUsages.page,
      lastSeenAt: max(locatorUsages.lastSeenAt),
      lastSeenRunId: max(locatorUsages.lastSeenRunId),
    })
    .from(locatorUsages)
    .where(
      and(
        eq(locatorUsages.projectId, projectId),
        eq(locatorUsages.branch, ''),
        gte(locatorUsages.lastSeenAt, new Date(now.getTime() - LOCATOR_REACH_MAX_AGE_MS)),
      ),
    )
    .groupBy(
      locatorUsages.testCaseId,
      locatorUsages.target,
      locatorUsages.action,
      locatorUsages.callSite,
      locatorUsages.page,
    );
}

/**
 * Write a `reaches` edge from each test to the controls and links its locators
 * target on the default branch, from the locator index and its snapshots. Only
 * nodes the page inventory recorded can be reached, each edge says whether the
 * test acted on the element or only asserted on it, and it carries when the
 * index last saw the use, so a use that stops being seen ages out like any
 * reach. A locator edge the index does not back is removed; a covered-by edge
 * from triage is left as it is. Returns, per page, the tests that operated an
 * element there that the index could not name.
 */
async function syncControlReach(
  db: DrizzleDB,
  projectId: number,
  indexedUses: IndexedLocatorUse[],
  now: Date = new Date(),
): Promise<Map<string, Set<number>>> {
  const nodeRows = await db
    .select({ kind: graphNodes.kind, key: graphNodes.key })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.projectId, projectId),
        isNull(graphNodes.branch),
        isNull(graphNodes.prunedAt),
        inArray(graphNodes.kind, ['control', 'link']),
      ),
    );
  const nodes = {
    controls: new Set(nodeRows.filter((n) => n.kind === 'control').map((n) => n.key)),
    links: new Set(nodeRows.filter((n) => n.kind === 'link').map((n) => n.key)),
  };

  const useRows = nodeRows.length === 0 ? [] : indexedUses;

  // Snapshot alternatives only for the tests with a use their own chain does not name.
  const needsAlternatives = [
    ...new Set(
      useRows
        .filter((u) => {
          const own = locatorNodeTarget(u.target);
          return !(own?.by === 'role' && (own.kind === 'control' ? nodes.controls : nodes.links).has(own.key));
        })
        .map((u) => u.testCaseId),
    ),
  ];
  const snapshotsByTest = new Map<
    number,
    Array<{ location: string; usedMethod: string; usedArgs: unknown; alternatives: string[] }>
  >();
  for (let i = 0; i < needsAlternatives.length; i += 500) {
    const rows = await db
      .select({
        testCaseId: locatorSnapshots.testCaseId,
        location: locatorSnapshots.location,
        usedMethod: locatorSnapshots.usedMethod,
        usedArgs: locatorSnapshots.usedArgs,
        alternatives: locatorSnapshots.alternatives,
      })
      .from(locatorSnapshots)
      .where(inArray(locatorSnapshots.testCaseId, needsAlternatives.slice(i, i + 500)));
    for (const r of rows) {
      if (!r.location) continue;
      let alternatives: string[] = [];
      try {
        const parsed = typeof r.alternatives === 'string' ? JSON.parse(r.alternatives) : r.alternatives;
        if (Array.isArray(parsed)) {
          alternatives = parsed
            .map((a) => (a && typeof a === 'object' ? (a as { locator?: unknown }).locator : null))
            .filter((l): l is string => typeof l === 'string');
        }
      } catch {
        // A malformed snapshot offers no alternative.
      }
      const list = snapshotsByTest.get(r.testCaseId) ?? [];
      list.push({ location: r.location, usedMethod: r.usedMethod, usedArgs: r.usedArgs, alternatives });
      snapshotsByTest.set(r.testCaseId, list);
    }
  }

  const uses = useRows.map((u) => ({
    testCaseId: u.testCaseId,
    target: u.target,
    action: u.action,
    page: u.page,
    lastSeenAt: u.lastSeenAt ? new Date(u.lastSeenAt) : now,
    lastSeenRunId: u.lastSeenRunId ?? null,
    alternatives: u.callSite
      ? snapshotsByTest
          .get(u.testCaseId)
          ?.find((snap) => sameCallLine(snap.location, u.callSite) && sameUsedCall(snap, u.target))?.alternatives
      : undefined,
  }));
  const { reach, unresolved } = resolveControlReach(uses, nodes);

  const existing = await db
    .select({
      id: graphEdges.id,
      fromKey: graphEdges.fromKey,
      toKind: graphEdges.toKind,
      toKey: graphEdges.toKey,
      origin: graphEdges.origin,
      confidence: graphEdges.confidence,
      evidence: graphEdges.evidence,
      lastSeenAt: graphEdges.lastSeenAt,
    })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, 'reaches'),
        eq(graphEdges.fromKind, 'test'),
        inArray(graphEdges.toKind, ['control', 'link']),
        isNull(graphEdges.branch),
      ),
    );
  const isLocatorEdge = (e: (typeof existing)[number]) =>
    e.origin === 'observed' && (e.evidence as { via?: unknown } | null)?.via === 'locator';
  const existingById = new Map(existing.map((e) => [`${e.fromKey}\x00${e.toKind}\x00${e.toKey}`, e]));
  const current = new Set(reach.map((r) => `${r.testCaseId}\x00${r.kind}\x00${r.key}`));
  const stale = existing
    .filter((e) => isLocatorEdge(e) && !current.has(`${e.fromKey}\x00${e.toKind}\x00${e.toKey}`))
    .map((e) => e.id);
  for (let i = 0; i < stale.length; i += 100) {
    await db.delete(graphEdges).where(inArray(graphEdges.id, stale.slice(i, i + 100)));
  }

  const values = reach
    .filter((r) => {
      const prev = existingById.get(`${r.testCaseId}\x00${r.kind}\x00${r.key}`);
      if (!prev) return true;
      if (!isLocatorEdge(prev)) return false;
      return (
        prev.confidence !== r.confidence ||
        (prev.evidence as { action?: unknown } | null)?.action !== r.action ||
        new Date(prev.lastSeenAt).getTime() !== (r.lastSeenAt ?? now).getTime()
      );
    })
    .map((r) => ({
      projectId,
      fromKind: 'test',
      fromKey: String(r.testCaseId),
      toKind: r.kind,
      toKey: r.key,
      kind: 'reaches',
      branch: null,
      confidence: r.confidence,
      origin: 'observed',
      evidence: { via: 'locator', action: r.action } as any,
      firstSeenRunId: r.lastSeenRunId ?? null,
      lastSeenRunId: r.lastSeenRunId ?? null,
      lastSeenAt: r.lastSeenAt ?? now,
    }));
  for (let i = 0; i < values.length; i += 100) {
    await db
      .insert(graphEdges)
      .values(values.slice(i, i + 100))
      .onConflictDoUpdate({
        target: [
          graphEdges.projectId,
          graphEdges.fromKind,
          graphEdges.fromKey,
          graphEdges.kind,
          graphEdges.toKind,
          graphEdges.toKey,
        ],
        targetWhere: isNull(graphEdges.branch),
        set: {
          confidence: sql`excluded.confidence`,
          evidence: sql`excluded.evidence`,
          lastSeenRunId: sql`excluded.last_seen_run_id`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
        setWhere: ne(graphEdges.origin, 'manual'),
      });
  }

  const unresolvedByPage = new Map<string, Set<number>>();
  for (const u of unresolved) {
    if (!u.page) continue;
    const tests = unresolvedByPage.get(u.page) ?? new Set<number>();
    tests.add(u.testCaseId);
    unresolvedByPage.set(u.page, tests);
  }
  return unresolvedByPage;
}

// ── Features ─────────────────────────────────────────────────────────────────

/** What a feature groups beyond its tests' reach is inferred from: the page inventory and the declared surface. */
export interface FeatureGroupingInput {
  /** The `piwi:feature` tag per test. */
  featureByTest: ReadonlyMap<number, string>;
  /** `kind\0key` → the tests reaching the node. */
  reachByNode: ReadonlyMap<string, ReadonlySet<number>>;
  /** Page → the controls it contains. */
  controlsByPage: ReadonlyMap<string, ReadonlySet<string>>;
  /** Page → the pages it links to. */
  linksByPage: ReadonlyMap<string, ReadonlySet<string>>;
  /** The route keys a manifest or OpenAPI document declares. */
  declaredRoutes: readonly string[];
}

/** One `groups` edge: a feature and a node it groups, how, and whether the node is a hub. */
export interface FeatureGroup {
  feature: string;
  kind: 'route' | 'page' | 'control';
  key: string;
  /** `reach`: a test carrying the feature reaches it; otherwise inferred from what the feature's nodes hold. */
  via: 'reach' | 'contains' | 'links' | 'path';
  /** Null for reach; below one when inferred. */
  confidence: number | null;
  /** With three features or more: reached by more than half the tests, or grouped by more than half the features and three at least. */
  hub: boolean;
}

/** `/settings` of `/settings/api`: the first path segment, which a page's siblings share. */
function pagePrefix(page: string): string {
  return `/${page.split('/').filter(Boolean)[0] ?? ''}`;
}

/**
 * `/api/users` of `GET /api/users/:id?page=…`: the path up to its first resource
 * segment, past an `api` and a version segment (`/api/v1/orders`), query aside.
 */
export function routePrefix(route: string): string {
  const path = route.slice(route.indexOf(' ') + 1).split('?')[0]!;
  const segments = path.split('/').filter(Boolean);
  let i = 0;
  while (i < segments.length - 1 && /^(api|v\d+)$/i.test(segments[i]!)) i++;
  return `/${segments.slice(0, i + 1).join('/')}`;
}

/**
 * What each feature groups. A feature groups the routes, pages and controls the
 * tests carrying its tag reach. It also groups, with a confidence below one,
 * what no feature reaches: the controls its pages contain (0.8), the pages its
 * pages link to under the same first path segment (0.6) and their controls
 * (0.5), and the declared routes under the same resource path as a route it
 * reaches ({@link routePrefix}, 0.6). With three features or more, a node
 * reached by more than half the tests, or grouped by more than half the features
 * and by three at least, is a hub: still grouped, but no source of inference, and
 * marked so the map neither links features through it nor counts its tests. Pure.
 */
export function groupFeatures(input: FeatureGroupingInput): FeatureGroup[] {
  const groups = new Map<string, FeatureGroup>(); // feature\0kind\0key → group
  const add = (
    feature: string,
    kind: FeatureGroup['kind'],
    key: string,
    via: FeatureGroup['via'],
    confidence: number | null,
  ) => {
    const id = `${feature}\x00${kind}\x00${key}`;
    const prev = groups.get(id);
    if (prev && (prev.confidence == null || (confidence != null && prev.confidence >= confidence))) return;
    groups.set(id, { feature, kind, key, via, confidence, hub: false });
  };
  /** `kind\0key` → the features grouping it, among `of`. */
  const featuresByNode = (of: Iterable<FeatureGroup>) => {
    const out = new Map<string, Set<string>>();
    for (const g of of) {
      const id = `${g.kind}\x00${g.key}`;
      let set = out.get(id);
      if (!set) out.set(id, (set = new Set()));
      set.add(g.feature);
    }
    return out;
  };

  const reachingTests = new Set<number>();
  for (const [nodeKey, tests] of input.reachByNode) {
    const kind = nodeKey.slice(0, nodeKey.indexOf('\x00'));
    if (kind !== 'route' && kind !== 'page' && kind !== 'control') continue;
    for (const testId of tests) {
      reachingTests.add(testId);
      const feature = input.featureByTest.get(testId);
      if (feature) add(feature, kind, nodeKey.slice(kind.length + 1), 'reach', null);
    }
  }
  const features = new Set([...groups.values()].map((g) => g.feature));
  const hubsApply = features.size >= 3;
  // Grouped by more than half the features, and by three at least, so two
  // features sharing a node stay linked through it.
  const sharedByMost = (count: number) => hubsApply && count >= 3 && count > features.size / 2;
  const reachedHub = (kind: string, key: string) =>
    hubsApply && (input.reachByNode.get(`${kind}\x00${key}`)?.size ?? 0) > reachingTests.size / 2;
  const reachGrouped = new Set([...groups.values()].map((g) => `${g.kind}\x00${g.key}`));
  const byReach = featuresByNode(groups.values());
  const reachHub = (kind: string, key: string) =>
    reachedHub(kind, key) || sharedByMost(byReach.get(`${kind}\x00${key}`)?.size ?? 0);

  const ownByFeature = new Map<string, FeatureGroup[]>();
  for (const g of groups.values()) {
    if (reachHub(g.kind, g.key)) continue;
    let own = ownByFeature.get(g.feature);
    if (!own) ownByFeature.set(g.feature, (own = []));
    own.push(g);
  }
  for (const [feature, own] of ownByFeature) {
    const pages = own.filter((g) => g.kind === 'page').map((g) => g.key);
    const linkedPages: string[] = [];
    for (const page of pages) {
      for (const control of input.controlsByPage.get(page) ?? []) {
        if (!reachGrouped.has(`control\x00${control}`)) add(feature, 'control', control, 'contains', 0.8);
      }
      for (const target of input.linksByPage.get(page) ?? []) {
        if (target === page || pagePrefix(target) !== pagePrefix(page)) continue;
        if (reachGrouped.has(`page\x00${target}`)) continue;
        add(feature, 'page', target, 'links', 0.6);
        linkedPages.push(target);
      }
    }
    for (const page of linkedPages) {
      for (const control of input.controlsByPage.get(page) ?? []) {
        if (!reachGrouped.has(`control\x00${control}`)) add(feature, 'control', control, 'contains', 0.5);
      }
    }
    const prefixes = new Set(own.filter((g) => g.kind === 'route').map((g) => routePrefix(g.key)));
    for (const route of input.declaredRoutes) {
      if (!reachGrouped.has(`route\x00${route}`) && prefixes.has(routePrefix(route)))
        add(feature, 'route', route, 'path', 0.6);
    }
  }

  const all = featuresByNode(groups.values());
  for (const g of groups.values()) {
    g.hub = reachedHub(g.kind, g.key) || sharedByMost(all.get(`${g.kind}\x00${g.key}`)?.size ?? 0);
  }
  return [...groups.values()].sort(
    (a, b) => a.feature.localeCompare(b.feature) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key),
  );
}

/**
 * The one feature each node's gaps sit under, from the `groups` edges into it:
 * the feature reaching it (no confidence) before one inferring it, the most
 * confident inference next, ties by name. A node any edge marks a hub belongs to
 * no one feature. Keyed `kind\0key`; shared by the gap list and the feature map.
 */
export function featureOwners(
  rows: Array<{ feature: string; toKind: string; toKey: string; confidence: number | null; evidence: unknown }>,
): Map<string, { feature: string; hub: boolean }> {
  const rank = (confidence: number | null) => confidence ?? 2;
  const best = new Map<string, { feature: string; confidence: number | null; hub: boolean }>();
  for (const g of rows) {
    const id = `${g.toKind}\x00${g.toKey}`;
    const hub = (g.evidence as { hub?: unknown } | null)?.hub === true;
    const prev = best.get(id);
    if (
      !prev ||
      rank(g.confidence) > rank(prev.confidence) ||
      (rank(g.confidence) === rank(prev.confidence) && g.feature < prev.feature)
    ) {
      best.set(id, { feature: g.feature, confidence: g.confidence, hub: hub || (prev?.hub ?? false) });
    } else if (hub) prev.hub = true;
  }
  return new Map([...best].map(([id, { feature, hub }]) => [id, { feature, hub }]));
}

/** The feature a gap sits under, and whether its node is a hub that belongs to no one feature. */
export type GapFeatureOwner = { feature: string; hub: boolean };

/**
 * The one feature each gap sits under, by its subject: a node's from its
 * `groups` edges ({@link featureOwners}); a test's from its `piwi:feature` tag,
 * when that feature is on the map; a catalog method's from the feature owning
 * most of the pages its URL pattern matches, ties by name. Shared by the gap
 * list and the feature map, so a gap counts under one feature on both.
 */
export async function loadGapFeatureOwners(
  db: DrizzleDB,
  projectId: number,
  rows: Array<{ feature: string; toKind: string; toKey: string; confidence: number | null; evidence: unknown }>,
  subjects: GapSubject[],
): Promise<(subject: GapSubject) => GapFeatureOwner | undefined> {
  const owners = featureOwners(rows);
  const mapped = new Set(rows.map((r) => r.feature));

  const testIds = [...new Set(subjects.filter((s) => s.kind === 'test').map((s) => Number(s.key)))].filter(
    Number.isFinite,
  );
  const featureByTest = new Map<string, string>();
  for (let i = 0; i < testIds.length; i += 200) {
    const tests = await db
      .select({ id: testCases.id, feature: testCases.feature })
      .from(testCases)
      .where(and(eq(testCases.projectId, projectId), inArray(testCases.id, testIds.slice(i, i + 200))));
    for (const t of tests) {
      const feature = t.feature?.trim();
      if (feature && mapped.has(feature)) featureByTest.set(String(t.id), feature);
    }
  }

  const featureByMethod = new Map<string, string>();
  const methods = new Set(subjects.filter((s) => s.kind === 'catalog').map((s) => s.key));
  if (methods.size > 0) {
    const entries = (
      await db
        .select({ module: testFunctions.module, name: testFunctions.name, urlPattern: testFunctions.urlPattern })
        .from(testFunctions)
        .where(eq(testFunctions.projectId, projectId))
    ).filter((e) => methods.has(`${e.module}#${e.name}`));
    const pages = await db
      .select({ key: graphNodes.key, attrs: graphNodes.attrs })
      .from(graphNodes)
      .where(
        and(
          eq(graphNodes.projectId, projectId),
          eq(graphNodes.kind, 'page'),
          isNull(graphNodes.branch),
          isNull(graphNodes.prunedAt),
        ),
      );
    for (const entry of entries) {
      const tally = new Map<string, number>();
      for (const page of pages) {
        const owner = owners.get(`page\x00${page.key}`);
        if (!owner || owner.hub) continue;
        const url = (page.attrs as { url?: unknown } | null)?.url;
        if (!catalogPatternMatchesPage(entry.urlPattern, page.key, typeof url === 'string' ? url : null)) continue;
        tally.set(owner.feature, (tally.get(owner.feature) ?? 0) + 1);
      }
      const [best] = [...tally].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
      if (best) featureByMethod.set(`${entry.module}#${entry.name}`, best[0]);
    }
  }

  return (subject) => {
    if (subject.kind === 'test') {
      const feature = featureByTest.get(subject.key);
      return feature ? { feature, hub: false } : undefined;
    }
    if (subject.kind === 'catalog') {
      const feature = featureByMethod.get(subject.key);
      return feature ? { feature, hub: false } : undefined;
    }
    return owners.get(`${subject.kind}\x00${subject.key}`);
  };
}

/**
 * Build `feature` nodes and `groups` edges from the `piwi:feature` tag on tests
 * and what the graph infers from it ({@link groupFeatures}). An inferred edge has
 * origin `inferred` and evidence naming how (`via`); a hub's edges carry
 * `hub: true`. Canonical rows only — features are project-level. The groups are
 * rebuilt whole: an edge the grouping no longer yields is removed, so a feature
 * that loses its tag leaves the map.
 */
async function syncFeatureNodes(
  db: DrizzleDB,
  projectId: number,
  shape: Omit<FeatureGroupingInput, 'featureByTest'>,
  runId: number | null,
): Promise<void> {
  const testIds = new Set<number>();
  for (const ids of shape.reachByNode.values()) for (const id of ids) testIds.add(id);

  const featureByTest = new Map<number, string>();
  const ids = [...testIds];
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await db
      .select({ id: testCases.id, feature: testCases.feature })
      .from(testCases)
      .where(inArray(testCases.id, ids.slice(i, i + 200)));
    for (const r of rows) if (r.feature?.trim()) featureByTest.set(r.id, r.feature.trim());
  }
  const groups = featureByTest.size === 0 ? [] : groupFeatures({ ...shape, featureByTest });

  const wanted = new Set(groups.map((g) => `${g.feature}\x00${g.kind}\x00${g.key}`));
  const existing = await db
    .select({ id: graphEdges.id, fromKey: graphEdges.fromKey, toKind: graphEdges.toKind, toKey: graphEdges.toKey })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, 'groups'),
        eq(graphEdges.fromKind, 'feature'),
        isNull(graphEdges.branch),
      ),
    );
  const stale = existing.filter((e) => !wanted.has(`${e.fromKey}\x00${e.toKind}\x00${e.toKey}`)).map((e) => e.id);
  for (let i = 0; i < stale.length; i += 100) {
    await db.delete(graphEdges).where(inArray(graphEdges.id, stale.slice(i, i + 100)));
  }
  if (groups.length === 0) return;

  const now = new Date();
  for (const feature of new Set(groups.map((g) => g.feature))) {
    await db
      .insert(graphNodes)
      .values({
        projectId,
        kind: 'feature',
        key: feature,
        branch: null,
        attrs: { source: 'tag' } as any,
        origin: 'observed',
        firstSeenRunId: runId,
        lastSeenRunId: runId,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [graphNodes.projectId, graphNodes.kind, graphNodes.key],
        targetWhere: isNull(graphNodes.branch),
        set: {
          lastSeenRunId: sql`excluded.last_seen_run_id`,
          lastSeenAt: sql`excluded.last_seen_at`,
          prunedAt: sql`null`,
        },
      });
  }

  const edgeValues = groups.map((g) => {
    const evidence =
      g.via === 'reach' ? (g.hub ? { hub: true } : null) : { via: g.via, ...(g.hub ? { hub: true } : {}) };
    return {
      projectId,
      fromKind: 'feature',
      fromKey: g.feature,
      toKind: g.kind,
      toKey: g.key,
      kind: 'groups',
      branch: null,
      confidence: g.confidence,
      origin: g.via === 'reach' ? 'observed' : 'inferred',
      evidence: evidence as any,
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      lastSeenAt: now,
    };
  });
  for (let i = 0; i < edgeValues.length; i += 100) {
    await db
      .insert(graphEdges)
      .values(edgeValues.slice(i, i + 100))
      .onConflictDoUpdate({
        target: [
          graphEdges.projectId,
          graphEdges.fromKind,
          graphEdges.fromKey,
          graphEdges.kind,
          graphEdges.toKind,
          graphEdges.toKey,
        ],
        targetWhere: isNull(graphEdges.branch),
        set: {
          confidence: sql`excluded.confidence`,
          origin: sql`excluded.origin`,
          evidence: sql`excluded.evidence`,
          lastSeenRunId: sql`excluded.last_seen_run_id`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      });
  }
}

/**
 * Close a changed-unreached gap once a test reaches the file's route or page
 * node — the same self-closing the project-wide detectors get, so a changed file
 * that later gains a test stops being reported. The file is resolved to its node
 * through the file-routing convention and checked against this run's reach edges.
 */
async function closeReachedChangedUnreached(
  db: DrizzleDB,
  projectId: number,
  runId: number | null,
  reachByNode: Map<string, Set<number>>,
  statuses: GapStatus[] = ['open', 'snoozed'],
): Promise<number> {
  const closable = statuses.filter((s) => s === 'open' || s === 'snoozed');
  if (closable.length === 0) return 0;
  const open = await db
    .select({ id: scenarioGaps.id, key: scenarioGaps.key })
    .from(scenarioGaps)
    .where(
      and(
        eq(scenarioGaps.projectId, projectId),
        eq(scenarioGaps.detector, 'changed-unreached'),
        inArray(scenarioGaps.status, closable),
      ),
    );
  if (open.length === 0) return 0;

  // Route and page node keys a test reaches in this scope.
  const reachedRoutes: string[] = [];
  const reachedPages: string[] = [];
  for (const [nodeKey, ids] of reachByNode) {
    if (ids.size === 0) continue;
    const sep = nodeKey.indexOf('\x00');
    const kind = nodeKey.slice(0, sep);
    const key = nodeKey.slice(sep + 1);
    if (kind === 'route') reachedRoutes.push(key);
    else if (kind === 'page') reachedPages.push(key);
  }

  const toClose: number[] = [];
  for (const gap of open) {
    const routeTarget = fileRouteTarget(gap.key);
    const pageTarget = filePageTarget(gap.key);
    const reached =
      (routeTarget != null && reachedRoutes.some((k) => routeKeyMatchesTarget(routeTarget, k))) ||
      (pageTarget != null && reachedPages.some((k) => pageKeyMatchesTarget(pageTarget, k)));
    if (reached) toClose.push(gap.id);
  }
  if (toClose.length === 0) return 0;

  const now = new Date();
  for (let i = 0; i < toClose.length; i += 100) {
    await db
      .update(scenarioGaps)
      .set({ status: 'closed', closedAt: now, closedByRunId: runId, updatedAt: now })
      .where(inArray(scenarioGaps.id, toClose.slice(i, i + 100)));
  }
  return toClose.length;
}

/**
 * Deduplicate detected gaps by `(detector, key)`, keeping the highest-scoring
 * row. Two tests reporting `unhandled` on one route, or a recompute that reads
 * both the canonical and the branch row of a node, otherwise send the same
 * `(detector, key)` twice in one batch — which PostgreSQL rejects with
 * `ON CONFLICT DO UPDATE command cannot affect row a second time` (SQLite quietly
 * accepts it, which is why the libSQL unit tests never caught it).
 */
export function dedupeScoredGaps(gaps: ScoredGap[]): ScoredGap[] {
  const byKey = new Map<string, ScoredGap>();
  for (const g of gaps) {
    const k = `${g.detector}\x00${g.key}`;
    const prev = byKey.get(k);
    if (!prev || (g.score ?? 0) > (prev.score ?? 0)) byKey.set(k, g);
  }
  return [...byKey.values()];
}

/**
 * Upsert scored gaps into the ledger. A row's evidence, factors and score are
 * refreshed; its triage columns (`dismiss_reason`, `assigned_to`) are never
 * touched, and a dismissed, accepted or snoozed gap keeps its status. A *closed*
 * gap detected again reopens, so a gap the sweep closed and the graph then
 * re-surfaces returns to the inbox rather than staying closed forever. Rows are
 * deduped by `(detector, key)` first, so the batch is safe on PostgreSQL.
 */
export async function upsertScenarioGaps(
  db: DrizzleDB,
  projectId: number,
  gaps: ScoredGap[],
  ctx: { runId?: number | null; prNumber?: number | null } = {},
): Promise<number> {
  const deduped = dedupeScoredGaps(gaps);
  if (deduped.length === 0) return 0;
  const now = new Date();
  const CHUNK = 100;
  let written = 0;
  const reopens = sql`(${scenarioGaps.status} = 'closed' and ${scenarioGaps.coveredAt} is null)`;

  for (let i = 0; i < deduped.length; i += CHUNK) {
    const slice = deduped.slice(i, i + CHUNK);
    await db
      .insert(scenarioGaps)
      .values(
        slice.map((g) => ({
          projectId,
          kind: g.kind,
          detector: g.detector,
          class: g.class,
          key: g.key,
          title: g.title,
          evidence: g.evidence as any,
          factors: g.factors as any,
          score: g.score,
          testCaseId: g.testCaseId ?? null,
          failureClusterId: g.failureClusterId ?? null,
          ticket: g.ticket ?? null,
          testRunId: ctx.runId ?? null,
          prNumber: ctx.prNumber ?? null,
          status: 'open',
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [scenarioGaps.projectId, scenarioGaps.detector, scenarioGaps.key],
        set: {
          kind: sql`excluded.kind`,
          class: sql`excluded.class`,
          title: sql`excluded.title`,
          evidence: sql`excluded.evidence`,
          factors: sql`excluded.factors`,
          score: sql`excluded.score`,
          testCaseId: sql`excluded.test_case_id`,
          failureClusterId: sql`excluded.failure_cluster_id`,
          ticket: sql`excluded.ticket`,
          testRunId: sql`excluded.test_run_id`,
          prNumber: sql`coalesce(excluded.pr_number, ${scenarioGaps.prNumber})`,
          updatedAt: sql`excluded.updated_at`,
          // Reopen a closed gap that is detected again, unless a person closed it
          // with a covered-by; every other status keeps its verdict. Clear the
          // close bookkeeping only on that reopen.
          status: sql`case when ${reopens} then 'open' else ${scenarioGaps.status} end`,
          closedAt: sql`case when ${reopens} then null else ${scenarioGaps.closedAt} end`,
          closedByRunId: sql`case when ${reopens} then null else ${scenarioGaps.closedByRunId} end`,
        },
      });
    written += slice.length;
  }
  return written;
}

/**
 * Close open/snoozed/accepted gaps of the given detectors whose key was not
 * re-detected: a gap whose node gained a trusted edge, or whose route now sees an
 * error path, closes itself so "closed this month" is a real number. Accepted
 * gaps close too — once a team wrote the test, the node is reached and the gap
 * stops being detected, so the Home inbox drains.
 */
async function closeMissingGaps(
  db: DrizzleDB,
  projectId: number,
  detectors: string[],
  kept: ScoredGap[],
  runId: number | null,
  statuses: GapStatus[] = ['open', 'snoozed', 'accepted'],
): Promise<number> {
  const keptKeys = new Set(kept.map((g) => `${g.detector}\x00${g.key}`));
  const open = await db
    .select({ id: scenarioGaps.id, detector: scenarioGaps.detector, key: scenarioGaps.key })
    .from(scenarioGaps)
    .where(
      and(
        eq(scenarioGaps.projectId, projectId),
        inArray(scenarioGaps.detector, detectors),
        inArray(scenarioGaps.status, statuses),
      ),
    );

  const toClose = open.filter((row) => !keptKeys.has(`${row.detector}\x00${row.key}`)).map((r) => r.id);
  if (toClose.length === 0) return 0;

  const now = new Date();
  for (let i = 0; i < toClose.length; i += 100) {
    await db
      .update(scenarioGaps)
      .set({ status: 'closed', closedAt: now, closedByRunId: runId, updatedAt: now })
      .where(inArray(scenarioGaps.id, toClose.slice(i, i + 100)));
  }
  return toClose.length;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface ScenarioGapRow {
  id: number;
  kind: GapKind;
  detector: string;
  class: GapClass;
  key: string;
  /** The graph node the gap is about, typed (kind + key), separate from the dedupe `key`. */
  subject: GapSubject;
  title: string;
  evidence: string[];
  factors: ExposureFactors | null;
  score: number | null;
  status: GapStatus;
  dismissReason: string | null;
  ticket: string | null;
  prNumber: number | null;
  testCaseId: number | null;
  testRunId: number | null;
  projectId: number;
  /**
   * The feature (from a `groups` edge) the gap's subject belongs to, or null:
   * one whose tests reach it before one that only infers it. Null for a hub.
   */
  feature: string | null;
  /** The subject is a hub: most tests reach it, or most features group it. */
  hub?: boolean;
  snoozedUntil: number | null;
  acceptedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Milliseconds from a stored timestamp column (Date in Postgres, epoch-ms in SQLite). */
function toMs(v: unknown): number {
  return v instanceof Date ? v.getTime() : Number(v);
}

/** Map a stored scenario_gaps row to the API {@link ScenarioGapRow}. */
function mapGapRow(r: typeof scenarioGaps.$inferSelect): ScenarioGapRow {
  return {
    id: r.id,
    kind: r.kind as GapKind,
    detector: r.detector,
    class: r.class as GapClass,
    key: r.key,
    subject: subjectFromGapKey(r.key),
    title: r.title,
    evidence: Array.isArray(r.evidence) ? (r.evidence as string[]) : [],
    factors: (r.factors as ExposureFactors | null) ?? null,
    score: r.score ?? null,
    status: r.status as GapStatus,
    dismissReason: r.dismissReason ?? null,
    ticket: r.ticket ?? null,
    prNumber: r.prNumber ?? null,
    testCaseId: r.testCaseId ?? null,
    testRunId: r.testRunId ?? null,
    projectId: r.projectId,
    feature: null,
    snoozedUntil: r.snoozedUntil != null ? toMs(r.snoozedUntil) : null,
    acceptedAt: r.acceptedAt != null ? toMs(r.acceptedAt) : null,
    createdAt: toMs(r.createdAt),
    updatedAt: toMs(r.updatedAt),
  };
}

export interface GapFilters {
  kind?: string;
  class?: string;
  detector?: string;
  status?: string;
  prNumber?: number;
  /** Keep only gaps at or above this exposure score. */
  minScore?: number;
  limit?: number;
}

/** List a project's gaps, ranked by score. Defaults to open gaps only. */
export async function listScenarioGaps(
  db: DrizzleDB,
  projectId: number,
  filters: GapFilters = {},
): Promise<ScenarioGapRow[]> {
  // Wake any timed snooze whose wake time has passed, so an expired snooze
  // reappears in the list without waiting for a recompute.
  await reopenExpiredSnoozes(db, projectId);

  const where = [eq(scenarioGaps.projectId, projectId)];
  if (filters.status && filters.status !== 'all') where.push(eq(scenarioGaps.status, filters.status));
  else if (!filters.status) where.push(eq(scenarioGaps.status, 'open'));
  if (filters.kind) where.push(eq(scenarioGaps.kind, filters.kind));
  if (filters.class) where.push(eq(scenarioGaps.class, filters.class));
  if (filters.detector) where.push(eq(scenarioGaps.detector, filters.detector));
  if (filters.prNumber != null) where.push(eq(scenarioGaps.prNumber, filters.prNumber));
  if (filters.minScore != null) where.push(gte(scenarioGaps.score, filters.minScore));

  const limit = Math.min(200, Math.max(1, filters.limit ?? 100));
  const rows = await db
    .select()
    .from(scenarioGaps)
    .where(and(...where))
    .orderBy(desc(scenarioGaps.score), desc(scenarioGaps.updatedAt))
    .limit(limit);

  const mapped = rows.map(mapGapRow);

  // Resolve each gap's feature from the `groups` edges (feature → node), canonical:
  // the feature reaching the node, else the one inferring it with the most
  // confidence, ties by name. A hub belongs to no one feature.
  const groupRows = await db
    .select({
      feature: graphEdges.fromKey,
      toKind: graphEdges.toKind,
      toKey: graphEdges.toKey,
      confidence: graphEdges.confidence,
      evidence: graphEdges.evidence,
    })
    .from(graphEdges)
    .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.kind, 'groups'), isNull(graphEdges.branch)));
  if (groupRows.length > 0) {
    const ownerOf = await loadGapFeatureOwners(
      db,
      projectId,
      groupRows,
      mapped.map((g) => g.subject),
    );
    for (const gap of mapped) {
      const owner = ownerOf(gap.subject);
      if (!owner) continue;
      if (owner.hub) gap.hub = true;
      else gap.feature = owner.feature;
    }
  }

  return mapped;
}

// ── Triage ───────────────────────────────────────────────────────────────────

/** The inbox verbs a gap can be triaged with. */
export type TriageVerb = 'accept' | 'snooze' | 'dismiss' | 'covered-by';
export type SnoozeOption = '1-day' | '1-week' | 'until-node-changes';
export type DismissReason = 'not-worth-testing' | 'covered-elsewhere' | 'wrong';

/** The body of a gap triage: the verb and what it carries. */
export const gapTriageSchema = z.object({
  verb: z.enum(['accept', 'snooze', 'dismiss', 'covered-by']),
  snooze: z.enum(['1-day', '1-week', 'until-node-changes']).optional(),
  reason: z.enum(['not-worth-testing', 'covered-elsewhere', 'wrong']).optional(),
  coveringTestCaseId: z.number().int().optional().nullable(),
  assignedTo: z.string().optional().nullable(),
});

/** What a triage action carries beyond its verb. */
export interface TriageInput {
  verb: TriageVerb;
  snooze?: SnoozeOption;
  reason?: DismissReason;
  /** The covering test for a `covered-by`, or a `covered-elsewhere` dismissal — writes a manual reaches edge. */
  coveringTestCaseId?: number | null;
  assignedTo?: string | null;
  /** The user who gave the verdict, recorded on the gap; null when auth is off. */
  triagedByUserId?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The fixed length a snooze defaults to when no option (or `1-week`) is given. */
const DEFAULT_SNOOZE_MS = 7 * DAY_MS;

/**
 * The wake time a snooze option resolves to. `until-node-changes` returns null —
 * it has no timed wake and is tracked by the node's edge signature instead —
 * while an absent option falls back to the fixed default length, never to
 * "until the node changes".
 */
function snoozeUntil(option: SnoozeOption | undefined, now: Date): Date | null {
  if (option === '1-day') return new Date(now.getTime() + DAY_MS);
  if (option === 'until-node-changes') return null;
  return new Date(now.getTime() + DEFAULT_SNOOZE_MS);
}

/**
 * Write a manual `reaches` edge from a covering test to a gap's subject node, so
 * the node is now considered reached and the gap closes on the next recompute.
 * Origin `manual` distinguishes it from an observed edge.
 */
async function writeManualReachesEdge(
  db: DrizzleDB,
  projectId: number,
  subject: GapSubject,
  testCaseId: number,
): Promise<void> {
  if (subject.kind === 'file') return; // a file node is not a reaches target here
  const now = new Date();
  await db
    .insert(graphEdges)
    .values({
      projectId,
      fromKind: 'test',
      fromKey: String(testCaseId),
      toKind: subject.kind,
      toKey: subject.key,
      kind: 'reaches',
      branch: null,
      confidence: 1,
      origin: 'manual',
      evidence: { manual: true } as any,
      firstSeenRunId: null,
      lastSeenRunId: null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [
        graphEdges.projectId,
        graphEdges.fromKind,
        graphEdges.fromKey,
        graphEdges.kind,
        graphEdges.toKind,
        graphEdges.toKey,
      ],
      targetWhere: isNull(graphEdges.branch),
      set: {
        origin: sql`excluded.origin`,
        confidence: sql`excluded.confidence`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    });
}

/** Subject kinds that are graph nodes with incident edges we can fingerprint. */
const SIGNATURE_SUBJECT_KINDS = new Set(['route', 'page', 'control', 'dependency', 'handler', 'feature']);

/**
 * A stable fingerprint of a subject node's canonical incident edges — every
 * `reaches`, `checks`, `contains`, `links` … edge into or out of the node,
 * sorted, and for a feature its `groups` edges. A `groups` edge into any other
 * node follows from project-wide grouping (a hub, a feature inferring it), so it
 * is no change of the node itself. "Snooze until the node changes" wakes when this fingerprint
 * changes (an edge added or removed, a confidence rescored), so a mere
 * re-observation of the unchanged node does not wake it. Returns null when the
 * subject is not a trackable node (a `test:`, `cluster:`, `file:`, `ticket:`,
 * `intent:` or `catalog:` subject): those cannot use the mechanism, so the caller
 * falls back to a fixed-length snooze rather than one that would never wake.
 */
async function subjectEdgeSignature(db: DrizzleDB, projectId: number, subject: GapSubject): Promise<string | null> {
  if (!SIGNATURE_SUBJECT_KINDS.has(subject.kind)) return null;
  const rows = await db
    .select({
      fromKind: graphEdges.fromKind,
      fromKey: graphEdges.fromKey,
      toKind: graphEdges.toKind,
      toKey: graphEdges.toKey,
      kind: graphEdges.kind,
      confidence: graphEdges.confidence,
    })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        isNull(graphEdges.branch),
        or(
          and(eq(graphEdges.fromKind, subject.kind), eq(graphEdges.fromKey, subject.key)),
          and(eq(graphEdges.toKind, subject.kind), eq(graphEdges.toKey, subject.key)),
        ),
      ),
    );
  const parts = rows
    .filter((r) => r.kind !== 'groups' || subject.kind === 'feature')
    .map((r) => `${r.kind}|${r.fromKind}:${r.fromKey}>${r.toKind}:${r.toKey}|${r.confidence ?? ''}`)
    .sort();
  return `${parts.length}\n${parts.join('\n')}`;
}

/** True when a test case belongs to the project — a covering test may only be one of its own. */
async function testCaseInProject(db: DrizzleDB, projectId: number, testCaseId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: testCases.id })
    .from(testCases)
    .where(and(eq(testCases.id, testCaseId), eq(testCases.projectId, projectId)))
    .limit(1);
  return !!row;
}

/** The outcome of a triage action: the new status, or why it could not be applied. */
export type TriageResult = { status: GapStatus } | { error: 'gap-not-found' | 'covering-test-not-found' };

/**
 * Apply an inbox verb to a gap: accept, snooze (1-day / 1-week / until the node
 * changes), dismiss with a reason (covered-elsewhere writes a manual reaches
 * edge from the covering test), or covered-by (closes the gap and writes the
 * edge). A covering test must belong to the same project. Returns the
 * gap's new status, or an error when the gap or the covering test is not found.
 */
export async function triageGap(
  db: DrizzleDB,
  projectId: number,
  gapId: number,
  input: TriageInput,
): Promise<TriageResult> {
  const [gap] = await db
    .select({ id: scenarioGaps.id, key: scenarioGaps.key })
    .from(scenarioGaps)
    .where(and(eq(scenarioGaps.id, gapId), eq(scenarioGaps.projectId, projectId)));
  if (!gap) return { error: 'gap-not-found' };

  // A covering test is written as a manual reaches edge; it must be one of this
  // project's own test cases, never a cross-project id.
  const writesEdge = input.verb === 'covered-by' || (input.verb === 'dismiss' && input.reason === 'covered-elsewhere');
  if (writesEdge && input.coveringTestCaseId != null) {
    if (!(await testCaseInProject(db, projectId, input.coveringTestCaseId))) {
      return { error: 'covering-test-not-found' };
    }
  }

  const now = new Date();
  const subject = subjectFromGapKey(gap.key);
  // Record who gave the verdict on every triage action (null when auth is off).
  const set: Record<string, unknown> = { updatedAt: now, triagedBy: input.triagedByUserId ?? null };

  if (input.verb === 'accept') {
    set.status = 'accepted';
    set.acceptedAt = now;
    if (input.assignedTo !== undefined) set.assignedTo = input.assignedTo;
  } else if (input.verb === 'snooze') {
    set.status = 'snoozed';
    if (input.snooze === 'until-node-changes') {
      // Record the subject node's edge signature; the gap wakes when it changes.
      const signature = await subjectEdgeSignature(db, projectId, subject);
      if (signature == null) {
        // Not a trackable node (a test/cluster/file gap): use a fixed length
        // rather than a snooze that could never wake.
        set.snoozedUntil = snoozeUntil(undefined, now);
        set.snoozedAtSignature = null;
      } else {
        set.snoozedUntil = null;
        set.snoozedAtSignature = signature;
      }
    } else {
      set.snoozedUntil = snoozeUntil(input.snooze, now);
      set.snoozedAtSignature = null;
    }
  } else if (input.verb === 'dismiss') {
    set.status = 'dismissed';
    set.dismissReason = input.reason ?? 'wrong';
    if (input.reason === 'covered-elsewhere' && input.coveringTestCaseId != null) {
      await writeManualReachesEdge(db, projectId, subject, input.coveringTestCaseId);
    }
  } else {
    // covered-by: close the gap for good (a later detection does not reopen it)
    // and record the covering test as a manual reaches edge. `coveredAt` is a
    // durable per-gap "for" verdict, so precision credits only this gap — not
    // every detector that happens to share the subject node.
    set.status = 'closed';
    set.closedAt = now;
    set.closedByRunId = null;
    set.coveredAt = now;
    if (input.coveringTestCaseId != null) {
      await writeManualReachesEdge(db, projectId, subject, input.coveringTestCaseId);
    }
  }

  await db
    .update(scenarioGaps)
    .set(set as any)
    .where(and(eq(scenarioGaps.id, gapId), eq(scenarioGaps.projectId, projectId)));
  return { status: (set.status as GapStatus) ?? 'open' };
}

/**
 * Wake snoozed gaps whose snooze has expired (snoozedUntil in the past). Called
 * before listing so an expired snooze reappears without a recompute.
 */
export async function reopenExpiredSnoozes(db: DrizzleDB, projectId: number, now: Date = new Date()): Promise<number> {
  const woken = await db
    .update(scenarioGaps)
    .set({ status: 'open', snoozedUntil: null, updatedAt: now })
    .where(
      and(
        eq(scenarioGaps.projectId, projectId),
        eq(scenarioGaps.status, 'snoozed'),
        isNotNull(scenarioGaps.snoozedUntil),
        lt(scenarioGaps.snoozedUntil, now),
      ),
    )
    .returning({ id: scenarioGaps.id });
  return woken.length;
}

/**
 * Wake "until the node changes" snoozes (snoozedUntil null) whose subject node's
 * edge signature no longer matches the one recorded when they were snoozed — the
 * node's observed shape changed (a new edge, a removed edge, a rescored one), so
 * the gap is worth re-evaluating. A node merely re-observed with the same shape
 * does not wake.
 */
async function reopenChangedNodeSnoozes(db: DrizzleDB, projectId: number, now: Date = new Date()): Promise<number> {
  const snoozed = await db
    .select({ id: scenarioGaps.id, key: scenarioGaps.key, snoozedAtSignature: scenarioGaps.snoozedAtSignature })
    .from(scenarioGaps)
    .where(
      and(
        eq(scenarioGaps.projectId, projectId),
        eq(scenarioGaps.status, 'snoozed'),
        isNull(scenarioGaps.snoozedUntil),
        isNotNull(scenarioGaps.snoozedAtSignature),
      ),
    );
  const toWake: number[] = [];
  for (const gap of snoozed) {
    const subject = subjectFromGapKey(gap.key);
    const current = await subjectEdgeSignature(db, projectId, subject);
    if (current != null && current !== gap.snoozedAtSignature) toWake.push(gap.id);
  }
  if (toWake.length === 0) return 0;
  for (let i = 0; i < toWake.length; i += 100) {
    await db
      .update(scenarioGaps)
      .set({ status: 'open', snoozedAtSignature: null, updatedAt: now })
      .where(inArray(scenarioGaps.id, toWake.slice(i, i + 100)));
  }
  return toWake.length;
}

/**
 * Accepted-but-unwritten gaps older than a week: the Home `gaps` inbox queue.
 * A gap the team accepted but whose node still has no trusted edge — the draft
 * was never turned into a test.
 */
export async function listAcceptedUnwritten(
  db: DrizzleDB,
  projectIds: number[] | 'all',
  now: Date = new Date(),
): Promise<ScenarioGapRow[]> {
  const cutoff = new Date(now.getTime() - 7 * DAY_MS);
  const where = [eq(scenarioGaps.status, 'accepted'), lt(scenarioGaps.acceptedAt, cutoff)];
  if (projectIds !== 'all') {
    if (projectIds.length === 0) return [];
    where.push(inArray(scenarioGaps.projectId, projectIds));
  }
  const rows = await db
    .select()
    .from(scenarioGaps)
    .where(and(...where))
    .orderBy(desc(scenarioGaps.score))
    .limit(100);
  const mapped = rows.map(mapGapRow);
  if (mapped.length === 0) return mapped;

  // "Unwritten" means the subject node still has no trusted `reaches` edge: a gap
  // whose test was actually written gains one and drops out of the queue.
  const byProject = new Map<number, ScenarioGapRow[]>();
  for (const gap of mapped) {
    const list = byProject.get(gap.projectId) ?? [];
    list.push(gap);
    byProject.set(gap.projectId, list);
  }
  const reachedSubjects = new Set<string>();
  for (const [projectId, gaps] of byProject) {
    const subjectKeys = [...new Set(gaps.map((g) => g.subject.key))];
    const edges = await db
      .select({ toKind: graphEdges.toKind, toKey: graphEdges.toKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.kind, 'reaches'),
          isNull(graphEdges.branch),
          inArray(graphEdges.toKey, subjectKeys),
        ),
      );
    const reached = new Set(edges.map((e) => `${e.toKind}\x00${e.toKey}`));
    for (const gap of gaps) {
      if (reached.has(`${gap.subject.kind}\x00${gap.subject.key}`)) {
        reachedSubjects.add(`${gap.projectId}\x00${gap.subject.kind}\x00${gap.subject.key}`);
      }
    }
  }
  return mapped.filter((gap) => !reachedSubjects.has(`${gap.projectId}\x00${gap.subject.kind}\x00${gap.subject.key}`));
}

// ── Deterministic draft (pure + loader) ──────────────────────────────────────

/** The pieces a draft skeleton is rendered from. */
export interface ScenarioDraftInput {
  gapTitle: string;
  gapClass: string;
  subject: { kind: string; key: string };
  nearestTest?: { title: string; feature?: string | null; priority?: string | null; location?: string | null } | null;
  /** Human-readable path steps from a reached page to the gap. */
  path: string[];
  catalogMethods: Array<{ module: string; name: string; receiver?: string | null }>;
  evidence: string[];
}

export interface ScenarioDraft extends ScenarioDraftInput {
  /** The piwi: annotations carried into the skeleton, from the nearest test. */
  annotations: Array<{ type: string; description?: string }>;
  /** The rendered Playwright test skeleton, delivered as text. */
  text: string;
}

/** A safe single-quoted string for the generated source. */
function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The TODO assertion a gap's class suggests. */
function assertionForClass(gapClass: string, subjectKey: string): string {
  switch (gapClass) {
    case 'false-comfort':
      return `TODO: assert the effect ${subjectKey} should have on the page — a probe showed a passing test does not notice it breaking.`;
    case 'fragile':
      return `TODO: assert the behavior a second scenario should protect.`;
    default:
      return `TODO: assert what ${subjectKey} should produce.`;
  }
}

/**
 * Render a deterministic test skeleton for a gap: a title, piwi: annotations
 * from the nearest test, the graph path as the step list, catalog methods where
 * they match, and a TODO assertion. No AI — the assertion is left for a human or
 * an agent to fill.
 */
export function renderScenarioDraft(input: ScenarioDraftInput): ScenarioDraft {
  const annotations: Array<{ type: string; description?: string }> = [];
  if (input.nearestTest?.feature) annotations.push({ type: 'piwi:feature', description: input.nearestTest.feature });
  if (input.nearestTest?.priority) annotations.push({ type: 'piwi:priority', description: input.nearestTest.priority });

  const lines: string[] = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`// Draft for a ${input.gapClass} gap: ${input.gapTitle}`);
  for (const e of input.evidence) lines.push(`// ${e}`);
  if (input.nearestTest?.location)
    lines.push(`// Nearest test: ${input.nearestTest.title} (${input.nearestTest.location})`);
  lines.push('');

  const annotationArg =
    annotations.length > 0
      ? `, {\n  annotation: [${annotations.map((a) => `{ type: ${q(a.type)}, description: ${q(a.description ?? '')} }`).join(', ')}],\n}`
      : '';
  lines.push(`test(${q(input.gapTitle)}${annotationArg}, async ({ page }) => {`);

  if (input.path.length > 0) {
    lines.push('  // Path to the gap:');
    for (const step of input.path) lines.push(`  ${step}`);
  } else {
    lines.push('  // No reached path to this gap — start from the nearest entry point.');
  }

  if (input.catalogMethods.length > 0) {
    lines.push('  // Catalog methods that match this page:');
    for (const m of input.catalogMethods) {
      const recv = m.receiver ? `${m.receiver}.` : '';
      lines.push(`  // await ${recv}${m.name}(); // from ${m.module}`);
    }
  }

  lines.push(`  // ${assertionForClass(input.gapClass, input.subject.key)}`);
  lines.push('});');
  lines.push('');

  return { ...input, annotations, text: lines.join('\n') };
}

/** A gap's subject node — the graph node the gap is about, as a typed (kind, key) pair. */
export interface GapSubject {
  kind: string;
  key: string;
}

/**
 * The subject node a gap is about, kept separate from its dedupe `key`: the
 * dedupe key varies by detector (a typed `kind:key`, a raw route key, or a file
 * path), so callers that need to join a gap to a graph node — the feature filter,
 * the draft builder — read the subject, never the raw key.
 */
export function subjectFromGapKey(key: string): GapSubject {
  // The not-handled finding keys its subject as `dependency:<dep> @ <route>`; the
  // subject node is the dependency, so drop the ` @ <route>` locator.
  if (key.startsWith('dependency:')) {
    const dep = key.slice('dependency:'.length).split(' @ ')[0]!;
    return { kind: 'dependency', key: dep };
  }
  for (const kind of [
    'route',
    'page',
    'control',
    'link',
    'test',
    'cluster',
    'catalog',
    'intent',
    'feature',
    'ticket',
    'handler',
  ]) {
    const prefix = `${kind}:`;
    if (key.startsWith(prefix)) return { kind, key: key.slice(prefix.length) };
  }
  // Untyped keys: a raw route key or a file path.
  if (/^[A-Z]+\s/.test(key)) return { kind: 'route', key };
  return { kind: 'file', key };
}

/**
 * Load a gap and render its deterministic draft. Finds the nearest test (the
 * gap's own, else one reaching the subject or a neighboring node), the reached
 * page nearest the subject as the path, and the catalog methods whose url pattern
 * matches. Returns null when the gap does not exist in the project.
 */
/**
 * Render a gap's draft for a person or an agent, and record it as the gap's
 * `gap-draft` hand-back (`suggested`), once per distinct draft text.
 */
export async function issueScenarioDraft(
  db: DrizzleDB,
  projectId: number,
  gapId: number,
  actor: HandbackActor,
): Promise<ScenarioDraft | null> {
  const draft = await draftScenario(db, projectId, gapId);
  if (!draft) return null;
  await recordOutcome(db, {
    projectId,
    kind: 'gap-draft',
    subjectType: 'gap',
    subjectId: gapId,
    suggestionKey: suggestionHash([draft.text]),
    outcome: 'suggested',
    actor,
  });
  return draft;
}

export async function draftScenario(db: DrizzleDB, projectId: number, gapId: number): Promise<ScenarioDraft | null> {
  const [gap] = await db
    .select()
    .from(scenarioGaps)
    .where(and(eq(scenarioGaps.projectId, projectId), eq(scenarioGaps.id, gapId)));
  if (!gap) return null;

  const subject = subjectFromGapKey(gap.key);
  const evidence = Array.isArray(gap.evidence) ? (gap.evidence as string[]) : [];

  // Nearest test: the gap's own, else a test reaching the subject node.
  let nearestTestId = gap.testCaseId ?? null;
  if (nearestTestId == null && (subject.kind === 'route' || subject.kind === 'page' || subject.kind === 'control')) {
    const [edge] = await db
      .select({ fromKey: graphEdges.fromKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.kind, 'reaches'),
          eq(graphEdges.toKind, subject.kind),
          eq(graphEdges.toKey, subject.key),
          isNull(graphEdges.branch),
        ),
      )
      .limit(1);
    if (edge) nearestTestId = Number(edge.fromKey) || null;
  }

  let nearestTest: ScenarioDraftInput['nearestTest'] = null;
  if (nearestTestId != null) {
    const [tc] = await db
      .select({
        title: testCases.title,
        feature: testCases.feature,
        priority: testCases.priority,
        filePath: testCases.filePath,
      })
      .from(testCases)
      .where(and(eq(testCases.id, nearestTestId), eq(testCases.projectId, projectId)));
    if (tc) {
      nearestTest = {
        title: tc.title,
        feature: tc.feature ?? null,
        priority: tc.priority ?? null,
        location: tc.filePath ?? null,
      };
    }
  }

  // Path: a reached page nearest the subject.
  const path: string[] = [];
  let pageForCatalog: string | null = null;
  if (subject.kind === 'page') {
    pageForCatalog = subject.key;
    path.push(`await page.goto(${q(subject.key)});`);
  } else if (subject.kind === 'control' || subject.kind === 'route') {
    // A page that contains the control, or loads/triggers the route.
    const [edge] = await db
      .select({ pageKey: graphEdges.fromKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          inArray(graphEdges.kind, subject.kind === 'control' ? ['contains'] : ['loads', 'triggers']),
          eq(graphEdges.fromKind, 'page'),
          eq(graphEdges.toKind, subject.kind),
          eq(graphEdges.toKey, subject.key),
          isNull(graphEdges.branch),
        ),
      )
      .limit(1);
    if (edge?.pageKey) {
      pageForCatalog = edge.pageKey;
      path.push(`await page.goto(${q(edge.pageKey)});`);
    }
    if (subject.kind === 'control') {
      const [role, ...nameParts] = subject.key.split(':');
      const name = nameParts.join(':');
      path.push(`await page.getByRole(${q(role ?? 'button')}, { name: ${q(name)} }).click();`);
    }
  }

  // Catalog methods whose url pattern matches the page.
  const catalogMethods: ScenarioDraftInput['catalogMethods'] = [];
  if (pageForCatalog) {
    const fns = await db
      .select({
        module: testFunctions.module,
        name: testFunctions.name,
        receiver: testFunctions.receiver,
        urlPattern: testFunctions.urlPattern,
      })
      .from(testFunctions)
      .where(eq(testFunctions.projectId, projectId));
    for (const f of fns) {
      if (!f.urlPattern || pageForCatalog.includes(f.urlPattern.replace(/\*+/g, ''))) {
        catalogMethods.push({ module: f.module, name: f.name, receiver: f.receiver });
      }
      if (catalogMethods.length >= 5) break;
    }
  }

  return renderScenarioDraft({
    gapTitle: gap.title,
    gapClass: gap.class,
    subject,
    nearestTest,
    path,
    catalogMethods,
    evidence,
  });
}

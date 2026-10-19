/**
 * Client probes and the probe ledger. A probe run replays a passing test with a
 * fault injected at the Playwright route boundary and records whether the test
 * noticed. The plan picks which (test, route) pairs to probe; the results write
 * the `probes` ledger and a `checks` edge per pair, so the "checked" axis of the
 * Test Map stops being a prior and becomes an observation.
 *
 * The selection core is pure so the demo runs it; the loaders read the graph and
 * the ledger and upsert the results.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  graphEdges,
  graphNodes,
  probes,
  projects,
  quarantinedTests,
  testCases,
  testRuns,
  testRunsCases,
} from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { routeKeyWithoutQuery } from '../graph';
import { eligibleExecutionSql, eligibleRunSql } from '../run-eligibility';
import { detectNotHandled, rankFinding, upsertScenarioGaps, type ResilienceSignal } from './scenario-gaps';
import { resolveProjectStates } from './capabilities';
import {
  resolveServerProbeSettings,
  serverProbeAllowed,
  type ServerProbeFault,
  type ServerProbeSettings,
} from '../server-probes';

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The client-side faults a probe run applies through `page.route`. */
export const PROBE_FAULTS = ['status-500', 'empty-body', 'drop-field', 'stale-value', 'slow'] as const;
export type ProbeFault = (typeof PROBE_FAULTS)[number];

export type ProbeOutcome = 'noticed' | 'not-noticed' | 'inconclusive';
export type ProbeLevel = 'client' | 'server';

/** Default per-project probes per run. */
export const DEFAULT_PROBE_BUDGET = 50;

/** An inconclusive (test, route) pair is eligible to be re-probed after this cooldown. */
export const PROBE_INCONCLUSIVE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** The fraction of the budget reserved for server (level-two) items when enabled. */
export const SERVER_PROBE_BUDGET_SHARE = 0.5;

// The lab stamps and their SQL forms are cases of the run eligibility rule.
export {
  FLAKE_LAB_RUN_METADATA_KEY,
  PROBE_RUN_METADATA_KEY,
  isFlakeLabRun,
  isLabRun,
  isProbeRun,
  notLabExecution,
  notLabExecutionInProject,
  notLabRun,
} from '../run-eligibility';

/** One (test, route, fault) pair the plan asks a probe run to apply. */
export interface ProbePlanItem {
  testCaseId: number;
  testTitle: string;
  /** Spec file relative to the project root — disambiguates a leaf title shared across files. */
  filePath: string | null;
  /** Describe-block titles from the outermost down, breaking a title tie within one file. */
  suitePath: string[];
  routeKey: string;
  /** Client faults apply at the Playwright boundary; server faults are signed onto the request. */
  fault: ProbeFault | ServerProbeFault;
  /** `client` (default) mutates the response; `server` signs an X-Piwi-Probe header. */
  level?: ProbeLevel;
  /** The dependency a server dependency fault targets. */
  dependency?: string;
  /** Apply the fault only to the Nth matching request after the first navigation. */
  nth: number;
}

export interface ProbePlan {
  budget: number;
  items: ProbePlanItem[];
}

/** An outcome a probe run reports back for one pair. */
export interface ProbeResultInput {
  testCaseId: number;
  routeKey: string;
  fault: string;
  outcome: ProbeOutcome;
  level?: ProbeLevel;
  applied?: boolean;
  /** How the application handled the fault (server probes): graceful/degraded/unhandled/n/a. */
  handled?: string;
  /** The dependency a server dependency-fault targeted, when the probe was one. */
  dependency?: string | null;
  /** The test's display title, used when a resilience finding is written. */
  testTitle?: string;
  evidence?: unknown;
}

/** A candidate pair the plan chooses among, with the inputs selection needs. */
export interface ProbeCandidate {
  testCaseId: number;
  testTitle: string;
  filePath: string | null;
  suitePath: string[];
  routeKey: string;
  /** Exposure proxy — higher is probed first. */
  exposure: number;
  /** True when a probe already exists for this (test, route). */
  probed: boolean;
  /** True when the test's source changed since that probe ({@link loadTestBodyChangedAt}). */
  changed: boolean;
}

// ── Selection (pure) ─────────────────────────────────────────────────────────

/**
 * Choose the pairs to probe this run: never-probed pairs first, then pairs whose
 * test changed since their last probe, each ordered by exposure. At
 * most one fault per test per run, capped at the budget. The fault rotates
 * deterministically so a project's probes spread across the fault classes.
 */
export function selectProbePlan(candidates: ProbeCandidate[], options: { budget?: number } = {}): ProbePlan {
  const budget = Math.max(0, options.budget ?? DEFAULT_PROBE_BUDGET);
  const eligible = candidates.filter((c) => !c.probed || c.changed);
  eligible.sort((a, b) => {
    // Unprobed (probed === false) before re-probes.
    if (a.probed !== b.probed) return a.probed ? 1 : -1;
    return b.exposure - a.exposure;
  });

  const seenTests = new Set<number>();
  const items: ProbePlanItem[] = [];
  for (const c of eligible) {
    if (items.length >= budget) break;
    if (seenTests.has(c.testCaseId)) continue; // one fault per test per run
    seenTests.add(c.testCaseId);
    items.push({
      testCaseId: c.testCaseId,
      testTitle: c.testTitle,
      filePath: c.filePath,
      suitePath: c.suitePath,
      routeKey: c.routeKey,
      fault: PROBE_FAULTS[items.length % PROBE_FAULTS.length]!,
      nth: 1,
    });
  }
  return { budget, items };
}

/**
 * Choose server-level probe items from the same candidates, gated by the
 * project's server-probe settings: only enabled projects, only allow-listed
 * fault classes and routes, one fault per test, capped at the budget. Dependency
 * faults need a call-site and are planned by {@link selectDependencyProbeItems} —
 * this picks a response-level server fault (status/data/…) allowed for the route.
 */
export function selectServerProbeItems(
  candidates: ProbeCandidate[],
  settings: ServerProbeSettings,
  options: { budget?: number; exclude?: Set<number> } = {},
): ProbePlanItem[] {
  if (!settings.enabled || settings.faults.length === 0) return [];
  const budget = Math.max(0, options.budget ?? DEFAULT_PROBE_BUDGET);
  const exclude = options.exclude ?? new Set<number>();
  const eligible = candidates.filter((c) => !c.probed || c.changed);
  eligible.sort((a, b) => (a.probed !== b.probed ? (a.probed ? 1 : -1) : b.exposure - a.exposure));

  const seen = new Set<number>();
  const items: ProbePlanItem[] = [];
  for (const c of eligible) {
    if (items.length >= budget) break;
    if (exclude.has(c.testCaseId) || seen.has(c.testCaseId)) continue;
    const fault = settings.faults.find((f) => f !== 'dependency' && serverProbeAllowed(settings, c.routeKey, f));
    if (!fault) continue;
    seen.add(c.testCaseId);
    items.push({
      testCaseId: c.testCaseId,
      testTitle: c.testTitle,
      filePath: c.filePath,
      suitePath: c.suitePath,
      routeKey: c.routeKey,
      fault: fault as ServerProbeFault,
      level: 'server',
      nth: 1,
    });
  }
  return items;
}

/**
 * Choose dependency-fault probe items: a `dependency` server fault for a test
 * reaching a route whose handler calls a dependency (`routeDependencies`), gated
 * by the project's settings — `serverProbeAllowed` enforces the fault allow-list,
 * the route allow-list and the state-changing opt-in. One fault per test, capped
 * at the budget, so the `unprobed-dependency` detector can actually clear.
 */
export function selectDependencyProbeItems(
  candidates: ProbeCandidate[],
  routeDependencies: Map<string, string[]>,
  settings: ServerProbeSettings,
  options: { budget?: number; exclude?: Set<number> } = {},
): ProbePlanItem[] {
  if (!settings.enabled || !settings.faults.includes('dependency')) return [];
  const budget = Math.max(0, options.budget ?? DEFAULT_PROBE_BUDGET);
  const exclude = options.exclude ?? new Set<number>();
  const eligible = candidates.filter(
    (c) => (!c.probed || c.changed) && (routeDependencies.get(c.routeKey)?.length ?? 0) > 0,
  );
  eligible.sort((a, b) => (a.probed !== b.probed ? (a.probed ? 1 : -1) : b.exposure - a.exposure));

  const seen = new Set<number>();
  const items: ProbePlanItem[] = [];
  for (const c of eligible) {
    if (items.length >= budget) break;
    if (exclude.has(c.testCaseId) || seen.has(c.testCaseId)) continue;
    if (!serverProbeAllowed(settings, c.routeKey, 'dependency')) continue;
    const dependency = routeDependencies.get(c.routeKey)?.[0];
    if (!dependency) continue;
    seen.add(c.testCaseId);
    items.push({
      testCaseId: c.testCaseId,
      testTitle: c.testTitle,
      filePath: c.filePath,
      suitePath: c.suitePath,
      routeKey: c.routeKey,
      fault: 'dependency',
      level: 'server',
      dependency,
      nth: 1,
    });
  }
  return items;
}

// ── Loaders + orchestration (impure) ─────────────────────────────────────────

/** The step categories that come from the test's own code. */
const BODY_STEP_CATEGORIES = new Set(['expect', 'pw:api', 'test.step']);

/**
 * What a test's source looks like from one passing execution: the distinct
 * `file:line:col` its steps ran from. An edit to the test or a helper it calls
 * changes it; a tag, owner or annotation change does not, nor does a loop
 * running a different number of times. Null when the execution recorded no
 * step location.
 */
export function testBodySignature(steps: unknown): string | null {
  if (!Array.isArray(steps)) return null;
  const locations = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const { category, location } = step as { category?: unknown; location?: unknown };
    if (typeof category !== 'string' || !BODY_STEP_CATEGORIES.has(category)) continue;
    if (typeof location === 'string' && location) locations.add(location);
  }
  return locations.size > 0 ? [...locations].sort().join('\n') : null;
}

/** Passing executions read per test to find when its source last changed. */
const BODY_HISTORY_EXECUTIONS = 20;

/**
 * When each test's source last changed, epoch ms: the oldest of its latest
 * passing executions (outside lab runs, bisect steps and reproductions) that
 * share the newest execution's {@link testBodySignature}, when an older one
 * differs. A test whose recent
 * executions all agree, or that recorded no step locations, is absent.
 */
export async function loadTestBodyChangedAt(db: DrizzleDB, testCaseIds: number[]): Promise<Map<number, number>> {
  const changedAt = new Map<number, number>();
  for (let i = 0; i < testCaseIds.length; i += 200) {
    const ranked = db.$with('ranked').as(
      db
        .select({
          testCaseId: testRunsCases.testCaseId,
          steps: testRunsCases.steps,
          createdAt: testRunsCases.createdAt,
          rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${testRunsCases.testCaseId} ORDER BY ${testRunsCases.createdAt} DESC, ${testRunsCases.id} DESC)`.as(
            'rn',
          ),
        })
        .from(testRunsCases)
        .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
        .where(
          and(
            inArray(testRunsCases.testCaseId, testCaseIds.slice(i, i + 200)),
            eq(testRunsCases.status, 'passed'),
            eligibleRunSql('shared-state'),
          ),
        ),
    );
    const rows = await db
      .with(ranked)
      .select({ testCaseId: ranked.testCaseId, steps: ranked.steps, createdAt: ranked.createdAt, rn: ranked.rn })
      .from(ranked)
      .where(sql`${ranked.rn} <= ${BODY_HISTORY_EXECUTIONS}`);

    // Newest first within each test.
    rows.sort((a, b) => Number(a.rn) - Number(b.rn));
    const byTest = new Map<number, Array<{ steps: unknown; createdAt: unknown }>>();
    for (const row of rows) {
      const list = byTest.get(row.testCaseId) ?? [];
      list.push({ steps: typeof row.steps === 'string' ? safeJson(row.steps) : row.steps, createdAt: row.createdAt });
      byTest.set(row.testCaseId, list);
    }
    for (const [testCaseId, executions] of byTest) {
      const current = testBodySignature(executions[0]!.steps);
      if (current == null) continue;
      let since = executions[0]!.createdAt;
      for (const execution of executions.slice(1)) {
        const signature = testBodySignature(execution.steps);
        if (signature == null) continue;
        if (signature !== current) {
          changedAt.set(testCaseId, epochMs(since));
          break;
        }
        since = execution.createdAt;
      }
    }
  }
  return changedAt;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function epochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  // SQLite stores `created_at` in seconds.
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : 0;
}

/**
 * Build a probe plan for a project: which passing tests reach which routes, how
 * exposed each route is (its reach count as a popularity proxy), whether the
 * pair was already probed, and whether the test changed since. Canonical rows
 * only — probe runs target the default-branch surface.
 */
export async function buildProbePlan(
  db: DrizzleDB,
  projectId: number,
  options: { budget?: number; serverProbes?: unknown } = {},
): Promise<ProbePlan> {
  // Reach edges test → route (canonical).
  const reachRows = await db
    .select({ fromKey: graphEdges.fromKey, routeKey: graphEdges.toKey })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, 'reaches'),
        eq(graphEdges.toKind, 'route'),
        isNull(graphEdges.branch),
      ),
    );
  if (reachRows.length === 0) return { budget: options.budget ?? DEFAULT_PROBE_BUDGET, items: [] };

  // Route popularity: how many distinct tests reach each route → exposure proxy.
  const routeReach = new Map<string, Set<number>>();
  for (const r of reachRows) {
    const id = Number(r.fromKey);
    if (!Number.isFinite(id)) continue;
    const set = routeReach.get(r.routeKey) ?? new Set<number>();
    set.add(id);
    routeReach.set(r.routeKey, set);
  }

  const testIds = [...new Set(reachRows.map((r) => Number(r.fromKey)).filter((n) => Number.isFinite(n)))];
  const testMeta = new Map<number, { title: string; filePath: string; suitePath: string[] }>();
  for (let i = 0; i < testIds.length; i += 200) {
    const rows = await db
      .select({
        id: testCases.id,
        title: testCases.title,
        filePath: testCases.filePath,
        suitePath: testCases.suitePath,
      })
      .from(testCases)
      .where(inArray(testCases.id, testIds.slice(i, i + 200)));
    for (const r of rows) {
      // `suite_path` is stored as a \x1f-delimited string; split it back to the array the plan carries.
      const suitePath = r.suitePath ? r.suitePath.split('\x1f').filter(Boolean) : [];
      testMeta.set(r.id, { title: r.title, filePath: r.filePath, suitePath });
    }
  }

  // Existing probes: (test, route) → last probedAt and last outcome.
  const existing = await db
    .select({
      testCaseId: probes.testCaseId,
      routeKey: probes.routeKey,
      probedAt: probes.probedAt,
      outcome: probes.outcome,
    })
    .from(probes)
    .where(eq(probes.projectId, projectId));
  const lastProbe = new Map<string, { at: number; outcome: string }>();
  for (const p of existing) {
    if (p.testCaseId == null || !p.routeKey) continue;
    const at = p.probedAt instanceof Date ? p.probedAt.getTime() : Number(p.probedAt) || 0;
    const key = `${p.testCaseId}\x00${p.routeKey}`;
    const prev = lastProbe.get(key);
    if (!prev || at > prev.at) lastProbe.set(key, { at, outcome: p.outcome });
  }

  const probedTests = [...new Set([...lastProbe.keys()].map((key) => Number(key.split('\x00')[0])))].filter((id) =>
    testMeta.has(id),
  );
  const bodyChangedAt = await loadTestBodyChangedAt(db, probedTests);

  // Tests never probed: a failing or quarantined test replays as a false
  // "noticed", so it is dropped from the plan rather than probed.
  const excludedTests = await loadUnprobableTestIds(db, projectId, testIds);

  const now = Date.now();
  const candidates: ProbeCandidate[] = [];
  for (const r of reachRows) {
    const testCaseId = Number(r.fromKey);
    if (!Number.isFinite(testCaseId)) continue;
    if (excludedTests.has(testCaseId)) continue;
    const meta = testMeta.get(testCaseId);
    if (!meta) continue;
    const pairKey = `${testCaseId}\x00${r.routeKey}`;
    const prior = lastProbe.get(pairKey);
    // An inconclusive probe does not block the pair forever: after a cooldown the
    // pair is eligible again, so a fault the server never honored is retried.
    const inconclusiveExpired =
      prior != null && prior.outcome === 'inconclusive' && now - prior.at > PROBE_INCONCLUSIVE_COOLDOWN_MS;
    const probed = prior != null && !inconclusiveExpired;
    candidates.push({
      testCaseId,
      testTitle: meta.title,
      filePath: meta.filePath,
      suitePath: meta.suitePath,
      routeKey: r.routeKey,
      exposure: routeReach.get(r.routeKey)?.size ?? 1,
      probed,
      // Re-probe when the test's source changed after the last probe.
      changed: prior != null && (bodyChangedAt.get(testCaseId) ?? 0) > prior.at,
    });
  }

  const budget = Math.max(0, options.budget ?? DEFAULT_PROBE_BUDGET);
  const settings = resolveServerProbeSettings(options.serverProbes);

  // When server probes are enabled, reserve a share of the budget for the
  // level-two items, so a full client plan can never starve them; any client
  // budget the client plan leaves unused still spills over to the server items.
  const serverShare = settings.enabled ? Math.floor(budget * SERVER_PROBE_BUDGET_SHARE) : 0;
  const clientPlan = selectProbePlan(candidates, { budget: budget - serverShare });
  if (!settings.enabled) return { budget, items: clientPlan.items };

  const claimed = new Set(clientPlan.items.map((i) => i.testCaseId));
  const serverItems = selectServerProbeItems(candidates, settings, {
    budget: budget - clientPlan.items.length,
    exclude: claimed,
  });

  // Dependency probes for routes whose handler calls a dependency (handled-by →
  // handler → calls → dependency), so the unprobed-dependency detector can clear.
  const routeDependencies = await loadRouteDependencies(db, projectId);
  const alreadyClaimed = new Set([...claimed, ...serverItems.map((i) => i.testCaseId)]);
  const dependencyItems = selectDependencyProbeItems(candidates, routeDependencies, settings, {
    budget: budget - clientPlan.items.length - serverItems.length,
    exclude: alreadyClaimed,
  });

  return { budget, items: [...clientPlan.items, ...serverItems, ...dependencyItems] };
}

/**
 * Test cases that must not be probed: a currently-quarantined test, or one whose
 * most recent execution failed or timed out. A probe replays a *passing* test, so
 * probing one of these records a false "noticed". The most recent execution is
 * read from the runs eligible as a baseline, so a lab arm, a bisect step or a
 * reproduction never decides it.
 */
async function loadUnprobableTestIds(db: DrizzleDB, projectId: number, ids: number[]): Promise<Set<number>> {
  const excluded = new Set<number>();
  if (ids.length === 0) return excluded;
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
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
    for (const r of quarantined) excluded.add(r.id);

    const maxRows = await db
      .select({ testCaseId: testRunsCases.testCaseId, maxId: sql<number>`max(${testRunsCases.id})` })
      .from(testRunsCases)
      .where(and(inArray(testRunsCases.testCaseId, slice), eligibleExecutionSql('baseline', testRunsCases.testRunId)))
      .groupBy(testRunsCases.testCaseId);
    const maxIds = maxRows.map((r) => Number(r.maxId)).filter((n) => Number.isFinite(n));
    if (maxIds.length === 0) continue;
    const statuses = await db
      .select({ testCaseId: testRunsCases.testCaseId, status: testRunsCases.status })
      .from(testRunsCases)
      .where(inArray(testRunsCases.id, maxIds));
    for (const r of statuses) {
      if (r.testCaseId == null) continue;
      const s = r.status.toLowerCase();
      if (s === 'failed' || s === 'timedout') excluded.add(r.testCaseId);
    }
  }
  return excluded;
}

/**
 * The probe plan for a project's `GET /probes/plan`, with the level-two server
 * items gated on the project's resolved `server-probes` state: a project that
 * declined the capability, or has no backend for it to be applicable, gets the
 * client plan only. The reporter is not a surface, so the plan itself keeps
 * working whatever the decisions — this only withholds the server items.
 */
export async function buildProbePlanForProject(
  db: DrizzleDB,
  projectId: number,
  options: { budget?: number } = {},
): Promise<ProbePlan> {
  const [project] = await db
    .select({ serverProbes: projects.serverProbes })
    .from(projects)
    .where(eq(projects.id, projectId));
  const serverProbesState = (await resolveProjectStates(db, projectId))['server-probes'];
  const serverProbesOff = serverProbesState === 'declined' || serverProbesState === 'not-applicable';
  return buildProbePlan(db, projectId, {
    budget: options.budget,
    serverProbes: serverProbesOff ? undefined : project?.serverProbes,
  });
}

/**
 * Map each route to the dependencies its handler calls, from the canonical
 * `handled-by` (route → handler) and `calls` (handler → dependency) edges.
 */
async function loadRouteDependencies(db: DrizzleDB, projectId: number): Promise<Map<string, string[]>> {
  const rows = await db
    .select({
      kind: graphEdges.kind,
      fromKind: graphEdges.fromKind,
      fromKey: graphEdges.fromKey,
      toKind: graphEdges.toKind,
      toKey: graphEdges.toKey,
    })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        inArray(graphEdges.kind, ['handled-by', 'calls']),
        isNull(graphEdges.branch),
      ),
    );
  const handlersByRoute = new Map<string, Set<string>>();
  const depsByHandler = new Map<string, Set<string>>();
  for (const e of rows) {
    if (e.kind === 'handled-by' && e.fromKind === 'route' && e.toKind === 'handler') {
      const set = handlersByRoute.get(e.fromKey) ?? new Set<string>();
      set.add(e.toKey);
      handlersByRoute.set(e.fromKey, set);
    } else if (e.kind === 'calls' && e.fromKind === 'handler' && e.toKind === 'dependency') {
      const set = depsByHandler.get(e.fromKey) ?? new Set<string>();
      set.add(e.toKey);
      depsByHandler.set(e.fromKey, set);
    }
  }
  const routeDependencies = new Map<string, string[]>();
  for (const [route, handlers] of handlersByRoute) {
    const deps = new Set<string>();
    for (const h of handlers) for (const d of depsByHandler.get(h) ?? []) deps.add(d);
    if (deps.size > 0) routeDependencies.set(route, [...deps]);
  }
  return routeDependencies;
}

/**
 * Record a probe run's outcomes: one `probes` row per pair (deduped by
 * (project, test, route, fault)) and a refreshed `checks` edge test → route
 * carrying the outcome. A noticed probe is confidence 1, not-noticed 0,
 * inconclusive unscored.
 */
export async function recordProbeResults(
  db: DrizzleDB,
  projectId: number,
  runId: number | null,
  results: ProbeResultInput[],
): Promise<{ recorded: number }> {
  if (results.length === 0) return { recorded: 0 };

  // Only this project's own test cases may be recorded: a reporter key for
  // project A must never write a probe row (or, through it, surface a title) for
  // project B's test.
  const candidateTestIds = [...new Set(results.map((r) => r.testCaseId).filter((n) => Number.isFinite(n)))];
  const ownTestIds = new Set<number>();
  for (let i = 0; i < candidateTestIds.length; i += 200) {
    const rows = await db
      .select({ id: testCases.id })
      .from(testCases)
      .where(and(eq(testCases.projectId, projectId), inArray(testCases.id, candidateTestIds.slice(i, i + 200))));
    for (const r of rows) ownTestIds.add(r.id);
  }

  // The per-project fault allow-list is enforced here too, not only in the
  // planner: a server-level result whose fault the project did not allow-list is
  // dropped, so a crafted result body cannot record an un-allowed server fault.
  const [project] = await db
    .select({ serverProbes: projects.serverProbes })
    .from(projects)
    .where(eq(projects.id, projectId));
  const settings = resolveServerProbeSettings(project?.serverProbes);
  // A result names its route without the query, as the route node does.
  results = results.map((r) => ({ ...r, routeKey: routeKeyWithoutQuery(r.routeKey) }));
  results = results.filter((r) => {
    if (!ownTestIds.has(r.testCaseId)) return false;
    if (r.level === 'server' && !serverProbeAllowed(settings, r.routeKey, r.fault as ServerProbeFault)) return false;
    return true;
  });
  if (results.length === 0) return { recorded: 0 };

  // Resolve route node ids for the checks edges and the ledger's node_id.
  const routeKeys = [...new Set(results.map((r) => r.routeKey))];
  const nodeIdByKey = new Map<string, number>();
  for (let i = 0; i < routeKeys.length; i += 200) {
    const rows = await db
      .select({ id: graphNodes.id, key: graphNodes.key })
      .from(graphNodes)
      .where(
        and(
          eq(graphNodes.projectId, projectId),
          eq(graphNodes.kind, 'route'),
          isNull(graphNodes.branch),
          inArray(graphNodes.key, routeKeys.slice(i, i + 200)),
        ),
      );
    for (const r of rows) nodeIdByKey.set(r.key, r.id);
  }

  // Route exposure: how many distinct tests reach each probed route, a proxy the
  // resilience findings rank by.
  const routeExposure = new Map<string, number>();
  if (routeKeys.length > 0) {
    const reachRows = await db
      .select({ toKey: graphEdges.toKey, fromKey: graphEdges.fromKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.kind, 'reaches'),
          eq(graphEdges.toKind, 'route'),
          isNull(graphEdges.branch),
          inArray(graphEdges.toKey, routeKeys),
        ),
      );
    const byRoute = new Map<string, Set<string>>();
    for (const r of reachRows) {
      const set = byRoute.get(r.toKey) ?? new Set<string>();
      set.add(r.fromKey);
      byRoute.set(r.toKey, set);
    }
    for (const [key, set] of byRoute) routeExposure.set(key, set.size);
  }

  const now = new Date();
  let recorded = 0;
  for (const r of results) {
    const outcome: ProbeOutcome = r.outcome === 'noticed' || r.outcome === 'not-noticed' ? r.outcome : 'inconclusive';
    await db
      .insert(probes)
      .values({
        projectId,
        testCaseId: r.testCaseId,
        nodeId: nodeIdByKey.get(r.routeKey) ?? null,
        routeKey: r.routeKey,
        level: r.level ?? 'client',
        fault: r.fault,
        applied: r.applied ?? true,
        outcome,
        handled: r.handled ?? 'n/a',
        runId,
        evidence: (r.evidence ?? null) as any,
        probedAt: now,
      })
      .onConflictDoUpdate({
        target: [probes.projectId, probes.testCaseId, probes.routeKey, probes.fault],
        set: {
          outcome: sql`excluded.outcome`,
          applied: sql`excluded.applied`,
          handled: sql`excluded.handled`,
          level: sql`excluded.level`,
          nodeId: sql`excluded.node_id`,
          runId: sql`excluded.run_id`,
          evidence: sql`excluded.evidence`,
          probedAt: sql`excluded.probed_at`,
        },
      });
    recorded++;

    // Refresh the checks edge test → route with this outcome.
    const confidence = outcome === 'noticed' ? 1 : outcome === 'not-noticed' ? 0 : null;
    await db
      .insert(graphEdges)
      .values({
        projectId,
        fromKind: 'test',
        fromKey: String(r.testCaseId),
        toKind: 'route',
        toKey: r.routeKey,
        kind: 'checks',
        branch: null,
        confidence,
        origin: 'observed',
        evidence: { fault: r.fault, outcome, level: r.level ?? 'client' } as any,
        firstSeenRunId: runId,
        lastSeenRunId: runId,
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
          confidence: sql`excluded.confidence`,
          evidence: sql`excluded.evidence`,
          lastSeenRunId: sql`excluded.last_seen_run_id`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      });

    // A server dependency probe also checks the dependency node, so an unprobed-
    // dependency gap clears once any test has probed it.
    if (r.dependency) {
      await db
        .insert(graphEdges)
        .values({
          projectId,
          fromKind: 'test',
          fromKey: String(r.testCaseId),
          toKind: 'dependency',
          toKey: r.dependency,
          kind: 'checks',
          branch: null,
          confidence,
          origin: 'observed',
          evidence: { fault: r.fault, outcome, level: r.level ?? 'server', route: r.routeKey } as any,
          firstSeenRunId: runId,
          lastSeenRunId: runId,
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
            confidence: sql`excluded.confidence`,
            evidence: sql`excluded.evidence`,
            lastSeenRunId: sql`excluded.last_seen_run_id`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
    }
  }

  // Resilience findings: a server probe where the application did not handle the
  // fault gracefully, written as scenario_gaps rows ranked by exposure × severity.
  const signals: ResilienceSignal[] = results
    .filter((r) => r.handled === 'degraded' || r.handled === 'unhandled')
    .map((r) => ({
      routeKey: r.routeKey,
      dependency: r.dependency ?? null,
      handled: r.handled as 'degraded' | 'unhandled',
      testTitle: r.testTitle ?? `test ${r.testCaseId}`,
      testCaseId: r.testCaseId,
      exposure: routeExposure.get(r.routeKey) ?? 1,
    }));
  if (signals.length > 0) {
    const findings = detectNotHandled(signals).map((gap, i) => {
      const exposure = signals[i]?.exposure ?? 1;
      // Normalize the reach-count proxy into the [0.1, 1] factor range.
      return rankFinding(gap, Math.min(1, exposure / 10));
    });
    await upsertScenarioGaps(db, projectId, findings, { runId });
  }

  return { recorded };
}

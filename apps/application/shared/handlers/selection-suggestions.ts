/**
 * Selection suggestions — the intelligence layer that *proposes* selections and
 * tags from observed history, never applies them. Everything here reads the same
 * catalog the resolver does, plus per-test route coverage from
 * `network_requests`, and returns candidates with the evidence behind them.
 *
 * Honest by construction: "coverage" is observed behavior (the routes a test
 * actually hit on recent runs), not instrumented code coverage — an
 * approximation, and a good one for smoke's purpose, which is breadth over
 * entry points.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { networkRequests, testCases, testRunsCases } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { loadSelectionCatalog, type CatalogRow } from './selections';
import { eligibleExecutionSql } from '../run-eligibility';
import { locksSpanningTests } from '../selection';
import { lowerPercentile } from '../utils/stats';

/** A proposed tag for one test, with the evidence for it. */
export interface TagSuggestion {
  testCaseId: number;
  title: string;
  filePath: string;
  /** What kind of tag this is. */
  kind: 'slow' | 'feature';
  /** The tag to add (e.g. `slow`, or a feature name like `checkout`). */
  tag: string;
  /** 0–1 — how strong the evidence is. */
  confidence: number;
  /** Human-readable evidence lines. */
  evidence: string[];
}

/** One test picked into a mined smoke suite, with its marginal coverage. */
export interface SmokeCandidate {
  testCaseId: number;
  title: string;
  filePath: string;
  /** New routes this pick added that no earlier pick covered. */
  newRoutes: number;
  /** Cumulative distinct routes covered through this pick. */
  cumulativeRoutes: number;
  /** Cumulative summed average duration through this pick, in ms. */
  cumulativeDurationMs: number;
}

/** A mined smoke suite — the diminishing-returns curve under a time budget. */
export interface SmokeMining {
  budgetMs: number;
  /** Distinct routes reachable by the candidate pool. */
  totalRoutes: number;
  /** Distinct routes the picks cover. */
  coveredRoutes: number;
  /** The picks in order — each buys fewer new routes than the last. */
  picks: SmokeCandidate[];
  /** test_case ids of the picks, ready to save as `{ include: [{ ids }] }`. */
  testCaseIds: number[];
  /**
   * Lock names held by more than one pick — sharding this suite with Playwright's
   * own `--shard` could split them across shards; run it with `piwi run --shard`
   * (lock-aware) instead. Empty when no lock spans two picks.
   */
  splitLocks: string[];
}

export interface SelectionSuggestions {
  tags: TagSuggestion[];
  smoke: SmokeMining | null;
}

/** Default smoke budget when the caller names none — five minutes. */
export const DEFAULT_SMOKE_BUDGET_MS = 5 * 60 * 1000;

/** Minimum pass rate for a test to be trusted in a smoke suite. */
const SMOKE_MIN_PASS_RATE = 0.99;

/** Per-test set of distinct route patterns the test has exercised in runs the selection catalog reads. */
async function loadRouteCoverage(db: DrizzleDB, projectId: number): Promise<Map<number, Set<string>>> {
  const rows = await db
    .select({ testCaseId: testRunsCases.testCaseId, route: networkRequests.normalizedUrl })
    .from(networkRequests)
    .innerJoin(testRunsCases, eq(networkRequests.testRunsCaseId, testRunsCases.id))
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(
      and(
        eq(testCases.projectId, projectId),
        isNotNull(networkRequests.normalizedUrl),
        eligibleExecutionSql('selection-catalog', testRunsCases.testRunId),
      ),
    )
    .groupBy(testRunsCases.testCaseId, networkRequests.normalizedUrl);

  const coverage = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!row.route) continue;
    let set = coverage.get(row.testCaseId);
    if (!set) {
      set = new Set();
      coverage.set(row.testCaseId, set);
    }
    set.add(row.route);
  }
  return coverage;
}

/** The feature family a route belongs to — its first meaningful path segment. */
function routeFamily(route: string): string | null {
  const segments = route.split('/').filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    // Skip generic API prefixes and version/param-looking segments.
    if (lower === 'api' || lower === 'v1' || lower === 'v2' || /^[:*{]/.test(segment) || /^\d/.test(segment)) continue;
    if (segment.length < 2) continue;
    return lower;
  }
  return null;
}

/** Tests markedly slower than the suite's 95th percentile, not already tagged slow. */
function computeSlowSuggestions(catalog: CatalogRow[]): TagSuggestion[] {
  const durations = catalog.map((r) => r.avgDurationMs).filter((d): d is number => d !== null && d > 0);
  if (durations.length === 0) return [];
  const p95 = lowerPercentile(
    durations.sort((a, b) => a - b),
    95,
  );
  if (p95 <= 0) return [];

  const suggestions: TagSuggestion[] = [];
  for (const row of catalog) {
    if (row.avgDurationMs === null || row.avgDurationMs <= p95) continue;
    if (row.tags.some((t) => t.toLowerCase() === 'slow')) continue;
    const ratio = row.avgDurationMs / p95;
    suggestions.push({
      testCaseId: row.id,
      title: row.title,
      filePath: row.filePath,
      kind: 'slow',
      tag: 'slow',
      confidence: Math.min(1, (ratio - 1) / 2),
      evidence: [`averages ${Math.round(row.avgDurationMs)}ms vs the suite's p95 of ${Math.round(p95)}ms`],
    });
  }
  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

/** A dominant route family a test hits but carries no `feature` annotation for. */
function computeFeatureSuggestions(catalog: CatalogRow[], coverage: Map<number, Set<string>>): TagSuggestion[] {
  const suggestions: TagSuggestion[] = [];
  for (const row of catalog) {
    if (row.feature) continue;
    const routes = coverage.get(row.id);
    if (!routes || routes.size < 2) continue;

    const familyCounts = new Map<string, number>();
    for (const route of routes) {
      const family = routeFamily(route);
      if (family) familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    }
    if (familyCounts.size === 0) continue;

    const [topFamily, topCount] = [...familyCounts].sort((a, b) => b[1] - a[1])[0]!;
    const share = topCount / routes.size;
    if (share < 0.6 || topCount < 2) continue;
    if (row.tags.some((t) => t.toLowerCase() === topFamily)) continue;

    const sample = [...routes].filter((r) => routeFamily(r) === topFamily).slice(0, 3);
    suggestions.push({
      testCaseId: row.id,
      title: row.title,
      filePath: row.filePath,
      kind: 'feature',
      tag: topFamily,
      confidence: share,
      evidence: [`${Math.round(share * 100)}% of its routes are under "${topFamily}": ${sample.join(', ')}`],
    });
  }
  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Mine a smoke suite: a greedy weighted set cover over observed route coverage,
 * picking the test that buys the most new routes per unit of time until the
 * budget is spent. The result is the classic diminishing-returns curve — each
 * pick covers fewer new routes than the last.
 */
function mineSmokeSuite(
  catalog: CatalogRow[],
  coverage: Map<number, Set<string>>,
  budgetMs: number,
): SmokeMining | null {
  const candidates = catalog.filter(
    (row) =>
      !row.quarantined &&
      !row.flaky &&
      row.avgDurationMs !== null &&
      row.avgDurationMs > 0 &&
      (row.passRate === null ? false : row.passRate >= SMOKE_MIN_PASS_RATE) &&
      (coverage.get(row.id)?.size ?? 0) > 0,
  );

  const universe = new Set<string>();
  for (const row of candidates) for (const route of coverage.get(row.id) ?? []) universe.add(route);
  if (universe.size === 0) return null;

  const covered = new Set<string>();
  const picks: SmokeCandidate[] = [];
  const remaining = new Set(candidates.map((r) => r.id));
  const byId = new Map(candidates.map((r) => [r.id, r]));
  let cumulativeDurationMs = 0;

  while (remaining.size > 0) {
    let best: { id: number; newRoutes: number; perMs: number } | null = null;
    for (const id of remaining) {
      const row = byId.get(id)!;
      const dur = row.avgDurationMs!;
      if (cumulativeDurationMs + dur > budgetMs) continue;
      let fresh = 0;
      for (const route of coverage.get(id) ?? []) if (!covered.has(route)) fresh++;
      if (fresh === 0) continue;
      const perMs = fresh / dur;
      // Most new routes wins; break ties by coverage-per-millisecond.
      if (!best || fresh > best.newRoutes || (fresh === best.newRoutes && perMs > best.perMs)) {
        best = { id, newRoutes: fresh, perMs };
      }
    }
    if (!best) break;

    const row = byId.get(best.id)!;
    for (const route of coverage.get(best.id) ?? []) covered.add(route);
    cumulativeDurationMs += row.avgDurationMs!;
    picks.push({
      testCaseId: row.id,
      title: row.title,
      filePath: row.filePath,
      newRoutes: best.newRoutes,
      cumulativeRoutes: covered.size,
      cumulativeDurationMs,
    });
    remaining.delete(best.id);
  }

  return {
    budgetMs,
    totalRoutes: universe.size,
    coveredRoutes: covered.size,
    picks,
    testCaseIds: picks.map((p) => p.testCaseId),
    splitLocks: locksSpanningTests(picks.map((p) => byId.get(p.testCaseId)!)),
  };
}

/** Compute every suggestion for a project: slow, feature, and a mined smoke suite. */
export async function getSelectionSuggestions(
  db: DrizzleDB,
  projectId: number,
  options: { budgetMs?: number } = {},
): Promise<SelectionSuggestions> {
  const catalog = await loadSelectionCatalog(db, projectId);
  const coverage = await loadRouteCoverage(db, projectId);
  const budgetMs = options.budgetMs && options.budgetMs > 0 ? options.budgetMs : DEFAULT_SMOKE_BUDGET_MS;

  return {
    tags: [...computeSlowSuggestions(catalog), ...computeFeatureSuggestions(catalog, coverage)],
    smoke: mineSmokeSuite(catalog, coverage, budgetMs),
  };
}

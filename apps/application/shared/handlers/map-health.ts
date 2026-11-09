/**
 * Map health: how complete a project's Test Map is, input by input. Each input
 * is optional, and a detector that reads one stays silent without it, so a quiet
 * Gaps view can mean a covered application or a map that cannot see. Each row
 * counts what the input holds against what it could hold, and names the
 * detectors it wakes; the Map view adds the setup step behind each.
 */
import { and, count, countDistinct, eq, gte, inArray, isNull, ne } from 'drizzle-orm';
import { graphEdges, graphNodes, locatorUsages, testFunctions } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { decidesCheck } from './probes';

/** The inputs the panel lists, in its order. */
export type MapHealthInput = 'inventory' | 'locator-pages' | 'handlers' | 'probes' | 'declared' | 'changes' | 'catalog';

export interface MapHealthRow {
  id: MapHealthInput;
  /** What the input holds: pages with an inventory, routes with a handler, declared routes. */
  have: number;
  /** What it could hold, or null for an input counted on its own (declared routes, catalog methods). */
  of: number | null;
  /** The detectors that read it. */
  wakes: string[];
  /** The input also ranks gaps: churn and escape history behind a route's handler. */
  ranks?: boolean;
}

/** The detectors each input wakes. */
const WAKES: Record<MapHealthInput, string[]> = {
  inventory: ['control-nobody-exercises', 'reachable-unvisited'],
  'locator-pages': ['assertion-light', 'single-covering-test'],
  handlers: ['unprobed-dependency', 'not-handled'],
  probes: ['not-noticed', 'not-handled'],
  declared: ['declared-never-hit', 'success-only'],
  changes: ['changed-unreached'],
  catalog: ['catalog-method-no-test-calls'],
};

/** How long a locator use counts, as for control reach. */
const LOCATOR_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/** Distinct `to_key`s of a project's canonical edges of one kind into one node kind. */
async function edgeTargets(db: DrizzleDB, projectId: number, kind: string, toKind: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ key: graphEdges.toKey })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, kind),
        eq(graphEdges.toKind, toKind),
        eq(graphEdges.fromKind, 'test'),
        isNull(graphEdges.branch),
      ),
    );
  return new Set(rows.map((r) => r.key));
}

/** The routes a probe decided: a canonical `checks` edge whose outcome `decidesCheck`. */
async function decidedCheckRoutes(db: DrizzleDB, projectId: number): Promise<Set<string>> {
  const rows = await db
    .select({ key: graphEdges.toKey, evidence: graphEdges.evidence })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, 'checks'),
        eq(graphEdges.toKind, 'route'),
        eq(graphEdges.fromKind, 'test'),
        isNull(graphEdges.branch),
      ),
    );
  const routes = new Set<string>();
  for (const r of rows) {
    const evidence = (r.evidence ?? null) as { outcome?: string; fault?: string } | null;
    if (decidesCheck(evidence?.outcome, evidence?.fault)) routes.add(r.key);
  }
  return routes;
}

/** Distinct `from_key`s of a project's canonical edges of one kind out of one node kind. */
async function edgeSources(db: DrizzleDB, projectId: number, kind: string, fromKind: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ key: graphEdges.fromKey })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, kind),
        eq(graphEdges.fromKind, fromKind),
        isNull(graphEdges.branch),
      ),
    );
  return new Set(rows.map((r) => r.key));
}

const within = (keys: Set<string>, of: Set<string>) => [...keys].filter((k) => of.has(k)).length;

/**
 * The map's completeness per input, on the default branch: reached pages with
 * an inventory, tests whose locator calls name their page, observed routes with
 * a handler, reached routes a probe checked, then the declared routes and pages,
 * the recorded diffs and the catalog's methods, each counted on its own.
 */
export async function getMapHealth(db: DrizzleDB, projectId: number, now: Date = new Date()): Promise<MapHealthRow[]> {
  const live = await db
    .select({ kind: graphNodes.kind, key: graphNodes.key, origin: graphNodes.origin })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.projectId, projectId),
        isNull(graphNodes.branch),
        isNull(graphNodes.prunedAt),
        inArray(graphNodes.kind, ['page', 'route']),
      ),
    );
  const declared = live.filter((n) => n.origin === 'manifest' || n.origin === 'openapi');
  const liveKeys = (kind: string) => new Set(live.filter((n) => n.kind === kind).map((n) => n.key));
  const reached = async (kind: string) => {
    const keys = liveKeys(kind);
    return new Set([...(await edgeTargets(db, projectId, 'reaches', kind))].filter((k) => keys.has(k)));
  };
  const reachedPages = await reached('page');
  const reachedRoutes = await reached('route');
  const observedRoutes = new Set(
    live.filter((n) => n.kind === 'route' && n.origin !== 'manifest' && n.origin !== 'openapi').map((n) => n.key),
  );

  const locatorTests = await db
    .select({ tests: countDistinct(locatorUsages.testCaseId) })
    .from(locatorUsages)
    .where(
      and(
        eq(locatorUsages.projectId, projectId),
        eq(locatorUsages.branch, ''),
        gte(locatorUsages.lastSeenAt, new Date(now.getTime() - LOCATOR_MAX_AGE_MS)),
      ),
    );
  const pagedTests = await db
    .select({ tests: countDistinct(locatorUsages.testCaseId) })
    .from(locatorUsages)
    .where(
      and(
        eq(locatorUsages.projectId, projectId),
        eq(locatorUsages.branch, ''),
        ne(locatorUsages.page, ''),
        gte(locatorUsages.lastSeenAt, new Date(now.getTime() - LOCATOR_MAX_AGE_MS)),
      ),
    );
  const commits = await db
    .select({ commits: countDistinct(graphEdges.fromKey) })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, 'changes'),
        eq(graphEdges.fromKind, 'commit'),
        isNull(graphEdges.branch),
      ),
    );
  const catalog = await db
    .select({ methods: count() })
    .from(testFunctions)
    .where(and(eq(testFunctions.projectId, projectId), ne(testFunctions.kind, 'fixture')));

  const rows: Array<Omit<MapHealthRow, 'wakes'>> = [
    {
      id: 'inventory',
      have: within(reachedPages, await edgeSources(db, projectId, 'contains', 'page')),
      of: reachedPages.size,
    },
    { id: 'locator-pages', have: Number(pagedTests[0]?.tests ?? 0), of: Number(locatorTests[0]?.tests ?? 0) },
    {
      id: 'handlers',
      have: within(observedRoutes, await edgeSources(db, projectId, 'handled-by', 'route')),
      of: observedRoutes.size,
      ranks: true,
    },
    {
      id: 'probes',
      have: within(reachedRoutes, await decidedCheckRoutes(db, projectId)),
      of: reachedRoutes.size,
    },
    { id: 'declared', have: declared.length, of: null },
    { id: 'changes', have: Number(commits[0]?.commits ?? 0), of: null, ranks: true },
    { id: 'catalog', have: Number(catalog[0]?.methods ?? 0), of: null },
  ];
  return rows.map((row) => ({ ...row, wakes: WAKES[row.id] }));
}

/**
 * A page load is its page's own node, never a route node (`isPageLoad`). The
 * route nodes that page loads alone wrote into a stored graph are retired once
 * per instance, project by project under the project's graph lock: each is
 * pruned as an unseen node is and loses its edges, and the next recompute
 * closes the gaps it held. A declared route stays, whatever reached it.
 */
import { and, count, eq, inArray, isNull, or } from 'drizzle-orm';
import { graphEdges, graphNodes, networkRequests, testRuns } from '../database/schema';
import { isPageLoad, routeNodeKey } from '#shared/graph';
import type { DrizzleDB } from '#shared/handlers/db';
import { runOnce } from './app-settings';
import { withProjectGraphLock } from './project-graph-lock';

/** App setting that claims the retirement and records it done, so it runs once per instance. */
export const PAGE_LOAD_ROUTES_RETIRED_SETTING = 'graph_page_load_routes_retired_at';

/** What the retirement changed. */
export interface PageLoadRouteRetirement {
  nodes: number;
  edges: number;
}

const BATCH = 100;

/** The route keys a project's stored requests reached by page loads alone, never by a call. */
export async function pageLoadOnlyRouteKeys(db: DrizzleDB, projectId: number): Promise<Set<string>> {
  const rows = await db
    .select({
      method: networkRequests.method,
      normalizedUrl: networkRequests.normalizedUrl,
      resourceType: networkRequests.resourceType,
      n: count(),
    })
    .from(networkRequests)
    .innerJoin(testRuns, eq(testRuns.id, networkRequests.testRunId))
    .where(eq(testRuns.projectId, projectId))
    .groupBy(networkRequests.method, networkRequests.normalizedUrl, networkRequests.resourceType);
  const loads = new Set<string>();
  const calls = new Set<string>();
  for (const r of rows) {
    if (!r.normalizedUrl) continue;
    (isPageLoad(r.resourceType) ? loads : calls).add(routeNodeKey(r.method, r.normalizedUrl));
  }
  return new Set([...loads].filter((key) => !calls.has(key)));
}

/** Retire one project's page-load route nodes, on every branch. */
export async function retireProjectPageLoadRoutes(db: DrizzleDB, projectId: number): Promise<PageLoadRouteRetirement> {
  const keys = await pageLoadOnlyRouteKeys(db, projectId);
  if (keys.size === 0) return { nodes: 0, edges: 0 };
  const routes = await db
    .select({ id: graphNodes.id, key: graphNodes.key, origin: graphNodes.origin, attrs: graphNodes.attrs })
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, 'route'), isNull(graphNodes.prunedAt)));
  const retired = routes.filter(
    (n) =>
      keys.has(n.key) &&
      n.origin !== 'manifest' &&
      n.origin !== 'openapi' &&
      (n.attrs as { declared?: unknown } | null)?.declared !== true,
  );
  if (retired.length === 0) return { nodes: 0, edges: 0 };

  const now = new Date();
  const ids = retired.map((n) => n.id);
  for (let i = 0; i < ids.length; i += BATCH) {
    await db
      .update(graphNodes)
      .set({ prunedAt: now })
      .where(inArray(graphNodes.id, ids.slice(i, i + BATCH)));
  }

  const routeKeys = [...new Set(retired.map((n) => n.key))];
  let edges = 0;
  for (let i = 0; i < routeKeys.length; i += BATCH) {
    const slice = routeKeys.slice(i, i + BATCH);
    const deleted = await db
      .delete(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          or(
            and(eq(graphEdges.fromKind, 'route'), inArray(graphEdges.fromKey, slice)),
            and(eq(graphEdges.toKind, 'route'), inArray(graphEdges.toKey, slice)),
          ),
        ),
      )
      .returning({ id: graphEdges.id });
    edges += deleted.length;
  }
  return { nodes: retired.length, edges };
}

/** Retire the page-load route nodes of every project that holds route nodes. */
export async function retirePageLoadRoutes(db: DrizzleDB): Promise<PageLoadRouteRetirement> {
  const total: PageLoadRouteRetirement = { nodes: 0, edges: 0 };
  const projects = await db
    .selectDistinct({ projectId: graphNodes.projectId })
    .from(graphNodes)
    .where(and(eq(graphNodes.kind, 'route'), isNull(graphNodes.prunedAt)));
  for (const { projectId } of projects) {
    const one = await withProjectGraphLock(projectId, () => retireProjectPageLoadRoutes(db, projectId));
    total.nodes += one.nodes;
    total.edges += one.edges;
  }
  return total;
}

/** Run {@link retirePageLoadRoutes} once per instance; null when another process has it or it is done. */
export async function retirePageLoadRoutesOnce(db: DrizzleDB): Promise<PageLoadRouteRetirement | null> {
  return runOnce(db, PAGE_LOAD_ROUTES_RETIRED_SETTING, () => retirePageLoadRoutes(db));
}

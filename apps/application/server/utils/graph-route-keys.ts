/**
 * One endpoint, one route node: a route key holds no query (`routeNodeKey`). A
 * key stored with one (`GET /api/users?page=…` beside `GET /api/users?role=…`)
 * is rewritten once per instance, project by project under the project's graph
 * lock: the nodes and edges that then share a key are merged, the probe ledger
 * and the snooze signatures follow, and the gap ledger keeps every verdict.
 */
import { and, eq, isNull, like, or } from 'drizzle-orm';
import { appSettings, graphEdges, graphNodes, probes, scenarioGaps } from '../database/schema';
import { routeKeyWithoutQuery } from '#shared/graph';
import type { DrizzleDB } from '#shared/handlers/db';
import { deleteAppSetting, setAppSetting } from './app-settings';
import { withProjectGraphLock } from './project-graph-lock';

/** App setting that claims the rewrite and records it done, so it runs once per instance. */
export const ROUTE_KEYS_WITHOUT_QUERY_SETTING = 'graph_route_keys_without_query_at';

/** A claim older than this belongs to a process that stopped before finishing; another may take it over. */
const STALE_CLAIM_MS = 60 * 60 * 1000;

/** What the rewrite changed, per table. */
export interface RouteKeyRewrite {
  nodes: number;
  edges: number;
  probes: number;
  gaps: number;
}

/** A query names no `:` once encoded, so it ends at the next `:` (a gap key's status suffix) or the end. */
function withoutQuery(routePart: string): string {
  return routePart.replace(/\?[^:]*/, '');
}

/**
 * A gap key with the query taken out of the route it names, for the forms that
 * name one: a bare route key, `route:<route>` (with an optional `:<status>`), and
 * `dependency:<name> @ <route>`. Any other key is returned as it is, so a
 * control named `Need help?` keeps its question mark.
 */
export function gapKeyWithoutRouteQuery(key: string): string {
  if (key.startsWith('dependency:')) {
    const at = key.indexOf(' @ ');
    return at < 0 ? key : `${key.slice(0, at + 3)}${withoutQuery(key.slice(at + 3))}`;
  }
  if (key.startsWith('route:')) return `route:${withoutQuery(key.slice('route:'.length))}`;
  if (/^[A-Z]+ \//.test(key)) return withoutQuery(key);
  return key;
}

/**
 * A snooze signature with the query taken out of every route endpoint it lists,
 * identical lines counted once. A rename alone then leaves the signature as the
 * subject's edges read after it; a merge that brings the subject edges of its
 * other variants changes them, and wakes a gap snoozed until the node changes.
 */
export function signatureWithoutRouteQuery(signature: string): string {
  const [, ...lines] = signature.split('\n');
  const rewritten = [
    ...new Set(lines.map((line) => line.replace(/(route:[A-Z]+ [^>|?]*)\?[^>|]*/g, '$1')).filter(Boolean)),
  ].sort();
  return `${rewritten.length}\n${rewritten.join('\n')}`;
}

const earliest = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));
const latest = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));
const later = (a: Date, b: Date) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b);

/** How deliberate a gap's status is, for the row a set of duplicates keeps: a verdict first, then the queue. */
const STATUS_RANK: Record<string, number> = { dismissed: 5, accepted: 4, snoozed: 3, open: 2, closed: 1 };

/**
 * Run one row's rewrite, and once more if it fails: a run ingested meanwhile may
 * have written the key the row was renamed to, and the second pass merges into it.
 */
async function twice(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch {
    await step();
  }
}

/** The projects holding a route key with a query, in any table the rewrite reads. */
async function projectsToRewrite(db: DrizzleDB): Promise<number[]> {
  const ids = new Set<number>();
  const add = (rows: Array<{ projectId: number }>) => rows.forEach((r) => ids.add(r.projectId));
  add(
    await db
      .selectDistinct({ projectId: graphNodes.projectId })
      .from(graphNodes)
      .where(and(eq(graphNodes.kind, 'route'), like(graphNodes.key, '%?%'))),
  );
  add(
    await db
      .selectDistinct({ projectId: graphEdges.projectId })
      .from(graphEdges)
      .where(
        or(
          and(eq(graphEdges.fromKind, 'route'), like(graphEdges.fromKey, '%?%')),
          and(eq(graphEdges.toKind, 'route'), like(graphEdges.toKey, '%?%')),
          and(eq(graphEdges.kind, 'checks'), eq(graphEdges.toKind, 'dependency')),
        ),
      ),
  );
  add(await db.selectDistinct({ projectId: probes.projectId }).from(probes).where(like(probes.routeKey, '%?%')));
  add(
    await db
      .selectDistinct({ projectId: scenarioGaps.projectId })
      .from(scenarioGaps)
      .where(or(like(scenarioGaps.key, '%?%'), like(scenarioGaps.snoozedAtSignature, '%?%'))),
  );
  return [...ids].sort((a, b) => a - b);
}

/**
 * Rewrite one project's route keys that hold a query. A node whose new key
 * another node already has is merged into it: the earliest first sighting, the
 * latest last one, live if either is, the survivor's attributes first, and its
 * probes moved over. An edge is merged the same way. A probe whose new key
 * collides keeps the newer outcome. Of a gap and its duplicates, the row with
 * the most deliberate status holds the new key; the others keep their own key
 * and their verdict, and an open, snoozed or accepted one closes, with no run
 * credited.
 */
export async function rewriteProjectRouteKeys(db: DrizzleDB, projectId: number): Promise<RouteKeyRewrite> {
  const out: RouteKeyRewrite = { nodes: 0, edges: 0, probes: 0, gaps: 0 };

  const nodes = await db
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, 'route'), like(graphNodes.key, '%?%')));
  for (const node of nodes) {
    const key = routeKeyWithoutQuery(node.key);
    await twice(async () => {
      const [survivor] = await db
        .select()
        .from(graphNodes)
        .where(
          and(
            eq(graphNodes.projectId, projectId),
            eq(graphNodes.kind, 'route'),
            eq(graphNodes.key, key),
            node.branch == null ? isNull(graphNodes.branch) : eq(graphNodes.branch, node.branch),
          ),
        );
      if (!survivor) {
        await db.update(graphNodes).set({ key }).where(eq(graphNodes.id, node.id));
        return;
      }
      await db
        .update(graphNodes)
        .set({
          firstSeenRunId: earliest(survivor.firstSeenRunId, node.firstSeenRunId),
          lastSeenRunId: latest(survivor.lastSeenRunId, node.lastSeenRunId),
          lastSeenAt: later(survivor.lastSeenAt, node.lastSeenAt),
          prunedAt: survivor.prunedAt && node.prunedAt ? later(survivor.prunedAt, node.prunedAt) : null,
          attrs: survivor.attrs ?? node.attrs,
          usage30d: latest(survivor.usage30d, node.usage30d),
        })
        .where(eq(graphNodes.id, survivor.id));
      await db.update(probes).set({ nodeId: survivor.id }).where(eq(probes.nodeId, node.id));
      await db.delete(graphNodes).where(eq(graphNodes.id, node.id));
    });
    out.nodes++;
  }

  const edges = await db
    .select()
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        or(
          and(eq(graphEdges.fromKind, 'route'), like(graphEdges.fromKey, '%?%')),
          and(eq(graphEdges.toKind, 'route'), like(graphEdges.toKey, '%?%')),
        ),
      ),
    );
  for (const edge of edges) {
    const fromKey = edge.fromKind === 'route' ? routeKeyWithoutQuery(edge.fromKey) : edge.fromKey;
    const toKey = edge.toKind === 'route' ? routeKeyWithoutQuery(edge.toKey) : edge.toKey;
    await twice(async () => {
      const [survivor] = await db
        .select()
        .from(graphEdges)
        .where(
          and(
            eq(graphEdges.projectId, projectId),
            eq(graphEdges.fromKind, edge.fromKind),
            eq(graphEdges.fromKey, fromKey),
            eq(graphEdges.kind, edge.kind),
            eq(graphEdges.toKind, edge.toKind),
            eq(graphEdges.toKey, toKey),
            edge.branch == null ? isNull(graphEdges.branch) : eq(graphEdges.branch, edge.branch),
          ),
        );
      if (!survivor) {
        await db.update(graphEdges).set({ fromKey, toKey }).where(eq(graphEdges.id, edge.id));
        return;
      }
      await db
        .update(graphEdges)
        .set({
          firstSeenRunId: earliest(survivor.firstSeenRunId, edge.firstSeenRunId),
          lastSeenRunId: latest(survivor.lastSeenRunId, edge.lastSeenRunId),
          lastSeenAt: later(survivor.lastSeenAt, edge.lastSeenAt),
          confidence: latest(survivor.confidence, edge.confidence),
        })
        .where(eq(graphEdges.id, survivor.id));
      await db.delete(graphEdges).where(eq(graphEdges.id, edge.id));
    });
    out.edges++;
  }

  // A dependency's checks edge names the route it was probed through in its evidence.
  const dependencyChecks = await db
    .select({ id: graphEdges.id, evidence: graphEdges.evidence })
    .from(graphEdges)
    .where(
      and(eq(graphEdges.projectId, projectId), eq(graphEdges.kind, 'checks'), eq(graphEdges.toKind, 'dependency')),
    );
  for (const edge of dependencyChecks) {
    const evidence = edge.evidence as { route?: unknown } | null;
    if (typeof evidence?.route !== 'string' || !evidence.route.includes('?')) continue;
    await db
      .update(graphEdges)
      .set({ evidence: { ...evidence, route: routeKeyWithoutQuery(evidence.route) } as never })
      .where(eq(graphEdges.id, edge.id));
    out.edges++;
  }

  const probeRows = await db
    .select()
    .from(probes)
    .where(and(eq(probes.projectId, projectId), like(probes.routeKey, '%?%')));
  for (const probe of probeRows) {
    const routeKey = routeKeyWithoutQuery(probe.routeKey!);
    await twice(async () => {
      const [other] = await db
        .select({ id: probes.id, probedAt: probes.probedAt })
        .from(probes)
        .where(
          and(
            eq(probes.projectId, projectId),
            probe.testCaseId == null ? isNull(probes.testCaseId) : eq(probes.testCaseId, probe.testCaseId),
            eq(probes.routeKey, routeKey),
            eq(probes.fault, probe.fault),
          ),
        );
      if (other && later(other.probedAt, probe.probedAt) === other.probedAt) {
        await db.delete(probes).where(eq(probes.id, probe.id));
        return;
      }
      if (other) await db.delete(probes).where(eq(probes.id, other.id));
      await db.update(probes).set({ routeKey }).where(eq(probes.id, probe.id));
    });
    out.probes++;
  }

  const gapColumns = {
    id: scenarioGaps.id,
    detector: scenarioGaps.detector,
    key: scenarioGaps.key,
    status: scenarioGaps.status,
    updatedAt: scenarioGaps.updatedAt,
  };
  const gapRows = await db
    .select(gapColumns)
    .from(scenarioGaps)
    .where(and(eq(scenarioGaps.projectId, projectId), like(scenarioGaps.key, '%?%')));
  const groups = new Map<string, typeof gapRows>();
  for (const gap of gapRows) {
    const key = gapKeyWithoutRouteQuery(gap.key);
    if (key === gap.key) continue;
    const id = `${gap.detector}\x00${key}`;
    groups.set(id, [...(groups.get(id) ?? []), gap]);
  }
  const now = new Date();
  for (const [id, rows] of groups) {
    const [detector, key] = id.split('\x00') as [string, string];
    const [holder] = await db
      .select(gapColumns)
      .from(scenarioGaps)
      .where(
        and(eq(scenarioGaps.projectId, projectId), eq(scenarioGaps.detector, detector), eq(scenarioGaps.key, key)),
      );
    const ranked = [...rows, ...(holder ? [holder] : [])].sort(
      (a, b) =>
        (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) ||
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const keeper = ranked[0]!;
    if (keeper !== holder) {
      // The holder gives the key up to the more deliberate row, taking that row's old key.
      if (holder) {
        await db
          .update(scenarioGaps)
          .set({ key: `${keeper.key} (moving)` })
          .where(eq(scenarioGaps.id, keeper.id));
        await db.update(scenarioGaps).set({ key: keeper.key }).where(eq(scenarioGaps.id, holder.id));
      }
      await db.update(scenarioGaps).set({ key }).where(eq(scenarioGaps.id, keeper.id));
    }
    for (const gap of ranked) {
      if (gap === keeper || !['open', 'snoozed', 'accepted'].includes(gap.status)) continue;
      await db
        .update(scenarioGaps)
        .set({ status: 'closed', closedAt: now, closedByRunId: null, updatedAt: now })
        .where(eq(scenarioGaps.id, gap.id));
    }
    out.gaps += rows.length;
  }

  const snoozed = await db
    .select({ id: scenarioGaps.id, signature: scenarioGaps.snoozedAtSignature })
    .from(scenarioGaps)
    .where(and(eq(scenarioGaps.projectId, projectId), like(scenarioGaps.snoozedAtSignature, '%?%')));
  for (const gap of snoozed) {
    const signature = signatureWithoutRouteQuery(gap.signature!);
    if (signature !== gap.signature) {
      await db.update(scenarioGaps).set({ snoozedAtSignature: signature }).where(eq(scenarioGaps.id, gap.id));
    }
  }

  return out;
}

/** Every project's rewrite, one project at a time under its graph lock. */
export async function rewriteQueryRouteKeys(db: DrizzleDB): Promise<RouteKeyRewrite> {
  const total: RouteKeyRewrite = { nodes: 0, edges: 0, probes: 0, gaps: 0 };
  for (const projectId of await projectsToRewrite(db)) {
    const one = await withProjectGraphLock(projectId, () => rewriteProjectRouteKeys(db, projectId));
    total.nodes += one.nodes;
    total.edges += one.edges;
    total.probes += one.probes;
    total.gaps += one.gaps;
  }
  return total;
}

/**
 * Claim the rewrite for this process: the first to write the setting runs it,
 * and a process finding a fresh claim or a finished rewrite skips it. A claim
 * left by a process that stopped is taken over once it is stale.
 */
async function claimRewrite(db: DrizzleDB): Promise<boolean> {
  const claim = { state: 'running', at: new Date().toISOString() };
  const inserted = await db
    .insert(appSettings)
    .values({ key: ROUTE_KEYS_WITHOUT_QUERY_SETTING, value: claim, updatedAt: new Date() })
    .onConflictDoNothing()
    .returning({ key: appSettings.key });
  if (inserted.length > 0) return true;
  const [row] = await db
    .select({ value: appSettings.value, updatedAt: appSettings.updatedAt })
    .from(appSettings)
    .where(eq(appSettings.key, ROUTE_KEYS_WITHOUT_QUERY_SETTING));
  const value = row?.value as { state?: unknown } | string | null | undefined;
  if (typeof value !== 'object' || value?.state !== 'running') return false;
  if (Date.now() - new Date(row!.updatedAt).getTime() < STALE_CLAIM_MS) return false;
  // Take the stale claim over; the write is conditional, so of two processes doing so at once one alone wins.
  await db
    .update(appSettings)
    .set({ value: claim, updatedAt: new Date() })
    .where(and(eq(appSettings.key, ROUTE_KEYS_WITHOUT_QUERY_SETTING), eq(appSettings.updatedAt, row!.updatedAt)));
  const [after] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, ROUTE_KEYS_WITHOUT_QUERY_SETTING));
  return (after?.value as { at?: unknown } | null)?.at === claim.at;
}

/** Run {@link rewriteQueryRouteKeys} once per instance; null when another process has it or it is done. */
export async function rewriteQueryRouteKeysOnce(db: DrizzleDB): Promise<RouteKeyRewrite | null> {
  if (!(await claimRewrite(db))) return null;
  let rewrite: RouteKeyRewrite;
  try {
    rewrite = await rewriteQueryRouteKeys(db);
  } catch (err) {
    // Release the claim, so the next start tries again.
    await deleteAppSetting(db, ROUTE_KEYS_WITHOUT_QUERY_SETTING).catch(() => {});
    throw err;
  }
  await setAppSetting(db, ROUTE_KEYS_WITHOUT_QUERY_SETTING, { state: 'done', at: new Date().toISOString() });
  return rewrite;
}

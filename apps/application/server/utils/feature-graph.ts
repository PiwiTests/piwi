/**
 * The feature-graph neighborhood for the graph view and the `get_feature_graph`
 * MCP tool: starting from one node, walk the typed graph outward — in both
 * directions — to a bounded depth, and return the nodes (each with its gap class
 * and the tests that reach it) and the edges between them.
 *
 * The walk is a breadth-first expansion capped at depth six and at a per-level
 * frontier size, so a hub node cannot fan the query out without bound. Only
 * canonical rows (branch null) are read.
 *
 * Also the feature map — the folded, per-feature view the graph view opens on —
 * and a file's place in the Test Map, the coverage file view's link to it, at
 * the bottom of this file.
 */

import { and, eq, inArray, isNull, like, or } from 'drizzle-orm';
import { itemsOfFile } from '@piwitests/core/locator-break';
import { graphEdges, graphNodes, scenarioGaps, testCases } from '../database/schema';
import {
  featureOwnersOf,
  loadGapFeatureOwners,
  subjectFromGapKey,
  type GapClass,
} from '#shared/handlers/scenario-gaps';
import { filePageTarget, fileRouteTarget, pageKeyMatchesTarget, routeKeyMatchesTarget } from '#shared/graph';
import { gapClassSeverity, worstGapClass } from '#shared/gap-classes';
import type { DrizzleDB } from '#shared/handlers/db';

/** The maximum traversal depth the endpoint and tool allow. */
export const MAX_GRAPH_DEPTH = 6;
/** The most nodes expanded at any one level, so a hub cannot explode the query. */
const MAX_FRONTIER = 200;

export interface GraphViewNode {
  kind: string;
  key: string;
  /** The class of the highest-scoring open gap on this node, or null. */
  class: string | null;
  /** How many hops from the seed this node is. */
  depth: number;
  /** Tests that reach this node, by id and title. */
  tests: Array<{ testCaseId: number; title: string }>;
}

export interface GraphViewEdge {
  fromKind: string;
  fromKey: string;
  toKind: string;
  toKey: string;
  kind: string;
  confidence: number | null;
}

export interface FeatureGraph {
  seed: { kind: string; key: string };
  depth: number;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

/** A node's identity string for the visited set and lookups. */
function id(kind: string, key: string): string {
  return `${kind}\x00${key}`;
}

/**
 * Walk the graph outward from `seed` to `depth`, both directions. Returns the
 * reachable nodes with their gap class and reaching tests, and the edges walked.
 */
export async function getFeatureGraph(
  db: DrizzleDB,
  projectId: number,
  seed: { kind: string; key: string },
  depth: number,
): Promise<FeatureGraph> {
  const maxDepth = Math.min(MAX_GRAPH_DEPTH, Math.max(1, Math.floor(depth)));
  const nodeDepth = new Map<string, number>([[id(seed.kind, seed.key), 0]]);
  const edges = new Map<string, GraphViewEdge>();
  let frontier: Array<{ kind: string; key: string }> = [seed];

  for (let level = 0; level < maxDepth && frontier.length > 0; level++) {
    const capped = frontier.slice(0, MAX_FRONTIER);
    const conds = capped.map((n) =>
      or(
        and(eq(graphEdges.fromKind, n.kind), eq(graphEdges.fromKey, n.key)),
        and(eq(graphEdges.toKind, n.kind), eq(graphEdges.toKey, n.key)),
      ),
    );
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
      .where(and(eq(graphEdges.projectId, projectId), isNull(graphEdges.branch), or(...conds)));

    const next: Array<{ kind: string; key: string }> = [];
    for (const e of rows) {
      const edgeId = `${e.fromKind}\x00${e.fromKey}\x00${e.kind}\x00${e.toKind}\x00${e.toKey}`;
      if (!edges.has(edgeId)) edges.set(edgeId, { ...e });
      for (const end of [
        { kind: e.fromKind, key: e.fromKey },
        { kind: e.toKind, key: e.toKey },
      ]) {
        const nid = id(end.kind, end.key);
        if (!nodeDepth.has(nid)) {
          nodeDepth.set(nid, level + 1);
          next.push(end);
        }
      }
    }
    frontier = next;
  }

  // Gap class per node: the class of the highest-scoring open gap on the node.
  const gapRows = await db
    .select({ key: scenarioGaps.key, class: scenarioGaps.class, score: scenarioGaps.score })
    .from(scenarioGaps)
    .where(and(eq(scenarioGaps.projectId, projectId), eq(scenarioGaps.status, 'open')));
  const classByNode = new Map<string, { class: string; score: number }>();
  for (const g of gapRows) {
    const subject = subjectFromGapKey(g.key);
    const nid = id(subject.kind, subject.key);
    const score = g.score ?? 0;
    const prev = classByNode.get(nid);
    if (!prev || score > prev.score) classByNode.set(nid, { class: g.class, score });
  }

  // Tests reaching each node, with titles. Read for every node in the graph,
  // not only from the edges walked: a route one hop from a feature still shows
  // its reaching tests even though the walk stopped before their edges.
  const testsByNode = new Map<string, Set<number>>();
  const nodeIds = [...nodeDepth.keys()];
  for (let i = 0; i < nodeIds.length; i += 200) {
    const chunk = nodeIds.slice(i, i + 200).map((nid) => {
      const [kind, key] = nid.split('\x00');
      return and(eq(graphEdges.toKind, kind!), eq(graphEdges.toKey, key!));
    });
    const rows = await db
      .select({ fromKey: graphEdges.fromKey, toKind: graphEdges.toKind, toKey: graphEdges.toKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.kind, 'reaches'),
          eq(graphEdges.fromKind, 'test'),
          isNull(graphEdges.branch),
          or(...chunk),
        ),
      );
    for (const e of rows) {
      const testId = Number(e.fromKey);
      if (!Number.isFinite(testId)) continue;
      const nid = id(e.toKind, e.toKey);
      const set = testsByNode.get(nid) ?? new Set<number>();
      set.add(testId);
      testsByNode.set(nid, set);
    }
  }
  const allTestIds = [...new Set([...testsByNode.values()].flatMap((s) => [...s]))];
  const titleById = new Map<number, string>();
  for (let i = 0; i < allTestIds.length; i += 200) {
    const rows = await db
      .select({ id: testCases.id, title: testCases.title })
      .from(testCases)
      .where(and(eq(testCases.projectId, projectId), inArray(testCases.id, allTestIds.slice(i, i + 200))));
    for (const r of rows) titleById.set(r.id, r.title);
  }

  const nodes: GraphViewNode[] = [...nodeDepth].map(([nid, d]) => {
    const [kind, key] = nid.split('\x00');
    return {
      kind: kind!,
      key: key!,
      class: classByNode.get(nid)?.class ?? null,
      depth: d,
      tests: [...(testsByNode.get(nid) ?? [])].map((tid) => ({
        testCaseId: tid,
        title: titleById.get(tid) ?? `test ${tid}`,
      })),
    };
  });

  return { seed, depth: maxDepth, nodes, edges: [...edges.values()] };
}

// ── The feature map ──────────────────────────────────────────────────────────
//
// The top level of the graph view: one node per feature, sized by what it
// groups, colored by the worst open gap under it, linked to the features it
// shares routes and pages with. It reads the canonical `groups` edges (feature →
// route/page/control), the open gaps and the `reaches` edges, and folds them per
// feature — a bounded query however large the application, since features are
// the tags a team put on its tests.

export interface FeatureMapFeature {
  /** The feature's name — its node key. */
  key: string;
  /** How many nodes the feature groups, per kind, hubs aside; `inferred` of them its tests do not reach. */
  members: { routes: number; pages: number; controls: number; inferred: number };
  /** Distinct tests reaching any node the feature groups, hubs aside. */
  tests: number;
  /** Open gaps on the feature's nodes (and on the feature node itself), by class. */
  gaps: Record<string, number>;
  /** The most severe open-gap class under the feature, or null. */
  worstClass: string | null;
}

export interface FeatureMapLink {
  from: string;
  to: string;
  /** How many route/page/control nodes the two features share. */
  weight: number;
}

export interface FeatureMap {
  features: FeatureMapFeature[];
  links: FeatureMapLink[];
  /** Open gaps whose subject no feature groups, by class. */
  ungrouped: { gaps: Record<string, number>; worstClass: string | null };
  /** The hubs (nodes most tests reach or most features group), and the open gaps on them, by class. */
  shared: { nodes: number; gaps: Record<string, number>; worstClass: string | null };
}

/**
 * Fold the canonical graph into features, their gap counts and shared-node
 * links. Each open gap counts under the one feature the gap list files it under
 * ({@link loadGapFeatureOwners}). A hub (a `groups` edge marked `hub`) is counted once
 * under `shared`: it adds no member, test, gap or link to the features grouping
 * it. A feature's tests are those reaching the nodes it groups by reach.
 */
export async function getFeatureMap(db: DrizzleDB, projectId: number): Promise<FeatureMap> {
  const groupRows = await db
    .select({
      feature: graphEdges.fromKey,
      toKind: graphEdges.toKind,
      toKey: graphEdges.toKey,
      origin: graphEdges.origin,
      confidence: graphEdges.confidence,
      evidence: graphEdges.evidence,
    })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, 'groups'),
        eq(graphEdges.fromKind, 'feature'),
        isNull(graphEdges.branch),
      ),
    );

  const features = new Map<string, FeatureMapFeature>();
  const featuresByNode = new Map<string, Set<string>>();
  const hubs = new Set<string>();
  const feature = (key: string): FeatureMapFeature => {
    let f = features.get(key);
    if (!f) {
      f = { key, members: { routes: 0, pages: 0, controls: 0, inferred: 0 }, tests: 0, gaps: {}, worstClass: null };
      features.set(key, f);
    }
    return f;
  };
  const reachedByFeature = new Map<string, Set<string>>(); // node → features grouping it by reach
  for (const row of groupRows) {
    const nid = id(row.toKind, row.toKey);
    if ((row.evidence as { hub?: unknown } | null)?.hub === true) {
      hubs.add(nid);
      continue;
    }
    const f = feature(row.feature);
    if (row.origin !== 'inferred') {
      let set = reachedByFeature.get(nid);
      if (!set) reachedByFeature.set(nid, (set = new Set()));
      set.add(row.feature);
    }
    if (row.toKind === 'route') f.members.routes++;
    else if (row.toKind === 'page') f.members.pages++;
    else if (row.toKind === 'control') f.members.controls++;
    if (row.origin === 'inferred') f.members.inferred++;
    const set = featuresByNode.get(nid) ?? new Set<string>();
    set.add(row.feature);
    featuresByNode.set(nid, set);
  }

  // Open gaps, each folded onto the one feature the gap list files it under — or
  // onto the feature itself for a gap keyed on the feature node — else onto
  // "ungrouped", or "shared" for a hub.
  const gapRows = await db
    .select({ key: scenarioGaps.key, class: scenarioGaps.class })
    .from(scenarioGaps)
    .where(and(eq(scenarioGaps.projectId, projectId), eq(scenarioGaps.status, 'open')));
  const ownerOf = await loadGapFeatureOwners(
    db,
    projectId,
    groupRows,
    gapRows.map((g) => subjectFromGapKey(g.key)),
  );
  const ungrouped: Record<string, number> = {};
  const shared: Record<string, number> = {};
  const count = (bucket: Record<string, number>, cls: string) => {
    bucket[cls] = (bucket[cls] ?? 0) + 1;
  };
  for (const g of gapRows) {
    const subject = subjectFromGapKey(g.key);
    if (hubs.has(id(subject.kind, subject.key))) {
      count(shared, g.class);
      continue;
    }
    const owner = subject.kind === 'feature' && features.has(subject.key) ? subject.key : ownerOf(subject)?.feature;
    if (!owner) {
      count(ungrouped, g.class);
      continue;
    }
    count(feature(owner).gaps, g.class);
  }
  for (const f of features.values()) f.worstClass = worstGapClass(Object.keys(f.gaps));

  // Distinct tests per feature, from the canonical `reaches` edges onto the nodes
  // it groups by reach.
  if (reachedByFeature.size > 0) {
    const reachRows = await db
      .select({ test: graphEdges.fromKey, toKind: graphEdges.toKind, toKey: graphEdges.toKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.kind, 'reaches'),
          eq(graphEdges.fromKind, 'test'),
          isNull(graphEdges.branch),
        ),
      );
    const testsByFeature = new Map<string, Set<string>>();
    for (const r of reachRows) {
      const grouping = reachedByFeature.get(id(r.toKind, r.toKey));
      if (!grouping) continue;
      for (const owner of grouping) {
        const set = testsByFeature.get(owner) ?? new Set<string>();
        set.add(r.test);
        testsByFeature.set(owner, set);
      }
    }
    for (const [key, tests] of testsByFeature) feature(key).tests = tests.size;
  }

  // Links: one per pair of features sharing a node, weighted by how many they share.
  const links = new Map<string, FeatureMapLink>();
  for (const owners of featuresByNode.values()) {
    if (owners.size < 2) continue;
    const sorted = [...owners].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const from = sorted[i]!;
        const to = sorted[j]!;
        const lid = `${from}\x00${to}`;
        const link = links.get(lid) ?? { from, to, weight: 0 };
        link.weight++;
        links.set(lid, link);
      }
    }
  }

  const ranked = [...features.values()].sort(
    (a, b) =>
      gapClassSeverity(b.worstClass) - gapClassSeverity(a.worstClass) ||
      sumGaps(b.gaps) - sumGaps(a.gaps) ||
      a.key.localeCompare(b.key),
  );
  return {
    features: ranked,
    links: [...links.values()].sort((a, b) => b.weight - a.weight),
    ungrouped: { gaps: ungrouped, worstClass: worstGapClass(Object.keys(ungrouped)) },
    shared: { nodes: hubs.size, gaps: shared, worstClass: worstGapClass(Object.keys(shared)) },
  };
}

function sumGaps(gaps: Record<string, number>): number {
  let n = 0;
  for (const v of Object.values(gaps)) n += v;
  return n;
}

// ── A file's place in the Test Map ───────────────────────────────────────────

/** How a file maps to a Test Map node. */
export type FileNodeVia = 'node' | 'handled-by' | 'convention';

/** An open gap on a file's node, as the coverage file view lists it. */
export interface FileTestMapGap {
  id: number;
  detector: string;
  class: GapClass;
  title: string;
  score: number | null;
}

/** One Test Map node a file is, or serves. */
export interface FileTestMapNode {
  kind: 'page' | 'route' | 'handler' | 'file';
  key: string;
  /**
   * How the file maps to it: `node` is the file's own handler or file node,
   * `handled-by` a route its handler serves, `convention` the route or page
   * the framework's file naming gives it.
   */
  via: FileNodeVia;
  /** Distinct tests that reach the node. */
  tests: number;
  /** The feature the node belongs to; null for none, and for a hub. */
  feature: string | null;
  /** Its open gaps, the highest score first, at most {@link MAX_FILE_NODE_GAPS}. */
  gaps: FileTestMapGap[];
  /** Every open gap on the node. */
  openGaps: number;
}

export interface FileTestMap {
  path: string;
  nodes: FileTestMapNode[];
}

/** Open gaps listed per node at most; the rest are counted. */
export const MAX_FILE_NODE_GAPS = 3;
/** Nodes returned at most, those with the most open gaps first. */
const MAX_FILE_NODES = 20;
const KIND_ORDER: Record<FileTestMapNode['kind'], number> = { page: 0, route: 1, handler: 2, file: 3 };

/**
 * Where a repository file sits in the Test Map: its own `handler` and `file`
 * nodes, the routes its handler serves (`handled-by`), and the route or page
 * the framework's file naming gives it, each with the tests that reach it, its
 * feature and its open gaps. A handler counts the tests of the routes it
 * serves, and a page the gaps of the controls and links it contains. A
 * changed file's own *changed, unreached* gap counts on its `file` node,
 * which is listed for it even when no test ran it. Canonical rows only
 * (branch null).
 */
export async function getFileTestMap(db: DrizzleDB, projectId: number, filePath: string): Promise<FileTestMap> {
  const path = filePath
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .trim();
  const nodes = new Map<string, { kind: FileTestMapNode['kind']; key: string; via: FileNodeVia }>();
  const add = (kind: FileTestMapNode['kind'], key: string, via: FileNodeVia) => {
    if (!nodes.has(id(kind, key))) nodes.set(id(kind, key), { kind, key, via });
  };
  if (!path) return { path, nodes: [] };
  const base = path.split('/').pop()!;

  // The file's own nodes, by path suffix as coverage matches files, its own path first.
  const own = await db
    .select({ kind: graphNodes.kind, key: graphNodes.key })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.projectId, projectId),
        inArray(graphNodes.kind, ['handler', 'file']),
        isNull(graphNodes.branch),
        isNull(graphNodes.prunedAt),
        like(graphNodes.key, `%${base}`),
      ),
    );
  for (const n of itemsOfFile(
    own.map((o) => ({ ...o, path: o.key })),
    path,
  )) {
    add(n.kind as 'handler' | 'file', n.key, 'node');
  }

  // The routes each of its handlers serves.
  const routesOf = new Map<string, string[]>();
  const handlers = [...nodes.values()].filter((n) => n.kind === 'handler').map((n) => n.key);
  if (handlers.length > 0) {
    const served = await db
      .select({ fromKey: graphEdges.fromKey, toKey: graphEdges.toKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.kind, 'handled-by'),
          eq(graphEdges.fromKind, 'route'),
          eq(graphEdges.toKind, 'handler'),
          inArray(graphEdges.toKey, handlers),
          isNull(graphEdges.branch),
        ),
      );
    for (const e of served) {
      add('route', e.fromKey, 'handled-by');
      routesOf.set(e.toKey, [...(routesOf.get(e.toKey) ?? []), e.fromKey]);
    }
  }

  // The route or page the framework's file naming gives it.
  const routeTarget = fileRouteTarget(path);
  const pageTarget = filePageTarget(path);
  if (routeTarget || pageTarget) {
    const named = await db
      .select({ kind: graphNodes.kind, key: graphNodes.key })
      .from(graphNodes)
      .where(
        and(
          eq(graphNodes.projectId, projectId),
          inArray(graphNodes.kind, [...(routeTarget ? ['route'] : []), ...(pageTarget ? ['page'] : [])]),
          isNull(graphNodes.branch),
          isNull(graphNodes.prunedAt),
        ),
      );
    for (const n of named) {
      if (n.kind === 'route' && routeTarget && routeKeyMatchesTarget(routeTarget, n.key))
        add('route', n.key, 'convention');
      if (n.kind === 'page' && pageTarget && pageKeyMatchesTarget(pageTarget, n.key)) add('page', n.key, 'convention');
    }
  }

  // The controls and links each page contains: their gaps are the page's.
  const pageOf = new Map<string, string>();
  const pages = [...nodes.values()].filter((n) => n.kind === 'page').map((n) => n.key);
  if (pages.length > 0) {
    const contained = await db
      .select({ fromKey: graphEdges.fromKey, toKind: graphEdges.toKind, toKey: graphEdges.toKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.kind, 'contains'),
          eq(graphEdges.fromKind, 'page'),
          inArray(graphEdges.fromKey, pages),
          inArray(graphEdges.toKind, ['control', 'link']),
          isNull(graphEdges.branch),
        ),
      );
    for (const e of contained)
      if (!pageOf.has(id(e.toKind, e.toKey))) pageOf.set(id(e.toKind, e.toKey), id('page', e.fromKey));
  }

  // The open gaps on those nodes, read by the keys a detector gives them (typed, or a bare route
  // key or file path); a gap on the file itself (changed, unreached) puts its file node in the list.
  const gapKeys = new Set<string>();
  for (const n of nodes.values()) {
    gapKeys.add(`${n.kind}:${n.key}`);
    gapKeys.add(n.key);
  }
  for (const nid of pageOf.keys()) gapKeys.add(nid.replace('\x00', ':'));
  const gapRows = await db
    .select({
      id: scenarioGaps.id,
      key: scenarioGaps.key,
      detector: scenarioGaps.detector,
      class: scenarioGaps.class,
      title: scenarioGaps.title,
      score: scenarioGaps.score,
    })
    .from(scenarioGaps)
    .where(
      and(
        eq(scenarioGaps.projectId, projectId),
        eq(scenarioGaps.status, 'open'),
        or(inArray(scenarioGaps.key, [...gapKeys]), like(scenarioGaps.key, `%${base}`)),
      ),
    );
  const fileSubjects = itemsOfFile(
    gapRows.map((g) => subjectFromGapKey(g.key)).flatMap((s) => (s.kind === 'file' ? [{ ...s, path: s.key }] : [])),
    path,
  );
  for (const s of fileSubjects) add('file', s.key, 'node');
  const gapsByNode = new Map<string, FileTestMapGap[]>();
  for (const g of gapRows) {
    const subject = subjectFromGapKey(g.key);
    const own = id(subject.kind, subject.key);
    const nid = nodes.has(own) ? own : pageOf.get(own);
    if (!nid) continue;
    const list = gapsByNode.get(nid) ?? [];
    list.push({ id: g.id, detector: g.detector, class: g.class as GapClass, title: g.title, score: g.score ?? null });
    gapsByNode.set(nid, list);
  }
  if (nodes.size === 0) return { path, nodes: [] };

  // Distinct tests reaching each node.
  const testsByNode = new Map<string, Set<string>>();
  const all = [...nodes.values()];
  for (let i = 0; i < all.length; i += 200) {
    const rows = await db
      .select({ fromKey: graphEdges.fromKey, toKind: graphEdges.toKind, toKey: graphEdges.toKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.kind, 'reaches'),
          eq(graphEdges.fromKind, 'test'),
          isNull(graphEdges.branch),
          or(...all.slice(i, i + 200).map((n) => and(eq(graphEdges.toKind, n.kind), eq(graphEdges.toKey, n.key)))),
        ),
      );
    for (const e of rows) {
      const nid = id(e.toKind, e.toKey);
      testsByNode.set(nid, (testsByNode.get(nid) ?? new Set<string>()).add(e.fromKey));
    }
  }
  // A handler is reached through the routes it serves.
  for (const [handler, routes] of routesOf) {
    const nid = id('handler', handler);
    const tests = new Set(testsByNode.get(nid) ?? []);
    for (const route of routes) for (const t of testsByNode.get(id('route', route)) ?? []) tests.add(t);
    testsByNode.set(nid, tests);
  }

  const ownerOf = await featureOwnersOf(db, projectId, all);
  const result: FileTestMapNode[] = all.map((n) => {
    const nid = id(n.kind, n.key);
    const gaps = (gapsByNode.get(nid) ?? []).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const owner = ownerOf({ kind: n.kind, key: n.key });
    return {
      ...n,
      tests: testsByNode.get(nid)?.size ?? 0,
      feature: owner && !owner.hub ? owner.feature : null,
      gaps: gaps.slice(0, MAX_FILE_NODE_GAPS),
      openGaps: gaps.length,
    };
  });
  result.sort(
    (a, b) => b.openGaps - a.openGaps || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key.localeCompare(b.key),
  );
  return { path, nodes: result.slice(0, MAX_FILE_NODES) };
}

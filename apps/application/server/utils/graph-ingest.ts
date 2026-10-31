/**
 * Feature-graph ingest — the single place run cases become `route`/`page` nodes
 * and `reaches` edges. Called from the one write path on every ingest, with
 * upsert semantics: a node or edge that already exists has its last-seen run
 * bumped, never truncated, so the graph accumulates across a project's history.
 *
 * Rows are tagged with the run's branch: a run on the project's default branch
 * writes canonical rows (`branch` null); a run on any other branch writes rows
 * tagged with that branch, so a route added on a pull request never shows up as
 * surface drift on the default branch. Route nodes come only from requests to
 * the run's own origin, so third-party beacons and CDN assets never enter the
 * graph, and never from page loads (`isPageLoad`), which are the pages' own
 * nodes.
 */

import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  graphNodes,
  graphEdges,
  projects,
  scenarioGaps,
  testRuns,
  testRunsCases,
  networkRequests,
} from '../database/schema';
import {
  routeNodeKey,
  pageNodeKey,
  testEndpointKey,
  collectOwnOrigins,
  isOwnOriginRequest,
  originsFromDocumentRequests,
  isPageLoad,
  buildRequestGraph,
  buildPageInventoryGraph,
  buildManifestGraph,
  buildImportEdges,
  dependencyNodeKey,
  type GraphNodeSpec,
  type GraphEdgeSpec,
  type RequestSpansInput,
  type PageInventoryInput,
  type ImportPair,
  projectRouteOrigins,
  runBaseUrls,
} from '#shared/graph';
import type { AppManifest, ManifestSource } from '#shared/types';
import type { ServerSpanEntry } from './run-json-types';
import { resolveRunBranch } from './run-branch';
import { resolveDefaultBranch } from './scm/default-branch';
import { resolveStoredDefaultBranch, type DefaultBranchProject } from './scm/stored-default-branch';
import { FALLBACK_DEFAULT_BRANCH } from './scm/git-url';
import { resolveCasePayloadContents } from './case-payloads';
import { parseStoredLocatorPages } from './locator-pages';
import { isLabRun } from '#shared/handlers/probes';
import { subjectFromGapKey } from '#shared/handlers/scenario-gaps';
import type { DbClient as DB } from '../database';

/** One test case's observed reach within a single run. */
export interface RunGraphReach {
  testCaseId: number;
  routes: Array<{ method: string; normalizedUrl: string; status: number; url?: string | null }>;
  /** The URL of the page each execution ended on. */
  pages: string[];
  /** The keys of the pages it ran locator calls on, which carry no URL of their own. */
  visitedPages?: string[];
}

interface PendingNode {
  kind: string;
  key: string;
  attrs: unknown;
  origin?: string;
}

interface PendingEdge {
  fromKind: string;
  fromKey: string;
  toKind: string;
  toKey: string;
  kind: string;
  confidence: number | null;
  evidence: unknown;
  origin?: string;
}

/** Read the sanitized page URL off a persisted case's `pageState`. */
function pageUrlOf(pageState: unknown): string | null {
  if (!pageState || typeof pageState !== 'object') return null;
  const url = (pageState as { url?: unknown }).url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/** The pages an execution ran locator calls on, as `piwi-locator-pages` records them. */
type LocatorPagesOfRow = ReadonlyArray<{ origin: string; page: string }> | null | undefined;

/**
 * Fold the per-execution rows of one run into per-test-case reach. A test that
 * ran several times (retries, browsers) contributes the union of what each
 * execution touched. A test reaches the page it ended on and every page it ran a
 * locator call on. When `origins` is given, only requests and pages on one of
 * those origins count — third-party beacons, CDN assets and redirects are
 * dropped before the fold, so they never key a node. A locator page counts only
 * against a known origin: its key has no host, so a third-party sign-in page
 * would otherwise merge into the application's page of the same path. A page
 * load reaches its page, never a route.
 */
export function collectRunGraphReaches(
  rows: Array<{ testCaseId: number | null | undefined; pageState: unknown; locatorPages?: LocatorPagesOfRow }>,
  networkBuilders: Array<{
    items: Array<{
      method: string;
      normalizedUrl: string;
      status: number;
      url?: string | null;
      resourceType?: string | null;
    }>;
  }>,
  options: { origins?: Set<string> } = {},
): RunGraphReach[] {
  const origins = options.origins ?? new Set<string>();
  const byCase = new Map<
    number,
    {
      routes: Map<string, { method: string; normalizedUrl: string; status: number; url?: string | null }>;
      pages: Set<string>;
      visitedPages: Set<string>;
    }
  >();

  for (let i = 0; i < rows.length; i++) {
    const testCaseId = rows[i]!.testCaseId;
    if (testCaseId == null) continue;
    let entry = byCase.get(testCaseId);
    if (!entry) {
      entry = { routes: new Map(), pages: new Set(), visitedPages: new Set() };
      byCase.set(testCaseId, entry);
    }
    for (const item of networkBuilders[i]?.items ?? []) {
      if (!item.normalizedUrl || isPageLoad(item.resourceType)) continue;
      if (!isOwnOriginRequest(item.url, origins)) continue;
      entry.routes.set(routeNodeKey(item.method, item.normalizedUrl), item);
    }
    const url = pageUrlOf(rows[i]!.pageState);
    // Own-origin pages only, like routes: a third-party redirect (checkout, OAuth)
    // is not this app's surface and must not become a page node.
    if (url && isOwnOriginRequest(url, origins)) entry.pages.add(url);
    for (const use of rows[i]!.locatorPages ?? []) {
      if (!origins.has(use.origin)) continue;
      const key = pageNodeKey(use.page);
      if (key) entry.visitedPages.add(key);
    }
  }

  return [...byCase].map(([testCaseId, e]) => ({
    testCaseId,
    routes: [...e.routes.values()],
    pages: [...e.pages],
    visitedPages: [...e.visitedPages],
  }));
}

/** Conflict target + predicate for the branch-aware unique indexes on nodes. */
function nodeConflict(branch: string | null) {
  return branch == null
    ? { target: [graphNodes.projectId, graphNodes.kind, graphNodes.key], targetWhere: isNull(graphNodes.branch) }
    : {
        target: [graphNodes.projectId, graphNodes.kind, graphNodes.key, graphNodes.branch],
        targetWhere: sql`${graphNodes.branch} is not null`,
      };
}

/** Conflict target + predicate for the branch-aware unique indexes on edges. */
function edgeConflict(branch: string | null) {
  return branch == null
    ? {
        target: [
          graphEdges.projectId,
          graphEdges.fromKind,
          graphEdges.fromKey,
          graphEdges.kind,
          graphEdges.toKind,
          graphEdges.toKey,
        ],
        targetWhere: isNull(graphEdges.branch),
      }
    : {
        target: [
          graphEdges.projectId,
          graphEdges.fromKind,
          graphEdges.fromKey,
          graphEdges.kind,
          graphEdges.toKind,
          graphEdges.toKey,
          graphEdges.branch,
        ],
        targetWhere: sql`${graphEdges.branch} is not null`,
      };
}

/** Stable conflict key for a node, so every writer locks rows in one order. */
function nodeSortKey(n: PendingNode): string {
  return `${n.kind}\x00${n.key}`;
}

/** Stable conflict key for an edge, so every writer locks rows in one order. */
function edgeSortKey(e: PendingEdge): string {
  return `${e.fromKind}\x00${e.fromKey}\x00${e.kind}\x00${e.toKind}\x00${e.toKey}`;
}

async function chunkedUpsertNodes(
  db: DB,
  projectId: number,
  runId: number,
  now: Date,
  branch: string | null,
  nodes: PendingNode[],
): Promise<void> {
  const CHUNK = 100;
  const conflict = nodeConflict(branch);
  // Sort by conflict key so concurrent shards acquire row locks in one order:
  // unsorted batches deadlock under parallel ingest, and the loss is silent.
  const sorted = [...nodes].sort((a, b) =>
    nodeSortKey(a) < nodeSortKey(b) ? -1 : nodeSortKey(a) > nodeSortKey(b) ? 1 : 0,
  );
  for (let i = 0; i < sorted.length; i += CHUNK) {
    const slice = sorted.slice(i, i + CHUNK);
    try {
      await db
        .insert(graphNodes)
        .values(
          slice.map((n) => ({
            projectId,
            kind: n.kind,
            key: n.key,
            branch,
            attrs: (n.attrs ?? null) as any,
            origin: n.origin ?? 'observed',
            firstSeenRunId: runId,
            lastSeenRunId: runId,
            lastSeenAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: conflict.target,
          targetWhere: conflict.targetWhere,
          // Never let last_seen move backwards: an older run re-ingested (a
          // rebuild, or an out-of-order concurrent write) must not lower it, or
          // the staleness sweep would misjudge the node's age.
          setWhere: sql`excluded.last_seen_run_id >= coalesce(${graphNodes.lastSeenRunId}, -1)`,
          set: {
            lastSeenRunId: sql`excluded.last_seen_run_id`,
            lastSeenAt: sql`excluded.last_seen_at`,
            // Keep the latest non-null attrs so a declared node's documented codes
            // survive a later observed upsert (which carries null attrs for routes).
            attrs: sql`coalesce(excluded.attrs, ${graphNodes.attrs})`,
            // A key that was soft-deleted by the staleness sweep and now reappears
            // is live again; first_seen is untouched, so it does not re-flag as drift.
            prunedAt: sql`null`,
          },
        });
    } catch (err) {
      console.error(`[graph-ingest] dropped a batch of ${slice.length} node upserts`, err);
    }
  }
}

async function chunkedUpsertEdges(
  db: DB,
  projectId: number,
  runId: number,
  now: Date,
  branch: string | null,
  edges: PendingEdge[],
): Promise<void> {
  const CHUNK = 100;
  const conflict = edgeConflict(branch);
  // Sort by conflict key so concurrent shards acquire row locks in one order.
  const sorted = [...edges].sort((a, b) =>
    edgeSortKey(a) < edgeSortKey(b) ? -1 : edgeSortKey(a) > edgeSortKey(b) ? 1 : 0,
  );
  for (let i = 0; i < sorted.length; i += CHUNK) {
    const slice = sorted.slice(i, i + CHUNK);
    try {
      await db
        .insert(graphEdges)
        .values(
          slice.map((e) => ({
            projectId,
            fromKind: e.fromKind,
            fromKey: e.fromKey,
            toKind: e.toKind,
            toKey: e.toKey,
            kind: e.kind,
            branch,
            confidence: e.confidence,
            origin: e.origin ?? 'observed',
            evidence: (e.evidence ?? null) as any,
            firstSeenRunId: runId,
            lastSeenRunId: runId,
            lastSeenAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: conflict.target,
          targetWhere: conflict.targetWhere,
          // Never let last_seen move backwards (see chunkedUpsertNodes).
          setWhere: sql`excluded.last_seen_run_id >= coalesce(${graphEdges.lastSeenRunId}, -1)`,
          set: {
            lastSeenRunId: sql`excluded.last_seen_run_id`,
            lastSeenAt: sql`excluded.last_seen_at`,
            confidence: sql`excluded.confidence`,
            evidence: sql`excluded.evidence`,
          },
        });
    } catch (err) {
      console.error(`[graph-ingest] dropped a batch of ${slice.length} edge upserts`, err);
    }
  }
}

/**
 * Upsert the `route`/`page` nodes and `reaches` edges implied by one run's
 * reach. Deduplicated per unique key before the batch upsert — a repeated key
 * within one statement would otherwise break PostgreSQL's `ON CONFLICT`. Rows
 * carry the run's `branch` tag (null = canonical, from a default-branch run).
 */
export async function ingestRunGraph(
  db: DB,
  projectId: number,
  runId: number,
  reaches: RunGraphReach[],
  options: { branch?: string | null } = {},
): Promise<void> {
  if (reaches.length === 0) return;
  const now = new Date();
  const branch = options.branch ?? null;

  const nodes = new Map<string, PendingNode>();
  const edges = new Map<string, PendingEdge>();

  const addNode = (kind: string, key: string, attrs: unknown = null) => {
    const id = `${kind}\x00${key}`;
    if (!nodes.has(id)) nodes.set(id, { kind, key, attrs });
  };
  const addEdge = (e: PendingEdge) => {
    const id = `${e.fromKind}\x00${e.fromKey}\x00${e.kind}\x00${e.toKind}\x00${e.toKey}`;
    edges.set(id, e);
  };

  for (const reach of reaches) {
    const from = testEndpointKey(reach.testCaseId);
    for (const route of reach.routes) {
      const key = routeNodeKey(route.method, route.normalizedUrl);
      addNode('route', key);
      addEdge({
        fromKind: 'test',
        fromKey: from,
        toKind: 'route',
        toKey: key,
        kind: 'reaches',
        confidence: 1,
        evidence: { method: route.method.toUpperCase(), status: route.status },
      });
    }
    for (const url of reach.pages) {
      const key = pageNodeKey(url);
      if (!key) continue;
      addNode('page', key, { url });
      addEdge({
        fromKind: 'test',
        fromKey: from,
        toKind: 'page',
        toKey: key,
        kind: 'reaches',
        confidence: 1,
        evidence: null,
      });
    }
  }
  // Pages known only by their key come after every page with a URL, so a node
  // keeps the real URL another test ended on; a null `attrs` leaves a stored one.
  for (const reach of reaches) {
    const from = testEndpointKey(reach.testCaseId);
    for (const key of reach.visitedPages ?? []) {
      addNode('page', key);
      addEdge({
        fromKind: 'test',
        fromKey: from,
        toKind: 'page',
        toKey: key,
        kind: 'reaches',
        confidence: 1,
        evidence: null,
      });
    }
  }

  await chunkedUpsertNodes(db, projectId, runId, now, branch, [...nodes.values()]);
  await chunkedUpsertEdges(db, projectId, runId, now, branch, [...edges.values()]);
}

/**
 * Upsert the node and edge specs a pure builder produced ({@link buildPageInventoryGraph},
 * {@link buildRequestGraph}, {@link buildTriggerEdges}). Deduplicated per unique
 * key before the batch, and tagged with the run's branch. A graph failure must
 * never break ingest, so callers wrap this in a try/catch that degrades to a
 * warning.
 */
export async function upsertGraphSpecs(
  db: DB,
  projectId: number,
  runId: number,
  specs: { nodes?: GraphNodeSpec[]; edges?: GraphEdgeSpec[] },
  options: { branch?: string | null } = {},
): Promise<void> {
  const branch = options.branch ?? null;
  const now = new Date();

  const nodes = new Map<string, PendingNode>();
  for (const n of specs.nodes ?? []) {
    nodes.set(`${n.kind}\x00${n.key}`, { kind: n.kind, key: n.key, attrs: n.attrs ?? null, origin: n.origin });
  }
  const edges = new Map<string, PendingEdge>();
  for (const e of specs.edges ?? []) {
    edges.set(`${e.fromKind}\x00${e.fromKey}\x00${e.kind}\x00${e.toKind}\x00${e.toKey}`, {
      fromKind: e.fromKind,
      fromKey: e.fromKey,
      toKind: e.toKind,
      toKey: e.toKey,
      kind: e.kind,
      confidence: e.confidence ?? null,
      evidence: e.evidence ?? null,
      origin: e.origin,
    });
  }

  if (nodes.size > 0) await chunkedUpsertNodes(db, projectId, runId, now, branch, [...nodes.values()]);
  if (edges.size > 0) await chunkedUpsertEdges(db, projectId, runId, now, branch, [...edges.values()]);
}

/** A case with its parsed page inventory and the network items it recorded. */
export interface PageInventoryCase {
  /** The `piwi-page-inventory` payload: `[{ url, controls, links, capturedAt }]`. */
  pageInventory?: unknown;
  networkItems: Array<{
    method: string;
    normalizedUrl: string;
    url?: string | null;
    resourceType?: string | null;
    /** Request start (Unix ms), used to attribute the request to the page current at that time. */
    startTime?: number | null;
  }>;
}

/** Load resource types that count as a page loading a route during settle; a page load opens a page, never a route. */
const LOAD_RESOURCE_TYPES = new Set(['xhr', 'fetch']);

/**
 * Turn a run's cases into page inventories: one {@link PageInventoryInput} per
 * visited page, with the own-origin routes the case loaded attached so `loads`
 * edges form. Malformed inventory entries are skipped.
 */
export function collectPageInventories(cases: PageInventoryCase[], origins: Set<string>): PageInventoryInput[] {
  const out: PageInventoryInput[] = [];
  for (const c of cases) {
    const inv = Array.isArray(c.pageInventory) ? (c.pageInventory as unknown[]) : null;
    if (!inv || inv.length === 0) continue;

    // One entry per page the case settled on, in settle order, each collecting
    // only the routes attributed to it below.
    const entries: Array<{
      pageKey: string;
      pageUrl: string;
      capturedAt: number | null;
      controls: Array<{ role: string | null; name: string }>;
      links: Array<{ name: string; href: string | null }>;
      loads: Set<string>;
    }> = [];
    for (const raw of inv) {
      if (!raw || typeof raw !== 'object') continue;
      const page = raw as { url?: unknown; controls?: unknown; links?: unknown; capturedAt?: unknown };
      if (typeof page.url !== 'string' || !page.url) continue;
      // Own-origin pages only — a third-party page the test visited is not surface.
      if (!isOwnOriginRequest(page.url, origins)) continue;
      const pageKey = pageNodeKey(page.url);
      if (!pageKey) continue;
      const controls = Array.isArray(page.controls)
        ? (page.controls as unknown[])
            .filter((x): x is { role?: unknown; name?: unknown } => !!x && typeof x === 'object')
            .map((x) => ({
              role: typeof x.role === 'string' ? x.role : null,
              name: typeof x.name === 'string' ? x.name : '',
            }))
            .filter((x) => x.name)
        : [];
      const links = Array.isArray(page.links)
        ? (page.links as unknown[])
            .filter((x): x is { name?: unknown; href?: unknown } => !!x && typeof x === 'object')
            .map((x) => ({
              name: typeof x.name === 'string' ? x.name : '',
              href: typeof x.href === 'string' ? x.href : null,
            }))
            .filter((x) => x.name)
        : [];
      const capturedAt =
        typeof page.capturedAt === 'number' && Number.isFinite(page.capturedAt) ? page.capturedAt : null;
      entries.push({ pageKey, pageUrl: page.url, capturedAt, controls, links, loads: new Set<string>() });
    }
    if (entries.length === 0) continue;

    // Attribute each own-origin xhr/fetch request to the page current
    // when it started — the entry with the greatest settle time at or before the
    // request start. A request with no start time, or before the first settle,
    // cannot be placed, so it produces no `loads` edge rather than a wrong one.
    const windows = entries.filter((e) => e.capturedAt != null).sort((a, b) => a.capturedAt! - b.capturedAt!);
    for (const item of c.networkItems) {
      if (!item.normalizedUrl) continue;
      if (!LOAD_RESOURCE_TYPES.has((item.resourceType ?? '').toLowerCase())) continue;
      if (!isOwnOriginRequest(item.url, origins)) continue;
      const startTime = typeof item.startTime === 'number' && Number.isFinite(item.startTime) ? item.startTime : null;
      if (startTime == null) continue;
      let target: (typeof windows)[number] | null = null;
      for (const w of windows) {
        if (w.capturedAt! <= startTime) target = w;
        else break;
      }
      if (!target) continue;
      target.loads.add(routeNodeKey(item.method, item.normalizedUrl));
    }

    for (const e of entries) {
      out.push({
        pageKey: e.pageKey,
        pageUrl: e.pageUrl,
        controls: e.controls,
        links: e.links,
        loadsRouteKeys: [...e.loads],
      });
    }
  }
  return out;
}

/**
 * Upsert the `control`/`link` nodes and `contains`/`links`/`loads` edges implied
 * by a run's page inventories. A no-op when no case carried an inventory.
 */
export async function ingestPageInventoryGraph(
  db: DB,
  projectId: number,
  runId: number,
  cases: PageInventoryCase[],
  origins: Set<string>,
  options: { branch?: string | null } = {},
): Promise<void> {
  const pages = collectPageInventories(cases, origins);
  if (pages.length === 0) return;
  await upsertGraphSpecs(db, projectId, runId, buildPageInventoryGraph(pages, { origins }), options);
}

/**
 * Upsert the declared `route`/`page`/`handler` nodes a manifest describes. Rows
 * are canonical (branch null) unless a branch is given — a declared surface is a
 * project-level contract, not a per-run observation. A graph failure must never
 * break the upload, so the caller wraps this in a try/catch.
 */
export async function ingestManifestGraph(
  db: DB,
  projectId: number,
  runId: number,
  manifest: AppManifest,
  source: ManifestSource,
  options: { branch?: string | null } = {},
): Promise<void> {
  await upsertGraphSpecs(db, projectId, runId, buildManifestGraph(manifest, source), options);
}

/**
 * Upsert `file` nodes and `imports` edges from a shallow import scan. The pairs
 * come from parsing the changed files' content at the run's ref through the SCM
 * provider, capped by the provider's file budget.
 */
export async function ingestImportEdges(
  db: DB,
  projectId: number,
  runId: number,
  pairs: ImportPair[],
  options: { branch?: string | null } = {},
): Promise<void> {
  if (pairs.length === 0) return;
  await upsertGraphSpecs(db, projectId, runId, buildImportEdges(pairs), options);
}

/** The handler's source file from a root span, when the instrumentation carries it. */
function handlerFileFromSpan(span: ServerSpanEntry | undefined): string | null {
  const attrs = span?.attrs;
  if (!attrs) return null;
  for (const key of ['piwi.handler', 'piwi.handler.file', 'code.filepath', 'handler']) {
    const v = attrs[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** A child span's dependency name — a peer service or database, else the span name. */
function dependencyNameFromSpan(span: ServerSpanEntry): string | null {
  const attrs = span.attrs ?? {};
  for (const key of ['peer.service', 'db.system', 'net.peer.name', 'rpc.service']) {
    const v = attrs[key];
    if (typeof v === 'string' && v.trim()) return dependencyNodeKey(v);
  }
  return span.name?.trim() ? dependencyNodeKey(span.name) : null;
}

/**
 * Extract per-route handler and dependency inputs from a run's network builders,
 * own-origin routes with server spans only. A request without spans contributes
 * nothing, so `handled-by` and `calls` edges form only for instrumented projects.
 * A page load is no route, so a server-rendered page's spans add nothing either.
 */
export function collectRequestGraph(
  builders: Array<{
    items: Array<{
      method: string;
      normalizedUrl: string;
      url?: string | null;
      serverTraces?: unknown;
      resourceType?: string | null;
    }>;
  }>,
  origins: Set<string>,
): RequestSpansInput[] {
  const out = new Map<string, RequestSpansInput & { dependencies: string[] }>();
  for (const b of builders) {
    for (const item of b.items) {
      if (!item.normalizedUrl || isPageLoad(item.resourceType)) continue;
      if (!isOwnOriginRequest(item.url, origins)) continue;
      const spans = Array.isArray(item.serverTraces) ? (item.serverTraces as ServerSpanEntry[]) : [];
      if (spans.length === 0) continue;
      const routeKey = routeNodeKey(item.method, item.normalizedUrl);
      const root = spans.find((s) => !s.parentId) ?? spans[0];
      const handlerFile = handlerFileFromSpan(root);
      const deps = spans
        .filter((s) => s.parentId)
        .map(dependencyNameFromSpan)
        .filter((d): d is string => !!d);
      const existing = out.get(routeKey);
      if (existing) {
        if (handlerFile && !existing.handlerFile) existing.handlerFile = handlerFile;
        for (const d of deps) if (!existing.dependencies.includes(d)) existing.dependencies.push(d);
      } else {
        out.set(routeKey, { routeKey, handlerFile, dependencies: [...new Set(deps)] });
      }
    }
  }
  return [...out.values()];
}

/**
 * Upsert the `handler`/`dependency` nodes and `handled-by`/`calls` edges implied
 * by a run's request spans. A no-op when no request carried spans.
 */
export async function ingestRequestGraph(
  db: DB,
  projectId: number,
  runId: number,
  builders: Array<{
    items: Array<{
      method: string;
      normalizedUrl: string;
      url?: string | null;
      serverTraces?: unknown;
      resourceType?: string | null;
    }>;
  }>,
  origins: Set<string>,
  options: { branch?: string | null } = {},
): Promise<void> {
  const requests = collectRequestGraph(builders, origins);
  if (requests.length === 0) return;
  await upsertGraphSpecs(db, projectId, runId, buildRequestGraph(requests), options);
}

/**
 * Persist `changes` edges for a diff: the head commit and every ticket named in
 * the pull request point at each changed file. Files are edge endpoints, not
 * materialized nodes. A commit edge's evidence names the diff's `base`, so diffs
 * that share a base (a red streak diffed again from the same green run) count
 * as one change. Upsert semantics, never truncate. Rows carry the run's
 * `branch` tag, like the reach graph.
 */
export async function ingestChangesEdges(
  db: DB,
  projectId: number,
  runId: number,
  headSha: string,
  tickets: string[],
  files: string[],
  options: { branch?: string | null; baseSha?: string | null } = {},
): Promise<void> {
  if (files.length === 0) return;
  const now = new Date();
  const branch = options.branch ?? null;
  const edges = new Map<string, PendingEdge>();
  const add = (fromKind: string, fromKey: string, file: string, evidence: Record<string, unknown> | null) => {
    const id = `${fromKind}\x00${fromKey}\x00changes\x00file\x00${file}`;
    edges.set(id, {
      fromKind,
      fromKey,
      toKind: 'file',
      toKey: file,
      kind: 'changes',
      confidence: null,
      evidence,
    });
  };
  const commitEvidence = options.baseSha ? { base: options.baseSha } : null;
  for (const file of files) {
    if (headSha) add('commit', headSha, file, commitEvidence);
    for (const ticket of tickets) add('ticket', ticket, file, null);
  }
  await chunkedUpsertEdges(db, projectId, runId, now, branch, [...edges.values()]);
}

/**
 * The graph branch tag for a run: null when the run is on the project's default
 * branch (canonical rows), otherwise the run's own branch. An unknown branch is
 * treated as canonical, since it cannot be distinguished from the default.
 *
 * Resolves the default branch through the SCM provider, so it is for off-hot-path
 * callers (the recompute endpoint, the backfill sweep). The ingest path uses
 * {@link resolveRunBranchTagFromStored}, which never makes a network call.
 */
export async function resolveRunBranchTag(
  db: DB,
  project: DefaultBranchProject,
  runMetadata: unknown,
  runBranch?: string | null,
): Promise<string | null> {
  const branch = (runBranch ?? resolveRunBranch(runMetadata))?.trim() || null;
  if (!branch) return null;
  const defaultBranch = await resolveDefaultBranch(db, project, runMetadata).catch(() => FALLBACK_DEFAULT_BRANCH);
  return branch === defaultBranch ? null : branch;
}

/**
 * The graph branch tag resolved without any SCM network call, so it is safe on
 * the ingest hot path. The run's branch is canonical (null tag) when it equals
 * the project's default branch, resolved through {@link resolveStoredDefaultBranch}
 * — the project's stored default, then the most common branch among its runs,
 * then `'main'`. That documented fallback keeps canonical rows even when the SCM
 * default branch is unknown, so an unresolved default never empties the Test Map.
 * A caller that resolves the stored default branch itself passes it as `storedDefault`.
 */
export async function resolveRunBranchTagFromStored(
  db: DB,
  project: DefaultBranchProject,
  runMetadata: unknown,
  runBranch?: string | null,
  storedDefault: () => Promise<string> = () => resolveStoredDefaultBranch(db, project),
): Promise<string | null> {
  const branch = (runBranch ?? resolveRunBranch(runMetadata))?.trim() || null;
  if (!branch) return null;
  const defaultBranch = await storedDefault();
  return branch === defaultBranch ? null : branch;
}

// The run's own origins, pure and shared with the locator index (which the demo
// runs in the browser, where this module's SCM imports cannot load).
export { projectRouteOrigins, runBaseUrls };

/**
 * Rebuild a project's `route`/`page` nodes and `reaches` edges from its whole
 * stored history, oldest run first so first- and last-seen land in order. Upsert
 * semantics make it idempotent — running it twice changes nothing. This is the
 * one-off backfill for instances whose history predates the graph.
 */
export async function rebuildProjectGraph(db: DB, projectId: number): Promise<{ runsProcessed: number }> {
  const [project] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch, routeOrigins: projects.routeOrigins })
    .from(projects)
    .where(eq(projects.id, projectId));
  const allowlist = projectRouteOrigins(project?.routeOrigins);

  const runs = await db
    .select({ id: testRuns.id, branch: testRuns.branch, metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId))
    .orderBy(asc(testRuns.id));

  let processed = 0;
  for (const run of runs) {
    // A lab run's statuses and traffic are synthetic, so it never feeds the
    // canonical graph — the same rule the live ingest path applies.
    if (isLabRun(run.metadata)) continue;
    const cases = await db
      .select({
        id: testRunsCases.id,
        testCaseId: testRunsCases.testCaseId,
        pageState: testRunsCases.pageState,
        locatorPagesPayloadId: testRunsCases.locatorPagesPayloadId,
      })
      .from(testRunsCases)
      .where(eq(testRunsCases.testRunId, run.id));
    if (cases.length === 0) continue;
    const locatorPagePayloads = await resolveCasePayloadContents(
      db,
      cases.map((c) => c.locatorPagesPayloadId),
    );

    const requests = await db
      .select({
        testRunsCaseId: networkRequests.testRunsCaseId,
        method: networkRequests.method,
        normalizedUrl: networkRequests.normalizedUrl,
        url: networkRequests.url,
        status: networkRequests.status,
        resourceType: networkRequests.resourceType,
      })
      .from(networkRequests)
      .where(eq(networkRequests.testRunId, run.id));

    const byCase = new Map<
      number,
      Array<{ method: string; normalizedUrl: string; status: number; url: string | null; resourceType: string | null }>
    >();
    for (const r of requests) {
      if (!r.normalizedUrl) continue;
      const list = byCase.get(r.testRunsCaseId) ?? [];
      list.push({
        method: r.method,
        normalizedUrl: r.normalizedUrl,
        status: r.status,
        url: r.url,
        resourceType: r.resourceType,
      });
      byCase.set(r.testRunsCaseId, list);
    }

    let origins = collectOwnOrigins(runBaseUrls(run.metadata), allowlist);
    // Older reporters recorded no baseURL; fall back to this run's document
    // request origins so route nodes still form from first-party traffic.
    if (origins.size === 0) origins = originsFromDocumentRequests(requests);
    const branch = project ? await resolveRunBranchTag(db, project, run.metadata, run.branch) : null;

    // Executions share content-addressed payloads, so each is parsed once.
    const locatorPagesById = new Map<number, ReturnType<typeof parseStoredLocatorPages>>();
    for (const [id, content] of locatorPagePayloads) locatorPagesById.set(id, parseStoredLocatorPages(content));
    const rows = cases.map((c) => ({
      testCaseId: c.testCaseId,
      pageState: c.pageState,
      locatorPages: c.locatorPagesPayloadId != null ? locatorPagesById.get(c.locatorPagesPayloadId) : null,
    }));
    const builders = cases.map((c) => ({ items: byCase.get(c.id) ?? [] }));
    await ingestRunGraph(db, projectId, run.id, collectRunGraphReaches(rows, builders, { origins }), { branch });
    processed++;
  }

  return { runsProcessed: processed };
}

// ── Pruning ────────────────────────────────────────────────────────────────

/** Nodes and edges older than a `changes`/branch window are dropped by age. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** `changes` edges track churn; ninety days is all churn needs. */
const CHANGES_EDGE_MAX_AGE_MS = 90 * DAY_MS;
/** Branch-tagged rows outlive their pull request by at most thirty days. */
const BRANCH_ROW_MAX_AGE_MS = 30 * DAY_MS;
/**
 * A `reaches` edge not refreshed in this long is dropped: the test no longer
 * reaches the node, so the edge is dead weight that otherwise grows forever.
 * Generous so a slow-cadence project's live reach is never mistaken for stale.
 */
const REACHES_EDGE_MAX_AGE_MS = 180 * DAY_MS;
/** A soft-deleted (pruned) node is hard-deleted once it has been gone this long. */
const PRUNED_NODE_GRACE_MS = 30 * DAY_MS;
/** A canonical node unseen for this many runs is a candidate for removal. */
const STALE_NODE_RUNS = 30;

/**
 * Delete every branch-tagged node and edge for one branch of a project. Called
 * where the SCM flow learns a pull request closed or merged, so its surface
 * stops shadowing the default branch immediately rather than aging out.
 */
export async function deleteBranchGraphRows(db: DB, projectId: number, branch: string): Promise<number> {
  if (!branch) return 0;
  const nodeCond = and(eq(graphNodes.projectId, projectId), eq(graphNodes.branch, branch));
  const edgeCond = and(eq(graphEdges.projectId, projectId), eq(graphEdges.branch, branch));
  const nodes = await db.delete(graphNodes).where(nodeCond).returning({ id: graphNodes.id });
  const edges = await db.delete(graphEdges).where(edgeCond).returning({ id: graphEdges.id });
  return nodes.length + edges.length;
}

/**
 * Prune `changes` edges last seen more than ninety days ago, independent of
 * `PIWI_RETENTION_DAYS`. Churn needs no longer a window, and commits are unique
 * keys that would otherwise grow with history forever.
 */
export async function pruneChangesEdges(db: DB, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CHANGES_EDGE_MAX_AGE_MS);
  const deleted = await db
    .delete(graphEdges)
    .where(and(eq(graphEdges.kind, 'changes'), lt(graphEdges.lastSeenAt, cutoff)))
    .returning({ id: graphEdges.id });
  return deleted.length;
}

/**
 * Prune branch-tagged rows last seen more than thirty days ago — the fallback
 * for a pull request whose close the SCM flow never learned of.
 */
export async function pruneStaleBranchGraphRows(db: DB, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - BRANCH_ROW_MAX_AGE_MS);
  const nodes = await db
    .delete(graphNodes)
    .where(and(sql`${graphNodes.branch} is not null`, lt(graphNodes.lastSeenAt, cutoff)))
    .returning({ id: graphNodes.id });
  const edges = await db
    .delete(graphEdges)
    .where(and(sql`${graphEdges.branch} is not null`, lt(graphEdges.lastSeenAt, cutoff)))
    .returning({ id: graphEdges.id });
  return nodes.length + edges.length;
}

/** Whether any run of the project recorded a branch. */
async function projectHasKnownBranch(db: DB, projectId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), sql`${testRuns.branch} is not null`, sql`${testRuns.branch} <> ''`))
    .limit(1);
  return row !== undefined;
}

/** How many recent canonical runs are scanned to find the window's non-probe floor. */
const STALE_NODE_RUN_SCAN = STALE_NODE_RUNS * 10;

/**
 * Soft-delete canonical nodes unseen for thirty canonical runs that back no live
 * gap, independently of `PIWI_RETENTION_DAYS` (which is opt-in and cannot be
 * relied on).
 *
 * The window counts default-branch, non-lab runs only — the runs that bump a
 * canonical node's `last_seen_run_id`. Counting pull-request and lab runs (as
 * a naive "last 30 runs" does) lets thirty pull-request runs with no default-branch
 * run in between prune every canonical node, wiping the graph and closing every
 * gap built on it. A node backing any open, snoozed or accepted gap is kept so
 * triage never loses its subject.
 *
 * The node's row is kept but stamped `pruned_at` — the bulk (its `reaches` edges)
 * is deleted, and keeping the row preserves `first_seen` so a re-appearance is
 * not mistaken for new surface. Returns how many nodes were pruned.
 */
export async function pruneStaleCanonicalNodes(db: DB): Promise<number> {
  const projectRows = await db.selectDistinct({ projectId: graphNodes.projectId }).from(graphNodes);
  let removed = 0;

  for (const { projectId } of projectRows) {
    const [proj] = await db
      .select({ id: projects.id, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    const defaultBranch = proj ? await resolveStoredDefaultBranch(db, proj) : FALLBACK_DEFAULT_BRANCH;

    // Runs on the default branch that are not lab runs. Scan a bounded window
    // and drop lab runs before taking the floor. A run whose branch is unknown
    // counts only in a project that never recorded a branch: elsewhere it may be
    // a pull-request run, and counting it would age canonical nodes it never saw.
    const branchKnown = await projectHasKnownBranch(db, projectId);
    const onDefault = branchKnown
      ? eq(testRuns.branch, defaultBranch)
      : or(isNull(testRuns.branch), eq(testRuns.branch, defaultBranch));
    const canonicalRuns = await db
      .select({ id: testRuns.id, metadata: testRuns.metadata })
      .from(testRuns)
      .where(and(eq(testRuns.projectId, projectId), onDefault))
      .orderBy(sql`${testRuns.id} desc`)
      .limit(STALE_NODE_RUN_SCAN);
    const canonical = canonicalRuns.filter((r) => !isLabRun(r.metadata)).slice(0, STALE_NODE_RUNS);
    // Fewer than a full window of canonical runs — nothing has been unseen long enough.
    if (canonical.length < STALE_NODE_RUNS) continue;
    const windowFloor = canonical[canonical.length - 1]!.id;

    const stale = await db
      .select({ id: graphNodes.id, kind: graphNodes.kind, key: graphNodes.key })
      .from(graphNodes)
      .where(
        and(
          eq(graphNodes.projectId, projectId),
          isNull(graphNodes.branch),
          isNull(graphNodes.prunedAt),
          lt(graphNodes.lastSeenRunId, windowFloor),
        ),
      );
    if (stale.length === 0) continue;

    // Keep any node that backs a live gap — open, snoozed or accepted, any
    // detector — so pruning never strips the subject out from under triage and
    // lets the recompute close it.
    const liveGaps = await db
      .select({ key: scenarioGaps.key })
      .from(scenarioGaps)
      .where(and(eq(scenarioGaps.projectId, projectId), inArray(scenarioGaps.status, ['open', 'snoozed', 'accepted'])));
    const keptSubjects = new Set(
      liveGaps.map((g) => {
        const s = subjectFromGapKey(g.key);
        return `${s.kind}\x00${s.key}`;
      }),
    );

    const removable = stale.filter((n) => !keptSubjects.has(`${n.kind}\x00${n.key}`));
    if (removable.length === 0) continue;

    const now = new Date();
    const ids = removable.map((n) => n.id);
    for (let i = 0; i < ids.length; i += 100) {
      await db
        .update(graphNodes)
        .set({ prunedAt: now })
        .where(inArray(graphNodes.id, ids.slice(i, i + 100)));
    }

    // Delete the pruned nodes' canonical edges — the bulk of the graph — by
    // matching their endpoints, grouped by kind so keys batch together.
    const keysByKind = new Map<string, string[]>();
    for (const n of removable) {
      const list = keysByKind.get(n.kind) ?? [];
      list.push(n.key);
      keysByKind.set(n.kind, list);
    }
    for (const [kind, keys] of keysByKind) {
      for (let i = 0; i < keys.length; i += 100) {
        const slice = keys.slice(i, i + 100);
        await db
          .delete(graphEdges)
          .where(
            and(
              eq(graphEdges.projectId, projectId),
              isNull(graphEdges.branch),
              eq(graphEdges.toKind, kind),
              inArray(graphEdges.toKey, slice),
            ),
          );
        await db
          .delete(graphEdges)
          .where(
            and(
              eq(graphEdges.projectId, projectId),
              isNull(graphEdges.branch),
              eq(graphEdges.fromKind, kind),
              inArray(graphEdges.fromKey, slice),
            ),
          );
      }
    }
    removed += removable.length;
  }
  return removed;
}

/**
 * Prune `reaches` edges last seen more than {@link REACHES_EDGE_MAX_AGE_MS} ago,
 * independent of `PIWI_RETENTION_DAYS`. A reach that a run keeps observing is
 * bumped every run, so only a reach a test genuinely stopped making ages out;
 * without this the edge table grows one row per (test, node) pair forever.
 */
export async function pruneStaleReachesEdges(db: DB, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - REACHES_EDGE_MAX_AGE_MS);
  const deleted = await db
    .delete(graphEdges)
    .where(and(eq(graphEdges.kind, 'reaches'), lt(graphEdges.lastSeenAt, cutoff)))
    .returning({ id: graphEdges.id });
  return deleted.length;
}

/**
 * Hard-delete nodes the staleness sweep soft-deleted (`pruned_at`) more than
 * {@link PRUNED_NODE_GRACE_MS} ago, so the vanished surface is kept only long
 * enough to avoid re-flagging a brief reappearance as drift, not forever. A node
 * that backs a live gap is never hard-deleted, and every remaining edge on a
 * deleted node's endpoints goes with it.
 */
export async function hardDeletePrunedNodes(db: DB, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PRUNED_NODE_GRACE_MS);
  const doomed = await db
    .select({ id: graphNodes.id, projectId: graphNodes.projectId, kind: graphNodes.kind, key: graphNodes.key })
    .from(graphNodes)
    .where(and(sql`${graphNodes.prunedAt} is not null`, lt(graphNodes.prunedAt, cutoff)));
  if (doomed.length === 0) return 0;

  // Keep any node that gained a live gap while soft-deleted.
  const byProject = new Map<number, typeof doomed>();
  for (const n of doomed) {
    const list = byProject.get(n.projectId) ?? [];
    list.push(n);
    byProject.set(n.projectId, list);
  }

  let removed = 0;
  for (const [projectId, nodes] of byProject) {
    const liveGaps = await db
      .select({ key: scenarioGaps.key })
      .from(scenarioGaps)
      .where(and(eq(scenarioGaps.projectId, projectId), inArray(scenarioGaps.status, ['open', 'snoozed', 'accepted'])));
    const keptSubjects = new Set(
      liveGaps.map((g) => {
        const s = subjectFromGapKey(g.key);
        return `${s.kind}\x00${s.key}`;
      }),
    );
    const removable = nodes.filter((n) => !keptSubjects.has(`${n.kind}\x00${n.key}`));
    if (removable.length === 0) continue;

    // Delete each doomed node's remaining edges by endpoint, then the node rows.
    const keysByKind = new Map<string, string[]>();
    for (const n of removable) {
      const list = keysByKind.get(n.kind) ?? [];
      list.push(n.key);
      keysByKind.set(n.kind, list);
    }
    for (const [kind, keys] of keysByKind) {
      for (let i = 0; i < keys.length; i += 100) {
        const slice = keys.slice(i, i + 100);
        await db
          .delete(graphEdges)
          .where(
            and(eq(graphEdges.projectId, projectId), eq(graphEdges.toKind, kind), inArray(graphEdges.toKey, slice)),
          );
        await db
          .delete(graphEdges)
          .where(
            and(eq(graphEdges.projectId, projectId), eq(graphEdges.fromKind, kind), inArray(graphEdges.fromKey, slice)),
          );
      }
    }
    const ids = removable.map((n) => n.id);
    for (let i = 0; i < ids.length; i += 100) {
      await db.delete(graphNodes).where(inArray(graphNodes.id, ids.slice(i, i + 100)));
    }
    removed += removable.length;
  }
  return removed;
}

/**
 * Delete the graph rows whose newest evidence was a run that is being deleted, so
 * age-based run retention does not leave the graph tables pointing at runs that
 * no longer exist. A node or edge whose `last_seen_run_id` is in `runIds` has not
 * been observed since — retention deletes the oldest runs, so an active row's
 * last-seen is a surviving run — and is removed with its endpoints' edges.
 */
export async function deleteGraphRowsForRuns(db: DB, projectId: number, runIds: number[]): Promise<number> {
  if (runIds.length === 0) return 0;
  let removed = 0;
  for (let i = 0; i < runIds.length; i += 100) {
    const slice = runIds.slice(i, i + 100);
    const edges = await db
      .delete(graphEdges)
      .where(and(eq(graphEdges.projectId, projectId), inArray(graphEdges.lastSeenRunId, slice)))
      .returning({ id: graphEdges.id });
    const nodes = await db
      .delete(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), inArray(graphNodes.lastSeenRunId, slice)))
      .returning({ id: graphNodes.id });
    removed += edges.length + nodes.length;
  }
  return removed;
}

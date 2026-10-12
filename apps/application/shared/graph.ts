/**
 * The feature graph — pure vocabulary and key helpers shared by the ingest
 * path, the detectors and the demo. A node is identified by `(kind, key)`; an
 * edge connects two typed endpoints. Everything here is dependency-free so the
 * demo runs the same code in the browser.
 */

import type { AppManifest, ManifestSource } from '#shared/types';
import { PATH_ANCHOR_HOST, pageKey as pageNodeKey } from '@piwitests/core/page-key';
import {
  filePageTarget,
  fileRouteTarget,
  pageKeyMatchesTarget,
  pathSegments,
  segmentsMatch,
  type ConventionTarget,
} from '@piwitests/core/file-routes';

export { filePageTarget, fileRouteTarget, pageKeyMatchesTarget, type ConventionTarget };

export type GraphNodeKind = 'feature' | 'page' | 'control' | 'link' | 'route' | 'handler' | 'dependency' | 'file';

/**
 * Edge endpoint kinds — the node kinds plus the entities named by id or key
 * rather than stored as nodes.
 */
export type GraphEndpointKind = GraphNodeKind | 'test' | 'cluster' | 'commit' | 'ticket' | 'owner';

export type GraphEdgeKind =
  | 'links'
  | 'contains'
  | 'triggers'
  | 'loads'
  | 'handled-by'
  | 'calls'
  | 'imports'
  | 'groups'
  | 'reaches'
  | 'checks'
  | 'uses'
  | 'drives'
  | 'changes'
  | 'affects'
  | 'caused-by'
  | 'owns';

/** How a node or edge came to be known. */
export type GraphOrigin =
  | 'observed'
  | 'manifest'
  | 'openapi'
  | 'convention'
  | 'import'
  | 'coverage'
  | 'usage'
  | 'manual'
  /** Derived from other edges, below full confidence: a feature grouping what its pages hold. */
  | 'inferred';

/**
 * A route node's key is `METHOD /normalized/pattern`, matching how the comment
 * examples and the PR section refer to endpoints (`POST /api/orders`). The query
 * is not part of it: a call with `?page=` and one with `?role=` reach one node.
 */
export function routeNodeKey(method: string, normalizedUrl: string): string {
  return routeKeyWithoutQuery(`${method.toUpperCase()} ${normalizedUrl}`);
}

/** A route key without its query: `GET /api/users?page=%3Credacted%3E` is `GET /api/users`. */
export function routeKeyWithoutQuery(key: string): string {
  const q = key.indexOf('?');
  return q === -1 ? key : key.slice(0, q);
}

/** Split a route key back into its method and pattern. */
export function parseRouteNodeKey(key: string): { method: string; pattern: string } {
  const space = key.indexOf(' ');
  if (space < 0) return { method: '', pattern: key };
  return { method: key.slice(0, space), pattern: key.slice(space + 1) };
}

/**
 * A page node's key: the normalized path pattern of a page URL, from
 * `@piwitests/core/page-key` — the same key the reporter records for the page
 * each locator call ran on, so the two can be joined.
 */
export { pageNodeKey };

/** The origin (`scheme://host:port`) of a URL, or null when it has none. */
export function urlOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Collect a run's own origins from its Playwright `baseURL`s and a per-project
 * allowlist. Route nodes come only from requests to one of these, so third-party
 * beacons and CDN assets never enter the graph. An entry may be a full URL or a
 * bare origin; both reduce to their origin.
 */
export function collectOwnOrigins(
  baseUrls: Array<string | null | undefined>,
  allowlist: Array<string | null | undefined> = [],
): Set<string> {
  const origins = new Set<string>();
  for (const entry of [...baseUrls, ...allowlist]) {
    const origin = urlOrigin(entry);
    if (origin) origins.add(origin);
  }
  return origins;
}

/**
 * True when a request URL targets one of the run's own origins. With no known
 * origin the caller keeps every route (it cannot tell own from third-party);
 * once an origin is known, only requests to it become route nodes.
 */
export function isOwnOriginRequest(url: string | null | undefined, origins: Set<string>): boolean {
  if (origins.size === 0) return true;
  const origin = urlOrigin(url);
  return origin != null && origins.has(origin);
}

/** The base URLs a run's Playwright config recorded, one per configured project. */
export function runBaseUrls(runMetadata: unknown): string[] {
  const meta = runMetadata as { htmlReport?: { projects?: Array<{ use?: { baseURL?: unknown } } | null> } } | null;
  const urls: string[] = [];
  for (const p of meta?.htmlReport?.projects ?? []) {
    const baseUrl = p?.use?.baseURL;
    if (typeof baseUrl === 'string' && baseUrl) urls.push(baseUrl);
  }
  return urls;
}

/** The per-project route-origin allowlist stored on the project row. */
export function projectRouteOrigins(routeOrigins: unknown): string[] {
  if (!Array.isArray(routeOrigins)) return [];
  return routeOrigins.filter((o): o is string => typeof o === 'string' && o.length > 0);
}

/**
 * Origins of a run's own document requests (navigations). The fallback for runs
 * from reporters that predate the recorded Playwright `baseURL`: a `document`
 * request goes to the application under test, so its origin is a safe own-origin
 * seed. Returns an empty set when no document request is present, in which case
 * the caller keeps every route rather than filtering them all out.
 */
export function originsFromDocumentRequests(
  requests: Array<{ url?: string | null; resourceType?: string | null }>,
): Set<string> {
  const origins = new Set<string>();
  for (const r of requests) {
    if (r.resourceType !== 'document') continue;
    const origin = urlOrigin(r.url);
    if (origin) origins.add(origin);
  }
  return origins;
}

/** The `from_key` of a `reaches`/`checks` edge is the test case's id as text. */
export function testEndpointKey(testCaseId: number): string {
  return String(testCaseId);
}

// ── File-routing conventions ─────────────────────────────────────────────────
//
// Resolve a changed source file to the graph node it implements, so change
// coverage can see reach into a route handler or a page through the file's own
// node — not only through a test's locator call site. The conventions live in
// core (`@piwitests/core/file-routes`), shared with the editor service.

/** True when a file's route target resolves to the given `route` node key. */
export function routeKeyMatchesTarget(target: ConventionTarget, routeKey: string): boolean {
  const { method, pattern } = parseRouteNodeKey(routeKey);
  if (target.method && target.method !== method.toUpperCase()) return false;
  return segmentsMatch(target, pathSegments(pattern));
}

// ── Control and link keys (size rule 3) ──────────────────────────────────────
//
// A control or link node's key collapses the volatile parts of the accessible
// name, so a table of five hundred orders is one control, not five hundred. The
// key is project-global: the same control on many pages is one node reached by a
// `contains` edge from each page.

/**
 * Collapse digits, dates and ids in an accessible name. ISO dates and UUIDs
 * become named placeholders before bare digit runs do, so `Order 2026-01-02` and
 * `Order 3f2c…` template to the same shape as `Order 5`. Whitespace is
 * normalized and the result trimmed.
 */
export function templateAccessibleName(name: string): string {
  return (name ?? '')
    .replace(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/g, '{date}')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')
    .replace(/\b[0-9a-f]{16,}\b/gi, '{id}')
    .replace(/\d+/g, '{n}')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A control node's key is `role:templated-name`; role defaults to `generic`. */
export function controlNodeKey(role: string | null | undefined, name: string): string {
  const r = (role || 'generic').toLowerCase();
  return `${r}:${templateAccessibleName(name)}`;
}

/** A link node's key is `link:templated-name`. */
export function linkNodeKey(name: string): string {
  return `link:${templateAccessibleName(name)}`;
}

/** Size rule 3 — a page keeps at most this many distinct controls after templating. */
export const MAX_CONTROLS_PER_PAGE = 200;

/**
 * Apply the per-page control cap: dedupe already-templated keys in order and keep
 * at most {@link MAX_CONTROLS_PER_PAGE}. Templating collapses the bulk, and the
 * cap bounds a pathological page that still exposes hundreds of distinct
 * controls.
 */
export function capPageControlKeys(keys: Iterable<string>, max = MAX_CONTROLS_PER_PAGE): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

// ── Handler and dependency keys ──────────────────────────────────────────────

/** A handler node's key is its source file path, forward-slashed. */
export function handlerNodeKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').trim();
}

/** A dependency node's key is a stable short name for the outbound call target. */
export function dependencyNodeKey(name: string): string {
  return name.trim();
}

/**
 * Construct the conventional Nitro handler file for a route key, e.g.
 * `POST /api/orders` → `server/api/orders.post.ts` and
 * `PATCH /api/orders/:id` → `server/api/orders/[id].patch.ts`. `:id`/`:uuid`
 * placeholders become `[id]`/`[uuid]` segments. Returns null for a root or
 * empty path. The result is a convention, never an observation, and callers
 * label the edge accordingly.
 */
export function conventionalHandlerFile(routeKey: string): string | null {
  const { method, pattern } = parseRouteNodeKey(routeKey);
  const q = pattern.indexOf('?');
  const path = q < 0 ? pattern : pattern.slice(0, q);
  const segs = pathSegments(path).map((s) => (s.startsWith(':') ? `[${s.slice(1)}]` : s));
  if (segs.length === 0) return null;
  // `server/api/**` mounts under `/api`; everything else is `server/routes/**`.
  const underApi = segs[0] === 'api';
  const dir = underApi ? 'server/api' : 'server/routes';
  const body = underApi ? segs.slice(1) : segs;
  if (body.length === 0) return null;
  const leaf = body[body.length - 1]!;
  const rest = body.slice(0, -1);
  const methodSuffix = method ? `.${method.toLowerCase()}` : '';
  return `${dir}/${[...rest, `${leaf}${methodSuffix}.ts`].join('/')}`;
}

// ── Trigger window (control → route) ─────────────────────────────────────────

/** A request fired within this many ms of a step's window still counts as caused by it. */
export const TRIGGER_WINDOW_PAD_MS = 50;

/**
 * True when a network request's start time falls inside an action step's window
 * `[startedAt − pad, startedAt + duration + pad]`. The pad absorbs the small gap
 * between the click resolving and the request leaving the browser.
 */
export function requestInStepWindow(
  requestStart: number | null | undefined,
  step: { startedAt: number; duration: number },
  padMs = TRIGGER_WINDOW_PAD_MS,
): boolean {
  if (requestStart == null || !Number.isFinite(requestStart) || !Number.isFinite(step.startedAt)) return false;
  const start = step.startedAt - padMs;
  const end = step.startedAt + Math.max(0, step.duration || 0) + padMs;
  return requestStart >= start && requestStart <= end;
}

/**
 * The confidence of a `triggers` edge: the share of executions in which the
 * control → route co-occurrence held. Clamped to `[0, 1]`; zero executions is
 * zero confidence.
 */
export function triggerConfidence(heldIn: number, executions: number): number {
  if (!executions || executions <= 0) return 0;
  return Math.max(0, Math.min(1, heldIn / executions));
}

// ── Link target resolution (page → page) ─────────────────────────────────────

/**
 * Resolve a link's `href` to the `page` node key it targets. Fragment-only,
 * `mailto:`, `tel:` and `javascript:` hrefs resolve to null. When origins are
 * known, an absolute off-origin href resolves to null; a relative href is always
 * kept. `base` anchors a relative href when given.
 */
export function linkTargetPageKey(
  href: string | null | undefined,
  origins: Set<string> = new Set(),
  base?: string | null,
): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(?:mailto|tel|javascript):/i.test(trimmed)) return null;
  const anchorBase = base && /^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `http://${PATH_ANCHOR_HOST}`;
  let absolute: string;
  try {
    absolute = new URL(trimmed, anchorBase).toString();
  } catch {
    return null;
  }
  const origin = urlOrigin(absolute);
  const isAnchor = origin === `http://${PATH_ANCHOR_HOST}`;
  if (origins.size > 0 && !isAnchor && origin != null && !origins.has(origin)) return null;
  const key = pageNodeKey(absolute);
  return key || null;
}

// ── Graph specs (pure descriptors upsert paths share) ────────────────────────

/** A node to upsert, produced by a pure builder and mapped to a DB row by ingest. */
export interface GraphNodeSpec {
  kind: GraphNodeKind;
  key: string;
  attrs?: unknown;
  origin?: GraphOrigin;
}

/** An edge to upsert, produced by a pure builder and mapped to a DB row by ingest. */
export interface GraphEdgeSpec {
  fromKind: GraphEndpointKind;
  fromKey: string;
  toKind: GraphEndpointKind;
  toKey: string;
  kind: GraphEdgeKind;
  confidence?: number | null;
  origin?: GraphOrigin;
  evidence?: unknown;
}

/** A page's observed inventory: its controls, its links, and the routes it loads. */
export interface PageInventoryInput {
  /** The page's node key (already normalized, e.g. from {@link pageNodeKey}). */
  pageKey: string;
  /** The page's real URL, used to resolve relative link hrefs before normalizing. */
  pageUrl?: string;
  controls: Array<{ role: string | null; name: string }>;
  links: Array<{ name: string; href: string | null }>;
  /** Routes the page loaded during navigation settle (document and XHR). */
  loadsRouteKeys?: string[];
}

/**
 * Build `control`/`link` nodes and `contains`/`links`/`loads` edges from one or
 * more pages' inventories. Control names are templated and capped per page; link
 * targets are resolved to page keys, own-origin only. Pure — the ingest path
 * upserts the returned specs, and the demo runs the same builder.
 */
export function buildPageInventoryGraph(
  pages: PageInventoryInput[],
  options: { origins?: Set<string> } = {},
): { nodes: GraphNodeSpec[]; edges: GraphEdgeSpec[] } {
  const origins = options.origins ?? new Set<string>();
  const nodes = new Map<string, GraphNodeSpec>();
  const edges = new Map<string, GraphEdgeSpec>();
  const addNode = (spec: GraphNodeSpec) => {
    nodes.set(`${spec.kind}\x00${spec.key}`, spec);
  };
  const addEdge = (spec: GraphEdgeSpec) => {
    edges.set(`${spec.fromKind}\x00${spec.fromKey}\x00${spec.kind}\x00${spec.toKind}\x00${spec.toKey}`, spec);
  };

  for (const page of pages) {
    if (!page.pageKey) continue;
    addNode({ kind: 'page', key: page.pageKey, attrs: null });

    // Controls, templated and capped per page.
    const controlKeys = capPageControlKeys(
      page.controls.filter((c) => c.name?.trim()).map((c) => controlNodeKey(c.role, c.name)),
    );
    for (const key of controlKeys) {
      const [role] = key.split(':', 1);
      addNode({ kind: 'control', key, attrs: { role } });
      addEdge({ fromKind: 'page', fromKey: page.pageKey, toKind: 'control', toKey: key, kind: 'contains' });
    }

    // Links: a `link` node and a `contains` edge, plus a `links` page → page edge
    // when the href resolves to an own-origin page.
    const linkKeys = capPageControlKeys(page.links.filter((l) => l.name?.trim()).map((l) => linkNodeKey(l.name)));
    const linkKeySet = new Set(linkKeys);
    for (const link of page.links) {
      if (!link.name?.trim()) continue;
      const key = linkNodeKey(link.name);
      if (!linkKeySet.has(key)) continue;
      addNode({ kind: 'link', key, attrs: link.href ? { href: link.href } : null });
      addEdge({ fromKind: 'page', fromKey: page.pageKey, toKind: 'link', toKey: key, kind: 'contains' });
      // Anchor a relative href against the page's real URL, not its bare path
      // key, so `<a href="details">` on /orders/:id resolves under /orders.
      const targetPage = linkTargetPageKey(link.href, origins, page.pageUrl ?? page.pageKey);
      if (targetPage && targetPage !== page.pageKey) {
        addNode({ kind: 'page', key: targetPage, attrs: null });
        addEdge({ fromKind: 'page', fromKey: page.pageKey, toKind: 'page', toKey: targetPage, kind: 'links' });
      }
    }

    for (const routeKey of page.loadsRouteKeys ?? []) {
      addNode({ kind: 'route', key: routeKey, attrs: null });
      addEdge({ fromKind: 'page', fromKey: page.pageKey, toKind: 'route', toKey: routeKey, kind: 'loads' });
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** One request's route, its handler (observed or to be conventional) and its calls. */
export interface RequestSpansInput {
  routeKey: string;
  /** The handler's source file from the root span, when the instrumentation carries it. */
  handlerFile?: string | null;
  /** Outbound dependency names from the child spans under the request's root span. */
  dependencies?: string[];
}

/**
 * Build `handler`/`dependency` nodes and `handled-by`/`calls` edges from a run's
 * request spans. A handler comes from the root span's handler field when present
 * (origin `observed`); otherwise the Nitro convention constructs it from the
 * route (origin `convention`). Each child span's dependency becomes a `calls`
 * edge from the handler. Pure.
 */
export function buildRequestGraph(requests: RequestSpansInput[]): {
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
} {
  const nodes = new Map<string, GraphNodeSpec>();
  const edges = new Map<string, GraphEdgeSpec>();
  const addNode = (spec: GraphNodeSpec) => {
    nodes.set(`${spec.kind}\x00${spec.key}`, spec);
  };
  const addEdge = (spec: GraphEdgeSpec) => {
    edges.set(`${spec.fromKind}\x00${spec.fromKey}\x00${spec.kind}\x00${spec.toKind}\x00${spec.toKey}`, spec);
  };

  for (const req of requests) {
    if (!req.routeKey) continue;
    const observed = req.handlerFile?.trim() || null;
    const handlerFile = observed ?? conventionalHandlerFile(req.routeKey);
    if (!handlerFile) continue;
    const handlerKey = handlerNodeKey(handlerFile);
    const origin: GraphOrigin = observed ? 'observed' : 'convention';
    addNode({ kind: 'route', key: req.routeKey, attrs: null });
    addNode({ kind: 'handler', key: handlerKey, attrs: null, origin });
    addEdge({
      fromKind: 'route',
      fromKey: req.routeKey,
      toKind: 'handler',
      toKey: handlerKey,
      kind: 'handled-by',
      origin,
    });
    for (const dep of req.dependencies ?? []) {
      const name = dependencyNodeKey(dep);
      if (!name) continue;
      addNode({ kind: 'dependency', key: name, attrs: null });
      addEdge({ fromKind: 'handler', fromKey: handlerKey, toKind: 'dependency', toKey: name, kind: 'calls' });
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** One observed control → route co-occurrence within an execution. */
export interface TriggerObservation {
  controlKey: string;
  routeKey: string;
}

/**
 * Build `triggers` edges from per-execution co-occurrences. A pair is counted at
 * most once per execution; the edge's confidence is the share of executions in
 * which the pair held. Pure.
 */
export function buildTriggerEdges(executions: TriggerObservation[][]): GraphEdgeSpec[] {
  const total = executions.length;
  if (total === 0) return [];
  const held = new Map<string, { controlKey: string; routeKey: string; count: number }>();
  for (const exec of executions) {
    const seen = new Set<string>();
    for (const { controlKey, routeKey } of exec) {
      if (!controlKey || !routeKey) continue;
      const id = `${controlKey}\x00${routeKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = held.get(id) ?? { controlKey, routeKey, count: 0 };
      entry.count++;
      held.set(id, entry);
    }
  }
  return [...held.values()].map((e) => ({
    fromKind: 'control' as const,
    fromKey: e.controlKey,
    toKind: 'route' as const,
    toKey: e.routeKey,
    kind: 'triggers' as const,
    confidence: triggerConfidence(e.count, total),
    evidence: { executions: total, held: e.count },
  }));
}

// ── Declared surface (manifest / OpenAPI) ────────────────────────────────────
//
// The declared surface says what the application exposes ahead of any test
// reaching it. A route the manifest declares becomes a `route` node whose key is
// aligned with the observed keys, so a declared route the suite later exercises
// shares one node (and gains a `reaches` edge, dropping out of the declared-
// never-hit detector). Documented response codes ride the node's attrs, and so
// do the patterns as declared, which {@link createDeclaredMatcher} reads to match
// the requests the key cannot line up with (`/blog/{slug}` and `/blog/hello`).

/** The most declared patterns one node keeps in its attrs. */
const MAX_DECLARED_PATTERNS = 10;

/**
 * A declared pattern without its query string. A `?` inside `{…}` or `[…]` marks
 * an optional parameter (`{page?}`), not a query.
 */
function declaredPath(pattern: string): string {
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && depth > 0) depth--;
    else if (c === '?' && depth === 0) return pattern.slice(0, i);
  }
  return pattern;
}

/**
 * Canonicalize a declared path pattern so it lines up with observed route keys.
 * Framework placeholders — `:param`, `{param}`, `[param]` — collapse to `:uuid`
 * for a parameter that reads as a uuid (see {@link isUuidParameter}), otherwise
 * `:id`, matching how
 * {@link normalizeRoute} collapses numeric and uuid segments of a real request.
 */
export function normalizeManifestPattern(pattern: string): string {
  const path = declaredPath(pattern);
  const withHost = path.startsWith('/') ? path : `/${path}`;
  return (
    '/' +
    pathSegments(withHost)
      .map((seg) => {
        const placeholder = /^(?::.+|\{.+\}|\[.+\])$/.test(seg);
        if (!placeholder) return seg;
        const { name, constraints } = parameterParts(seg.replace(/^[:{[]+|[}\]]+$/g, ''));
        return isUuidParameter(name, constraints) ? ':uuid' : ':id';
      })
      .join('/')
  );
}

/** The graph origin a manifest source maps to. */
function manifestOrigin(source: ManifestSource): GraphOrigin {
  return source === 'openapi' ? 'openapi' : 'manifest';
}

/**
 * Build declared `route`/`page`/`handler` nodes and `handled-by` edges from a
 * manifest. Route nodes carry the documented response codes in their attrs so
 * the success-only detector can name the error codes a route documents but never
 * returned under test. Pure — the ingest path upserts the returned specs.
 */
export function buildManifestGraph(
  manifest: AppManifest,
  source: ManifestSource,
): { nodes: GraphNodeSpec[]; edges: GraphEdgeSpec[] } {
  const origin = manifestOrigin(source);
  const nodes = new Map<string, GraphNodeSpec>();
  const edges = new Map<string, GraphEdgeSpec>();
  const addNode = (spec: GraphNodeSpec) => {
    nodes.set(`${spec.kind}\x00${spec.key}`, spec);
  };
  const addEdge = (spec: GraphEdgeSpec) => {
    edges.set(`${spec.fromKind}\x00${spec.fromKey}\x00${spec.kind}\x00${spec.toKind}\x00${spec.toKey}`, spec);
  };

  // Patterns that fold to one key (`/users/{id:int}` and `/users/{name}`) share
  // its node, which keeps every one of them and the union of their codes.
  const prior = (kind: string, key: string) =>
    (nodes.get(`${kind}\x00${key}`)?.attrs ?? null) as { responses?: number[]; patterns?: string[] } | null;
  const withPattern = (patterns: string[] | undefined, pattern: string) =>
    [...new Set([...(patterns ?? []), declaredPath(pattern)])].slice(0, MAX_DECLARED_PATTERNS);

  for (const route of manifest.routes ?? []) {
    if (!route?.method || !route?.pattern) continue;
    const key = routeNodeKey(route.method, normalizeManifestPattern(route.pattern));
    const before = prior('route', key);
    const responses = Array.isArray(route.responses)
      ? [...new Set([...(before?.responses ?? []), ...route.responses.filter((c) => Number.isInteger(c))])].sort(
          (a, b) => a - b,
        )
      : (before?.responses ?? []);
    const patterns = withPattern(before?.patterns, route.pattern);
    addNode({ kind: 'route', key, origin, attrs: { declared: true, responses, patterns } });
    const handler = route.handler?.trim();
    if (handler) {
      const handlerKey = handlerNodeKey(handler);
      addNode({ kind: 'handler', key: handlerKey, origin, attrs: { declared: true } });
      addEdge({ fromKind: 'route', fromKey: key, toKind: 'handler', toKey: handlerKey, kind: 'handled-by', origin });
    }
  }

  for (const page of manifest.pages ?? []) {
    if (!page?.pattern) continue;
    const key = pageNodeKey(normalizeManifestPattern(page.pattern));
    if (!key) continue;
    const patterns = withPattern(prior('page', key)?.patterns, page.pattern);
    addNode({
      kind: 'page',
      key,
      origin,
      attrs: page.name ? { declared: true, name: page.name, patterns } : { declared: true, patterns },
    });
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** A declared path segment, as {@link createDeclaredMatcher} reads it. */
type DeclaredSegment =
  | { kind: 'literal'; text: string }
  | { kind: 'param'; accepts: 'any' | 'number' | 'uuid'; optional: boolean }
  | { kind: 'mixed'; regex: RegExp }
  | { kind: 'catch-all'; min: number };

/** A declared pattern read for matching, with the segment counts a path needs to match it. */
interface DeclaredPattern {
  segments: DeclaredSegment[];
  min: number;
  max: number;
}

/** Route constraints that accept only a number, the segments observed keys collapse to `:id`. */
const NUMERIC_CONSTRAINTS = new Set(['int', 'long', 'decimal', 'double', 'float', 'min', 'max', 'range']);

const NUMBER_SEGMENT = /^-?\d+(?:\.\d+)?$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A catch-all of zero or more segments: `{**path}`, `{*path}`, `**`, `**:path`, `[...path]`, `:path*`. */
const CATCH_ALL_SEGMENT = /^(?:\{\*{1,2}[^{}]*\}|\*\*(?::.*)?|\[\.\.\.[^\]]+\]|:[^/]+\*)$/;

/** A catch-all of one or more segments: `:path+`. */
const CATCH_ALL_ONE_OR_MORE_SEGMENT = /^:[^/]+\+$/;

/** A whole-segment parameter: `:id`, `*`, `{id}`, `{id:int}`, `{id?}`, `[[id]]`, `[id]`. */
const PARAM_SEGMENT = /^(?::(.+)|\*|\{([^{}]+)\}|\[\[([^\]]+)\]\]|\[([^\]]+)\])$/;

/** The parameters of a segment mixing literals and parameters. */
const MIXED_PARAM = /(\{[^{}]*\}|\[\[[^\][]*\]\]|\[[^\][]*\])/;

/** A segment compared without case or percent-encoding, as routers match it. */
function comparableSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}

/** A literal segment as an observed key holds it: `2024` collapses to `:id`, a uuid to `:uuid`. */
function observedLiteral(segment: string): string {
  return comparableSegment(pageNodeKey(`/${segment}`)?.slice(1) || segment);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A parameter's name, constraint names and whether it may be left out: `{id:int?}` is `id`, `[int]`, optional. */
function parameterParts(body: string): { name: string; constraints: string[]; optional: boolean } {
  const optional = body.endsWith('?') || body.includes('=');
  const [name = '', ...constraints] = body.replace(/\?$/, '').split('=')[0]!.split(':');
  return { name, constraints: constraints.map((c) => c.split('(')[0]!.toLowerCase()), optional };
}

/**
 * True for a parameter holding a uuid: a `guid` constraint, or a name ending with
 * uuid or guid (`orderGuid`) or starting with it as a word (`uuid_part`, `uuidPart`,
 * not `guide`).
 */
function isUuidParameter(name: string, constraints: string[]): boolean {
  return (
    constraints.includes('guid') || /(?:uuid|guid)$/i.test(name) || /^(?:[Uu]uid|UUID|[Gg]uid|GUID)(?![a-z])/.test(name)
  );
}

function compileDeclaredSegment(segment: string, last: boolean): DeclaredSegment {
  if (last && CATCH_ALL_SEGMENT.test(segment)) return { kind: 'catch-all', min: 0 };
  if (last && CATCH_ALL_ONE_OR_MORE_SEGMENT.test(segment)) return { kind: 'catch-all', min: 1 };
  const param = PARAM_SEGMENT.exec(segment);
  if (param) {
    const parts = parameterParts(param[1] ?? param[2] ?? param[3] ?? param[4] ?? '');
    const accepts = isUuidParameter(parts.name, parts.constraints)
      ? 'uuid'
      : parts.constraints.some((c) => NUMERIC_CONSTRAINTS.has(c))
        ? 'number'
        : 'any';
    return { kind: 'param', accepts, optional: parts.optional || param[3] !== undefined };
  }
  if (MIXED_PARAM.test(segment)) {
    // A literal mixing parameters (`v{version}`, `{name}.{ext?}`): each parameter takes one
    // or more characters, and a last optional one may be left out with the literal before it.
    const parts = segment.split(MIXED_PARAM);
    const pieces: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (i % 2 === 0) {
        pieces.push(escapeRegExp(comparableSegment(part)));
        continue;
      }
      const optional = part.startsWith('[[') || parameterParts(part.slice(1, -1)).optional;
      if (optional && i === parts.length - 2 && parts[i + 1] === '') pieces.push(`(?:${pieces.pop() ?? ''}.+)?`);
      else pieces.push('.+');
    }
    return { kind: 'mixed', regex: new RegExp(`^${pieces.join('')}$`) };
  }
  return { kind: 'literal', text: observedLiteral(segment) };
}

/** Read a declared pattern from any source's syntax: ASP.NET Core, OpenAPI, Nitro, Nuxt file routes. */
function compileDeclaredPattern(pattern: string): DeclaredPattern {
  const parts = pathSegments(declaredPath(pattern));
  const segments = parts.map((segment, i) => compileDeclaredSegment(segment, i === parts.length - 1));
  let min = 0;
  for (const s of segments) {
    if (s.kind === 'catch-all') min += s.min;
    else if (!(s.kind === 'param' && s.optional)) min++;
  }
  const catchAll = segments.at(-1)?.kind === 'catch-all';
  return { segments, min, max: catchAll ? Infinity : segments.length };
}

/**
 * How closely a declared segment matches an observed one, highest first: a
 * literal, a literal mixing parameters, a typed parameter, any parameter; -1
 * when it does not match. The observed segment is already comparable.
 */
function segmentRank(declared: DeclaredSegment, observed: string): number {
  switch (declared.kind) {
    case 'literal':
      return observed === declared.text ? 4 : -1;
    case 'mixed':
      return declared.regex.test(observed) ? 3 : -1;
    case 'param':
      if (declared.accepts === 'any') return 1;
      if (declared.accepts === 'number') return observed === ':id' || NUMBER_SEGMENT.test(observed) ? 2 : -1;
      return observed === ':uuid' || UUID_SEGMENT.test(observed) ? 2 : -1;
    case 'catch-all':
      return 0;
  }
}

/**
 * The rank of each declared segment against the observed segments from `j` on,
 * or null when the pattern does not match them. An optional parameter is tried
 * both holding a segment and left out, and the closer match is kept.
 */
function matchSegments(segments: DeclaredSegment[], i: number, observed: string[], j: number): number[] | null {
  if (i === segments.length) return j === observed.length ? [] : null;
  const segment = segments[i]!;
  if (segment.kind === 'catch-all') return observed.length - j >= segment.min ? [0] : null;
  let best: number[] | null = null;
  if (j < observed.length) {
    const rank = segmentRank(segment, observed[j]!);
    const rest = rank < 0 ? null : matchSegments(segments, i + 1, observed, j + 1);
    if (rest) best = [rank, ...rest];
  }
  if (segment.kind === 'param' && segment.optional) {
    const rest = matchSegments(segments, i + 1, observed, j);
    if (rest && (!best || compareRanks([0, ...rest], best) > 0)) best = [0, ...rest];
  }
  return best;
}

/**
 * Order two matches segment by segment; a match that ends where the other goes
 * on through a catch-all is the closer one.
 */
function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 5;
    const y = b[i] ?? 5;
    if (x !== y) return x - y;
  }
  return 0;
}

/** The patterns a declared node was declared under: its attrs' `patterns`, else its own key. */
function declaredPatternsOf(kind: string, key: string, attrs: unknown): string[] {
  const stored = (attrs as { patterns?: unknown } | null)?.patterns;
  const patterns = Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string' && p !== '') : [];
  if (patterns.length > 0) return patterns;
  return [kind === 'route' ? parseRouteNodeKey(key).pattern : key];
}

/** A declared `route` or `page` node, as the graph stores it. */
export interface DeclaredSurfaceNode {
  kind: string;
  key: string;
  attrs?: unknown;
}

/**
 * Match observed route and page keys to the declared nodes that serve them. A
 * declared key alone lines up only with numeric and uuid segments, the ones
 * {@link normalizeRoute} collapses; this reads the patterns as declared, so
 * `/blog/{slug}` serves `/blog/hello-world`, `/files/{**path}` serves
 * `/files/a/b.txt` and `/api/v{version}/orders` serves `/api/v1/orders`. Typed
 * parameters keep their type (`{id:int}` serves `/orders/:id`, not
 * `/orders/export`), and the closest pattern wins, as in a router: a node's own
 * key first, then a literal segment over a parameter over a catch-all. Routes
 * match on method.
 *
 * Returns the keys of the declared nodes that serve `key` most closely (several
 * only on an exact tie), or none. Results are kept per key.
 */
export function createDeclaredMatcher(nodes: DeclaredSurfaceNode[]): (kind: string, key: string) => string[] {
  const groupOf = (kind: string, key: string) =>
    kind === 'route' ? `route\x00${parseRouteNodeKey(key).method.toUpperCase()}` : 'page\x00';
  // Per group, the patterns by their first literal segment, and those that start otherwise.
  const groups = new Map<
    string,
    {
      byFirst: Map<string, Array<{ key: string; pattern: DeclaredPattern }>>;
      rest: Array<{ key: string; pattern: DeclaredPattern }>;
    }
  >();
  const keys = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'route' && node.kind !== 'page') continue;
    keys.add(`${node.kind}\x00${node.key}`);
    const groupKey = groupOf(node.kind, node.key);
    let group = groups.get(groupKey);
    if (!group) groups.set(groupKey, (group = { byFirst: new Map(), rest: [] }));
    for (const source of declaredPatternsOf(node.kind, node.key, node.attrs)) {
      const pattern = compileDeclaredPattern(source);
      const first = pattern.segments[0];
      if (first?.kind === 'literal') {
        const list = group.byFirst.get(first.text) ?? [];
        list.push({ key: node.key, pattern });
        group.byFirst.set(first.text, list);
      } else {
        group.rest.push({ key: node.key, pattern });
      }
    }
  }

  const cache = new Map<string, string[]>();
  return (kind, key) => {
    const id = `${kind}\x00${key}`;
    const cached = cache.get(id);
    if (cached) return cached;
    let result: string[] = [];
    const group = groups.get(groupOf(kind, key));
    if (keys.has(id)) {
      result = [key];
    } else if (group) {
      const observed = pathSegments(kind === 'route' ? parseRouteNodeKey(key).pattern : key).map(comparableSegment);
      const candidates = [...(group.byFirst.get(observed[0] ?? '') ?? []), ...group.rest];
      let best: number[] | null = null;
      for (const candidate of candidates) {
        const { pattern } = candidate;
        if (observed.length < pattern.min || observed.length > pattern.max) continue;
        const ranks = matchSegments(pattern.segments, 0, observed, 0);
        if (!ranks) continue;
        const order = best ? compareRanks(ranks, best) : 1;
        if (order > 0) {
          best = ranks;
          result = [candidate.key];
        } else if (order === 0 && !result.includes(candidate.key)) {
          result.push(candidate.key);
        }
      }
    }
    cache.set(id, result);
    return result;
  };
}

// ── Import edges (shallow scan) ──────────────────────────────────────────────
//
// A changed source file no test reaches may still be exercised through a file
// that is reached, so a shallow one-level import scan at the run's ref connects
// changed-but-unreached files to their importers. Only relative specifiers are
// resolved; aliases and bare package names are out of scope.

/** Resolve a relative import specifier against the importing file's directory. */
function resolveRelativeImport(fromPath: string, specifier: string, knownFiles: Set<string>): string | null {
  const fromDir = fromPath.replace(/\\/g, '/').split('/').slice(0, -1);
  const parts = specifier.split('/');
  const stack = [...fromDir];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const base = stack.join('/');
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue'].flatMap((ext) => [`${base}${ext}`, `${base}/index${ext}`]),
  ];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

const IMPORT_SPECIFIER_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

/**
 * Extract the relative files a source file imports, resolved against the run's
 * tree. Only `./` and `../` specifiers are resolved to a real known file; bare
 * and aliased specifiers are dropped. Pure and dependency-free.
 */
export function extractImports(fromPath: string, content: string, knownFiles: Set<string>): string[] {
  const out = new Set<string>();
  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || !specifier.startsWith('.')) continue;
    const resolved = resolveRelativeImport(fromPath, specifier, knownFiles);
    if (resolved && resolved !== fromPath) out.add(resolved);
  }
  return [...out];
}

/** One resolved import: the importing file and the file it imports. */
export interface ImportPair {
  from: string;
  to: string;
}

/**
 * Build `file` nodes and `imports` edges (file → imported file) from resolved
 * import pairs, origin `import`. Pure — the ingest path upserts the specs.
 */
export function buildImportEdges(pairs: ImportPair[]): { nodes: GraphNodeSpec[]; edges: GraphEdgeSpec[] } {
  const nodes = new Map<string, GraphNodeSpec>();
  const edges = new Map<string, GraphEdgeSpec>();
  for (const { from, to } of pairs) {
    if (!from || !to || from === to) continue;
    const fromKey = handlerNodeKey(from);
    const toKey = handlerNodeKey(to);
    nodes.set(`file\x00${fromKey}`, { kind: 'file', key: fromKey, origin: 'import' });
    nodes.set(`file\x00${toKey}`, { kind: 'file', key: toKey, origin: 'import' });
    edges.set(`${fromKey}\x00${toKey}`, {
      fromKind: 'file',
      fromKey,
      toKind: 'file',
      toKey,
      kind: 'imports',
      origin: 'import',
    });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

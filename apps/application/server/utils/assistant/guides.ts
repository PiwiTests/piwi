/**
 * Guides the assistant composes from the anchor registry: `find_anchors`
 * searches it for the anchors this user can see on this instance, and every
 * guide plan, and every page a `navigate` block opens, is checked here before
 * it is sent. A plan's anchors must exist and render for the user (their
 * `requires`: a capability not declined, the permission on the page's project
 * or on any, the desktop app, never a demo-only one); each stop's route must
 * open one of its anchor's pages and name only entities the user can read; a
 * stop on a page with an id needs a route unless the user is already there;
 * its copy fits the tour's limits, with `**bold**` as the only markup.
 */
import { eq } from 'drizzle-orm';
import { GUIDE_ANCHORS, findGuideAnchor, type GuideAnchor } from '#shared/guide-anchors/index.mjs';
import type { AssistantGuidePlan, AssistantPageContext } from '#shared/assistant';
import type { CapabilityId, CapabilityState } from '#shared/capabilities';
import { can, holdsAnywhere, type AccessSummary } from '#shared/permissions';
import { isFixedPage, routeOnPage } from '#shared/guide-stops';
import { resolveInstanceStates } from '#shared/handlers/setup-status';
import { isBuiltinDashboardKey } from '#shared/analytics/dashboards';
import { dashboardActorFor, loadDashboardDefinition } from '#shared/handlers/dashboards';
import { getReportSnapshot } from '#shared/handlers/reports';
import type { DbClient } from '../../database';
import { projects } from '../../database/schema';
import { isDesktopRuntime } from '../ai-claude-cli';
import { isAuthEnabled } from '../auth';
import type { McpContext } from '../mcp/tools';
import {
  resolveBugReportProjectId,
  resolveCaseProjectId,
  resolveClusterProjectId,
  resolveRunProjectId,
  resolveTestRunCaseProjectId,
  scopeAllows,
} from '../project-access';

/** The most anchors one `find_anchors` call returns. */
const FIND_ANCHORS_LIMIT = 8;

/** What an anchor's `requires` is checked against. */
export interface AnchorFacts {
  states: Record<CapabilityId, CapabilityState>;
  access: AccessSummary;
  desktop: boolean;
}

export async function loadAnchorFacts(db: DbClient, ctx: McpContext): Promise<AnchorFacts> {
  return { states: await resolveInstanceStates(db), access: ctx.access, desktop: isDesktopRuntime() };
}

/**
 * Why an anchor does not render for this user here, or null when it does. A
 * permission is checked on `projectId` when the page shows a project, on any
 * project otherwise.
 */
export function anchorUnavailable(anchor: GuideAnchor, facts: AnchorFacts, projectId: number | null): string | null {
  const requires = anchor.requires;
  if (!requires) return null;
  if (requires.demo) return 'it shows in the live demo only';
  if (requires.desktop && !facts.desktop) return 'it shows in the desktop app only';
  if (requires.capability) {
    const state = facts.states[requires.capability];
    if (state === 'declined' || state === 'not-applicable') {
      return `it needs the ${requires.capability} capability, ${state} on this instance`;
    }
  }
  if (requires.permission) {
    const holds =
      projectId !== null
        ? can(facts.access, requires.permission, projectId)
        : holdsAnywhere(facts.access, requires.permission);
    if (!holds) {
      return `it needs the ${requires.permission} permission${projectId !== null ? ` on project ${projectId}` : ''}, which the user does not hold`;
    }
  }
  return null;
}

// ── find_anchors ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'how',
  'where',
  'what',
  'which',
  'can',
  'does',
  'with',
  'this',
  'that',
]);

/** A word as matched: lower case, a plural `s` dropped. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map(stem);
}

/** Whether a query word names a text's word: the same, or one starting the other when both are long. */
function matches(word: string, tokens: readonly string[]): boolean {
  return tokens.some(
    (t) => t === word || (word.length >= 5 && t.startsWith(word)) || (t.length >= 5 && word.startsWith(t)),
  );
}

/** Whether `route` opens one of the anchor's pages. */
function rendersOn(anchor: GuideAnchor, route: string | null | undefined): boolean {
  return route ? anchor.pages.some((page) => routeOnPage(route, page)) : false;
}

/** Whether a stop at this anchor needs a route: its main page has an id, and the user is not on one of its pages. */
function needsRoute(anchor: GuideAnchor, route: string | null | undefined): boolean {
  const main = anchor.pages[0] ?? '*';
  return main !== '*' && !isFixedPage(main) && !rendersOn(anchor, route);
}

/**
 * The anchors matching a query that render for this user, best first: each
 * query word found in the id, the description, the help topic, the kind or
 * the condition scores, and an anchor of the current page breaks ties.
 */
export function findAnchors(query: string, facts: AnchorFacts, context: AssistantPageContext | null) {
  const wanted = words(query);
  const projectId = context?.projectId ?? null;
  const scored = GUIDE_ANCHORS.filter((anchor) => !anchorUnavailable(anchor, facts, projectId))
    .map((anchor) => {
      const fields: Array<[string, number]> = [
        [anchor.id, 3],
        [anchor.describes, 2],
        [anchor.help ?? '', 2],
        [anchor.kind, 1],
        [anchor.shownWhen ?? '', 1],
      ];
      const tokens = fields.map(([text, weight]) => [words(text), weight] as const);
      const score = wanted.reduce(
        (n, w) => n + tokens.reduce((m, [t, weight]) => m + (matches(w, t) ? weight : 0), 0),
        0,
      );
      const here = rendersOn(anchor, context?.route) && anchor.pages[0] !== '*';
      return { anchor, score: score > 0 && here ? score + 0.5 : score, here };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, FIND_ANCHORS_LIMIT);
  if (scored.length === 0) {
    return {
      anchors: [],
      note: 'No anchor matches. Try the words the dashboard uses (a page, a tab, a section or a setting), or answer without a guide.',
    };
  }
  return {
    anchors: scored.map(({ anchor, here }) => ({
      id: anchor.id,
      kind: anchor.kind,
      pages: anchor.pages,
      describes: anchor.describes,
      ...(anchor.shownWhen ? { shownWhen: anchor.shownWhen } : {}),
      ...(here ? { onThisPage: true } : {}),
      ...(needsRoute(anchor, context?.route) ? { needsRoute: true } : {}),
    })),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** The outcome of checking a route's entities: the project it shows, or why it cannot be opened. */
type RouteCheck = { ok: true; projectId: number | null } | { ok: false; error: string };

async function projectExists(db: DbClient, id: number): Promise<number | null> {
  const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
  return row?.id ?? null;
}

/** The pages whose `[id]` is an entity of a project, and how to find that project. */
const ROUTE_ENTITIES: Array<{
  pattern: RegExp;
  label: string;
  project: (db: DbClient, id: number) => Promise<number | null>;
}> = [
  { pattern: /^\/projects\/(\d+)(?:\/|$)/, label: 'project', project: projectExists },
  { pattern: /^\/test-runs\/(\d+)$/, label: 'run', project: resolveRunProjectId },
  { pattern: /^\/test-run-cases\/(\d+)$/, label: 'execution', project: resolveTestRunCaseProjectId },
  { pattern: /^\/failure-clusters\/(\d+)$/, label: 'failure cluster', project: resolveClusterProjectId },
  { pattern: /^\/test-cases\/(\d+)$/, label: 'test', project: resolveCaseProjectId },
  { pattern: /^\/bug-reports\/(\d+)$/, label: 'bug report', project: resolveBugReportProjectId },
];

/**
 * Whether the user can open a dashboard route's entities, as the API would
 * let them: a project's run, execution, cluster, test or bug report in their
 * scope, a built-in dashboard (each shows the projects the user reads) or a
 * saved one they see, a quality report covering projects they read.
 * A `project` query naming a project they do not read refuses it too, and an
 * id this cannot check refuses the route.
 */
export async function checkRouteEntities(db: DbClient, ctx: McpContext, route: string): Promise<RouteCheck> {
  if (!route.startsWith('/') || route.startsWith('//')) {
    return { ok: false, error: `"${route}" is not a dashboard route: start it with / from the app's root` };
  }
  const [path = '', query = ''] = route.split('#')[0]!.split('?');
  const queryProject = Number(new URLSearchParams(query).get('project') ?? NaN);
  if (Number.isInteger(queryProject) && !scopeAllows(ctx.scope, queryProject)) {
    return { ok: false, error: `the user cannot read project ${queryProject}` };
  }
  const entity = ROUTE_ENTITIES.find((e) => e.pattern.test(path));
  if (entity) {
    const id = Number(entity.pattern.exec(path)![1]);
    const projectId = await entity.project(db, id);
    if (projectId === null) return { ok: false, error: `no ${entity.label} ${id} exists` };
    if (!scopeAllows(ctx.scope, projectId)) return { ok: false, error: `the user cannot read ${entity.label} ${id}` };
    return { ok: true, projectId };
  }
  const dashboard = /^\/analytics\/d\/([^/]+)$/.exec(path);
  if (dashboard) {
    if (isBuiltinDashboardKey(dashboard[1])) return { ok: true, projectId: null };
    const actor = isAuthEnabled() ? dashboardActorFor(ctx.user?.id ?? null, ctx.access) : dashboardActorFor(null, null);
    const seen = await loadDashboardDefinition(db, dashboard[1], actor).then(
      () => true,
      () => false,
    );
    return seen
      ? { ok: true, projectId: null }
      : { ok: false, error: `the user cannot open dashboard ${dashboard[1]}` };
  }
  const report = /^\/reports\/(\d+)$/.exec(path);
  if (report) {
    const read = await getReportSnapshot(db, Number(report[1]), ctx.scope).then(
      () => true,
      () => false,
    );
    return read
      ? { ok: true, projectId: null }
      : { ok: false, error: `the user cannot open quality report ${report[1]}` };
  }
  if (/\/\d+(?:\/|$)/.test(path)) return { ok: false, error: `the ids in "${path}" cannot be checked` };
  return { ok: true, projectId: null };
}

// ── Plans ─────────────────────────────────────────────────────────────────────

/** What a plan's checks read: the anchor facts, the page the question was asked on, and a route's entities. */
export interface GuideCheckEnv {
  facts: AnchorFacts;
  context: AssistantPageContext | null;
  checkRoute: (route: string) => Promise<RouteCheck>;
}

/** Why guide copy uses markup other than `**bold**`, or null. */
export function guideMarkupProblem(text: string): string | null {
  const rest = text.replace(/\*\*[^*\n]+?\*\*/g, '');
  if (rest.includes('*')) return 'a lone * (only **bold** is allowed)';
  if (rest.includes('`')) return 'backticks (only **bold** is allowed)';
  if (/<[a-z/!]/i.test(rest)) return 'HTML (only **bold** is allowed)';
  if (/\]\(/.test(rest)) return 'a link (only **bold** is allowed; the stop links its docs page itself)';
  if (/[\r\n]/.test(rest)) return 'a line break (one paragraph)';
  return null;
}

/**
 * Check a guide plan against the registry, the user and the instance; the
 * first problem found, in the words the model reads, or null when it holds.
 * `where` prefixes each problem with the plan's place in the tool's arguments.
 */
export async function checkGuidePlan(plan: AssistantGuidePlan, env: GuideCheckEnv, where = ''): Promise<string | null> {
  const at = (path: string) => (where ? `${where}.${path}` : path);
  const titleMarkup = guideMarkupProblem(plan.title);
  if (titleMarkup) return `${at('title')}: ${titleMarkup}`;

  // The page each stop starts from: the question's, then the one the stop before opened.
  let current = env.context?.route ?? null;
  let currentProject = env.context?.projectId ?? null;
  for (const [n, stop] of plan.stops.entries()) {
    const path = at(`stops.${n}`);
    const anchor = findGuideAnchor(stop.anchor);
    if (!anchor) return `${path}.anchor: unknown anchor "${stop.anchor}"; use an id find_anchors returned`;
    for (const field of ['title', 'body'] as const) {
      const problem = guideMarkupProblem(stop[field]);
      if (problem) return `${path}.${field}: ${problem}`;
    }

    if (stop.route !== undefined) {
      if (!anchor.pages.some((page) => routeOnPage(stop.route!, page))) {
        return `${path}.route: "${stop.route}" does not open a page anchor "${anchor.id}" renders on (${anchor.pages.join(', ')})`;
      }
      const checked = await env.checkRoute(stop.route);
      if (!checked.ok) return `${path}.route: ${checked.error}`;
      current = stop.route;
      currentProject = checked.projectId;
    } else if (needsRoute(anchor, current)) {
      return `${path}.route: anchor "${anchor.id}" renders on ${anchor.pages.join(', ')}, which the user is not on; give the route with a real id from a tool result`;
    } else if (isFixedPage(anchor.pages[0]!)) {
      current = anchor.pages[0]!;
      currentProject = null;
    }

    const unavailable = anchorUnavailable(anchor, env.facts, currentProject);
    if (unavailable) return `${path}.anchor: "${anchor.id}" does not show for this user: ${unavailable}`;
  }
  return null;
}

/** Every page pattern of the registry's anchors: the pages a `navigate` block can open. */
const KNOWN_PAGES = [...new Set(GUIDE_ANCHORS.flatMap((anchor) => anchor.pages).filter((page) => page !== '*'))];

/**
 * Check a route a `navigate` block opens: a page of the registry, its entities
 * readable, and the page's own anchor shown to this user. The problem, or null.
 */
export async function checkNavigateRoute(route: string, env: GuideCheckEnv): Promise<string | null> {
  const pages = KNOWN_PAGES.filter((page) => routeOnPage(route, page));
  if (pages.length === 0) return `route: "${route}" opens no page of the dashboard the assistant knows`;
  const checked = await env.checkRoute(route);
  if (!checked.ok) return `route: ${checked.error}`;
  const pageAnchor = GUIDE_ANCHORS.find((a) => a.kind === 'page' && pages.includes(a.pages[0]!));
  const unavailable = pageAnchor ? anchorUnavailable(pageAnchor, env.facts, checked.projectId) : null;
  return unavailable ? `route: the page does not show for this user: ${unavailable}` : null;
}

/**
 * Guides the assistant composes from the anchor registry: `find_anchors`
 * searches it for the anchors this user can see on this instance, and every
 * guide plan, and every page a `navigate` block opens, is checked here before
 * it is sent. A plan's anchors must exist and render for the user (their
 * `requires`: a capability not declined, by the page's project on its pages
 * or by the instance, the permission on the page's project or on any, the
 * desktop app, never a demo-only one); each stop's route must
 * open one of its anchor's pages and name only entities the user can read; a
 * stop on a page with an id needs a route unless the user is already there;
 * its copy fits the tour's limits, with `**bold**` as the only markup.
 */
import { eq } from 'drizzle-orm';
import { GUIDE_ANCHORS, findGuideAnchor } from '#shared/guide-anchors/index.mjs';
import type { AssistantGuidePlan, AssistantPageContext } from '#shared/assistant';
import { isFixedPage, routeOnPage } from '#shared/guide-stops';
import { anchorUnavailable, guideMarkupProblem, needsRoute, type AnchorFacts } from '#shared/guide-anchor-search';
import type { CapabilityId, CapabilityState } from '#shared/capabilities';
import { resolveProjectStates } from '#shared/handlers/capabilities';
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

export { anchorUnavailable, findAnchors, guideMarkupProblem, type AnchorFacts } from '#shared/guide-anchor-search';

/** The anchor facts of one answer, with the capability states of each project a check named, read once. */
export interface AnswerAnchorFacts extends AnchorFacts {
  projectStates: Map<number, Record<CapabilityId, CapabilityState>>;
}

export async function loadAnchorFacts(db: DbClient, ctx: McpContext): Promise<AnswerAnchorFacts> {
  return {
    states: await resolveInstanceStates(db),
    projectStates: new Map(),
    access: ctx.access,
    desktop: isDesktopRuntime(),
  };
}

/** The capability states of `projectId` (its decisions over the instance's), read into `facts` the first time. */
export async function readProjectStates(
  db: DbClient,
  facts: AnswerAnchorFacts,
  projectId: number,
): Promise<Record<CapabilityId, CapabilityState>> {
  let states = facts.projectStates.get(projectId);
  if (!states) {
    states = await resolveProjectStates(db, projectId);
    facts.projectStates.set(projectId, states);
  }
  return states;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** The outcome of checking a route's entities: the project it shows, or why it cannot be opened. */
type RouteCheck = { ok: true; projectId: number | null } | { ok: false; error: string };

/** The project's id when it exists, else null: a project's own project, as the other resolvers find an entity's. */
export async function projectExists(db: DbClient, id: number): Promise<number | null> {
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

/**
 * The env an answer's guides and page links are checked in: its anchor facts
 * with the capability states of the project of the user's page, and of each
 * route's project once the route is checked, read into them; the routes
 * checked as the user would open them.
 */
export async function answerGuideCheckEnv(
  db: DbClient,
  ctx: McpContext,
  facts: AnswerAnchorFacts,
  context: AssistantPageContext | null,
): Promise<GuideCheckEnv> {
  if (context?.projectId != null) await readProjectStates(db, facts, context.projectId);
  return {
    facts,
    context,
    checkRoute: async (route) => {
      const checked = await checkRouteEntities(db, ctx, route);
      if (checked.ok && checked.projectId !== null) await readProjectStates(db, facts, checked.projectId);
      return checked;
    },
  };
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

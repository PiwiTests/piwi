/**
 * Guides the assistant composes from the anchor registry: `find_anchors`
 * returns only the anchors the user and the instance can see, and a plan is
 * refused for an unknown anchor, failing `requires`, a route off the
 * anchor's pages, an entity the user cannot read, a missing route, or copy
 * with markup other than bold.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { CAPABILITIES, type CapabilityId, type CapabilityState } from '#shared/capabilities';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary, type AccessSummary } from '#shared/permissions';
import { GUIDE_ANCHORS, findGuideAnchor } from '#shared/guide-anchors/index.mjs';
import { isFixedPage } from '#shared/guide-stops';
import type { AssistantGuidePlan, AssistantPageContext } from '#shared/assistant';

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_DESKTOP_TOKEN;
vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: false, public: { appVersion: '0.59.0' } }));

const guides = await import('../../server/utils/assistant/guides');
const tools = await import('../../server/utils/assistant/tools');
const { setInstanceDecisions, setProjectDecisions } = await import('#shared/handlers/capabilities');
type McpContext = import('../../server/utils/mcp/tools').McpContext;
type AnchorFacts = import('../../server/utils/assistant/guides').AnchorFacts;

const memberAccess = buildAccessSummary(InstanceRole.MEMBER, [
  { projectId: 1, role: ProjectRole.CONTRIBUTOR },
  { projectId: 3, role: ProjectRole.VIEWER },
]);
const member: McpContext = {
  user: { id: 2, role: 'member', username: 'robin' } as User,
  access: memberAccess,
  scope: new Set([1, 3]),
};
const administrator: McpContext = { user: null, access: ADMIN_ACCESS, scope: 'all' };

function facts(access: AccessSummary, states: Partial<Record<CapabilityId, CapabilityState>> = {}): AnchorFacts {
  const all = Object.fromEntries(CAPABILITIES.map((c) => [c.id, 'available'])) as Record<CapabilityId, CapabilityState>;
  return { states: { ...all, ...states }, access, desktop: false };
}

/** `f` with project `projectId`'s capability states read: every one available, but `states`. */
function withProject(
  f: AnchorFacts,
  projectId: number,
  states: Partial<Record<CapabilityId, CapabilityState>> = {},
): AnchorFacts {
  const all = Object.fromEntries(CAPABILITIES.map((c) => [c.id, 'available'])) as Record<CapabilityId, CapabilityState>;
  return { ...f, projectStates: new Map([[projectId, { ...all, ...states }]]) };
}

const anchor = (id: string) => {
  const found = findGuideAnchor(id);
  if (!found) throw new Error(`no anchor ${id}`);
  return found;
};

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'admin-console' },
    { id: 3, name: 'docs' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'failed', startTime: new Date() },
    { id: 2, projectId: 2, status: 'failed', startTime: new Date() },
  ]);
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'totals' });
  await db.insert(schema.testRunsCases).values({ id: 1, testRunId: 1, testCaseId: 1, status: 'failed' });
});
afterEach(async () => {
  await close();
});
afterAll(() => vi.unstubAllGlobals());

describe('anchorUnavailable', () => {
  test('a demo-only anchor never shows, a desktop one only in the desktop app', () => {
    expect(guides.anchorUnavailable(anchor('demo-personas'), facts(ADMIN_ACCESS), null)).toBe(
      'it shows in the live demo only',
    );
    const desktopOnly = { ...anchor('run-incident'), requires: { desktop: true as const } };
    expect(guides.anchorUnavailable(desktopOnly, facts(ADMIN_ACCESS), null)).toBe('it shows in the desktop app only');
    expect(guides.anchorUnavailable(desktopOnly, { ...facts(ADMIN_ACCESS), desktop: true }, null)).toBeNull();
  });

  test('a capability declined or not applicable hides it; undecided does not', () => {
    const leaks = anchor('run-leaks');
    expect(leaks.requires?.capability).toBe('resources');
    expect(guides.anchorUnavailable(leaks, facts(ADMIN_ACCESS, { resources: 'declined' }), null)).toBe(
      'it needs the resources capability, declined on this instance',
    );
    expect(guides.anchorUnavailable(leaks, facts(ADMIN_ACCESS, { resources: 'not-applicable' }), null)).toContain(
      'not-applicable',
    );
    expect(guides.anchorUnavailable(leaks, facts(ADMIN_ACCESS, { resources: 'undecided' }), null)).toBeNull();
  });

  test("on a project's pages a capability follows the project's states, elsewhere the instance's", () => {
    const leaks = anchor('run-leaks');
    const declinedFor1 = withProject(facts(ADMIN_ACCESS), 1, { resources: 'declined' });
    expect(guides.anchorUnavailable(leaks, declinedFor1, 1)).toBe(
      'it needs the resources capability, declined for project 1',
    );
    expect(guides.anchorUnavailable(leaks, declinedFor1, 3)).toBeNull();
    expect(guides.anchorUnavailable(leaks, declinedFor1, null)).toBeNull();
    expect(
      guides.anchorUnavailable(leaks, withProject(facts(ADMIN_ACCESS), 1, { resources: 'not-applicable' }), 1),
    ).toContain('not-applicable for project 1');

    // A page of no project, a dashboard or every project, follows the instance.
    const coverageFor1 = withProject(facts(ADMIN_ACCESS), 1, { coverage: 'declined', 'flake-lab': 'declined' });
    expect(anchor('analytics-coverage-trend').pages[0]).toBe('/analytics/d/[id]');
    expect(guides.anchorUnavailable(anchor('analytics-coverage-trend'), coverageFor1, 1)).toBeNull();
    expect(guides.anchorUnavailable(anchor('flake-lab-inbox'), coverageFor1, 1)).toBeNull();
    expect(guides.anchorUnavailable(anchor('coverage-overview'), coverageFor1, 1)).toContain('coverage capability');

    // A project enabling what the instance declined shows the anchor on its pages only.
    const enabledFor1 = withProject(facts(ADMIN_ACCESS, { resources: 'declined' }), 1);
    expect(guides.anchorUnavailable(leaks, enabledFor1, 1)).toBeNull();
    expect(guides.anchorUnavailable(leaks, enabledFor1, 3)).toBe(
      'it needs the resources capability, declined on this instance',
    );
  });

  test("a permission holds on the page's project when it shows one, on any project otherwise", () => {
    const schedules = anchor('report-schedules');
    expect(schedules.requires?.permission).toBe('report:write');
    expect(guides.anchorUnavailable(schedules, facts(memberAccess), null)).toBeNull();
    expect(guides.anchorUnavailable(schedules, facts(memberAccess), 1)).toBeNull();
    expect(guides.anchorUnavailable(schedules, facts(memberAccess), 3)).toBe(
      'it needs the report:write permission on project 3, which the user does not hold',
    );
    const ladder = anchor('setup-ladder');
    expect(guides.anchorUnavailable(ladder, facts(memberAccess), null)).toContain('settings:manage');
    expect(guides.anchorUnavailable(ladder, facts(ADMIN_ACCESS), null)).toBeNull();
  });
});

describe('findAnchors', () => {
  const ids = (result: ReturnType<typeof guides.findAnchors>) => result.anchors.map((a) => a.id);

  test('returns the anchors matching the query, leaving out the ones whose requires fail', () => {
    expect(ids(guides.findAnchors('resource leaks', facts(ADMIN_ACCESS), null))).toContain('run-leaks');
    expect(
      ids(guides.findAnchors('resource leaks', facts(ADMIN_ACCESS, { resources: 'declined' }), null)),
    ).not.toContain('run-leaks');
    expect(ids(guides.findAnchors('setup ladder', facts(ADMIN_ACCESS), null))).toContain('setup-ladder');
    expect(ids(guides.findAnchors('setup ladder', facts(memberAccess), null))).not.toContain('setup-ladder');
  });

  test("leaves out an anchor of the user's project's pages when the project declines its capability", () => {
    const declinedFor1 = withProject(facts(ADMIN_ACCESS), 1, { resources: 'declined' });
    const onRun1: AssistantPageContext = { route: '/test-runs/1', page: '/test-runs/[id]', projectId: 1 };
    const onProject3: AssistantPageContext = { route: '/projects/3', page: '/projects/[id]', projectId: 3 };
    expect(ids(guides.findAnchors('resource leaks', declinedFor1, onRun1))).not.toContain('run-leaks');
    expect(ids(guides.findAnchors('resource leaks', declinedFor1, onProject3))).toContain('run-leaks');
    expect(ids(guides.findAnchors('resource leaks', declinedFor1, null))).toContain('run-leaks');
  });

  test('never returns a demo-only anchor', () => {
    const everything = GUIDE_ANCHORS.map((a) => a.describes).join(' ');
    expect(ids(guides.findAnchors(everything, facts(ADMIN_ACCESS), null)).some((id) => id.startsWith('demo-'))).toBe(
      false,
    );
    expect(ids(guides.findAnchors('demo personas acting as', facts(ADMIN_ACCESS), null))).not.toContain(
      'demo-personas',
    );
  });

  test('says which anchors are on the current page, and which need a route', () => {
    const onRun: AssistantPageContext = { route: '/test-runs/1', page: '/test-runs/[id]', projectId: 1 };
    const here = guides.findAnchors('environment incident', facts(ADMIN_ACCESS), onRun).anchors;
    expect(here.find((a) => a.id === 'run-incident')).toMatchObject({ onThisPage: true });
    expect(here.find((a) => a.id === 'run-incident')).not.toHaveProperty('needsRoute');
    const home = guides.findAnchors('environment incident', facts(ADMIN_ACCESS), { route: '/', page: '/' }).anchors;
    expect(home.find((a) => a.id === 'run-incident')).toMatchObject({ needsRoute: true });
  });

  test('ranks the anchors the page rendered first, then the others, best first', () => {
    const query = 'flaky tests quarantine';
    const elsewhere = guides.findAnchors(query, facts(ADMIN_ACCESS), null).anchors;
    const last = elsewhere.filter((a) => a.pages[0] !== '*').at(-1)!;
    expect(elsewhere[0]!.id).not.toBe(last.id);
    const rendered = guides.findAnchors(query, facts(ADMIN_ACCESS), {
      route: '/',
      page: '/',
      anchors: [last.id, 'nav-home', 'no-such-anchor'],
    }).anchors;
    expect(rendered[0]).toMatchObject({ id: last.id, onThisPage: true });
    expect(rendered.filter((a) => a.onThisPage).map((a) => a.id)).toEqual([last.id]);
    expect(rendered.slice(1).map((a) => a.id)).toEqual(elsewhere.filter((a) => a.id !== last.id).map((a) => a.id));
  });

  test('answers a query nothing matches with a note', () => {
    expect(guides.findAnchors('zzzz qqqq', facts(ADMIN_ACCESS), null)).toEqual({
      anchors: [],
      note: expect.stringContaining('No anchor matches'),
    });
  });
});

describe('checkRouteEntities', () => {
  const check = (ctx: McpContext, route: string) => guides.checkRouteEntities(db as never, ctx, route);

  test("resolves a route's entity to its project and checks the user reads it", async () => {
    expect(await check(member, '/test-runs/1')).toEqual({ ok: true, projectId: 1 });
    expect(await check(member, '/test-run-cases/1?evidence=network')).toEqual({ ok: true, projectId: 1 });
    expect(await check(member, '/projects/1/coverage')).toEqual({ ok: true, projectId: 1 });
    expect(await check(member, '/test-runs/2')).toEqual({ ok: false, error: 'the user cannot read run 2' });
    expect(await check(administrator, '/test-runs/2')).toEqual({ ok: true, projectId: 2 });
    expect(await check(member, '/failure-clusters/9')).toEqual({ ok: false, error: 'no failure cluster 9 exists' });
  });

  test('refuses a project query the user cannot read, an id it cannot check, and a route off the app', async () => {
    expect(await check(member, '/?project=2')).toEqual({ ok: false, error: 'the user cannot read project 2' });
    expect(await check(member, '/settings/notifications')).toEqual({ ok: true, projectId: null });
    expect((await check(member, '/widgets/4')) as { error: string }).toMatchObject({ ok: false });
    expect((await check(member, '//evil.example/x')) as { error: string }).toMatchObject({ ok: false });
    expect(await check(member, '/analytics/d/99')).toEqual({ ok: false, error: 'the user cannot open dashboard 99' });
  });

  test('opens a built-in dashboard by its key, and no other word', async () => {
    expect(await check(member, '/analytics/d/engineering')).toEqual({ ok: true, projectId: null });
    expect(await check(member, '/analytics/d/gaps-digest?period=7d')).toEqual({ ok: true, projectId: null });
    expect(await check(member, '/analytics/d/marketing')).toEqual({
      ok: false,
      error: 'the user cannot open dashboard marketing',
    });
  });
});

describe('checkGuidePlan', () => {
  function plan(stops: AssistantGuidePlan['stops']): AssistantGuidePlan {
    return { title: 'Where it is', stops };
  }
  const stop = (anchorId: string, route?: string) => ({
    anchor: anchorId,
    ...(route ? { route } : {}),
    title: 'Here',
    body: 'Look at **Findings**.',
  });
  function check(
    p: AssistantGuidePlan,
    ctx: McpContext = member,
    context: AssistantPageContext | null = null,
    f: AnchorFacts = facts(ctx.access),
  ) {
    return guides.checkGuidePlan(p, {
      facts: f,
      context,
      checkRoute: (route) => guides.checkRouteEntities(db as never, ctx, route),
    });
  }

  test('a plan of known anchors, on readable routes, holds', async () => {
    expect(
      await check(plan([stop('run-incident', '/test-runs/1'), stop('situation', '/test-run-cases/1')])),
    ).toBeNull();
  });

  test('a stop on a built-in dashboard names it by its key', async () => {
    expect(await check(plan([stop('analytics-verdict', '/analytics/d/executive')]))).toBeNull();
    expect(await check(plan([stop('analytics-verdict', '/analytics/d/marketing')]))).toContain(
      'does not open a page anchor "analytics-verdict" renders on',
    );
  });

  test('refuses an unknown anchor', async () => {
    expect(await check(plan([stop('the-pay-button', '/test-runs/1')]))).toBe(
      'stops.0.anchor: unknown anchor "the-pay-button"; use an id find_anchors returned',
    );
  });

  test('refuses an anchor whose requires fail for this user or this instance', async () => {
    const declined = facts(memberAccess, { resources: 'declined' });
    expect(await check(plan([stop('run-leaks', '/test-runs/1')]), member, null, declined)).toBe(
      'stops.0.anchor: "run-leaks" does not show for this user: it needs the resources capability, declined on this instance',
    );
    expect(await check(plan([stop('setup-ladder')]))).toContain('settings:manage');
    expect(await check(plan([stop('demo-personas')]), administrator)).toContain('live demo only');
  });

  test("refuses a route that opens none of the anchor's pages", async () => {
    expect(await check(plan([stop('run-incident', '/test-run-cases/1')]))).toBe(
      'stops.0.route: "/test-run-cases/1" does not open a page anchor "run-incident" renders on (/test-runs/[id])',
    );
  });

  test('refuses a route naming an entity the user cannot read, or one that does not exist', async () => {
    expect(await check(plan([stop('run-incident', '/test-runs/2')]))).toBe('stops.0.route: the user cannot read run 2');
    expect(await check(plan([stop('run-incident', '/test-runs/404')]))).toBe('stops.0.route: no run 404 exists');
  });

  test('needs a route on a page with an id, unless the user is on it or an earlier stop opened it', async () => {
    expect(await check(plan([stop('run-incident')]), member, { route: '/', page: '/' })).toContain(
      'stops.0.route: anchor "run-incident" renders on /test-runs/[id], which the user is not on',
    );
    const onRun: AssistantPageContext = { route: '/test-runs/1?tab=tests', page: '/test-runs/[id]', projectId: 1 };
    expect(await check(plan([stop('run-incident')]), member, onRun)).toBeNull();
    expect(await check(plan([stop('run-leaks', '/test-runs/1'), stop('run-incident')]))).toBeNull();
    // A stop on a fixed page opens it, so the next stop on a page with an id needs its route again.
    expect(await check(plan([stop('failure-inbox-row'), stop('run-incident')]), member, onRun)).toContain(
      'stops.1.route',
    );
  });

  test('refuses copy with markup other than **bold**', async () => {
    const withCode = { ...stop('run-incident', '/test-runs/1'), body: 'Run `npx piwi` here.' };
    expect(await check(plan([withCode]))).toBe('stops.0.body: backticks (only **bold** is allowed)');
    const withLink = { ...stop('run-incident', '/test-runs/1'), title: 'See [docs](/x)' };
    expect(await check(plan([withLink]))).toContain('stops.0.title: a link');
    expect(await check({ title: 'The *run*', stops: [stop('run-incident', '/test-runs/1')] })).toContain(
      'title: a lone *',
    );
    expect(guides.guideMarkupProblem('Open **Settings → AI** and set **Model**.')).toBeNull();
    expect(guides.guideMarkupProblem('Two lines\nhere')).toContain('line break');
    expect(guides.guideMarkupProblem('An <b>HTML</b> tag')).toContain('HTML');
  });

  test("names the plan's place in the tool's arguments", async () => {
    expect(
      await guides.checkGuidePlan(
        plan([stop('nope')]),
        {
          facts: facts(memberAccess),
          context: null,
          checkRoute: async () => ({ ok: true, projectId: null }),
        },
        'steps.2.guide',
      ),
    ).toMatch(/^steps\.2\.guide\.stops\.0\.anchor: /);
  });
});

describe("a project's own capability decisions, read from the database", () => {
  const onRun1: AssistantPageContext = { route: '/test-runs/1', page: '/test-runs/[id]', projectId: 1 };
  const toolbox = (context: AssistantPageContext | null) =>
    tools.createAssistantToolbox({ db: db as never, ctx: member, readTools: [], page: null, extraTools: [], context });
  async function found(context: AssistantPageContext | null): Promise<string[]> {
    const result = await toolbox(context).run({
      id: 'f',
      name: 'find_anchors',
      arguments: { query: 'resource leaks' },
    });
    return (JSON.parse(result.content) as { anchors: { id: string }[] }).anchors.map((a) => a.id);
  }
  const leaksGuide = (route: string) => ({
    id: 'leaks',
    title: 'Where the leaks are',
    stops: [{ anchor: 'run-leaks', route, title: 'Findings', body: 'The **Findings** of the run.' }],
  });

  test("find_anchors leaves out an anchor of the user's project's pages when the project declines it", async () => {
    expect(await found(onRun1)).toContain('run-leaks');
    await setProjectDecisions(db as never, 1, { resources: 'declined' });
    expect(await found(onRun1)).not.toContain('run-leaks');
    expect(await found({ route: '/projects/3', page: '/projects/[id]', projectId: 3 })).toContain('run-leaks');
  });

  test("a guide's stop is refused on the pages of a project that declines its anchor's capability", async () => {
    await setProjectDecisions(db as never, 1, { resources: 'declined' });
    const refused = await toolbox(null).run({ id: 'g', name: 'show_guide', arguments: leaksGuide('/test-runs/1') });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain(
      'stops.0.anchor: "run-leaks" does not show for this user: it needs the resources capability, declined for project 1',
    );
    // Staying on the user's page, the stop follows that page's project too.
    const here = await toolbox(onRun1).run({
      id: 'g',
      name: 'show_guide',
      arguments: { ...leaksGuide('/test-runs/1'), stops: [{ ...leaksGuide('').stops[0]!, route: undefined }] },
    });
    expect(here.content).toContain('declined for project 1');
  });

  test('a project enabling what the instance declined shows the anchor on its pages', async () => {
    await setInstanceDecisions(db as never, { resources: 'declined' });
    expect(await found(onRun1)).not.toContain('run-leaks');
    await setProjectDecisions(db as never, 1, { resources: 'enabled' });
    expect(await found(onRun1)).toContain('run-leaks');
    const shown = await toolbox(null).run({ id: 'g', name: 'show_guide', arguments: leaksGuide('/test-runs/1') });
    expect(shown).toMatchObject({ isError: false, block: { kind: 'guide' } });
  });
});

describe('checkNavigateRoute', () => {
  const env = (ctx: McpContext) => ({
    facts: facts(ctx.access),
    context: null,
    checkRoute: (route: string) => guides.checkRouteEntities(db as never, ctx, route),
  });

  test('opens a page of the registry whose entities the user reads', async () => {
    expect(await guides.checkNavigateRoute('/test-runs/1', env(member))).toBeNull();
    expect(await guides.checkNavigateRoute('/test-runs/2', env(member))).toBe('route: the user cannot read run 2');
    expect(await guides.checkNavigateRoute('/no-such-page', env(member))).toContain('opens no page');
    expect(await guides.checkNavigateRoute('/analytics/d/engineering', env(member))).toBeNull();
    expect(await guides.checkNavigateRoute('/analytics/d/marketing', env(member))).toContain('opens no page');
  });

  test('refuses a page whose own anchor does not show for the user', async () => {
    const adminPage = GUIDE_ANCHORS.find(
      (a) => a.kind === 'page' && a.requires?.permission === 'settings:manage' && isFixedPage(a.pages[0]!),
    )!;
    expect(await guides.checkNavigateRoute(adminPage.pages[0]!, env(member))).toContain('settings:manage');
    expect(await guides.checkNavigateRoute(adminPage.pages[0]!, env(administrator))).toBeNull();
  });
});

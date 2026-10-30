import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary } from '../../shared/permissions';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const dashboards = await import('../../shared/handlers/dashboards');
const defs = await import('../../shared/analytics/dashboards');
const { backfillDailyRollups } = await import('../../shared/handlers/analytics/rollups');
const { sweepOrphans, pruneReportSnapshots } = await import('../../server/utils/retention');

const DAY_MS = 24 * 60 * 60 * 1000;
let db: ReturnType<typeof drizzle<typeof schema>>;

const onAllProjects = (role: ProjectRole) => buildAccessSummary(InstanceRole.MEMBER, [{ projectId: null, role }]);
const admin = dashboards.dashboardActorFor(10, ADMIN_ACCESS);
// A Maintainer may share a dashboard; a Viewer keeps private ones only.
const maintainer = dashboards.dashboardActorFor(11, onAllProjects(ProjectRole.MAINTAINER));
const viewer = dashboards.dashboardActorFor(12, onAllProjects(ProjectRole.VIEWER));
const noAuth = dashboards.dashboardActorFor(null, null);

const metricWidget = (key: string, options: Record<string, unknown> = {}) => ({
  key,
  type: 'metric',
  size: 'full',
  options,
});

function definition(widgets: unknown[], scope: Record<string, unknown> = {}) {
  return { v: 1, scope, bands: [{ title: 'Numbers', widgets }] };
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'checkout' },
    { id: 2, name: 'search' },
    { id: 3, name: 'billing' },
  ]);
  await db.insert(schema.users).values([
    { id: 10, username: 'admin', password: '', role: InstanceRole.ADMINISTRATOR },
    { id: 11, username: 'maintainer', password: '', role: InstanceRole.MEMBER },
    { id: 12, username: 'viewer', password: '', role: InstanceRole.MEMBER },
    { id: 13, username: 'leaver', password: '', role: InstanceRole.MEMBER },
  ]);
  const now = Date.now();
  for (const [projectId, passed] of [
    [1, 9],
    [2, 10],
    [3, 5],
  ] as const) {
    await db.insert(schema.testRuns).values({
      projectId,
      status: passed === 10 ? 'passed' : 'failed',
      startTime: new Date(now - 2 * DAY_MS),
      duration: 60_000,
      totalTests: 10,
      passedTests: passed,
      failedTests: 10 - passed,
      isFullRun: 1,
    });
  }
  await backfillDailyRollups(db as any);
});

describe('dashboard definitions', () => {
  test('fill the defaults of every widget option and of the scope', () => {
    const parsed = defs.parseDashboardDefinition(definition([metricWidget('pass')]));
    expect(parsed.bands[0]!.widgets[0]!.options).toMatchObject({ metric: 'test-pass-rate', display: 'line' });
    expect(parsed.scope).toMatchObject({ period: { kind: 'rolling', days: 30 }, defaultBranchOnly: true });
  });

  test('refuse an unknown widget, bad options, a duplicate key and a bad period', () => {
    expect(() => defs.parseDashboardDefinition(definition([{ key: 'x', type: 'nope', size: 'full' }]))).toThrow(
      /unknown widget type/,
    );
    expect(() => defs.parseDashboardDefinition(definition([metricWidget('m', { metric: 'nope' })]))).toThrow(
      /Invalid options/,
    );
    expect(() => defs.parseDashboardDefinition(definition([metricWidget('m'), metricWidget('m')]))).toThrow(
      /used twice/,
    );
    expect(() => defs.parseDashboardDefinition(definition([], { period: { kind: 'forever' } }))).toThrow(/period/);
  });

  test('keep only the keys a widget override sets', () => {
    const parsed = defs.parseDashboardDefinition(
      definition([{ ...metricWidget('week'), scope: { period: { kind: 'rolling', days: 7 }, browsers: ['webkit'] } }]),
    );
    expect(parsed.bands[0]!.widgets[0]!.scope).toEqual({ period: { kind: 'rolling', days: 7 }, browsers: ['webkit'] });
  });

  test('a stored widget a later release removed renders as a notice', () => {
    const bands = defs.resolveDashboard({
      v: 1,
      scope: defs.OVERVIEW_DASHBOARD.scope,
      bands: [{ title: 'Old', widgets: [{ key: 'gone', type: 'removed-widget' as any, size: 'half' }] }],
    });
    expect(bands[0]!.widgets[0]).toMatchObject({ available: false, reason: defs.UNAVAILABLE_WIDGET });
  });
});

describe('widget overrides only narrow', () => {
  const base = { ...defs.OVERVIEW_DASHBOARD.scope, projectIds: [1, 2] };

  test('the period is replaced, the projects intersected', () => {
    const scope = defs.applyWidgetScope(base, { period: { kind: 'rolling', days: 7 }, projectIds: [2, 3] });
    expect(scope.period).toEqual({ kind: 'rolling', days: 7 });
    expect(scope.projectIds).toEqual([2]);
  });

  test('disjoint projects match nothing rather than every project', () => {
    const scope = defs.applyWidgetScope(base, { projectIds: [3] });
    expect(scope.projectIds).toEqual([0]);
  });

  test('a branch list cannot widen the default-branch policy', () => {
    const scope = defs.applyWidgetScope(base, { branches: ['feature/x'], defaultBranchOnly: false });
    expect(scope.branches).toBeUndefined();
    expect(scope.defaultBranchOnly).toBe(true);
  });
});

describe('a scope laid over the dashboard scope', () => {
  const def = {
    ...definition([], { projectIds: [3], environments: ['ci'], period: { kind: 'rolling', days: 30 } }),
  } as any;

  test('a period alone keeps the projects and filters of the dashboard', () => {
    const scope = dashboards.dashboardScopeWith(def, { period: 'last-7d' });
    expect(scope.period).toEqual({ kind: 'rolling', days: 7 });
    expect(scope.projectIds).toEqual([3]);
    expect(scope.environments).toEqual(['ci']);
  });

  test('a key the caller names replaces the dashboard one, and nothing else', () => {
    const scope = dashboards.dashboardScopeWith(def, { projects: '1,2' });
    expect(scope.projectIds).toEqual([1, 2]);
    expect(scope.environments).toEqual(['ci']);
    expect(scope.period).toEqual({ kind: 'rolling', days: 30 });
  });

  test('the page URL, which carries the whole scope, still replaces it', () => {
    const scope = dashboards.viewerScope(def, { period: 'last-7d' });
    expect(scope.projectIds).toBeUndefined();
  });
});

describe('saved dashboards', () => {
  test('a viewer keeps a private dashboard nobody else sees', async () => {
    const mine = await dashboards.createDashboard(db as any, { name: 'Mine', visibility: 'private' }, viewer);
    expect(mine).toMatchObject({ visibility: 'private', mine: true, canEdit: true });
    const others = await dashboards.listDashboards(db as any, maintainer);
    expect(others.items.map((d) => d.id)).not.toContain(mine.id);
    await expect(dashboards.getDashboard(db as any, mine.id, maintainer, 'all')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test('sharing needs share:create on a project', async () => {
    await expect(
      dashboards.createDashboard(db as any, { name: 'Shared', visibility: 'shared' }, viewer),
    ).rejects.toMatchObject({ statusCode: 403 });
    const shared = await dashboards.createDashboard(db as any, { name: 'Team', visibility: 'shared' }, maintainer);
    expect(shared.visibility).toBe('shared');
  });

  test('with authentication off every dashboard is shared', async () => {
    const d = await dashboards.createDashboard(db as any, { name: 'Open', visibility: 'private' }, noAuth);
    expect(d.visibility).toBe('shared');
  });

  test('the list starts with the built-ins, Overview first, and leaves out the team dashboard', async () => {
    const list = await dashboards.listDashboards(db as any, viewer);
    expect(list.items[0]).toMatchObject({ id: 'overview', kind: 'builtin', canEdit: false });
    expect(list.items.map((d) => d.id)).not.toContain('team');
    expect(list.canShare).toBe(false);
  });

  test('a built-in cannot be saved, only duplicated', async () => {
    await expect(
      dashboards.saveDashboard(db as any, 'overview', { updatedAt: new Date().toISOString() }, admin, 'all'),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(dashboards.deleteDashboard(db as any, 'overview', admin)).rejects.toMatchObject({ statusCode: 403 });
    const copy = await dashboards.duplicateDashboard(db as any, 'overview', viewer);
    expect(copy).toMatchObject({ name: 'Copy of Overview', visibility: 'private', kind: 'saved' });
    expect(copy.definition.bands).toEqual(defs.OVERVIEW_DASHBOARD.bands);
  });

  test('a shared dashboard is edited by its owner or an administrator, and duplicated by everyone else', async () => {
    const shared = await dashboards.createDashboard(db as any, { name: 'Release', visibility: 'shared' }, maintainer);
    await expect(
      dashboards.saveDashboard(db as any, shared.id, { name: 'Mine now', updatedAt: shared.updatedAt! }, viewer, 'all'),
    ).rejects.toMatchObject({ statusCode: 403 });
    const saved = await dashboards.saveDashboard(
      db as any,
      shared.id,
      { name: 'Release train', updatedAt: shared.updatedAt! },
      admin,
      'all',
    );
    expect(saved.name).toBe('Release train');
    const copy = await dashboards.duplicateDashboard(db as any, shared.id, viewer);
    expect(copy.ownerId).toBe(12);
  });

  test('a concurrent save gets a 409', async () => {
    const d = await dashboards.createDashboard(db as any, { name: 'Race', visibility: 'private' }, viewer);
    const first = await dashboards.saveDashboard(
      db as any,
      d.id,
      { name: 'First', updatedAt: d.updatedAt! },
      viewer,
      'all',
      Date.now() + 5,
    );
    expect(first.name).toBe('First');
    await expect(
      dashboards.saveDashboard(db as any, d.id, { name: 'Second', updatedAt: d.updatedAt! }, viewer, 'all'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('a save refuses an invalid definition', async () => {
    const d = await dashboards.createDashboard(db as any, { name: 'Bad', visibility: 'private' }, viewer);
    await expect(
      dashboards.saveDashboard(
        db as any,
        d.id,
        { definition: definition([{ key: 'x', type: 'nope', size: 'full' }]), updatedAt: d.updatedAt! },
        viewer,
        'all',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('the header counts the projects the viewer cannot open', async () => {
    const d = await dashboards.createDashboard(
      db as any,
      { name: 'Two', visibility: 'shared', definition: definition([metricWidget('pass')], { projectIds: [1, 3] }) },
      admin,
    );
    const view = await dashboards.getDashboard(db as any, d.id, viewer, new Set([1]));
    expect(view.hiddenProjects).toBe(1);
    const all = await dashboards.getDashboard(db as any, 'overview', viewer, new Set([1]));
    expect(all.hiddenProjects).toBe(2);
  });

  test('a new dashboard answers with the projects its creator cannot open', async () => {
    const source = await dashboards.createDashboard(
      db as any,
      { name: 'Wide', visibility: 'shared', definition: definition([metricWidget('pass')], { projectIds: [1, 2, 3] }) },
      admin,
    );
    const copy = await dashboards.createDashboard(
      db as any,
      { name: 'My copy', visibility: 'private', from: source.id },
      viewer,
      new Set([1]),
    );
    expect(copy.hiddenProjects).toBe(2);
    const duplicate = await dashboards.duplicateDashboard(db as any, source.id, viewer, { access: new Set([1]) });
    expect(duplicate.hiddenProjects).toBe(2);
  });

  test('a widget is computed for the viewer only', async () => {
    const d = await dashboards.createDashboard(
      db as any,
      {
        name: 'Rates',
        visibility: 'shared',
        definition: definition([metricWidget('pass', { display: 'stat' })], { projectIds: [1, 3] }),
      },
      admin,
    );
    const everyone = (await dashboards.getDashboardWidgetData(db as any, d.id, 'pass', {}, admin, 'all')) as any;
    const limited = (await dashboards.getDashboardWidgetData(db as any, d.id, 'pass', {}, viewer, new Set([1]))) as any;
    expect(everyone.value.value).toBe(70);
    expect(limited.value.value).toBe(90);
  });

  test('the URL scope replaces the dashboard default', async () => {
    const d = await dashboards.createDashboard(
      db as any,
      { name: 'Scoped', visibility: 'shared', definition: definition([metricWidget('pass', { display: 'stat' })]) },
      admin,
    );
    const data = (await dashboards.getDashboardWidgetData(
      db as any,
      d.id,
      'pass',
      { period: 'last-30d', projects: '2' },
      admin,
      'all',
    )) as any;
    expect(data.value.value).toBe(100);
  });

  test('the preview runs an unsaved widget', async () => {
    const data = (await dashboards.previewDashboardWidget(
      db as any,
      { widget: { type: 'metric', options: { display: 'stat' } }, scope: { period: 'last-30d', projects: '3' } },
      'all',
    )) as any;
    expect(data.value.value).toBe(50);
  });

  test('deleting a dashboard deactivates the schedules that render it', async () => {
    const d = await dashboards.createDashboard(db as any, { name: 'Scheduled', visibility: 'shared' }, admin);
    const [schedule] = await db
      .insert(schema.reportSchedules)
      .values({ name: 'Weekly', dashboardId: +d.id, cadence: 'weekly', anchor: 1, at: '08:00', channelIds: [] })
      .returning();
    const view = await dashboards.getDashboard(db as any, d.id, admin, 'all');
    expect(view.schedules).toEqual([{ id: schedule!.id, name: 'Weekly' }]);
    const result = await dashboards.deleteDashboard(db as any, d.id, admin);
    expect(result.deactivatedSchedules).toEqual([schedule!.id]);
    const [row] = await db.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, schedule!.id));
    expect(row).toMatchObject({ active: false, dashboardId: null });
  });

  test('the instance default must be a shared dashboard', async () => {
    const priv = await dashboards.createDashboard(db as any, { name: 'P', visibility: 'private' }, admin);
    await expect(dashboards.setInstanceDefaultDashboard(db as any, priv.id)).rejects.toMatchObject({
      statusCode: 400,
    });
    await dashboards.setInstanceDefaultDashboard(db as any, 'executive');
    expect(await dashboards.getInstanceDefaultDashboard(db as any)).toBe('executive');
    await dashboards.setInstanceDefaultDashboard(db as any, null);
    expect(await dashboards.getInstanceDefaultDashboard(db as any)).toBeNull();
  });

  test('a shared dashboard nobody opened for 90 days is unused', async () => {
    const d = await dashboards.createDashboard(db as any, { name: 'Old', visibility: 'shared' }, admin);
    await db
      .update(schema.analyticsDashboards)
      .set({ createdAt: new Date(Date.now() - 100 * DAY_MS) })
      .where(eq(schema.analyticsDashboards.id, +d.id));
    const list = await dashboards.listDashboards(db as any, admin);
    expect(list.items.find((x) => x.id === d.id)?.unused).toBe(true);
  });

  test('the orphan sweep removes private dashboards whose owner left, and keeps shared ones', async () => {
    const priv = await dashboards.createDashboard(
      db as any,
      { name: 'Private', visibility: 'private' },
      dashboards.dashboardActorFor(13, onAllProjects(ProjectRole.VIEWER)),
    );
    await db
      .update(schema.analyticsDashboards)
      .set({ ownerId: null })
      .where(eq(schema.analyticsDashboards.id, +priv.id));
    const shared = await dashboards.createDashboard(db as any, { name: 'Kept', visibility: 'shared' }, maintainer);
    await db
      .update(schema.analyticsDashboards)
      .set({ ownerId: null })
      .where(eq(schema.analyticsDashboards.id, +shared.id));
    const result = await sweepOrphans(db as any);
    expect(result.dashboards).toBe(1);
    const left = await db.select({ id: schema.analyticsDashboards.id }).from(schema.analyticsDashboards);
    expect(left.map((r) => String(r.id))).toContain(shared.id);
    expect(left.map((r) => String(r.id))).not.toContain(priv.id);
  });

  test('report and dashboard links go with their snapshot or dashboard, and the sweep removes any left behind', async () => {
    const linkIds = async () =>
      (await db.select({ id: schema.shareLinks.id }).from(schema.shareLinks)).map((r) => r.id);
    const link = (id: number, entityKind: string, entityId: number) => ({
      id,
      entityKind,
      entityId,
      tokenHash: `hash-${id}`,
      tokenPrefix: 'abcd1234',
    });
    const d = await dashboards.createDashboard(db as any, { name: 'Linked', visibility: 'shared' }, maintainer);
    const [old] = await db
      .insert(schema.reportSnapshots)
      .values({
        dashboardRef: 'executive',
        dashboardName: 'Executive',
        projectIds: [1],
        periodFrom: new Date('2020-01-01'),
        periodTo: new Date('2020-01-08'),
        bundle: {},
        generatedAt: new Date('2020-01-08'),
      })
      .returning({ id: schema.reportSnapshots.id });
    await db
      .insert(schema.shareLinks)
      .values([
        link(900, 'dashboard', +d.id),
        link(901, 'report', old!.id),
        link(902, 'dashboard', 99_999),
        link(903, 'report', 99_999),
      ]);

    await dashboards.deleteDashboardRows(db as any, eq(schema.analyticsDashboards.id, +d.id));
    expect(await linkIds()).not.toContain(900);
    expect(await pruneReportSnapshots(db as any, 365)).toBe(1);
    expect(await linkIds()).not.toContain(901);

    // Links whose entity went another way (an older build, a direct delete) are the sweep's.
    const result = await sweepOrphans(db as any);
    expect(result.shareLinks).toBe(2);
    const left = await linkIds();
    expect(left).not.toContain(902);
    expect(left).not.toContain(903);
  });
});

describe('report schedules on a saved dashboard', () => {
  const reports = import('../../shared/handlers/reports');
  const reportAdmin = { id: 10, isAdmin: true, authEnabled: true };
  const writeCtx = { actor: reportAdmin, channels: [], access: 'all' as const, timeZone: 'UTC' };

  test('render the dashboard, and go inactive with the reason when it is deleted, until pointed at another', async () => {
    const r = await reports;
    await db
      .insert(schema.notificationChannels)
      .values({ id: 50, name: 'Team mail', type: 'email', config: { address: 'a@example.test' }, userId: null });
    const channels = await r.loadReportChannels(db as any);
    const d = await dashboards.createDashboard(
      db as any,
      { name: 'Checkout weekly', visibility: 'shared', definition: definition([metricWidget('pass')]) },
      admin,
    );
    const schedule = await r.createReportSchedule(
      db as any,
      r.parseScheduleBody(r.reportScheduleInputSchema, {
        name: 'Weekly checkout',
        dashboard: d.id,
        cadence: 'weekly',
        anchor: 1,
        at: '08:00',
        channelIds: [50],
      }),
      { ...writeCtx, channels },
    );
    expect(schedule).toMatchObject({ dashboard: d.id, dashboardName: 'Checkout weekly', inactiveReason: null });

    const [row] = await db.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, schedule.id));
    const run = await r.runReportSchedule(db as any, row!, { access: 'all', timeZone: 'UTC', deliver: false });
    const [snapshot] = await db
      .select()
      .from(schema.reportSnapshots)
      .where(eq(schema.reportSnapshots.id, run.snapshotId));
    expect(snapshot!.dashboardRef).toBe(d.id);
    expect(snapshot!.dashboardName).toBe('Checkout weekly');

    await dashboards.deleteDashboard(db as any, d.id, admin);
    const inactive = await r.getReportSchedule(db as any, schedule.id, reportAdmin, channels);
    expect(inactive).toMatchObject({ active: false, dashboard: null, inactiveReason: r.DASHBOARD_DELETED_REASON });

    const repointed = await r.updateReportSchedule(
      db as any,
      schedule.id,
      { dashboard: 'executive' },
      {
        ...writeCtx,
        channels,
      },
    );
    expect(repointed).toMatchObject({ active: true, dashboard: 'executive', inactiveReason: null });
  });

  test('a global schedule needs a shared dashboard', async () => {
    const r = await reports;
    const priv = await dashboards.createDashboard(db as any, { name: 'Private', visibility: 'private' }, admin);
    await expect(
      r.createReportSchedule(
        db as any,
        r.parseScheduleBody(r.reportScheduleInputSchema, {
          name: 'Global',
          dashboard: priv.id,
          cadence: 'daily',
          at: '08:00',
          channelIds: [50],
          global: true,
        }),
        { ...writeCtx, channels: await r.loadReportChannels(db as any) },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

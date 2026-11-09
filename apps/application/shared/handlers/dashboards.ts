/**
 * Saved dashboards: list, read, create, save, delete and duplicate, and the
 * widget data of a dashboard. Shared by the server routes, the MCP tools and
 * the demo; who is asking and what they may open come in as arguments.
 *
 * Access: any signed-in user keeps private dashboards; sharing needs
 * `share:create` on at least one project; a shared dashboard is changed by its
 * owner or an administrator and duplicated by everyone else. With authentication
 * off every dashboard is shared. A dashboard grants no access: every widget is
 * computed for the viewer's project access, and the projects of its scope the
 * viewer cannot open are counted, never shown.
 */
import { and, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { analyticsDashboards, projects, reportSchedules, shareLinks, users } from '../../server/database/schema';
import { deleteAppSetting, getAppSetting, setAppSetting } from '../../server/utils/app-settings';
import type { DrizzleDB } from './db';
import { holdsAnywhere, isAdministrator, type AccessSummary } from '../permissions';
import { analyticsScopeToQuery, parseAnalyticsScope, type AnalyticsScope } from '../analytics/scope';
import { queryHasScope } from '../analytics/scope-state';
import { parseRouteId } from '../route-id';
import {
  applyWidgetScope,
  BUILTIN_DASHBOARDS,
  dashboardScope,
  dashboardWidgets,
  DASHBOARD_LIMITS,
  DashboardDefinitionError,
  getBuiltinDashboard,
  isBuiltinDashboardKey,
  normalizeDashboardScope,
  parseDashboardDefinition,
  parseDashboardWidget,
  resolveDashboard,
  type BuiltinDashboardKey,
  type DashboardDefinition,
  type ResolvedDashboardBand,
} from '../analytics/dashboards';
import { runAnalyticsWidget } from './analytics';
import { getInstanceCapabilities } from './capabilities';
import { filterByProjectTags, resolveAllowedProjects, type ProjectAccess } from './analytics/common';

export class DashboardError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Who is asking. With authentication off there is no user: `id` is null and
 * every dashboard is shared. `isAdmin` is an instance administrator, who edits
 * every dashboard and sets the instance default; `canShare` whether they hold
 * `share:create` on at least one project.
 */
export interface DashboardActor {
  id: number | null;
  authEnabled: boolean;
  isAdmin: boolean;
  canShare: boolean;
}

/** The actor for a signed-in user's access; `access` null means authentication is off. */
export function dashboardActorFor(id: number | null, access: AccessSummary | null): DashboardActor {
  if (!access) return { id: null, authEnabled: false, isAdmin: true, canShare: true };
  return { id, authEnabled: true, isAdmin: isAdministrator(access), canShare: holdsAnywhere(access, 'share:create') };
}

export type DashboardVisibility = 'private' | 'shared';

/** The app setting holding the instance default dashboard (a built-in key or a saved id). */
export const DEFAULT_DASHBOARD_SETTING = 'analytics.default_dashboard';

/** A shared dashboard nobody opened for this long sits in the *Unused* group. */
export const UNUSED_AFTER_DAYS = 90;

/** How often opening a dashboard writes its `last_viewed_at`. */
const VIEW_TOUCH_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

function isAdmin(actor: DashboardActor): boolean {
  return !actor.authEnabled || actor.isAdmin;
}

/** Sharing needs `share:create` on at least one project; with authentication off everything is shared. */
function canShareDashboards(actor: DashboardActor): boolean {
  return !actor.authEnabled || actor.isAdmin || actor.canShare;
}

// ── References ───────────────────────────────────────────────────────────────

/** A dashboard reference: a built-in key or a saved dashboard id. */
export type DashboardRef = { kind: 'builtin'; key: BuiltinDashboardKey } | { kind: 'saved'; id: number };

/** A built-in key, or a saved dashboard's id read as a route reads one (`parseRouteId`); null for anything else. */
function parseDashboardRef(raw: unknown): DashboardRef | null {
  const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (isBuiltinDashboardKey(value)) return { kind: 'builtin', key: value };
  const id = parseRouteId(value);
  return id === null ? null : { kind: 'saved', id };
}

function dashboardRefString(ref: DashboardRef): string {
  return ref.kind === 'builtin' ? ref.key : String(ref.id);
}

/** Whether the instance declined the Test Map, which hides the gaps digest dashboard. */
async function isTestMapHidden(db: DrizzleDB): Promise<boolean> {
  const state = (await getInstanceCapabilities(db)).items.find((c) => c.id === 'test-map')?.state;
  return state === 'declined' || state === 'not-applicable';
}

/** The built-in dashboards a page lists: the team dashboard needs an owner test filter, so it is a report-only one. */
function listedBuiltins(testMapHidden: boolean) {
  return BUILTIN_DASHBOARDS.filter((d) => d.requires !== 'owner' && (d.requires !== 'test-map' || !testMapHidden));
}

// ── Views ────────────────────────────────────────────────────────────────────

type DashboardRow = typeof analyticsDashboards.$inferSelect;

export interface DashboardSummary {
  /** A built-in key or the saved dashboard's id, as `/analytics/d/<id>` takes it. */
  id: string;
  kind: 'builtin' | 'saved';
  name: string;
  description: string | null;
  visibility: DashboardVisibility;
  ownerId: number | null;
  ownerName: string | null;
  /** The viewer owns it. */
  mine: boolean;
  widgetCount: number;
  updatedAt: string | null;
  lastViewedAt: string | null;
  /** A shared dashboard nobody opened for `UNUSED_AFTER_DAYS`. */
  unused: boolean;
  /** The viewer may save, share and delete it; otherwise *Duplicate* only. */
  canEdit: boolean;
}

export interface DashboardView extends DashboardSummary {
  definition: DashboardDefinition;
  /** The definition checked against the widget registry, options defaulted; removed widgets become notices. */
  bands: ResolvedDashboardBand[];
  /** Projects of the dashboard's scope the viewer cannot open. */
  hiddenProjects: number;
  /** The report schedules rendering this dashboard (saved dashboards only). */
  schedules: Array<{ id: number; name: string }>;
}

const iso = (value: Date | number | null | undefined) => (value == null ? null : new Date(value).toISOString());

function canEditRow(row: Pick<DashboardRow, 'ownerId'>, actor: DashboardActor): boolean {
  if (isAdmin(actor)) return true;
  return row.ownerId !== null && row.ownerId === actor.id;
}

/** Whether the viewer may open a saved dashboard: a shared one, their own, or any with authentication off. */
function canSeeRow(row: Pick<DashboardRow, 'ownerId' | 'visibility'>, actor: DashboardActor): boolean {
  if (!actor.authEnabled || row.visibility === 'shared') return true;
  return row.ownerId !== null && row.ownerId === actor.id;
}

function isUnused(row: DashboardRow, now: number): boolean {
  if (row.visibility !== 'shared') return false;
  const seen = new Date(row.lastViewedAt ?? row.createdAt).getTime();
  return now - seen > UNUSED_AFTER_DAYS * DAY_MS;
}

function savedSummary(
  row: DashboardRow,
  ownerName: string | null,
  actor: DashboardActor,
  now: number,
): DashboardSummary {
  const definition = row.definition as DashboardDefinition;
  return {
    id: String(row.id),
    kind: 'saved',
    name: row.name,
    description: row.description ?? null,
    visibility: actor.authEnabled ? (row.visibility as DashboardVisibility) : 'shared',
    ownerId: row.ownerId ?? null,
    ownerName,
    mine: actor.id !== null && row.ownerId === actor.id,
    widgetCount: dashboardWidgets(definition).length,
    updatedAt: iso(row.updatedAt),
    lastViewedAt: iso(row.lastViewedAt),
    unused: isUnused(row, now),
    canEdit: canEditRow(row, actor),
  };
}

function builtinSummary(key: BuiltinDashboardKey): DashboardSummary {
  const d = getBuiltinDashboard(key);
  return {
    id: d.key,
    kind: 'builtin',
    name: d.name,
    description: d.description,
    visibility: 'shared',
    ownerId: null,
    ownerName: null,
    mine: false,
    widgetCount: dashboardWidgets(d.definition).length,
    updatedAt: null,
    lastViewedAt: null,
    unused: false,
    canEdit: false,
  };
}

async function ownerNames(db: DrizzleDB, ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name || r.username]));
}

// ── Listing and reading ──────────────────────────────────────────────────────

export interface DashboardList {
  items: DashboardSummary[];
  /** The instance default an administrator set; null leaves Overview the default. */
  instanceDefault: string | null;
  /** The viewer may share a dashboard. */
  canShare: boolean;
  /** The viewer may set the instance default. */
  canSetDefault: boolean;
}

function visibleCondition(actor: DashboardActor): SQL | undefined {
  if (!actor.authEnabled) return undefined;
  const shared = eq(analyticsDashboards.visibility, 'shared');
  return actor.id === null ? shared : or(shared, eq(analyticsDashboards.ownerId, actor.id));
}

/** Every dashboard the viewer may open: the built-ins, then the shared and their own saved ones, newest first. */
export async function listDashboards(
  db: DrizzleDB,
  actor: DashboardActor,
  opts: { testMapHidden?: boolean; now?: number } = {},
): Promise<DashboardList> {
  const now = opts.now ?? Date.now();
  const rows = await db
    .select()
    .from(analyticsDashboards)
    .where(visibleCondition(actor))
    .orderBy(desc(analyticsDashboards.updatedAt), desc(analyticsDashboards.id));
  const names = await ownerNames(
    db,
    rows.map((r) => r.ownerId).filter((id): id is number => id !== null),
  );
  return {
    items: [
      ...listedBuiltins(opts.testMapHidden ?? (await isTestMapHidden(db))).map((d) => builtinSummary(d.key)),
      ...rows.map((r) => savedSummary(r, r.ownerId ? (names.get(r.ownerId) ?? null) : null, actor, now)),
    ],
    instanceDefault: await getInstanceDefaultDashboard(db),
    canShare: canShareDashboards(actor),
    canSetDefault: isAdmin(actor),
  };
}

async function loadRow(db: DrizzleDB, id: number): Promise<DashboardRow> {
  const [row] = await db.select().from(analyticsDashboards).where(eq(analyticsDashboards.id, id));
  if (!row) throw new DashboardError(404, 'Dashboard not found');
  return row;
}

async function visibleRow(db: DrizzleDB, id: number, actor: DashboardActor): Promise<DashboardRow> {
  const row = await loadRow(db, id);
  // A private dashboard of someone else reads as missing, not forbidden.
  if (!canSeeRow(row, actor)) throw new DashboardError(404, 'Dashboard not found');
  return row;
}

/** A saved dashboard's id; a built-in cannot be changed, only duplicated. */
function savedId(rawRef: unknown): number {
  const ref = requireRef(rawRef);
  if (ref.kind === 'builtin') {
    throw new DashboardError(403, 'A built-in dashboard cannot be changed; duplicate it instead');
  }
  return ref.id;
}

async function editableRow(db: DrizzleDB, rawRef: unknown, actor: DashboardActor): Promise<DashboardRow> {
  const row = await visibleRow(db, savedId(rawRef), actor);
  if (!canEditRow(row, actor)) {
    throw new DashboardError(403, 'Only its owner or an administrator can change this dashboard; duplicate it instead');
  }
  return row;
}

function requireRef(raw: unknown): DashboardRef {
  const ref = parseDashboardRef(raw);
  if (!ref) throw new DashboardError(404, 'Dashboard not found');
  return ref;
}

/** A dashboard's name and definition, when the viewer may open it: what a page, a report and a schedule render. */
export async function loadDashboardDefinition(
  db: DrizzleDB,
  rawRef: unknown,
  actor: DashboardActor,
): Promise<{ ref: string; name: string; definition: DashboardDefinition; row: DashboardRow | null }> {
  const ref = requireRef(rawRef);
  if (ref.kind === 'builtin') {
    const d = getBuiltinDashboard(ref.key);
    return { ref: d.key, name: d.name, definition: d.definition, row: null };
  }
  const row = await visibleRow(db, ref.id, actor);
  return { ref: String(row.id), name: row.name, definition: row.definition as DashboardDefinition, row };
}

/** The dashboard a quality report renders: a built-in key as is, a saved dashboard loaded for the viewer. */
export async function reportDashboardFor(
  db: DrizzleDB,
  rawRef: unknown,
  actor: DashboardActor,
): Promise<BuiltinDashboardKey | { ref: string; name: string; definition: DashboardDefinition }> {
  const ref = requireRef(rawRef);
  if (ref.kind === 'builtin') return ref.key;
  const { name, definition } = await loadDashboardDefinition(db, rawRef, actor);
  return { ref: String(ref.id), name, definition };
}

/**
 * The projects of a scope the viewer cannot open: the scope's project filter
 * (or every project, when it has none), narrowed by its project tags.
 */
async function countHiddenProjects(db: DrizzleDB, scope: AnalyticsScope, access: ProjectAccess): Promise<number> {
  if (access === 'all') return 0;
  let covered = resolveAllowedProjects(scope, 'all');
  if (scope.projectTags && scope.projectTags.length > 0)
    covered = await filterByProjectTags(db, covered, scope.projectTags);
  const ids =
    covered === 'all'
      ? (await db.select({ id: projects.id }).from(projects)).map((r: { id: number }) => r.id)
      : covered;
  return ids.filter((id) => !access.has(id)).length;
}

async function schedulesUsing(db: DrizzleDB, id: number): Promise<Array<{ id: number; name: string }>> {
  return db
    .select({ id: reportSchedules.id, name: reportSchedules.name })
    .from(reportSchedules)
    .where(eq(reportSchedules.dashboardId, id))
    .orderBy(reportSchedules.name);
}

/**
 * One dashboard with its definition, resolved against the widget registry.
 * `scope` is the scope the viewer looks at (the URL's changes over the
 * dashboard's default) and decides the hidden-project count. Opening a saved
 * dashboard (`touch`) records the view, at most once an hour.
 */
export async function getDashboard(
  db: DrizzleDB,
  rawRef: unknown,
  actor: DashboardActor,
  access: ProjectAccess,
  opts: { scope?: AnalyticsScope; touch?: boolean; now?: number } = {},
): Promise<DashboardView> {
  const now = opts.now ?? Date.now();
  const loaded = await loadDashboardDefinition(db, rawRef, actor);
  const scope = opts.scope ?? dashboardScope(loaded.definition);
  const hiddenProjects = await countHiddenProjects(db, scope, access);
  const bands = resolveDashboard(loaded.definition);
  if (!loaded.row) {
    return {
      ...builtinSummary(loaded.ref as BuiltinDashboardKey),
      definition: loaded.definition,
      bands,
      hiddenProjects,
      schedules: [],
    };
  }
  let row = loaded.row;
  if (opts.touch && (!row.lastViewedAt || now - new Date(row.lastViewedAt).getTime() > VIEW_TOUCH_MS)) {
    await db
      .update(analyticsDashboards)
      .set({ lastViewedAt: new Date(now) })
      .where(eq(analyticsDashboards.id, row.id));
    row = { ...row, lastViewedAt: new Date(now) };
  }
  const names = await ownerNames(db, row.ownerId ? [row.ownerId] : []);
  return {
    ...savedSummary(row, row.ownerId ? (names.get(row.ownerId) ?? null) : null, actor, now),
    definition: loaded.definition,
    bands,
    hiddenProjects,
    schedules: canEditRow(row, actor) ? await schedulesUsing(db, row.id) : [],
  };
}

// ── Writing ──────────────────────────────────────────────────────────────────

const nameSchema = z.string().trim().min(1).max(DASHBOARD_LIMITS.name);
const descriptionSchema = z.string().trim().max(DASHBOARD_LIMITS.description).nullable();

export const dashboardInputSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  visibility: z.enum(['private', 'shared']).default('private'),
  /** A definition to start from; empty when omitted. `from` copies another dashboard's instead. */
  definition: z.unknown().optional(),
  from: z.union([z.string(), z.number()]).optional(),
});

export const dashboardPatchSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  definition: z.unknown().optional(),
  /** The `updatedAt` the edit started from: a save over a newer version is refused with a 409. */
  updatedAt: z.string().datetime(),
});

export const dashboardDuplicateSchema = z.object({ name: nameSchema.optional() });

export type DashboardInput = z.infer<typeof dashboardInputSchema>;
export type DashboardPatch = z.infer<typeof dashboardPatchSchema>;

/** Parse a request body, turning a zod refusal into a 400. */
export function parseDashboardBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DashboardError(
      400,
      `Invalid dashboard: ${issue?.path.join('.') || 'body'} ${issue?.message ?? ''}`.trim(),
    );
  }
  return parsed.data;
}

function checkedDefinition(raw: unknown): DashboardDefinition {
  try {
    return parseDashboardDefinition(raw);
  } catch (error) {
    if (error instanceof DashboardDefinitionError) throw new DashboardError(400, error.message);
    throw error;
  }
}

/** The visibility a write stores: sharing needs `share:create`, and with authentication off everything is shared. */
function storedVisibility(requested: DashboardVisibility, actor: DashboardActor): DashboardVisibility {
  if (!actor.authEnabled) return 'shared';
  if (requested === 'shared' && !canShareDashboards(actor)) {
    throw new DashboardError(403, 'Sharing a dashboard needs the Maintainer role on at least one project');
  }
  return requested;
}

export const EMPTY_DASHBOARD: DashboardDefinition = {
  v: 1,
  scope: normalizeDashboardScope({}),
  bands: [{ title: 'Widgets', widgets: [] }],
};

/** Create a saved dashboard: empty, from a definition, or copied from another dashboard (`from`). */
export async function createDashboard(
  db: DrizzleDB,
  input: DashboardInput,
  actor: DashboardActor,
  /** The creator's project access, so the answer counts the projects of its scope they cannot open. */
  access: ProjectAccess = 'all',
  now = Date.now(),
): Promise<DashboardView> {
  const definition =
    input.from !== undefined
      ? (await loadDashboardDefinition(db, input.from, actor)).definition
      : input.definition !== undefined
        ? checkedDefinition(input.definition)
        : EMPTY_DASHBOARD;
  const at = new Date(now);
  const [row] = await db
    .insert(analyticsDashboards)
    .values({
      name: input.name,
      description: input.description ?? null,
      ownerId: actor.id,
      visibility: storedVisibility(input.visibility, actor),
      definition,
      createdAt: at,
      updatedAt: at,
      updatedBy: actor.id,
    })
    .returning();
  return getDashboard(db, row!.id, actor, access, { now });
}

/**
 * Save a dashboard. The `updatedAt` the edit started from must match the
 * stored one: a concurrent save gets a 409, and the editor offers to reload
 * or save a copy.
 */
export async function saveDashboard(
  db: DrizzleDB,
  rawRef: unknown,
  patch: DashboardPatch,
  actor: DashboardActor,
  access: ProjectAccess,
  now = Date.now(),
): Promise<DashboardView> {
  const row = await editableRow(db, rawRef, actor);
  const id = row.id;
  if (new Date(row.updatedAt).getTime() !== new Date(patch.updatedAt).getTime()) {
    throw new DashboardError(409, 'This dashboard was saved by someone else since you opened it');
  }
  const visibility =
    patch.visibility !== undefined && patch.visibility !== row.visibility
      ? storedVisibility(patch.visibility, actor)
      : (row.visibility as DashboardVisibility);
  // Keep a strictly newer stamp, so two saves in one millisecond still conflict.
  const stamp = Math.max(now, new Date(row.updatedAt).getTime() + 1);
  const [updated] = await db
    .update(analyticsDashboards)
    .set({
      name: patch.name ?? row.name,
      description: patch.description !== undefined ? patch.description : row.description,
      visibility,
      definition: patch.definition !== undefined ? checkedDefinition(patch.definition) : row.definition,
      updatedAt: new Date(stamp),
      updatedBy: actor.id,
    })
    .where(and(eq(analyticsDashboards.id, id), eq(analyticsDashboards.updatedAt, row.updatedAt)))
    .returning();
  if (!updated) throw new DashboardError(409, 'This dashboard was saved by someone else since you opened it');
  return getDashboard(db, id, actor, access, { now });
}

/** Duplicate any dashboard the viewer may open, built-ins included; the copy is the viewer's, private. */
export async function duplicateDashboard(
  db: DrizzleDB,
  rawRef: unknown,
  actor: DashboardActor,
  /** `access`: the viewer's project access, so the copy counts the projects of its scope they cannot open. */
  opts: { name?: string; now?: number; access?: ProjectAccess } = {},
): Promise<DashboardView> {
  const source = await loadDashboardDefinition(db, rawRef, actor);
  const name = (opts.name ?? `Copy of ${source.name}`).slice(0, DASHBOARD_LIMITS.name);
  return createDashboard(
    db,
    { name, description: source.row?.description ?? null, visibility: 'private', from: source.ref },
    actor,
    opts.access ?? 'all',
    opts.now,
  );
}

/**
 * Remove dashboards matching `where`. The report schedules rendering one are
 * deactivated first and keep no dashboard, so the Reports page shows them
 * inactive until their owner points them at another dashboard.
 */
export async function deleteDashboardRows(db: DrizzleDB, where: SQL): Promise<number[]> {
  const rows: { id: number }[] = await db.select({ id: analyticsDashboards.id }).from(analyticsDashboards).where(where);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const schedules: { id: number }[] = await db
    .select({ id: reportSchedules.id })
    .from(reportSchedules)
    .where(inArray(reportSchedules.dashboardId, ids));
  if (schedules.length > 0) {
    await db
      .update(reportSchedules)
      .set({ active: false, dashboardId: null, updatedAt: new Date() })
      .where(
        inArray(
          reportSchedules.id,
          schedules.map((s) => s.id),
        ),
      );
  }
  const instanceDefault = await getInstanceDefaultDashboard(db);
  if (instanceDefault && ids.map(String).includes(instanceDefault))
    await deleteAppSetting(db, DEFAULT_DASHBOARD_SETTING);
  // A live link has no FK to its dashboard: it goes with it.
  await db.delete(shareLinks).where(and(eq(shareLinks.entityKind, 'dashboard'), inArray(shareLinks.entityId, ids)));
  await db.delete(analyticsDashboards).where(inArray(analyticsDashboards.id, ids));
  return schedules.map((s) => s.id);
}

/** Delete a saved dashboard; the schedules that render it become inactive. */
export async function deleteDashboard(
  db: DrizzleDB,
  rawRef: unknown,
  actor: DashboardActor,
): Promise<{ deactivatedSchedules: number[] }> {
  const row = await editableRow(db, rawRef, actor);
  return { deactivatedSchedules: await deleteDashboardRows(db, eq(analyticsDashboards.id, row.id)) };
}

// ── The instance default ─────────────────────────────────────────────────────

/** The instance default dashboard (a built-in key or a shared dashboard's id), or null for Overview. */
export async function getInstanceDefaultDashboard(db: DrizzleDB): Promise<string | null> {
  const value = await getAppSetting<string>(db, DEFAULT_DASHBOARD_SETTING);
  return typeof value === 'string' && parseDashboardRef(value) ? value : null;
}

/** Set or clear the instance default. A saved dashboard must be shared, since everyone opens it. */
export async function setInstanceDefaultDashboard(db: DrizzleDB, raw: unknown): Promise<{ dashboard: string | null }> {
  if (raw === null || raw === undefined || raw === '' || raw === 'overview') {
    await deleteAppSetting(db, DEFAULT_DASHBOARD_SETTING);
    return { dashboard: null };
  }
  const ref = parseDashboardRef(raw);
  if (!ref) throw new DashboardError(400, 'Unknown dashboard');
  if (ref.kind === 'builtin' && getBuiltinDashboard(ref.key).requires === 'owner') {
    throw new DashboardError(400, 'The team dashboard needs an owner filter and cannot be the default');
  }
  if (ref.kind === 'saved') {
    const row = await loadRow(db, ref.id);
    if (row.visibility !== 'shared') throw new DashboardError(400, 'Only a shared dashboard can be the default');
  }
  const value = dashboardRefString(ref);
  await setAppSetting(db, DEFAULT_DASHBOARD_SETTING, value);
  return { dashboard: value };
}

// ── Widget data ──────────────────────────────────────────────────────────────

type QueryLike = URLSearchParams | Record<string, unknown> | undefined | null;

function queryRecord(query: QueryLike): Record<string, unknown> {
  if (!query) return {};
  if (query instanceof URLSearchParams) return Object.fromEntries(query.entries());
  return query;
}

/**
 * The scope a viewer looks at: the URL's scope when it carries one (the
 * viewer's changes), else the dashboard's default, with the viewer's time
 * zone and locale from the request either way.
 */
export function viewerScope(definition: DashboardDefinition, query: QueryLike): AnalyticsScope {
  const record = queryRecord(query);
  const parsed = parseAnalyticsScope(record);
  if (queryHasScope(record)) return parsed;
  const scope = { ...dashboardScope(definition) };
  if (parsed.timeZone) scope.timeZone = parsed.timeZone;
  if (parsed.locale) scope.locale = parsed.locale;
  return scope;
}

/**
 * The dashboard's own scope with the keys a caller names laid over it, key by
 * key: an agent asking about "this sprint" keeps the dashboard's projects and
 * filters. The page's URL always carries the whole scope, so it goes through
 * `viewerScope` instead.
 */
export function dashboardScopeWith(definition: DashboardDefinition, query: QueryLike): AnalyticsScope {
  return parseAnalyticsScope({ ...analyticsScopeToQuery(dashboardScope(definition)), ...queryRecord(query) });
}

export interface DashboardWidgetRequest {
  /** The dashboard's version: a save changes it, so cached answers of the previous version are not reused. */
  version: string;
  widgetKey: string;
  scope: AnalyticsScope;
  run: () => Promise<unknown>;
}

/**
 * Resolve one widget of a dashboard for a viewer, without running it: the
 * server caches by `version`, widget, scope and project access before calling
 * `run`. A widget a later release removed, or one the dashboard no longer
 * has, is a 404.
 */
export async function prepareDashboardWidget(
  db: DrizzleDB,
  rawRef: unknown,
  widgetKey: string,
  query: QueryLike,
  actor: DashboardActor,
  access: ProjectAccess,
): Promise<DashboardWidgetRequest> {
  const loaded = await loadDashboardDefinition(db, rawRef, actor);
  const widget = resolveDashboard(loaded.definition)
    .flatMap((b) => b.widgets)
    .find((w) => w.key === widgetKey);
  if (!widget) throw new DashboardError(404, 'Widget not found in this dashboard');
  if (!widget.available) throw new DashboardError(404, widget.reason);
  const scope = applyWidgetScope(viewerScope(loaded.definition, query), widget.scope);
  return {
    version: `${loaded.ref}@${loaded.row ? new Date(loaded.row.updatedAt).getTime() : 'builtin'}`,
    widgetKey,
    scope,
    run: () => runAnalyticsWidget(db, widget.type, scope, access, widget.options),
  };
}

/** One widget's data from a dashboard. */
export async function getDashboardWidgetData(
  db: DrizzleDB,
  rawRef: unknown,
  widgetKey: string,
  query: QueryLike,
  actor: DashboardActor,
  access: ProjectAccess,
): Promise<unknown> {
  return (await prepareDashboardWidget(db, rawRef, widgetKey, query, actor, access)).run();
}

export const widgetPreviewSchema = z.object({
  /** The unsaved widget: type, options and scope override, as a definition holds it. */
  widget: z.unknown(),
  /** The dashboard's scope under edit, in the analytics query keys; the widget's override applies over it. */
  scope: z.record(z.string(), z.string()).default({}),
});

/** One widget from an unsaved definition: the editor's preview. Reads only. */
export async function previewDashboardWidget(db: DrizzleDB, body: unknown, access: ProjectAccess): Promise<unknown> {
  const input = parseDashboardBody(widgetPreviewSchema, body);
  let widget;
  try {
    widget = parseDashboardWidget({ key: 'preview', size: 'full', ...(input.widget as object) }, 'Widget');
  } catch (error) {
    if (error instanceof DashboardDefinitionError) throw new DashboardError(400, error.message);
    throw error;
  }
  const scope = applyWidgetScope(parseAnalyticsScope(input.scope), widget.scope);
  return runAnalyticsWidget(db, widget.type, scope, access, widget.options ?? {});
}

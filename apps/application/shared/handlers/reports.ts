/**
 * Report schedules and report snapshots: the saved recurring deliveries of a
 * quality report, and every quality report generated, stored with its frozen
 * bundle. Shared by the server routes, the `reports:schedule` task and the
 * demo; the parts that differ (whose project access a schedule runs with,
 * which channels exist) come in as arguments.
 *
 * Access: creating and editing a schedule needs the reporter or administrator
 * role (the routes declare it); a global schedule needs an administrator and
 * targets global channels only; a snapshot is readable by whoever can open
 * every project it covers.
 */
import { and, desc, eq, gte, inArray, isNotNull, lt, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  analyticsDashboards,
  notificationDeliveries,
  notificationChannels,
  projects,
  reportSchedules,
  reportSnapshots,
  testCases,
  users,
} from '../../server/database/schema';
import type { DrizzleDB } from './db';
import {
  analyticsScopeToQuery,
  DEFAULT_ANALYTICS_SCOPE,
  parseAnalyticsScope,
  scopeFilesErrors,
  type AnalyticsScope,
} from '../analytics/scope';
import {
  BUILTIN_DASHBOARDS,
  dashboardScope,
  getBuiltinDashboard,
  isBuiltinDashboardKey,
  type BuiltinDashboardKey,
  type DashboardDefinition,
} from '../analytics/dashboards';
import { DashboardError, loadDashboardDefinition, type DashboardActor } from './dashboards';
import type { ComparisonSpec } from '../analytics/period';
import { collectReportBundle, type ReportDashboard } from '../reports/collect';
import { makeFormatter } from '../reports/format';
import { assertDashboardScope, ReportRequestError } from '../reports/request';
import { REPORT_LANGUAGES, type ReportLanguage } from '../reports/languages';
import { sentencesFor } from '../reports/sentences';
import type { ReportBundle } from '../reports/types';
import { applyNarrative, type GeneratedNarrative } from '../reports/narrative';
import {
  lastCompletePeriod,
  latestDueRun,
  MONTHLY_ANCHOR_MAX,
  nextRunAt,
  normalizeScheduleTime,
  periodFor,
  REPORT_CADENCES,
  reportDedupeKey,
  SCHEDULE_COMPARISONS,
  type ReportCadence,
  type ScheduleComparison,
  type SchedulePeriod,
} from '../reports/schedule';
import { REPORT_READY_EVENT, type ReportReadyPayload } from '../notification-events';
import { getAnalyticsContext, type ProjectAccess } from './analytics/common';
import { channelOwnerOf, channelRecipient, type ChannelOwner } from '../notifications/channel-recipients';

export class ReportScheduleError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Who is asking. With authentication off there is no user row: `id` is null and everything is global. */
export interface ReportActor {
  id: number | null;
  isAdmin: boolean;
  authEnabled: boolean;
}

/** A notification channel as a schedule sees it. */
export interface ReportChannel {
  id: number;
  name: string;
  type: string;
  userId: number | null;
  /** The owner's display name; null for a global channel. */
  ownerName?: string | null;
  /** An email channel's address, or the owner's account email for `personal_email`. */
  address?: string | null;
  /** A webhook channel's endpoint. */
  url?: string | null;
}

/** A schedule's channel: its name, who receives what it sends, and whose it is. */
export interface ReportScheduleChannel {
  id: number;
  name: string;
  type: string;
  /** Null once the channel was deleted. */
  owner: ChannelOwner | null;
  recipient: string;
}

// ── Input ────────────────────────────────────────────────────────────────────

const BUILTIN_KEYS = BUILTIN_DASHBOARDS.map((d) => d.key) as [BuiltinDashboardKey, ...BuiltinDashboardKey[]];

/** A built-in dashboard key or a saved dashboard's id. */
const dashboardRefSchema = z.union([
  z.enum(BUILTIN_KEYS),
  z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform((v) => String(v)),
]);

// The fields without their creation defaults: `.partial()` keeps a field's `.default()`, so a PATCH
// built from the create schema would reset `scope` and `comparison` on every partial update.
const reportScheduleFields = z.object({
  name: z.string().trim().min(1).max(120),
  dashboard: dashboardRefSchema,
  /** The analytics scope keys (`projects`, `environments`, `allBranches`, `sel`, `owner`, …); the period is ignored. */
  scope: z.record(z.string(), z.string()),
  cadence: z.enum(REPORT_CADENCES),
  anchor: z.number().int().min(1).max(MONTHLY_ANCHOR_MAX).nullable().optional(),
  at: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'at must be HH:mm'),
  comparison: z.enum(SCHEDULE_COMPARISONS),
  language: z.enum(REPORT_LANGUAGES).nullable().optional(),
  channelIds: z.array(z.number().int().positive()).min(1).max(20),
  /** Mint a share link per snapshot, carried by the email and Slack messages (when share links are enabled). */
  includeShareLink: z.boolean().optional(),
  /** Add the AI narrative (three paragraphs by the configured model); the rule-based verdict when none can be written. */
  includeNarrative: z.boolean().optional(),
  /** Administrator only: an instance-wide schedule, sent to global channels. */
  global: z.boolean().optional(),
  active: z.boolean().optional(),
  /** Mute until this instant (ISO); null unmutes. */
  mutedUntil: z.string().datetime().nullable().optional(),
});

export const reportScheduleInputSchema = reportScheduleFields.extend({
  scope: reportScheduleFields.shape.scope.default({}),
  comparison: reportScheduleFields.shape.comparison.default('previous'),
});

/** Only the keys the body carries: a PATCH of `{ active }` leaves the scope and the comparison as they are. */
export const reportSchedulePatchSchema = reportScheduleFields.partial();

/**
 * What a preview reads of a schedule not saved yet: the create body without
 * the channels, with a name that may still be empty. `createdAt`, a saved
 * schedule's creation, sets the weeks of an every-other-week cadence.
 */
export const reportSchedulePreviewSchema = reportScheduleFields
  .pick({ dashboard: true, cadence: true, anchor: true, at: true, language: true, global: true })
  .extend({
    name: z.string().trim().max(120).optional(),
    scope: reportScheduleFields.shape.scope.default({}),
    comparison: reportScheduleFields.shape.comparison.default('previous'),
    createdAt: z.string().datetime().optional(),
  });

export type ReportScheduleInput = z.infer<typeof reportScheduleInputSchema>;
export type ReportSchedulePatch = z.infer<typeof reportSchedulePatchSchema>;
export type ReportSchedulePreviewInput = z.infer<typeof reportSchedulePreviewSchema>;

/** Parse a request body, turning a zod refusal into a 400. */
export function parseScheduleBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ReportScheduleError(400, `Invalid schedule: ${issue?.path.join('.') || 'body'} ${issue?.message ?? ''}`);
  }
  return parsed.data;
}

/**
 * The filters a schedule keeps from a scope: its period comes from the cadence, its comparison from the schedule.
 * A `files` list past the limits of a selection's is refused.
 */
export function scheduleFilters(query: Record<string, string>): Partial<AnalyticsScope> {
  const filesErrors = scopeFilesErrors(query, 'scope.files');
  if (filesErrors.length > 0) throw new ReportScheduleError(400, `Invalid schedule: ${filesErrors.join('; ')}`);
  const scope = parseAnalyticsScope(query);
  const keep: Partial<AnalyticsScope> = {
    defaultBranchOnly: scope.defaultBranchOnly,
    fullRunsOnly: scope.fullRunsOnly,
  };
  if (scope.projectIds) keep.projectIds = scope.projectIds;
  if (scope.projectTags) keep.projectTags = scope.projectTags;
  if (scope.environments) keep.environments = scope.environments;
  if (scope.branches) keep.branches = scope.branches;
  if (scope.selection) keep.selection = scope.selection;
  if (scope.tests) keep.tests = scope.tests;
  if (scope.browsers) keep.browsers = scope.browsers;
  return keep;
}

function anchorFor(cadence: ReportCadence, anchor: number | null | undefined): number | null {
  if (cadence === 'daily') return null;
  if (cadence === 'monthly') return Math.min(MONTHLY_ANCHOR_MAX, Math.max(1, anchor ?? 1));
  return Math.min(7, Math.max(1, anchor ?? 1));
}

// ── Views ────────────────────────────────────────────────────────────────────

type ScheduleRow = typeof reportSchedules.$inferSelect;

export interface ReportScheduleView {
  id: number;
  name: string;
  /** Instance-wide, managed by administrators. */
  global: boolean;
  ownerId: number | null;
  /** The owner's display name; null for a global schedule. */
  ownerName: string | null;
  /** The reader owns it. */
  mine: boolean;
  /** A built-in key or a saved dashboard's id; null once its saved dashboard was deleted. */
  dashboard: string | null;
  dashboardName: string;
  /** Why an inactive schedule does not fire, when it is not a choice (its saved dashboard was deleted). */
  inactiveReason: string | null;
  /** The scope query keys of the schedule's filters, as the analytics page reads them. */
  scope: Record<string, string>;
  cadence: ReportCadence;
  anchor: number | null;
  at: string;
  comparison: ScheduleComparison;
  language: ReportLanguage | null;
  includeShareLink: boolean;
  includeNarrative: boolean;
  channels: ReportScheduleChannel[];
  active: boolean;
  mutedUntil: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Whether the reader may edit, run or delete it. */
  canEdit: boolean;
}

const iso = (value: Date | number | null | undefined) => (value == null ? null : new Date(value).toISOString());

function filtersQuery(filters: Partial<AnalyticsScope> | null): Record<string, string> {
  const query = analyticsScopeToQuery({ ...DEFAULT_ANALYTICS_SCOPE, ...filters });
  delete query.period;
  return query;
}

function canEdit(row: Pick<ScheduleRow, 'userId'>, actor: ReportActor): boolean {
  if (actor.isAdmin) return true;
  return row.userId !== null && row.userId === actor.id;
}

export const DASHBOARD_DELETED_REASON = 'Its saved dashboard was deleted. Pick another dashboard to reactivate it.';

/**
 * A schedule's channel as the reader sees it. An address or endpoint shows to
 * whoever could read it on the channels list (a global channel, their own) and
 * to administrators; anyone else reads whose it is, not where it points.
 */
function scheduleChannel(id: number, channel: ReportChannel | undefined, actor: ReportActor): ReportScheduleChannel {
  if (!channel)
    return { id, name: `Channel #${id}`, type: 'unknown', owner: null, recipient: 'nobody: it was deleted' };
  const owner = channelOwnerOf(channel.userId, actor.id, channel.ownerName);
  const reveal = actor.isAdmin || owner.kind !== 'user';
  return {
    id,
    name: channel.name,
    type: channel.type,
    owner,
    recipient: channelRecipient(reveal ? channel : { type: channel.type }, owner),
  };
}

/** The names a schedule view shows: its saved dashboard's and its owner's. */
interface ViewNames {
  dashboards: Map<number, string>;
  users: Map<number, string>;
}

function toView(row: ScheduleRow, channels: ReportChannel[], actor: ReportActor, names: ViewNames): ReportScheduleView {
  const dashboard =
    row.dashboardId !== null && row.dashboardId !== undefined
      ? String(row.dashboardId)
      : isBuiltinDashboardKey(row.builtinDashboard)
        ? row.builtinDashboard
        : null;
  const dashboardName =
    row.dashboardId != null
      ? (names.dashboards.get(row.dashboardId) ?? `Dashboard #${row.dashboardId}`)
      : dashboard
        ? getBuiltinDashboard(dashboard as BuiltinDashboardKey).name
        : 'Deleted dashboard';
  const ids = (row.channelIds as number[] | null) ?? [];
  const byId = new Map(channels.map((c) => [c.id, c]));
  return {
    id: row.id,
    name: row.name,
    global: row.userId === null,
    ownerId: row.userId,
    ownerName: row.userId === null ? null : (names.users.get(row.userId) ?? `User #${row.userId}`),
    mine: row.userId !== null && row.userId === actor.id,
    dashboard,
    dashboardName,
    inactiveReason: dashboard === null ? DASHBOARD_DELETED_REASON : null,
    scope: filtersQuery(row.scope as Partial<AnalyticsScope> | null),
    cadence: row.cadence as ReportCadence,
    anchor: row.anchor ?? null,
    at: row.at,
    comparison: row.comparison as ScheduleComparison,
    language: (row.language as ReportLanguage | null) ?? null,
    includeShareLink: row.includeShareLink,
    includeNarrative: row.includeNarrative,
    channels: ids.map((id) => scheduleChannel(id, byId.get(id), actor)),
    active: row.active,
    mutedUntil: iso(row.mutedUntil),
    lastRunAt: iso(row.lastRunAt),
    nextRunAt: iso(row.nextRunAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    canEdit: canEdit(row, actor),
  };
}

async function savedDashboardNames(db: DrizzleDB, rows: ScheduleRow[]): Promise<Map<number, string>> {
  const ids = [...new Set(rows.map((r) => r.dashboardId).filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: analyticsDashboards.id, name: analyticsDashboards.name })
    .from(analyticsDashboards)
    .where(inArray(analyticsDashboards.id, ids));
  return new Map(found.map((r) => [r.id, r.name]));
}

async function ownerNames(db: DrizzleDB, rows: ScheduleRow[]): Promise<Map<number, string>> {
  const ids = [...new Set(rows.map((r) => r.userId).filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(found.map((r) => [r.id, r.name || r.username]));
}

async function viewNames(db: DrizzleDB, rows: ScheduleRow[]): Promise<ViewNames> {
  const [dashboards, owners] = await Promise.all([savedDashboardNames(db, rows), ownerNames(db, rows)]);
  return { dashboards, users: owners };
}

async function viewOf(db: DrizzleDB, row: ScheduleRow, channels: ReportChannel[], actor: ReportActor) {
  return toView(row, channels, actor, await viewNames(db, [row]));
}

// ── Schedules ────────────────────────────────────────────────────────────────

/**
 * Every channel, for naming a schedule's destinations and who they reach: the
 * owner's name, and the address or endpoint from the config (never a secret).
 */
export async function loadReportChannels(db: DrizzleDB): Promise<ReportChannel[]> {
  const rows = await db
    .select({
      id: notificationChannels.id,
      name: notificationChannels.name,
      type: notificationChannels.type,
      userId: notificationChannels.userId,
      config: notificationChannels.config,
      ownerName: users.name,
      ownerUsername: users.username,
      ownerEmail: users.email,
    })
    .from(notificationChannels)
    .leftJoin(users, eq(users.id, notificationChannels.userId));
  return rows.map((r) => {
    const config = (r.config ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      userId: r.userId,
      ownerName: r.userId === null ? null : r.ownerName || r.ownerUsername || null,
      address: r.type === 'personal_email' ? text(r.ownerEmail) : text(config.address),
      url: text(config.url),
    };
  });
}

/**
 * The schedules a reader sees: administrators (and everyone with
 * authentication off) see them all; anyone else their own and the global ones.
 */
export async function listReportSchedules(
  db: DrizzleDB,
  actor: ReportActor,
  channels: ReportChannel[],
): Promise<ReportScheduleView[]> {
  const rows = await db.select().from(reportSchedules).orderBy(desc(reportSchedules.createdAt));
  const visible =
    actor.isAdmin || !actor.authEnabled ? rows : rows.filter((r) => r.userId === null || r.userId === actor.id);
  const names = await viewNames(db, visible);
  return visible.map((r) => toView(r, channels, actor, names));
}

async function loadSchedule(db: DrizzleDB, id: number): Promise<ScheduleRow> {
  const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id));
  if (!row) throw new ReportScheduleError(404, 'Report schedule not found');
  return row;
}

/** One schedule, when the reader may see it. */
export async function getReportSchedule(
  db: DrizzleDB,
  id: number,
  actor: ReportActor,
  channels: ReportChannel[],
): Promise<ReportScheduleView> {
  const row = await loadSchedule(db, id);
  const visible = actor.isAdmin || !actor.authEnabled || row.userId === null || row.userId === actor.id;
  if (!visible) throw new ReportScheduleError(404, 'Report schedule not found');
  return viewOf(db, row, channels, actor);
}

async function editableSchedule(db: DrizzleDB, id: number, actor: ReportActor): Promise<ScheduleRow> {
  const row = await loadSchedule(db, id);
  if (!canEdit(row, actor)) {
    if (row.userId !== null && row.userId !== actor.id && !actor.isAdmin) {
      throw new ReportScheduleError(404, 'Report schedule not found');
    }
    throw new ReportScheduleError(403, 'Only administrators can change a global schedule');
  }
  return row;
}

export interface ScheduleWriteContext {
  actor: ReportActor;
  channels: ReportChannel[];
  /** The actor's project access, checked against the schedule's project filter. */
  access: ProjectAccess;
  /** The zone schedules run in (`scheduleTimeZone`). */
  timeZone: string;
  now?: number;
}

/** The dashboard actor a schedule's actor stands for: what saved dashboards it may open, which needs no right to share. */
function dashboardActorOf(actor: ReportActor): DashboardActor {
  return { id: actor.id, authEnabled: actor.authEnabled, isAdmin: actor.isAdmin, canShare: actor.isAdmin };
}

/** The dashboard a schedule renders: a built-in key, or a saved dashboard the actor may open. */
async function scheduleDashboard(
  db: DrizzleDB,
  ref: string,
  actor: ReportActor,
  global: boolean,
): Promise<{
  builtin: BuiltinDashboardKey | null;
  savedId: number | null;
  name: string;
  definition: DashboardDefinition;
}> {
  if (isBuiltinDashboardKey(ref)) {
    const builtin = getBuiltinDashboard(ref);
    return { builtin: ref, savedId: null, name: builtin.name, definition: builtin.definition };
  }
  let loaded;
  try {
    loaded = await loadDashboardDefinition(db, ref, dashboardActorOf(actor));
  } catch (error) {
    if (error instanceof DashboardError) throw new ReportScheduleError(error.statusCode, error.message);
    throw error;
  }
  // A global schedule reports to everyone its channels reach, so its dashboard must be one everyone can open.
  if (global && actor.authEnabled && loaded.row?.visibility !== 'shared') {
    throw new ReportScheduleError(400, 'A global schedule needs a built-in or a shared dashboard');
  }
  return { builtin: null, savedId: loaded.row!.id, name: loaded.row!.name, definition: loaded.definition };
}

/** What a schedule's scope needs: its built-in dashboard's filter (the team owner) and the actor's access to its projects. */
function checkScheduleScope(
  values: {
    dashboard: { builtin: BuiltinDashboardKey | null; definition: DashboardDefinition };
    filters: Partial<AnalyticsScope>;
  },
  access: ProjectAccess,
): void {
  if (values.dashboard.builtin) {
    try {
      assertDashboardScope(values.dashboard.builtin, {
        ...dashboardScope(values.dashboard.definition),
        ...values.filters,
      });
    } catch (error) {
      if (error instanceof ReportRequestError) throw new ReportScheduleError(400, error.message);
      throw error;
    }
  }
  const projectIds = values.filters.projectIds ?? [];
  if (access !== 'all' && projectIds.some((id) => !access.has(id))) {
    throw new ReportScheduleError(403, 'No access to a project of this schedule');
  }
}

function checkSchedule(
  values: {
    dashboard: { builtin: BuiltinDashboardKey | null; definition: DashboardDefinition };
    filters: Partial<AnalyticsScope>;
    channelIds: number[];
    global: boolean;
  },
  ctx: ScheduleWriteContext,
): void {
  checkScheduleScope(values, ctx.access);
  if (values.global && ctx.actor.authEnabled && !ctx.actor.isAdmin) {
    throw new ReportScheduleError(403, 'Only administrators can create global schedules');
  }
  const byId = new Map(ctx.channels.map((c) => [c.id, c]));
  for (const id of values.channelIds) {
    const channel = byId.get(id);
    if (!channel) throw new ReportScheduleError(404, `Channel #${id} not found`);
    // A global schedule delivers without a per-user access check, so a personal
    // channel would carry every project's numbers to its owner.
    if (values.global && channel.userId !== null) {
      throw new ReportScheduleError(400, 'Global schedules require global channels');
    }
    if (!values.global && channel.userId !== null && channel.userId !== ctx.actor.id && !ctx.actor.isAdmin) {
      throw new ReportScheduleError(403, "Cannot send to another user's channel");
    }
  }
}

/** Create a schedule; it first fires at its next scheduled instant. */
export async function createReportSchedule(
  db: DrizzleDB,
  input: ReportScheduleInput,
  ctx: ScheduleWriteContext,
): Promise<ReportScheduleView> {
  const now = ctx.now ?? Date.now();
  const global = input.global === true || !ctx.actor.authEnabled;
  const filters = scheduleFilters(input.scope);
  const dashboard = await scheduleDashboard(db, input.dashboard, ctx.actor, global);
  checkSchedule({ dashboard, filters, channelIds: input.channelIds, global }, ctx);
  const anchor = anchorFor(input.cadence, input.anchor);
  const at = normalizeScheduleTime(input.at);
  const createdAt = new Date(now);
  const [row] = await db
    .insert(reportSchedules)
    .values({
      name: input.name,
      userId: global ? null : ctx.actor.id,
      scope: filters,
      builtinDashboard: dashboard.builtin,
      dashboardId: dashboard.savedId,
      cadence: input.cadence,
      anchor,
      at,
      comparison: input.comparison,
      language: input.language ?? null,
      includeShareLink: input.includeShareLink ?? false,
      includeNarrative: input.includeNarrative ?? false,
      channelIds: [...new Set(input.channelIds)],
      active: input.active ?? true,
      mutedUntil: input.mutedUntil ? new Date(input.mutedUntil) : null,
      nextRunAt: nextRunAt({ cadence: input.cadence, anchor, at, createdAt }, now, ctx.timeZone),
      createdAt,
      updatedAt: createdAt,
    })
    .returning();
  return viewOf(db, row!, ctx.channels, ctx.actor);
}

/** Change a schedule; a new cadence, anchor or time moves its next firing. */
export async function updateReportSchedule(
  db: DrizzleDB,
  id: number,
  patch: ReportSchedulePatch,
  ctx: ScheduleWriteContext,
): Promise<ReportScheduleView> {
  const now = ctx.now ?? Date.now();
  const row = await editableSchedule(db, id, ctx.actor);
  const global = patch.global !== undefined ? patch.global || !ctx.actor.authEnabled : row.userId === null;
  const currentRef =
    row.dashboardId != null
      ? String(row.dashboardId)
      : isBuiltinDashboardKey(row.builtinDashboard)
        ? row.builtinDashboard
        : null;
  const ref = patch.dashboard ?? currentRef;
  if (ref === null)
    throw new ReportScheduleError(400, 'Pick a dashboard for this schedule: its saved dashboard was deleted');
  const dashboard = await scheduleDashboard(db, ref, ctx.actor, global);
  const filters = patch.scope ? scheduleFilters(patch.scope) : ((row.scope as Partial<AnalyticsScope> | null) ?? {});
  const channelIds = patch.channelIds ? [...new Set(patch.channelIds)] : ((row.channelIds as number[] | null) ?? []);
  checkSchedule({ dashboard, filters, channelIds, global }, ctx);

  const cadence = patch.cadence ?? (row.cadence as ReportCadence);
  const anchor = anchorFor(cadence, patch.anchor !== undefined ? patch.anchor : row.anchor);
  const at = patch.at ? normalizeScheduleTime(patch.at) : row.at;
  const timingChanged = cadence !== row.cadence || anchor !== row.anchor || at !== row.at;
  // Pointing a schedule whose dashboard was deleted at another one reactivates it.
  const repointed = currentRef === null && patch.dashboard !== undefined && patch.active !== false;
  const reactivated = (patch.active === true || repointed) && !row.active;
  const next =
    timingChanged || reactivated || !row.nextRunAt
      ? nextRunAt({ cadence, anchor, at, createdAt: row.createdAt }, now, ctx.timeZone)
      : row.nextRunAt;

  const [updated] = await db
    .update(reportSchedules)
    .set({
      name: patch.name ?? row.name,
      userId: global ? null : (row.userId ?? ctx.actor.id),
      scope: filters,
      builtinDashboard: dashboard.builtin,
      dashboardId: dashboard.savedId,
      cadence,
      anchor,
      at,
      comparison: patch.comparison ?? row.comparison,
      language: patch.language !== undefined ? patch.language : row.language,
      includeShareLink: patch.includeShareLink ?? row.includeShareLink,
      includeNarrative: patch.includeNarrative ?? row.includeNarrative,
      channelIds,
      active: repointed ? true : (patch.active ?? row.active),
      mutedUntil:
        patch.mutedUntil !== undefined ? (patch.mutedUntil ? new Date(patch.mutedUntil) : null) : row.mutedUntil,
      nextRunAt: next,
      updatedAt: new Date(now),
    })
    .where(eq(reportSchedules.id, id))
    .returning();
  return viewOf(db, updated!, ctx.channels, ctx.actor);
}

/** Delete a schedule; its snapshots stay, as reports generated by hand. */
export async function deleteReportSchedule(db: DrizzleDB, id: number, actor: ReportActor): Promise<void> {
  await editableSchedule(db, id, actor);
  await db.delete(reportSchedules).where(eq(reportSchedules.id, id));
}

// ── Running a schedule ───────────────────────────────────────────────────────

export interface GenerateContext {
  /** The project access the report is collected with: the schedule owner's at run time. */
  access: ProjectAccess;
  timeZone: string;
  baseUrl?: string | null;
  piwiVersion?: string | null;
  /** Queue one outbox row per channel; the demo has no outbox. */
  deliver: boolean;
  /**
   * Mint a share link to a snapshot that expires at the given instant, and
   * return its token sealed for the outbox payload. Absent where share links
   * are off (and in the demo); a schedule with `includeShareLink` then sends
   * its messages without one.
   */
  mintShareLink?: (snapshotId: number, expiresAt: Date, createdBy: number | null) => Promise<string>;
  /**
   * Write the AI narrative of a bundle, or answer null (no provider, a
   * failure, an ungrounded answer). Absent in the demo, which has no model.
   */
  narrative?: (bundle: ReportBundle) => Promise<GeneratedNarrative | null>;
  now?: number;
}

export interface ScheduleRunResult {
  snapshotId: number;
  period: SchedulePeriod;
  /** Outbox rows queued (0 when muted or not delivering). */
  queued: number;
  muted: boolean;
}

/** The dashboard a firing renders; a schedule whose saved dashboard was deleted cannot fire. */
async function runDashboard(db: DrizzleDB, schedule: ScheduleRow): Promise<BuiltinDashboardKey | ReportDashboard> {
  if (schedule.dashboardId != null) {
    const [row] = await db.select().from(analyticsDashboards).where(eq(analyticsDashboards.id, schedule.dashboardId));
    if (row) return { ref: String(row.id), name: row.name, definition: row.definition as DashboardDefinition };
  } else if (isBuiltinDashboardKey(schedule.builtinDashboard)) {
    return schedule.builtinDashboard;
  }
  throw new ReportScheduleError(409, DASHBOARD_DELETED_REASON);
}

/** How long a scheduled report's share link outlives the next report of its schedule. */
export const SHARE_LINK_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const COMPARISONS: Record<ScheduleComparison, ComparisonSpec> = {
  previous: { kind: 'previous' },
  'year-ago': { kind: 'year' },
  none: { kind: 'none' },
};

/** The ids of the projects a bundle covers: the scope resolved against the access it was collected with. */
async function coveredProjects(db: DrizzleDB, scope: AnalyticsScope, access: ProjectAccess): Promise<number[]> {
  const ctx = await getAnalyticsContext(db, scope, access);
  if (ctx.allowed !== 'all') return [...ctx.allowed].sort((a, b) => a - b);
  const rows = await db.select({ id: projects.id }).from(projects);
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

async function storeSnapshot(
  db: DrizzleDB,
  values: {
    bundle: ReportBundle;
    scope: AnalyticsScope;
    projectIds: number[];
    scheduleId: number | null;
    createdBy: number | null;
  },
): Promise<number> {
  const { bundle } = values;
  const json = JSON.stringify(bundle);
  const [row] = await db
    .insert(reportSnapshots)
    .values({
      scheduleId: values.scheduleId,
      createdBy: values.createdBy,
      dashboardRef: bundle.dashboard.ref,
      dashboardName: bundle.dashboard.name,
      scope: values.scope,
      projectIds: values.projectIds,
      periodFrom: new Date(bundle.period.from),
      periodTo: new Date(bundle.period.to),
      comparisonFrom: bundle.comparison ? new Date(bundle.comparison.from) : null,
      comparisonTo: bundle.comparison ? new Date(bundle.comparison.to) : null,
      bundle,
      sizeBytes: new TextEncoder().encode(json).length,
      generatedAt: new Date(bundle.generatedAt),
    })
    .returning({ id: reportSnapshots.id });
  return row!.id;
}

/**
 * A schedule's quality report over one period, as a firing collects it: the
 * dashboard's scope under the schedule's filters, the period as whole days,
 * the schedule's comparison and language, the title led by its name. A firing
 * and the preview both go through it, so the preview shows what is sent.
 */
async function collectScheduleBundle(
  db: DrizzleDB,
  values: {
    name: string;
    dashboard: BuiltinDashboardKey | ReportDashboard;
    filters: Partial<AnalyticsScope> | null;
    comparison: ScheduleComparison;
    language: ReportLanguage | null;
  },
  period: SchedulePeriod,
  ctx: Pick<GenerateContext, 'access' | 'timeZone' | 'baseUrl' | 'piwiVersion'> & { now: number },
): Promise<{ bundle: ReportBundle; scope: AnalyticsScope }> {
  const definition =
    typeof values.dashboard === 'string'
      ? getBuiltinDashboard(values.dashboard).definition
      : values.dashboard.definition;
  const scope: AnalyticsScope = {
    ...dashboardScope(definition),
    ...(values.filters ?? {}),
    period: { kind: 'range', from: period.from, to: period.to },
    comparison: COMPARISONS[values.comparison] ?? { kind: 'previous' },
    granularity: 'auto',
    timeZone: ctx.timeZone,
  };
  const bundle = await collectReportBundle(db, {
    dashboard: values.dashboard,
    scope,
    access: ctx.access,
    language: values.language ?? undefined,
    timeZone: ctx.timeZone,
    baseUrl: ctx.baseUrl ?? null,
    piwiVersion: ctx.piwiVersion ?? null,
    now: ctx.now,
  });
  if (values.name) bundle.title = `${values.name}${sentencesFor(bundle.language).colon}${bundle.title}`;
  return { bundle, scope };
}

/**
 * Render one firing of a schedule into a snapshot, and queue its deliveries.
 * A scheduled firing (`runAt`) reports on the period that firing covers; *Run
 * now* (`runAt` omitted) on the last complete cadence. A muted schedule keeps
 * its snapshot and sends nothing.
 */
export async function runReportSchedule(
  db: DrizzleDB,
  schedule: ScheduleRow,
  ctx: GenerateContext & { runAt?: number; createdBy?: number | null },
): Promise<ScheduleRunResult> {
  const now = ctx.now ?? Date.now();
  const timing = {
    cadence: schedule.cadence as ReportCadence,
    anchor: schedule.anchor,
    at: schedule.at,
    createdAt: schedule.createdAt,
  };
  const manual = ctx.runAt === undefined;
  const period = manual ? lastCompletePeriod(timing, now, ctx.timeZone) : periodFor(timing, ctx.runAt!, ctx.timeZone);
  const { bundle, scope } = await collectScheduleBundle(
    db,
    {
      name: schedule.name,
      dashboard: await runDashboard(db, schedule),
      filters: schedule.scope as Partial<AnalyticsScope> | null,
      comparison: schedule.comparison as ScheduleComparison,
      language: (schedule.language as ReportLanguage | null) ?? null,
    },
    period,
    { ...ctx, now },
  );
  if (schedule.includeNarrative) applyNarrative(bundle, ctx.narrative ? await ctx.narrative(bundle) : null);
  if (period.firstRun) {
    const f = makeFormatter(bundle.language, bundle.locale);
    bundle.limits.unshift(sentencesFor(bundle.language).firstRunLimit(f.date(period.from)));
  }
  const snapshotId = await storeSnapshot(db, {
    bundle,
    scope,
    projectIds: await coveredProjects(db, scope, ctx.access),
    scheduleId: schedule.id,
    createdBy: ctx.createdBy ?? null,
  });
  if (bundle.sourceUrl && ctx.baseUrl) {
    bundle.sourceUrl = `${ctx.baseUrl.replace(/\/$/, '')}/reports/${snapshotId}`;
    await db.update(reportSnapshots).set({ bundle }).where(eq(reportSnapshots.id, snapshotId));
  }

  const muted = !!schedule.mutedUntil && new Date(schedule.mutedUntil).getTime() > now;
  let queued = 0;
  if (ctx.deliver && !muted) {
    const wanted = (schedule.channelIds as number[] | null) ?? [];
    const existing =
      wanted.length > 0
        ? await db
            .select({ id: notificationChannels.id })
            .from(notificationChannels)
            .where(inArray(notificationChannels.id, wanted))
        : [];
    const payload: ReportReadyPayload = { snapshotId, scheduleId: schedule.id, periodEnd: period.to };
    if (schedule.includeShareLink && ctx.mintShareLink && existing.length > 0) {
      // The link outlives the next report by a grace, so a reader can still open this one when the next arrives.
      const next = nextRunAt(timing, ctx.runAt ?? now, ctx.timeZone);
      const expiresAt = new Date(next.getTime() + SHARE_LINK_GRACE_MS);
      payload.shareToken = await ctx.mintShareLink(snapshotId, expiresAt, schedule.userId);
    }
    for (const { id: channelId } of existing) {
      const inserted = await db
        .insert(notificationDeliveries)
        .values({
          subscriptionId: null,
          channelId,
          event: REPORT_READY_EVENT,
          payload,
          dedupeKey: reportDedupeKey(schedule.id, period.to, channelId, manual ? snapshotId : undefined),
          status: 'pending',
          scheduledFor: new Date(now),
        })
        .onConflictDoNothing()
        .returning({ id: notificationDeliveries.id });
      queued += inserted.length;
    }
  }
  await db
    .update(reportSchedules)
    .set({ lastRunAt: new Date(now) })
    .where(eq(reportSchedules.id, schedule.id));
  return { snapshotId, period, queued, muted };
}

/** *Run now*: generate a schedule's quality report over its last complete cadence and deliver it. */
export async function runReportScheduleNow(
  db: DrizzleDB,
  id: number,
  actor: ReportActor,
  ctx: GenerateContext,
): Promise<ScheduleRunResult> {
  const row = await editableSchedule(db, id, actor);
  return runReportSchedule(db, row, { ...ctx, createdBy: actor.id });
}

export interface ReportSchedulePreview {
  bundle: ReportBundle;
  /** The whole days the report covers: the last complete cadence, the period of *Run now*. */
  period: SchedulePeriod;
  /** The instance address the report's links and its email name. */
  siteUrl: string | null;
}

/**
 * The quality report a schedule would send now, before it is saved: the same
 * dashboard, filters, comparison and language as a firing, over the last
 * complete cadence (the period of *Run now*), collected with the caller's
 * project access. Nothing is stored or sent, and no AI narrative is written:
 * the rule-based verdict stands in its place.
 */
export async function previewReportSchedule(
  db: DrizzleDB,
  input: ReportSchedulePreviewInput,
  ctx: Pick<GenerateContext, 'access' | 'timeZone' | 'baseUrl' | 'piwiVersion' | 'now'> & { actor: ReportActor },
): Promise<ReportSchedulePreview> {
  const now = ctx.now ?? Date.now();
  const global = input.global === true || !ctx.actor.authEnabled;
  const filters = scheduleFilters(input.scope);
  const dashboard = await scheduleDashboard(db, input.dashboard, ctx.actor, global);
  checkScheduleScope({ dashboard, filters }, ctx.access);
  const timing = {
    cadence: input.cadence,
    anchor: anchorFor(input.cadence, input.anchor),
    at: normalizeScheduleTime(input.at),
    createdAt: input.createdAt ? new Date(input.createdAt) : new Date(now),
  };
  const period = lastCompletePeriod(timing, now, ctx.timeZone);
  const { bundle } = await collectScheduleBundle(
    db,
    {
      name: input.name ?? '',
      dashboard: dashboard.builtin ?? {
        ref: String(dashboard.savedId),
        name: dashboard.name,
        definition: dashboard.definition,
      },
      filters,
      comparison: input.comparison,
      language: input.language ?? null,
    },
    period,
    { ...ctx, now },
  );
  return { bundle, period, siteUrl: ctx.baseUrl ? ctx.baseUrl.replace(/\/$/, '') : null };
}

/**
 * The `reports:schedule` sweep: every active schedule whose next firing is
 * due fires once, for its intended period (the latest one when the server
 * missed several), then moves to its next firing. `accessFor` resolves a
 * schedule owner's project access at run time (a global schedule, owner null,
 * sees every project).
 */
export async function sweepReportSchedules(
  db: DrizzleDB,
  ctx: Omit<GenerateContext, 'access'> & { accessFor: (userId: number | null) => Promise<ProjectAccess> },
): Promise<{ fired: number; failed: number }> {
  const now = ctx.now ?? Date.now();
  const due = await db
    .select()
    .from(reportSchedules)
    .where(
      and(
        eq(reportSchedules.active, true),
        isNotNull(reportSchedules.nextRunAt),
        lte(reportSchedules.nextRunAt, new Date(now)),
      ),
    );
  let fired = 0;
  let failed = 0;
  for (const schedule of due) {
    const timing = {
      cadence: schedule.cadence as ReportCadence,
      anchor: schedule.anchor,
      at: schedule.at,
      createdAt: schedule.createdAt,
    };
    const runAt = latestDueRun(timing, new Date(schedule.nextRunAt!).getTime(), now, ctx.timeZone);
    // Advance first, so a failing schedule is retried at its next firing rather than every sweep.
    await db
      .update(reportSchedules)
      .set({ nextRunAt: nextRunAt(timing, runAt.getTime(), ctx.timeZone) })
      .where(eq(reportSchedules.id, schedule.id));
    try {
      const access = await ctx.accessFor(schedule.userId);
      await runReportSchedule(db, schedule, { ...ctx, access, runAt: runAt.getTime(), now });
      fired++;
    } catch (error) {
      failed++;
      console.error(`[reports] Schedule ${schedule.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return { fired, failed };
}

/** Move every schedule's next firing onto the current time zone, when the instance zone changes. */
export async function rescheduleReportSchedules(db: DrizzleDB, timeZone: string, now = Date.now()): Promise<void> {
  const rows = await db.select().from(reportSchedules).where(eq(reportSchedules.active, true));
  for (const row of rows) {
    const next = nextRunAt(
      { cadence: row.cadence as ReportCadence, anchor: row.anchor, at: row.at, createdAt: row.createdAt },
      now,
      timeZone,
    );
    await db.update(reportSchedules).set({ nextRunAt: next }).where(eq(reportSchedules.id, row.id));
  }
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/** Generate a quality report by hand and keep it as a snapshot. */
export async function createReportSnapshot(
  db: DrizzleDB,
  request: { dashboard: BuiltinDashboardKey | ReportDashboard; scope: AnalyticsScope; language?: ReportLanguage },
  ctx: Omit<GenerateContext, 'deliver'> & { createdBy: number | null },
): Promise<{ id: number }> {
  const bundle = await collectReportBundle(db, {
    dashboard: request.dashboard,
    scope: request.scope,
    access: ctx.access,
    language: request.language,
    locale: request.scope.locale,
    timeZone: request.scope.timeZone ?? ctx.timeZone,
    baseUrl: ctx.baseUrl ?? null,
    piwiVersion: ctx.piwiVersion ?? null,
    now: ctx.now,
  });
  const id = await storeSnapshot(db, {
    bundle,
    scope: request.scope,
    projectIds: await coveredProjects(db, request.scope, ctx.access),
    scheduleId: null,
    createdBy: ctx.createdBy,
  });
  return { id };
}

export interface ReportDeliveryView {
  channelId: number;
  channelName: string;
  channelType: string;
  status: string;
  error: string | null;
  sentAt: string | null;
}

export interface ReportSnapshotSummary {
  id: number;
  title: string;
  scheduleId: number | null;
  scheduleName: string | null;
  dashboardRef: string;
  dashboardName: string;
  scopeText: ReportBundle['scopeText'];
  period: ReportBundle['period'];
  verdict: ReportBundle['verdict'];
  generatedAt: string;
  sizeBytes: number;
  deliveries: ReportDeliveryView[];
}

export interface ReportSnapshotView extends ReportSnapshotSummary {
  bundle: ReportBundle;
}

/** A snapshot is readable when the reader can open every project it covers. */
export function canReadSnapshot(projectIds: unknown, access: ProjectAccess): boolean {
  if (access === 'all') return true;
  // No list means every project: only a reader of every project may open it.
  if (!Array.isArray(projectIds)) return false;
  return (projectIds as number[]).every((id) => access.has(id));
}

/** Snapshots read per page while looking for the ones a reader may open. */
const SNAPSHOT_SCAN = 200;

async function deliveriesFor(
  db: DrizzleDB,
  snapshotIds: number[],
  since: Date,
): Promise<Map<number, ReportDeliveryView[]>> {
  const out = new Map<number, ReportDeliveryView[]>();
  if (snapshotIds.length === 0) return out;
  const wanted = new Set(snapshotIds);
  const rows = await db
    .select({ d: notificationDeliveries, name: notificationChannels.name, type: notificationChannels.type })
    .from(notificationDeliveries)
    .innerJoin(notificationChannels, eq(notificationDeliveries.channelId, notificationChannels.id))
    .where(and(eq(notificationDeliveries.event, REPORT_READY_EVENT), gte(notificationDeliveries.createdAt, since)));
  for (const { d, name, type } of rows) {
    const snapshotId = (d.payload as ReportReadyPayload | null)?.snapshotId;
    if (!snapshotId || !wanted.has(snapshotId)) continue;
    const list = out.get(snapshotId) ?? [];
    list.push({
      channelId: d.channelId,
      channelName: name,
      channelType: type,
      status: d.status,
      error: d.error ?? null,
      sentAt: iso(d.sentAt),
    });
    out.set(snapshotId, list);
  }
  return out;
}

function summaryOf(
  row: typeof reportSnapshots.$inferSelect,
  scheduleName: string | null,
  deliveries: ReportDeliveryView[],
): ReportSnapshotView {
  const bundle = row.bundle as ReportBundle;
  return {
    id: row.id,
    title: bundle.title,
    scheduleId: row.scheduleId ?? null,
    scheduleName,
    dashboardRef: row.dashboardRef,
    dashboardName: row.dashboardName,
    scopeText: bundle.scopeText,
    period: bundle.period,
    verdict: bundle.verdict,
    generatedAt: iso(row.generatedAt)!,
    sizeBytes: row.sizeBytes,
    deliveries,
    bundle,
  };
}

/** The snapshots a reader can open, newest first, with how each was delivered. */
export async function listReportSnapshots(
  db: DrizzleDB,
  access: ProjectAccess,
  opts: { limit?: number; scheduleId?: number } = {},
): Promise<ReportSnapshotSummary[]> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  // Page through the snapshots, newest first, until `limit` of them are readable: the latest ones may all
  // cover projects this reader cannot open (a global schedule's), and their own snapshots come after.
  const ids: number[] = [];
  let cursor: { generatedAt: Date; id: number } | null = null;
  while (ids.length < limit) {
    const page: Array<{ id: number; generatedAt: Date; projectIds: unknown }> = await db
      .select({
        id: reportSnapshots.id,
        generatedAt: reportSnapshots.generatedAt,
        projectIds: reportSnapshots.projectIds,
      })
      .from(reportSnapshots)
      .where(
        and(
          opts.scheduleId ? eq(reportSnapshots.scheduleId, opts.scheduleId) : undefined,
          cursor
            ? or(
                lt(reportSnapshots.generatedAt, cursor.generatedAt),
                and(eq(reportSnapshots.generatedAt, cursor.generatedAt), lt(reportSnapshots.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(reportSnapshots.generatedAt), desc(reportSnapshots.id))
      .limit(SNAPSHOT_SCAN);
    for (const row of page) if (canReadSnapshot(row.projectIds, access)) ids.push(row.id);
    if (page.length < SNAPSHOT_SCAN) break;
    const last = page[page.length - 1]!;
    cursor = { generatedAt: last.generatedAt, id: last.id };
  }
  if (ids.length === 0) return [];
  const wanted = ids.slice(0, limit);
  const readable = await db
    .select({ s: reportSnapshots, scheduleName: reportSchedules.name })
    .from(reportSnapshots)
    .leftJoin(reportSchedules, eq(reportSnapshots.scheduleId, reportSchedules.id))
    .where(inArray(reportSnapshots.id, wanted))
    .orderBy(desc(reportSnapshots.generatedAt), desc(reportSnapshots.id));
  if (readable.length === 0) return [];
  const oldest = readable[readable.length - 1]!.s.generatedAt;
  const deliveries = await deliveriesFor(
    db,
    readable.map((r) => r.s.id),
    new Date(new Date(oldest).getTime() - 60_000),
  );
  return readable.map((r) => {
    const { bundle: _bundle, ...summary } = summaryOf(r.s, r.scheduleName ?? null, deliveries.get(r.s.id) ?? []);
    return summary;
  });
}

/** One snapshot with its bundle; 404 when missing, 403 when it covers a project the reader cannot open. */
export async function getReportSnapshot(db: DrizzleDB, id: number, access: ProjectAccess): Promise<ReportSnapshotView> {
  const [row] = await db
    .select({ s: reportSnapshots, scheduleName: reportSchedules.name })
    .from(reportSnapshots)
    .leftJoin(reportSchedules, eq(reportSnapshots.scheduleId, reportSchedules.id))
    .where(eq(reportSnapshots.id, id));
  if (!row) throw new ReportScheduleError(404, 'Report snapshot not found');
  if (!canReadSnapshot(row.s.projectIds, access)) {
    throw new ReportScheduleError(403, 'This quality report covers a project you cannot open');
  }
  const deliveries = await deliveriesFor(db, [id], new Date(new Date(row.s.generatedAt).getTime() - 60_000));
  return summaryOf(row.s, row.scheduleName ?? null, deliveries.get(id) ?? []);
}

/** A snapshot's bundle and projects for a delivery, with no access check (the schedule's access applied at generation). */
export async function loadSnapshotForDelivery(
  db: DrizzleDB,
  id: number,
): Promise<{ bundle: ReportBundle; projectIds: number[] } | null> {
  const [row] = await db
    .select({ bundle: reportSnapshots.bundle, projectIds: reportSnapshots.projectIds })
    .from(reportSnapshots)
    .where(eq(reportSnapshots.id, id));
  if (!row) return null;
  return { bundle: row.bundle as ReportBundle, projectIds: (row.projectIds as number[] | null) ?? [] };
}

/** The owners the tests of the reader's projects carry, for the team dashboard's owner filter. */
export async function listScheduleOwners(
  db: DrizzleDB,
  access: ProjectAccess,
): Promise<Array<{ owner: string; projectIds: number[] }>> {
  if (access !== 'all' && access.size === 0) return [];
  const rows = await db
    .selectDistinct({ owner: testCases.owner, projectId: testCases.projectId })
    .from(testCases)
    .where(and(isNotNull(testCases.owner), access === 'all' ? undefined : inArray(testCases.projectId, [...access])))
    .limit(2000);
  const byOwner = new Map<string, Set<number>>();
  for (const r of rows) {
    const owner = r.owner?.trim();
    if (!owner) continue;
    const set = byOwner.get(owner) ?? new Set<number>();
    set.add(r.projectId);
    byOwner.set(owner, set);
  }
  return [...byOwner.entries()]
    .map(([owner, ids]) => ({ owner, projectIds: [...ids].sort((a, b) => a - b) }))
    .sort((a, b) => a.owner.localeCompare(b.owner));
}

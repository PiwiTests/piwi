import type { H3Event } from 'h3';
import { apiError } from './api-error';
import { getDatabase } from '../database';
import type { DbClient } from '../database';
import {
  testRuns,
  testCases,
  testRunsCases,
  failureClusters,
  bugReports,
  failureDiagnoses,
  markers,
  testFunctions,
  entityLinks,
} from '../database/schema';
import { eq } from 'drizzle-orm';
import { isVisibleRun } from '#shared/run-eligibility';
import { requireAuth, isAuthEnabled, getRequestAccess, getUserAccessCached, requiredPermissionsFor } from './auth';
import {
  can,
  passesProjectCheck,
  projectScopeFor,
  type ProjectPermission,
  type RoutePermission,
} from '#shared/permissions';
import type { User } from '../database/schema';
import { parseRouteId, parseRouteIndex } from '#shared/route-id';

export type DrizzleDB = DbClient;

export type ProjectScope = 'all' | Set<number>;

/**
 * The projects on which `user` holds `permission`: `'all'` for an
 * administrator or a role granted on all projects, else the project ids. With
 * authentication off, or no user, every project.
 */
export async function getProjectScope(
  db: DrizzleDB,
  user: User | null,
  permission: ProjectPermission = 'project:read',
): Promise<ProjectScope> {
  if (!user || !isAuthEnabled()) {
    return 'all';
  }
  return projectScopeFor(await getUserAccessCached(db, user), permission);
}

export function scopeAllows(scope: ProjectScope, projectId: number): boolean {
  return scope === 'all' || scope.has(projectId);
}

export async function canAccessProject(
  db: DrizzleDB,
  user: User | null,
  projectId: number,
  permission: ProjectPermission = 'project:read',
): Promise<boolean> {
  const scope = await getProjectScope(db, user, permission);
  return scopeAllows(scope, projectId);
}

/**
 * Require the caller to hold, on `projectId`, one of the permissions the route
 * declares in `x-required-permission` (or of `permission`, which overrides the
 * meta like `requireAuth`'s argument). A route declaring none, or `signed-in`,
 * needs `project:read` there.
 */
export async function requireProjectAccess(
  event: H3Event,
  projectId: number,
  permission?: RoutePermission | RoutePermission[],
): Promise<User> {
  const user = await requireAuth(event, permission);
  await requireProjectPermission(event, projectId, permission);
  return user;
}

/**
 * The project decision of `requireProjectAccess`, for a handler that already
 * called `requireAuth`: it reads the access `requireAuth` loaded, so the caller
 * is identified once per request.
 */
export async function requireProjectPermission(
  event: H3Event,
  projectId: number,
  permission?: RoutePermission | RoutePermission[],
): Promise<void> {
  const access = await getRequestAccess(event);
  if (!passesProjectCheck(access, requiredPermissionsFor(event, permission), projectId)) {
    throw apiError({
      statusCode: 403,
      message: can(access, 'project:read', projectId) ? 'Insufficient permissions' : 'No access to this project',
    });
  }
}

/** Whether the caller holds at least one of `permissions` on `projectId`. */
export async function holdsProjectPermission(
  event: H3Event,
  projectId: number,
  permissions: readonly ProjectPermission[],
): Promise<boolean> {
  const access = await getRequestAccess(event);
  return permissions.some((permission) => can(access, permission, projectId));
}

/**
 * Parse and validate a numeric route param, throwing 400 if missing/invalid. The param is a positive integer written
 * plainly: `12`, never `012`, `12abc` or `12\..\x`, which `parseInt` would read as 12, and at most the largest
 * `serial` id (`parseRouteId`).
 */
export function requireRouteId(event: H3Event, paramName = 'id', label = 'ID'): number {
  const id = parseRouteId(getRouterParam(event, paramName));
  if (id === null) throw apiError({ statusCode: 400, message: `Invalid ${label}` });
  return id;
}

/** Parse and validate a 0-based position of a route (`0`, `12`, never `012`), throwing 400 if missing/invalid. */
export function requireRouteIndex(event: H3Event, paramName: string, label: string): number {
  const index = parseRouteIndex(getRouterParam(event, paramName));
  if (index === null) throw apiError({ statusCode: 400, message: `Invalid ${label}` });
  return index;
}

/**
 * Authenticate the caller (`requireAuth`), resolve a child entity's project via
 * `resolve`, 404 if the entity doesn't exist, then require the caller holds the
 * route's permission on that project (see `requireProjectAccess`). A caller
 * without credentials gets 401 whether the entity exists or not. Returns the
 * db/projectId/user so callers don't need a second getDatabase() call.
 */
export async function requireResolvedProjectAccess(
  event: H3Event,
  id: number,
  resolve: (db: DrizzleDB, id: number, viewerId: number) => Promise<number | null>,
  notFoundLabel: string,
  permission?: RoutePermission | RoutePermission[],
): Promise<{ db: DrizzleDB; projectId: number; user: User }> {
  const user = await requireAuth(event, permission);
  const db = await getDatabase();
  const projectId = await resolve(db, id, user.id);
  if (!projectId) throw apiError({ statusCode: 404, message: `${notFoundLabel} not found` });
  await requireProjectPermission(event, projectId, permission);
  return { db, projectId, user };
}

// Helpers to resolve projectId from entity IDs

/**
 * The project of a run `viewerId` sees, or null: a missing run, and another person's private run (`isVisibleRun`),
 * are both answered as missing.
 */
export async function resolveRunProjectId(
  db: DrizzleDB,
  runId: number,
  viewerId: number | null,
): Promise<number | null> {
  const rows = await db
    .select({ projectId: testRuns.projectId, origin: testRuns.origin, requesterId: testRuns.requesterId })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  const run = rows[0];
  return run && isVisibleRun(run, viewerId) ? run.projectId : null;
}

/** The most runs a stream's `runVisibilityReader` remembers; past it, it starts again. */
const MAX_REMEMBERED_RUNS = 1000;

/**
 * Whether `viewerId` sees each run an event names (`isVisibleRun`), for a stream that fans run events out: read once
 * per run, a run that is gone reading as seen. A failed read answers not seen and is read again on the next event.
 */
export function runVisibilityReader(db: DrizzleDB, viewerId: number | null): (runId: number) => Promise<boolean> {
  const seen = new Map<number, Promise<boolean>>();
  return (runId) => {
    let known = seen.get(runId);
    if (!known) {
      if (seen.size >= MAX_REMEMBERED_RUNS) seen.clear();
      known = db
        .select({ origin: testRuns.origin, requesterId: testRuns.requesterId })
        .from(testRuns)
        .where(eq(testRuns.id, runId))
        .then(([run]) => !run || isVisibleRun(run, viewerId))
        .catch(() => {
          seen.delete(runId);
          return false;
        });
      seen.set(runId, known);
    }
    return known;
  };
}

export async function resolveCaseProjectId(db: DrizzleDB, caseId: number): Promise<number | null> {
  const rows = await db.select({ projectId: testCases.projectId }).from(testCases).where(eq(testCases.id, caseId));
  return rows[0]?.projectId ?? null;
}

export async function resolveClusterProjectId(db: DrizzleDB, clusterId: number): Promise<number | null> {
  const rows = await db
    .select({ projectId: failureClusters.projectId })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  return rows[0]?.projectId ?? null;
}

/** The project of an execution of a run `viewerId` sees, or null, as `resolveRunProjectId` answers. */
export async function resolveTestRunCaseProjectId(
  db: DrizzleDB,
  runCaseId: number,
  viewerId: number | null,
): Promise<number | null> {
  const rows = await db
    .select({ projectId: testRuns.projectId, origin: testRuns.origin, requesterId: testRuns.requesterId })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.id, runCaseId))
    .limit(1);
  const run = rows[0];
  return run && isVisibleRun(run, viewerId) ? run.projectId : null;
}

export async function resolveMarkerProjectId(db: DrizzleDB, markerId: number): Promise<number | null> {
  const rows = await db.select({ projectId: markers.projectId }).from(markers).where(eq(markers.id, markerId));
  return rows[0]?.projectId ?? null;
}

export async function resolveTestFunctionProjectId(db: DrizzleDB, testFunctionId: number): Promise<number | null> {
  const rows = await db
    .select({ projectId: testFunctions.projectId })
    .from(testFunctions)
    .where(eq(testFunctions.id, testFunctionId));
  return rows[0]?.projectId ?? null;
}

/** Resolve the project owning the entity an entity-link targets (list/create). */
export async function resolveLinkEntityProjectId(
  db: DrizzleDB,
  entityType: string,
  entityId: number,
  viewerId: number | null,
): Promise<number | null> {
  if (entityType === 'test_run') return resolveRunProjectId(db, entityId, viewerId);
  if (entityType === 'test_runs_case') return resolveTestRunCaseProjectId(db, entityId, viewerId);
  if (entityType === 'test_case') return resolveCaseProjectId(db, entityId);
  if (entityType === 'failure_cluster') return resolveClusterProjectId(db, entityId);
  if (entityType === 'bug_report') return resolveBugReportProjectId(db, entityId);
  return null;
}

/** Resolve the project owning an existing entity link, via its target entity. */
export async function resolveLinkProjectId(
  db: DrizzleDB,
  linkId: number,
  viewerId: number | null,
): Promise<number | null> {
  const rows = await db.select().from(entityLinks).where(eq(entityLinks.id, linkId)).limit(1);
  const link = rows[0];
  if (!link) return null;
  if (link.testRunId != null) return resolveRunProjectId(db, link.testRunId, viewerId);
  if (link.testRunsCaseId != null) return resolveTestRunCaseProjectId(db, link.testRunsCaseId, viewerId);
  if (link.testCaseId != null) return resolveCaseProjectId(db, link.testCaseId);
  if (link.failureClusterId != null) return resolveClusterProjectId(db, link.failureClusterId);
  if (link.bugReportId != null) return resolveBugReportProjectId(db, link.bugReportId);
  return null;
}

export async function resolveDiagnosisProjectId(db: DrizzleDB, diagnosisId: number): Promise<number | null> {
  // Cluster-scoped diagnoses resolve via their cluster; execution-scoped rows carry no
  // cluster (null) and resolve via the execution's run instead.
  const rows = await db
    .select({ clusterProjectId: failureClusters.projectId, execProjectId: testRuns.projectId })
    .from(failureDiagnoses)
    .leftJoin(failureClusters, eq(failureDiagnoses.clusterId, failureClusters.id))
    .leftJoin(testRunsCases, eq(failureDiagnoses.testRunsCaseId, testRunsCases.id))
    .leftJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(failureDiagnoses.id, diagnosisId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row.clusterProjectId ?? row.execProjectId ?? null;
}

export async function resolveBugReportProjectId(db: DrizzleDB, bugReportId: number): Promise<number | null> {
  const rows = await db
    .select({ projectId: bugReports.projectId })
    .from(bugReports)
    .where(eq(bugReports.id, bugReportId));
  return rows[0]?.projectId ?? null;
}

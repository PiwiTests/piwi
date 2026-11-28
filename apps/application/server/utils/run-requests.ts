import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { H3Event } from 'h3';
import {
  FINAL_RUN_REQUEST_STATES,
  RUN_REQUEST_ID,
  RUN_REQUEST_LIMITS,
  parseRunRequest,
  readRunRequestFolderHints,
  type RunRequest,
  type RunRequestFolderHints,
  type RunRequestOffer,
  type RunRequestOutcome,
  type RunRequestState,
} from '@piwitests/core/run-request';
import { runRequests, runTargets, testRuns, type RunRequestRow, type RunTarget, type User } from '../database/schema';
import { getDatabase, type DbClient } from '../database';
import { apiError } from './api-error';
import { isReadOnly } from './operator-limits';
import { extractApiKey, getUserAccessCached, isAuthEnabled, resolveApiKey } from './auth';
import { RUN_TARGET_PERMISSIONS, type RunTargetPermission } from './extension-connect';
import { readProjectRepositoryUrl } from './scm/project-repository';
import { newRequestToken, REQUEST_TOKEN_LIFETIME_MS } from './request-tokens';
import { isOptInCapabilityOn } from '#shared/handlers/capabilities';
import { can, type AccessSummary } from '#shared/permissions';
import { LOCAL_RUN_ORIGINS, PRIVATE_RUN_ORIGINS, runOriginIn } from '#shared/run-eligibility';
import { ACTIVE_STATES, projectNamesOf, RUN_STATES } from '#shared/handlers/run-requests';
import { readProjectRunVariables } from '#shared/handlers/run-variables';
import { environmentRunSettings, listProjectEnvironments } from '#shared/handlers/environments';
import type { EnvironmentRecord } from '#shared/environments';
import type { EnvironmentForRun } from '@piwitests/core/environments';
import type { RunVariable } from '#shared/run-variables';
import { RUN_TARGET_FEATURES, type RunTargetFeature } from '@piwitests/core/run-request';

export {
  countWaitingRequests,
  effectiveState,
  findOwnRequest,
  MAX_WAITING_REQUESTS,
  resolveRequestTests,
  runRequestView,
  stopOwnRequest,
  type RunRequestSourceInput,
} from '#shared/handlers/run-requests';

/**
 * Run requests on the instance's side: a page asks for a run of tests the instance resolves, on one of the
 * requester's own targets (`@piwitests/core/run-request`). A target claims a request once, shows it, and answers;
 * each move between states is one conditional update, so two targets, or a reconnect, never both win one.
 */

/** A new request id: 32 hex digits, which is also the run's ref. */
export function newRunRequestId(): string {
  return randomBytes(16).toString('hex');
}

/** The request id of a route, or a 404: anything else names no request. */
export function requireRunRequestId(event: H3Event): string {
  const id = getRouterParam(event, 'id') ?? '';
  if (!RUN_REQUEST_ID.test(id)) throw apiError({ statusCode: 404, message: 'No run request has this id' });
  return id;
}

/** A request belongs to the person who made it, so the routes need sign-in turned on. */
export function requireSignInForRunRequests(event: H3Event): void {
  if (!isAuthEnabled(event)) {
    throw apiError({
      statusCode: 403,
      message: 'Run on my machine needs sign-in turned on: a request belongs to the person who made it',
    });
  }
}

/** 403 unless an administrator turned **Run on my machine** on and the project did not decline it. */
export async function requireMachineRunsOn(db: DbClient, projectId: number): Promise<void> {
  if (!(await isOptInCapabilityOn(db, projectId, 'machine-runs'))) {
    throw apiError({ statusCode: 403, message: 'Run on my machine is off for this project' });
  }
}

/** A target route's caller: the target, its owner and the owner's access. */
export interface RunTargetCaller {
  db: DbClient;
  user: User;
  target: RunTarget;
  /** The permissions the key holds: some of `RUN_TARGET_PERMISSIONS`. */
  permissions: RunTargetPermission[];
  /**
   * The owner's access, loaded on every request: a target takes requests only on projects where they hold
   * `run:receive`, and compares only on projects they read.
   */
  access: AccessSummary;
}

/**
 * Authenticate a target route: a target key (an API key that holds some of `RUN_TARGET_PERMISSIONS` and nothing else,
 * made by the device flow for the desktop app or Piwi Runner) whose target is still connected, and that holds the
 * route's `permission`: `run:receive` for the run requests, `project:read` for the comparison with the team's CI. Any
 * other credential, a session or a key with its owner's access, is refused: these routes serve connected apps only.
 * Records that the target was seen, unless `seen` is false (a check the instance makes on its own, such as an open
 * stream's, is no sign the app is there) or the instance is read-only.
 */
export async function requireRunTarget(
  event: H3Event,
  { seen = true, permission = 'run:receive' }: { seen?: boolean; permission?: RunTargetPermission } = {},
): Promise<RunTargetCaller> {
  requireSignInForRunRequests(event);
  const value = extractApiKey(event);
  if (!value) throw apiError({ statusCode: 401, message: 'A connected app’s key is required' });
  const resolved = await resolveApiKey(value);
  if (!resolved) {
    throw apiError({ statusCode: 401, message: 'Invalid or expired API key', errorCode: 'RUN_TARGET_KEY_REVOKED' });
  }
  const holds = resolved.permissions ?? [];
  if (holds.length === 0 || !holds.every((p) => (RUN_TARGET_PERMISSIONS as readonly string[]).includes(p))) {
    throw apiError({ statusCode: 403, message: 'Only a connected app that runs tests may call this route' });
  }
  const db = await getDatabase();
  const [target] = await db.select().from(runTargets).where(eq(runTargets.apiKeyId, resolved.keyId));
  if (!target || target.userId !== resolved.user.id) {
    throw apiError({ statusCode: 403, message: 'This app is no longer connected' });
  }
  if (!holds.includes(permission)) {
    throw permission === 'project:read'
      ? apiError({
          statusCode: 403,
          message: 'This app’s key cannot compare with the team instance: connect the app again',
          errorCode: 'RUN_TARGET_KEY_CANNOT_COMPARE',
        })
      : apiError({ statusCode: 403, message: 'This app’s key does not take run requests' });
  }
  event.context.apiKeyId = resolved.keyId;
  const access = await getUserAccessCached(db, resolved.user);
  event.context.access = access;
  const permissions = holds as RunTargetPermission[];
  if (!seen || isReadOnly()) return { db, user: resolved.user, target, access, permissions };
  const now = new Date();
  await db.update(runTargets).set({ lastSeenAt: now }).where(eq(runTargets.id, target.id));
  return { db, user: resolved.user, target: { ...target, lastSeenAt: now }, access, permissions };
}

/** End a waiting request whose stored values no longer pass the parser, so its page says so rather than expired. */
async function endUnreadableRequest(db: DbClient, id: string, now: Date): Promise<void> {
  await db
    .update(runRequests)
    .set({
      state: 'ended',
      outcome: 'error',
      detail: 'This request no longer passes the checks of this version of Piwi: ask for the run again',
      updatedAt: now,
    })
    .where(and(eq(runRequests.id, id), eq(runRequests.state, 'waiting')));
}

/** The request a target receives, rebuilt and checked by the one parser. Null when a stored value no longer passes. */
export function runRequestOf(row: RunRequestRow): RunRequest | null {
  const parsed = parseRunRequest({
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    tests: row.tests,
    options: row.options,
    source: row.source,
  });
  return parsed.ok ? parsed.value : null;
}

/** The request as a target is offered it, with the time it stops waiting. Null when a stored value no longer passes. */
export function runRequestOfferOf(row: RunRequestRow): RunRequestOffer | null {
  const request = runRequestOf(row);
  return request && { ...request, expiresAt: row.expiresAt.toISOString() };
}

/** How long a target keeps hearing of a request that ended at a stop, so one that polls late still ends its run. */
const STOPPED_NOTICE_MS = 10 * 60 * 1000;

/** How long a claimed request waits for the person's answer in the app before it ends. */
const ANSWER_WINDOW_MS = 10 * 60 * 1000;

/** The states a run moves through once the person clicked **Run**, and where each may go next. */
const STATE_MOVES: Record<'running' | 'stopping' | 'ended', RunRequestState[]> = {
  running: ['starting'],
  stopping: ['starting', 'running'],
  ended: ['starting', 'running', 'stopping'],
};

export type RunStateUpdate = { state: 'running' | 'stopping' } | { state: 'ended'; outcome: RunRequestOutcome };

/**
 * End, as an error, the requests nobody can act on any more: one held (claimed, or its run) by a target the instance
 * has not heard from for `silentTargetMs` or that was disconnected, one claimed but not answered within 10
 * minutes, and one whose request token expired before it started a run. One request when `id` is given, else every
 * one.
 */
export async function endStaleRequests(db: DbClient, now = new Date(), id?: string): Promise<number> {
  const one = id === undefined ? undefined : eq(runRequests.id, id);
  const unanswered = await db
    .update(runRequests)
    .set({ state: 'ended', outcome: 'error', detail: 'Nobody answered this request in the app', updatedAt: now })
    .where(
      and(one, eq(runRequests.state, 'claimed'), lt(runRequests.claimedAt, new Date(now.getTime() - ANSWER_WINDOW_MS))),
    )
    .returning({ id: runRequests.id });
  const silentSince = new Date(now.getTime() - RUN_REQUEST_LIMITS.silentTargetMs);
  const silent = db
    .select({ id: runTargets.id })
    .from(runTargets)
    .where(
      or(
        lt(runTargets.lastSeenAt, silentSince),
        and(isNull(runTargets.lastSeenAt), lt(runTargets.createdAt, silentSince)),
      ),
    );
  const ended = await db
    .update(runRequests)
    .set({
      state: 'ended',
      outcome: 'error',
      detail: 'The app that held this request stopped answering',
      updatedAt: now,
    })
    .where(
      and(
        one,
        inArray(runRequests.state, ACTIVE_STATES),
        or(isNull(runRequests.targetId), inArray(runRequests.targetId, silent)),
      ),
    )
    .returning({ id: runRequests.id });
  // A request whose token expired unspent ends as an error.
  const unstarted = await db
    .update(runRequests)
    .set({ state: 'ended', outcome: 'error', detail: 'The app did not start the run in time', updatedAt: now })
    .where(
      and(
        one,
        inArray(runRequests.state, ['starting', 'running']),
        isNull(runRequests.runId),
        isNotNull(runRequests.requestTokenDigest),
        lt(runRequests.requestTokenExpiresAt, now),
      ),
    )
    .returning({ id: runRequests.id });
  return unanswered.length + ended.length + unstarted.length;
}

/**
 * Delete the requests that ended, or expired unclaimed, more than `olderThanDays` days ago. A request only records
 * what was asked: the run it started, if any, is a run of its own.
 */
export async function pruneRunRequests(db: DbClient, olderThanDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const old = or(
    and(eq(runRequests.state, 'waiting'), lt(runRequests.expiresAt, cutoff)),
    and(inArray(runRequests.state, [...FINAL_RUN_REQUEST_STATES]), lt(runRequests.updatedAt, cutoff)),
  );
  const deleted = await db.delete(runRequests).where(old).returning({ id: runRequests.id });
  return deleted.length;
}

const NOT_ALLOWED = 'Run on my machine is off for this project, or you cannot run its tests';

/**
 * The words a waiting request keeps when an app that does not apply run variables was asked to run one of a project
 * that sets some: the request goes on waiting for an app that does, and says why when none takes it.
 */
const NO_RUN_VARIABLES =
  'An app that cannot apply this project’s run variables was asked to run it: update Piwi Desktop or Piwi Runner.';

/**
 * The words a waiting request keeps when an app that does not apply environments was asked to run one that names an
 * environment: the request goes on waiting for an app that does, and says why when none takes it.
 */
const NO_ENVIRONMENTS =
  'An app that cannot apply environments was asked to run this request for one: update Piwi Desktop or Piwi Runner.';

/** The features a target declared with its claim (`claimRequest`), those this instance knows. */
export function claimedFeatures(declared: unknown): RunTargetFeature[] {
  const listed = Array.isArray(declared) ? (declared as unknown[]) : [];
  return RUN_TARGET_FEATURES.filter((feature) => listed.includes(feature));
}

/**
 * Whether an app that declared `features` cannot take a request of a project: it does not apply run variables and the
 * project sets some, so its run would miss them (the tenant it tests, the project it reports to).
 */
async function lacksRunVariables(db: DbClient, features: readonly string[], projectId: number): Promise<boolean> {
  if (features.includes('run-variables')) return false;
  return ((await readProjectRunVariables(db as never, projectId)) ?? []).length > 0;
}

/**
 * The words why an app that declared `features` cannot take a request, or null when it can: it lacks run variables the
 * project sets, or environments when the request names one.
 */
async function missingFeature(
  db: DbClient,
  features: readonly string[],
  request: { projectId: number; environmentId: number | null },
): Promise<string | null> {
  if (request.environmentId !== null && !features.includes('environments')) return NO_ENVIRONMENTS;
  return (await lacksRunVariables(db, features, request.projectId)) ? NO_RUN_VARIABLES : null;
}

/** Whether a target may take a request of a project: its owner holds `run:receive` there and the capability is on. */
export async function mayReceiveOn(db: DbClient, access: AccessSummary, projectId: number): Promise<boolean> {
  return can(access, 'run:receive', projectId) && (await isOptInCapabilityOn(db, projectId, 'machine-runs'));
}

/**
 * The requests a target should act on: those still waiting for one of its owner's targets, and its own stops: a run
 * to end, or a request that ended at a stop within the last 10 minutes (a claim to stop showing, or a run the second
 * stop ended). `held` names the requests the instance counts as the target's, claimed or with their run, so a target
 * that started again ends those it no longer holds. `projects` names the projects of those requests and the ones the
 * target has a folder for, where its owner holds `run:receive`. A waiting request whose stored values no longer pass
 * the parser is left out, and ended unless the instance is read-only.
 */
export async function requestsForTarget(
  { db, target, access }: RunTargetCaller,
  now = new Date(),
): Promise<{
  requests: RunRequestOffer[];
  stops: string[];
  held: { id: string; state: RunRequestState }[];
  projects: TargetProjectName[];
}> {
  const waiting = await db
    .select()
    .from(runRequests)
    .where(
      and(
        eq(runRequests.requesterId, target.userId),
        eq(runRequests.state, 'waiting'),
        gt(runRequests.expiresAt, now),
        or(isNull(runRequests.targetId), eq(runRequests.targetId, target.id)),
      ),
    );
  const on = new Map<number, boolean>();
  const requests: RunRequestOffer[] = [];
  for (const row of waiting) {
    if (!on.has(row.projectId)) on.set(row.projectId, await mayReceiveOn(db, access, row.projectId));
    if (!on.get(row.projectId)) continue;
    const request = runRequestOfferOf(row);
    if (request) requests.push(request);
    else if (!isReadOnly()) await endUnreadableRequest(db, row.id, now);
  }
  const stops = await db
    .select({ id: runRequests.id })
    .from(runRequests)
    .where(
      and(
        eq(runRequests.targetId, target.id),
        isNotNull(runRequests.stopRequestedAt),
        or(
          inArray(runRequests.state, RUN_STATES),
          and(
            eq(runRequests.state, 'ended'),
            gt(runRequests.stopRequestedAt, new Date(now.getTime() - STOPPED_NOTICE_MS)),
          ),
        ),
      ),
    );
  const holding = await db
    .select({ id: runRequests.id, state: runRequests.state })
    .from(runRequests)
    .where(and(eq(runRequests.targetId, target.id), inArray(runRequests.state, ACTIVE_STATES)));
  const held = holding.map((row) => ({ id: row.id, state: row.state as RunRequestState }));
  const named = [...new Set([...requests.map((r) => r.projectId), ...storedProjectIds(target)])].filter(
    (id) => on.get(id) ?? can(access, 'run:receive', id),
  );
  return { requests, stops: stops.map((s) => s.id), held, projects: await targetProjectNames(db, named) };
}

/** The project ids a target said it has a folder for, as stored. */
export function storedProjectIds(target: RunTarget): number[] {
  return Array.isArray(target.projectIds)
    ? target.projectIds.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id))
    : [];
}

/** A project's id and its label, else its name, as a target shows it. */
export interface TargetProjectName {
  id: number;
  name: string;
}

/** The names of the projects a target may take requests for, by id; a project that is gone is left out. */
export async function targetProjectNames(db: DbClient, ids: number[]): Promise<TargetProjectName[]> {
  const names = await projectNamesOf(db, ids);
  return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id);
}

export type TargetMoveResult =
  | { ok: true; row: RunRequestRow; requestToken?: string }
  | { ok: false; statusCode: 403 | 404 | 409; message: string };

async function moveOrExplain(
  db: DbClient,
  target: RunTarget,
  id: string,
  moved: RunRequestRow[],
  conflict: string,
): Promise<TargetMoveResult> {
  if (moved[0]) return { ok: true, row: moved[0] };
  const [row] = await db
    .select({ id: runRequests.id })
    .from(runRequests)
    .where(and(eq(runRequests.id, id), eq(runRequests.requesterId, target.userId)));
  return row
    ? { ok: false, statusCode: 409, message: conflict }
    : { ok: false, statusCode: 404, message: 'No run request has this id' };
}

/**
 * Claim a waiting request for this target, in one conditional update: a second claim, from a reconnect or a second
 * process, finds it claimed and answers 409. An expired request cannot be claimed. `features` are what the target
 * declares with this claim (`RUN_TARGET_FEATURES`), kept on the request: a target that does not apply run variables
 * cannot claim one of a project that sets some, which goes on waiting for an app that does and keeps the words why.
 */
export async function claimRequest(
  { db, target, access }: RunTargetCaller,
  id: string,
  features: readonly string[] = [],
  now = new Date(),
): Promise<TargetMoveResult> {
  const [row] = await db
    .select({
      projectId: runRequests.projectId,
      environmentId: runRequests.environmentId,
      state: runRequests.state,
      expiresAt: runRequests.expiresAt,
    })
    .from(runRequests)
    .where(and(eq(runRequests.id, id), eq(runRequests.requesterId, target.userId)));
  if (!row) return { ok: false, statusCode: 404, message: 'No run request has this id' };
  if (!(await mayReceiveOn(db, access, row.projectId))) {
    return { ok: false, statusCode: 403, message: NOT_ALLOWED };
  }
  const declared = claimedFeatures(features);
  // A request already taken or past its time answers the claim's own 409, below.
  const claimable = row.state === 'waiting' && !!row.expiresAt && row.expiresAt > now;
  const missing = claimable ? await missingFeature(db, declared, row) : null;
  if (missing) {
    await db
      .update(runRequests)
      .set({ detail: missing, updatedAt: now })
      .where(and(eq(runRequests.id, id), eq(runRequests.state, 'waiting'), gt(runRequests.expiresAt, now)));
    return { ok: false, statusCode: 409, message: missing };
  }
  const moved = await db
    .update(runRequests)
    .set({ state: 'claimed', targetId: target.id, claimFeatures: declared, claimedAt: now, updatedAt: now })
    .where(
      and(
        eq(runRequests.id, id),
        eq(runRequests.requesterId, target.userId),
        eq(runRequests.state, 'waiting'),
        gt(runRequests.expiresAt, now),
        or(isNull(runRequests.targetId), eq(runRequests.targetId, target.id)),
      ),
    )
    .returning();
  return moveOrExplain(db, target, id, moved, 'This request was already claimed, or has expired');
}

/**
 * The run variables of a request, for the target that claimed it, as it plans and launches the run: the project's, and
 * with an environment the environment's over them, with the environment the target reads (`environmentRunSettings`).
 * 404 when the request is not this target's, 403 when the project no longer lets its owner receive it or the
 * environment became protected and its owner does not manage the project, 409 when the list the rules refuse.
 */
export async function runVariablesForTarget(
  { db, target, access }: RunTargetCaller,
  id: string,
): Promise<
  | { ok: true; runVariables: RunVariable[]; environment: EnvironmentForRun | null }
  | { ok: false; statusCode: 403 | 404 | 409; message: string }
> {
  const [row] = await db
    .select({ projectId: runRequests.projectId, environmentId: runRequests.environmentId })
    .from(runRequests)
    .where(
      and(eq(runRequests.id, id), eq(runRequests.requesterId, target.userId), eq(runRequests.targetId, target.id)),
    );
  if (!row) return { ok: false, statusCode: 404, message: 'No run request this app claimed has this id' };
  if (!(await mayReceiveOn(db, access, row.projectId))) return { ok: false, statusCode: 403, message: NOT_ALLOWED };
  const settings = await environmentRunSettings(db as never, row.projectId, row.environmentId ?? null, {
    canManage: can(access, 'project:manage', row.projectId),
  });
  if (!settings.ok) return settings;
  return { ok: true, runVariables: settings.runVariables, environment: settings.environment };
}

/**
 * A project's environments, for a connected app of someone who may receive its runs: what the desktop app offers for
 * a folder also linked to the project (its own local runs, read from the team instance). 403 when the owner may not.
 */
export async function environmentsForTarget(
  { db, access }: RunTargetCaller,
  projectId: number,
): Promise<{ ok: true; environments: EnvironmentRecord[] } | { ok: false; statusCode: 403; message: string }> {
  if (!(await mayReceiveOn(db, access, projectId))) return { ok: false, statusCode: 403, message: NOT_ALLOWED };
  const canManage = can(access, 'project:manage', projectId);
  return {
    ok: true,
    environments: await listProjectEnvironments(db as never, projectId, { canManage, includeArchived: false }),
  };
}

/**
 * The run variables and environment a run of a project gets, for a connected app of someone who may receive its runs,
 * as `GET /api/projects/:id/run-variables?environment=` answers them.
 */
export async function runSettingsForTarget(
  { db, access }: RunTargetCaller,
  projectId: number,
  environmentId: number | null,
): Promise<
  | { ok: true; runVariables: RunVariable[]; environment: EnvironmentForRun | null }
  | { ok: false; statusCode: 403 | 404 | 409; message: string }
> {
  if (!(await mayReceiveOn(db, access, projectId))) return { ok: false, statusCode: 403, message: NOT_ALLOWED };
  return environmentRunSettings(db as never, projectId, environmentId, {
    canManage: can(access, 'project:manage', projectId),
  });
}

/** How many of the requester's latest runs of a project the folder hints read, and over how long. */
const HINT_RUNS = 20;
const HINT_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * What a target is told to find the folder of a request it claimed with (`RunRequestFolderHints`): the project's
 * repository, and the folders the requester's own runs of the project came from in the last 180 days, newest first:
 * those they started on a machine of theirs (`LOCAL_RUN_ORIGINS`, reported with their credentials) and those they
 * requested, never a CI or a lab run. Only the target that claimed the request is answered, while its owner may still
 * run tests on the project.
 */
export async function folderHintsForTarget(
  { db, target, access }: RunTargetCaller,
  id: string,
): Promise<{ ok: true; hints: RunRequestFolderHints } | { ok: false; statusCode: number; message: string }> {
  const [row] = await db
    .select({ projectId: runRequests.projectId })
    .from(runRequests)
    .where(
      and(eq(runRequests.id, id), eq(runRequests.requesterId, target.userId), eq(runRequests.targetId, target.id)),
    );
  if (!row) return { ok: false, statusCode: 404, message: 'No run request of this app has this id' };
  if (!(await mayReceiveOn(db, access, row.projectId))) {
    return { ok: false, statusCode: 403, message: NOT_ALLOWED };
  }
  const runs = await db
    .select({ metadata: testRuns.metadata })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, row.projectId),
        gt(testRuns.startTime, new Date(Date.now() - HINT_WINDOW_MS)),
        or(
          and(eq(testRuns.reporterId, target.userId), runOriginIn(testRuns.origin, LOCAL_RUN_ORIGINS)),
          and(eq(testRuns.requesterId, target.userId), runOriginIn(testRuns.origin, PRIVATE_RUN_ORIGINS)),
        ),
      ),
    )
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(HINT_RUNS);
  const folders = runs.map((run) => (run.metadata as { workingDir?: unknown } | null)?.workingDir);
  const repositoryUrl = await readProjectRepositoryUrl(db, row.projectId);
  return { ok: true, hints: readRunRequestFolderHints({ repositoryUrl, folders }) };
}

export type TargetAnswer = { decision: 'run' } | { decision: 'not-now' } | { decision: 'refused'; detail: string };

/**
 * The person's answer in the target, to a request this target claimed: **Run** moves it to `starting` and answers a
 * request token (`server/utils/request-tokens.ts`), kept as its digest, **Not now** moves it to `declined`, a failed check to
 * `refused` with its words. **Run** is refused once the requester stopped it, and checks again that the project
 * allows it, as the claim did.
 */
export async function answerRequest(
  { db, target, access }: RunTargetCaller,
  id: string,
  answer: TargetAnswer,
  now = new Date(),
): Promise<TargetMoveResult> {
  if (answer.decision === 'run') {
    const [row] = await db
      .select({
        projectId: runRequests.projectId,
        environmentId: runRequests.environmentId,
        claimFeatures: runRequests.claimFeatures,
      })
      .from(runRequests)
      .where(and(eq(runRequests.id, id), eq(runRequests.targetId, target.id)));
    if (row && !(await mayReceiveOn(db, access, row.projectId))) {
      return { ok: false, statusCode: 403, message: NOT_ALLOWED };
    }
    const missing = row ? await missingFeature(db, claimedFeatures(row.claimFeatures), row) : null;
    if (missing) {
      await db
        .update(runRequests)
        .set({ state: 'refused', detail: missing, answeredAt: now, updatedAt: now })
        .where(and(eq(runRequests.id, id), eq(runRequests.targetId, target.id), eq(runRequests.state, 'claimed')));
      return { ok: false, statusCode: 409, message: missing };
    }
  }
  const base = [eq(runRequests.id, id), eq(runRequests.targetId, target.id), eq(runRequests.state, 'claimed')];
  const minted = answer.decision === 'run' ? newRequestToken() : null;
  const values = minted
    ? {
        state: 'starting',
        requestTokenDigest: minted.digest,
        requestTokenExpiresAt: new Date(now.getTime() + REQUEST_TOKEN_LIFETIME_MS),
      }
    : answer.decision === 'not-now'
      ? { state: 'declined' }
      : { state: 'refused', detail: answer.decision === 'refused' ? answer.detail : null };
  if (answer.decision === 'run') base.push(isNull(runRequests.stopRequestedAt));
  const moved = await db
    .update(runRequests)
    .set({ ...values, answeredAt: now, updatedAt: now })
    .where(and(...base))
    .returning();
  const result = await moveOrExplain(
    db,
    target,
    id,
    moved,
    'This request is not waiting for an answer, or was stopped',
  );
  return result.ok && minted ? { ...result, requestToken: minted.token } : result;
}

/** A run's next state, reported by the target that runs it: only forward, and an end once. */
export async function moveRequestState(
  { db, target }: RunTargetCaller,
  id: string,
  update: RunStateUpdate,
  detail: string | null,
  now = new Date(),
): Promise<TargetMoveResult> {
  const moved = await db
    .update(runRequests)
    .set({
      state: update.state,
      outcome: update.state === 'ended' ? update.outcome : null,
      ...(detail ? { detail } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(runRequests.id, id),
        eq(runRequests.targetId, target.id),
        inArray(runRequests.state, STATE_MOVES[update.state]),
      ),
    )
    .returning();
  return moveOrExplain(db, target, id, moved, `This request cannot move to ${update.state} from its current state`);
}

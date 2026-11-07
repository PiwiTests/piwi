import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { H3Event } from 'h3';
import {
  RUN_REQUEST_ID,
  RUN_REQUEST_LIMITS,
  parseRunRequest,
  type RunRequest,
  type RunRequestOptions,
  type RunRequestOutcome,
  type RunRequestSource,
  type RunRequestState,
  type RunRequestTest,
} from '@piwitests/core/run-request';
import {
  runRequests,
  runTargets,
  testCases,
  testRuns,
  testRunsCases,
  type RunRequestRow,
  type RunTarget,
  type User,
} from '../database/schema';
import { getDatabase, type DbClient } from '../database';
import { apiError } from './api-error';
import { extractApiKey, getUserAccessCached, isAuthEnabled, resolveApiKey } from './auth';
import { RUN_TARGET_KEY_PERMISSIONS } from './extension-connect';
import { isOptInCapabilityOn } from '#shared/handlers/capabilities';
import { can, type AccessSummary } from '#shared/permissions';
import { FAILED_STATUS_KEYS } from '#shared/utils/test-counts';

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
  /** The owner's access, loaded on every request: a target acts only on projects where they hold `run:receive`. */
  access: AccessSummary;
}

/**
 * Authenticate a target route: a target key (an API key that holds `run:receive` alone, made by the device flow for
 * the desktop app or Piwi Runner) whose target is still connected. Any other credential, a session or a key with its
 * owner's access, is refused: these routes serve connected apps only. Records that the target was seen.
 */
export async function requireRunTarget(event: H3Event): Promise<RunTargetCaller> {
  requireSignInForRunRequests(event);
  const value = extractApiKey(event);
  if (!value) throw apiError({ statusCode: 401, message: 'A connected app’s key is required' });
  const resolved = await resolveApiKey(value);
  if (!resolved) throw apiError({ statusCode: 401, message: 'Invalid or expired API key' });
  const holds = resolved.permissions ?? [];
  if (
    holds.length !== RUN_TARGET_KEY_PERMISSIONS.length ||
    !RUN_TARGET_KEY_PERMISSIONS.every((p) => holds.includes(p))
  ) {
    throw apiError({ statusCode: 403, message: 'Only a connected app that runs tests may call this route' });
  }
  const db = await getDatabase();
  const [target] = await db.select().from(runTargets).where(eq(runTargets.apiKeyId, resolved.keyId));
  if (!target || target.userId !== resolved.user.id) {
    throw apiError({ statusCode: 403, message: 'This app is no longer connected' });
  }
  event.context.apiKeyId = resolved.keyId;
  const access = await getUserAccessCached(db, resolved.user);
  event.context.access = access;
  const now = new Date();
  await db.update(runTargets).set({ lastSeenAt: now }).where(eq(runTargets.id, target.id));
  return { db, user: resolved.user, target: { ...target, lastSeenAt: now }, access };
}

/** What a request names its tests from, before the instance resolves them. */
export type RunRequestSourceInput =
  | { executionId: number }
  | { runId: number; tests: 'failed' | 'all' }
  | { runId: number; filePath: string };

export type ResolvedRequestTests =
  | { ok: true; projectId: number; tests: RunRequestTest[]; source: RunRequestSource; projects: string[] }
  | { ok: false; statusCode: 404 | 422; message: string };

/**
 * The tests a request runs, read from the stored executions, never from the browser: an execution, the failed or
 * all tests of a run (final attempts only, one per test and Playwright project), or the tests of one spec file of a
 * run. Also answers what the request came from (the run, its branch and commit) and the Playwright projects the
 * tests ran in, which bound the request's `project` option.
 */
export async function resolveRequestTests(db: DbClient, input: RunRequestSourceInput): Promise<ResolvedRequestTests> {
  let runId: number;
  let executionId: number | undefined;
  const conditions = [eq(testRunsCases.finalAttempt, true)];
  if ('executionId' in input) {
    const [row] = await db
      .select({ runId: testRunsCases.testRunId })
      .from(testRunsCases)
      .where(eq(testRunsCases.id, input.executionId));
    if (!row) return { ok: false, statusCode: 404, message: 'Execution not found' };
    runId = row.runId;
    executionId = input.executionId;
    conditions.length = 0;
    conditions.push(eq(testRunsCases.id, input.executionId));
  } else {
    runId = input.runId;
    conditions.push(eq(testRunsCases.testRunId, runId));
    if ('filePath' in input) conditions.push(eq(testCases.filePath, input.filePath));
    else if (input.tests === 'failed') conditions.push(inArray(testRunsCases.status, [...FAILED_STATUS_KEYS]));
  }

  const [run] = await db
    .select({ projectId: testRuns.projectId, branch: testRuns.branch, commit: testRuns.commit })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return { ok: false, statusCode: 404, message: 'Test run not found' };

  const rows = await db
    .select({
      filePath: testCases.filePath,
      title: testCases.title,
      suitePath: testCases.suitePath,
      line: testRunsCases.line,
      projectName: testRunsCases.browserName,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(and(...conditions));

  const seen = new Set<string>();
  const tests: RunRequestTest[] = [];
  const projects = new Set<string>();
  for (const row of rows) {
    const projectName = row.projectName || null;
    const key = JSON.stringify([row.filePath, row.suitePath, row.title, row.line, projectName]);
    if (seen.has(key)) continue;
    seen.add(key);
    tests.push({ filePath: row.filePath, title: row.title, line: row.line ?? null, projectName });
    if (projectName) projects.add(projectName);
  }
  if (tests.length === 0) return { ok: false, statusCode: 422, message: 'These tests are not in the run' };
  if (tests.length > RUN_REQUEST_LIMITS.tests.max) {
    return {
      ok: false,
      statusCode: 422,
      message: `A request runs at most ${RUN_REQUEST_LIMITS.tests.max} tests; these are ${tests.length}`,
    };
  }

  const source: RunRequestSource = { runId };
  if (executionId !== undefined) source.executionId = executionId;
  if (run.branch) source.branch = run.branch;
  if (run.commit) source.commit = run.commit;
  return { ok: true, projectId: run.projectId, tests, source, projects: [...projects].sort() };
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

/** A request's state as of `now`: an unclaimed request past its expiry reads expired, whatever its stored state. */
export function effectiveState(row: Pick<RunRequestRow, 'state' | 'expiresAt'>, now = new Date()): RunRequestState {
  const state = row.state as RunRequestState;
  return state === 'waiting' && row.expiresAt.getTime() <= now.getTime() ? 'expired' : state;
}

/** What the requester's page reads of a request. */
export interface RunRequestView {
  id: string;
  kind: string;
  projectId: number;
  tests: RunRequestTest[];
  options: RunRequestOptions;
  source: RunRequestSource;
  state: RunRequestState;
  outcome: RunRequestOutcome | null;
  /** The words of a failed check, or of an error. */
  detail: string | null;
  stopRequested: boolean;
  target: { id: number; kind: string; deviceName: string } | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export async function runRequestView(db: DbClient, row: RunRequestRow, now = new Date()): Promise<RunRequestView> {
  let target: RunRequestView['target'] = null;
  if (row.targetId != null) {
    const [t] = await db
      .select({ id: runTargets.id, kind: runTargets.kind, deviceName: runTargets.deviceName })
      .from(runTargets)
      .where(eq(runTargets.id, row.targetId));
    target = t ?? null;
  }
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    tests: row.tests as RunRequestTest[],
    options: row.options as RunRequestOptions,
    source: row.source as RunRequestSource,
    state: effectiveState(row, now),
    outcome: (row.outcome as RunRequestOutcome | null) ?? null,
    detail: row.detail ?? null,
    stopRequested: row.stopRequestedAt != null,
    target,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A requester's own request, or null: another person's request is answered as missing. */
export async function findOwnRequest(db: DbClient, id: string, requesterId: number): Promise<RunRequestRow | null> {
  const [row] = await db
    .select()
    .from(runRequests)
    .where(and(eq(runRequests.id, id), eq(runRequests.requesterId, requesterId)));
  return row ?? null;
}

/** The states of a request a target holds: claimed, or its run once the person clicked **Run**. */
const ACTIVE_STATES: RunRequestState[] = ['claimed', 'starting', 'running', 'stopping'];
const RUN_STATES: RunRequestState[] = ['starting', 'running', 'stopping'];

/** How long a target keeps hearing of a claimed request the requester stopped before the person answered it. */
const STOPPED_CLAIM_NOTICE_MS = 10 * 60 * 1000;

/** The states a run moves through once the person clicked **Run**, and where each may go next. */
const STATE_MOVES: Record<'running' | 'stopping' | 'ended', RunRequestState[]> = {
  running: ['starting'],
  stopping: ['starting', 'running'],
  ended: ['starting', 'running', 'stopping'],
};

export type RunStateUpdate = { state: 'running' | 'stopping' } | { state: 'ended'; outcome: RunRequestOutcome };

/**
 * Stop a request from the requester's page. Waiting, claimed but not answered, or held by a target that was
 * disconnected since, it ends at once as stopped, and the target that claimed it finds it in its stops. Once the
 * person clicked **Run**, the stop is recorded for the target, which ends the run and reports it. Answers false once
 * the request has ended.
 */
export async function stopOwnRequest(
  db: DbClient,
  id: string,
  requesterId: number,
  now = new Date(),
): Promise<boolean> {
  const mine = and(eq(runRequests.id, id), eq(runRequests.requesterId, requesterId));
  const ended = await db
    .update(runRequests)
    .set({ state: 'ended', outcome: 'stopped', stopRequestedAt: now, updatedAt: now })
    .where(
      and(
        mine,
        or(
          and(eq(runRequests.state, 'waiting'), gt(runRequests.expiresAt, now)),
          eq(runRequests.state, 'claimed'),
          and(isNull(runRequests.targetId), inArray(runRequests.state, ACTIVE_STATES)),
        ),
      ),
    )
    .returning({ id: runRequests.id });
  if (ended.length) return true;
  const stopping = await db
    .update(runRequests)
    .set({ stopRequestedAt: now, updatedAt: now })
    .where(and(mine, inArray(runRequests.state, RUN_STATES)))
    .returning({ id: runRequests.id });
  return stopping.length > 0;
}

const NOT_ALLOWED = 'Run on my machine is off for this project, or you cannot run its tests';

/** Whether a target may take a request of a project: its owner holds `run:receive` there and the capability is on. */
async function mayReceiveOn(db: DbClient, access: AccessSummary, projectId: number): Promise<boolean> {
  return can(access, 'run:receive', projectId) && (await isOptInCapabilityOn(db, projectId, 'machine-runs'));
}

/**
 * The requests a target should act on: those still waiting for one of its owner's targets, and its own stops (a run
 * to end, or a claimed request to stop showing).
 */
export async function requestsForTarget(
  { db, target, access }: RunTargetCaller,
  now = new Date(),
): Promise<{ requests: RunRequest[]; stops: string[] }> {
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
  const requests: RunRequest[] = [];
  for (const row of waiting) {
    if (!on.has(row.projectId)) on.set(row.projectId, await mayReceiveOn(db, access, row.projectId));
    if (!on.get(row.projectId)) continue;
    const request = runRequestOf(row);
    if (request) requests.push(request);
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
            isNull(runRequests.answeredAt),
            gt(runRequests.stopRequestedAt, new Date(now.getTime() - STOPPED_CLAIM_NOTICE_MS)),
          ),
        ),
      ),
    );
  return { requests, stops: stops.map((s) => s.id) };
}

export type TargetMoveResult =
  | { ok: true; row: RunRequestRow }
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
 * process, finds it claimed and answers 409. An expired request cannot be claimed.
 */
export async function claimRequest(
  { db, target, access }: RunTargetCaller,
  id: string,
  now = new Date(),
): Promise<TargetMoveResult> {
  const [row] = await db
    .select({ projectId: runRequests.projectId })
    .from(runRequests)
    .where(and(eq(runRequests.id, id), eq(runRequests.requesterId, target.userId)));
  if (!row) return { ok: false, statusCode: 404, message: 'No run request has this id' };
  if (!(await mayReceiveOn(db, access, row.projectId))) {
    return { ok: false, statusCode: 403, message: NOT_ALLOWED };
  }
  const moved = await db
    .update(runRequests)
    .set({ state: 'claimed', targetId: target.id, claimedAt: now, updatedAt: now })
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

export type TargetAnswer = { decision: 'run' } | { decision: 'not-now' } | { decision: 'refused'; detail: string };

/**
 * The person's answer in the target, to a request this target claimed: **Run** moves it to `starting`, **Not now**
 * to `declined`, a failed check to `refused` with its words. **Run** is refused once the requester stopped it, and
 * checks again that the project allows it, as the claim did.
 */
export async function answerRequest(
  { db, target, access }: RunTargetCaller,
  id: string,
  answer: TargetAnswer,
  now = new Date(),
): Promise<TargetMoveResult> {
  if (answer.decision === 'run') {
    const [row] = await db
      .select({ projectId: runRequests.projectId })
      .from(runRequests)
      .where(and(eq(runRequests.id, id), eq(runRequests.targetId, target.id)));
    if (row && !(await mayReceiveOn(db, access, row.projectId))) {
      return { ok: false, statusCode: 403, message: NOT_ALLOWED };
    }
  }
  const base = [eq(runRequests.id, id), eq(runRequests.targetId, target.id), eq(runRequests.state, 'claimed')];
  const values =
    answer.decision === 'run'
      ? { state: 'starting' }
      : answer.decision === 'not-now'
        ? { state: 'declined' }
        : { state: 'refused', detail: answer.detail };
  if (answer.decision === 'run') base.push(isNull(runRequests.stopRequestedAt));
  const moved = await db
    .update(runRequests)
    .set({ ...values, answeredAt: now, updatedAt: now })
    .where(and(...base))
    .returning();
  return moveOrExplain(db, target, id, moved, 'This request is not waiting for an answer, or was stopped');
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

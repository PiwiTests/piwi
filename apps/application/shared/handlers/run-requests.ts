import { and, count, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  RUN_REQUEST_LIMITS,
  isRunRequestBranch,
  parseRunRequest,
  isRunRequestCommit,
  parseRunRequestTest,
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
} from '../../server/database/schema';
import { can, projectScopeFor, type AccessSummary } from '#shared/permissions';
import { FAILED_STATUS_KEYS } from '#shared/utils/test-counts';
import type { DrizzleDB } from './db';

/**
 * The requester's side of run requests, which the server and the demo share: the tests a request runs, resolved from
 * the stored executions, what the requester's page reads of a request, the requester's own list, and a stop.
 */

/** What a request names its tests from, before the instance resolves them. */
export type RunRequestSourceInput =
  | { executionId: number }
  | { runId: number; tests: 'failed' | 'all' }
  | { runId: number; filePath: string };

export type ResolvedRequestTests =
  | {
      ok: true;
      projectId: number;
      tests: RunRequestTest[];
      /** How many of the tests were left out: no line was recorded, or a stored value does not pass the parser. */
      skipped: number;
      source: RunRequestSource;
      projects: string[];
    }
  | { ok: false; statusCode: 404 | 422; message: string };

/**
 * The tests a request runs, read from the stored executions, never from the browser: an execution, the failed or
 * all tests of a run (final attempts only, one per test and Playwright project), or the tests of one spec file of a
 * run. A test the parser refuses, or one stored without a line (which would select its whole file), is left out and
 * counted. Also answers what the request came from (the run, and its branch and commit when they pass the parser) and
 * the Playwright projects the tests ran in, which bound the request's `project` option.
 */
export async function resolveRequestTests(db: DrizzleDB, input: RunRequestSourceInput): Promise<ResolvedRequestTests> {
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

  const { max } = RUN_REQUEST_LIMITS.tests;
  const readAtMost = RAW_TEST_ROWS * max;
  const rows = await db
    .selectDistinct({
      filePath: testCases.filePath,
      title: testCases.title,
      suitePath: testCases.suitePath,
      line: testRunsCases.line,
      projectName: testRunsCases.browserName,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(and(...conditions))
    .orderBy(testCases.filePath, testRunsCases.line, testCases.title, testRunsCases.browserName)
    .limit(readAtMost + 1);
  if (rows.length === 0) return { ok: false, statusCode: 422, message: 'These tests are not in the run' };
  const tooMany = {
    ok: false,
    statusCode: 422,
    message: `A request runs at most ${max} tests; these are more`,
  } as const;
  if (rows.length > readAtMost) return tooMany;

  const tests: RunRequestTest[] = [];
  const seen = new Set<string>();
  const projects = new Set<string>();
  let skipped = 0;
  for (const row of rows) {
    const projectName = row.projectName || null;
    const parsed = parseRunRequestTest({ filePath: row.filePath, title: row.title, line: row.line, projectName });
    if (!parsed.ok || parsed.value.line === null) {
      skipped++;
      continue;
    }
    const key = JSON.stringify([row.filePath, row.title, row.line, projectName]);
    if (seen.has(key)) continue;
    seen.add(key);
    tests.push(parsed.value);
    if (projectName) projects.add(projectName);
  }
  if (tests.length > max) return tooMany;
  if (tests.length === 0) {
    return {
      ok: false,
      statusCode: 422,
      message:
        'None of these tests can be sent: each has no recorded line, or a path, title or project a run request refuses',
    };
  }

  const source: RunRequestSource = { runId };
  if (executionId !== undefined) source.executionId = executionId;
  if (isRunRequestBranch(run.branch)) source.branch = run.branch;
  if (isRunRequestCommit(run.commit)) source.commit = run.commit;
  return { ok: true, projectId: run.projectId, tests, skipped, source, projects: [...projects].sort() };
}

/**
 * How many stored rows per allowed test the instance reads before it counts the tests a request keeps: rows of a
 * test that differ only by describe block, and tests the parser refuses, are left out after the read.
 */
const RAW_TEST_ROWS = 4;

/** How many waiting requests one person may hold at once. */
export const MAX_WAITING_REQUESTS = 5;

/** How many of a person's requests wait for a claim, as of `now`. */
export async function countWaitingRequests(db: DrizzleDB, requesterId: number, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(runRequests)
    .where(
      and(eq(runRequests.requesterId, requesterId), eq(runRequests.state, 'waiting'), gt(runRequests.expiresAt, now)),
    );
  return row?.n ?? 0;
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
  /** The run the request started, once its request token started one. */
  runId: number | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export async function runRequestView(db: DrizzleDB, row: RunRequestRow, now = new Date()): Promise<RunRequestView> {
  const targets = await targetsOf(db, row.targetId == null ? [] : [row.targetId]);
  return viewOf(row, targets, now);
}

type TargetSummary = NonNullable<RunRequestView['target']>;

async function targetsOf(db: DrizzleDB, ids: number[]): Promise<Map<number, TargetSummary>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: runTargets.id, kind: runTargets.kind, deviceName: runTargets.deviceName })
    .from(runTargets)
    .where(inArray(runTargets.id, ids));
  return new Map(rows.map((t) => [t.id, t]));
}

function viewOf(row: RunRequestRow, targets: Map<number, TargetSummary>, now: Date): RunRequestView {
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
    target: row.targetId == null ? null : (targets.get(row.targetId) ?? null),
    runId: row.runId ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** How many of their requests the requester's list shows. */
export const OWN_REQUESTS_LIMIT = 20;

/**
 * The requester's own requests, newest first: the last `OWN_REQUESTS_LIMIT` of a project, or of every project they
 * can read. A request of a project they can no longer read is left out.
 */
export async function listOwnRequests(
  db: DrizzleDB,
  requesterId: number,
  access: AccessSummary,
  { projectId }: { projectId?: number } = {},
  now = new Date(),
): Promise<RunRequestView[]> {
  if (projectId !== undefined && !can(access, 'project:read', projectId)) return [];
  const conditions = [eq(runRequests.requesterId, requesterId)];
  if (projectId !== undefined) conditions.push(eq(runRequests.projectId, projectId));
  else {
    const scope = projectScopeFor(access, 'project:read');
    if (scope !== 'all') {
      if (scope.size === 0) return [];
      conditions.push(inArray(runRequests.projectId, [...scope]));
    }
  }
  const readable = await db
    .select()
    .from(runRequests)
    .where(and(...conditions))
    .orderBy(desc(runRequests.createdAt), desc(runRequests.id))
    .limit(OWN_REQUESTS_LIMIT);
  const targetIds = [...new Set(readable.flatMap((row) => (row.targetId == null ? [] : [row.targetId])))];
  const targets = await targetsOf(db, targetIds);
  return readable.map((row) => viewOf(row, targets, now));
}

/**
 * A requester's own request, or null: another person's request is answered as missing, and so is one of a project
 * the requester can no longer read.
 */
export async function findOwnRequest(
  db: DrizzleDB,
  id: string,
  requesterId: number,
  access: AccessSummary,
): Promise<RunRequestRow | null> {
  const [row] = await db
    .select()
    .from(runRequests)
    .where(and(eq(runRequests.id, id), eq(runRequests.requesterId, requesterId)));
  return row && can(access, 'project:read', row.projectId) ? row : null;
}

/** The states of a request a target holds: claimed, or its run once the person clicked **Run**. */
export const ACTIVE_STATES: RunRequestState[] = ['claimed', 'starting', 'running', 'stopping'];
export const RUN_STATES: RunRequestState[] = ['starting', 'running', 'stopping'];

/**
 * Stop a request from the requester's page. Waiting, claimed but not answered, or held by a target that was
 * disconnected since, it ends at once as stopped, and the target that claimed it finds it in its stops. Once the
 * person clicked **Run**, the stop is recorded for the target, which ends the run and reports it; a second stop, once
 * the target had `stopGraceMs` to act on the first, ends the request as stopped. Answers false once it has ended.
 */
export async function stopOwnRequest(
  db: DrizzleDB,
  id: string,
  requesterId: number,
  now = new Date(),
): Promise<boolean> {
  const mine = and(eq(runRequests.id, id), eq(runRequests.requesterId, requesterId));
  const graceOver = new Date(now.getTime() - RUN_REQUEST_LIMITS.stopGraceMs);
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
          and(inArray(runRequests.state, RUN_STATES), lt(runRequests.stopRequestedAt, graceOver)),
        ),
      ),
    )
    .returning({ id: runRequests.id });
  if (ended.length) return true;
  const stopping = await db
    .update(runRequests)
    .set({ stopRequestedAt: now, updatedAt: now })
    .where(and(mine, inArray(runRequests.state, RUN_STATES), isNull(runRequests.stopRequestedAt)))
    .returning({ id: runRequests.id });
  if (stopping.length) return true;
  const [asked] = await db
    .select({ id: runRequests.id })
    .from(runRequests)
    .where(and(mine, inArray(runRequests.state, RUN_STATES)));
  return asked !== undefined;
}

const id = z.number().int().positive().max(2_147_483_647);

/** The body of `POST /api/run-requests`: what the tests come from, the options and, optionally, the target. */
export const runRequestBodySchema = z.object({
  source: z.union([
    z.object({ executionId: id }).strict(),
    z.object({ runId: id, tests: z.enum(['failed', 'all']) }).strict(),
    z.object({ runId: id, filePath: z.string().min(1).max(500) }).strict(),
  ]),
  options: z.unknown().optional(),
  targetId: id.optional(),
});

export interface CreateRunRequestInput {
  /** A new request id, 32 hex digits. */
  id: string;
  requesterId: number;
  /** The project of the source, which the caller was checked on. */
  projectId: number;
  source: RunRequestSourceInput;
  options: RunRequestOptions;
  targetId: number | null;
  now?: Date;
}

export type CreateRunRequestResult =
  | { ok: true; row: RunRequestRow; skipped: number }
  | { ok: false; statusCode: 404 | 422 | 429; message: string };

/**
 * Store a request for the requester's own targets, its tests resolved from the stored executions. The cap of waiting
 * requests is counted once the request is stored, so requests made at the same moment never pass it together; a
 * request claimed before its refusal deletes it stands, and is answered as made.
 */
export async function createRunRequest(db: DrizzleDB, input: CreateRunRequestInput): Promise<CreateRunRequestResult> {
  const now = input.now ?? new Date();
  const resolved = await resolveRequestTests(db, input.source);
  if (!resolved.ok) return resolved;
  const project = input.options.project;
  if (project !== undefined && !resolved.projects.includes(project)) {
    return { ok: false, statusCode: 422, message: `These tests did not run in the Playwright project "${project}"` };
  }
  if (input.targetId != null) {
    const [target] = await db
      .select({ id: runTargets.id })
      .from(runTargets)
      .where(and(eq(runTargets.id, input.targetId), eq(runTargets.userId, input.requesterId)));
    if (!target) return { ok: false, statusCode: 404, message: 'No connected app of yours has this id' };
  }
  const request = parseRunRequest({
    id: input.id,
    kind: 'run',
    projectId: input.projectId,
    tests: resolved.tests,
    options: input.options,
    source: resolved.source,
  });
  if (!request.ok) return { ok: false, statusCode: 422, message: request.problems.join(' ') };

  const [row] = await db
    .insert(runRequests)
    .values({
      id: request.value.id,
      projectId: input.projectId,
      requesterId: input.requesterId,
      targetId: input.targetId,
      kind: request.value.kind,
      tests: request.value.tests,
      options: request.value.options,
      source: request.value.source,
      state: 'waiting',
      expiresAt: new Date(now.getTime() + RUN_REQUEST_LIMITS.lifetimeMs),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  let stored = row!;
  if ((await countWaitingRequests(db, input.requesterId, now)) > MAX_WAITING_REQUESTS) {
    const refused = await db
      .delete(runRequests)
      .where(and(eq(runRequests.id, stored.id), eq(runRequests.state, 'waiting')))
      .returning({ id: runRequests.id });
    if (refused.length) {
      return {
        ok: false,
        statusCode: 429,
        message: `${MAX_WAITING_REQUESTS} of your requests are already waiting for a claim: stop one, or wait for them`,
      };
    }
    stored = (await db.select().from(runRequests).where(eq(runRequests.id, stored.id)))[0] ?? stored;
  }
  return { ok: true, row: stored, skipped: resolved.skipped };
}

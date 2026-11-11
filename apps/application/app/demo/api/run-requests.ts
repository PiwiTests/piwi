/**
 * Run on my machine in the demo (`server/api/run-requests/`): the requester's routes, kept in the in-browser database
 * through the server's shared handler. The demo has no app to claim a request, so the requester's own seeded desktop
 * app answers it as it is read: claimed after 2 seconds, **Run** clicked after 5, running from 7 and passed at 15; a
 * stop ends it 2 seconds later. From 7 seconds the request has its run, private to its requester, whose tests pass at
 * 15. A persona with no app of their own sees their request expire, as on a server.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  parseRunRequestOptions,
  RUN_REQUEST_ID,
  type RunRequestSource,
  type RunRequestState,
  type RunRequestTest,
} from '@piwitests/core/run-request';
import { runRequests, runTargets, testCases, testRuns, testRunsCases } from '../../../server/database/schema';
import {
  createRunRequest,
  findOwnRequest,
  listOwnRequests,
  runRequestBodySchema,
  runRequestView,
  stopOwnRequest,
  type RunRequestSourceInput,
} from '#shared/handlers/run-requests';
import { isOptInCapabilityOn } from '#shared/handlers/capabilities';
import { isVisibleRun, runCommit, runOrigin, withRequestOrigin } from '#shared/run-eligibility';
import type { AccessSummary } from '#shared/permissions';
import { getDemoDb } from '../db.client';
import { demoHttpError } from './http-error';

/** When the simulated app moves a request on, in milliseconds after it was made. */
const CLAIM_AFTER_MS = 2000;
const RUN_AFTER_MS = 5000;
const RUNNING_AFTER_MS = 7000;
const ENDED_AFTER_MS = 15000;
const STOPPED_AFTER_MS = 2000;

const HELD: RunRequestState[] = ['waiting', 'claimed', 'starting', 'running', 'stopping'];

function newDemoRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Where a request stands for the simulated app, `age` milliseconds after it was made. */
function simulatedState(age: number): RunRequestState {
  if (age < CLAIM_AFTER_MS) return 'waiting';
  if (age < RUN_AFTER_MS) return 'claimed';
  if (age < RUNNING_AFTER_MS) return 'starting';
  if (age < ENDED_AFTER_MS) return 'running';
  return 'ended';
}

type DemoDb = Awaited<ReturnType<typeof getDemoDb>>;
type HeldRequest = typeof runRequests.$inferSelect;

/** The run a request's tests started: private to its requester, as a requested run is, and running. */
async function startRequestedRun(db: DemoDb, row: HeldRequest, startTime: Date): Promise<number> {
  const source = row.source as RunRequestSource;
  const scm = { ...(source.branch && { branch: source.branch }), ...(source.commit && { commit: source.commit }) };
  const metadata = withRequestOrigin(Object.keys(scm).length > 0 ? { scm } : null, row.id);
  const [run] = await db
    .insert(testRuns)
    .values({
      projectId: row.projectId,
      status: 'running',
      startTime,
      totalTests: (row.tests as RunRequestTest[]).length,
      branch: source.branch ?? null,
      metadata,
      origin: runOrigin(metadata),
      commit: runCommit(metadata),
      requesterId: row.requesterId,
      isFullRun: 0,
    })
    .returning({ id: testRuns.id });
  return run!.id;
}

/** End a request's run: its tests passed, each as the test it reran, or it was stopped while they ran. */
async function endRequestedRun(db: DemoDb, runId: number, row: HeldRequest, passed: boolean, endedAt: Date) {
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run || run.status !== 'running') return;
  const duration = Math.max(0, endedAt.getTime() - run.startTime.getTime());
  if (!passed) {
    await db
      .update(testRuns)
      .set({ status: 'interrupted', duration, updatedAt: endedAt })
      .where(eq(testRuns.id, runId));
    return;
  }
  const tests = row.tests as RunRequestTest[];
  const known = await db
    .select({ id: testCases.id, filePath: testCases.filePath, title: testCases.title })
    .from(testCases)
    .where(
      and(
        eq(testCases.projectId, row.projectId),
        inArray(testCases.filePath, [...new Set(tests.map((t) => t.filePath))]),
      ),
    );
  const each = Math.round(duration / Math.max(1, tests.length));
  const executions = tests.flatMap((test) => {
    const found = known.find((c) => c.filePath === test.filePath && c.title === test.title);
    return found
      ? [
          {
            testRunId: runId,
            testCaseId: found.id,
            status: 'passed',
            duration: each,
            line: test.line,
            browserName: test.projectName,
          },
        ]
      : [];
  });
  if (executions.length > 0) await db.insert(testRunsCases).values(executions);
  await db
    .update(testRuns)
    .set({
      status: 'passed',
      duration,
      totalTests: executions.length,
      passedTests: executions.length,
      avgTestDuration: executions.length > 0 ? each : null,
      updatedAt: endedAt,
    })
    .where(eq(testRuns.id, runId));
}

/** Move the requester's requests on as their seeded app would. */
async function answerAsTheApp(requesterId: number, now = new Date()): Promise<void> {
  const db = await getDemoDb();
  const [app] = await db.select({ id: runTargets.id }).from(runTargets).where(eq(runTargets.userId, requesterId));
  if (!app) return;
  const held = await db
    .select()
    .from(runRequests)
    .where(and(eq(runRequests.requesterId, requesterId), inArray(runRequests.state, HELD)));
  for (const row of held) {
    if (row.targetId != null && row.targetId !== app.id) continue;
    if (row.state === 'waiting' && row.expiresAt.getTime() <= row.createdAt.getTime() + CLAIM_AFTER_MS) continue;
    let state = simulatedState(now.getTime() - row.createdAt.getTime());
    // Claimed and answered when the app would have, whenever the request is read again.
    const claimedAt = new Date(row.createdAt.getTime() + CLAIM_AFTER_MS);
    const answeredAt = new Date(row.createdAt.getTime() + RUN_AFTER_MS);
    let outcome: 'passed' | 'stopped' | null = state === 'ended' ? 'passed' : null;
    if (row.stopRequestedAt) {
      const stopped = now.getTime() - row.stopRequestedAt.getTime() >= STOPPED_AFTER_MS;
      state = stopped ? 'ended' : 'stopping';
      outcome = stopped ? 'stopped' : null;
    }
    // The run started when the app would have started it, unless a stop came first.
    const ranAt = new Date(row.createdAt.getTime() + RUNNING_AFTER_MS);
    const ran =
      now.getTime() >= ranAt.getTime() && (!row.stopRequestedAt || row.stopRequestedAt.getTime() > ranAt.getTime());
    if (state === row.state && (!ran || row.runId != null)) continue;
    let runId = row.runId;
    if (ran && runId == null) runId = await startRequestedRun(db, row, ranAt);
    if (runId != null && state === 'ended') {
      const endedAt =
        outcome === 'stopped'
          ? new Date(row.stopRequestedAt!.getTime() + STOPPED_AFTER_MS)
          : new Date(row.createdAt.getTime() + ENDED_AFTER_MS);
      await endRequestedRun(db, runId, row, outcome === 'passed', endedAt);
    }
    await db
      .update(runRequests)
      .set({
        state,
        outcome,
        runId,
        targetId: state === 'waiting' ? row.targetId : app.id,
        claimedAt: state === 'waiting' ? row.claimedAt : (row.claimedAt ?? claimedAt),
        answeredAt: ['waiting', 'claimed'].includes(state) ? row.answeredAt : (row.answeredAt ?? answeredAt),
        updatedAt: now,
      })
      .where(eq(runRequests.id, row.id));
  }
}

/** The project of a request's source; null when its run or execution is missing, or not the viewer's to see. */
export async function demoRunRequestProjectId(
  source: RunRequestSourceInput,
  viewerId: number | null,
): Promise<number | null> {
  const db = await getDemoDb();
  const columns = { projectId: testRuns.projectId, origin: testRuns.origin, requesterId: testRuns.requesterId };
  const [row] =
    'executionId' in source
      ? await db
          .select(columns)
          .from(testRunsCases)
          .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
          .where(eq(testRunsCases.id, source.executionId))
      : await db.select(columns).from(testRuns).where(eq(testRuns.id, source.runId));
  return row && isVisibleRun(row, viewerId) ? row.projectId : null;
}

/** The body of POST /api/run-requests, checked as the server checks it, with its project. */
export async function demoReadRunRequestBody(body: unknown, viewerId: number | null) {
  const parsed = runRequestBodySchema.safeParse(body);
  if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
  const options = parseRunRequestOptions(parsed.data.options);
  if (!options.ok) throw demoHttpError(422, options.problems.join(' '));
  const source = parsed.data.source as RunRequestSourceInput;
  const projectId = await demoRunRequestProjectId(source, viewerId);
  if (projectId === null) {
    throw demoHttpError(404, 'executionId' in source ? 'Execution not found' : 'Test run not found');
  }
  return { source, options: options.value, targetId: parsed.data.targetId ?? null, projectId };
}

/** POST /api/run-requests, once the caller was checked on the project. */
export async function apiCreateRunRequest(
  requesterId: number,
  input: Awaited<ReturnType<typeof demoReadRunRequestBody>>,
) {
  const db = await getDemoDb();
  if (!(await isOptInCapabilityOn(db, input.projectId, 'machine-runs'))) {
    throw demoHttpError(403, 'Run on my machine is off for this project');
  }
  const created = await createRunRequest(db, { id: newDemoRequestId(), requesterId, ...input });
  if (!created.ok) throw demoHttpError(created.statusCode, created.message);
  return { ...(await runRequestView(db, created.row)), skipped: created.skipped };
}

/** GET /api/run-requests */
export async function apiListRunRequests(requesterId: number, access: AccessSummary, query?: URLSearchParams) {
  const raw = query?.get('projectId');
  let projectId: number | undefined;
  if (raw != null) {
    if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) {
      throw demoHttpError(400, 'projectId must be a project id');
    }
    projectId = Number(raw);
  }
  await answerAsTheApp(requesterId);
  return { items: await listOwnRequests(await getDemoDb(), requesterId, access, { projectId }) };
}

async function ownRequest(id: string, requesterId: number, access: AccessSummary) {
  if (!RUN_REQUEST_ID.test(id)) throw demoHttpError(404, 'No run request has this id');
  const row = await findOwnRequest(await getDemoDb(), id, requesterId, access);
  if (!row) throw demoHttpError(404, 'No run request has this id');
  return row;
}

/** GET /api/run-requests/:id */
export async function apiGetRunRequest(id: string, requesterId: number, access: AccessSummary) {
  await ownRequest(id, requesterId, access);
  await answerAsTheApp(requesterId);
  return runRequestView(await getDemoDb(), await ownRequest(id, requesterId, access));
}

/** POST /api/run-requests/:id/stop */
export async function apiStopRunRequest(id: string, requesterId: number, access: AccessSummary) {
  await answerAsTheApp(requesterId);
  await ownRequest(id, requesterId, access);
  if (!(await stopOwnRequest(await getDemoDb(), id, requesterId))) {
    throw demoHttpError(409, 'This request has already ended');
  }
  return runRequestView(await getDemoDb(), await ownRequest(id, requesterId, access));
}

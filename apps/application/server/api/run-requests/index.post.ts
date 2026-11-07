import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { parseRunRequest, parseRunRequestOptions, RUN_REQUEST_LIMITS } from '@piwitests/core/run-request';
import { getDatabase } from '../../database';
import { runRequests, runTargets } from '../../database/schema';
import { refuseApiKey, requireAuth } from '../../utils/auth';
import { requireProjectPermission, resolveRunProjectId, resolveTestRunCaseProjectId } from '../../utils/project-access';
import { checkRateLimit, rateLimitedError } from '../../utils/rate-limit';
import {
  countWaitingRequests,
  MAX_WAITING_REQUESTS,
  newRunRequestId,
  requireMachineRunsOn,
  requireSignInForRunRequests,
  resolveRequestTests,
  runRequestView,
  type RunRequestSourceInput,
} from '../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Ask one of your own machines to run tests',
    description:
      'Stores a run request for the caller’s own connected apps (the desktop app, Piwi Runner): one of them claims it, shows it, and runs it only after the person clicks **Run** there. The instance resolves the tests from a stored execution (`{ executionId }`), the failed or all tests of a run (`{ runId, tests: "failed" | "all" }`) or one spec file of a run (`{ runId, filePath }`); the request never takes a test list from the caller. `options` is a closed list (`headed`, `trace`, `repeatEach` 1–10, `workers` 1–4, `project` among the Playwright projects the tests ran in). `targetId` sends it to one of the caller’s targets; without it, the first to claim it takes it. A test whose path, title or project a request refuses, or with no recorded line, is left out, and `skipped` counts them. A request waits 2 minutes for a claim, and a person holds at most 5 waiting requests. Needs sign-in turned on, a signed-in session (an API key is refused), `run:request` on the run’s project and **Run on my machine** on for it. Rate-limited per user.',
    'x-required-permission': 'run:request',
    responses: {
      200: { description: 'The stored request, and `skipped`, how many of the tests were left out' },
      403: { description: 'Sign-in is off, the caller used an API key, lacks `run:request`, or the capability is off' },
      404: { description: 'The run, the execution or the target does not exist' },
      422: { description: 'The tests or options are out of bounds' },
      429: { description: 'Too many requests from this user, or 5 of theirs are already waiting' },
    },
  },
});

const CREATE_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

const id = z.number().int().positive().max(2_147_483_647);
const bodySchema = z.object({
  source: z.union([
    z.object({ executionId: id }).strict(),
    z.object({ runId: id, tests: z.enum(['failed', 'all']) }).strict(),
    z.object({ runId: id, filePath: z.string().min(1).max(500) }).strict(),
  ]),
  options: z.unknown().optional(),
  targetId: id.optional(),
});

export default eventHandler(async (event) => {
  requireSignInForRunRequests(event);
  const user = await requireAuth(event);
  refuseApiKey(event);
  const rateKey = `run-requests:create:${user.id}`;
  if (!checkRateLimit(rateKey, CREATE_RATE_LIMIT.limit, CREATE_RATE_LIMIT.windowMs)) {
    throw rateLimitedError(event, [rateKey]);
  }

  const parsed = bodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }
  const options = parseRunRequestOptions(parsed.data.options);
  if (!options.ok) throw apiError({ statusCode: 422, message: options.problems.join(' ') });
  const source = parsed.data.source as RunRequestSourceInput;

  const db = await getDatabase();
  const projectId =
    'executionId' in source
      ? await resolveTestRunCaseProjectId(db, source.executionId, user.id)
      : await resolveRunProjectId(db, source.runId, user.id);
  if (projectId == null) {
    throw apiError({
      statusCode: 404,
      message: 'executionId' in source ? 'Execution not found' : 'Test run not found',
    });
  }
  await requireProjectPermission(event, projectId);
  await requireMachineRunsOn(db, projectId);

  const resolved = await resolveRequestTests(db, source);
  if (!resolved.ok) throw apiError({ statusCode: resolved.statusCode, message: resolved.message });
  const project = options.value.project;
  if (project !== undefined && !resolved.projects.includes(project)) {
    throw apiError({ statusCode: 422, message: `These tests did not run in the Playwright project "${project}"` });
  }

  const targetId = parsed.data.targetId ?? null;
  if (targetId != null) {
    const [target] = await db
      .select({ id: runTargets.id })
      .from(runTargets)
      .where(and(eq(runTargets.id, targetId), eq(runTargets.userId, user.id)));
    if (!target) throw apiError({ statusCode: 404, message: 'No connected app of yours has this id' });
  }

  const request = parseRunRequest({
    id: newRunRequestId(),
    kind: 'run',
    projectId,
    tests: resolved.tests,
    options: options.value,
    source: resolved.source,
  });
  if (!request.ok) throw apiError({ statusCode: 422, message: request.problems.join(' ') });

  const now = new Date();
  const [row] = await db
    .insert(runRequests)
    .values({
      id: request.value.id,
      projectId,
      requesterId: user.id,
      targetId,
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
  // Counted once stored, so requests made at the same moment never pass the cap together.
  if ((await countWaitingRequests(db, user.id, now)) > MAX_WAITING_REQUESTS) {
    await db
      .delete(runRequests)
      .where(and(eq(runRequests.id, row!.id), eq(runRequests.state, 'waiting'), isNull(runRequests.targetId)));
    throw apiError({
      statusCode: 429,
      message: `${MAX_WAITING_REQUESTS} of your requests are already waiting for a claim: stop one, or wait for them`,
    });
  }
  return { ...(await runRequestView(db, row!, now)), skipped: resolved.skipped };
});

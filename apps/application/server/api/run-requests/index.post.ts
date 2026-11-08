import { parseRunRequestOptions } from '@piwitests/core/run-request';
import { createRunRequest, runRequestBodySchema } from '#shared/handlers/run-requests';
import { getDatabase } from '../../database';
import { refuseApiKey, requireAuth } from '../../utils/auth';
import { requireProjectPermission, resolveRunProjectId, resolveTestRunCaseProjectId } from '../../utils/project-access';
import { checkRateLimit, rateLimitedError } from '../../utils/rate-limit';
import { publishRunRequest } from '../../utils/run-target-events';
import {
  newRunRequestId,
  requireMachineRunsOn,
  requireSignInForRunRequests,
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

export default eventHandler(async (event) => {
  requireSignInForRunRequests(event);
  const user = await requireAuth(event);
  refuseApiKey(event);
  const rateKey = `run-requests:create:${user.id}`;
  if (!checkRateLimit(rateKey, CREATE_RATE_LIMIT.limit, CREATE_RATE_LIMIT.windowMs)) {
    throw rateLimitedError(event, [rateKey]);
  }

  const parsed = runRequestBodySchema.safeParse(await readBody(event));
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

  const created = await createRunRequest(db, {
    id: newRunRequestId(),
    requesterId: user.id,
    projectId,
    source,
    options: options.value,
    targetId: parsed.data.targetId ?? null,
  });
  if (!created.ok) throw apiError({ statusCode: created.statusCode, message: created.message });
  const stored = created.row;
  // Its targets that are online hear it at once; the rest read it as they connect.
  await publishRunRequest(db, stored).catch(() => {});
  return { ...(await runRequestView(db, stored)), skipped: created.skipped };
});

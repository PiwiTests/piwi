import { eq } from 'drizzle-orm';
import { ASK_TO_WATCH_MS } from '@piwitests/core/live-view';
import { projects, testRuns } from '../../../../database/schema';
import { isAuthEnabled, isSignedInPerson } from '../../../../utils/auth';
import { askRefusal, liveAsks } from '../../../../utils/live-asks';
import { liveViewRelay } from '../../../../utils/live-view';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Ask to watch a run nobody shares',
    description:
      "Asks the developer of a running run outside CI that is not shared live to share it (Ask to watch), naming the caller. The ask reaches the run's reporter in the answer of its next stream request, once, and the tool the run was launched from asks the developer, or its terminal prints it. Answers the caller's ask: its `id`, `by` (the caller's name, as the developer reads it), `answer` (null until the developer answers; `not-now`, or `shared` once a worker of the run shares it) and `waitMs` (how long before the caller may ask again). Each change of the ask comes to the caller on the run's event stream (`live-ask`). A person asks once per five minutes on one run: 429 with `Retry-After` and `waitMs` before that. 403 with authentication off or with an API key: a signed-in person asks. 409 while the project's live view or Ask to watch is off, the run is not running, is a CI run, holds no live view key, or is shared now. Asks are kept in memory, and end with the run. Requires `project:read` on the run's project.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, projectId, user } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  if (!isAuthEnabled(event)) {
    throw apiError({ statusCode: 403, message: 'Asking to watch names who asks: it needs sign-in, which is off here' });
  }
  if (!isSignedInPerson(event)) {
    throw apiError({ statusCode: 403, message: 'A signed-in person asks to watch a run, never an API key' });
  }

  const [run] = await db
    .select({
      status: testRuns.status,
      metadata: testRuns.metadata,
      digests: testRuns.liveViewKeyDigests,
      createdAt: testRuns.createdAt,
      liveView: projects.liveView,
      askToWatch: projects.askToWatch,
    })
    .from(testRuns)
    .innerJoin(projects, eq(projects.id, testRuns.projectId))
    .where(eq(testRuns.id, id));
  if (!run) throw apiError({ statusCode: 404, message: 'Test run not found' });
  const refusal = askRefusal({ ...run, keyed: liveViewRelay.holdsKey(id, run) });
  if (refusal) throw apiError({ statusCode: 409, message: refusal });
  if (liveViewRelay.workersOf(id).length > 0) {
    throw apiError({ statusCode: 409, message: 'The run is shared live now: watch it from its page.' });
  }

  const outcome = liveAsks.ask(id, projectId, user.id, user.name || user.username);
  if (!outcome.ok) {
    const minutes = Math.ceil(outcome.waitMs / 60_000);
    setResponseHeader(event, 'Retry-After', Math.ceil(outcome.waitMs / 1000));
    throw apiError({
      statusCode: 429,
      message: `You asked to watch this run less than ${ASK_TO_WATCH_MS / 60_000} minutes ago: ask again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      data: { waitMs: outcome.waitMs },
    });
  }
  return outcome.ask;
});

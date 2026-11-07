import { isRunKept, keptRunDeleteMessage } from '#shared/handlers/run-keep';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { testRuns } from '../../database/schema';
import { requireAuth } from '../../utils/auth';
import { holdsProjectPermission, requireProjectPermission, requireRouteId } from '../../utils/project-access';
import { deleteRunsByIds } from '../../utils/retention';
import { isVisibleRun } from '#shared/run-eligibility';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Delete a test run',
    description:
      'Permanently delete a test run and all associated data including reports, traces, files, and failure clusters. A kept run is refused with 409 until it is released. Requires `run:delete` (Project admin on the project). A private run (one a person asked for from the dashboard) is also deleted by its requester, with `run:request`, and is missing (404) to anyone else without `run:delete`.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': ['run:delete', 'run:request'],
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const user = await requireAuth(event);
  const db = await getDatabase();
  const [run] = await db
    .select({ projectId: testRuns.projectId, origin: testRuns.origin, requesterId: testRuns.requesterId })
    .from(testRuns)
    .where(eq(testRuns.id, id));
  if (!run) throw apiError({ statusCode: 404, message: 'Test run not found' });
  if (isVisibleRun(run, null)) {
    await requireProjectPermission(event, run.projectId, 'run:delete');
  } else if (isVisibleRun(run, user.id)) {
    // Its requester deletes their own private run.
    await requireProjectPermission(event, run.projectId, ['run:request', 'run:delete']);
  } else if (!(await holdsProjectPermission(event, run.projectId, ['run:delete']))) {
    // Another person's private run is missing to anyone who may not purge it.
    throw apiError({ statusCode: 404, message: 'Test run not found' });
  }

  if (await isRunKept(db, id)) {
    throw apiError({ statusCode: 409, message: keptRunDeleteMessage(id) });
  }

  // One deletion path for the endpoint and the nightly sweep: removes the run's
  // files, frees any trace blob it was the last to reference, clears every
  // dependent row and recomputes affected cluster counters.
  const { deletedRuns } = await deleteRunsByIds(db, [id]);
  if (deletedRuns === 0) {
    throw apiError({ statusCode: 404, message: 'Test run not found' });
  }

  return { success: true };
});

import { eq } from 'drizzle-orm';
import { readLiveWorkerId } from '@piwitests/core/live-view';
import { projects } from '../../../../database/schema';
import { openEventStream } from '../../../../utils/event-stream';
import { isAuthEnabled } from '../../../../utils/auth';
import { liveViewRelay } from '../../../../utils/live-view';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Watch a worker of a live run',
    description:
      "An event stream of one worker's live view, in a project with the live view on: frames of its test's page (`{ type: 'frame', data, call, test }`, a JPEG in base64, the call it was taken at and the test's title), why none shows (`{ type: 'refused', message }`), and why the view ended (`{ type: 'end', reason }`: the test ended, the worker left, the run ended, the project turned its live view off, the developer stopped sharing the run from their machine (`unshared`), or the same person opened a further view in its place), after which the stream closes. The worker sends frames only while someone watches, a few a second at most; a viewer that reads slower gets the latest frame alone. Nothing is stored. Watching needs what opening the run needs; with authentication on, one person holds 4 views of a run at most, a fifth ending their oldest (`{ type: 'end', reason: 'replaced' }`). 404 for a project with the live view off or a worker not in it, 429 past 16 views of one run.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'worker', in: 'query', required: true, schema: { type: 'integer', minimum: 0 } },
      { name: 'shard', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, projectId, user } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const query = getQuery(event);
  const worker = readLiveWorkerId(query.shard, query.worker);
  if (!worker)
    throw apiError({ statusCode: 400, message: 'Name the worker: worker from 0, and shard from 1 when sharded' });
  const [project] = await db.select({ liveView: projects.liveView }).from(projects).where(eq(projects.id, projectId));
  if (!project?.liveView) throw apiError({ statusCode: 404, message: 'The live view is off for this project' });
  // The person watching, when the instance knows people apart.
  const person = isAuthEnabled(event) ? user.id : null;
  const refused = liveViewRelay.addViewer(id, worker, () => openEventStream(event), person);
  if (refused) throw apiError({ statusCode: refused.status, message: refused.message });
});

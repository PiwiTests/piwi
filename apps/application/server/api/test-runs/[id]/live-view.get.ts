import { eq } from 'drizzle-orm';
import { readLiveWorkerId } from '@piwitests/core/live-view';
import { getDatabase } from '../../../database';
import { projects, testRuns } from '../../../database/schema';
import { openEventStream } from '../../../utils/event-stream';
import { liveViewKeyOf, liveViewRelay } from '../../../utils/live-view';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: "Hold a worker's live view stream",
    description:
      "The event stream a test worker keeps open while its run executes, in a project with the live view on: each event says how many people watch the worker (`{ type: 'viewers', count }`), and the worker sends frames of its test's page only while someone does. Authenticated by the run's live view key (`Authorization: Bearer pdl_…`), which the run's setup received and which opens nothing but this run's live view; a second stream of the same worker replaces the first. 401 without a key of this run, 404 once the project turned its live view off, 409 while the run is interrupted (its key opens the stream again if the run goes on), 410 once the run is no longer live, 429 past 64 workers of one run.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'worker', in: 'query', required: true, schema: { type: 'integer', minimum: 0 } },
      { name: 'shard', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
    ],
  },
});

/** The statuses of a run whose workers run tests. */
const LIVE_STATUSES: readonly string[] = ['initializing', 'running'];

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  liveViewRelay.noteRequest(id);
  const entry = liveViewRelay.authorize(id, liveViewKeyOf(event));
  if (!entry) throw apiError({ statusCode: 401, message: 'A live view key of this run is required' });
  const query = getQuery(event);
  const worker = readLiveWorkerId(query.shard, query.worker);
  if (!worker)
    throw apiError({ statusCode: 400, message: 'Name the worker: worker from 0, and shard from 1 when sharded' });

  const db = await getDatabase();
  const [run] = await db
    .select({ status: testRuns.status, liveView: projects.liveView })
    .from(testRuns)
    .innerJoin(projects, eq(projects.id, testRuns.projectId))
    .where(eq(testRuns.id, id));
  // A key minted as the project turned its live view off opens nothing.
  if (run && !run.liveView) {
    liveViewRelay.endRun(id, 'off');
    throw apiError({ statusCode: 404, message: 'The live view is off for this project' });
  }
  // An interrupted run may go on: its worker tries again a few times.
  if (run?.status === 'interrupted') throw apiError({ statusCode: 409, message: 'The run is interrupted' });
  if (!run || !LIVE_STATUSES.includes(run.status)) {
    liveViewRelay.endRun(id);
    throw apiError({ statusCode: 410, message: 'The run is no longer live' });
  }

  const refused = liveViewRelay.connectWorker(entry, worker, () => openEventStream(event));
  if (refused) throw apiError({ statusCode: refused.status, message: refused.message });
});

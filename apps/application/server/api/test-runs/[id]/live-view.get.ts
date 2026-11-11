import { eq } from 'drizzle-orm';
import { LIVE_VIEW_AFTER_PARAM, parseLiveMasks, readLiveWorkerId } from '@piwitests/core/live-view';
import { parseRouteId } from '#shared/route-id';
import { getDatabase } from '../../../database';
import { projects, testRuns } from '../../../database/schema';
import { openEventStream } from '../../../utils/event-stream';
import { liveAsks } from '../../../utils/live-asks';
import { authorizeLiveViewKey, liveViewKeyOf, liveViewRelay } from '../../../utils/live-view';
import { continueRun } from '../../../utils/run-continuation';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: "Hold a worker's live view stream",
    description:
      "The event stream a test worker keeps open while its run executes, in a project with the live view on: each event says how many people watch the worker (`{ type: 'viewers', count }`), or which elements the project masks in each image beside the secret fields (`{ type: 'masks', locators }`, first as the stream opens and again when a project admin changes them), and the worker sends frames of its test's page only while someone does. Authenticated by the run's live view key (`Authorization: Bearer pdl_…`), which the run's setup received and which opens nothing but this run's live view: the run keeps its digest, so an instance started again takes the key back while the run lasts; a second stream of the same worker replaces the first. 401 without a key of this run, 404 while the project has its live view off (a key that ended so included: it opens the stream again once the setting is back on, while the run lasts), 409 while the run is interrupted (its key opens the stream again if the run goes on), 410 once the run is no longer live (a key that ended with it included), 429 past 64 workers of one run. A worker that streams makes each teammate's ask to watch the run that waits answered as shared. `after` names the run this one continues, shared before it from the same editor window: that earlier run of the same project, with a lower id, run on a developer's machine as this one, from the same machine (the reporter's instance), keyed for the live view, ended, seen by the same people and continued by no run yet, is continued by this one from now on (its `continuedInId`), once, and its page follows; a run continues one run at most.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'worker', in: 'query', required: true, schema: { type: 'integer', minimum: 0 } },
      { name: 'shard', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
      { name: 'slot', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
      { name: 'after', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
    ],
  },
});

/** The statuses of a run whose workers run tests. */
const LIVE_STATUSES: readonly string[] = ['initializing', 'running'];

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  liveViewRelay.noteRequest(id);
  const db = await getDatabase();
  const entry = await authorizeLiveViewKey(db, id, liveViewKeyOf(event));
  const query = getQuery(event);
  const worker = readLiveWorkerId(query.shard, query.worker, query.slot);
  if (!worker)
    throw apiError({ statusCode: 400, message: 'Name the worker: worker from 0, and shard from 1 when sharded' });

  const [run] = await db
    .select({
      status: testRuns.status,
      projectId: testRuns.projectId,
      origin: testRuns.origin,
      requesterId: testRuns.requesterId,
      instanceId: testRuns.instanceId,
      liveView: projects.liveView,
      masks: projects.liveViewMasks,
    })
    .from(testRuns)
    .innerJoin(projects, eq(projects.id, testRuns.projectId))
    .where(eq(testRuns.id, id));
  // A key minted as the project turned its live view off opens nothing.
  if (run && !run.liveView) {
    liveViewRelay.endRun(id, 'off');
    throw apiError({ statusCode: 404, message: 'The live view is off for this project' });
  }
  // An interrupted run may go on: its worker tries again.
  if (run?.status === 'interrupted') throw apiError({ statusCode: 409, message: 'The run is interrupted' });
  if (!run || !LIVE_STATUSES.includes(run.status)) {
    liveViewRelay.endRun(id);
    throw apiError({ statusCode: 410, message: 'The run is no longer live' });
  }

  const refused = liveViewRelay.connectWorker(
    entry,
    worker,
    () => openEventStream(event),
    parseLiveMasks(run.masks) ?? [],
  );
  if (refused) throw apiError({ statusCode: refused.status, message: refused.message });
  liveAsks.shareRun(id);
  const named = query[LIVE_VIEW_AFTER_PARAM];
  const after = typeof named === 'string' ? parseRouteId(named) : null;
  // The stream is open: a link that fails is logged, and the worker's next stream links it.
  if (after !== null) {
    await continueRun(db, { id, ...run }, after).catch((err) =>
      console.warn(`[live-view] Run #${id} could not continue run #${after}`, err),
    );
  }
});

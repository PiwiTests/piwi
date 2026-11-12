import { eq } from 'drizzle-orm';
import { readLiveViewSize, readLiveWorkerId } from '@piwitests/core/live-view';
import { projects, testRuns } from '../../../../database/schema';
import { openLiveStream } from '../../../../utils/event-stream';
import { isAuthEnabled } from '../../../../utils/auth';
import { liveViewRelay } from '../../../../utils/live-view';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Watch a live run',
    description:
      "A page's one watch of a live run, in a project with the live view on: a stream of live messages (`Content-Type: application/vnd.piwi.live-stream`; each message the header's length as a 32-bit big-endian number, the header as JSON, the data's length the same way, then the data; a message whose two lengths are 0 is a heartbeat, every 15 s). It opens with the watch's id (`{ type: 'hello', watch }`), which `POST` on this path takes to change what it shows. It shows one worker in full (`worker`, `shard`, and `slot`, its Playwright `parallelIndex`, for a view of the worker's lane, which follows the lane through its next tests and the worker Playwright starts in it again after a failure, waiting 30 s for it, as it does for a lane asked while it waits), at the size the page shows it (`width` and `height`, both or neither, in device pixels from 1, held within 320 by 200 and 1280 by 800, the largest asked of a worker its worker takes), and with `tiles=1` every other worker's latest image, one a second at most (**Watch all**). Each message about a worker names it (`shard`, `worker`, `slot`): its frames (`{ type: 'frame', call, test, at }`, the JPEG's bytes as the data, the call it was taken at, the test's title), why none shows (`{ type: 'refused', message }`), and for the full view the call its test is in as Playwright logs it in a CI run (`{ type: 'call-log', log, test }`), how its test ended (`{ type: 'test-ended', outcome }`) for a view of its lane, and why the full view ended (`{ type: 'end', reason, outcome? }`: the test ended, the worker left, the developer stopped sharing the run from their machine, `unshared`), after which the watch stays open. An end that names no worker ends the whole watch, and the stream closes after it: the run ended, the project turned its live view off, or the same person opened a further watch in its place. The worker sends frames only while someone watches; a page that reads slower, or past 1 MB of images a second, gets the latest frame alone, and a watch whose page reads nothing for 5 s ends, its stream closed. A tile carries an image of 48 KB at most: a larger one, of a worker shown in full elsewhere at a large size, comes as why none shows. Nothing is stored. Watching needs what opening the run needs; with authentication on, one person holds 4 watches of a run at most, a fifth ending their oldest (`{ type: 'end', reason: 'replaced' }`). 400 for a worker or a size named wrongly, or for neither a worker nor tiles; 404 for a project with the live view off or a full view of a worker not in it; 410 for a run that is no longer live, one that ends as the watch opens included; 429 past 16 watches of one run.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'worker', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
      { name: 'shard', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
      { name: 'slot', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
      { name: 'tiles', in: 'query', required: false, schema: { type: 'integer', enum: [0, 1] } },
      { name: 'width', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
      { name: 'height', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
    ],
    'x-required-permission': 'project:read',
  },
});

/** The statuses of a run whose workers run tests. */
const LIVE_STATUSES: readonly string[] = ['initializing', 'running'];

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, projectId, user } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const query = getQuery(event);
  const named = query.worker !== undefined && query.worker !== '';
  const focus = named ? readLiveWorkerId(query.shard, query.worker, query.slot) : null;
  if (named && !focus)
    throw apiError({ statusCode: 400, message: 'Name the worker: worker from 0, and shard from 1 when sharded' });
  const tiles = query.tiles === '1';
  if (!focus && !tiles) throw apiError({ statusCode: 400, message: 'Name a worker to show in full, or tiles=1' });
  const sized = query.width !== undefined || query.height !== undefined;
  const size = sized ? readLiveViewSize(query.width, query.height) : null;
  if (sized && !size) {
    throw apiError({
      statusCode: 400,
      message: 'width and height are whole numbers of device pixels, both or neither',
    });
  }
  const [project] = await db.select({ liveView: projects.liveView }).from(projects).where(eq(projects.id, projectId));
  if (!project?.liveView) throw apiError({ statusCode: 404, message: 'The live view is off for this project' });
  const [run] = await db.select({ status: testRuns.status }).from(testRuns).where(eq(testRuns.id, id));
  if (!run || !LIVE_STATUSES.includes(run.status))
    throw apiError({ statusCode: 410, message: 'The run is no longer live' });
  // The person watching, when the instance knows people apart.
  const person = isAuthEnabled(event) ? user.id : null;
  const refused = liveViewRelay.openWatch(
    id,
    projectId,
    { focus, tiles, ...(size ? { size } : {}) },
    () => openLiveStream(event),
    person,
  );
  if (refused) throw apiError({ statusCode: refused.status, message: refused.message });
});

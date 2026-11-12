import { eq } from 'drizzle-orm';
import { projects } from '../../../../database/schema';
import { liveViewRelay, MAX_LIVE_VIEWERS_PER_RUN } from '../../../../utils/live-view';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: "The workers in a run's live view",
    description:
      "Whether the run's project has its live view on (`enabled`), the workers of the run that hold a live view stream now (`workers`: each one's `shard`, `worker`, its lane `slot` when its reporter says it and, while its test is stopped, the stop and its call in `paused`), how many watches of the run are open, a page's one connection whatever it shows (`viewers`), of the most it allows (`maxViewers`), and what the run's workers sent this instance so far (`received`: the requests to the run's live view, refused ones included, the frames and their bytes), counted in memory while the instance runs. The run's event stream carries the same workers as `live-worker` events.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const [project] = await db.select({ liveView: projects.liveView }).from(projects).where(eq(projects.id, projectId));
  return {
    enabled: project?.liveView === true,
    workers: liveViewRelay.workersOf(id),
    viewers: liveViewRelay.viewersOf(id),
    maxViewers: MAX_LIVE_VIEWERS_PER_RUN,
    received: liveViewRelay.countsFor(id),
  };
});

import { eq } from 'drizzle-orm';
import { projects } from '../../../../database/schema';
import { liveViewRelay } from '../../../../utils/live-view';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: "The workers in a run's live view",
    description:
      "Whether the run's project has its live view on (`enabled`), the workers of the run that hold a live view stream now (`workers`: each one's `shard`, `worker` and, while its test is stopped, the stop and its call in `paused`), and what the run's workers sent this instance so far (`received`: the requests to the run's live view, refused ones included, the frames and their bytes), counted in memory while the instance runs. The run's event stream carries the same workers as `live-worker` events.",
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
    received: liveViewRelay.countsFor(id),
  };
});

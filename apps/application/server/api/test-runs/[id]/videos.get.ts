import { getRunVideos } from '#shared/handlers/run-videos';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'The executions of a run with their recorded videos',
    description:
      'The final attempts of the run, by file and line, each with the video it recorded (`video`, null when it has none; its `path` is served by `GET /api/files/{path}` with range requests) and what the Video tab needs to place the test in that video: when it started, how long it ran and when its `Create page` step ended. An earlier attempt of a retried test is not listed. `executions` lists up to 2000; `truncated` is true when there are more. Read-only.',
    'x-required-permission': 'project:read',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  return getRunVideos(db, id);
});

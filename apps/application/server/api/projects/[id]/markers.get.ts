import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getDatabase } from '../../../database';
import { listProjectMarkers } from '#shared/handlers/markers';

defineRouteMeta({
  openAPI: {
    tags: ['Markers'],
    summary: 'List project timeline markers',
    description:
      'Returns the dated timeline markers (deploys, config changes, incidents, ...) for a project. Each keeps its environment label as written (`environment`), the environment it resolves to (`environmentId`) and that environment’s name (`environmentName`), all null for a marker of every environment, and a deploy marker its `commit`.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);

  const db = await getDatabase();
  return { items: (await listProjectMarkers(db, id)).markers };
});

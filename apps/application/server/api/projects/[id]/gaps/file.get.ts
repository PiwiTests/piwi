import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getFileTestMap } from '../../../../utils/feature-graph';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: "A file's place in the Test Map",
    description:
      "The Test Map nodes a repository file is or serves: its own `handler` and `file` nodes, the routes its handler serves (`handled-by`), and the route or page the framework's file naming gives it (`convention`), each with the tests that reach it, its feature and its open gaps (the highest score first, at most three, with the count of all). A *changed, unreached* gap on the file lists its `file` node. Where the coverage file view links to the Gaps tab. Observed reach, never instrumented coverage.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'path',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Repository-relative path of the file',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);
  const path = String(getQuery(event).path ?? '').trim();
  if (!path) throw apiError({ statusCode: 400, message: 'path is required: a repository-relative file path' });
  return getFileTestMap(await getDatabase(), projectId, path);
});

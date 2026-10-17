import { getDatabase } from '../../../database';
import { listCoverageReports, parseCoverageReportsQuery } from '../../../utils/coverage-reports';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Coverage'],
    summary: 'List coverage reports',
    description:
      'The project’s uploaded coverage reports, newest first: those of one `commit`, or the latest `limit` (50 by default, 500 at most). Each names its `commit`, `branch` (null for the default branch), `suite`, `kind` (`unit` or `e2e`), `tool`, whether it is `incomplete`, how many `files` it covers and how many tracked files its commit’s inventory names (`inventoryFiles`, null without one).',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'commit', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const query = getQuery(event);
  const parsed = parseCoverageReportsQuery(query.commit, query.limit);
  if ('error' in parsed) throw apiError({ statusCode: 400, message: parsed.error });
  return { items: await listCoverageReports(await getDatabase(), id, parsed) };
});

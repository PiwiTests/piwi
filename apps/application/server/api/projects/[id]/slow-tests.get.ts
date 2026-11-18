import { parseProjectRunScope } from '#shared/project-run-scope';
import { getDatabase } from '../../../database';
import { optionalIntQuery } from '../../../utils/query-params';
import { getProjectSlowTests } from '#shared/handlers/projects';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Slow test analysis',
    description:
      'Returns the slowest test cases for a project with average, max, min duration, run count, and trend direction',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'environments',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Run scope: comma-separated environments; only their runs count. Without it, the project’s default environment when it has one, unless `allEnvironments`. Any of `environments`, `allEnvironments`, `branches` or `allBranches` makes the request read the project page’s run scope.',
      },
      {
        name: 'allEnvironments',
        in: 'query',
        required: false,
        schema: { type: 'boolean', default: false },
        description: 'Run scope: with no `environments`, count every environment instead of the default environment.',
      },
      {
        name: 'branches',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Run scope: comma-separated branches; only their runs count. Without it, the project’s default branch and runs with no branch count, unless `allBranches`.',
      },
      {
        name: 'allBranches',
        in: 'query',
        required: false,
        schema: { type: 'boolean', default: false },
        description: 'Run scope: with no `branches`, count every branch instead of the default branch.',
      },
      {
        name: 'fullRunsOnly',
        in: 'query',
        required: false,
        schema: { type: 'boolean', default: true },
        description: 'Run scope: only full-suite runs count; `false` adds partial runs.',
      },
      {
        name: 'runs',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 10, maximum: 100 },
        description: 'Number of recent runs to analyze (default 10, max 100).',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');

  await requireProjectAccess(event, id);

  const runsCount = optionalIntQuery(event, 'runs', { default: 10, min: 1, max: 100 });

  const db = await getDatabase();

  try {
    return { items: await getProjectSlowTests(db, id, runsCount, parseProjectRunScope(getQuery(event))) };
  } catch (e: any) {
    if (e?.message === 'Project not found') {
      throw apiError({ statusCode: 404, message: 'Project not found' });
    }
    throw e;
  }
});

import { getDatabase } from '../../database';
import { getProject } from '#shared/handlers/projects';
import { parseProjectRunScope } from '#shared/project-run-scope';
import { optionalIntQuery } from '../../utils/query-params';
import { requireProjectAccess, requireRouteId } from '../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Get project details',
    description:
      'Returns the project with its most recent runs (`testRuns`). With a run scope (any of `environments`, `branches` or `allBranches`), `testRuns` holds the most recent runs within it, and `unscopedRuns` the most recent runs of any scope with their environment, branch and run kind.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 200, maximum: 1000 },
        description: 'Maximum number of recent runs to include',
      },
      {
        name: 'environments',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Run scope: comma-separated environments; only their runs are listed. Any of `environments`, `branches` or `allBranches` makes the request read the project page’s run scope.',
      },
      {
        name: 'branches',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Run scope: comma-separated branches; only their runs are listed. Without it, the project’s default branch and runs with no branch are, unless `allBranches`.',
      },
      {
        name: 'allBranches',
        in: 'query',
        required: false,
        schema: { type: 'boolean', default: false },
        description: 'Run scope: with no `branches`, list every branch instead of the default branch.',
      },
      {
        name: 'fullRunsOnly',
        in: 'query',
        required: false,
        schema: { type: 'boolean', default: true },
        description: 'Run scope: only full-suite runs are listed; `false` adds partial runs.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');

  await requireProjectAccess(event, id);

  const runLimit = optionalIntQuery(event, 'limit', { min: 1 });

  const db = await getDatabase();
  try {
    const result = await getProject(db, id, { runLimit, scope: parseProjectRunScope(getQuery(event)) });
    const { scmToken: _scm, ...rest } = result;
    return rest;
  } catch (e: any) {
    if (e?.message === 'Project not found') {
      throw apiError({ statusCode: 404, message: 'Project not found' });
    }
    throw e;
  }
});

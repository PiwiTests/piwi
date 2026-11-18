import { parseProjectRunScope } from '#shared/project-run-scope';
import { getDatabase } from '../../../database';
import { optionalIntQuery } from '../../../utils/query-params';
import { getProjectTimeoutOpportunities } from '#shared/handlers/projects';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getTimeoutThresholds } from '../../../utils/timeout-thresholds';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Timeout-reduction opportunities',
    description:
      'Ranks a project’s tests whose configured per-test timeout far exceeds their real p95 duration (so failures waste time waiting), plus tests still carrying a stale test.slow() mark. Each row includes p50/p95/max duration, the effective timeout, a recommended new timeout, and an impact score. Thresholds are configurable in Settings.',
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
        schema: { type: 'integer', default: 20, maximum: 100 },
        description: 'How many recent runs to analyse',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');

  await requireProjectAccess(event, id);

  const runsCount = optionalIntQuery(event, 'runs', { default: 20, min: 1, max: 100 });

  const db = await getDatabase();
  const thresholds = await getTimeoutThresholds(db);

  try {
    return {
      items: await getProjectTimeoutOpportunities(db, id, runsCount, thresholds, parseProjectRunScope(getQuery(event))),
    };
  } catch (e: any) {
    if (e?.message === 'Project not found') {
      throw apiError({ statusCode: 404, message: 'Project not found' });
    }
    throw e;
  }
});

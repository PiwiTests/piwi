import { parseProjectRunScope } from '#shared/project-run-scope';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getDatabase } from '../../../database';
import { getProjectFailureClusters } from '#shared/handlers/projects';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'List failure clusters for a project',
    description:
      'Returns failure clusters grouped by error fingerprint with occurrence counts, affected tests count, and compact diagnosis info. Supports optional status filter.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['open', 'resolved', 'ignored'] },
        description: 'Only clusters in this triage status.',
      },
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
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const statusFilter = getQuery(event).status as string | undefined;

  await requireProjectAccess(event, projectId);

  const db = await getDatabase();

  try {
    return {
      items: await getProjectFailureClusters(db, projectId, statusFilter, parseProjectRunScope(getQuery(event))),
    };
  } catch (e: any) {
    if (e?.message === 'Project not found') {
      throw apiError({ statusCode: 404, message: 'Project not found' });
    }
    throw e;
  }
});

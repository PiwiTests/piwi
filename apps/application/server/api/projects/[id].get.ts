import { getDatabase } from '../../database';
import { getProject } from '#shared/handlers/projects';
import { parseProjectRunScope } from '#shared/project-run-scope';
import { optionalIntQuery } from '../../utils/query-params';
import { holdsProjectPermission, requireProjectAccess, requireRouteId } from '../../utils/project-access';
import { instanceCiServerUrl } from '../../utils/ci-server-dispatch';
import { runViewerOf } from '../../utils/run-viewer';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Get project details',
    description:
      'Returns the project with its most recent runs (`testRuns`). With a run scope (any of `environments`, `branches` or `allBranches`), `testRuns` holds the most recent runs within it, `unscopedRuns` the most recent runs of any scope with their environment, branch and run kind, and `ownRuns` the caller’s own most recent runs in the scope’s environments that `testRuns` does not hold, which the project page lists whatever its filters say. A run that is the caller’s own says `mine: true` (any other says nothing): a run outside CI they reported, or, with sign-in off, any such run; lab runs and imports are nobody’s. No token is returned: `hasScmToken` says whether one is stored, and, for a caller with `project:manage` on the project (null for anyone else), `ciServerInstanceUrl` names the instance’s CI server. The CI server credentials an action may name are listed by `GET /api/credentials?projectId=`.',
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

  const user = await requireProjectAccess(event, id);

  const runLimit = optionalIntQuery(event, 'limit', { min: 1 });

  const db = await getDatabase();
  try {
    const result = await getProject(db, id, {
      runLimit,
      scope: parseProjectRunScope(getQuery(event)),
      viewer: runViewerOf(event, user),
    });
    const { scmToken: _scm, ciServerToken: _ciServerToken, ...rest } = result;
    // The instance's CI server URL is the settings form's, which only a project admin opens.
    const managesProject = await holdsProjectPermission(event, id, ['project:manage']);
    return {
      ...rest,
      ciServerInstanceUrl: managesProject ? instanceCiServerUrl() : null,
    };
  } catch (e: any) {
    if (e?.message === 'Project not found') {
      throw apiError({ statusCode: 404, message: 'Project not found' });
    }
    throw e;
  }
});

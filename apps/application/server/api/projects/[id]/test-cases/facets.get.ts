import { parseProjectRunScope } from '#shared/project-run-scope';
import { getDatabase } from '../../../../database';
import { getProjectTestCaseFacets } from '#shared/handlers/projects';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'List the values the test catalog search can filter on',
    description:
      'Every spec file, describe block, tag, lock, owner, priority and feature among a project’s test cases, each with the number of test cases carrying it — the completions of the catalog’s search qualifiers (`file:`, `describe:`, `tag:`…). Returns `{ values: { file?, describe?, tag?, lock?, owner?, priority?, feature? } }`, each a list of `{ value, count }`, most common first; a field no test case has a value for is left out.',
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
        name: 'maxAgeDays',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 0, minimum: 0 },
        description: 'Only count cases executed within the last N days (0 = all time)',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');

  await requireProjectAccess(event, id);

  const query = getQuery(event);
  const maxAgeDays = Math.max(0, Math.floor(Number(query.maxAgeDays) || 0));
  const db = await getDatabase();
  return getProjectTestCaseFacets(db, id, { maxAgeDays, scope: parseProjectRunScope(query) });
});

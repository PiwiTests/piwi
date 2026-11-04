import { parseProjectRunScope } from '#shared/project-run-scope';
import { FLAKE_EXPERIMENTS_MAX, getProjectFlakeLab } from '#shared/handlers/flake-lab';
import { cachedFlakeProfileSummaries } from '../../../../utils/flake-profile-cache';
import { TOP_SUSPECTS_MAX_TESTS } from '#shared/handlers/flake-profile';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { optionalIntQuery } from '../../../../utils/query-params';
import { getDatabase } from '../../../../database';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'The project’s Flake Lab',
    description: `Where each test stands in the Flake Lab. \`tests\` holds every test on the flaky ranking of the last \`runs\` runs (scoped by environment and branch like the flaky-test analysis) or with a finished experiment: its \`state\` (\`untested\`, \`not-reproduced\`, \`amplified\`, \`reproduced\`, \`still-fails\`, \`inconclusive\`, \`verified\`, \`flaked-again\`), the \`nextCommand\` it needs (\`piwi flake\` to reproduce, \`piwi flake verify\` once reproduced, null once its fix holds), whether it is on the ranking, its retry-pass runs, the condition that reproduced it, its newest experiment, its experiment count, its verified fix and its \`flakeRate\` (the share of the runs read where it passed or failed in which it failed at least once). With \`suspects=true\`, the first ${TOP_SUSPECTS_MAX_TESTS} tests that need a step also carry \`suspect\` (the one it is shown with: a reproduced suspect, else the highest-ranked untested one, else one that did not reproduce; \`{ id, label, standing, matchingFailures, runs, lab }\`, null when its history names none) and \`untestedSuspects\`. Tests come a fix to verify first, a fix that held last. \`experiments\` is the project’s newest finished experiments (at most ${FLAKE_EXPERIMENTS_MAX}) with each test’s title and path, in the shape of the test-case experiments endpoint. \`counts\` totals the flaky, untested, awaiting-a-fix and verified tests, and every finished experiment.`,
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'environments',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Run scope: comma-separated environments; only their runs count. Any of `environments`, `branches` or `allBranches` makes the request read the project page’s run scope.',
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
      { name: 'runs', in: 'query', required: false, schema: { type: 'integer', default: 50 } },
      { name: 'environment', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'branch', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 20 } },
      { name: 'suspects', in: 'query', required: false, schema: { type: 'boolean', default: false } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);
  const query = getQuery(event);
  const db = await getDatabase();
  try {
    return await getProjectFlakeLab(db, projectId, {
      runs: optionalIntQuery(event, 'runs', { default: 50, min: 1, max: 200 }),
      environment: typeof query.environment === 'string' && query.environment ? query.environment : null,
      branch: typeof query.branch === 'string' && query.branch ? query.branch : null,
      scope: parseProjectRunScope(query),
      limit: optionalIntQuery(event, 'limit', { default: 20, min: 1, max: FLAKE_EXPERIMENTS_MAX }),
      suspects: query.suspects === 'true' || query.suspects === '1',
      profiles: (testCaseIds) => cachedFlakeProfileSummaries(db, projectId, testCaseIds),
    });
  } catch (e: any) {
    if (e?.message === 'Project not found') throw apiError({ statusCode: 404, message: 'Project not found' });
    throw e;
  }
});

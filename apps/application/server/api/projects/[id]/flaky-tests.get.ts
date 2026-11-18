import { parseProjectRunScope } from '#shared/project-run-scope';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { optionalIntQuery, queryFlag } from '../../../utils/query-params';
import { getDatabase } from '../../../database';
import { getProjectFlakyTestsWithVerified } from '#shared/handlers/projects';
import { withFlakyRootCauses } from '#shared/handlers/flaky-classify';
import { parseTagFilter } from '#shared/utils/tag-filter';
import { withResolvedOwners } from '../../../utils/scm/ownership';
import { TEST_PRIORITIES } from '@piwitests/core/test-meta';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Flaky test analysis',
    description:
      'Analyzes test flakiness across recent runs using retry-pass detection and pass/fail alternation scoring. Pass an environment and/or branch to scope the analysis to runs from that deployment environment (its key, an alias or a label, ignoring case) or SCM branch; without one, the project’s default branch and, when it has one, its default environment. A test whose Flake Lab verify experiment held, and that has not retry-passed in a run started since, leaves `items` and is listed in `verifiedFixed` (`{ testCaseId, title, filePath, retryPassRuns, lastFlakeAt, verifiedFix }`) until it retry-passes again. A test with no root cause yet is classified as the list is read, so `rootCause` is set on every item, unless `enrich=false`.',
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
      { name: 'runs', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'environment', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'branch', in: 'query', required: false, schema: { type: 'string' } },
      {
        name: 'enrich',
        in: 'query',
        required: false,
        schema: { type: 'boolean', default: true },
        description:
          'false leaves out what only the list shows — the root cause classified on read and the owner read from CODEOWNERS — for a caller that only counts the tests',
      },
      {
        name: 'tags',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Comma-separated tags; a test must carry every one of them to appear',
      },
      {
        name: 'owner',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Exact owner declared via the `piwi:owner` annotation',
      },
      {
        name: 'priority',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        description: 'Priority declared via the `piwi:priority` annotation',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);

  const query = getQuery(event);
  const runsLimit = optionalIntQuery(event, 'runs', { default: 50, min: 1, max: 200 });
  const environment = typeof query.environment === 'string' && query.environment ? query.environment : undefined;
  const branch = typeof query.branch === 'string' && query.branch ? query.branch : undefined;

  const tags = parseTagFilter(typeof query.tags === 'string' ? query.tags : undefined);
  const rawPriority = typeof query.priority === 'string' ? query.priority.trim().toLowerCase() : '';
  const filter = {
    tags: tags.length > 0 ? tags : undefined,
    owner: typeof query.owner === 'string' && query.owner.trim() ? query.owner.trim() : undefined,
    priority: (TEST_PRIORITIES as readonly string[]).includes(rawPriority) ? rawPriority : undefined,
  };

  const db = await getDatabase();

  try {
    const { items, verifiedFixed } = await getProjectFlakyTestsWithVerified(
      db,
      projectId,
      runsLimit,
      environment,
      filter,
      branch,
      parseProjectRunScope(query),
    );
    if (!queryFlag(event, 'enrich', { default: true })) return { items, verifiedFixed };
    const classified = await withFlakyRootCauses(db, projectId, items);
    // Fill in the owner from CODEOWNERS for tests that declare none, so the
    // leaderboard can be read per team without anyone annotating a test.
    return { items: await withResolvedOwners(db, projectId, classified), verifiedFixed };
  } catch (e: any) {
    if (e?.message === 'Project not found') {
      throw apiError({ statusCode: 404, message: 'Project not found' });
    }
    throw e;
  }
});

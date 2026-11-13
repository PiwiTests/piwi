import { getDatabase } from '../../../database';
import { getProjectTestCases, parseTestCasesQuery } from '#shared/handlers/projects';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'List test cases for a project with aggregated stats',
    description:
      'Paginated test-case catalog with per-case aggregates: total runs, pass/fail/skip/flaky counts, pass rate (passed over passed and failed runs, null when none) and average duration, derived status category, last run and its longest final attempt (`lastDuration`, ms), and the line and column its latest execution reported. Returns `{ items, total, limit, offset }`. Timed-out runs are folded into the failed counts.',
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
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 50, minimum: 1, maximum: 1000 },
        description: 'Page size',
      },
      {
        name: 'offset',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 0, minimum: 0 },
        description: 'Row offset for paging',
      },
      {
        name: 'q',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Search the catalog the way its search box does. Words and "quoted phrases" match the title, the describe blocks or the file path; qualifiers match one field: `file:` (alias `path:`), `describe:` (`suite:`), `title:` (`test:`, `name:`), `tag:`, `lock:`, `owner:`, `priority:`, `feature:`. A leading `-` excludes (`-tag:slow`). Text fields match anywhere, with `*` as a wildcard; the others match a whole value. Case is ignored. Every term must match, except that repeating `file:`, `owner:`, `priority:` or `feature:` matches any of the values.',
      },
      {
        name: 'file',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Spec file path: the path the test case stores, or its end from a folder boundary (`tests/cart.spec.ts` finds `e2e/tests/cart.spec.ts`).',
      },
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Comma-separated status categories to include: passed, failed, flaky, skipped, didnotrun',
      },
      {
        name: 'tags',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Comma-separated tags; a case must carry every one of them to match. A leading `@` is optional (`@smoke` and `smoke` are the same tag).',
      },
      {
        name: 'locks',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Comma-separated lock names; a case must carry every one of them to match.',
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
      {
        name: 'maxAgeDays',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 0, minimum: 0 },
        description:
          'Only include cases executed within the last N days, each counted over its executions of those days (0 = all time)',
      },
      {
        name: 'sort',
        in: 'query',
        required: false,
        schema: {
          type: 'string',
          enum: ['file', 'lastRun', 'title', 'totalRuns', 'passRate', 'avgDuration', 'status'],
          default: 'lastRun',
        },
        description:
          'Sort column. `file` is declaration order: file path, then the line and column of the latest execution.',
      },
      {
        name: 'dir',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        description: 'Sort direction',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');

  await requireProjectAccess(event, id);

  const db = await getDatabase();
  return getProjectTestCases(db, id, parseTestCasesQuery(getQuery(event)));
});

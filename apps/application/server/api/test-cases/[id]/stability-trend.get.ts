import { getTestCaseStabilityTrend, STABILITY_TREND_DEFAULT_DAYS } from '#shared/handlers/test-cases';
import { parseGranularity } from '#shared/analytics/period';
import { optionalIntQuery } from '../../../utils/query-params';
import { requireResolvedProjectAccess, requireRouteId, resolveCaseProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Stability trend for a test case',
    description:
      'Returns the pass rate, flaky rate and average duration of one test case in UTC time buckets over the last `days` days (probe runs left out), over its runs: one result per run, Playwright project and `--repeat-each` repetition. The pass rate is the passed runs over the runs that passed or failed, and the flaky rate the flaky runs (passed on a retry) over the same runs: both are null in a bucket without a passed or failed run. The Trend tab of the test page and the MCP `get_test_stability_trend` tool read it.',
    'x-required-permission': 'project:read',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'days', in: 'query', schema: { type: 'integer', default: 90, minimum: 1, maximum: 3650 } },
      {
        name: 'by',
        in: 'query',
        description: 'Bucket granularity: auto (about 31 buckets), day, week or month.',
        schema: { type: 'string', enum: ['auto', 'day', 'week', 'month'], default: 'auto' },
      },
    ],
  },
});

export default eventHandler(async (event) => {
  const testCaseId = requireRouteId(event, 'id', 'test case ID');
  const { db } = await requireResolvedProjectAccess(event, testCaseId, resolveCaseProjectId, 'Test case');

  const days = optionalIntQuery(event, 'days', { default: STABILITY_TREND_DEFAULT_DAYS });
  const by = getQuery(event).by;
  const granularity = parseGranularity(typeof by === 'string' ? by : null) ?? 'auto';

  try {
    return await getTestCaseStabilityTrend(db, testCaseId, { days, granularity });
  } catch (err) {
    if (err instanceof Error && err.message === 'Test case not found') {
      throw apiError({ statusCode: 404, message: 'Test case not found' });
    }
    throw err;
  }
});

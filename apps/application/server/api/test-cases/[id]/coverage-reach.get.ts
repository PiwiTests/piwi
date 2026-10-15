import { CoverageInsightInputError, getCoverageReach } from '#shared/handlers/coverage-insights';
import { parseCoverageReachQuery } from '#shared/coverage-insights';
import { requireResolvedProjectAccess, requireRouteId, resolveCaseProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Get which target lines of a file a test ran (coverage reach)',
    description:
      'Reads the coverage of one execution of the test (`executionId`, else its latest execution with coverage outside lab runs) and tells, of the target `lines` of `file`, which `ran`, which did not (`notRan`, only from a complete capture) and which the capture cannot tell (`unknown`: at file granularity, or not recorded by an incomplete capture). `reachedFile` says whether the coverage names the file; `path`, `runtime` and `blob` are the covered file the target matched and the version its line numbers refer to; `granularity` is `lines`, `functions` (a line ran when a function around it ran) or `files`. `notExecutable` lists the target lines the run’s executable lines for that version leave out (blank lines, comments), when a run recorded them; `allRan` is true when every other target line ran. When a target line did not run, `nearest` names the test running most of the function around the first target line at that version (else of the target lines; else, at another version, of the file), with the `function`, its `executedLines`, the target lines it ran (`ranTarget`) and `sameVersion`: the test to copy. `available` is false with `reason` `no-coverage` when the execution has no coverage.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test case id' },
      {
        name: 'file',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Repository-relative path, or a path suffix.',
      },
      {
        name: 'lines',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Target lines, 1-based, as ranges: `57-59,63` (at most 100 ranges).',
      },
      {
        name: 'executionId',
        in: 'query',
        required: false,
        schema: { type: 'integer' },
        description: 'An execution of the test to read; its latest execution with coverage when absent.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const testCaseId = requireRouteId(event, 'id', 'test case ID');
  const { db } = await requireResolvedProjectAccess(event, testCaseId, resolveCaseProjectId, 'Test case');
  const query = parseCoverageReachQuery(getQuery(event));
  if ('error' in query) throw apiError({ statusCode: 400, message: query.error });
  try {
    const answer = await getCoverageReach(db, testCaseId, query);
    if (!answer) throw apiError({ statusCode: 404, message: 'Test case not found' });
    return answer;
  } catch (error) {
    if (error instanceof CoverageInsightInputError) throw apiError({ statusCode: 400, message: error.message });
    throw error;
  }
});

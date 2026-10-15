import { getPathVariation } from '#shared/handlers/coverage-insights';
import { requireResolvedProjectAccess, requireRouteId, resolveCaseProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Get how a test’s coverage varies across its recent runs, and the earlier test that predicts it',
    description:
      'Compares the coverage of the test’s latest executions with coverage (non-lab runs; at most 30, of the Playwright project with most of the last 60; incomplete captures left out, counted in `executions.incomplete`), on the files every execution that ran them ran at the same version (`files.changedVersion` counts the others): at line granularity when each recorded lines, else function granularity, else whether the file ran. `varying` groups the code that ran in some executions only by the executions that ran it, most evenly split first (at most 10, `moreVarying` counting the rest): `ranIn` and `failedIn` of `executions.compared`, its `lines` and `functions`, the `files` (at most 10 each, 20 ranges per file) and `examples` of executions that ran it and that did not. `explanation` names the earlier test whose having run before best predicts a group (`varying`, its position): `earlier-in-run` when it finished earlier in the same run before the execution started, `earlier-on-worker` when it did on the same worker and shard; `effect` `runs-code` or `prevents-code`; `agreement`, the share of the executions with a start time it predicts, at least 0.9, with at least 3 executions on each side of the group and of the test (`before`, `notBefore`). `failuresFollow` says when at least 2 failing executions, 90% of them, fall on one side of a group, and `orderDependent` when they follow the explained group, the evidence flaky classification reads as the `order` root cause. `available` is false with a `reason`: `no-coverage` or `too-few-executions` (fewer than 2 complete captures). Nothing is stored: computed on each read.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test case id' }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const testCaseId = requireRouteId(event, 'id', 'test case ID');
  const { db } = await requireResolvedProjectAccess(event, testCaseId, resolveCaseProjectId, 'Test case');
  const answer = await getPathVariation(db, testCaseId);
  if (!answer) throw apiError({ statusCode: 404, message: 'Test case not found' });
  return answer;
});

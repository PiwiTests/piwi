import { getDatabase } from '../../../database';
import { getCoverageLoss } from '#shared/handlers/coverage-insights';
import { parseLossTestIds } from '#shared/coverage-insights';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Get the code only some tests run (what quarantining, skipping or deleting them leaves uncovered)',
    description:
      'Reads the latest coverage of the given tests on the project’s default branch and, per file and version (runtime, repository-relative path, git `blob`), the lines and functions no other trusted test runs there. Trusted means not quarantined; the given tests are left out of the others. Each of the `files` (at most 100, the worst first) has a `status`: `only-these` (no other trusted test runs the file), `only-flaky` (the only other trusted tests running it are flaky: a flaky root cause is recorded for them), `partial` (other tests run the file, not every line: `lines` and `functions` no other trusted test runs, `onlyFlakyLines` and `onlyFlakyFunctions` only flaky ones run besides the given tests) or `uncertain` (the other tests recorded the file only at another version or without ranges, so no line is claimed); `otherTests` counts the other trusted tests running the file at any version, `steady` and `flaky`. Ranges are 1-based and inclusive, at most 20 per list (`moreRanges` counts the rest). `summary` counts every file and line; `filesCovered` the files every line of which another steady test runs. `tests` says of each given test whether it is quarantined and has coverage; `unknownTestIds` lists ids that are no test of the project. `available` is false with `reason` `no-coverage` when none of the tests has coverage on the default branch.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'tests',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Test case ids, comma-separated: `12,15,40` (1 to 50).',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const tests = parseLossTestIds(getQuery(event).tests);
  if (!tests) throw apiError({ statusCode: 400, message: 'tests must list 1 to 50 test case ids, such as 12,15,40' });
  const answer = await getCoverageLoss(await getDatabase(), id, tests);
  if (!answer) throw apiError({ statusCode: 404, message: 'None of these tests is in the project' });
  return answer;
});

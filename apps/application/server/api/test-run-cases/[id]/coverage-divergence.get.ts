import { getCoverageDivergence } from '#shared/handlers/coverage-insights';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary:
      'Get the code a failing execution ran that the test’s last passing execution did not (coverage divergence)',
    description:
      'Compares the coverage of a failed or timed-out execution with the test’s latest passing execution with coverage that started before it (`baseline`: the same Playwright project on the same branch first, then the same project on the default branch, then any project on the same branch, then any on the default branch; among the newest three of that tier, a complete capture first), per runtime and repository-relative path. Each of the `files` (at most 50: `only-here` files first, then `diverged`, `only-baseline` and `changed`) has a `status`: `only-here` (only the failing execution ran it), `only-baseline`, `diverged` (both ran the same version, the git `blob`, not the same lines or functions: `linesOnlyHere`, `linesOnlyBaseline`, `functionsOnlyHere`, `functionsOnlyBaseline`, at most 20 ranges each, `moreRanges` counting the rest) or `changed` (different versions, `blob` and `baselineBlob`, not compared line by line). Ranges are 1-based and inclusive. An incomplete capture never yields a claim that something did not run: `incomplete` says which side was, and the claims needing it are left out. `summary` counts every file and line before the caps. `available` is false with a `reason`: `not-failing`, `no-coverage`, `no-baseline` (no earlier passing execution with coverage), or `incomplete` (both captures are).',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');
  const answer = await getCoverageDivergence(db, id);
  if (!answer) throw apiError({ statusCode: 404, message: 'Test run case not found' });
  return answer;
});

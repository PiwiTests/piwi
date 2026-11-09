import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getGapCode, parseCoverageSummaryQuery } from '../../../../utils/coverage-summary';
import { parseGapIds } from '#shared/gap-ids';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: 'The code behind scenario gaps',
    description:
      'For each of the gaps `ids` names (at most 200), the repository files behind it, each with its lines in the project’s combined coverage at one commit: `executableLines`, `executedLines` and `unrunLines` (executable lines no suite ran, the undetermined ones not counted). A gap on a file or a route handler is about that file; a gap on a route, about the handlers that serve it. A file the commit’s coverage does not hold is left out, and so is a gap with no file left. Without `commit`, the newest commit with coverage on `branch` (the default branch when absent). Answers 404 when there is no coverage, or only the commit’s totals are kept.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'ids',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Gap ids, comma-separated',
      },
      { name: 'commit', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'branch', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);
  const query = getQuery(event);
  const ids = parseGapIds(query.ids);
  if ('error' in ids) throw apiError({ statusCode: 400, message: ids.error });
  const parsed = parseCoverageSummaryQuery(query.commit, query.branch, undefined);
  if ('error' in parsed) throw apiError({ statusCode: 400, message: parsed.error });
  const code = await getGapCode(await getDatabase(), projectId, ids, parsed);
  if (!code) throw apiError({ statusCode: 404, message: 'No coverage for this commit' });
  return code;
});

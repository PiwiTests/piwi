import { getDatabase } from '../../../database';
import { getCoverageTree, parseCoverageSummaryQuery } from '../../../utils/coverage-summary';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Coverage'],
    summary: 'Get one level of a commit’s coverage tree',
    description:
      'The children of `folder` (the repository root when absent) in the project’s combined coverage at one commit, for a tree read one folder at a time: folders first, then files, by path. Each entry gives its `path`, its `kind` (`folder` or `file`), the counts the summary gives (`executableLines`, `executedLines`, `undeterminedLines`, `unitOnlyLines`, `e2eOnlyLines`, `bothLines`, functions and `files`) with their ratios, `unrunLines` (executable lines no suite ran, the undetermined ones not counted) and `filesWithoutData` (tracked files in scope under it that no suite names). A file no suite names is an entry of its own with `noData` true. With `area`, one of the project’s named areas, only its files count. Without `commit`, the newest commit with coverage on `branch` (the default branch when absent). Answers 404 when there is none.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'commit', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'branch', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'folder', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'area', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const query = getQuery(event);
  const parsed = parseCoverageSummaryQuery(query.commit, query.branch, query.folder, undefined, query.area);
  if ('error' in parsed) throw apiError({ statusCode: 400, message: parsed.error });
  const tree = await getCoverageTree(await getDatabase(), id, parsed);
  if (!tree) throw apiError({ statusCode: 404, message: 'No coverage for this commit' });
  return tree;
});

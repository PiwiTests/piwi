import { getDatabase } from '../../../database';
import { getCoverageSummary, parseCoverageSummaryQuery } from '../../../utils/coverage-summary';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Coverage'],
    summary: 'Get combined coverage of a commit',
    description:
      'The project’s combined coverage at one commit: every suite that ran the code (the uploaded reports, and `e2e`, the run coverage of the commit’s complete Playwright runs) counted on one set of executable lines per file version, the span table’s when a run recorded it, else the reports’. `totals` and each of `suites` give `executableLines`, `executedLines`, `undeterminedLines` (unrun lines inside functions a suite recording functions only ran: shown beside the ratio, never in it), `knownFunctions`, `runFunctions`, the `files` counted, the lines only unit suites ran (`unitOnlyLines`), only end-to-end suites (`e2eOnlyLines`) and both (`bothLines`), with `linePercent`, `functionPercent` and `undeterminedPercent`. A suite the commit lacks is carried forward from its newest earlier coverage, file by file where the file version is unchanged (`carriedFrom`, `carriedFiles`). `filesWithoutData` counts the files of the commit’s inventory in scope that no suite names (null without an inventory) and lists up to 100. `entries` breaks `folder` down into its direct children, and `leastCovered` lists the folder’s files with the most lines no suite ran (`unrunLines`, undetermined lines not counted), the most first, at most 20. With `file`, `file` gives that file’s `executable` and `executed` lines, their `classes` (`unitOnly`, `e2eOnly`, `both`, `none`, `undetermined`), the lines each suite ran (`bySuite`) and its functions; null when no suite names it. Without `commit`, the newest commit with coverage on `branch` (the default branch when absent). Answers 404 when there is none.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'commit', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'branch', in: 'query', required: false, schema: { type: 'string' } },
      {
        name: 'folder',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'The repository-relative folder to break down; the repository root when absent.',
      },
      {
        name: 'file',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'A repository-relative file whose lines to add.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const query = getQuery(event);
  const parsed = parseCoverageSummaryQuery(query.commit, query.branch, query.folder, query.file);
  if ('error' in parsed) throw apiError({ statusCode: 400, message: parsed.error });
  const summary = await getCoverageSummary(await getDatabase(), id, parsed);
  if (!summary) throw apiError({ statusCode: 404, message: 'No coverage for this commit' });
  return summary;
});

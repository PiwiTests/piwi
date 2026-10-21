import { getDatabase } from '../../../database';
import { getCoverageSummary, parseCoverageSummaryQuery } from '../../../utils/coverage-summary';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Coverage'],
    summary: 'Get combined coverage of a commit',
    description:
      'The project’s combined coverage at one commit: every suite that ran the code (the uploaded reports, and `e2e`, the run coverage of the commit’s complete Playwright runs) counted on one set of executable lines per file version, the span table’s when a run recorded it, else the reports’. `totals` and each of `suites` give `executableLines`, `executedLines`, `undeterminedLines` (unrun lines inside functions a suite recording functions only ran: shown beside the ratio, never in it), `knownFunctions`, `runFunctions`, the `files` counted, the lines only unit suites ran (`unitOnlyLines`), only end-to-end suites (`e2eOnlyLines`) and both (`bothLines`), with `linePercent`, `functionPercent` and `undeterminedPercent`. A suite the commit lacks is carried forward from the newest commit whose coverage arrived before the commit’s, on its branch then on the default branch, file by file where the file version is unchanged (`carriedFrom`, `carriedFiles`). `filesWithoutData` counts the files of the commit’s inventory in scope that no suite names (null without an inventory) and lists up to 100. `entries` breaks `folder` down into its direct children, `areas` gives each of the project’s named areas (its `coverageAreas`: a file belongs to the first whose patterns match it) with its totals and each suite’s share of its lines, and `leastCovered` lists the folder’s files with the most lines no suite ran (`unrunLines`, undetermined lines not counted), the most first, at most 20. With `file`, `file` gives that file’s `executable` and `executed` lines, their `classes` (`unitOnly`, `e2eOnly`, `both`, `none`, `undetermined`), the lines each suite ran (`bySuite`) and its functions; null when no suite names it. `notes` lists what the numbers leave out or take from elsewhere, each with its `kind`: `detail-removed` (only the commit’s totals are kept), `carried` (`suite`, `from`, `files`), `incomplete` (`suite`: its report was cut at a cap, or its files disagreed with the checkout; for `e2e`, every run it counts has incomplete server coverage), `missing-suite` (`suite`: a suite the project knows on the branch or the default branch that the commit has neither itself nor carried), `no-inventory` (files no suite names are not counted), `scope-changed` (totals computed under an earlier coverage scope or areas) `runs-not-counted` (the commit’s `partial` and `lab` runs with run coverage, which do not count) and `runs-incomplete` (the commit’s counted `runs` whose server coverage is incomplete, each with its `reasons`, `restarted` or `unreachable`, and `restartedAt`, and how many `completeRuns` count beside them: they join the `e2e` union, which reads as incomplete when no complete run is beside them). Off the default branch, per suite only the report of the commit whose coverage arrived last is kept; a commit that lost its reports keeps its totals, final, and answers from them: `detailRemoved` gives when and `supersededBy`, the newer commit, with `totals`, `suites`, `areas` and the count of `filesWithoutData` as computed, and empty `entries`, `leastCovered` and `file`. Without `commit`, the newest commit with coverage on `branch` (the default branch when absent). Answers 404 when there is none.',
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
      {
        name: 'area',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'One of the project’s named areas: `entries`, `leastCovered` and the files without data keep to its files.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const query = getQuery(event);
  const parsed = parseCoverageSummaryQuery(query.commit, query.branch, query.folder, query.file, query.area);
  if ('error' in parsed) throw apiError({ statusCode: 400, message: parsed.error });
  const summary = await getCoverageSummary(await getDatabase(), id, parsed);
  if (!summary) throw apiError({ statusCode: 404, message: 'No coverage for this commit' });
  return summary;
});

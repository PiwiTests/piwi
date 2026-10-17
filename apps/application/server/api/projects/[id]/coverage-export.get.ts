import { getDatabase } from '../../../database';
import {
  exportCommitCoverage,
  parseCoverageExportFormat,
  parseCoverageSummaryQuery,
} from '../../../utils/coverage-summary';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Coverage'],
    summary: 'Export combined coverage of a commit as LCOV or Cobertura',
    description:
      'The project’s combined coverage at one commit, as another tool reads it (Sonar, Codecov, an IDE): `format=lcov` (the default) for an LCOV tracefile, `format=cobertura` for a Cobertura report. Each file is repository-relative, with its reference lines (the lines the combined coverage counts) at 1 hit when any suite ran them and 0 when none did, an undetermined line included, and its functions, named by their lines (`lines_12_18`), at 1 hit when a suite ran them. Piwi keeps no hit counts and no branches, so none are written. Without `commit`, the newest commit with coverage on `branch` (the default branch when absent). Sent as an attachment named after the commit. Answers 404 when there is no coverage, and 410 for a commit whose file detail was removed, a newer commit having superseded it.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'commit', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'branch', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['lcov', 'cobertura'] } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const query = getQuery(event);
  const parsed = parseCoverageSummaryQuery(query.commit, query.branch, undefined);
  if ('error' in parsed) throw apiError({ statusCode: 400, message: parsed.error });
  const format = parseCoverageExportFormat(query.format);
  if (typeof format !== 'string') throw apiError({ statusCode: 400, message: format.error });
  const exported = await exportCommitCoverage(await getDatabase(), id, parsed, format);
  if (!exported) throw apiError({ statusCode: 404, message: 'No coverage for this commit' });
  if ('gone' in exported) throw apiError({ statusCode: 410, message: exported.message });
  setResponseHeader(event, 'Content-Type', exported.contentType);
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${exported.filename}"`);
  return exported.body;
});

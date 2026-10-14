import { getRunCoverage } from '../../../utils/coverage';
import { optionalIntQuery } from '../../../utils/query-params';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Get a run’s coverage',
    description:
      'The coverage of the whole run, attributed to no test, as `PUT /api/test-runs/{id}/coverage` stored it: `files`, one entry per repository-relative `path` and `runtime` (`browser` or `server`), sorted by path then runtime, with the git `blob` its line numbers refer to, the `functions` and executed `lines` that ran and, for server files, the `executable` lines (1-based inclusive ranges), so an executable line in no test’s coverage is one the run did not execute. `file` keeps the files whose path is it or ends with it; `limit` caps how many are returned (0 returns none). `fileCounts` counts the run’s files per runtime and `executionsWithCoverage` the run’s executions that recorded coverage of their own, whatever `file` and `limit` keep.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'file',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Repository-relative path, or a path suffix.',
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0, maximum: 20000 },
        description: 'Files returned at most; every file when absent.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const raw = getQuery(event).file;
  const file = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  if (file && file.length > 500) throw apiError({ statusCode: 400, message: 'file is at most 500 characters' });
  const limit = optionalIntQuery(event, 'limit', { min: 0, max: 20_000 });
  const coverage = await getRunCoverage(db, id, { file, limit });
  if (!coverage) throw apiError({ statusCode: 404, message: 'Test run not found' });
  return coverage;
});

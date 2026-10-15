import { getDatabase } from '../../../database';
import { getFileCoverage } from '../../../utils/coverage';
import { sendJsonWithEtag } from '../../../utils/json-etag';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { parseLocatorBranchQuery } from '#shared/locator-usages.types';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Get the coverage of a source file',
    description:
      'The coverage the project’s tests recorded of one application source file on a branch: `fragments`, each distinct coverage of the file (its repository-relative `path`, `runtime` (`browser` or `server`), the git `blob` its line numbers refer to, the `functions` that ran and the executed `lines`, 1-based inclusive ranges) with `tests`, the positions in `tests` of the tests that recorded it; and `tests`, shaped as in the locator index, with their latest outcome on the branch. Each test’s latest run with coverage counts. `executable` gives, per version of the file the fragments name (`path`, `runtime`, `blob`), the executable `lines` the newest run’s coverage recorded (server files), so a line in them and in no fragment is one no test runs; a version no run recorded them for is absent. `file` matches a stored repository-relative path or a path suffix of it. Carries an `ETag`: a request whose `If-None-Match` names it is answered 304 without a body.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'file',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Repository-relative path, or a path suffix.',
      },
      {
        name: 'branch',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'The branch to read: per runtime, its tests’ own coverage where they ran on it with coverage, the default branch’s for the others. The default branch when absent.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const query = getQuery(event);
  const file = typeof query.file === 'string' ? query.file.trim() : '';
  if (!file || file.length > 500)
    throw apiError({ statusCode: 400, message: 'file is required (at most 500 characters)' });
  const branch = parseLocatorBranchQuery(query.branch);
  if ('error' in branch) throw apiError({ statusCode: 400, message: branch.error });
  return sendJsonWithEtag(event, await getFileCoverage(await getDatabase(), id, file, branch.branch));
});

import { getDatabase } from '../../../database';
import { getCodeReachForFile } from '../../../utils/code-reach';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { parseLocatorBranchQuery } from '#shared/locator-usages.types';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'List the tests that reach a source file',
    description:
      'The tests whose execution reached one application source file. Each test carries how: `runtime` (`browser` when the file’s code ran in the page, `server` when it ran in the backend) and `via` (`coverage` when the test’s coverage recorded the file, from the reporter’s opt-in `captureCodeReach` or coverage capture; `route` when the test called a route the Test Map knows is handled by that file), listed once with the first of browser coverage, server coverage and route that applies; `origin` names the same in two values, `client` for browser coverage and `server` for any server reach. `file` matches a stored repository-relative path or a path suffix of it. Each test carries its latest outcome on the branch. Observed reach, not line coverage.',
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
          'The branch to read: per runtime, its tests’ own reach where they ran on it, the default branch’s for the others. The default branch when absent.',
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
  return getCodeReachForFile(await getDatabase(), id, file, branch.branch);
});

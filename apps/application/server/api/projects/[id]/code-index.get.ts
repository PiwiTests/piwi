import { getDatabase } from '../../../database';
import { getCodeIndex } from '../../../utils/code-reach';
import { sendJsonWithEtag } from '../../../utils/json-etag';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { parseLocatorBranchQuery } from '#shared/locator-usages.types';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Download a project’s code index',
    description:
      'Every application source file the project’s tests reach, with the tests reaching it, for editors: `files` (repository-relative paths), `tests` (shaped as in the locator index, with their latest outcome) and `reach`, one entry per file and origin giving positions in `files` and `tests`. `client` reach comes from the reporter’s opt-in `captureCodeReach`; `server` reach from the Test Map’s routes and their handler files. Capped at 20000 files; `truncated` says when more exist. Carries an `ETag`: a request whose `If-None-Match` names it is answered 304 without a body.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'branch',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'The branch to describe; the default branch when absent.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const branch = parseLocatorBranchQuery(getQuery(event).branch);
  if ('error' in branch) throw apiError({ statusCode: 400, message: branch.error });
  return sendJsonWithEtag(event, await getCodeIndex(await getDatabase(), id, branch.branch));
});

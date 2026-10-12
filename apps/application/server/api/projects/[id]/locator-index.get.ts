import { getDatabase } from '../../../database';
import { sendJsonWithEtag } from '../../../utils/json-etag';
import { getLocatorIndex } from '../../../utils/locator-usages';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { parseLocatorBranchQuery } from '#shared/locator-usages.types';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Download a project’s locator index',
    description:
      'Returns every distinct locator chain the project’s tests used, the chains reaching the most tests first, each with the tests that use it and how (actions, call sites, Playwright projects). Tests carry their latest outcome, and `testIdAttributes` names the attributes `getByTestId` reads when a run reported Playwright’s `testIdAttribute`, and `viewports` the `use.viewport` of each Playwright project when a run reported them. The Piwi Picker browser extension evaluates these chains against a live page to show which elements are tested. Describes one branch (`branch`, the default branch when absent), and lists the branches with uses of their own. When runs used the capture fixtures, `pages` lists the page keys calls ran on (`/orders/:id`; a third-party page keeps its origin), and each use gives the positions of its pages in it, `arrival` those where a call ran before any locator interaction, and `pagesTruncated` when it was used on more than 50. Capped at 20000 chains; `truncated` says when more exist. Carries an `ETag`: a request whose `If-None-Match` names it is answered 304 without a body.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'branch',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'The branch to describe: its tests’ uses where they ran on it, the default branch’s for the others. `*` for every branch together; the default branch when absent.',
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

  const db = await getDatabase();
  const index = await getLocatorIndex(db, id, { branch: branch.branch });
  if (!index) throw apiError({ statusCode: 404, message: 'Project not found' });
  // `generatedAt` is the time of this answer: the same index is the same `ETag` whenever it is asked.
  return sendJsonWithEtag(event, index, ['generatedAt']);
});

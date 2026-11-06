import { getDatabase } from '../../database';
import { isAuthEnabled, requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { listProjectStars } from '#shared/handlers/project-stars';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'List the projects you starred',
    description:
      "The ids of the projects the caller starred, in the order they were starred: `{ projectIds }`. Starred projects lead the sidebar and Home's Project health; a star changes order only, never access. A starred project the caller can no longer read is left out, and comes back with the access. Never another user's, administrators included. With authentication off there is no user to keep a star on: the dashboard keeps the stars in the browser, and this route returns an empty list.",
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  if (!isAuthEnabled(event)) return { projectIds: [] as number[] };
  const db = await getDatabase();
  return listProjectStars(db, user.id, await getProjectScope(db, user));
});

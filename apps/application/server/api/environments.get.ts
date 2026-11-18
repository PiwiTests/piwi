import { listInstanceEnvironments } from '#shared/handlers/environments';
import { requireAuth } from '../utils/auth';
import { getProjectScope } from '../utils/project-access';
import { getDatabase } from '../database';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'List the environments of every project you can read',
    description:
      'One entry per environment key, ignoring case, across the projects the caller can read, archived environments left out: `{ environments: [{ key, names, projects }] }`, with the names the projects give that key and how many have it. What the pickers that span projects offer (Analytics, dashboards, quality reports, a notification filter on every project), since they name an environment by key; `GET /api/projects/:id/environments` lists one project’s.',
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  return { environments: await listInstanceEnvironments(db, await getProjectScope(db, user as any)) };
});

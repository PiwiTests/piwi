import { apiError } from '../../../../utils/api-error';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { createTracker } from '../../../../utils/integrations/connections';
import { requireConnectionAccess } from '../../../../utils/integrations/connection-access';
import { projectsCache } from '../../../../utils/integrations/picker-cache';
import { CONNECTION_NOT_FOUND } from '#shared/integrations/connection-access';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: "List a connection's tracker projects",
    description:
      'Projects available in the tracker, for the create-issue modal. Cached for five minutes. Requires `issue:create` on a project bound to the connection (Contributor and above), `project:manage` on any project (Project admin) or `connections:manage` (administrators); any other caller holding `issue:create` gets the 404 of a missing connection.',
    'x-required-permission': 'issue:create',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event);
  const db = await requireConnectionAccess(event, id);

  const cached = projectsCache.get(`${id}`);
  if (cached) return { projects: cached };

  const tracker = await createTracker(db, id);
  if (!tracker) throw apiError({ statusCode: 404, message: CONNECTION_NOT_FOUND });

  const projects = await tracker.listProjects();
  projectsCache.set(`${id}`, projects);
  return { projects };
});

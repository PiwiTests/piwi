import { apiError } from '../../../../../../../../utils/api-error';
import { requireAuth } from '../../../../../../../../utils/auth';
import { requireRouteId } from '../../../../../../../../utils/project-access';
import { requireConnectionAccess } from '../../../../../../../../utils/integrations/connection-access';
import { getCreateFields } from '../../../../../../../../utils/integrations/fields';
import { CONNECTION_NOT_FOUND } from '#shared/integrations/connection-access';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: "List the fields of an issue type's create screen",
    description:
      "The fields a tracker project's create screen has for an issue type (id or name), from Jira's create metadata: each with whether it is required, whether Jira fills a default, how its value is typed, and the values Jira lists for it. The binding form and the create modal use it to ask for the required fields Piwi does not fill. Cached for five minutes. Requires `issue:create` on a project bound to the connection (Contributor and above), `project:manage` on any project (Project admin) or `connections:manage` (administrators); to anyone else the connection answers 404, as a missing one does.",
    'x-required-permission': 'issue:create',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event);
  const db = await requireConnectionAccess(event, id);
  const key = getRouterParam(event, 'key');
  const type = getRouterParam(event, 'type');
  if (!key || !type) throw apiError({ statusCode: 400, message: 'project key and issue type are required' });

  const fields = await getCreateFields(db, id, decodeURIComponent(key), decodeURIComponent(type));
  if (!fields) throw apiError({ statusCode: 404, message: CONNECTION_NOT_FOUND });
  return { fields };
});

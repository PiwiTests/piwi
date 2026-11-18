import { z } from 'zod';
import { copyEnvironments } from '#shared/handlers/environments';
import { getDatabase } from '../../../../database';
import { can } from '#shared/permissions';
import { getRequestAccess } from '../../../../utils/auth';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "Copy another project's environments",
    description:
      'Body: `{ fromProjectId }`. Copies the declared environments of that project into this one, every field but its URL patterns, each copy independent of its source. An environment whose key or an alias this project already names is left as it is and listed in `skipped`, and so is a protected environment unless the caller manages the other project too. Needs `project:manage` on this project and `project:read` on the other.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

const bodySchema = z.object({ fromProjectId: z.number().int().positive() }).strict();

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const parsed = bodySchema.safeParse(await readBody(event));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  const { fromProjectId } = parsed.data;
  if (fromProjectId === id) throw apiError({ statusCode: 400, message: 'Pick another project to copy from' });
  const access = await getRequestAccess(event);
  if (!can(access, 'project:read', fromProjectId)) {
    throw apiError({ statusCode: 403, message: 'No access to the project to copy from' });
  }
  return copyEnvironments(await getDatabase(), fromProjectId, id, {
    canManageSource: can(access, 'project:manage', fromProjectId),
  });
});

import { getDatabase } from '../../../database';
import { listConnectedApps } from '#shared/handlers/users';
import { getRequestAccess, requireAuth } from '../../../utils/auth';
import { requireRouteId } from '../../../utils/project-access';
import { isRunTargetOnline } from '../../../utils/run-target-events';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'List the apps a user connected',
    description:
      'Returns the apps a user connected through the device flow (Piwi Picker, an editor, the desktop app, Piwi Runner), newest first: each `id` is its key’s, which `DELETE /api/users/{id}/api-keys/{keyId}` revokes to disconnect it. An app that runs tests has a `target`: its `id` (what `POST /api/run-requests` takes as `targetId`), platform, version, the projects it has a folder for (`projectIds`), when it was last seen, and `online`, whether it holds its request stream open and called the instance within the last two minutes. Anyone but an administrator can only list their own.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const currentUser = await requireAuth(event);
  const userId = requireRouteId(event, 'id', 'user ID');
  if (!can(await getRequestAccess(event), 'users:manage') && currentUser.id !== userId) {
    throw apiError({ statusCode: 403, message: 'Insufficient permissions' });
  }
  return {
    items: await listConnectedApps(await getDatabase(), userId, (targetId, lastSeenAt) =>
      isRunTargetOnline(targetId, lastSeenAt),
    ),
  };
});

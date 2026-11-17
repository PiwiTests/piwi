import { eq, and } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { notificationChannels } from '../../database/schema';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { isAdministrator } from '#shared/permissions';
import { requireRouteId } from '../../utils/project-access';
import { deleteCredentialIfUnused } from '#shared/handlers/credentials';
import { channelCredentialId } from '../../utils/notifications/slack-credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Delete a notification channel',
    description:
      'Deletes a channel and all associated subscriptions and deliveries. With `deleteCredential=true`, an administrator deleting a global Slack channel also deletes the credential it sent with, unless something else names it (`credentialDeleted` says whether it was).',
    'x-required-permission': 'signed-in',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'deleteCredential', in: 'query', required: false, schema: { type: 'boolean' } },
    ],
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'channel ID');

  const db = await getDatabase();
  const [channel] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id));
  if (!channel) throw apiError({ statusCode: 404, message: 'Channel not found' });

  const isAdmin = isAdministrator(await getRequestAccess(event));
  if (channel.type === 'personal_email') {
    throw apiError({
      statusCode: 400,
      message: 'Cannot delete your personal email channel. Remove your email in Account settings to disconnect it.',
    });
  }

  if (channel.userId !== user.id && !isAdmin) {
    throw apiError({ statusCode: 403, message: 'Not authorized to delete this channel' });
  }

  await db
    .delete(notificationChannels)
    .where(
      isAdmin
        ? eq(notificationChannels.id, id)
        : and(eq(notificationChannels.id, id), eq(notificationChannels.userId, user.id)),
    );
  const credentialId = channelCredentialId(channel.config as Record<string, unknown> | null);
  const credentialDeleted =
    isAdmin && credentialId != null && getQuery(event).deleteCredential === 'true'
      ? await deleteCredentialIfUnused(db, credentialId)
      : false;
  return { success: true, credentialDeleted };
});

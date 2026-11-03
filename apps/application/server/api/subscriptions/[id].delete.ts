import { eq, and } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { subscriptions } from '../../database/schema';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { isAdministrator } from '#shared/permissions';
import { requireRouteId } from '../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Delete a subscription',
    description: 'Deletes a subscription.',
    'x-required-permission': 'signed-in',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'subscription ID');

  const db = await getDatabase();
  const isAdmin = isAdministrator(await getRequestAccess(event));
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(isAdmin ? eq(subscriptions.id, id) : and(eq(subscriptions.id, id), eq(subscriptions.userId, user.id)));
  if (!sub) throw apiError({ statusCode: 404, message: 'Subscription not found' });

  await db.delete(subscriptions).where(eq(subscriptions.id, id));
  return { success: true };
});

import { eq, and, or, isNull } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { subscriptions, notificationChannels } from '../../database/schema';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { formatSubscription } from '../../utils/subscriptions';
import { NOTIFICATION_EVENTS } from '#shared/notification-events';
import { digestAtSchema, subscriptionFiltersSchema } from '#shared/subscription-filters';
import { isAdministrator } from '#shared/permissions';
import { z } from 'zod';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Update a subscription',
    description:
      'Updates events, filters, mode, muting, or active state. `filters` takes the same keys as when creating a subscription; `null` clears them.',
    'x-required-permission': 'signed-in',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

const schema = z.object({
  channelId: z.number().int().positive().optional(),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).max(NOTIFICATION_EVENTS.length).optional(),
  filters: subscriptionFiltersSchema.nullable().optional(),
  mode: z.enum(['realtime', 'digest']).optional(),
  digestAt: digestAtSchema.nullable().optional(),
  mutedUntil: z.string().datetime().nullable().optional(),
  active: z.boolean().optional(),
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = parseInt(getRouterParam(event, 'id') || '0');
  if (!id) throw apiError({ statusCode: 400, message: 'Invalid subscription ID' });

  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body' });

  const db = await getDatabase();
  const isAdmin = isAdministrator(await getRequestAccess(event));
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(isAdmin ? eq(subscriptions.id, id) : and(eq(subscriptions.id, id), eq(subscriptions.userId, user.id)));
  if (!sub) throw apiError({ statusCode: 404, message: 'Subscription not found' });

  const update: Record<string, unknown> = { updatedAt: new Date() };
  const d = parsed.data;

  if (d.channelId !== undefined) {
    // Ensure the target channel is owned by this user or is global
    const [ch] = await db
      .select({ id: notificationChannels.id, userId: notificationChannels.userId })
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.id, d.channelId),
          isAdmin ? undefined : or(isNull(notificationChannels.userId), eq(notificationChannels.userId, user.id)),
        ),
      );
    if (!ch) throw apiError({ statusCode: 404, message: 'Channel not found' });
    // A global subscription delivers with no per-user access check, so it must
    // stay on a global channel.
    if (sub.userId === null && ch.userId !== null) {
      throw apiError({ statusCode: 400, message: 'Global subscriptions require a global channel' });
    }
    update.channelId = d.channelId;
  }

  if (d.events !== undefined) update.events = d.events;
  if (d.filters !== undefined) update.filters = d.filters;
  if (d.mode !== undefined) update.mode = d.mode;
  if (d.digestAt !== undefined) update.digestAt = d.digestAt;
  if (d.mutedUntil !== undefined) update.mutedUntil = d.mutedUntil ? new Date(d.mutedUntil) : null;
  if (d.active !== undefined) update.active = d.active;

  await db.update(subscriptions).set(update).where(eq(subscriptions.id, id));

  const [updated] = await db
    .select({ sub: subscriptions, channel: notificationChannels })
    .from(subscriptions)
    .innerJoin(notificationChannels, eq(subscriptions.channelId, notificationChannels.id))
    .where(eq(subscriptions.id, id));

  return { success: true, subscription: formatSubscription(updated!.sub, updated!.channel) };
});

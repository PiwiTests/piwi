import { and, eq, or, isNull } from 'drizzle-orm';
import { subscriptions, notificationChannels, notificationDeliveries, users } from '../../database/schema';
import { getProjectScope, scopeAllows, type DrizzleDB } from '../project-access';
import {
  buildNotificationDedupeKey,
  passesSubscriptionFilters,
  type NotificationEvent,
  type NotificationPayload,
  type SubscriptionFilters,
} from '#shared/notification-events';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { isUniqueViolation } from '../db-errors';
import { emailDestinationVerified } from './email-verified';

function parseDigestHHMM(digestAt: string | null | undefined): { hour: number; minute: number } | null {
  if (!digestAt) return null;
  const match = digestAt.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return { hour: parseInt(match[1]!), minute: parseInt(match[2]!) };
}

function nextDigestTime(digestAt: string): Date {
  const parsed = parseDigestHHMM(digestAt);
  if (!parsed) return new Date(Date.now() + 24 * 60 * 60 * 1000);
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), parsed.hour, parsed.minute, 0, 0),
  );
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * For a given event+payload, find matching subscriptions and enqueue delivery rows.
 * Idempotent through the unique `dedupeKey`: a delivery already queued is left
 * alone. Any other failed insert is thrown once every other subscription has
 * its row, so a notification is never dropped in silence.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function matchAndEnqueue(
  db: LibSQLDatabase<any>,
  event: NotificationEvent,
  payload: NotificationPayload,
): Promise<number> {
  const projectId = (payload as { projectId: number }).projectId;

  const rows = await db
    .select({ sub: subscriptions, channel: notificationChannels })
    .from(subscriptions)
    .innerJoin(notificationChannels, eq(subscriptions.channelId, notificationChannels.id))
    .where(
      and(eq(subscriptions.active, true), or(isNull(subscriptions.projectId), eq(subscriptions.projectId, projectId))),
    );

  let enqueued = 0;
  let insertError: unknown = null;
  const now = new Date();

  // Re-check project access at delivery time so a subscription never leaks a
  // project its subscriber, or the owner of its personal channel, cannot reach,
  // including one the user was removed from after subscribing.
  const accessByUser = new Map<number, boolean>();
  const userCanAccess = async (userId: number): Promise<boolean> => {
    const cached = accessByUser.get(userId);
    if (cached !== undefined) return cached;
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    const allowed = u ? scopeAllows(await getProjectScope(db as unknown as DrizzleDB, u), projectId) : false;
    accessByUser.set(userId, allowed);
    return allowed;
  };

  for (const { sub, channel } of rows) {
    // Global subscriptions (userId null) are admin-managed and span every
    // project; per-user subscriptions re-check the subscriber's access, and a
    // personal channel its owner's.
    if (sub.userId != null && !(await userCanAccess(sub.userId))) continue;
    if (channel.userId != null && !(await userCanAccess(channel.userId))) continue;

    // Email goes only to an address its owner proved they hold.
    if (!(await emailDestinationVerified(db, channel))) continue;

    // Check event is subscribed
    const events = (sub.events as string[] | null) ?? [];
    if (!events.includes(event)) continue;

    // Check mute
    if (sub.mutedUntil && new Date(sub.mutedUntil) > now) continue;

    // Check filters
    const filters = sub.filters as SubscriptionFilters | null;
    if (!passesSubscriptionFilters(filters, event, payload)) continue;

    const dedupeKey = buildNotificationDedupeKey(event, payload, channel.id);
    const scheduledFor = sub.mode === 'digest' && sub.digestAt ? nextDigestTime(sub.digestAt) : now;

    try {
      await db.insert(notificationDeliveries).values({
        subscriptionId: sub.id,
        channelId: channel.id,
        event,
        payload: payload as unknown as Record<string, unknown>,
        dedupeKey,
        status: 'pending',
        scheduledFor,
        createdAt: now,
      });
      enqueued++;
    } catch (error) {
      // The unique dedupe key: this event already has its delivery on this channel.
      if (!isUniqueViolation(error)) insertError ??= error;
    }
  }

  if (insertError) throw insertError;
  return enqueued;
}

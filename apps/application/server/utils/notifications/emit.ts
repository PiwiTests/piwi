import { matchAndEnqueue } from './match';
import { sweepOutbox } from './dispatch';
import { runEventBus } from '../run-events';
import type { NotificationEvent, NotificationPayload } from '#shared/notification-events';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

/**
 * Entry point: publish to the SSE notification bus for any open browser tabs,
 * then match subscriptions for the event, enqueue outbox deliveries, and
 * kick the sweeper for realtime deliveries (email/Slack/webhook).
 *
 * The SSE bus publishes regardless of auth — when auth is off, client-side
 * cookie preferences gate which events trigger browser notifications. The
 * outbox path works in both modes: with auth off every channel and
 * subscription is global (userId null), so no per-user access check applies.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function emitNotification(
  db: LibSQLDatabase<any>,
  event: NotificationEvent,
  payload: NotificationPayload,
  opts?: {
    /**
     * Deliver the browser (SSE) notification to this user even when they have no
     * matching subscription — per-user targeting for events addressed at one
     * person, such as the author of a fix — as long as they can open the event's
     * project. Normal subscription routing is unaffected: other subscribers still
     * receive the event, and the outbox (email/Slack/webhook) is untouched by
     * this flag.
     */
    targetUserId?: number;
  },
): Promise<void> {
  runEventBus.publishNotification({
    type: event,
    ...payload,
    ...(opts?.targetUserId != null ? { targetUserId: opts.targetUserId } : {}),
  });

  try {
    const enqueued = await matchAndEnqueue(db, event, payload);
    if (enqueued > 0) {
      // Best-effort immediate delivery; sweeper handles failures/retries
      sweepOutbox(db).catch((e) => console.error('[notifications] sweep after emit failed', e));
    }
  } catch (e) {
    console.error('[notifications] emitNotification failed', e);
  }
}

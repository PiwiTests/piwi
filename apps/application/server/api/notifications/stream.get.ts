import { eq, and, or, isNull } from 'drizzle-orm';
import { requireAuth, isAuthEnabled } from '../../utils/auth';
import { getProjectScope, scopeAllows } from '../../utils/project-access';
import { runEventBus } from '../../utils/run-events';
import { createSSEEndpoint } from '../../utils/sse';
import { getDatabase } from '../../database';
import { notificationChannels, subscriptions } from '../../database/schema';
import {
  REPORT_READY_EVENT,
  passesSubscriptionFilters,
  type NotificationEvent,
  type NotificationPayload,
  type SubscriptionFilters,
} from '#shared/notification-events';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Notification event stream',
    description:
      "Server-sent events stream (text/event-stream) of the signed-in user's browser notifications, filtered to their subscriptions and project scope.",
    'x-required-permission': 'project:read',
  },
});

/** How often a connection re-checks its caller and reloads their project scope and browser subscriptions. */
const REFRESH_INTERVAL_MS = 60_000;

/** Whether `error` is requireAuth refusing the caller: a revoked session, a deleted user or API key. */
function isAuthRefusal(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return statusCode === 401 || statusCode === 403;
}

interface BrowserSubscription {
  events: string[];
  projectId: number | null;
  mutedUntil: Date | null;
  filters: SubscriptionFilters | null;
}

export default eventHandler(async (event) => {
  const user = await requireAuth(event);

  // With auth disabled the instance is single-user, so there is no cross-project
  // boundary to enforce — stream every notification; the client's cookie
  // preferences gate which events raise browser notifications.
  if (!isAuthEnabled()) {
    return createSSEEndpoint(event, (controller, encoder) =>
      runEventBus.subscribeNotifications((notificationEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(notificationEvent)}\n\n`));
        } catch {
          // Stream closed — unsubscribe is handled by SSE helper
        }
      }),
    );
  }

  const db = await getDatabase();

  // The user's active browser-channel subscriptions (own + global) decide which
  // events this connection streams.
  const loadSubscriptions = async (): Promise<BrowserSubscription[]> => {
    const rows = await db
      .select({
        events: subscriptions.events,
        projectId: subscriptions.projectId,
        mutedUntil: subscriptions.mutedUntil,
        filters: subscriptions.filters,
      })
      .from(subscriptions)
      .innerJoin(notificationChannels, eq(subscriptions.channelId, notificationChannels.id))
      .where(
        and(
          eq(notificationChannels.type, 'browser'),
          eq(subscriptions.active, true),
          or(isNull(subscriptions.userId), eq(subscriptions.userId, user.id)),
        ),
      );
    return rows.map((r) => ({
      events: (r.events as string[] | null) ?? [],
      projectId: r.projectId,
      mutedUntil: r.mutedUntil,
      filters: r.filters as SubscriptionFilters | null,
    }));
  };

  // No early close on an empty subscription set: an event can still be targeted
  // at this user by id (e.g. cluster.fixed to the author of the fix), and that
  // must reach them even with nothing subscribed. Such a connection stays quiet
  // until an event is addressed to them.
  let subs = await loadSubscriptions();

  // Never stream an event for a project the caller cannot access. The scope is
  // reloaded with the subscriptions on every refresh.
  let scope = await getProjectScope(db, user);

  const matchesSubscription = (type: string, projectId: number, payload: Record<string, unknown>): boolean => {
    const now = new Date();
    return subs.some(
      (s) =>
        s.events.includes(type) &&
        (s.projectId == null || s.projectId === projectId) &&
        (!s.mutedUntil || s.mutedUntil <= now) &&
        passesSubscriptionFilters(s.filters, type as NotificationEvent, payload as unknown as NotificationPayload),
    );
  };

  return createSSEEndpoint(event, (controller, encoder) => {
    // Re-check the caller and reload their scope and subscriptions on a timer, so
    // role, event and mute changes apply to a long-lived connection without a
    // reconnect, and the stream ends once its session or API key stops working.
    // A failed reload for any other reason keeps the last snapshot.
    const refresh = setInterval(() => {
      requireAuth(event)
        .then(async (current) => {
          const [nextScope, nextSubs] = await Promise.all([getProjectScope(db, current), loadSubscriptions()]);
          scope = nextScope;
          subs = nextSubs;
        })
        .catch((error) => {
          if (isAuthRefusal(error)) stop();
        });
    }, REFRESH_INTERVAL_MS);

    const unsubscribe = runEventBus.subscribeNotifications((notificationEvent) => {
      const projectId = notificationEvent.projectId as number | undefined;
      if (typeof projectId === 'number' && !scopeAllows(scope, projectId)) return;

      // A targeted event (e.g. cluster.fixed addressed at the author of the fix)
      // is delivered to that one user regardless of their subscriptions; every
      // other connection falls back to normal subscription matching.
      const targetUserId = notificationEvent.targetUserId as number | undefined;
      const targetedAtMe = typeof targetUserId === 'number' && targetUserId === user.id;

      const type = notificationEvent.type as string | undefined;
      // A quality report goes to its personal channel's owner, or, from a global
      // channel, to whoever can open every project it covers.
      if (type === REPORT_READY_EVENT) {
        const covered = (notificationEvent.projectIds as number[] | undefined) ?? [];
        const allowed = typeof targetUserId === 'number' ? targetedAtMe : covered.every((id) => scopeAllows(scope, id));
        if (!allowed) return;
      } else if (
        !targetedAtMe &&
        typeof projectId === 'number' &&
        type &&
        !matchesSubscription(type, projectId, notificationEvent)
      )
        return;

      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(notificationEvent)}\n\n`));
      } catch {
        // Stream closed — unsubscribe is handled by SSE helper
      }
    });

    function stop() {
      clearInterval(refresh);
      unsubscribe();
      try {
        controller.close();
      } catch {
        // Already closed
      }
    }
    return stop;
  });
});

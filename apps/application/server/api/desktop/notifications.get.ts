// Desktop-only: the notifications the desktop shell shows, rendered from the
// notification events. The shell follows this stream for as long as the app
// runs, so a notification does not depend on the dashboard page being loaded.
// Responds 404 on the normal server build.
import { requireAuth } from '../../utils/auth';
import { getDatabase } from '../../database';
import { getProjectScope } from '../../utils/project-access';
import { opensEveryProject } from '../../utils/notifications/event-scope';
import { apiError } from '../../utils/api-error';
import { runEventBus } from '../../utils/run-events';
import { createSSEEndpoint } from '../../utils/sse';
import { desktopNotification } from '../../utils/desktop-notifications';
import type { NotificationEventData } from '#shared/notifications/browser-message';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Notifications the desktop shell shows (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Server-sent events (text/event-stream): one `{ type, projectId, title, body, path, defaultOn }` message per notification event that shows a notification, with the dashboard page a click opens (`path`) and whether a project whose events nobody chose notifies on it (`defaultOn`). A run the app started itself is left out: its window notifies on it. Scoped to the projects the caller can open, as the notification stream is. The shell applies the notification choices the dashboard window gives it.',
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  const user = await requireAuth(event);
  const scope = await getProjectScope(await getDatabase(), user);

  return createSSEEndpoint(event, (controller, encoder) =>
    runEventBus.subscribeNotifications((notificationEvent) => {
      if (!opensEveryProject(scope, notificationEvent)) return;
      const notification = desktopNotification(notificationEvent as unknown as NotificationEventData);
      if (!notification) return;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(notification)}\n\n`));
      } catch {
        // Stream closed — the SSE helper handles unsubscribe.
      }
    }),
  );
});

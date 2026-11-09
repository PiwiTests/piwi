import { DEFAULT_SUBSCRIPTION_EVENTS, isDesktopAppRunEvent } from '#shared/notification-events';
import {
  NOTIFICATION_MESSAGE_TITLE,
  notificationMessageBody,
  notificationMessagePath,
  type NotificationEventData,
} from '#shared/notifications/browser-message';

/**
 * A notification the desktop shell shows, as `GET /api/desktop/notifications` sends it. The shell applies the choices
 * the dashboard window gives it (`desktop_set_notification_choices`): a project's bell picks its events, and a project
 * with no choice notifies on the events marked `defaultOn`.
 */
export interface DesktopNotification {
  type: string;
  projectId: number | null;
  title: string;
  body: string;
  /** The dashboard page a click opens. */
  path: string | null;
  /** Whether a project whose events nobody chose notifies on this one (`DEFAULT_SUBSCRIPTION_EVENTS`). */
  defaultOn: boolean;
}

/**
 * The notification the desktop shell shows for a notification event, `null` for one it shows none for: an event with
 * no text, and a run the app started itself, which the window's own notification covers (`isDesktopAppRunEvent`).
 */
export function desktopNotification(event: NotificationEventData): DesktopNotification | null {
  if (isDesktopAppRunEvent(event.type, event.origin)) return null;
  const body = notificationMessageBody(event);
  if (!body) return null;
  return {
    type: event.type,
    projectId: typeof event.projectId === 'number' ? event.projectId : null,
    title: NOTIFICATION_MESSAGE_TITLE,
    body,
    path: notificationMessagePath(event),
    defaultOn: (DEFAULT_SUBSCRIPTION_EVENTS as readonly string[]).includes(event.type),
  };
}

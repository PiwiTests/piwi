import {
  NOTIFICATION_MESSAGE_TITLE,
  notificationMessageBody,
  notificationMessagePath,
  notificationMessageTag,
  type NotificationEventData,
} from '#shared/notifications/browser-message';
import { subscribeDemoEvents } from '~/demo/run-events';
import { useDiagnosisNotification } from './useDiagnosisNotification';
import { useBrowserNotificationCookie } from './useBrowserNotificationCookie';

let sharedSource: EventSource | null = null;
let _demoUnsubscribe: (() => void) | null = null;
let started = false;
let _windowFocused = true;
/** The router and the base path the app is served at (`/demo/` in the demo), read when the stream starts. */
let _router: ReturnType<typeof useRouter> | null = null;
let _baseURL = '/';

if (import.meta.client) {
  window.addEventListener('focus', () => {
    _windowFocused = true;
  });
  window.addEventListener('blur', () => {
    _windowFocused = false;
  });
  _windowFocused = document.hasFocus();
}
let _cookie: ReturnType<typeof useBrowserNotificationCookie> | null = null;

let _diagnosisActive: ReturnType<typeof useDiagnosisNotification>['active'] | null = null;

function handleEvent(data: NotificationEventData) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && _windowFocused) return;

  if (data.type === 'diagnosis.completed' && _diagnosisActive && !_diagnosisActive.value) {
    return;
  }

  if (_cookie && data.projectId != null) {
    if (!_cookie.isEventSubscribed(data.projectId, data.type)) return;
  }

  const body = notificationMessageBody(data);
  if (!body) return;

  const notification = new Notification(NOTIFICATION_MESSAGE_TITLE, {
    body,
    tag: notificationMessageTag(data),
    icon: `${_baseURL.replace(/\/$/, '')}/logo.svg`,
  });

  const link = notificationMessagePath(data);
  if (link) {
    notification.onclick = () => {
      window.focus();
      void _router?.push(link);
      notification.close();
    };
  } else {
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }
}

async function checkBrowserSubscriptions(): Promise<boolean> {
  if (useRuntimeConfig().public.demoMode) return true;
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;

  try {
    const res = await $fetch<{ items: Array<{ type: string }> }>('/api/channels');
    return res.items.some((c) => c.type === 'browser');
  } catch {
    return false;
  }
}

async function shouldConnect(): Promise<boolean> {
  const config = useRuntimeConfig();

  if (config.public.demoMode) return true;

  if (config.public.authEnabled) {
    return checkBrowserSubscriptions();
  }

  return true;
}

function connectDemo() {
  _demoUnsubscribe = subscribeDemoEvents((message) => {
    if (message.scope === 'notification') {
      handleEvent(message.event as unknown as NotificationEventData);
    }
  });
}

const REOPEN_MIN_MS = 2_000;
const REOPEN_MAX_MS = 30_000;
let reopenDelay = REOPEN_MIN_MS;

function connectLive() {
  const source = new EventSource('/api/notifications/stream');
  sharedSource = source;

  source.onopen = () => {
    reopenDelay = REOPEN_MIN_MS;
  };

  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleEvent(data as NotificationEventData);
    } catch {
      /* ignore */
    }
  };

  // EventSource reconnects by itself, unless an error answer closed it for good (a proxy's 502 while the instance
  // restarts, an expired session): the stream then opens again, waiting longer each time.
  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED || sharedSource !== source) return;
    source.close();
    sharedSource = null;
    setTimeout(connectLive, reopenDelay);
    reopenDelay = Math.min(reopenDelay * 2, REOPEN_MAX_MS);
  };
}

/**
 * Show the server's notification events as browser notifications while the tab is hidden or unfocused. In the
 * desktop app the shell shows them itself, from its server's stream, so the page does not.
 */
export function useNotificationStream() {
  if (!import.meta.client || started || useIsDesktop()) return;
  started = true;

  const { active } = useDiagnosisNotification();
  _diagnosisActive = active;

  const config = useRuntimeConfig();
  _router = useRouter();
  _baseURL = config.app.baseURL || '/';

  if (!config.public.authEnabled) {
    _cookie = useBrowserNotificationCookie();
  }

  shouldConnect().then((subscribed) => {
    if (!subscribed) return;

    if (config.public.demoMode) {
      connectDemo();
    } else {
      connectLive();
    }
  });
}

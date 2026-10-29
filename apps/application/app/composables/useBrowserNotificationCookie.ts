import { effectScope, computed, type WritableComputedRef } from 'vue';
import { DEFAULT_SUBSCRIPTION_EVENTS, type NotificationEvent } from '#shared/notification-events';

const COOKIE_KEY = 'piwi-browser-notify';

interface ProjectNotifyConfig {
  events: NotificationEvent[];
}

type ProjectsMap = Record<number, ProjectNotifyConfig>;

interface StoredConfig {
  projects: ProjectsMap;
}

function defaultStored(): StoredConfig {
  return { projects: {} };
}

function parseConfig(raw: string): StoredConfig {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultStored();
    const projects: ProjectsMap = {};
    if (parsed.projects && typeof parsed.projects === 'object') {
      for (const [key, val] of Object.entries(parsed.projects)) {
        const id = Number(key);
        if (Number.isNaN(id)) continue;
        if (val && typeof val === 'object' && Array.isArray((val as ProjectNotifyConfig).events)) {
          projects[id] = { events: (val as ProjectNotifyConfig).events.filter((e: unknown) => typeof e === 'string') };
        }
      }
    }
    return { projects };
  } catch {
    return defaultStored();
  }
}

const _scope = effectScope(true);

let _cookieRef: any = null;
let _stored: WritableComputedRef<StoredConfig> | null = null;

function ensureInit() {
  if (_stored) return;

  _scope.run(() => {
    _cookieRef = useCookie<string>(COOKIE_KEY, {
      default: () => '',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      path: '/',
      secure: import.meta.client ? location.protocol === 'https:' : false,
      encode: (v: string) => encodeURIComponent(v),
      decode: (v: string) => decodeURIComponent(v),
    });

    _stored = computed<StoredConfig>({
      get: () => {
        const raw = _cookieRef!.value;
        return raw ? parseConfig(raw) : defaultStored();
      },
      set: (value: StoredConfig) => {
        _cookieRef!.value = JSON.stringify(value);
      },
    });
  });
}

/**
 * The per-browser notification events of each project, kept in a cookie: the
 * project bell's choices when authentication is off. In the desktop app, a
 * project whose events nobody chose notifies on `DEFAULT_SUBSCRIPTION_EVENTS`,
 * so its notifications work with no setup; turning every event off stores an
 * empty list, which keeps them off.
 */
export function useBrowserNotificationCookie() {
  ensureInit();

  const stored = _stored!;
  const desktop = useIsDesktop();

  function getProject(projectId: number): ProjectNotifyConfig {
    return stored.value.projects[projectId] ?? { events: desktop ? [...DEFAULT_SUBSCRIPTION_EVENTS] : [] };
  }

  function setEvents(projectId: number, events: NotificationEvent[]) {
    if (events.length === 0 && !desktop) {
      const next = { ...stored.value };
      delete next.projects[projectId];
      stored.value = next;
    } else {
      stored.value = {
        ...stored.value,
        projects: {
          ...stored.value.projects,
          [projectId]: { events },
        },
      };
    }
  }

  function toggleEvent(projectId: number, event: NotificationEvent) {
    const current = getProject(projectId).events;
    const next = current.includes(event) ? current.filter((e) => e !== event) : [...current, event];
    setEvents(projectId, next);
  }

  function isSubscribed(projectId: number): boolean {
    return getProject(projectId).events.length > 0;
  }

  function isEventSubscribed(projectId: number, event: string): boolean {
    return getProject(projectId).events.includes(event as NotificationEvent);
  }

  function hasAnySubscription(): boolean {
    return Object.values(stored.value.projects).some((p) => p.events.length > 0);
  }

  return { getProject, setEvents, toggleEvent, isSubscribed, isEventSubscribed, hasAnySubscription, stored };
}

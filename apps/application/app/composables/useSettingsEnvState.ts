import type { SettingsPageId } from '~/utils/settings-metadata';
import type { AiSettings } from '~~/types/api';

interface SmtpStatus {
  configured: boolean;
  envManaged: boolean;
}

interface WastedSettings {
  envManaged: boolean;
}

/**
 * Resolves which settings pages are currently "env-managed" (one or more of
 * their fields pinned by a `PIWI_*` env var), so the settings nav can show a
 * lock badge and pages can show the standardized banner.
 *
 * Reuses the existing `GET /api/settings/*` endpoints — no new server API. The
 * AI page is env-managed when its provider is env-pinned (`AiSettings.envManaged`);
 * SMTP is always env-only (read-only display); the Performance page when its
 * wasted-wait patterns or its cost of a CI minute come from env. Pages with no env-overridable fields
 * (account, users, groups, permissions, roles, tags) are never env-managed. Storage backend is env-only by
 * design but no endpoint
 * reports it today, so it is treated as "overridable but not necessarily locked"
 * (the page shows the env-var reference card regardless).
 *
 * Fetches lazily and only on the client, and only what the viewer may read:
 * most of these endpoints need an instance permission (`settings:manage`,
 * `connections:manage`), held by an administrator alone. In demo mode they are
 * served by the service worker.
 */
export function useSettingsEnvState() {
  const { can } = useAuth();
  const envManaged = ref<Record<SettingsPageId, boolean>>({
    account: false,
    localization: false,
    users: false,
    groups: false,
    permissions: false,
    roles: false,
    notifications: false,
    tags: false,
    storage: false,
    performance: false,
    'pr-feedback': false,
    'auto-heal': false,
    integrations: false,
    ai: false,
    desktop: false,
    connect: false,
    capabilities: false,
    mcp: false,
    api: false,
    'companion-tools': false,
    about: false,
  });

  async function refresh() {
    // A page the viewer cannot read stays false; a failed read too.
    const tasks: Promise<void>[] = [];

    if (can('settings:manage')) {
      tasks.push(
        $fetch<AiSettings>('/api/settings/ai')
          .then((s) => {
            envManaged.value.ai = Boolean(s.envManaged);
          })
          .catch(() => {}),
      );

      tasks.push(
        $fetch<WastedSettings>('/api/settings/wasted-waits')
          .then((s) => {
            // Performance groups wasted-time, timeout hygiene and the CI cost; the
            // wasted-wait patterns and the cost are its env-pinnable fields.
            if (s.envManaged) envManaged.value.performance = true;
          })
          .catch(() => {}),
      );

      tasks.push(
        $fetch<{ envManaged: boolean }>('/api/settings/ci-cost')
          .then((s) => {
            // The cost of a CI minute is the Performance page's other env-pinnable field.
            if (s.envManaged) envManaged.value.performance = true;
          })
          .catch(() => {}),
      );
    }

    tasks.push(
      $fetch<SmtpStatus>('/api/settings/smtp')
        .then((s) => {
          // SMTP is env-only by design; mark managed when configured.
          envManaged.value.notifications = Boolean(s.envManaged && s.configured);
        })
        .catch(() => {}),
    );

    if (can('connections:manage')) {
      tasks.push(
        $fetch<{ connections: { managedBy: string }[] }>('/api/integrations/connections')
          .then((s) => {
            // Integrations is env-managed when a connection comes from the environment.
            envManaged.value.integrations = (s.connections ?? []).some((c) => c.managedBy === 'env');
          })
          .catch(() => {}),
      );
    }

    tasks.push(
      $fetch<{ localeEnvManaged: boolean; timeZoneEnvManaged: boolean }>('/api/settings/locale')
        .then((s) => {
          // Localization is env-managed when either the locale or the time zone
          // is pinned by an env var.
          envManaged.value.localization = Boolean(s.localeEnvManaged || s.timeZoneEnvManaged);
        })
        .catch(() => {}),
    );

    await Promise.all(tasks);
  }

  // Fetch once on mount (client-only to avoid auth-gated SSR calls).
  if (import.meta.client) {
    onMounted(() => {
      void refresh();
    });
  }

  return { envManaged, refresh };
}

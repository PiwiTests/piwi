/**
 * Single source of truth for the Settings surface metadata: which pages exist,
 * their nav label/icon/route, the permission required to open them, and the
 * overridable fields on each. Each field references a `HelpTopicKey` whose
 * `envVars` list the `PIWI_*` environment variable(s) that override it (env
 * always wins; the UI shows the field read-only when set).
 *
 * It is metadata only: the server keeps being the actual resolver
 * (`runtimeConfig` + `resolveContextLimits` / `resolveWastedSettings` /
 * `readAiSettings`).
 *
 * Consumed by: `useSettingsNav` (nav items + lock badges), `useSettingsEnvState`
 * (which pages are env-managed), the settings pages themselves (page-level
 * env-var lists for banners + tooltips), and the assistant's `explain_setting`
 * tool. `app/utils/settings-metadata.ts` re-exports it, so the app auto-imports it.
 */
import { can, type AccessSummary, type InstancePermission } from '#shared/permissions';
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';
import type { CapabilityId } from '#shared/capabilities';
import { helpEnvVars, type HelpTopicKey } from '#shared/help-content';

export type SettingsPageId =
  | 'account'
  | 'localization'
  | 'users'
  | 'groups'
  | 'permissions'
  | 'roles'
  | 'notifications'
  | 'tags'
  | 'storage'
  | 'performance'
  | 'pr-feedback'
  | 'auto-heal'
  | 'integrations'
  | 'ai'
  | 'about';

export interface SettingFieldMeta {
  /** Stable field id, e.g. `ai.diagnosis.provider`. */
  id: string;
  /** UI label (used by tooltips / lock affordances). */
  label: string;
  /** Help-registry topic key — carries the env-var list. */
  help: HelpTopicKey;
  /** True when the field is read-only-by-design (env-only, never editable). */
  envOnly?: boolean;
}

/**
 * Settings splits into two jobs: running the instance, and tuning what Piwi
 * infers from your results, so infrastructure pages and analysis pages are
 * grouped apart.
 */
export type SettingsGroupId = 'instance' | 'analysis' | 'meta';

export const SETTINGS_GROUPS: { id: SettingsGroupId; label: string }[] = [
  { id: 'instance', label: 'Instance' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'meta', label: '' },
];

export interface SettingsPageMeta {
  id: SettingsPageId;
  label: string;
  icon: string;
  to: string;
  /** Which section of the Settings nav this page belongs to. */
  group: SettingsGroupId;
  /**
   * The instance permission the page's endpoints need; omitted = any signed-in
   * user. Only an administrator holds an instance permission.
   */
  permission?: InstancePermission;
  /**
   * Pages that only make sense when authentication is enabled (managing your
   * own account, managing users). Hidden in the desktop build, which is
   * single-user with auth off — see `useSettingsNav` / `useIsDesktop`.
   */
  authOnly?: boolean;
  /** Fields on this page (used to aggregate env vars + drive tooltips). */
  fields: SettingFieldMeta[];
  /** Topic key for a page-level intro hint shown under the nav. */
  introHelp?: HelpTopicKey;
  /**
   * The optional capability this page configures. When that capability is
   * declined, the nav drops the page and the page itself shows the reconsider
   * line instead of its settings.
   */
  capability?: CapabilityId;
}

export const SETTINGS_PAGES: SettingsPageMeta[] = [
  {
    id: 'account',
    label: 'Account',
    icon: 'i-lucide-user-round',
    to: '/settings/account',
    group: 'instance',
    authOnly: true,
    fields: [
      { id: 'account.display-name', label: 'Display name', help: 'account.display-name' },
      { id: 'account.email', label: 'Email address', help: 'account.email' },
      { id: 'account.connected-accounts', label: 'Connected accounts', help: 'account.connected-accounts' },
      { id: 'account.password', label: 'Password', help: 'account.password' },
      { id: 'account.api-keys', label: 'API keys', help: 'settings.api-keys' },
      { id: 'account.auth-toggle', label: 'Authentication', help: 'settings.auth-toggle', envOnly: true },
    ],
  },
  {
    id: 'localization',
    label: 'Localization',
    icon: 'i-lucide-languages',
    to: '/settings/localization',
    group: 'instance',
    introHelp: 'settings.localization',
    fields: [
      { id: 'localization.format', label: 'Date & time format', help: 'settings.locale' },
      { id: 'localization.time-zone', label: 'Time zone', help: 'settings.time-zone' },
    ],
  },
  {
    id: 'users',
    label: 'Users',
    icon: 'i-lucide-users',
    to: '/settings/users',
    group: 'instance',
    permission: 'users:manage',
    authOnly: true,
    introHelp: 'settings.users',
    fields: [
      { id: 'users.list', label: 'Users & roles', help: 'settings.users' },
      { id: 'users.api-keys', label: 'API keys', help: 'settings.api-keys' },
    ],
  },
  {
    id: 'groups',
    label: 'Groups',
    icon: 'i-lucide-users-round',
    to: '/settings/groups',
    group: 'instance',
    permission: 'groups:manage',
    authOnly: true,
    introHelp: 'settings.groups',
    fields: [{ id: 'groups.list', label: 'Groups', help: 'settings.groups' }],
  },
  {
    id: 'permissions',
    label: 'Permissions',
    icon: 'i-lucide-shield-check',
    to: '/settings/permissions',
    group: 'instance',
    permission: 'users:manage',
    authOnly: true,
    introHelp: 'settings.permissions',
    fields: [{ id: 'permissions.grid', label: 'Permission grid', help: 'settings.permissions' }],
  },
  {
    // Read-only, for everyone: what each role allows, so a member can see what a
    // role they are offered or hold lets them do.
    id: 'roles',
    label: 'Roles',
    icon: 'i-lucide-list-checks',
    to: '/settings/roles',
    group: 'instance',
    authOnly: true,
    introHelp: 'settings.roles',
    fields: [{ id: 'roles.matrix', label: 'What each role can do', help: 'settings.roles' }],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: 'i-lucide-bell',
    to: '/settings/notifications',
    group: 'instance',
    capability: 'notifications',
    fields: [
      { id: 'notifications.smtp', label: 'SMTP email delivery', help: 'settings.smtp', envOnly: true },
      { id: 'notifications.test-email', label: 'Send test email', help: 'notifications.test-email' },
      { id: 'notifications.channels', label: 'Notification channels', help: 'notifications.channels' },
      { id: 'notifications.subscriptions', label: 'Subscriptions', help: 'notifications.subscriptions' },
    ],
  },
  {
    id: 'tags',
    label: 'Tags',
    icon: 'i-lucide-tags',
    to: '/settings/tags',
    group: 'analysis',
    permission: 'tags:manage',
    introHelp: 'settings.tags',
    capability: 'tags',
    fields: [{ id: 'tags.list', label: 'Tags', help: 'settings.tags' }],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: 'i-lucide-plug',
    to: '/settings/integrations',
    group: 'instance',
    permission: 'connections:manage',
    introHelp: 'settings.integrations',
    capability: 'integrations',
    fields: [
      { id: 'integrations.connections', label: 'Connections', help: 'settings.integrations' },
      { id: 'integrations.connection', label: 'Connect a system', help: 'settings.integrations.connection' },
    ],
  },
  {
    id: 'storage',
    label: 'Storage',
    icon: 'i-lucide-hard-drive',
    to: '/settings/storage',
    group: 'instance',
    permission: 'storage:manage',
    fields: [
      { id: 'storage.backend', label: 'Storage backend', help: 'settings.storage-backend', envOnly: true },
      { id: 'storage.stats', label: 'Storage analysis', help: 'settings.storage-stats' },
      { id: 'storage.cleanup', label: 'Cleanup old test runs', help: 'settings.cleanup' },
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    icon: 'i-lucide-gauge',
    to: '/settings/performance',
    group: 'analysis',
    permission: 'settings:manage',
    fields: [
      { id: 'wasted-time.patterns', label: 'Wasted-time patterns', help: 'settings.wasted-time' },
      { id: 'timeout-hygiene.thresholds', label: 'Detection thresholds', help: 'settings.timeout-hygiene' },
      { id: 'ci-cost', label: 'Cost of a CI minute', help: 'settings.ci-cost' },
    ],
  },
  {
    id: 'pr-feedback',
    label: 'Pull requests',
    icon: 'i-lucide-git-pull-request',
    to: '/settings/pr-feedback',
    group: 'analysis',
    permission: 'settings:manage',
    introHelp: 'settings.pr-feedback',
    capability: 'pr-feedback',
    fields: [{ id: 'pr-feedback.settings', label: 'Pull-request feedback', help: 'settings.pr-feedback' }],
  },
  {
    id: 'auto-heal',
    label: 'Auto-heal',
    icon: 'i-lucide-bandage',
    to: '/settings/auto-heal',
    group: 'analysis',
    permission: 'settings:manage',
    introHelp: 'settings.auto-heal',
    capability: 'auto-heal',
    fields: [{ id: 'auto-heal.settings', label: 'Auto-heal pull requests', help: 'settings.auto-heal' }],
  },
  {
    id: 'ai',
    label: 'AI diagnosis',
    icon: 'i-lucide-sparkles',
    to: '/settings/ai',
    group: 'analysis',
    permission: 'settings:manage',
    capability: 'ai',
    fields: [
      { id: 'ai.diagnosis', label: 'Diagnosis model', help: 'settings.ai-provider' },
      { id: 'ai.research', label: 'Research model', help: 'settings.ai-research' },
      { id: 'ai.embedding', label: 'Embedding model', help: 'settings.embedding-model' },
      { id: 'ai.assistant', label: 'Assistant model', help: 'settings.ai-assistant' },
      { id: 'ai.auto-diagnose', label: 'Auto-diagnose', help: 'settings.auto-diagnose' },
      { id: 'ai.notifications', label: 'Diagnosis notifications', help: 'settings.ai-notifications' },
      { id: 'ai.context-limits', label: 'Diagnosis context limits', help: 'settings.ai-limits' },
      { id: 'ai.instructions', label: 'Global analysis instructions', help: 'settings.ai-instructions' },
      { id: 'ai.scm-token', label: 'Repository access token', help: 'project.scm-token' },
      { id: 'ai.privacy', label: 'Privacy notice', help: 'settings.privacy' },
    ],
  },
  {
    id: 'about',
    label: 'About',
    icon: 'i-lucide-info',
    to: '/settings/about',
    group: 'meta',
    fields: [],
  },
];

// ── Env-var helpers ────────────────────────────────────────────────────────

/** Env var(s) backing a field, resolved from its help topic. */
export function fieldEnvVars(field: SettingFieldMeta): PiwiEnvVarName[] {
  return helpEnvVars(field.help);
}

/** Union of all env vars across a page's fields (for banners / nav badges). */
export function pageEnvVars(page: SettingsPageMeta): PiwiEnvVarName[] {
  const seen = new Set<PiwiEnvVarName>();
  for (const f of page.fields) for (const v of fieldEnvVars(f)) seen.add(v);
  return [...seen];
}

/** Look up a page by id. */
export function getSettingsPage(id: SettingsPageId): SettingsPageMeta {
  const page = SETTINGS_PAGES.find((p) => p.id === id);
  if (!page) throw new Error(`Unknown settings page: ${id}`);
  return page;
}

/**
 * Whether a signed-in user with `access` may open `path`. Only settings pages
 * that need a permission are refused to someone without it; any other path
 * (including non-settings routes) is allowed. Used by the auth middleware so a
 * direct URL cannot reach a page the nav hides; the server still checks the
 * permission on each page's endpoints.
 */
export function canOpenSettingsPath(path: string, access: AccessSummary | null | undefined): boolean {
  const page = SETTINGS_PAGES.find((p) => p.to === path.replace(/\/+$/, ''));
  return !page?.permission || (!!access && can(access, page.permission));
}

// ── Nav construction ───────────────────────────────────────────────────────

/**
 * One nav entry. Structurally a `NavigationMenuItem` (and a `DropdownMenuItem`),
 * declared here rather than importing the Nuxt UI type so this module stays pure
 * and unit-testable.
 */
export interface SettingsNavItem {
  label: string;
  icon: string;
  to: string;
  badge?: { icon: string; color: 'neutral' };
}

/** What the viewer is allowed to see, and which pages the environment has pinned. */
export interface SettingsNavContext {
  /**
   * Whether the pages needing an instance permission are visible (only an
   * administrator holds one). Callers pass `true` when auth is disabled
   * entirely: every visitor is a virtual administrator then.
   */
  canSeeAdmin: boolean;
  /** Desktop build: single-user with auth off, so `authOnly` pages are hidden. */
  isDesktop: boolean;
  /** Pages currently pinned by env, which get a trailing lock badge. */
  envManaged?: Partial<Record<SettingsPageId, boolean>>;
  /** Capabilities declined at instance level; their pages drop out of the nav. */
  declinedCapabilities?: Set<CapabilityId>;
}

/**
 * Build the grouped Settings navigation.
 *
 * Sections come out in `SETTINGS_GROUPS` order, and a section whose pages are
 * all hidden for this viewer is dropped rather than rendered as an empty
 * separator — a non-admin, for instance, can see none of the Analysis pages.
 *
 * Kept pure (no Vue, no Nuxt composables) so the permission/build/env branching is
 * directly testable; `useSettingsNav` is the reactive wrapper around it.
 */
export function buildSettingsNavSections(ctx: SettingsNavContext): SettingsNavItem[][] {
  const visible = SETTINGS_PAGES.filter(
    (page) =>
      (!page.permission || ctx.canSeeAdmin) &&
      !(ctx.isDesktop && page.authOnly) &&
      !(page.capability && ctx.declinedCapabilities?.has(page.capability)),
  );

  const toItem = (page: SettingsPageMeta): SettingsNavItem => ({
    label: page.label,
    icon: page.icon,
    to: page.to,
    // Trailing lock badge marks env-pinned pages.
    ...(ctx.envManaged?.[page.id] ? { badge: { icon: 'i-lucide-lock', color: 'neutral' as const } } : {}),
  });

  return SETTINGS_GROUPS.map((group) => visible.filter((page) => page.group === group.id).map(toItem)).filter(
    (section) => section.length > 0,
  );
}

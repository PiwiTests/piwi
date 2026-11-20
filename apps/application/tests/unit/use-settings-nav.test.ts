import { describe, test, expect, vi, afterEach } from 'vitest';
import { computed, ref } from 'vue';
import { useSettingsNav } from '../../app/composables/useSettingsNav';
import type { SettingsPageId } from '../../app/utils/settings-metadata';

/**
 * `useSettingsNav` is a thin reactive wrapper — the filtering and grouping live
 * in `buildSettingsNavSections` (covered in settings-metadata.test.ts). What is
 * only testable here is the wiring: whether the viewer sees the pages needing
 * an instance permission (only an administrator holds one), and how the
 * `envManaged` ref-or-getter is unwrapped.
 *
 * Nuxt auto-imports are globals at runtime, so they are stubbed rather than
 * imported. `computed` is the real Vue one, so the returned ref behaves.
 */
function stubNuxt(
  opts: {
    authEnabled?: boolean;
    isAdmin?: boolean;
    projectAdmin?: boolean;
    desktop?: boolean;
    declined?: Set<string>;
  } = {},
) {
  const authEnabled = opts.authEnabled ?? false;
  const isAdmin = ref(opts.isAdmin ?? false);
  const declined = opts.declined ?? new Set<string>();

  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { authEnabled } }));
  vi.stubGlobal('useIsDesktop', () => opts.desktop ?? false);
  // Mirrors the real `useAuth`: with auth disabled there are no users, so nobody
  // holds the administrator role and `canSeeAdmin` has to fall back to true.
  vi.stubGlobal('useAuth', () => ({
    isAdmin,
    canSeeAdmin: computed(() => !authEnabled || isAdmin.value),
    // A Project admin somewhere holds project:manage there; an administrator, and everyone without sign-in, everywhere.
    canAnywhere: (permission: string) =>
      !authEnabled || isAdmin.value || (permission === 'project:manage' && (opts.projectAdmin ?? false)),
  }));
  vi.stubGlobal('useInstanceCapabilities', () => ({ isHidden: (id: string) => declined.has(id) }));
}

const pathsOf = (nav: { value: { to?: string | object }[][] }) => nav.value.flat().map((i) => i.to);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSettingsNav', () => {
  test('treats every visitor as an admin when auth is disabled', async () => {
    // The instance has no users at all, so gating admin pages would lock
    // everyone out of Storage, Tags and AI on a default self-hosted install.
    stubNuxt({ authEnabled: false, isAdmin: false });

    expect(pathsOf(await useSettingsNav())).toContain('/settings/storage');
  });

  test('hides admin pages from a non-admin once auth is enabled', async () => {
    stubNuxt({ authEnabled: true, isAdmin: false });

    const visible = pathsOf(await useSettingsNav());
    expect(visible).not.toContain('/settings/storage');
    expect(visible).toContain('/settings/account');
  });

  test('hides the user and permission pages from a non-admin, project admins included', async () => {
    // Project roles carry no instance permission: a Project admin manages their
    // project's members from the project's own settings, not from here.
    stubNuxt({ authEnabled: true, isAdmin: false });

    const visible = pathsOf(await useSettingsNav());
    expect(visible).not.toContain('/settings/users');
    expect(visible).not.toContain('/settings/permissions');
  });

  test('shows a Project admin the pages a project permission opens, and no other admin page', async () => {
    stubNuxt({ authEnabled: true, isAdmin: false, projectAdmin: true });

    const visible = pathsOf(await useSettingsNav());
    expect(visible).toContain('/settings/credentials');
    expect(visible).not.toContain('/settings/storage');
    expect(visible).not.toContain('/settings/users');
  });

  test('shows admin pages to an admin when auth is enabled', async () => {
    stubNuxt({ authEnabled: true, isAdmin: true });

    expect(pathsOf(await useSettingsNav())).toContain('/settings/storage');
  });

  test('hides the auth-only pages in the desktop build', async () => {
    stubNuxt({ desktop: true });

    const visible = pathsOf(await useSettingsNav());
    expect(visible).not.toContain('/settings/account');
    expect(visible).not.toContain('/settings/users');
    expect(visible).toContain('/settings/storage');
  });

  test('unwraps envManaged given as a ref', async () => {
    stubNuxt();
    const managed = ref({ ai: true } as Record<SettingsPageId, boolean>);

    const item = (await useSettingsNav(managed)).value.flat().find((i) => i.to === '/settings/ai');
    expect(item?.badge).toEqual({ icon: 'i-lucide-lock', color: 'neutral' });
  });

  test('unwraps envManaged given as a getter, and tracks its changes', async () => {
    stubNuxt();
    const managed = ref({} as Record<SettingsPageId, boolean>);
    const nav = await useSettingsNav(() => managed.value);

    const aiItem = () => nav.value.flat().find((i) => i.to === '/settings/ai');
    expect(aiItem()?.badge).toBeUndefined();

    managed.value = { ai: true } as Record<SettingsPageId, boolean>;
    expect(aiItem()?.badge).toEqual({ icon: 'i-lucide-lock', color: 'neutral' });
  });

  test('returns grouped sections, each non-empty', async () => {
    stubNuxt();
    const sections = (await useSettingsNav()).value;

    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.length > 0)).toBe(true);
  });

  test('drops a settings page whose capability is declined', async () => {
    stubNuxt({ authEnabled: true, isAdmin: true, declined: new Set(['notifications']) });
    const paths = pathsOf(await useSettingsNav());

    expect(paths).not.toContain('/settings/notifications');
    expect(paths).toContain('/settings/ai');
  });
});

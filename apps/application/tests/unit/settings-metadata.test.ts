import { describe, test, expect } from 'vitest';
import {
  SETTINGS_PAGES,
  SETTINGS_GROUPS,
  buildSettingsNavSections,
  canOpenSettingsPath,
  getSettingsPage,
  type SettingsNavContext,
} from '../../app/utils/settings-metadata';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary, isInstancePermission } from '#shared/permissions';

/** Flatten sections to the `to` paths, for terse assertions. */
function paths(ctx: SettingsNavContext): string[] {
  return buildSettingsNavSections(ctx)
    .flat()
    .map((i) => i.to);
}

const WEB_ADMIN: SettingsNavContext = { canSeeAdmin: true, isDesktop: false };
const WEB_MEMBER: SettingsNavContext = { canSeeAdmin: false, isDesktop: false };
const DESKTOP: SettingsNavContext = { canSeeAdmin: true, isDesktop: true };

describe('settings registry integrity', () => {
  test('every page belongs to a declared group', () => {
    const groupIds = new Set(SETTINGS_GROUPS.map((g) => g.id));
    for (const page of SETTINGS_PAGES) {
      expect(groupIds.has(page.group)).toBe(true);
    }
  });

  test('every declared group has at least one page', () => {
    // An empty group would be a heading (or separator) over nothing.
    for (const group of SETTINGS_GROUPS) {
      expect(SETTINGS_PAGES.some((p) => p.group === group.id)).toBe(true);
    }
  });

  test('page ids and routes are unique', () => {
    expect(new Set(SETTINGS_PAGES.map((p) => p.id)).size).toBe(SETTINGS_PAGES.length);
    expect(new Set(SETTINGS_PAGES.map((p) => p.to)).size).toBe(SETTINGS_PAGES.length);
  });

  test('getSettingsPage resolves every id and rejects unknown ones', () => {
    for (const page of SETTINGS_PAGES) {
      expect(getSettingsPage(page.id).to).toBe(page.to);
    }
    // @ts-expect-error — deliberately outside the union
    expect(() => getSettingsPage('nope')).toThrow(/Unknown settings page/);
  });
});

describe('buildSettingsNavSections', () => {
  test('an admin on the web sees every page but the desktop-only ones', () => {
    // Set comparison, not sequence: grouping deliberately reorders relative to
    // the registry's declaration order (storage sits with Instance, tags with
    // Analysis). The order that matters is asserted by the group-order test.
    expect(paths(WEB_ADMIN).sort()).toEqual(
      SETTINGS_PAGES.filter((p) => !p.desktopOnly)
        .map((p) => p.to)
        .sort(),
    );
  });

  test('the desktop-only pages show in the desktop build alone, first', () => {
    const desktopOnly = SETTINGS_PAGES.filter((p) => p.desktopOnly).map((p) => p.to);
    expect(desktopOnly).toEqual(['/settings/desktop']);
    expect(paths(WEB_ADMIN)).not.toContain('/settings/desktop');
    // The first page `/settings` opens on in the desktop build.
    expect(paths(DESKTOP)[0]).toBe('/settings/desktop');
  });

  test('a non-admin sees no page needing an instance permission', () => {
    const visible = paths(WEB_MEMBER);
    for (const page of SETTINGS_PAGES) {
      if (page.permission) expect(visible).not.toContain(page.to);
      else expect(visible).toContain(page.to);
    }
  });

  test('a section whose pages are all hidden collapses instead of rendering empty', () => {
    // Every Analysis page is admin-only, so a non-admin loses the whole section
    // rather than getting a separator with nothing under it.
    const analysisPages = SETTINGS_PAGES.filter((p) => p.group === 'analysis');
    expect(analysisPages.every((p) => p.permission)).toBe(true);

    const sections = buildSettingsNavSections(WEB_MEMBER);
    expect(sections.every((section) => section.length > 0)).toBe(true);
    expect(sections.length).toBeLessThan(buildSettingsNavSections(WEB_ADMIN).length);
  });

  test('the desktop build hides the auth-only pages', () => {
    const visible = paths(DESKTOP);
    for (const page of SETTINGS_PAGES) {
      if (page.authOnly) expect(visible).not.toContain(page.to);
    }
    // …but keeps the admin pages, since desktop runs with auth off.
    expect(visible).toContain('/settings/storage');
  });

  test('sections come out in registry group order', () => {
    const sections = buildSettingsNavSections(WEB_ADMIN);
    const groupOfFirstItem = sections.map((section) => SETTINGS_PAGES.find((p) => p.to === section[0]!.to)!.group);
    const expectedOrder = SETTINGS_GROUPS.map((g) => g.id).filter((id) => SETTINGS_PAGES.some((p) => p.group === id));
    expect(groupOfFirstItem).toEqual(expectedOrder);
  });

  test('only env-managed pages carry a lock badge', () => {
    const sections = buildSettingsNavSections({ ...WEB_ADMIN, envManaged: { ai: true } });
    const items = sections.flat();

    expect(items.find((i) => i.to === '/settings/ai')?.badge).toEqual({ icon: 'i-lucide-lock', color: 'neutral' });
    for (const item of items) {
      if (item.to !== '/settings/ai') expect(item.badge).toBeUndefined();
    }
  });

  test('no lock badges when env state is omitted', () => {
    expect(
      buildSettingsNavSections(WEB_ADMIN)
        .flat()
        .every((i) => i.badge === undefined),
    ).toBe(true);
  });

  test('a declined capability drops its settings page', () => {
    const visible = paths({ ...WEB_ADMIN, declinedCapabilities: new Set(['notifications']) });
    expect(visible).not.toContain('/settings/notifications');
    // Pages without a capability, and undeclined ones, are untouched.
    expect(visible).toContain('/settings/ai');
    expect(visible).toContain('/settings/storage');
  });

  test('declining several capabilities drops each of their pages', () => {
    const declined = new Set(['ai', 'tags', 'integrations', 'pr-feedback', 'auto-heal'] as const);
    const visible = paths({ ...WEB_ADMIN, declinedCapabilities: declined });
    for (const to of [
      '/settings/ai',
      '/settings/tags',
      '/settings/integrations',
      '/settings/pr-feedback',
      '/settings/auto-heal',
    ]) {
      expect(visible).not.toContain(to);
    }
    // Storage carries no capability, so it survives.
    expect(visible).toContain('/settings/storage');
  });

  test('an empty declined set changes nothing', () => {
    expect(paths({ ...WEB_ADMIN, declinedCapabilities: new Set() }).sort()).toEqual(paths(WEB_ADMIN).sort());
  });
});

describe('canOpenSettingsPath', () => {
  const restricted = SETTINGS_PAGES.filter((page) => page.permission);
  const open = SETTINGS_PAGES.filter((page) => !page.permission);
  // Project roles grant no instance permission, even Project admin on all projects.
  const projectAdmin = buildAccessSummary(InstanceRole.MEMBER, [{ projectId: null, role: ProjectRole.PROJECT_ADMIN }]);
  const viewer = buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.VIEWER }]);

  test('the registry has both restricted and open pages to guard', () => {
    expect(restricted.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
  });

  test('every restricted page needs an instance permission', () => {
    // Only an administrator holds one, which is what the nav's canSeeAdmin gate relies on.
    for (const page of restricted) expect(isInstancePermission(page.permission)).toBe(true);
  });

  test('refuses every restricted page to a member, whatever their project roles, and to nobody', () => {
    for (const page of restricted) {
      expect(canOpenSettingsPath(page.to, viewer)).toBe(false);
      expect(canOpenSettingsPath(page.to, projectAdmin)).toBe(false);
      expect(canOpenSettingsPath(page.to, null)).toBe(false);
      expect(canOpenSettingsPath(page.to, undefined)).toBe(false);
    }
  });

  test('lets an administrator open every settings page', () => {
    for (const page of SETTINGS_PAGES) expect(canOpenSettingsPath(page.to, ADMIN_ACCESS)).toBe(true);
  });

  test('lets any member open the unrestricted pages (account, notifications…)', () => {
    for (const page of open) expect(canOpenSettingsPath(page.to, viewer)).toBe(true);
  });

  test('ignores a trailing slash', () => {
    expect(canOpenSettingsPath('/settings/users/', viewer)).toBe(false);
  });

  test('allows paths that are not a settings page', () => {
    expect(canOpenSettingsPath('/settings', viewer)).toBe(true);
    expect(canOpenSettingsPath('/projects/1', viewer)).toBe(true);
  });
});

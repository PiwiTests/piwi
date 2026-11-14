/**
 * Which tabs of the project page, and which pages of its More actions menu, a
 * project shows. The Flake Lab tab follows the `flake-lab` capability, the
 * Coverage tab the `test-map` and `coverage` ones (it shows while either is
 * on), and the Bug reports page the `bug-reports` one. The page's strip and
 * menu and the command palette's project entries all ask here, so the palette
 * offers what the page shows.
 */
import type { CapabilityId } from '#shared/capabilities';
import type { ProjectMenuPagePath, ProjectTabValue } from '#shared/app-places';

/** The capabilities a tab stands on: the tab is hidden once every one of them is. */
const PROJECT_TAB_CAPABILITIES: Partial<Record<ProjectTabValue, CapabilityId[]>> = {
  coverage: ['test-map', 'coverage'],
  'flake-lab': ['flake-lab'],
};

/** Whether the project page hides a tab, given what says a capability is hidden for the project. */
export function projectTabHidden(tab: ProjectTabValue, capabilityHidden: (id: CapabilityId) => boolean): boolean {
  const capabilities = PROJECT_TAB_CAPABILITIES[tab];
  return capabilities ? capabilities.every((capability) => capabilityHidden(capability)) : false;
}

/** The capability a page of the More actions menu stands on. */
const PROJECT_MENU_PAGE_CAPABILITIES: Partial<Record<ProjectMenuPagePath, CapabilityId>> = {
  'bug-reports': 'bug-reports',
};

/** Whether the project page's More actions menu hides a page, given what says a capability is hidden for the project. */
export function projectMenuPageHidden(
  path: ProjectMenuPagePath,
  capabilityHidden: (id: CapabilityId) => boolean,
): boolean {
  const capability = PROJECT_MENU_PAGE_CAPABILITIES[path];
  return capability ? capabilityHidden(capability) : false;
}

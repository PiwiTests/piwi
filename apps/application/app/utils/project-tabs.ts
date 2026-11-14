/**
 * Which tabs of the project page a project shows. The Flake Lab tab follows
 * the `flake-lab` capability, and the Coverage tab the `test-map` and
 * `coverage` ones (it shows while either is on). The page's strip and the
 * command palette's project entries both ask here, so the palette offers the
 * tabs the page shows.
 */
import type { CapabilityId } from '#shared/capabilities';
import type { ProjectTabValue } from '#shared/app-places';

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

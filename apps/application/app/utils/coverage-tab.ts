/**
 * The project page's Coverage tab: its views, in the order the switch shows
 * them, and the address keys each view owns (`?tab=coverage&view=…`).
 */

export const COVERAGE_VIEWS = ['gaps', 'map', 'code'] as const;
export type CoverageView = (typeof COVERAGE_VIEWS)[number];

/** The query keys a view reads; they leave the address when another view opens. */
export const COVERAGE_VIEW_KEYS: Record<CoverageView, string[]> = {
  gaps: ['gap', 'gapPr', 'gapFile', 'gapStatus'],
  map: ['node'],
  code: ['commit', 'branch', 'folder', 'area'],
};

/** The Coverage tab on one of its views, as a route location. */
export function coverageTabLink(
  projectId: number,
  view: CoverageView,
  query: Record<string, string | undefined> = {},
): { path: string; query: Record<string, string | undefined> } {
  return { path: `/projects/${projectId}`, query: { tab: 'coverage', view, ...query } };
}

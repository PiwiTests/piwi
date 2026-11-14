/**
 * The project page's Coverage tab: the address keys each of its views owns
 * (`?tab=coverage&view=…`) and the link to one view. The views themselves are
 * `PROJECT_COVERAGE_VIEWS` (`#shared/app-places`).
 */
import type { ProjectCoverageView } from '#shared/app-places';

export type CoverageView = ProjectCoverageView;

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

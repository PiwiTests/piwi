/**
 * The places of the dashboard that more than one file names: the project
 * page's tabs and their views, the run page's tabs, and the pages a project's
 * More actions menu opens. A page builds its strip, its switch or its menu from
 * these lists, and the command palette, the copy and the docs name a place by
 * the label it has here.
 *
 * The lists hold what exists. Which of it shows (a declined capability, a live
 * run, a run with no video) is decided by the page that renders it.
 *
 * Kept dependency-free in `shared/`, like `piwi-features.ts`, so a script or a
 * unit test imports it without the app's runtime.
 */

/** One view of a tab: the value its switch holds, and its label. */
export interface PlaceView {
  value: string;
  label: string;
}

/** One tab of a page: its `?tab=` value, its label without a count, its icon and its views. */
export interface PlaceTab {
  value: string;
  label: string;
  icon: string;
  views?: readonly PlaceView[];
}

/** One page of a project's More actions menu: its path under `/projects/<id>/`, its label and its icon. */
export interface ProjectMenuPage {
  path: string;
  label: string;
  icon: string;
}

/** The views of the project page's Failures tab, in the order of its switch. */
export const PROJECT_FAILURE_VIEWS = [
  { value: 'clusters', label: 'Clusters' },
  { value: 'flaky', label: 'Flaky' },
  { value: 'quarantine', label: 'Quarantine' },
] as const satisfies readonly PlaceView[];

/** The views of the project page's Coverage tab, in the order of its switch; the value is the address's `?view=`. */
export const PROJECT_COVERAGE_VIEWS = [
  { value: 'gaps', label: 'Gaps' },
  { value: 'map', label: 'Map' },
  { value: 'code', label: 'Code' },
] as const satisfies readonly PlaceView[];

/** The project page's tabs (`/projects/<id>?tab=<value>`), in the order of its strip. */
export const PROJECT_TABS = [
  { value: 'runs', label: 'Runs', icon: 'i-lucide-play-circle' },
  { value: 'tests', label: 'Tests', icon: 'i-lucide-flask-conical' },
  { value: 'failures', label: 'Failures', icon: 'i-lucide-layers', views: PROJECT_FAILURE_VIEWS },
  { value: 'flake-lab', label: 'Flake Lab', icon: 'i-lucide-snowflake' },
  { value: 'coverage', label: 'Coverage', icon: 'i-lucide-radar', views: PROJECT_COVERAGE_VIEWS },
  { value: 'performance', label: 'Performance', icon: 'i-lucide-trending-up' },
  { value: 'settings', label: 'Settings', icon: 'i-lucide-settings' },
] as const satisfies readonly PlaceTab[];

/** The run page's tabs (`/test-runs/<id>?tab=<value>`), in the order of its strip. */
export const RUN_TABS = [
  { value: 'test-cases', label: 'Tests', icon: 'i-lucide-beaker' },
  { value: 'changes', label: 'Changes', icon: 'i-lucide-git-compare-arrows' },
  { value: 'workers', label: 'Timeline', icon: 'i-lucide-timeline' },
  { value: 'video', label: 'Video', icon: 'i-lucide-video' },
  { value: 'resources', label: 'Resources', icon: 'i-lucide-cpu' },
] as const satisfies readonly PlaceTab[];

/** The pages a project's More actions menu opens (`/projects/<id>/<path>`), in the order of the menu. */
export const PROJECT_MENU_PAGES = [
  { path: 'test-functions', label: 'Test functions', icon: 'i-lucide-square-function' },
  { path: 'selections', label: 'Selections', icon: 'i-lucide-list-filter' },
  { path: 'locators', label: 'Locators', icon: 'i-lucide-crosshair' },
  { path: 'bug-reports', label: 'Bug reports', icon: 'i-lucide-bug' },
] as const satisfies readonly ProjectMenuPage[];

export type ProjectTabValue = (typeof PROJECT_TABS)[number]['value'];
export type ProjectFailureView = (typeof PROJECT_FAILURE_VIEWS)[number]['value'];
export type ProjectCoverageView = (typeof PROJECT_COVERAGE_VIEWS)[number]['value'];
export type RunTabValue = (typeof RUN_TABS)[number]['value'];

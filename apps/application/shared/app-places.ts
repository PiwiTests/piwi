/**
 * The places of the dashboard that more than one file names: the project
 * page's tabs and their views, the run page's tabs, the pages a project's More
 * actions menu opens, the sections of a project's Settings tab and the pages of
 * Settings. A page builds its strip, its switch or its menu from these lists,
 * and the command palette, the copy and the docs name a place by the label it
 * has here.
 *
 * The lists hold what exists. Which of it shows (a declined capability, a live
 * run, a run with no video, a permission) is decided by the page that renders it.
 *
 * Kept free of the app's runtime in `shared/`, like `piwi-features.ts`, so a
 * script or a unit test imports it without Nuxt; Settings' pages come from
 * `settings-metadata.ts`, which the Settings menu renders.
 */
import { SETTINGS_PAGES } from '#shared/settings-metadata';

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
  { value: 'tests', label: 'Tests', icon: 'i-lucide-beaker' },
  { value: 'changes', label: 'Changes', icon: 'i-lucide-git-compare-arrows' },
  { value: 'timeline', label: 'Timeline', icon: 'i-lucide-timeline' },
  { value: 'video', label: 'Video', icon: 'i-lucide-video' },
  { value: 'resources', label: 'Resources', icon: 'i-lucide-cpu' },
] as const satisfies readonly PlaceTab[];

/**
 * Other `?tab=` values the run page answers and the tab each opens, where the
 * page rewrites the address to that tab's own value: `test-cases` and
 * `workers`, the names of the parts of a tab (`failure-groups`, the Tests tab
 * grouped by cluster) and of what a tab holds (`insights`, `regression`,
 * `compare`, `endpoints`).
 */
export const RUN_TAB_ALIASES: Readonly<Record<string, RunTabValue>> = {
  'test-cases': 'tests',
  workers: 'timeline',
  'failure-groups': 'tests',
  endpoints: 'tests',
  insights: 'changes',
  regression: 'changes',
  compare: 'changes',
};

/** The pages a project's More actions menu opens (`/projects/<id>/<path>`), in the order of the menu. */
export const PROJECT_MENU_PAGES = [
  { path: 'test-functions', label: 'Test functions', icon: 'i-lucide-square-function' },
  { path: 'selections', label: 'Selections', icon: 'i-lucide-list-filter' },
  { path: 'locators', label: 'Locators', icon: 'i-lucide-crosshair' },
  { path: 'bug-reports', label: 'Bug reports', icon: 'i-lucide-bug' },
] as const satisfies readonly ProjectMenuPage[];

/** One section of a project's Settings tab: its `?section=` id, its label, its icon and its group. */
export interface ProjectSettingsSection {
  id: string;
  label: string;
  icon: string;
  group: (typeof PROJECT_SETTINGS_GROUPS)[number]['id'];
}

/** The groups of a project's Settings menu, in its order. */
export const PROJECT_SETTINGS_GROUPS = [
  { id: 'project', label: 'Project' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'integrations', label: 'Integrations' },
] as const;

/** The sections of a project's Settings tab (`/projects/<id>?tab=settings&section=<id>`), in the order of its menu. */
export const PROJECT_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', icon: 'i-lucide-settings', group: 'project' },
  { id: 'status', label: 'Status', icon: 'i-lucide-circle-check-big', group: 'project' },
  { id: 'members', label: 'Members', icon: 'i-lucide-users', group: 'project' },
  { id: 'source-control', label: 'Source control', icon: 'i-lucide-git-branch', group: 'project' },
  { id: 'ai', label: 'AI diagnosis', icon: 'i-lucide-sparkles', group: 'project' },
  { id: 'live-view', label: 'Live view', icon: 'i-lucide-monitor-play', group: 'project' },
  { id: 'run-variables', label: 'Run variables', icon: 'i-lucide-variable', group: 'project' },
  { id: 'capabilities', label: 'Capabilities', icon: 'i-lucide-toggle-right', group: 'analysis' },
  { id: 'coverage', label: 'Coverage', icon: 'i-lucide-scan-line', group: 'analysis' },
  { id: 'targets', label: 'Targets', icon: 'i-lucide-target', group: 'analysis' },
  { id: 'issue-tracker', label: 'Issue tracker', icon: 'i-lucide-ticket', group: 'integrations' },
  { id: 'ci', label: 'CI', icon: 'i-lucide-workflow', group: 'integrations' },
  { id: 'tag-keys', label: 'Keys in test tags', icon: 'i-lucide-tags', group: 'integrations' },
  { id: 'test-management', label: 'Test management', icon: 'i-lucide-list-checks', group: 'integrations' },
  { id: 'browser-extension', label: 'Browser extension', icon: 'i-lucide-link', group: 'integrations' },
  { id: 'local-folder', label: 'Local folder', icon: 'i-lucide-folder-symlink', group: 'integrations' },
] as const satisfies readonly ProjectSettingsSection[];

/** One page of Settings (`/settings/<page>`): its path and its label, as the Settings menu shows it. */
export interface SettingsPagePlace {
  path: string;
  label: string;
}

/** The pages of Settings, from `SETTINGS_PAGES`; which a viewer sees, and in which group, follows `buildSettingsNavSections`. */
export const SETTINGS_PAGE_PLACES: readonly SettingsPagePlace[] = SETTINGS_PAGES.map((page) => ({
  path: page.to,
  label: page.label,
}));

export type ProjectTabValue = (typeof PROJECT_TABS)[number]['value'];
export type ProjectFailureView = (typeof PROJECT_FAILURE_VIEWS)[number]['value'];
export type ProjectCoverageView = (typeof PROJECT_COVERAGE_VIEWS)[number]['value'];
export type RunTabValue = (typeof RUN_TABS)[number]['value'];
export type ProjectMenuPagePath = (typeof PROJECT_MENU_PAGES)[number]['path'];
export type ProjectSettingsSectionId = (typeof PROJECT_SETTINGS_SECTIONS)[number]['id'];

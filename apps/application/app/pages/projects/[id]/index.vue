<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { SortingState } from '@tanstack/vue-table';
import type {
  ProjectWithTestRuns,
  TestRunSummary,
  PerformanceTrendPoint,
  SlowTest,
  FlakyTest,
  MarkersResponse,
} from '~~/types/api';
import type { FilterBarState } from '~/components/shared/FilterBar.vue';
import { RUN_STATUS_SERIES, legendOf } from '~/utils/chart';
import { drillQueryKey, parseDrillQuery, type DrillScope } from '~/utils/analytics-drilldown';
import { projectRunScopeQuery, runInProjectScope, type ProjectRunScope } from '#shared/project-run-scope';
import type { ProjectHeaderTarget } from '~/components/project/ProjectHeader.vue';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id as string;

// === MAIN PROJECT DATA ===
const {
  data: project,
  error: projectError,
  refresh,
} = await useFetch<ProjectWithTestRuns>(`/api/projects/${projectId}`);
if (projectError.value) showPageLoadError(projectError.value, 'project');
provideExternalIdUrl(() => project.value?.externalIdUrl);

useHead(computed(() => ({ title: `${project.value?.label || project.value?.name || 'Project'} — Piwi Dashboard` })));

const toast = useToast();

const { can } = useAuth();
// Project-level capability states gate the bell, the Quarantine segment, the
// Gaps tab and the Timeline's add-marker control.
const { isHidden: projCapHidden } = await useProjectCapabilities(Number(projectId));

// *Export*: this project as a quality report over the last 30 days, the project page's own window.
const reportOpen = ref(false);
const reportQuery = computed(() => ({ projects: String(projectId), period: 'last-30d' }));
// *Schedule…*: a report schedule over this project.
const scheduleOpen = ref(false);
const runtimeConfig = useRuntimeConfig();
const { isDesktop, openReport } = useDesktopReportLink();
// What the viewer may do on this project; the server checks each route's permission.
const canEditSettings = computed(() => can('project:manage', projectId));
const canDeleteRuns = computed(() => can('run:delete', projectId));
const canDeleteProject = computed(() => can('project:delete', projectId));
// Importing runs from a blob report or a trace is an instance permission.
const canImport = computed(() => can('storage:manage'));
const canScheduleReport = computed(() => can('report:write', projectId));

const showDeleteProjectModal = ref(false);
const deleteProjectConfirmInput = ref('');
const deleteProjectConfirmValid = computed(() => deleteProjectConfirmInput.value === project.value?.name);
const {
  deleting: deletingProject,
  progress: deletionProgress,
  elapsedMs: deletionElapsedMs,
  deleteProject,
} = useProjectDeletion(projectId);

async function handleDeleteProject() {
  if (!deleteProjectConfirmValid.value || deletingProject.value) return;
  try {
    await deleteProject();
    toast.add({ title: 'Project deleted', color: 'success' });
    await refreshNuxtData();
    await router.push('/');
  } catch (error: unknown) {
    const message =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({ title: 'Delete failed', description: message || 'An error occurred', color: 'error' });
  }
}

// === FILTERS (persisted per project) ===
const defaultFilters = (): FilterBarState => ({
  environments: [],
  branches: [],
  fullRunsOnly: true,
  allBranches: false,
});
const filters = useCookie<FilterBarState>(`piwi-filters-project-${projectId}`, {
  default: defaultFilters,
  encode: (v) => JSON.stringify(v),
  decode: (v) => {
    try {
      return { ...defaultFilters(), ...(v ? (JSON.parse(v) as Partial<FilterBarState>) : {}) };
    } catch {
      return defaultFilters();
    }
  },
});

// === DRILL-DOWN FROM ANALYTICS ===
// A number on a dashboard links here with its scope: the filters and branch
// policy it names replace the saved ones, and its period narrows the runs
// table and chart until cleared.
function viewerTimeZone(): string {
  const tz = activeLocalePrefs().timeZone;
  return tz === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz;
}
const drill = ref<DrillScope | null>(null);
function readDrill() {
  const parsed = parseDrillQuery(route.query as Record<string, unknown>, {
    now: Date.now(),
    timeZone: import.meta.client ? viewerTimeZone() : 'UTC',
    markers: markers.value,
  });
  drill.value = parsed;
  if (parsed) {
    filters.value = {
      environments: parsed.environments,
      branches: parsed.branches,
      fullRunsOnly: parsed.fullRunsOnly,
      allBranches: parsed.branches.length === 0 && !parsed.defaultBranchOnly,
    };
  }
}
function clearDrill() {
  drill.value = null;
  const { source: _s, period: _p, tz: _t, status: _st, allBranches: _a, ...rest } = route.query;
  router.replace({ query: rest });
}
/** The branch the filters read with no branch picked: the project's setting, else its most common run branch. */
const defaultBranch = computed(
  () => project.value?.effectiveDefaultBranch || project.value?.defaultBranch?.trim() || 'main',
);
const drillText = computed(() => drill.value?.period?.label ?? null);

// A run's branch reads the scalar column, falling back to the SCM metadata for
// runs reported before the branch column existed.
function runBranch(run: { branch?: string | null; metadata?: { scm?: { branch?: string | null } } | null }) {
  return run.branch ?? run.metadata?.scm?.branch ?? null;
}

const availableEnvironments = computed(() => {
  const envs = new Set<string>();
  for (const run of project.value?.testRuns || []) if (run.environment) envs.add(run.environment);
  return [...envs].sort();
});

const availableBranches = computed(() => {
  const branches = new Set<string>();
  for (const run of project.value?.testRuns || []) {
    const b = runBranch(run);
    if (b) branches.add(b);
  }
  return [...branches].sort();
});

// === RUN SCOPE ===
// The filters as the run scope every tab that reads run history follows: the
// header, the runs table and chart here, and the catalog, the failures, the
// Flake Lab and the performance tab on the server.
const runScope = computed<ProjectRunScope>(() => ({
  environments: filters.value.environments,
  branches: filters.value.branches,
  allBranches: !!filters.value.allBranches,
  fullRunsOnly: filters.value.fullRunsOnly,
}));
const runScopeQuery = computed(() => projectRunScopeQuery(runScope.value));

function inScope(run: TestRunSummary, scope: ProjectRunScope = runScope.value): boolean {
  return runInProjectScope(
    { environment: run.environment, branch: runBranch(run), isFullRun: run.isFullRun },
    scope,
    defaultBranch.value,
  );
}

/** The drill-down period from Analytics, which narrows the runs table and chart only. */
function inDrillPeriod(run: TestRunSummary): boolean {
  const period = drill.value?.period;
  if (!period) return true;
  const t = new Date(run.startTime).getTime();
  return t >= period.from && t < period.to;
}

const scopedRuns = computed(() => (project.value?.testRuns ?? []).filter((run) => inScope(run)));
const filteredRuns = computed(() => scopedRuns.value.filter(inDrillPeriod));

function resetFilters(): void {
  filters.value = defaultFilters();
}

const filtersActive = computed(
  () =>
    filters.value.environments.length > 0 ||
    filters.value.branches.length > 0 ||
    !!filters.value.allBranches ||
    !filters.value.fullRunsOnly,
);

// === RUNS TAB: kept runs ===
// Kept runs are mostly old, past the recent window the project loads, so the
// "Kept runs only" view reads them from their own endpoint.
const keptOnly = useViewState('runs:kept-only', () => false);
const { data: keptRunsData, refresh: refreshKeptRuns } = useFetch<{ items: TestRunSummary[]; total: number }>(
  `/api/projects/${projectId}/kept-runs`,
  { lazy: true, server: false, default: () => ({ items: [], total: 0 }) },
);
const filteredKeptRuns = computed(() =>
  (keptRunsData.value?.items ?? []).filter((run) => inScope(run) && inDrillPeriod(run)),
);
const tableRuns = computed(() => (keptOnly.value ? filteredKeptRuns.value : filteredRuns.value));

// The table shows one page of runs at a time, so the page's HTML and its
// hydration stay the same size however many runs are loaded; the chart above it
// draws them all.
const RUNS_PAGE_SIZE = 25;
const runsPage = useViewState('runs:page', () => 1);
const runsSorting = useViewState<SortingState>('runs:sorting', () => []);
const pagedRuns = computed(() =>
  tableRuns.value.slice((runsPage.value - 1) * RUNS_PAGE_SIZE, runsPage.value * RUNS_PAGE_SIZE),
);
// A narrower filter (or a deleted run) can leave the page past the last one.
watch(tableRuns, (rows) => {
  const last = Math.max(1, Math.ceil(rows.length / RUNS_PAGE_SIZE));
  if (runsPage.value > last) runsPage.value = last;
});

// Runs the other filters keep but "Full runs only" or the default-branch
// reading hides — both are on by default, so without a note those runs look
// missing.
const hiddenRuns = computed(() => {
  const runs = (keptOnly.value ? keptRunsData.value?.items : project.value?.testRuns) ?? [];
  const scope = runScope.value;
  const withPartialRuns = { ...scope, fullRunsOnly: false };
  const withAllBranches = { ...scope, allBranches: true };
  let partial = 0;
  let otherBranches = 0;
  for (const run of runs) {
    if (!inDrillPeriod(run) || inScope(run)) continue;
    if (scope.fullRunsOnly && inScope(run, withPartialRuns)) partial++;
    else if (scope.branches.length === 0 && !scope.allBranches && inScope(run, withAllBranches)) otherBranches++;
  }
  return { partial, otherBranches };
});

function includePartialRuns(): void {
  filters.value = { ...filters.value, fullRunsOnly: false };
}

function showAllBranches(): void {
  filters.value = { ...filters.value, allBranches: true };
}

const filtersSummary = computed(() => {
  const hidden: string[] = [];
  if (hiddenRuns.value.otherBranches > 0)
    hidden.push(hiddenRunsPhrase(hiddenRuns.value.otherBranches, 'other-branches'));
  if (hiddenRuns.value.partial > 0) hidden.push(hiddenRunsPhrase(hiddenRuns.value.partial, 'partial'));
  return filterBarSummary(filters.value, {
    environments: availableEnvironments.value.length > 0,
    branches: availableBranches.value.length > 0,
    // As the bar: the policy reads only once a run is off the default branch.
    branchPolicy: availableBranches.value.some((branch) => branch !== defaultBranch.value),
    defaultBranch: defaultBranch.value,
    hidden,
  });
});

const keepRunId = ref<number | null>(null);
const isKeepOpen = ref(false);
const { release: releaseKeep, canRelease } = useRunKeep();

async function refreshAfterKeepChange() {
  await Promise.all([refresh(), refreshKeptRuns()]);
}

// === HEADER FIGURES ===
// Within the filters: the latest run and the pass rate come from the runs
// already loaded; the open clusters and flaky counts come from the same
// endpoints the Failures tab reads, fetched lazily so they never block the
// first paint. The quarantine is the project's, whatever the filters.
const PASS_RATE_RUNS = 20;
const newestFirst = (a: TestRunSummary, b: TestRunSummary) =>
  new Date(b.startTime).getTime() - new Date(a.startTime).getTime();

const latestRun = computed(() => [...scopedRuns.value].sort(newestFirst)[0] ?? null);

const passRateRuns = computed(() => [...scopedRuns.value].sort(newestFirst).slice(0, PASS_RATE_RUNS));
const passRate = computed(() => {
  let passed = 0;
  let total = 0;
  for (const r of passRateRuns.value) {
    passed += r.passedTests;
    total += r.totalTests;
  }
  return total > 0 ? Math.round((passed / total) * 100) : null;
});

const {
  data: clustersCount,
  status: clustersCountStatus,
  refresh: refreshClustersCount,
} = await useFetch(`/api/projects/${projectId}/failure-clusters`, {
  lazy: true,
  server: false,
  query: runScopeQuery,
  default: () => ({ total: 0, open: 0 }),
  transform: (r: { items: Array<{ status?: string | null }> }) => ({
    total: r.items.length,
    open: r.items.filter((c) => (c.status ?? 'open') === 'open').length,
  }),
});

const {
  data: flakyCount,
  status: flakyCountStatus,
  refresh: refreshFlakyCount,
} = await useFetch(`/api/projects/${projectId}/flaky-tests`, {
  lazy: true,
  server: false,
  query: computed(() => ({ runs: 50, enrich: 'false', ...runScopeQuery.value })),
  default: () => 0,
  transform: (r: { items: FlakyTest[] }) => r.items.length,
});

const {
  data: quarantineCount,
  status: quarantineCountStatus,
  refresh: refreshQuarantineCount,
} = await useFetch(`/api/projects/${projectId}/quarantine?candidates=false`, {
  lazy: true,
  server: false,
  default: () => 0,
  transform: (r: { debt?: { active?: number } }) => r.debt?.active ?? 0,
});

// The counts read as loading until each has answered once; a later refresh keeps the last figures.
const failureCountsReady = ref(false);
watchEffect(() => {
  const settled = (status: string) => status === 'success' || status === 'error';
  if ([clustersCountStatus.value, flakyCountStatus.value, quarantineCountStatus.value].every(settled))
    failureCountsReady.value = true;
});
const headerFailures = computed(() =>
  failureCountsReady.value
    ? {
        openClusters: clustersCount.value.open,
        flaky: flakyCount.value ?? 0,
        quarantined: projCapHidden('quarantine') ? null : (quarantineCount.value ?? 0),
      }
    : null,
);

// The catalog owns its fetch and emits its total for the Tests tab label.
const testCasesTotal = ref<number | null>(null);

function refreshFailureCounts() {
  refreshClustersCount();
  refreshFlakyCount();
  refreshQuarantineCount();
}

useRunStream(() => Promise.all([refresh(), refreshFailureCounts()]));

// === TABS ===
const TABS = ['runs', 'tests', 'failures', 'flake-lab', 'gaps', 'performance', 'settings'] as const;
type TabValue = (typeof TABS)[number];

// Other ?tab= values (and the redirecting sub-routes) land on the tab that holds them.
const TAB_ALIASES: Record<string, TabValue> = {
  'test-runs': 'runs',
  compare: 'runs',
  timeline: 'runs',
  'test-cases': 'tests',
  'spec-health': 'tests',
  'failure-clusters': 'failures',
  'flaky-tests': 'failures',
  quarantine: 'failures',
  'ai-steps': 'performance',
  members: 'settings',
};

type FailureSegment = 'clusters' | 'flaky' | 'quarantine';
const ALIAS_SEGMENT: Record<string, FailureSegment> = {
  'failure-clusters': 'clusters',
  'flaky-tests': 'flaky',
  quarantine: 'quarantine',
};

const activeTab = ref<TabValue>('runs');
const failureSegment = useViewState<FailureSegment>('failures:segment', () => 'clusters');

// The Quarantine segment follows the `quarantine` capability: a project that
// declined it loses the segment button, and a stale `?tab=quarantine` link falls
// back to Clusters.
const failureSegments = computed(() => {
  const segs: { key: FailureSegment; label: string; count: number }[] = [
    { key: 'clusters', label: 'Clusters', count: clustersCount.value.total },
    { key: 'flaky', label: 'Flaky', count: flakyCount.value ?? 0 },
  ];
  if (!projCapHidden('quarantine'))
    segs.push({ key: 'quarantine', label: 'Quarantine', count: quarantineCount.value ?? 0 });
  return segs;
});
watch(
  () => projCapHidden('quarantine'),
  (hidden) => {
    if (hidden && failureSegment.value === 'quarantine') failureSegment.value = 'clusters';
  },
  { immediate: true },
);

function resolveTab(raw: unknown): TabValue | null {
  if (typeof raw !== 'string') return null;
  if (TABS.includes(raw as TabValue)) return raw as TabValue;
  return TAB_ALIASES[raw] ?? null;
}

// The Gaps and Flake Lab tabs follow the `test-map` and `flake-lab`
// capabilities: a project that declined one loses its tab, and a stale
// `?tab=` link to it falls back to Runs.
const TAB_CAPABILITY: Partial<Record<TabValue, Parameters<typeof projCapHidden>[0]>> = {
  gaps: 'test-map',
  'flake-lab': 'flake-lab',
};
const tabHidden = (tab: TabValue) => {
  const capability = TAB_CAPABILITY[tab];
  return capability ? projCapHidden(capability) : false;
};
watch(
  () => tabHidden(activeTab.value),
  (hidden) => {
    if (hidden) activeTab.value = 'runs';
  },
  { immediate: true },
);

const initialTab = resolveTab(route.query.tab);
if (initialTab && !tabHidden(initialTab)) {
  activeTab.value = initialTab;
  if (typeof route.query.tab === 'string' && ALIAS_SEGMENT[route.query.tab])
    failureSegment.value = ALIAS_SEGMENT[route.query.tab]!;
}

// Reflect the active tab in the URL (replace, so tab switches don't stack history).
// A tab's own keys leave with it: the Settings section, the Gaps tab's graph node.
const TAB_QUERY_KEYS: Partial<Record<TabValue, string[]>> = { settings: ['section'], gaps: ['node'] };
watch(activeTab, (tab) => {
  if (route.query.tab === tab) return;
  const patch: Record<string, string | undefined> = { tab };
  for (const [owner, keys] of Object.entries(TAB_QUERY_KEYS)) {
    if (owner !== tab) for (const key of keys) patch[key] = undefined;
  }
  void replaceQuery(router, patch);
});

// The page scrolls inside its own body; each tab keeps its position for when
// the user comes back to the project.
const scrollEl = ref<HTMLElement | null>(null);
useViewScroll(
  () => scrollEl.value,
  () => activeTab.value,
);

// Rewrite an old ?tab= alias to its canonical value once the page is interactive;
// `members` names a section of the Settings tab, so it keeps that section.
onMounted(() => {
  if (route.query.tab !== activeTab.value) {
    const section = route.query.tab === 'members' ? { section: 'members' } : {};
    void replaceQuery(router, { tab: activeTab.value, ...section }, { hash: route.hash });
  }
});

const failuresCount = computed(() => clustersCount.value.open + (flakyCount.value ?? 0) + (quarantineCount.value ?? 0));

const tabItems = computed(() =>
  [
    { label: `Runs (${filteredRuns.value.length})`, icon: 'i-lucide-play-circle', value: 'runs' as const },
    {
      label: `Tests${testCasesTotal.value != null ? ` (${testCasesTotal.value})` : ''}`,
      icon: 'i-lucide-flask-conical',
      value: 'tests' as const,
    },
    {
      label: `Failures${failuresCount.value > 0 ? ` (${failuresCount.value})` : ''}`,
      icon: 'i-lucide-layers',
      value: 'failures' as const,
    },
    { label: 'Flake Lab', icon: 'i-lucide-snowflake', value: 'flake-lab' as const },
    { label: 'Gaps', icon: 'i-lucide-radar', value: 'gaps' as const },
    { label: 'Performance', icon: 'i-lucide-trending-up', value: 'performance' as const },
    { label: 'Settings', icon: 'i-lucide-settings', value: 'settings' as const },
  ].filter((item) => !tabHidden(item.value)),
);

const tabNavItems = computed(() =>
  tabItems.value.map((item) => ({
    label: item.label,
    icon: item.icon,
    active: activeTab.value === item.value,
    'aria-current': activeTab.value === item.value ? ('true' as const) : undefined,
    onSelect: () => {
      activeTab.value = item.value;
    },
  })),
);

const tabSelectItems = computed(() => tabItems.value.map((t) => ({ label: t.label, value: t.value })));
const activeTabIcon = computed(() => tabItems.value.find((t) => t.value === activeTab.value)?.icon);

// A header figure links to the tab that holds it (Failures also selects the
// segment it belongs to).
function goToTab(tab: TabValue, segment?: FailureSegment) {
  if (segment) failureSegment.value = segment;
  activeTab.value = tab;
}

function openHeaderTarget(target: ProjectHeaderTarget) {
  goToTab('failures', target);
}

// === RUNS TAB: selection → compare or delete ===
const selectedRunIds = ref<number[]>([]);
const isRunSelected = (runId: number) => selectedRunIds.value.includes(runId);
// The header checkbox selects (or clears) the runs of the page on screen.
const allRunsSelected = computed(
  () => pagedRuns.value.length > 0 && pagedRuns.value.every((r) => selectedRunIds.value.includes(r.id)),
);
const someRunsSelected = computed(() => selectedRunIds.value.length > 0 && !allRunsSelected.value);

function toggleRunSelection(runId: number) {
  const idx = selectedRunIds.value.indexOf(runId);
  if (idx >= 0) selectedRunIds.value.splice(idx, 1);
  else selectedRunIds.value.push(runId);
}

function toggleAllRuns() {
  const page = new Set(pagedRuns.value.map((r) => r.id));
  selectedRunIds.value = allRunsSelected.value
    ? selectedRunIds.value.filter((id) => !page.has(id))
    : [...new Set([...selectedRunIds.value, ...page])];
}

// A filter that hides a selected run drops it from the selection, so a bulk
// delete only ever covers rows on screen.
watch(tableRuns, (rows) => {
  const visible = new Set(rows.map((r) => r.id));
  if (selectedRunIds.value.some((id) => !visible.has(id))) {
    selectedRunIds.value = selectedRunIds.value.filter((id) => visible.has(id));
  }
});

// === RUNS TAB: delete (one run from its menu, or the selection) ===
const runsToDelete = ref<TestRunSummary[]>([]);
const isDeleteRunsOpen = ref(false);

function openDeleteRuns(runs: TestRunSummary[]) {
  runsToDelete.value = runs;
  isDeleteRunsOpen.value = true;
}

function deleteSelectedRuns() {
  openDeleteRuns(tableRuns.value.filter((r) => selectedRunIds.value.includes(r.id)));
}

async function onRunsDeleted(runIds: number[]) {
  selectedRunIds.value = selectedRunIds.value.filter((id) => !runIds.includes(id));
  await Promise.all([refresh(), refreshKeptRuns()]);
}

// Compare opens the newer run's Changes tab with the older run as its baseline.
function compareSelectedRuns() {
  if (selectedRunIds.value.length !== 2) return;
  const [a, b] = selectedRunIds.value as [number, number];
  const newer = Math.max(a, b);
  const older = Math.min(a, b);
  navigateTo(`/test-runs/${newer}?tab=changes&baseline=${older}`);
}

function scopeTooltip(run: TestRunSummary): string {
  if (run.isFullRun !== false) return 'Full run — the complete test suite ran';
  const parts: string[] = [];
  const grep = run.filterDetails?.grep?.trim();
  const grepInvert = run.filterDetails?.grepInvert?.trim();
  const files = run.filterDetails?.files;
  if (grep && grep !== '.*') parts.push(`grep: ${grep}`);
  if (grepInvert) parts.push(`grep-invert: ${grepInvert}`);
  if (files?.length) parts.push(`files: ${files.join(', ')}`);
  return parts.length
    ? `Partial run — ${parts.join(' · ')}`
    : 'Partial run — only a filtered subset of tests ran (grep, file, or line filter)';
}

const runsColumns: TableColumn<TestRunSummary>[] = [
  { accessorKey: 'select', header: 'Select' },
  { accessorKey: 'id', header: createSortHeader<TestRunSummary>('Run') },
  { accessorKey: 'status', header: createSortHeader<TestRunSummary>('Status') },
  { accessorKey: 'isFullRun', header: 'Scope' },
  { id: 'browsers', accessorFn: (row) => row.browsers, header: 'Browsers' },
  { accessorKey: 'startTime', header: createSortHeader<TestRunSummary>('Started') },
  { accessorKey: 'environment', header: createSortHeader<TestRunSummary>('Environment') },
  { accessorKey: 'metadata', header: 'Branch / Commit' },
  { accessorKey: 'duration', header: createSortHeader<TestRunSummary>('Test status / Dur.') },
  { id: 'actions', header: 'Actions' },
];

function openRun(runId: number) {
  navigateTo(`/test-runs/${runId}`);
}

/** A run's page as an href, under the base path the app is served at (`/demo/` in the demo). */
function runHref(runId: number): string {
  return router.resolve(`/test-runs/${runId}`).href;
}

/** A plain click on a run link routes in the app; a modified click opens it as the browser does. */
function onRunLinkClick(event: MouseEvent, runId: number) {
  if (isModifiedClick(event)) return;
  event.preventDefault();
  openRun(runId);
}

// The report links and the delete action share one row overflow menu, so the
// table fits without a horizontal scroll at 1280 px.
function runMenuItems(run: TestRunSummary) {
  // In the desktop shell a `target="_blank"` menu link is inert, so open the
  // report through the shell instead (a window for viewable reports, a disk
  // save for a blob archive); on the web it stays a normal new-tab link.
  const items: Array<Record<string, unknown>> = (run.reports ?? []).map((report) =>
    isDesktop
      ? { label: report.label, icon: reportIcon(report.type), onSelect: () => openReport(report) }
      : {
          label: report.label,
          icon: reportIcon(report.type),
          to: fileApiUrl(report.path, null, runtimeConfig.app?.baseURL),
          target: '_blank',
        },
  );
  if (items.length) items.push({ type: 'separator' });
  if (!run.keptAt) {
    items.push({
      label: 'Keep forever…',
      icon: 'i-lucide-lock',
      onSelect: () => {
        keepRunId.value = run.id;
        isKeepOpen.value = true;
      },
    });
  } else if (canRelease(projectId)) {
    items.push({
      label: 'Release keep',
      icon: 'i-lucide-lock-open',
      onSelect: async () => {
        if (await releaseKeep(run.id)) await refreshAfterKeepChange();
      },
    });
  }
  // A kept run cannot be deleted until it is released.
  if (canDeleteRuns.value) {
    items.push({
      label: run.keptAt ? 'Delete run (release it first)' : 'Delete run',
      icon: 'i-lucide-trash-2',
      color: 'error',
      disabled: !!run.keptAt,
      onSelect: () => openDeleteRuns([run]),
    });
  }
  return items;
}

// === RUNS TAB: markers ===
const { data: markersData, refresh: refreshMarkers } = await useFetch<MarkersResponse>(
  `/api/projects/${projectId}/markers`,
  { default: () => ({ items: [] }) },
);
const markers = computed(() => markersData.value?.items ?? []);

// The drill-down period resolves in the viewer's zone, so it applies once mounted,
// and again only when the drill-down's own query keys change (a new link), not
// on any other change of the URL (a tab, a page of a list, a filter).
onMounted(readDrill);
watch(
  () => drillQueryKey(route.query as Record<string, unknown>),
  (drilled) => {
    if (drilled) readDrill();
  },
);

const visibleMarkers = computed(() => {
  if (filters.value.environments.length === 0) return markers.value;
  return markers.value.filter((m) => m.environment == null || filters.value.environments.includes(m.environment!));
});

const markersOpen = ref(false);
const focusMarkerId = ref<number | null>(null);

function handleMarkerClick(id: number) {
  focusMarkerId.value = id;
  markersOpen.value = true;
}

// === PERFORMANCE TAB ===
const RUNS_WINDOW_OPTIONS = [
  { label: 'Last 20 runs', value: 20 },
  { label: 'Last 50 runs', value: 50 },
  { label: 'Last 100 runs', value: 100 },
  { label: 'Last 200 runs', value: 200 },
];
const perfRunsWindow = useViewState('performance:runs-window', () => 50);

const performanceData = ref<PerformanceTrendPoint[] | null>(null);
const performanceLoading = ref(false);
const slowTests = ref<SlowTest[] | null>(null);
const slowTestsError = ref(false);
const slowTestsLoading = ref(false);
const performanceInitialLoading = computed(() => performanceLoading.value && performanceData.value === null);

// Whether the project ships committed AI-step artifacts; the coverage card only
// appears when it does, so the check waits for the Performance tab.
const {
  data: hasAiSteps,
  status: aiStepsStatus,
  execute: checkAiSteps,
} = useFetch(`/api/projects/${projectId}/ai-steps?days=90`, {
  lazy: true,
  server: false,
  immediate: false,
  default: () => false,
  transform: (r: { artifacts?: unknown[] }) => (r.artifacts?.length ?? 0) > 0,
});

// The slowest tests follow the run scope, not the window, so they are read
// again only when the scope changes. Each read counts its requests, so an
// answer to an older window or scope never replaces a newer one.
let slowTestsScope: string | null = null;
let performanceRequest = 0;
let slowTestsRequest = 0;
watch(
  [activeTab, perfRunsWindow, runScopeQuery],
  async ([tab, runsWindow, scopeQuery]) => {
    if (tab !== 'performance') return;
    const scopeKey = JSON.stringify(scopeQuery);
    const readSlowTests = slowTestsScope !== scopeKey;
    performanceLoading.value = true;
    if (readSlowTests) slowTestsLoading.value = true;
    if (import.meta.server) return;
    if (aiStepsStatus.value === 'idle') void checkAiSteps();
    const performanceAsked = ++performanceRequest;
    const slowTestsAsked = readSlowTests ? ++slowTestsRequest : 0;
    if (readSlowTests) slowTestsScope = scopeKey;
    const perfRes = await $fetch<{ items: PerformanceTrendPoint[] }>(`/api/projects/${projectId}/performance`, {
      query: { runs: runsWindow, ...scopeQuery },
    }).catch((err) => {
      console.warn('[PerformanceTab] Failed to fetch performance trend:', err);
      return null;
    });
    if (performanceAsked === performanceRequest) {
      performanceData.value = perfRes?.items ?? null;
      performanceLoading.value = false;
    }
    if (readSlowTests) {
      slowTestsError.value = false;
      const slowRes = await $fetch<{ items: SlowTest[] }>(`/api/projects/${projectId}/slow-tests`, {
        query: scopeQuery,
      }).catch((err) => {
        if (slowTestsAsked === slowTestsRequest) slowTestsError.value = true;
        console.warn('[PerformanceTab] Failed to fetch slow tests:', err);
        return null;
      });
      if (slowTestsAsked === slowTestsRequest) {
        slowTests.value = slowRes?.items ?? null;
        slowTestsLoading.value = false;
      }
    }
  },
  { immediate: true },
);

const slowTestsColumns: TableColumn<SlowTest>[] = [
  { accessorKey: 'title', header: createSortHeader<SlowTest>('Test') },
  { accessorKey: 'avgDuration', header: createSortHeader<SlowTest>('Avg duration') },
  { accessorKey: 'maxDuration', header: createSortHeader<SlowTest>('Max') },
  { accessorKey: 'minDuration', header: createSortHeader<SlowTest>('Min') },
  { accessorKey: 'latestDuration', header: createSortHeader<SlowTest>('Latest') },
  { accessorKey: 'trend', header: createSortHeader<SlowTest>('Trend') },
  { accessorKey: 'runCount', header: createSortHeader<SlowTest>('Runs') },
];
const slowTestsSorting = useViewState<SortingState>('performance:slow-tests-sorting', () => []);

// Latest run seeds the slow-endpoints selector.
const slowEndpointsRunId = ref<number | null>(null);
watch(
  latestRun,
  (run) => {
    if (run && slowEndpointsRunId.value == null) slowEndpointsRunId.value = run.id;
  },
  { immediate: true },
);

// Clusters list refreshes after a suggested merge is approved.
const clustersRefreshKey = ref(0);

// === NAVBAR MORE MENU ===
const moreMenuItems = computed(() => {
  const items: {
    label: string;
    icon: string;
    color?: 'error';
    onSelect: () => void;
    to?: string;
    'data-tour'?: string;
  }[] = [];
  if (canEditSettings.value)
    items.push({ label: 'Edit', icon: 'i-lucide-pencil', onSelect: () => goToTab('settings') });
  items.push({
    label: 'Test functions',
    icon: 'i-lucide-square-function',
    onSelect: () => navigateTo(`/projects/${projectId}/test-functions`),
  });
  items.push({
    label: 'Selections',
    icon: 'i-lucide-list-filter',
    onSelect: () => navigateTo(`/projects/${projectId}/selections`),
  });
  items.push({
    label: 'Locators',
    icon: 'i-lucide-crosshair',
    onSelect: () => navigateTo(`/projects/${projectId}/locators`),
  });
  items.push({
    label: 'Coverage',
    icon: 'i-lucide-scan-line',
    onSelect: () => navigateTo(`/projects/${projectId}/coverage`),
  });
  if (!projCapHidden('bug-reports'))
    items.push({
      label: 'Bug reports',
      icon: 'i-lucide-bug',
      onSelect: () => navigateTo(`/projects/${projectId}/bug-reports`),
    });
  if (canScheduleReport.value && !projCapHidden('quality-reports'))
    items.push({
      label: 'Schedule a quality report…',
      icon: 'i-lucide-calendar-clock',
      'data-tour': 'project-schedule-report',
      onSelect: () => (scheduleOpen.value = true),
    });
  if (canDeleteProject.value)
    items.push({
      label: 'Delete',
      icon: 'i-lucide-trash-2',
      color: 'error',
      onSelect: () => {
        deleteProjectConfirmInput.value = '';
        showDeleteProjectModal.value = true;
      },
    });
  items.push({ label: 'Refresh', icon: 'i-lucide-refresh-cw', onSelect: () => refresh() });
  return items;
});
</script>

<template>
  <UDashboardPanel id="project-detail">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav
            :items="[
              { label: 'Home', icon: 'i-lucide-house', to: '/' },
              { label: 'Projects', to: '/projects' },
              { label: project?.label || project?.name || 'Project' },
            ]"
          />
        </template>
        <template #right>
          <div class="flex items-center gap-1.5 shrink-0">
            <SubscribeBell
              v-if="!projCapHidden('notifications')"
              :project-id="parseInt(projectId)"
              :project-label="project?.label || project?.name"
              :known-branches="availableBranches"
              :known-environments="availableEnvironments"
            />
            <UButton
              v-if="!projCapHidden('quality-reports')"
              label="Export"
              icon="i-lucide-file-down"
              size="sm"
              color="neutral"
              variant="outline"
              title="Export this project as a quality report"
              @click="reportOpen = true"
            />
            <UButton
              v-if="canImport"
              label="Import"
              icon="i-lucide-import"
              size="sm"
              :to="`/projects/${projectId}/import`"
            />
            <UDropdownMenu :items="moreMenuItems">
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-ellipsis-vertical"
                aria-label="More actions"
                title="More actions"
                data-tour="project-more-actions"
              />
            </UDropdownMenu>
          </div>
        </template>
      </UDashboardNavbar>
      <ReportPreviewModal v-model:open="reportOpen" :query="reportQuery" />
      <ScheduleForm v-model:open="scheduleOpen" :scope="reportQuery" />
    </template>

    <template #body>
      <div ref="scrollEl" class="flex flex-col h-full overflow-y-auto gap-4">
        <ProjectHeader
          :title="project?.label || project?.name || 'Project'"
          :description="project?.description"
          :tags="project?.tags"
          :latest-run="latestRun"
          :pass-rate="passRate"
          :pass-rate-runs="passRateRuns.length"
          :has-runs="(project?.testRuns?.length ?? 0) > 0"
          :failures="headerFailures"
          @open="openHeaderTarget"
        />

        <!-- The filters the header and every tab that reads run history follow -->
        <FiltersBlock
          inline
          :summary="filtersSummary"
          :resettable="filtersActive"
          help="project.filters"
          test-id="project-filters"
          data-shot="project-filters"
          data-tour="project-filters"
          @reset="resetFilters"
        >
          <FilterBar
            v-model="filters"
            :available-environments="availableEnvironments"
            :available-branches="availableBranches"
            branch-policy
            :default-branch="defaultBranch"
            :show-reset="false"
          />
          <template v-if="hiddenRuns.partial > 0 || hiddenRuns.otherBranches > 0" #notes>
            <HiddenRunsNote
              :partial-runs="hiddenRuns.partial"
              :other-branch-runs="hiddenRuns.otherBranches"
              @include-partial="includePartialRuns"
              @all-branches="showAllBranches"
            />
          </template>
        </FiltersBlock>

        <!-- Desktop shell only (renders nothing without the IPC bridge). -->
        <DesktopProjectLinkCard :project-id="projectId" />

        <!-- Mobile: a select replaces the cramped tab strip; the strip scrolls from sm up. -->
        <USelect
          v-model="activeTab"
          :items="tabSelectItems"
          value-key="value"
          :icon="activeTabIcon"
          size="md"
          aria-label="Select tab"
          class="w-full sm:hidden"
        />
        <UDashboardToolbar class="hidden sm:block p-1">
          <UNavigationMenu
            :items="tabNavItems"
            highlight
            class="-mx-1 flex-1"
            :ui="{ list: 'overflow-x-auto', root: 'min-w-0', item: 'shrink-0' }"
          />
        </UDashboardToolbar>

        <!-- RUNS TAB -->
        <div v-if="activeTab === 'runs'" data-tour="project-runs-tab">
          <p v-if="drill" class="text-xs text-muted mb-2" data-testid="analytics-drill">
            From Analytics<template v-if="drillText">: {{ drillText }}</template> ·
            <button
              type="button"
              class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
              @click="clearDrill"
            >
              Show every run
            </button>
          </p>
          <ChartCard
            v-if="filteredRuns.length > 0"
            title="Run trend"
            subtitle="One bar per run, newest on the right"
            help="project.runs-trend"
            :legend="legendOf(RUN_STATUS_SERIES)"
            data-shot="run-trend"
            data-tour="project-run-trend"
          >
            <template #actions>
              <UButton
                v-if="!projCapHidden('markers')"
                size="xs"
                color="neutral"
                variant="outline"
                icon="i-lucide-milestone"
                :label="`Markers (${markers.length})`"
                data-tour="project-markers"
                @click="markersOpen = true"
              />
            </template>
            <TestRunsChart :test-runs="filteredRuns" :markers="visibleMarkers" @marker-click="handleMarkerClick" />
          </ChartCard>

          <UCard class="mt-4" data-shot="runs-table" data-tour="project-runs-table">
            <div
              v-if="selectedRunIds.length > 0"
              class="flex items-center gap-3 px-3 py-2 mb-3 rounded-lg bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800"
            >
              <span class="text-sm text-primary-700 dark:text-primary-300" aria-live="polite">
                {{ selectedRunIds.length }} run{{ selectedRunIds.length > 1 ? 's' : '' }} selected
              </span>
              <UButton
                v-if="selectedRunIds.length === 2"
                icon="i-lucide-git-compare-arrows"
                size="sm"
                color="primary"
                label="Compare"
                @click="compareSelectedRuns"
              />
              <span v-else-if="selectedRunIds.length === 1" class="text-xs text-primary-500">
                Select another run to compare
              </span>
              <UButton
                v-if="canDeleteRuns"
                icon="i-lucide-trash-2"
                size="sm"
                color="neutral"
                variant="outline"
                label="Delete"
                :title="`Delete the ${selectedRunIds.length === 1 ? 'selected run' : `${selectedRunIds.length} selected runs`}`"
                @click="deleteSelectedRuns"
              />
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-x"
                label="Clear"
                @click="selectedRunIds = []"
              />
            </div>

            <div v-if="keptRunsData.total > 0" class="flex items-center justify-end gap-1.5 mb-3">
              <label
                class="flex items-center gap-1.5 cursor-pointer select-none text-sm text-muted hover:text-default transition-colors"
                data-shot="kept-runs-toggle"
              >
                <UCheckbox v-model="keptOnly" size="sm" />
                Kept runs only ({{ filteredKeptRuns.length }})
              </label>
              <HelpHint topic="run.keep" />
            </div>

            <!-- md+ : the runs table; below md a card list keeps it scroll-free -->
            <div class="hidden md:block">
              <UTable
                v-if="tableRuns.length > 0"
                v-model:sorting="runsSorting"
                :data="pagedRuns"
                :columns="runsColumns"
                :ui="{
                  base: 'w-full border-separate border-spacing-0',
                  thead: '[&>tr]:bg-elevated/50 [&>tr]:after:content-none',
                  tbody: '[&>tr]:last:[&>td]:border-b-0 [&>tr]:hover:bg-gray-50 dark:[&>tr]:hover:bg-gray-900/50',
                  th: 'first:rounded-l-lg last:rounded-r-lg border-y border-default first:border-l last:border-r',
                  td: 'border-b border-default',
                }"
              >
                <template #select-header>
                  <input
                    type="checkbox"
                    :checked="allRunsSelected"
                    :indeterminate.prop="someRunsSelected"
                    class="cursor-pointer size-4 accent-primary"
                    :aria-label="allRunsSelected ? 'Deselect all runs' : 'Select all runs'"
                    @change="toggleAllRuns"
                  />
                </template>
                <template #select-cell="{ row }">
                  <input
                    type="checkbox"
                    :checked="isRunSelected(row.original.id)"
                    class="cursor-pointer size-4 accent-primary"
                    :aria-label="`Select run #${row.original.id}`"
                    @click.stop="toggleRunSelection(row.original.id)"
                  />
                </template>
                <template #id-cell="{ row }">
                  <div class="flex items-center gap-2">
                    <a
                      :href="runHref(row.original.id)"
                      class="text-primary hover:underline font-medium"
                      @click="onRunLinkClick($event, row.original.id)"
                    >
                      Run #{{ row.original.id }}
                    </a>
                    <DeferredTooltip v-if="row.original.keptAt" :text="describeKeep(row.original)">
                      <UIcon
                        name="i-lucide-lock"
                        class="size-3.5 shrink-0 text-muted"
                        :aria-label="`Run #${row.original.id} is kept forever`"
                      />
                    </DeferredTooltip>
                    <span v-if="row.original.label" class="text-xs text-gray-500 dark:text-gray-400 truncate max-w-32">
                      {{ row.original.label }}
                    </span>
                  </div>
                </template>
                <template #status-cell="{ row }">
                  <RunStatusBadge
                    :status="row.original.status"
                    class="cursor-pointer"
                    @click="openRun(row.original.id)"
                  />
                </template>
                <template #isFullRun-header>
                  <span class="inline-flex items-center gap-1">Scope <HelpHint topic="run.partial" /></span>
                </template>
                <template #isFullRun-cell="{ row }">
                  <DeferredTooltip :text="scopeTooltip(row.original)">
                    <UIcon
                      :name="row.original.isFullRun === false ? 'i-lucide-list-filter' : 'i-lucide-list-checks'"
                      class="size-4 shrink-0 cursor-help"
                      :class="row.original.isFullRun === false ? 'text-amber-500' : 'text-green-500'"
                    />
                  </DeferredTooltip>
                </template>
                <template #browsers-header>
                  <span class="sr-only">Browsers</span>
                </template>
                <template #browsers-cell="{ row }">
                  <div v-if="row.original.browsers?.length" class="flex items-center gap-1">
                    <BrowserBadge
                      v-for="name in row.original.browsers"
                      :key="name"
                      :browser="{ projectName: name }"
                      size="sm"
                    />
                  </div>
                </template>
                <template #startTime-cell="{ row }">
                  <ClientDate
                    :date="row.original.startTime"
                    class="text-xs text-gray-600 cursor-pointer"
                    @click="openRun(row.original.id)"
                  />
                </template>
                <template #environment-cell="{ row }">
                  <EnvironmentBadge v-if="row.original.environment" :name="row.original.environment" class="text-xs" />
                </template>
                <template #metadata-cell="{ row }">
                  <div
                    v-if="runBranch(row.original) || row.original.metadata?.scm?.commit"
                    class="flex items-center gap-1.5 flex-wrap text-xs cursor-pointer"
                    @click="openRun(row.original.id)"
                  >
                    <BranchLabel
                      v-if="runBranch(row.original)"
                      :name="runBranch(row.original)"
                      class="text-gray-600 dark:text-gray-300 max-w-[12rem]"
                    />
                    <code v-if="row.original.metadata?.scm?.commit" class="text-gray-500">
                      {{ row.original.metadata.scm.commit.substring(0, 7) }}
                    </code>
                  </div>
                </template>
                <template #duration-cell="{ row }">
                  <div class="space-y-1 cursor-pointer" @click="openRun(row.original.id)">
                    <TestStatusBar
                      :passed="row.original.passedTests"
                      :failed="row.original.failedTests"
                      :skipped="row.original.skippedTests"
                      :fixme="row.original.fixmeTests ?? 0"
                      :flaky="row.original.flakyTests"
                      :did-not-run="row.original.didNotRunTests ?? 0"
                      :total="row.original.totalTests"
                    />
                    <DurationValue :ms="row.original.duration" class="text-xs text-gray-500" />
                  </div>
                </template>
                <template #actions-header>
                  <span class="sr-only">Actions</span>
                </template>
                <template #actions-cell="{ row }">
                  <div class="flex justify-end">
                    <RunActionsMenu
                      :label="`Run #${row.original.id} actions`"
                      :items="() => runMenuItems(row.original)"
                    />
                  </div>
                </template>
              </UTable>
            </div>

            <!-- Below md: one card per run, hydrated only where it shows. No `>` in this
                 tag: Nuxt's lazy-hydration transform reads it with a parser that stops there. -->
            <LazyProjectRunCards
              v-if="tableRuns.length"
              hydrate-on-visible
              :runs="pagedRuns"
              :selected-run-ids="selectedRunIds"
              :menu-items="runMenuItems"
              @toggle="toggleRunSelection"
            />

            <div v-if="tableRuns.length > RUNS_PAGE_SIZE" class="flex justify-center mt-3">
              <UPagination
                v-model:page="runsPage"
                :total="tableRuns.length"
                :items-per-page="RUNS_PAGE_SIZE"
                size="sm"
                data-testid="runs-pagination"
              />
            </div>

            <div
              v-if="tableRuns.length === 0 && project?.testRuns && project.testRuns.length > 0"
              class="text-center py-8 text-gray-500"
            >
              {{ keptOnly ? 'No kept runs match the current filters.' : 'No test runs match the current filters.' }}
            </div>

            <EmptyState
              v-else-if="!project?.testRuns || project.testRuns.length === 0"
              icon="i-lucide-rocket"
              text="No test runs yet for this project."
            >
              <p class="text-xs text-gray-400 max-w-sm">
                Point the reporter's <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">projectName</code> at
                <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">{{ project?.name }}</code> to send results here
                — <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">npx @piwitests/reporter init</code> wires a
                Playwright project in one command, or see the
                <DocLink to="guide/reporter" no-icon class="text-primary hover:underline">reporter docs</DocLink> for
                manual setup.
              </p>
            </EmptyState>
          </UCard>
        </div>

        <!-- TESTS TAB -->
        <div v-if="activeTab === 'tests'" data-tour="project-tests-tab">
          <ProjectTestCasesTable
            :project-id="projectId"
            :project-name="project?.name"
            :scope="runScope"
            sync-query
            @total="testCasesTotal = $event"
          />
        </div>

        <!-- FAILURES TAB -->
        <div v-if="activeTab === 'failures'" class="space-y-4" data-tour="project-failures-tab">
          <div class="flex">
            <div class="inline-flex rounded-lg border border-default p-0.5 bg-elevated/40">
              <button
                v-for="seg in failureSegments"
                :key="seg.key"
                type="button"
                class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors"
                :class="failureSegment === seg.key ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-highlighted'"
                :aria-pressed="failureSegment === seg.key"
                @click="failureSegment = seg.key"
              >
                {{ seg.label }} <span class="tabular-nums text-muted">({{ seg.count }})</span>
              </button>
            </div>
          </div>

          <template v-if="failureSegment === 'clusters'">
            <ClusterMergeSuggestions
              :key="`sug-${clustersRefreshKey}`"
              :project-id="String(projectId)"
              @merged="
                clustersRefreshKey++;
                refreshClustersCount();
              "
            />
            <FailureClustersList
              :key="clustersRefreshKey"
              data-tour="failure-clusters-list"
              :project-id="String(projectId)"
              :initial-status="drill?.status ?? undefined"
              :scope="runScope"
              @count="clustersCount.total = $event"
            />
          </template>

          <FlakyTestsList
            v-else-if="failureSegment === 'flaky'"
            data-tour="flaky-tests-list"
            :project-id="String(projectId)"
            :scope="runScope"
            :project-name="project?.name"
            @count="flakyCount = $event"
            @quarantined="refreshQuarantineCount"
          />

          <QuarantineTable
            v-else
            data-tour="quarantine-list"
            :project-id="String(projectId)"
            :project-name="project?.name"
            hide-candidates
            @count="quarantineCount = $event"
          />
        </div>

        <!-- FLAKE LAB TAB -->
        <div v-if="activeTab === 'flake-lab'" data-tour="project-flake-lab-tab">
          <FlakeLabPanel :project-id="Number(projectId)" :scope="runScope" :project-name="project?.name" />
        </div>

        <!-- GAPS TAB -->
        <div v-if="activeTab === 'gaps'" data-tour="project-gaps-tab">
          <GapsPanel :project-id="Number(projectId)" />
        </div>

        <!-- PERFORMANCE TAB -->
        <div v-if="activeTab === 'performance'" class="space-y-4" data-tour="project-performance-tab">
          <ChartCard
            title="Performance trend"
            subtitle="Duration metrics per run, newest on the right"
            help="project.performance"
            data-shot="performance-trend"
            data-tour="project-performance-trend"
          >
            <template #actions>
              <USelect
                v-model="perfRunsWindow"
                :items="RUNS_WINDOW_OPTIONS"
                size="xs"
                class="w-36"
                aria-label="Runs in the trend"
              />
            </template>
            <LoadingState v-if="performanceInitialLoading" text="Loading chart…" />
            <PerformanceTrendChart
              v-else
              :data="performanceData || []"
              :markers="visibleMarkers"
              @marker-click="handleMarkerClick"
            />
          </ChartCard>

          <UCard data-shot="slowest-tests">
            <template #header>
              <h2 class="text-xl font-semibold inline-flex items-center gap-1" data-tour="slowest-tests">
                Slowest tests <HelpHint topic="project.slowest-tests" />
              </h2>
              <p class="text-sm text-gray-600 mt-1">Top 20 slowest tests across recent runs</p>
            </template>

            <LoadingState v-if="slowTestsLoading && slowTests === null" text="Loading…" />

            <TableScroller v-else-if="slowTests && slowTests.length > 0" min-width="52rem" :bleed="false">
              <UTable
                v-model:sorting="slowTestsSorting"
                :data="slowTests"
                :columns="slowTestsColumns"
                :ui="{
                  base: 'table-fixed border-separate border-spacing-0',
                  thead: '[&>tr]:bg-elevated/50 [&>tr]:after:content-none',
                  tbody: '[&>tr]:last:[&>td]:border-b-0',
                  th: 'first:rounded-l-lg last:rounded-r-lg border-y border-default first:border-l last:border-r',
                  td: 'border-b border-default',
                }"
              >
                <template #title-cell="{ row }">
                  <NuxtLink :to="`/test-cases/${row.original.id}`" class="block hover:underline">
                    <div class="font-medium">{{ row.original.title }}</div>
                    <div class="mt-1">
                      <OpenInIdeLink
                        :file-path="row.original.filePath"
                        :project-key="projectId"
                        :project-name="project?.name"
                        class="text-xs"
                        @click.stop
                      />
                    </div>
                  </NuxtLink>
                </template>
                <template #avgDuration-cell="{ row }">
                  <DurationValue v-if="row.original.avgDuration" :ms="row.original.avgDuration" class="tabular-nums" />
                  <span v-else class="text-gray-400">—</span>
                </template>
                <template #maxDuration-cell="{ row }">
                  <DurationValue v-if="row.original.maxDuration" :ms="row.original.maxDuration" class="tabular-nums" />
                  <span v-else class="text-gray-400">—</span>
                </template>
                <template #minDuration-cell="{ row }">
                  <DurationValue v-if="row.original.minDuration" :ms="row.original.minDuration" class="tabular-nums" />
                  <span v-else class="text-gray-400">—</span>
                </template>
                <template #latestDuration-cell="{ row }">
                  <DurationValue
                    v-if="row.original.latestDuration"
                    :ms="row.original.latestDuration"
                    class="tabular-nums"
                  />
                  <span v-else class="text-gray-400">—</span>
                </template>
                <template #trend-cell="{ row }">
                  <span v-if="row.original.trend === 'slower'" class="text-red-600 font-medium">▲ Slower</span>
                  <span v-else-if="row.original.trend === 'faster'" class="text-green-600 font-medium">▼ Faster</span>
                  <span v-else class="text-gray-500">&mdash; Stable</span>
                </template>
              </UTable>
            </TableScroller>

            <div v-else-if="slowTestsError" class="text-center py-8 text-red-500">
              Couldn't load the slowest tests — try refreshing.
            </div>

            <div v-else class="text-center py-8 text-gray-500">No slow test data available yet.</div>
          </UCard>

          <TimeoutOpportunitiesTable :project-id="String(projectId)" :project-name="project?.name" :scope="runScope" />

          <ProjectSlowEndpoints
            v-model:run-id="slowEndpointsRunId"
            :runs="filteredRuns"
            :project-id="String(projectId)"
          />

          <AiStepCoverage v-if="hasAiSteps" :project-id="String(projectId)" />
        </div>

        <!-- SETTINGS TAB -->
        <ProjectSettingsPanel
          v-if="activeTab === 'settings' && project"
          :project="project"
          data-tour="project-settings-tab"
          @saved="refresh()"
        />
      </div>
    </template>
  </UDashboardPanel>

  <!-- Markers slide-over -->
  <ClientOnly>
    <USlideover v-model:open="markersOpen" title="Timeline markers" :ui="{ content: 'max-w-2xl' }">
      <template #body>
        <ProjectTimeline
          :project-id="Number(projectId)"
          :markers="markers"
          :environments="availableEnvironments"
          :focus-marker-id="focusMarkerId"
          @changed="refreshMarkers"
          @clear-focus="focusMarkerId = null"
        />
      </template>
    </USlideover>
  </ClientOnly>

  <ClientOnly>
    <RunKeepModal v-model:open="isKeepOpen" :run-id="keepRunId" @kept="refreshAfterKeepChange" />
  </ClientOnly>

  <!-- Delete Project Modal -->
  <ClientOnly>
    <UModal
      :open="showDeleteProjectModal"
      :title="deletingProject ? 'Deleting project' : 'Delete project'"
      :dismissible="!deletingProject"
      :close="!deletingProject"
      @update:open="
        (val) => {
          if (!val) showDeleteProjectModal = false;
        }
      "
    >
      <template #body>
        <div v-if="deletingProject" class="space-y-4">
          <p class="text-sm text-highlighted leading-relaxed">
            Deleting <strong>{{ project?.label || project?.name }}</strong> and everything it holds. A project with a
            long history can take a few minutes.
          </p>
          <ProjectDeleteProgress :progress="deletionProgress" :elapsed-ms="deletionElapsedMs" />
        </div>
        <div v-else class="space-y-4">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            This will permanently delete <strong>{{ project?.label || project?.name }}</strong> and all its test runs,
            reports, traces, and failure clusters. This action cannot be undone.
          </p>
          <div>
            <label class="block text-sm font-medium mb-1">
              Type the project key <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">{{ project?.name }}</code> to
              confirm:
            </label>
            <UInput
              v-model="deleteProjectConfirmInput"
              :placeholder="project?.name"
              autofocus
              @keydown.enter="handleDeleteProject"
            />
          </div>
        </div>
      </template>
      <template #footer>
        <UButton
          v-if="!deletingProject"
          color="neutral"
          variant="ghost"
          label="Cancel"
          @click="showDeleteProjectModal = false"
        />
        <UButton
          color="error"
          :label="deletingProject ? 'Deleting…' : 'Delete project'"
          icon="i-lucide-trash-2"
          :disabled="!deleteProjectConfirmValid"
          :loading="deletingProject"
          @click="handleDeleteProject"
        />
      </template>
    </UModal>
  </ClientOnly>

  <ClientOnly>
    <RunsDeleteModal v-model:open="isDeleteRunsOpen" :runs="runsToDelete" @deleted="onRunsDeleted" />
  </ClientOnly>
</template>

<script setup lang="ts">
import type { FilterBarState } from '~/components/shared/FilterBar.vue';
import type { OpenFailureCluster, ProjectOverview, TestRunForChart } from '~~/types/api';
import { errorMessage } from '~/utils';
import type { FlakeLabInboxItem } from '#shared/handlers/flake-lab';

useHead({ title: 'Piwi Dashboard' });

// `lazy` so client-side navigation to Home is instant — the page renders a
// skeleton immediately instead of blocking on the fetch (which felt like a hang).
// On first SSR load the data still arrives in the payload, so there's no flash.
const {
  data: overview,
  error: overviewError,
  refresh: refreshOverview,
  status: overviewStatus,
} = useFetch('/api/projects/overview', {
  lazy: true,
  default: () => [] as ProjectOverview[],
  transform: (r: { items: ProjectOverview[] }) => r.items,
});
const {
  data: recentTestRuns,
  error: recentRunsError,
  refresh: refreshRecentRuns,
} = useFetch('/api/test-runs/recent', {
  lazy: true,
  transform: (r: { items: TestRunForChart[] }) => r.items,
});

// Open failure clusters across the visible projects — the "Open failures" card.
const { data: openClusters, refresh: refreshOpenClusters } = useFetch('/api/failure-clusters', {
  lazy: true,
  query: { status: 'open', limit: 50 },
  default: () => [] as OpenFailureCluster[],
  transform: (r: { items: OpenFailureCluster[] }) => r.items,
});

// Accepted-but-unwritten scenario gaps older than a week — the Home gaps queue.
// The queue follows the instance `test-map` state: an instance that declined it
// hides the card and never fetches it.
const { isHidden: instCapHidden } = await useInstanceCapabilities();
const gapsHidden = computed(() => instCapHidden('test-map'));
interface InboxGap {
  id: number;
  projectId: number;
  title: string;
  class: string;
  score: number | null;
}
const { data: inboxGaps } = useFetch('/api/gaps/inbox', {
  lazy: true,
  immediate: !gapsHidden.value,
  default: () => [] as InboxGap[],
  transform: (r: { items: InboxGap[] }) => r.items,
});

// Flaky tests waiting in the Flake Lab — hidden when the instance declined it.
// Fetched by the browser only: reading the suspects of each project's flaky
// tests takes seconds on a large instance, and the server render would wait.
const flakeLabHidden = computed(() => instCapHidden('flake-lab'));
const { data: flakeLabInbox } = useFetch('/api/flake-lab/inbox', {
  server: false,
  lazy: true,
  immediate: !flakeLabHidden.value,
  default: () => [] as FlakeLabInboxItem[],
  transform: (r: { items: FlakeLabInboxItem[] }) => r.items,
});

useRunStream(() => Promise.all([refreshOverview(), refreshRecentRuns(), refreshOpenClusters()]));

// True only before the first project-overview load resolves — drives the skeleton.
// Gated on `overview` (which decides projects-vs-onboarding) so a slow load can't
// flash the onboarding wizard, while a background SSE refetch (data already present)
// never replaces the page with a skeleton. A genuine "no projects yet" state
// resolves to success with empty data, so the wizard shows there.
const isInitialLoad = computed(() => overviewStatus.value === 'pending' && !overview.value?.length);

// A failed load must never be mistaken for "no projects yet" — that would
// render the onboarding wizard over what's actually a broken DB/API.
const loadError = computed(() => overviewError.value || recentRunsError.value);

function retryLoad(): void {
  refreshOverview();
  refreshRecentRuns();
}

// ── Filters (persisted to cookie, SSR-safe — no hydration flicker) ───────────

const filters = useCookie<FilterBarState>('piwi-home-filters', {
  default: () => ({ environments: [], branches: [], fullRunsOnly: true }),
  encode: (v) => JSON.stringify(v),
  decode: (v) => {
    try {
      return v
        ? { environments: [], branches: [], fullRunsOnly: true, ...(JSON.parse(v) as Partial<FilterBarState>) }
        : { environments: [], branches: [], fullRunsOnly: true };
    } catch {
      return { environments: [], branches: [], fullRunsOnly: true };
    }
  },
});

const availableEnvironments = computed(() => {
  const envSet = new Set<string>();
  for (const run of recentTestRuns.value ?? []) {
    if (run.environment) envSet.add(run.environment);
  }
  for (const project of overview.value ?? []) {
    for (const run of project.recentRuns) {
      if (run.environment) envSet.add(run.environment);
    }
  }
  return [...envSet].sort();
});

// ── Filtered data ─────────────────────────────────────────────────────────────

function matchesEnv(env: string | null | undefined): boolean {
  if (filters.value.environments.length === 0) return true;
  return !!env && filters.value.environments.includes(env);
}

const filteredRecentRuns = computed(() => {
  let runs = recentTestRuns.value ?? [];
  if (filters.value.fullRunsOnly) runs = runs.filter((r) => r.isFullRun);
  if (filters.value.environments.length > 0) runs = runs.filter((r) => matchesEnv(r.environment));
  return runs;
});

const filteredOverview = computed(() => {
  let projects = overview.value ?? [];
  if (filters.value.environments.length > 0) {
    projects = projects
      .map((p) => ({
        ...p,
        recentRuns: p.recentRuns.filter((r) => matchesEnv(r.environment)),
      }))
      .filter((p) => p.recentRuns.length > 0);
  }
  return projects;
});

// ── Stat strip ────────────────────────────────────────────────────────────────

const overviewStats = computed(() => {
  const projects = filteredOverview.value;
  const totalProjects = projects.length;
  const failingNow = projects.filter((p) => p.tendency === 'failing').length;
  const flakyNow = projects.filter((p) => p.tendency === 'flaky').length;

  let totalPassed = 0;
  let totalTests = 0;
  for (const p of projects) {
    if (p.latestFullRun) {
      totalPassed += p.latestFullRun.passedTests;
      totalTests += p.latestFullRun.totalTests;
    }
  }
  const avgPassRate = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : null;

  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const runs24h = filteredRecentRuns.value.filter((r) => new Date(r.startTime).getTime() > oneDayAgo).length;

  return { totalProjects, failingNow, flakyNow, avgPassRate, runs24h };
});

// ── Recent activity ───────────────────────────────────────────────────────────

const RUNNING_STATUSES = new Set(['running', 'initializing', 'finalizing']);
const ACTIVITY_PREVIEW_LIMIT = 6;

const activityExpanded = useViewState('activity-expanded', () => false);

const allActivity = computed(() => {
  const runs = [...filteredRecentRuns.value];
  // Running runs first, then by start time desc
  return runs.sort((a, b) => {
    const aR = RUNNING_STATUSES.has(a.status) ? 0 : 1;
    const bR = RUNNING_STATUSES.has(b.status) ? 0 : 1;
    if (aR !== bR) return aR - bR;
    return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
  });
});

const visibleActivity = computed(() =>
  activityExpanded.value ? allActivity.value : allActivity.value.slice(0, ACTIVITY_PREVIEW_LIMIT),
);

const hasMoreActivity = computed(() => allActivity.value.length > ACTIVITY_PREVIEW_LIMIT);

const hasActivity = computed(() => filteredRecentRuns.value.length > 0);
const hasProjects = computed(() => (overview.value?.length ?? 0) > 0);

// ── Stat-strip links ──────────────────────────────────────────────────────────
// The "failing now" number narrows the Project health table to failing projects;
// "runs today" expands the Recent activity card. Both are in-page filters, so
// they set state rather than navigate.

const healthFilter = useViewState<'all' | 'failing'>('health-filter', () => 'all');

const healthProjects = computed(() =>
  healthFilter.value === 'failing'
    ? filteredOverview.value.filter((p) => p.tendency === 'failing')
    : filteredOverview.value,
);

function focusFailingProjects(): void {
  if (overviewStats.value.failingNow === 0) return;
  healthFilter.value = 'failing';
  if (import.meta.client)
    document.getElementById('project-health')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function expandActivity(): void {
  if (overviewStats.value.runs24h === 0) return;
  activityExpanded.value = true;
  if (import.meta.client)
    document.getElementById('recent-activity')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Runs that exist (within the environment filter) but are hidden by "Full runs
// only" — without this, a project's very first (partial) run reads as if
// nothing arrived: 0 runs today, no recent activity, "No full runs" everywhere.
const hiddenPartialRunsCount = computed(() => {
  if (!filters.value.fullRunsOnly) return 0;
  const runs = recentTestRuns.value ?? [];
  const envScoped = runs.filter((r) => matchesEnv(r.environment));
  return envScoped.filter((r) => !r.isFullRun).length;
});

function showPartialRuns(): void {
  filters.value = { ...filters.value, fullRunsOnly: false };
}

const filtersActive = computed(() => filters.value.environments.length > 0 || !filters.value.fullRunsOnly);

function resetFilters(): void {
  filters.value = { environments: [], branches: [], fullRunsOnly: true };
}

const filtersSummary = computed(() =>
  filterBarSummary(filters.value, {
    branches: false,
    hidden: hiddenPartialRunsCount.value > 0 ? [hiddenRunsPhrase(hiddenPartialRunsCount.value, 'partial')] : [],
  }),
);

// ── Activity list ────────────────────────────────────────────────────────────

function statusBorderClass(status: string): string {
  switch (statusPaletteKey(status)) {
    case 'passed':
      return 'border-l-status-passed';
    case 'failed':
      return 'border-l-status-failed';
    case 'running':
      return 'border-l-status-running';
    default:
      return 'border-l-status-skipped';
  }
}

// Coming back to Home scrolls it to where the user left it.
useViewScroll(() => dashboardPanelBody('home'));
</script>

<template>
  <UDashboardPanel id="home">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <UBreadcrumb :items="[{ label: 'Home', icon: 'i-lucide-house', to: '/' }]" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="loadError" class="p-6">
        <ErrorState :text="`Couldn't load the dashboard: ${errorMessage(loadError)}`">
          <template #action>
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="retryLoad">
              Retry
            </UButton>
          </template>
        </ErrorState>
      </div>

      <!-- Skeleton while the first load resolves (client-side navigation to Home) -->
      <div v-else-if="isInitialLoad" class="p-6 space-y-8" aria-busy="true">
        <span class="sr-only" role="status">Loading dashboard…</span>
        <USkeleton class="h-14 w-full rounded-xl" />
        <div class="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
          <div class="xl:col-span-2 space-y-3">
            <USkeleton class="h-7 w-40" />
            <USkeleton class="h-72 w-full rounded-lg" />
          </div>
          <div class="space-y-3">
            <USkeleton class="h-7 w-32" />
            <USkeleton v-for="i in 5" :key="i" class="h-12 w-full rounded-lg" />
          </div>
        </div>
      </div>

      <div v-else class="p-6 space-y-8">
        <!-- The note names the partial runs "Full runs only" hides — without it, a
             project's first (partial) run reads as if nothing arrived. -->
        <FiltersBlock
          v-if="hasProjects"
          inline
          inset
          :summary="filtersSummary"
          :resettable="filtersActive"
          data-shot="home-filters"
          @reset="resetFilters"
        >
          <FilterBar
            v-model="filters"
            :available-environments="availableEnvironments"
            :available-branches="[]"
            :show-reset="false"
          />
          <template v-if="hiddenPartialRunsCount > 0" #notes>
            <HiddenRunsNote :partial-runs="hiddenPartialRunsCount" @include-partial="showPartialRuns" />
          </template>
        </FiltersBlock>

        <!-- Compact stat strip (full-run-aware) — every number is a link -->
        <div
          v-if="hasProjects"
          class="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm border border-gray-200 dark:border-gray-700 rounded-xl px-6 py-4 bg-gray-50 dark:bg-gray-900/50"
        >
          <NuxtLink to="/projects" class="flex items-center gap-1.5 hover:underline">
            <UIcon name="i-lucide-folder" class="size-4 text-primary shrink-0" />
            <span class="font-semibold tabular-nums">{{ overviewStats.totalProjects }}</span>
            <span class="text-gray-500">projects</span>
          </NuxtLink>

          <button
            type="button"
            class="flex items-center gap-1.5"
            :class="overviewStats.failingNow > 0 ? 'hover:underline cursor-pointer' : 'cursor-default'"
            @click="focusFailingProjects"
          >
            <div
              class="w-2 h-2 rounded-full shrink-0"
              :class="overviewStats.failingNow > 0 ? STATUS_PALETTE.failed.bg : STATUS_PALETTE.passed.bg"
            />
            <span
              class="font-semibold tabular-nums"
              :class="overviewStats.failingNow > 0 ? STATUS_PALETTE.failed.text : ''"
              >{{ overviewStats.failingNow }}</span
            >
            <span class="text-gray-500">failing now</span>
          </button>

          <NuxtLink to="/analytics" class="flex items-center gap-1.5 hover:underline">
            <div
              class="w-2 h-2 rounded-full shrink-0"
              :class="overviewStats.flakyNow > 0 ? STATUS_PALETTE.flaky.bg : 'bg-gray-300 dark:bg-gray-600'"
            />
            <span
              class="font-semibold tabular-nums"
              :class="overviewStats.flakyNow > 0 ? STATUS_PALETTE.flaky.text : ''"
              >{{ overviewStats.flakyNow }}</span
            >
            <span class="text-gray-500">flaky</span>
          </NuxtLink>

          <div v-if="overviewStats.avgPassRate !== null" class="flex items-center gap-1.5">
            <UIcon
              name="i-lucide-check-circle"
              class="size-4 shrink-0"
              :class="passRateTextClass(overviewStats.avgPassRate)"
            />
            <span class="font-semibold tabular-nums" :class="passRateTextClass(overviewStats.avgPassRate)"
              >{{ overviewStats.avgPassRate }}%</span
            >
            <span class="text-gray-500">avg pass rate</span>
          </div>

          <button
            type="button"
            class="flex items-center gap-1.5"
            :class="overviewStats.runs24h > 0 ? 'hover:underline cursor-pointer' : 'cursor-default'"
            @click="expandActivity"
          >
            <UIcon name="i-lucide-play-circle" class="size-4 text-primary shrink-0" />
            <span class="font-semibold tabular-nums">{{ overviewStats.runs24h }}</span>
            <span class="text-gray-500">runs today</span>
          </button>
        </div>

        <!-- Per-project trend table + Recent activity side by side on wide screens -->
        <div v-if="hasProjects || hasActivity" class="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
          <div id="project-health" class="xl:col-span-2 space-y-2 scroll-mt-4">
            <div
              v-if="healthFilter === 'failing'"
              class="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400"
            >
              <span>Showing failing projects only</span>
              <UButton size="xs" variant="ghost" icon="i-lucide-x" @click="healthFilter = 'all'">Clear</UButton>
            </div>
            <ProjectTrendTable v-if="hasProjects" :projects="healthProjects" data-tour="project-health" />
          </div>

          <!-- Recent activity -->
          <SectionCard
            id="recent-activity"
            v-if="hasActivity"
            icon="i-lucide-activity"
            title="Recent activity"
            class="scroll-mt-4"
          >
            <template #actions>
              <UButton
                v-if="hasMoreActivity && !activityExpanded"
                variant="ghost"
                size="sm"
                trailing-icon="i-lucide-chevron-down"
                @click="activityExpanded = true"
              >
                Show all {{ allActivity.length }}
              </UButton>
              <UButton
                v-else-if="activityExpanded"
                variant="ghost"
                size="sm"
                trailing-icon="i-lucide-chevron-up"
                @click="activityExpanded = false"
              >
                Show less
              </UButton>
            </template>

            <div class="divide-y divide-gray-100 dark:divide-gray-800 text-sm">
              <NuxtLink
                v-for="run in visibleActivity"
                :key="run.id"
                :to="`/test-runs/${run.id}`"
                class="flex items-center gap-3 py-3 pl-3 border-l-2 hover:bg-gray-50 dark:hover:bg-gray-800/60 rounded-r transition-colors"
                :class="statusBorderClass(run.status)"
              >
                <RunStatusBadge :status="run.status" />
                <div class="flex-1 min-w-0">
                  <div class="font-medium truncate">{{ run.projectLabel || run.projectName }}</div>
                  <div class="text-xs text-gray-400">Run #{{ run.id }} · {{ formatRelativeTime(run.startTime) }}</div>
                </div>
                <div class="text-right tabular-nums shrink-0">
                  <div :class="passRateTextClass(passRate(run))">{{ passRate(run) }}%</div>
                  <DurationValue v-if="run.duration" :ms="run.duration" class="block text-xs text-gray-400" />
                </div>
              </NuxtLink>
            </div>
          </SectionCard>
        </div>

        <!-- Open failures across the visible projects — one click to a failing cluster -->
        <OpenFailuresCard
          v-if="hasProjects"
          data-shot="open-failures"
          :clusters="openClusters"
          @changed="refreshOpenClusters"
        />

        <!-- Accepted-but-unwritten scenario gaps — the gaps inbox queue -->
        <SectionCard
          v-if="!gapsHidden && inboxGaps.length > 0"
          data-shot="gaps-inbox"
          icon="i-lucide-radar"
          title="Accepted gaps not yet written"
        >
          <div class="divide-y divide-default text-sm">
            <NuxtLink
              v-for="gap in inboxGaps"
              :key="gap.id"
              :to="`/projects/${gap.projectId}?tab=gaps&gapStatus=accepted`"
              class="flex items-center gap-3 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/60 rounded transition-colors"
            >
              <UBadge color="neutral" variant="subtle" size="sm">{{ gap.class }}</UBadge>
              <span class="flex-1 min-w-0 truncate text-highlighted">{{ gap.title }}</span>
              <span class="text-xs text-muted tabular-nums shrink-0">{{ (gap.score ?? 0).toFixed(3) }}</span>
            </NuxtLink>
          </div>
        </SectionCard>

        <!-- Flaky tests the Flake Lab can move forward: verify a fix, reproduce under an untested suspect -->
        <FlakeLabInboxCard
          v-if="!flakeLabHidden && flakeLabInbox.length > 0"
          data-shot="flake-lab-inbox"
          :items="flakeLabInbox"
        />

        <!-- Empty state when projects exist but all filtered out -->
        <div
          v-if="hasProjects && !hasActivity && filteredOverview.length === 0"
          class="text-center py-12 text-gray-500 dark:text-gray-400"
        >
          <UIcon name="i-lucide-filter-x" class="size-8 mx-auto mb-2 opacity-40" />
          <p>No runs match the current filters.</p>
        </div>

        <!-- Empty instance: the setup wizard is the one actionable step. Once
             projects exist it moves to /setup, which stays reachable from the
             sidebar — the steps past "install the reporter" must not vanish. -->
        <GetStartedWizard v-if="!hasProjects" show-capability-step />
      </div>
    </template>
  </UDashboardPanel>
</template>

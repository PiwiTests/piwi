<script setup lang="ts">
import { testLabel } from '#shared/utils/test-label';
import { describeCluster } from '#shared/describe-cluster';
import type { ApiResponse, TestCaseHistoryPoint, MarkerInfo, MarkersResponse } from '~~/types/api';
import { CASE_STATUS_SERIES, legendOf } from '~/utils/chart';
import { refetchKeeping } from '~/utils/refetch-keeping';
import type { RunWhat } from '~/composables/useRunPlace';

const route = useRoute();
const testCaseId = route.params.id;

// Compare with team instance (desktop app): the team instance's CI for this test, once the page shows.
const { comparison: teamComparison, shown: teamComparisonShown } = useTeamComparison('test-case', () =>
  String(testCaseId),
);

type TestCaseDetail = ApiResponse<typeof import('~~/server/api/test-cases/[id].get').default>;
const { data: testCase, error: testCaseError } = await useFetch<TestCaseDetail>(`/api/test-cases/${testCaseId}`);
if (testCaseError.value) showPageLoadError(testCaseError.value, 'test');
// Every later read of the test keeps the one the page shows when it fails, a read asked from outside the page (the
// assistant, once a proposal is applied) included.
const refresh = refetchKeeping(testCase, () => $fetch<TestCaseDetail>(`/api/test-cases/${testCaseId}`));
usePageReload(refresh);
const { data: historyData } = await useFetch(`/api/test-cases/${testCaseId}/history`, {
  transform: (r: { items: TestCaseHistoryPoint[] }) => r.items,
});
/** The environment of each of the test's recent runs, one per run: the desktop app's lab starts on the most common. */
const historyEnvironmentIds = computed(() => {
  const byRun = new Map<number, number | null>();
  for (const point of historyData.value ?? []) {
    if (!byRun.has(point.runId)) byRun.set(point.runId, point.environmentId ?? null);
  }
  return [...byRun.values()];
});
provideExternalIdUrl(() => testCase.value?.project?.externalIdUrl);
provideTestManagementKeys(() => testCase.value?.project?.id);

// Project timeline markers, overlaid on the history chart for context.
const historyMarkers = ref<MarkerInfo[]>([]);
watch(
  () => testCase.value?.project?.id,
  async (pid) => {
    if (!pid) return;
    try {
      historyMarkers.value = (await $fetch<MarkersResponse>(`/api/projects/${pid}/markers`)).items ?? [];
    } catch {
      // markers are optional context
    }
  },
  { immediate: true },
);
// A marker clicked on the history chart opens in the project's markers panel.
function openProjectMarker(markerId: number) {
  const pid = testCase.value?.project?.id;
  if (pid) navigateTo(`/projects/${pid}?tab=runs&marker=${markerId}`);
}

useHead(
  computed(() => ({
    title: `${testCase.value?.title || `Test #${testCaseId}`} — Piwi Dashboard`,
  })),
);

const passRate = computed<number | null>(() => testCase.value?.passRate ?? null);

/** A run of this test on this computer: by its title, up to 20 times with a trace, until the failure that comes and goes. */
const REPEAT_PRESET = { mode: 'grep', repeatEach: 20, stopAtFirstFailure: true, trace: true } as const;
const reproduceCases = computed(() =>
  testCase.value?.filePath ? [{ filePath: testCase.value.filePath, title: testCase.value.title, line: null }] : [],
);

const clusterColor = (status: string) => {
  return status === 'open' ? 'error' : status === 'resolved' ? 'success' : 'neutral';
};

const passRateClass = computed(() => passRateTextClass(passRate.value));

// Overview holds the page as it was; Trend holds the stability trend over time;
// Flakiness, for a flaky test, the suspects its history points at.
const TABS = [
  { value: 'overview', label: 'Overview', icon: 'i-lucide-list-checks' },
  { value: 'trend', label: 'Trend', icon: 'i-lucide-activity' },
  { value: 'flakiness', label: 'Flakiness', icon: 'i-lucide-search-check' },
] as const;
type TabValue = (typeof TABS)[number]['value'];

const { isHidden: capabilityHidden, state: capabilityState } = await useProjectCapabilities(
  testCase.value?.project?.id ?? 0,
);
// How the test's path varies across its executions, where the project records coverage.
const showPathVariation = computed(
  () => Boolean(testCase.value?.project?.id) && capabilityState('coverage') === 'active',
);
const showFlakiness = computed(() => (testCase.value?.flakyRuns ?? 0) > 0 && !capabilityHidden('flake-lab'));
const visibleTabs = computed(() => TABS.filter((t) => t.value !== 'flakiness' || showFlakiness.value));

// The run button: this test by its newest execution, and for a flaky test its Flake Lab experiments, which CI runs. In
// the desktop window, this computer runs the test until it fails, and the Flakiness tab its Flake Lab.
const runPlace = await useRunPlace({
  projectId: testCase.value?.project?.id ?? 0,
  machine: await useRunOnMyMachine(testCase.value?.project?.id ?? 0),
  whats: () => {
    const tc = testCase.value;
    if (!tc) return [];
    const local = reproduceCases.value.length
      ? { label: 'Run this test', cases: reproduceCases.value, runTitle: testLabel(tc) }
      : null;
    // A test with no execution to name runs on this computer alone, by its file and title.
    const test: RunWhat | null = tc.lastExecutionId
      ? executionTestWhat(tc.lastExecutionId, testLabel(tc))
      : local && { key: 'test', label: 'This test', count: 1, tests: [testLabel(tc)], app: null, ci: null };
    if (!test) return [];
    const whats: RunWhat[] = [{ ...test, local }];
    if (showFlakiness.value) {
      const lab = { reason: 'The Flakiness tab runs Flake Lab on this computer.' };
      whats.push({ ...flakeLabWhat(tc.id, 'reproduce'), local: lab }, { ...flakeLabWhat(tc.id, 'verify'), local: lab });
    }
    return whats;
  },
  prefersCi: () => false,
  thisComputer: {
    projectLabel: () => testCase.value?.project?.label ?? testCase.value?.project?.name,
    presetOptions: REPEAT_PRESET,
  },
});

const router = useRouter();
const activeTab = computed<TabValue>({
  get: () => {
    const tab = visibleTabs.value.find((t) => t.value === route.query.tab);
    return tab ? tab.value : 'overview';
  },
  set: (tab) => router.replace({ query: { ...route.query, tab: tab === 'overview' ? undefined : tab } }),
});
const tabNavItems = computed(() =>
  visibleTabs.value.map((t) => ({
    label: t.label,
    icon: t.icon,
    active: activeTab.value === t.value,
    'aria-current': activeTab.value === t.value ? ('true' as const) : undefined,
    onSelect: () => (activeTab.value = t.value),
  })),
);
const tabSelectItems = computed(() => visibleTabs.value.map((t) => ({ label: t.label, value: t.value })));
const activeTabIcon = computed(() => TABS.find((t) => t.value === activeTab.value)?.icon);

// Each tab keeps its scroll position for when the user comes back to the test.
useViewScroll(
  () => dashboardPanelBody('test-case-evolution'),
  () => activeTab.value,
);
</script>

<template>
  <UDashboardPanel id="test-case-evolution">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav
            :items="[
              { label: 'Home', icon: 'i-lucide-house', to: '/' },
              { label: 'Projects', to: '/projects' },
              ...(testCase?.project?.id
                ? [
                    {
                      label: testCase.project.label || testCase.project.name || 'Project',
                      to: `/projects/${testCase.project.id}`,
                    },
                  ]
                : [{ label: 'Project' }]),
              { label: (testCase ? testLabel(testCase) : '') || `Test #${testCaseId}` },
            ]"
          />
        </template>
        <template #right>
          <NavbarActions :actions="[{ label: 'Refresh', icon: 'i-lucide-refresh-cw', onClick: () => refresh() }]" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex flex-col gap-4 max-sm:px-4" data-shot="test-case-detail">
        <!-- Header: title, a single facts line, and the two actions. The title
             wraps and the actions drop below it on phones. -->
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4" data-tour="test-case-header">
          <div class="flex-1 min-w-0 space-y-2">
            <h1 class="text-xl font-bold break-words" :title="testCase?.displayTitle ? testCase.title : undefined">
              <TestIdChip v-if="testCase?.externalId" :external-id="testCase.externalId" class="mr-2 align-middle" />{{
                testCase ? testLabel(testCase) : ''
              }}
            </h1>
            <OpenInIdeLink
              v-if="testCase?.filePath"
              :file-path="testCase.filePath"
              :project-key="testCase?.project?.id"
              :project-name="testCase?.project?.name"
              class="text-sm text-gray-500"
            />
            <UBadge v-if="testCase?.project" color="neutral" variant="soft" size="xs" class="font-mono">
              {{ testCase.project.label ?? testCase.project.name }}
            </UBadge>

            <TestMetaBadges
              v-if="testCase?.tags?.length || testCase?.locks?.length"
              :tags="testCase?.tags"
              :locks="testCase?.locks"
            />

            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span class="tabular-nums">
                <strong class="text-highlighted">{{ testCase?.totalRuns ?? 0 }}</strong> runs
              </span>
              <span aria-hidden class="opacity-40">·</span>
              <span class="tabular-nums">
                <strong :class="passRateClass">{{ passRate !== null ? `${passRate}%` : '—' }}</strong> pass
              </span>
              <span aria-hidden class="opacity-40">·</span>
              <span class="tabular-nums">
                <strong :class="STATUS_PALETTE.failed.text">{{ testCase?.failedRuns ?? 0 }}</strong> failed
              </span>
              <span aria-hidden class="opacity-40">·</span>
              <span class="inline-flex items-center gap-1">
                avg <DurationValue :ms="testCase?.avgDuration" class="text-highlighted" />
              </span>
              <span aria-hidden class="opacity-40">·</span>
              <span class="tabular-nums">
                <strong :class="(testCase?.flakyRuns ?? 0) > 0 ? STATUS_PALETTE.flaky.text : 'text-highlighted'">
                  {{ testCase?.flakyRuns ?? 0 }}
                </strong>
                flaky
              </span>
              <span aria-hidden class="opacity-40">·</span>
              <span>last run {{ testCase?.lastRunAt ? formatRelativeTime(testCase.lastRunAt) : '—' }}</span>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <RunButton :place="runPlace" data-tour="test-run-button" />
            <RunDialog :place="runPlace" />
            <TestCaseMergeButton
              v-if="testCase?.project"
              :test-case-id="testCase.id"
              :project-id="testCase.project.id"
              :label="testLabel(testCase)"
              @merged="refresh()"
            />
            <NuxtLink
              v-if="testCase?.lastExecutionId"
              :to="`/test-run-cases/${testCase.lastExecutionId}`"
              data-tour="test-latest-execution"
            >
              <UButton size="sm" variant="outline" trailing-icon="i-lucide-arrow-right">Latest execution</UButton>
            </NuxtLink>
          </div>
        </div>

        <!-- Mobile: a select replaces the tab strip; the strip shows from sm up. -->
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

        <TestCaseStabilityTrend
          v-if="activeTab === 'trend'"
          :test-case-id="Number(testCaseId)"
          :markers="historyMarkers"
        />

        <FlakinessTab
          v-else-if="activeTab === 'flakiness'"
          :test-case-id="Number(testCaseId)"
          :project-id="testCase.project?.id ?? null"
          :project-label="testCase.project?.label ?? testCase.project?.name ?? null"
          :carried-environment-ids="historyEnvironmentIds"
        />

        <div v-else class="flex flex-col gap-4" data-tour="test-overview">
          <!-- Duration trend, with the execution strip as its footer row -->
          <ChartCard
            v-if="historyData && historyData.length"
            title="Duration trend"
            icon="i-lucide-trending-up"
            help="case.history-chart"
            data-tour="test-duration-trend"
            :legend="historyData.length > 1 ? legendOf(CASE_STATUS_SERIES) : undefined"
          >
            <TestCaseHistoryChart
              v-if="historyData.length > 1"
              :data="historyData"
              :height="200"
              :markers="historyMarkers"
              @marker-click="openProjectMarker"
            />
            <p v-else class="text-center py-4 text-sm text-gray-400">Need at least 2 runs to show a trend.</p>

            <template #footer>
              <HistoryStrip :history="historyData" />
            </template>
          </ChartCard>

          <!-- Desktop app: the test on the team instance its folder is linked to (Compare with team instance) -->
          <SectionCard
            v-if="teamComparisonShown"
            icon="i-lucide-users"
            title="Team CI"
            subtitle="This test on the team instance, by the environment its CI ran it in"
            data-shot="test-case-team-ci"
          >
            <TeamComparisonLine :comparison="teamComparison!" />
          </SectionCard>

          <!-- Recent executions -->
          <SectionCard
            icon="i-lucide-list-checks"
            :title="`Recent executions (${testCase?.recentExecutions?.length ?? 0})`"
          >
            <div v-if="testCase?.recentExecutions?.length" class="rounded-lg border border-default overflow-hidden">
              <TestRow
                v-for="exec in testCase.recentExecutions"
                :key="exec.id"
                :href="`/test-run-cases/${exec.id}`"
                :title="formatRelativeTime(exec.startTime)"
                :status="exec.status"
                :ended-at-stop="exec.endedAtStop"
                :error="exec.error"
                :issue="exec.knownIssue"
                :project-key="testCase?.project?.id"
                :project-name="testCase?.project?.name"
              >
                <template #metrics>
                  <span
                    v-if="exec.runOrigin === 'request'"
                    class="text-xs text-muted shrink-0"
                    title="A run you asked for from the dashboard: only you see it, and it stays out of everything the team sees"
                    >On your machine</span
                  >
                  <DurationValue v-if="exec.duration !== null" :ms="exec.duration" />
                  <UBadge
                    v-if="exec.retries && exec.retries > 0"
                    color="warning"
                    variant="soft"
                    size="xs"
                    :title="`${exec.retries + 1} attempts`"
                  >
                    {{ exec.retries + 1 }} attempts
                  </UBadge>
                  <NuxtLink :to="`/test-runs/${exec.runId}`" class="text-primary hover:underline shrink-0" @click.stop>
                    {{ exec.runLabel ? `${exec.runLabel} (#${exec.runId})` : `run #${exec.runId}` }}
                  </NuxtLink>
                </template>
              </TestRow>
            </div>
            <EmptyState v-else icon="i-lucide-inbox" text="No executions yet" />
          </SectionCard>

          <PathVariationCard
            v-if="showPathVariation"
            :test-case-id="Number(testCaseId)"
            :project-id="testCase!.project!.id"
            :project-name="testCase?.project?.name"
          />

          <!-- Locators of the latest execution, each with who else uses it -->
          <SectionCard
            v-if="testCase?.lastExecutionId"
            icon="i-lucide-crosshair"
            title="Locators"
            subtitle="From the latest execution"
            data-shot="test-case-locators"
          >
            <ExecutionLocatorsCard
              :test-runs-case-id="testCase.lastExecutionId"
              :project-key="testCase?.project?.id"
              :project-name="testCase?.project?.name"
            />
          </SectionCard>

          <!-- Failure clusters -->
          <SectionCard
            v-if="testCase?.failureClusters?.length"
            icon="i-lucide-bug"
            :title="`Failure clusters (${testCase.failureClusters.length})`"
            help="cluster.concept"
          >
            <div class="space-y-1">
              <NuxtLink
                v-for="cluster in testCase.failureClusters"
                :key="cluster.id"
                :to="`/failure-clusters/${cluster.id}`"
                class="flex items-center gap-2 py-2 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <UBadge :color="clusterColor(cluster.status)" variant="soft" size="xs" class="shrink-0">
                  {{ formatTriageStatus(cluster.status) }}
                </UBadge>
                <span class="text-sm truncate min-w-0" :title="cluster.signature">{{ describeCluster(cluster) }}</span>
                <span v-if="cluster.occurrences > 1" class="text-xs text-gray-400 shrink-0">
                  {{ cluster.occurrences }} occurrences
                </span>
                <UIcon name="i-lucide-arrow-right" class="size-3.5 text-muted shrink-0 ml-auto" />
              </NuxtLink>
            </div>
          </SectionCard>

          <!-- Entity links -->
          <SectionCard
            v-if="testCase?.links?.length"
            icon="i-lucide-link"
            title="Links"
            help="shared.entity-links"
            data-tour="test-links"
          >
            <EntityLinks
              entity-type="test_case"
              :entity-id="Number(testCaseId)"
              :links="(testCase.links as any) ?? null"
            />
          </SectionCard>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

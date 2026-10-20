<script setup lang="ts">
import { testLabel } from '#shared/utils/test-label';
import { describeCluster } from '#shared/describe-cluster';
import type { ApiResponse, TestCaseHistoryPoint, MarkerInfo, MarkersResponse } from '~~/types/api';
import { CASE_STATUS_SERIES, legendOf } from '~/utils/chart';

const route = useRoute();
const testCaseId = route.params.id;

const {
  data: testCase,
  error: testCaseError,
  refresh,
} = await useFetch<ApiResponse<typeof import('~~/server/api/test-cases/[id].get').default>>(
  `/api/test-cases/${testCaseId}`,
);
if (testCaseError.value) showPageLoadError(testCaseError.value, 'test');
const { data: historyData } = await useFetch(`/api/test-cases/${testCaseId}/history`, {
  transform: (r: { items: TestCaseHistoryPoint[] }) => r.items,
});
provideExternalIdUrl(() => testCase.value?.project?.externalIdUrl);

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
function goToProjectRuns() {
  const pid = testCase.value?.project?.id;
  if (pid) navigateTo(`/projects/${pid}?tab=runs`);
}

useHead(
  computed(() => ({
    title: `${testCase.value?.title || `Test #${testCaseId}`} — Piwi Dashboard`,
  })),
);

const passRate = computed<number | null>(() => testCase.value?.passRate ?? null);

// Desktop shell: reproduce this test on this machine. Selected by title so no
// line number is needed; repeat ×20 with a trace is the flake-hunting preset.
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
      <div class="flex flex-col gap-4 p-4" data-shot="test-case-detail">
        <!-- Header: title, a single facts line, and the two actions. The title
             wraps and the actions drop below it on phones. -->
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
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
            <DesktopRunLocallyButton
              :project-id="testCase?.project?.id"
              :project-label="testCase?.project?.label ?? testCase?.project?.name"
              :cases="reproduceCases"
              label="Reproduce locally"
              :preset-options="{ mode: 'grep', repeatEach: 20, trace: true }"
            />
            <NuxtLink v-if="testCase?.lastExecutionId" :to="`/test-run-cases/${testCase.lastExecutionId}`">
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
        />

        <template v-else>
          <!-- Duration trend, with the execution strip as its footer row -->
          <ChartCard
            v-if="historyData && historyData.length"
            title="Duration trend"
            icon="i-lucide-trending-up"
            help="case.history-chart"
            :legend="historyData.length > 1 ? legendOf(CASE_STATUS_SERIES) : undefined"
          >
            <TestCaseHistoryChart
              v-if="historyData.length > 1"
              :data="historyData"
              :height="200"
              :markers="historyMarkers"
              @marker-click="goToProjectRuns"
            />
            <p v-else class="text-center py-4 text-sm text-gray-400">Need at least 2 runs to show a trend.</p>

            <template #footer>
              <HistoryStrip :history="historyData" compact />
            </template>
          </ChartCard>

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
                :error="exec.error"
                :issue="exec.knownIssue"
                :project-key="testCase?.project?.id"
                :project-name="testCase?.project?.name"
              >
                <template #metrics>
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
          <SectionCard v-if="testCase?.links?.length" icon="i-lucide-link" title="Links" help="shared.entity-links">
            <EntityLinks
              entity-type="test_case"
              :entity-id="Number(testCaseId)"
              :links="(testCase.links as any) ?? null"
            />
          </SectionCard>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>

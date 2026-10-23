<script setup lang="ts">
import type { AnalyticsPortfolioRow } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string> }>();

const {
  data: rows,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsPortfolioRow[]>('portfolio', () => props.query);

function deltaMeta(delta: number | null): { icon: string; class: string } | null {
  if (delta === null || Math.abs(delta) < 1) return null;
  return delta > 0
    ? { icon: 'i-lucide-trending-up', class: PASS_RATE_TONES.good.text }
    : { icon: 'i-lucide-trending-down', class: PASS_RATE_TONES.poor.text };
}
</script>

<template>
  <SectionCard
    icon="i-lucide-table-properties"
    title="Portfolio health"
    :count="rows?.length || undefined"
    help="analytics.portfolio"
    data-tour="analytics-portfolio"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the portfolio: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!rows || rows.length === 0" text="No projects with runs in this period." />
    <template v-else>
      <!-- Mobile: card list -->
      <div class="md:hidden space-y-3">
        <div
          v-for="row in rows"
          :key="row.projectId"
          class="rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-2"
        >
          <div class="flex items-center justify-between gap-2">
            <NuxtLink :to="`/projects/${row.projectId}`" class="font-medium truncate hover:text-primary">
              {{ row.label || row.name }}
            </NuxtLink>
            <span class="tabular-nums font-semibold shrink-0" :class="passRateTextClass(row.passRate)">
              {{ row.passRate !== null ? `${row.passRate}%` : '—' }}
            </span>
          </div>
          <MiniRunBars :runs="row.recentRuns" :height="20" />
          <div class="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span
              >{{ row.runCount }} runs · {{ row.flakyTests }} flaky · {{ row.openClusters }} open clusters<template
                v-if="projectTargetsSummary(row.targets)"
              >
                ·
                <span :class="targetClass(projectTargetsSummary(row.targets)!.met)"
                  >targets {{ projectTargetsSummary(row.targets)!.text }}</span
                ></template
              ></span
            >
            <span v-if="row.latestRun">{{ formatRelativeTime(row.latestRun.startTime) }}</span>
          </div>
        </div>
      </div>

      <!-- Desktop: table -->
      <div class="hidden md:block">
        <TableScroller min-width="58rem">
          <table class="w-full text-sm">
            <thead>
              <tr
                class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200 dark:border-gray-800"
              >
                <th class="py-2 pr-4 font-medium">Project</th>
                <th class="py-2 pr-4 font-medium">Trend</th>
                <th class="py-2 pr-4 font-medium text-right">Pass rate</th>
                <th class="py-2 pr-4 font-medium text-right">Runs</th>
                <th class="py-2 pr-4 font-medium text-right">Flaky</th>
                <th class="py-2 pr-4 font-medium text-right">Avg run</th>
                <th class="py-2 pr-4 font-medium text-right">Open clusters</th>
                <th class="py-2 pr-4 font-medium text-right">Targets</th>
                <th class="py-2 font-medium text-right">Latest run</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              <tr v-for="row in rows" :key="row.projectId">
                <td class="py-2.5 pr-4">
                  <div class="flex items-center gap-2 min-w-0">
                    <NuxtLink :to="`/projects/${row.projectId}`" class="font-medium truncate hover:text-primary">
                      {{ row.label || row.name }}
                    </NuxtLink>
                    <TagBadge v-for="tag in row.tags.slice(0, 2)" :key="tag.id" :text="tag.text" :color="tag.color" />
                  </div>
                </td>
                <td class="py-2.5 pr-4">
                  <div class="w-36">
                    <MiniRunBars :runs="row.recentRuns" :height="22" />
                  </div>
                </td>
                <td class="py-2.5 pr-4 text-right">
                  <span
                    class="inline-flex items-center gap-1 tabular-nums font-semibold"
                    :class="passRateTextClass(row.passRate)"
                  >
                    {{ row.passRate !== null ? `${row.passRate}%` : '—' }}
                    <UIcon
                      v-if="deltaMeta(row.passRateDelta)"
                      :name="deltaMeta(row.passRateDelta)!.icon"
                      class="size-3.5"
                      :class="deltaMeta(row.passRateDelta)!.class"
                      :title="`${row.passRateDelta! > 0 ? '+' : ''}${row.passRateDelta} pts vs previous period`"
                    />
                  </span>
                </td>
                <td class="py-2.5 pr-4 text-right tabular-nums">
                  <NuxtLink
                    :to="drillDownHref('runs', row.projectId, query)"
                    class="hover:text-primary"
                    title="The runs behind this number"
                    >{{ row.runCount }}</NuxtLink
                  >
                </td>
                <td
                  class="py-2.5 pr-4 text-right tabular-nums"
                  :class="row.flakyTests > 0 ? STATUS_PALETTE.flaky.text : ''"
                >
                  <NuxtLink
                    :to="drillDownHref('flaky', row.projectId, query)"
                    class="hover:text-primary"
                    title="The flaky tests behind this number"
                    >{{ row.flakyTests }}</NuxtLink
                  >
                </td>
                <td class="py-2.5 pr-4 text-right tabular-nums text-gray-500 dark:text-gray-400">
                  <DurationValue :ms="row.avgRunDurationMs" />
                </td>
                <td
                  class="py-2.5 pr-4 text-right tabular-nums"
                  :class="row.openClusters > 0 ? STATUS_PALETTE.failed.text : ''"
                >
                  <NuxtLink
                    :to="drillDownHref('clusters', row.projectId, query, { status: 'open' })"
                    class="hover:text-primary"
                    title="The open failure clusters behind this number"
                    >{{ row.openClusters }}</NuxtLink
                  >
                </td>
                <td class="py-2.5 pr-4 text-right tabular-nums" data-testid="portfolio-targets">
                  <span
                    v-if="projectTargetsSummary(row.targets)"
                    :class="targetClass(projectTargetsSummary(row.targets)!.met)"
                    :title="projectTargetsSummary(row.targets)!.detail"
                    >{{ projectTargetsSummary(row.targets)!.text }}</span
                  >
                  <span v-else class="text-xs text-muted">—</span>
                </td>
                <td class="py-2.5 text-right">
                  <NuxtLink
                    v-if="row.latestRun"
                    :to="`/test-runs/${row.latestRun.id}`"
                    class="inline-flex items-center gap-2 hover:text-primary"
                  >
                    <RunStatusBadge :status="row.latestRun.status" />
                    <span class="text-xs text-gray-500 dark:text-gray-400">
                      {{ formatRelativeTime(row.latestRun.startTime) }}
                    </span>
                  </NuxtLink>
                  <span v-else class="text-xs text-gray-400">No runs</span>
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroller>
      </div>
    </template>
  </SectionCard>
</template>

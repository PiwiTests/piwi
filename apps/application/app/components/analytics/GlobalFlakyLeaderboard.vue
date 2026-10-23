<script setup lang="ts">
import type { AnalyticsFlakyRow } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string> }>();

const {
  data: rows,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsFlakyRow[]>('flaky-leaderboard', () => props.query);

function scoreColor(score: number): string {
  if (score >= 60) return 'text-red-600 dark:text-red-400';
  if (score >= 30) return 'text-amber-600 dark:text-amber-400';
  return 'text-gray-500';
}

/** Retry-pass flakes read as "flaked N/M runs"; alternation-only flakes as status flips. */
function flakeSummary(row: AnalyticsFlakyRow): string {
  if (row.retryPassRuns > 0) return `flaked ${row.retryPassRuns}/${row.totalRuns} runs`;
  return `${row.alternations} status flips in ${row.totalRuns} runs`;
}
</script>

<template>
  <SectionCard
    icon="i-lucide-repeat"
    title="Flakiest tests"
    :count="rows?.length || undefined"
    subtitle="Across all projects, sorted by impact"
    help="analytics.flaky-leaderboard"
    data-tour="analytics-flaky-leaderboard"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load flaky tests: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!rows || rows.length === 0" text="No flaky tests detected. Nice and stable." />
    <div v-else class="divide-y divide-gray-100 dark:divide-gray-800">
      <NuxtLink
        v-for="row in rows"
        :key="`${row.projectId}-${row.testCaseId}`"
        :to="`/test-cases/${row.testCaseId}`"
        class="flex items-center gap-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/60 rounded transition-colors"
      >
        <span class="tabular-nums font-bold text-sm w-10 text-right shrink-0" :class="scoreColor(row.score)">
          {{ row.score }}
        </span>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium truncate">{{ row.title }}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400 truncate">
            {{ row.projectLabel || row.projectName }} · {{ flakeSummary(row) }}
            <template v-if="row.lastFlakeAt"> · last {{ formatRelativeTime(row.lastFlakeAt) }}</template>
          </p>
        </div>
        <div class="text-right shrink-0">
          <p
            class="text-sm tabular-nums"
            :class="
              row.wastedCiMinutes >= 30
                ? 'text-red-600 dark:text-red-400'
                : row.wastedCiMinutes >= 5
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-gray-500'
            "
          >
            {{ Math.round(row.wastedCiMinutes) }} min
          </p>
          <TagBadge v-if="row.rootCause" :text="row.rootCause" color="neutral" />
        </div>
      </NuxtLink>
    </div>
  </SectionCard>
</template>

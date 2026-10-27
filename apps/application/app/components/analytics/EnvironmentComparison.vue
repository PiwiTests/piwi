<script setup lang="ts">
import type { AnalyticsEnvironmentComparison } from '#shared/analytics/types';
import { GROUP_SERIES_COLORS, type TrendLine } from '~/utils/chart';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const {
  data: comparison,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsEnvironmentComparison>(
  'environment-comparison',
  () => props.query,
  () => props.options,
);

const f = computed(() => metricFormatter());
const rows = computed(() => comparison.value?.rows ?? []);

const lines = computed<TrendLine[]>(() =>
  rows.value.slice(0, GROUP_SERIES_COLORS.length).map((row, i) => ({
    label: row.label,
    color: GROUP_SERIES_COLORS[i]!,
    points: row.points,
  })),
);
const legend = computed(() => lines.value.map((l) => ({ color: l.color, label: l.label })));

const exportData = computed(() => {
  const first = rows.value[0];
  if (!first) return null;
  return {
    name: 'environment-comparison',
    header: ['date', ...rows.value.map((r) => `${r.label} pass rate`)],
    rows: first.points.map((p, i) => [p.date, ...rows.value.map((r) => r.points[i]?.value ?? null)]),
  };
});
</script>

<template>
  <ChartCard
    icon="i-lucide-server"
    :title="title ?? 'Environment comparison'"
    subtitle="Test pass rate and run success per environment"
    help="analytics.environment-comparison"
    data-tour="analytics-environment-comparison"
    :legend="legend"
    :export-data="exportData"
    data-shot="analytics-environment-comparison"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the environment comparison: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="rows.length === 0" text="No runs in this period." />
    <div v-else class="space-y-3">
      <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <li
          v-for="row in rows"
          :key="row.environment"
          class="rounded-lg bg-gray-50 dark:bg-gray-900 p-2.5 space-y-0.5"
          data-testid="environment-row"
        >
          <p class="text-xs font-medium text-muted truncate" :title="row.label">{{ row.label }}</p>
          <p class="text-sm">
            <span class="font-semibold tabular-nums" :class="metricValueClass(row.passRate)">{{
              formatMetric(row.passRate, f)
            }}</span>
            <span class="text-xs text-muted"> tests passed</span>
            <span v-if="f.delta(row.passRate)" class="text-xs" :class="metricTrendClass(row.passRate.trend)">
              {{ f.delta(row.passRate) }}</span
            >
          </p>
          <p class="text-xs text-muted">
            <span :class="metricValueClass(row.runSuccessRate)">{{ formatMetric(row.runSuccessRate, f) }}</span>
            of {{ row.runs }} runs green
          </p>
        </li>
      </ul>
      <TrendLinesChart
        v-if="rows.length > 1"
        :series="lines"
        :height="180"
        :y-max="100"
        :y-format="(v) => `${v}%`"
        :value-format="(v) => f.value(v, 'percent', 1)"
      />
    </div>
  </ChartCard>
</template>

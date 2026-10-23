<script setup lang="ts">
import type { AnalyticsFlakyDebt } from '#shared/analytics/types';
import { GROUP_SERIES_COLORS, type TrendLine } from '~/utils/chart';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const {
  data: debt,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsFlakyDebt>('flaky-debt', () => props.query);

const FLAKY_COLOR = STATUS_PALETTE.flaky.color;
const QUARANTINE_COLOR = GROUP_SERIES_COLORS[0];

const perRunLines = computed<TrendLine[]>(() => [
  {
    label: 'Flaky occurrences per run',
    color: FLAKY_COLOR,
    points: (debt.value?.points ?? []).map((p) => ({ date: p.date, value: p.flakyPerRun })),
  },
]);
const countLines = computed<TrendLine[]>(() => [
  {
    label: 'Flaky tests',
    color: FLAKY_COLOR,
    dashed: true,
    points: (debt.value?.points ?? []).map((p) => ({ date: p.date, value: p.flakyTests })),
  },
  {
    label: 'In quarantine',
    color: QUARANTINE_COLOR,
    points: (debt.value?.points ?? []).map((p) => ({ date: p.date, value: p.quarantined })),
  },
]);
const hasData = computed(
  () => debt.value?.points.some((p) => p.flakyPerRun !== null || p.flakyTests > 0 || p.quarantined > 0) ?? false,
);

const legend = [
  { color: FLAKY_COLOR, label: 'Flaky' },
  { color: QUARANTINE_COLOR, label: 'In quarantine' },
];

const subtitle = computed(() => {
  const d = debt.value;
  if (!d) return undefined;
  const perRun = d.flakyPerRun === null ? null : `${d.flakyPerRun} flaky per run`;
  return [perRun, `${d.flakyTests} flaky tests`, `${d.quarantined} in quarantine`].filter(Boolean).join(' · ');
});

const change = computed(() => {
  const d = debt.value;
  if (!d || d.flakyPerRun === null || d.previousFlakyPerRun === null) return null;
  const delta = Math.round((d.flakyPerRun - d.previousFlakyPerRun) * 10) / 10;
  return {
    text: `${delta > 0 ? '+' : ''}${delta} per run vs previous period`,
    class: metricTrendClass(delta === 0 ? 'same' : delta < 0 ? 'better' : 'worse'),
  };
});

const exportData = computed(() =>
  debt.value
    ? {
        name: 'flaky-debt',
        header: ['date', 'flaky occurrences per run', 'flaky tests', 'in quarantine'],
        rows: debt.value.points.map((p) => [p.date, p.flakyPerRun, p.flakyTests, p.quarantined]),
      }
    : null,
);
</script>

<template>
  <ChartCard
    icon="i-lucide-repeat-2"
    :title="title ?? 'Flaky debt'"
    :subtitle="subtitle"
    help="analytics.flaky-debt"
    data-tour="analytics-flaky-debt"
    :legend="legend"
    :export-data="exportData"
    data-shot="analytics-flaky-debt"
  >
    <template #actions>
      <span v-if="change" class="text-xs tabular-nums" :class="change.class">{{ change.text }}</span>
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the flaky debt: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!hasData" icon="i-lucide-shield-check" text="No flakiness in this period." />
    <div v-else class="space-y-2">
      <TrendLinesChart
        :series="perRunLines"
        :height="150"
        :bucket-href="bucketDrill(query, debt!.bucketDays, 'flaky')"
      />
      <div>
        <p class="text-xs font-medium text-muted">Flaky tests and quarantine</p>
        <TrendLinesChart :series="countLines" :height="120" :markers="false" />
      </div>
    </div>
  </ChartCard>
</template>

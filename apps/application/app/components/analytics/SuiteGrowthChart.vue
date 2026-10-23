<script setup lang="ts">
import type { AnalyticsSuiteGrowth } from '#shared/analytics/types';
import { GROUP_SERIES_COLORS, type TrendLine } from '~/utils/chart';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const {
  data: growth,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsSuiteGrowth>('suite-growth', () => props.query);

/** A count of tests, not an outcome: the first series color. */
const SIZE_COLOR = GROUP_SERIES_COLORS[0];

const sizeLines = computed<TrendLine[]>(() => [
  {
    label: 'Suite size',
    color: SIZE_COLOR,
    points: (growth.value?.points ?? []).map((p) => ({ date: p.date, value: p.suiteSize })),
  },
]);
const shareLines = computed<TrendLine[]>(() => [
  {
    label: 'Skipped',
    color: STATUS_PALETTE.skipped.color,
    points: (growth.value?.points ?? []).map((p) => ({ date: p.date, value: p.skippedPct })),
  },
  {
    label: 'Did not run',
    color: STATUS_PALETTE.didnotrun.color,
    points: (growth.value?.points ?? []).map((p) => ({ date: p.date, value: p.didNotRunPct })),
  },
]);
const shareMax = computed(() =>
  Math.max(5, ...shareLines.value.flatMap((l) => l.points.map((p) => Math.ceil(p.value ?? 0)))),
);
const hasData = computed(() => growth.value?.points.some((p) => p.suiteSize !== null) ?? false);

const legend = [
  { color: SIZE_COLOR, label: 'Suite size' },
  { color: STATUS_PALETTE.skipped.color, label: 'Skipped' },
  { color: STATUS_PALETTE.didnotrun.color, label: 'Did not run' },
];

const subtitle = computed(() => {
  const g = growth.value;
  if (!g || g.suiteSize === null) return undefined;
  const shares = [
    g.skippedPct !== null ? `${g.skippedPct}% skipped` : null,
    g.didNotRunPct !== null ? `${g.didNotRunPct}% did not run` : null,
  ].filter(Boolean);
  return `${g.suiteSize} tests${shares.length ? ` · ${shares.join(' · ')}` : ''}`;
});

const deltaText = computed(() => {
  const d = growth.value?.delta;
  if (d === null || d === undefined) return null;
  return `${d > 0 ? '+' : ''}${d} tests vs previous period`;
});

const exportData = computed(() =>
  growth.value
    ? {
        name: 'suite-growth',
        header: ['date', 'suite size', 'skipped %', 'did not run %'],
        rows: growth.value.points.map((p) => [p.date, p.suiteSize, p.skippedPct, p.didNotRunPct]),
      }
    : null,
);
</script>

<template>
  <ChartCard
    icon="i-lucide-sprout"
    :title="title ?? 'Suite growth'"
    :subtitle="subtitle"
    help="analytics.suite-growth"
    data-tour="analytics-suite-growth"
    :legend="legend"
    :export-data="exportData"
    data-shot="analytics-suite-growth"
  >
    <template #actions>
      <span v-if="deltaText" class="text-xs tabular-nums text-muted">{{ deltaText }}</span>
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the suite growth: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!hasData" text="No runs in this period." />
    <div v-else class="space-y-2">
      <TrendLinesChart
        :series="sizeLines"
        :height="170"
        :bucket-href="bucketDrill(query, growth!.bucketDays, 'runs')"
      />
      <div>
        <p class="text-xs font-medium text-muted">Share of the suite skipped or not run</p>
        <TrendLinesChart
          :series="shareLines"
          :height="100"
          :y-max="shareMax"
          :y-format="(v) => `${v}%`"
          :value-format="(v) => (v === null ? '—' : `${v}%`)"
          :markers="false"
        />
      </div>
    </div>
  </ChartCard>
</template>

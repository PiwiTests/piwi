<script setup lang="ts">
/**
 * The Trend tab of a test page: the test's pass rate, flaky rate and average
 * duration in time buckets over a chosen span, with the project's timeline
 * markers, so "did my fix hold" reads without MCP.
 */
import type { TestCaseStabilityTrend } from '#shared/handlers/test-cases';
import type { MarkerInfo } from '~~/types/api';
import { GROUP_SERIES_COLORS, type TrendLine } from '~/utils/chart';

const DURATION_COLOR = GROUP_SERIES_COLORS[0];

const props = defineProps<{ testCaseId: number; markers?: MarkerInfo[] }>();

const SPANS = [
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 90 days', value: 90 },
  { label: 'Last 365 days', value: 365 },
];
const days = useViewState('stability-trend-days', () => 90);
const trend = ref<TestCaseStabilityTrend | null>(null);
const pending = ref(false);
const error = ref<unknown>(null);

async function load() {
  pending.value = true;
  error.value = null;
  try {
    trend.value = await $fetch<TestCaseStabilityTrend>(`/api/test-cases/${props.testCaseId}/stability-trend`, {
      query: { days: days.value },
    });
  } catch (e) {
    error.value = e;
  } finally {
    pending.value = false;
  }
}
watch([() => props.testCaseId, days], load, { immediate: true });

const f = computed(() => metricFormatter());
const pct = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 10);
const buckets = computed(() => trend.value?.buckets ?? []);
const hasData = computed(() => buckets.value.some((b) => b.totalRuns > 0));

const rateLines = computed<TrendLine[]>(() => [
  {
    label: 'Pass rate',
    color: STATUS_PALETTE.passed.color,
    points: buckets.value.map((b) => ({ date: b.date, value: pct(b.passRate) })),
  },
  {
    label: 'Flaky rate',
    color: STATUS_PALETTE.flaky.color,
    points: buckets.value.map((b) => ({ date: b.date, value: pct(b.flakyRate) })),
  },
]);
const durationLines = computed<TrendLine[]>(() => [
  {
    label: 'Average duration',
    color: DURATION_COLOR,
    points: buckets.value.map((b) => ({ date: b.date, value: b.avgDuration })),
  },
]);
const legend = [
  { color: STATUS_PALETTE.passed.color, label: 'Pass rate' },
  { color: STATUS_PALETTE.flaky.color, label: 'Flaky rate' },
  { color: DURATION_COLOR, label: 'Average duration' },
];
const exportData = computed(() => ({
  name: `test-${props.testCaseId}-trend`,
  header: ['date', 'executions', 'pass rate %', 'flaky rate %', 'average duration ms'],
  rows: buckets.value.map((b) => [b.date, b.totalRuns, pct(b.passRate), pct(b.flakyRate), b.avgDuration]),
}));
const subtitle = computed(() => {
  const t = trend.value;
  if (!t) return undefined;
  const runs = t.buckets.reduce((n, b) => n + b.totalRuns, 0);
  const span =
    t.bucketDays === 1 ? 'day' : t.bucketDays === 7 ? 'week' : t.bucketDays >= 28 ? 'month' : `${t.bucketDays} days`;
  return `${runs} executions · one point per ${span} (UTC)`;
});
</script>

<template>
  <ChartCard
    title="Stability trend"
    icon="i-lucide-activity"
    :subtitle="subtitle"
    help="case.stability-trend"
    :legend="legend"
    :export-data="exportData"
    data-shot="test-case-trend"
  >
    <template #actions>
      <USelect
        v-model="days"
        :items="SPANS"
        value-key="value"
        size="xs"
        aria-label="Trend span"
        data-testid="case-trend-span"
      />
    </template>
    <LoadingState v-if="pending && !trend" />
    <ErrorState v-else-if="error" :text="`Couldn't load the trend: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="load()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!hasData" text="No execution in this span." />
    <div v-else class="space-y-2" :class="pending ? 'opacity-60' : ''">
      <TrendLinesChart
        :series="rateLines"
        :height="170"
        :y-max="100"
        :y-format="(v) => `${v}%`"
        :value-format="(v) => f.value(v, 'percent', 1)"
        :timeline-markers="markers ?? []"
      />
      <div>
        <p class="text-xs font-medium text-muted">Average duration</p>
        <TrendLinesChart
          :series="durationLines"
          :height="110"
          :y-format="(v) => (v >= 1000 ? `${Math.round(v / 100) / 10}s` : `${v}ms`)"
          :value-format="(v) => f.value(v, 'ms', 0)"
          :timeline-markers="markers ?? []"
        />
      </div>
    </div>
  </ChartCard>
</template>

<script setup lang="ts">
/**
 * Combined line coverage over time: per bucket, the lines every suite ran
 * together over the executable lines of the projects in scope with coverage
 * on, with the change against the comparison period, and as dashed lines each
 * suite's share of the same lines, or each named area's (`split: 'areas'`).
 */
import type { AnalyticsCoverageTrend } from '#shared/analytics/types';
import { GROUP_SERIES_COLORS, type TrendLine } from '~/utils/chart';
import { formatCount, formatPercent } from '~/utils/combined-coverage';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const {
  data: trend,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsCoverageTrend>(
  'coverage-trend',
  () => props.query,
  () => props.options,
);

/** A share of lines, not an outcome: the first series color. */
const LINE_COLOR = GROUP_SERIES_COLORS[0];

/** Each suite or area after the combined line, in the next series colors. */
const suiteColor = (i: number) => GROUP_SERIES_COLORS[(i + 1) % GROUP_SERIES_COLORS.length]!;

const lines = computed<TrendLine[]>(() => [
  {
    label: 'All suites',
    color: LINE_COLOR,
    points: (trend.value?.points ?? []).map((p) => ({ date: p.date, value: p.linePercent })),
  },
  ...(trend.value?.series ?? []).map((suite, i) => ({
    label: suite.name,
    color: suiteColor(i),
    dashed: true,
    points: suite.points.map((p) => ({ date: p.date, value: p.linePercent })),
  })),
]);
const hasData = computed(() => trend.value?.points.some((p) => p.linePercent !== null) ?? false);
const legend = computed(() => [
  { color: LINE_COLOR, label: 'All suites' },
  ...(trend.value?.series ?? []).map((suite, i) => ({ color: suiteColor(i), label: suite.name })),
]);

// The change sits in the subtitle: the legend can name as many lines as there are suites or areas.
const subtitle = computed(() => {
  const t = trend.value;
  if (!t || t.linePercent === null) return undefined;
  const delta = t.delta === null ? '' : ` · ${t.delta > 0 ? '+' : ''}${t.delta} pts vs previous period`;
  return `${formatPercent(t.linePercent)} of ${formatCount(t.executableLines)} lines${delta}`;
});

const exportData = computed(() =>
  trend.value
    ? {
        name: 'coverage-trend',
        header: [
          'date',
          'line coverage %',
          'executed lines',
          'executable lines',
          ...trend.value.series.map((s) => `${s.name} %`),
        ],
        rows: trend.value.points.map((p, i) => [
          p.date,
          p.linePercent,
          p.executedLines,
          p.executableLines,
          ...trend.value!.series.map((s) => s.points[i]?.linePercent ?? null),
        ]),
      }
    : null,
);
</script>

<template>
  <ChartCard
    icon="i-lucide-scan-line"
    :title="title ?? 'Coverage trend'"
    :subtitle="subtitle"
    help="analytics.coverage-trend"
    :legend="legend"
    :export-data="exportData"
    data-shot="analytics-coverage-trend"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the coverage trend: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!trend || trend.projects === 0" text="Coverage is not on for the projects in scope." />
    <EmptyState v-else-if="!hasData" text="No coverage in this period." />
    <div v-else class="space-y-1">
      <TrendLinesChart
        :series="lines"
        :height="170"
        :y-max="100"
        :y-format="(v) => `${v}%`"
        :value-format="(v) => (v === null ? '—' : `${v}%`)"
      />
      <p v-if="trend.declined > 0" class="text-xs text-muted">
        {{ trend.declined }} {{ trend.declined === 1 ? 'project' : 'projects' }} without coverage left out.
      </p>
    </div>
  </ChartCard>
</template>

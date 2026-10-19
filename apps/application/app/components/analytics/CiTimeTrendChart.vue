<script setup lang="ts">
import type { AnalyticsCiTimeTrend } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string> }>();

const {
  data: trend,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsCiTimeTrend>('ci-time-trend', () => props.query);

type DataPoint = { date: Date; totalMinutes: number; runCount: number };

const chartData = computed<DataPoint[]>(
  () =>
    trend.value?.points.map((p) => ({ date: new Date(p.date), totalMinutes: p.totalMinutes, runCount: p.runCount })) ??
    [],
);

const hasData = computed(() => chartData.value.some((p) => p.runCount > 0));

const lineColor = 'rgb(59, 130, 246)';

const yMax = computed(() => Math.max(1, ...chartData.value.map((d) => d.totalMinutes)));

const { markers, tooltip, centers, layout, xTicks, markerX, drill, openBucket } = useDailyBarChart({
  points: chartData,
  bucketDays: () => trend.value?.bucketDays,
  query: () => props.query,
});
const { data: tooltipData, pos: tooltipPos, show, move, hide } = tooltip;

function linePath(plotWidth: number, yScale: (value: number) => number): string {
  const xs = centers(plotWidth);
  return chartData.value.map((d, i) => `${i === 0 ? 'M' : 'L'}${xs[i]},${yScale(d.totalMinutes)}`).join('');
}

function areaPath(plotWidth: number, plotHeight: number, yScale: (value: number) => number): string {
  const xs = centers(plotWidth);
  if (xs.length === 0) return '';
  const line = linePath(plotWidth, yScale);
  return `${line}L${xs[xs.length - 1]},${plotHeight}L${xs[0]},${plotHeight}Z`;
}

const deltaBadge = computed(() => {
  if (!trend.value || trend.value.deltaPct === null) return null;
  const pct = trend.value.deltaPct;
  return {
    label: `${pct > 0 ? '+' : ''}${pct}% vs previous period`,
    class:
      pct > 25 ? 'text-red-600 dark:text-red-400' : pct < -10 ? 'text-green-600 dark:text-green-400' : 'text-gray-500',
  };
});

const exportData = computed(() =>
  trend.value
    ? {
        name: 'ci-time',
        header: ['date', 'CI minutes', 'runs'],
        rows: trend.value.points.map((p) => [p.date, p.totalMinutes, p.runCount]),
      }
    : null,
);

const subtitle = computed(() => {
  if (!trend.value) return undefined;
  const total = trend.value.totalMinutes;
  const label = total < 60 ? `${Math.round(total)} min` : `${Math.round((total / 60) * 10) / 10} h`;
  return `${label} across ${trend.value.runCount} runs`;
});
</script>

<template>
  <ChartCard
    icon="i-lucide-timer"
    title="CI time"
    :subtitle="subtitle"
    help="analytics.ci-time"
    :export-data="exportData"
  >
    <template #actions>
      <span v-if="deltaBadge" class="text-xs font-medium tabular-nums" :class="deltaBadge.class">
        {{ deltaBadge.label }}
      </span>
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load CI time: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!hasData" text="No runs in this period." />
    <div v-else class="w-full">
      <ChartFrame
        v-slot="{ plotWidth, plotHeight, yScale }"
        :height="220"
        :y-max="yMax"
        :y-format="(value) => `${value}m`"
      >
        <path :d="areaPath(plotWidth, plotHeight, yScale)" fill="rgba(59, 130, 246, 0.15)" />
        <path :d="linePath(plotWidth, yScale)" fill="none" :stroke="lineColor" stroke-width="2" />

        <text
          v-for="tick in xTicks(plotWidth)"
          :key="tick.x"
          :x="tick.x"
          :y="plotHeight + 14"
          text-anchor="middle"
          class="fill-gray-400 dark:fill-gray-500 text-[10px]"
        >
          {{ tick.label }}
        </text>

        <rect
          v-for="slot in layout(plotWidth, plotHeight, yScale)"
          :key="`hover-${slot.d.date.getTime()}`"
          :x="slot.slotX"
          :y="0"
          :width="slot.slotWidth"
          :height="plotHeight"
          :fill="tooltipData === slot.d ? 'rgb(148 163 184 / 0.15)' : 'transparent'"
          :class="drill ? 'cursor-pointer' : ''"
          @click="openBucket(slot.d.date)"
          @mouseenter="show($event, slot.d)"
          @mousemove="move($event)"
          @mouseleave="hide()"
        />
        <ChartMarkerLines
          :markers="markers"
          :x-of="(occurredAt) => markerX(plotWidth, occurredAt)"
          :plot-height="plotHeight"
        />
      </ChartFrame>

      <ChartTooltip v-if="tooltipData" :pos="tooltipPos">
        <div class="font-semibold mb-1">
          {{ tooltipData.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }}
        </div>
        <div>{{ tooltipData.totalMinutes }} minutes</div>
        <div class="text-gray-400 text-xs">{{ tooltipData.runCount }} runs</div>
      </ChartTooltip>
    </div>
  </ChartCard>
</template>

<script setup lang="ts">
import type { AnalyticsRegressionVelocity } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string> }>();

const {
  data: velocity,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsRegressionVelocity>('regression-velocity', () => props.query);

type DataPoint = { date: Date; regressions: number; newFlaky: number };

const chartData = computed<DataPoint[]>(
  () =>
    velocity.value?.points.map((p) => ({
      date: new Date(p.date),
      regressions: p.regressions,
      newFlaky: p.newFlaky,
    })) ?? [],
);

const hasData = computed(() => chartData.value.some((p) => p.regressions > 0 || p.newFlaky > 0));

const barColors = [STATUS_PALETTE.failed.color, STATUS_PALETTE.flaky.color] as const;

const yMax = computed(() => Math.max(1, ...chartData.value.map((d) => d.regressions + d.newFlaky)));

// One stacked bar per day: regressions on the baseline, newly flaky above.
const { markers, tooltip, layout, xTicks, markerX, drill, openBucket } = useDailyBarChart({
  points: chartData,
  bucketDays: () => velocity.value?.bucketDays,
  query: () => props.query,
  segments: (d) => [
    { color: barColors[0], value: d.regressions },
    { color: barColors[1], value: d.newFlaky },
  ],
});
const { data: tooltipData, pos: tooltipPos, show, move, hide } = tooltip;

const legendItems = [
  { color: barColors[0], label: 'New regressions' },
  { color: barColors[1], label: 'Newly flaky' },
];

const deltaBadge = computed(() => {
  if (!velocity.value || velocity.value.deltaPct === null) return null;
  const pct = velocity.value.deltaPct;
  return {
    label: `${pct > 0 ? '+' : ''}${pct}% vs previous period`,
    // Fewer regressions is good, more is bad.
    class: pct > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400',
  };
});

const exportData = computed(() =>
  velocity.value
    ? {
        name: 'regression-velocity',
        header: ['date', 'new regressions', 'newly flaky'],
        rows: velocity.value.points.map((p) => [p.date, p.regressions, p.newFlaky]),
      }
    : null,
);

const subtitle = computed(() => {
  if (!velocity.value) return undefined;
  return `${velocity.value.totalRegressions} new regressions, ${velocity.value.totalNewFlaky} newly flaky`;
});
</script>

<template>
  <ChartCard
    icon="i-lucide-git-pull-request-arrow"
    title="Regression velocity"
    :subtitle="subtitle"
    help="analytics.regression-velocity"
    data-tour="analytics-regression-velocity"
    :legend="legendItems"
    :export-data="exportData"
  >
    <template #actions>
      <span v-if="deltaBadge" class="text-xs font-medium tabular-nums" :class="deltaBadge.class">
        {{ deltaBadge.label }}
      </span>
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load regression velocity: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!hasData" icon="i-lucide-shield-check" text="No new regressions in this period." />
    <div v-else class="w-full">
      <ChartFrame v-slot="{ plotWidth, plotHeight, yScale }" :height="220" :y-max="yMax">
        <template v-for="bar in layout(plotWidth, plotHeight, yScale)" :key="bar.d.date.getTime()">
          <rect
            v-for="segment in bar.segments"
            :key="segment.color"
            :x="bar.barX"
            :y="segment.y"
            :width="bar.barWidth"
            :height="segment.height"
            :style="{ fill: segment.color }"
          />
        </template>

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
          v-for="bar in layout(plotWidth, plotHeight, yScale)"
          :key="`hover-${bar.d.date.getTime()}`"
          :x="bar.slotX"
          :y="0"
          :width="bar.slotWidth"
          :height="plotHeight"
          :fill="tooltipData === bar.d ? 'rgb(148 163 184 / 0.15)' : 'transparent'"
          :class="drill ? 'cursor-pointer' : ''"
          @click="openBucket(bar.d.date)"
          @mouseenter="show($event, bar.d)"
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
        <div><span :style="{ color: barColors[0] }">&#9679;</span> New regressions: {{ tooltipData.regressions }}</div>
        <div><span :style="{ color: barColors[1] }">&#9679;</span> Newly flaky: {{ tooltipData.newFlaky }}</div>
      </ChartTooltip>
    </div>
  </ChartCard>
</template>

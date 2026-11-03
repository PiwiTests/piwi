<script setup lang="ts">
import type { TestCaseHistoryPoint, MarkerInfo } from '~~/types/api';
import { barGeometry, dayTickIndices, formatTickDate, timeToOrdinalX } from '~/utils/chart';

interface Props {
  data: TestCaseHistoryPoint[];
  height?: number;
  markers?: MarkerInfo[];
}

const props = withDefaults(defineProps<Props>(), {
  height: 200,
  markers: () => [],
});

const emit = defineEmits<{ 'marker-click': [id: number] }>();

const chartData = computed(() => {
  if (!props.data || props.data.length === 0) return [];
  // Show chronologically oldest → newest for chart
  const sorted = [...props.data].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  return sorted.map((point) => ({
    id: point.id,
    runId: point.runId,
    date: new Date(point.startTime),
    duration: point.duration ?? 0,
    status: point.status,
    passedAfterFailure: point.passedAfterFailure,
    runStatus: point.runStatus,
  }));
});

type DataPoint = (typeof chartData)['value'][number];

const yMax = computed(() => Math.max(1, ...chartData.value.map((d) => d.duration)));

const dates = computed(() => chartData.value.map((d) => d.date));

/** One duration bar per execution, colored by its status. */
function layout(plotWidth: number, plotHeight: number, yScale: (value: number) => number) {
  const geo = barGeometry(chartData.value.length, plotWidth, 16);
  return chartData.value.map((d, i) => {
    const barHeight = Math.max(2, plotHeight - yScale(d.duration));
    return {
      d,
      slotX: i * geo.slotWidth,
      slotWidth: geo.slotWidth,
      barX: geo.xOf(i),
      barWidth: geo.barWidth,
      barY: plotHeight - barHeight,
      barHeight,
      color: statusPalette(d.status, d.passedAfterFailure).color,
    };
  });
}

function xTicks(plotWidth: number) {
  const { centerOf } = barGeometry(chartData.value.length, plotWidth);
  return dayTickIndices(dates.value, Math.max(2, Math.floor(plotWidth / 80))).map((i) => ({
    x: centerOf(i),
    label: formatTickDate(dates.value[i] as Date),
  }));
}

function markerX(plotWidth: number, occurredAt: string | Date): number | null {
  const { centerOf } = barGeometry(chartData.value.length, plotWidth);
  const centers = chartData.value.map((_, i) => centerOf(i));
  return timeToOrdinalX(dates.value, centers, new Date(occurredAt).getTime());
}

function formatMs(value: number): string {
  return value >= 1000 ? `${Math.round(value / 100) / 10}s` : `${value}ms`;
}

const { data: tooltipData, pos: tooltipPos, show, move, hide } = useChartTooltip<DataPoint>();
</script>

<template>
  <div class="w-full">
    <ChartFrame
      v-if="chartData.length > 0"
      v-slot="{ plotWidth, plotHeight, yScale }"
      :height="height"
      :y-max="yMax"
      :y-format="formatMs"
    >
      <rect
        v-for="bar in layout(plotWidth, plotHeight, yScale)"
        :key="bar.d.id"
        :x="bar.barX"
        :y="bar.barY"
        :width="bar.barWidth"
        :height="bar.barHeight"
        :style="{ fill: bar.color }"
      />

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
        :key="`hover-${bar.d.id}`"
        :x="bar.slotX"
        :y="0"
        :width="bar.slotWidth"
        :height="plotHeight"
        :fill="tooltipData?.id === bar.d.id ? 'rgb(148 163 184 / 0.15)' : 'transparent'"
        class="cursor-pointer"
        @click="navigateTo(`/test-runs/${bar.d.runId}`)"
        @mouseenter="show($event, bar.d)"
        @mousemove="move($event)"
        @mouseleave="hide()"
      />

      <!-- Markers render after the hover columns so their flags stay on top
           and hover/click reach them (SVG paints in document order). -->
      <ChartMarkerLines
        :markers="markers"
        :x-of="(occurredAt) => markerX(plotWidth, occurredAt)"
        :plot-height="plotHeight"
        @marker-click="emit('marker-click', $event)"
      />
    </ChartFrame>

    <EmptyState v-else text="No history data available to display chart" />

    <ChartTooltip v-if="tooltipData" :pos="tooltipPos">
      <div class="font-semibold mb-1">
        {{
          tooltipData.date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        }}
      </div>
      <div class="space-y-0.5">
        <div>
          Status:
          <span
            class="font-medium capitalize"
            :class="statusPalette(tooltipData.status, tooltipData.passedAfterFailure).text"
            >{{ formatExecutionStatus(tooltipData.status, tooltipData.passedAfterFailure) }}</span
          >
        </div>
        <div>Duration: {{ tooltipData.duration }}ms</div>
        <div v-if="tooltipData.runStatus" class="text-gray-400 text-xs">
          Run status: {{ formatStatusLabel(tooltipData.runStatus) }}
        </div>
      </div>
      <div class="text-gray-400 text-xs mt-1">Click to view run details</div>
    </ChartTooltip>
  </div>
</template>

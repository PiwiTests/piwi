<script setup lang="ts">
/**
 * Presentational line chart over time buckets: one line per series (a gap in
 * the data is a gap in the line), the x-axis dates, the timeline markers of
 * the analytics page when one provides them, and a tooltip with every series'
 * value in the hovered bucket, and the point's note when it has one. Place
 * inside a `ChartCard`.
 */
import { barGeometry, bucketTimeToX, dayTickIndices, formatTickDate, type TrendLine } from '~/utils/chart';
import type { MarkerInfo } from '~~/types/api';

const props = withDefaults(
  defineProps<{
    series: TrendLine[];
    height?: number;
    /** Upper bound of the value axis; fits the data when unset. */
    yMax?: number;
    yFormat?: (value: number) => string;
    /** How a value reads in the tooltip. */
    valueFormat?: (value: number | null, line: TrendLine) => string;
    /** Draw the analytics page's timeline markers. */
    markers?: boolean;
    /** Timeline markers to draw instead of the analytics page's (a project's, on a test page). */
    timelineMarkers?: MarkerInfo[] | null;
    /** The list behind a bucket, opened on click; unset leaves buckets unlinked. */
    bucketHref?: ((date: string) => string) | null;
    /** Extra marks (a fix, a regression) drawn as labeled vertical lines. */
    marks?: Array<{ date: string; label: string; color: string }>;
  }>(),
  {
    height: 200,
    yMax: undefined,
    yFormat: (value: number) => String(value),
    valueFormat: (value: number | null) => (value === null ? '—' : String(value)),
    markers: true,
    timelineMarkers: null,
    bucketHref: null,
    marks: () => [],
  },
);

const dates = computed(() => (props.series[0]?.points ?? []).map((p) => new Date(`${p.date}T00:00:00Z`)));
const top = computed(
  () => props.yMax ?? Math.max(1, ...props.series.flatMap((s) => s.points.map((p) => p.value ?? 0))),
);

function pathOf(line: TrendLine, plotWidth: number, yScale: (v: number) => number): string {
  const { centerOf } = barGeometry(line.points.length, plotWidth);
  let d = '';
  let pen = false;
  line.points.forEach((p, i) => {
    if (p.value === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${centerOf(i)},${yScale(p.value)}`;
    pen = true;
  });
  return d;
}

function dots(line: TrendLine, plotWidth: number, yScale: (v: number) => number) {
  const { centerOf } = barGeometry(line.points.length, plotWidth);
  return line.points.flatMap((p, i) => (p.value === null ? [] : [{ x: centerOf(i), y: yScale(p.value), i }]));
}

function xTicks(plotWidth: number) {
  const { centerOf } = barGeometry(dates.value.length, plotWidth);
  return dayTickIndices(dates.value, Math.max(2, Math.floor(plotWidth / 80))).map((i) => ({
    x: centerOf(i),
    label: formatTickDate(dates.value[i] as Date),
  }));
}

const scopeSummary = injectAnalyticsScopeSummary();
const markerList = computed<MarkerInfo[]>(() =>
  !props.markers ? [] : (props.timelineMarkers ?? (scopeSummary.value?.markers as MarkerInfo[] | undefined) ?? []),
);
function timeX(plotWidth: number, at: string | Date): number | null {
  const { centerOf } = barGeometry(dates.value.length, plotWidth);
  const end =
    scopeSummary.value && !props.timelineMarkers ? new Date(scopeSummary.value.period.to).getTime() : Date.now();
  return bucketTimeToX(
    dates.value,
    dates.value.map((_, i) => centerOf(i)),
    new Date(at).getTime(),
    end,
  );
}

const { data: tooltipData, pos: tooltipPos, show, move, hide } = useChartTooltip<{ i: number }>(240);
const f = computed(() => metricFormatter());
</script>

<template>
  <div class="w-full">
    <ChartFrame v-slot="{ plotWidth, plotHeight, yScale }" :height="height" :y-max="top" :y-format="yFormat">
      <template v-for="line in series" :key="line.label">
        <path
          :d="pathOf(line, plotWidth, yScale)"
          fill="none"
          :style="{ stroke: line.color }"
          stroke-width="2"
          :stroke-dasharray="line.dashed ? '4 3' : undefined"
        />
        <circle
          v-for="dot in dots(line, plotWidth, yScale)"
          :key="dot.i"
          :cx="dot.x"
          :cy="dot.y"
          r="2.5"
          :style="{ fill: line.color }"
        />
      </template>
      <template v-for="mark in marks" :key="`${mark.date}-${mark.label}`">
        <line
          v-if="timeX(plotWidth, mark.date) !== null"
          :x1="timeX(plotWidth, mark.date)!"
          :x2="timeX(plotWidth, mark.date)!"
          :y1="0"
          :y2="plotHeight"
          :style="{ stroke: mark.color }"
          stroke-width="1.5"
          stroke-dasharray="3 2"
        >
          <title>{{ mark.label }}</title>
        </line>
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
        v-for="(d, i) in dates"
        :key="`hover-${d.getTime()}`"
        :x="i * (plotWidth / dates.length)"
        :y="0"
        :width="plotWidth / dates.length"
        :height="plotHeight"
        :fill="tooltipData?.i === i ? 'rgb(148 163 184 / 0.15)' : 'transparent'"
        :class="bucketHref ? 'cursor-pointer' : ''"
        @click="bucketHref && navigateTo(bucketHref(series[0]!.points[i]!.date))"
        @mouseenter="show($event, { i })"
        @mousemove="move($event)"
        @mouseleave="hide()"
      />
      <ChartMarkerLines :markers="markerList" :x-of="(at) => timeX(plotWidth, at)" :plot-height="plotHeight" />
    </ChartFrame>

    <ChartTooltip v-if="tooltipData" :pos="tooltipPos">
      <div class="font-semibold mb-1">{{ f.date(series[0]!.points[tooltipData.i]!.date) }}</div>
      <div v-for="line in series" :key="line.label">
        <span :style="{ color: line.color }">&#9679;</span> {{ line.label }}:
        {{ valueFormat(line.points[tooltipData.i]?.value ?? null, line)
        }}<span v-if="line.points[tooltipData.i]?.note" class="opacity-70">
          · {{ line.points[tooltipData.i]!.note }}</span
        >
      </div>
    </ChartTooltip>
  </div>
</template>

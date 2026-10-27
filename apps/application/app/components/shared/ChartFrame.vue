<script setup lang="ts">
import { niceTicks } from '~/utils/chart';

/**
 * Responsive SVG shell shared by the trend charts: measures its own width,
 * draws the y-axis gridlines and labels for a 0-based linear scale, and hands
 * the plot geometry to the default slot, which renders the marks (bars, lines,
 * x labels, marker lines) in plot coordinates. It also renders the tooltip of
 * the `ChartMarkerLines` in that slot, outside the SVG.
 */
const props = withDefaults(
  defineProps<{
    /** Total SVG height in px. */
    height: number;
    /** Largest data value; the axis extends to the next round tick above it. */
    yMax: number;
    /** Tick label formatter — fold the unit in here ("12s", "45m"). */
    yFormat?: (value: number) => string;
  }>(),
  { yFormat: (value: number) => String(value) },
);

const MARGIN = { top: 8, right: 8, bottom: 20, left: 40 } as const;

const wrapper = ref<HTMLElement | null>(null);
const { width } = useElementSize(wrapper);

const ticks = computed(() => niceTicks(props.yMax));
const yTop = computed(() => ticks.value[ticks.value.length - 1] || 1);
const plotWidth = computed(() => Math.max(0, width.value - MARGIN.left - MARGIN.right));
const plotHeight = computed(() => Math.max(0, props.height - MARGIN.top - MARGIN.bottom));

const { data: hoveredMarker, pos: markerPos, clickable: markerClickable } = provideChartMarkerTooltip();

function yScale(value: number): number {
  return plotHeight.value - (value / yTop.value) * plotHeight.value;
}
</script>

<template>
  <div ref="wrapper" class="w-full">
    <svg v-if="plotWidth > 0" :width="width" :height="height" class="block">
      <g :transform="`translate(${MARGIN.left},${MARGIN.top})`">
        <g v-for="tick in ticks" :key="tick">
          <line
            :x1="0"
            :x2="plotWidth"
            :y1="yScale(tick)"
            :y2="yScale(tick)"
            class="stroke-gray-200 dark:stroke-gray-700/70"
            :stroke-dasharray="tick === 0 ? undefined : '3 3'"
          />
          <text
            :x="-8"
            :y="yScale(tick)"
            text-anchor="end"
            dominant-baseline="middle"
            class="fill-gray-400 dark:fill-gray-500 text-[10px] tabular-nums"
          >
            {{ yFormat(tick) }}
          </text>
        </g>
        <slot :plot-width="plotWidth" :plot-height="plotHeight" :y-scale="yScale" />
      </g>
    </svg>
    <ChartMarkerTooltip :marker="hoveredMarker" :pos="markerPos" :clickable="markerClickable" />
  </div>
</template>

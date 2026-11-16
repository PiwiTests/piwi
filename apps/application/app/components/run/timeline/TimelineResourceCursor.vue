<script setup lang="ts">
/**
 * The moment the pointer is on, as a line down the whole timeline, so a CPU or
 * memory spike points at the tests that ran then: the time at its top, and
 * beside it, in each band's tracks, what each track reads then. The labels sit
 * right of the line, or left of it near the viewport's right edge (`flip`).
 * Reads the shared hover state, so a pointer move redraws this and nothing else.
 */
import { computed } from 'vue';
import type { SeriesPoint } from '#shared/types';
import { TIMELINE_LAYOUT, formatTimelineTime } from '~/utils/timeline';
import { trackReadings, type ResourceBand, type ResourceTrack } from '~/utils/resource-tracks';

const props = defineProps<{
  state: { on: boolean; t: number; flip: boolean };
  pxPerMs: number;
  contentHeight: number;
  /** Each band with the tracks it draws and the Y of its top. */
  bands: Array<{ band: ResourceBand; tracks: ResourceTrack[]; top: number }>;
  /** The pages earlier tests left open in each band's workers. */
  leftOpenFor?: (band: ResourceBand) => SeriesPoint[] | null;
}>();

const { labelWidth, axisHeight, trackHeight, trackGap } = TIMELINE_LAYOUT;
/** Space between the line and its labels. */
const LABEL_GAP = 5;

const x = computed(() => labelWidth + props.state.t * props.pxPerMs);
const labelX = computed(() => x.value + (props.state.flip ? -LABEL_GAP : LABEL_GAP));
const anchor = computed(() => (props.state.flip ? 'end' : 'start'));

const readings = computed(() =>
  props.state.on
    ? props.bands.flatMap(({ band, tracks, top }) =>
        trackReadings(band, tracks, props.state.t, props.leftOpenFor?.(band)).map((reading, i) => ({
          key: `${band.key}-${reading.kind}`,
          y: top + i * (trackHeight + trackGap) + trackHeight / 2,
          ...reading,
        })),
      )
    : [],
);
</script>

<template>
  <g v-if="state.on" class="pointer-events-none" data-testid="timeline-resource-cursor">
    <line
      :x1="x"
      :x2="x"
      :y1="axisHeight"
      :y2="contentHeight"
      stroke-dasharray="3 3"
      class="stroke-gray-400 dark:stroke-gray-500"
    />
    <text
      :x="labelX"
      :y="axisHeight - 8"
      :text-anchor="anchor"
      paint-order="stroke"
      stroke-width="4"
      stroke-linejoin="round"
      class="fill-gray-900 dark:fill-white stroke-[var(--ui-bg)] text-[10px] font-medium tabular-nums"
      data-testid="timeline-resource-cursor-time"
    >
      {{ formatTimelineTime(Math.max(0, Math.round(state.t))) }}
    </text>
    <text
      v-for="reading in readings"
      :key="reading.key"
      :x="labelX"
      :y="reading.y"
      :text-anchor="anchor"
      dominant-baseline="middle"
      paint-order="stroke"
      stroke-width="4"
      stroke-linejoin="round"
      class="stroke-[var(--ui-bg)] text-[11px] font-medium tabular-nums"
      :class="reading.value === null ? 'fill-gray-400 dark:fill-gray-500' : 'fill-gray-900 dark:fill-white'"
      :data-resource-reading="reading.kind"
    >
      {{ reading.text }}
    </text>
  </g>
</template>

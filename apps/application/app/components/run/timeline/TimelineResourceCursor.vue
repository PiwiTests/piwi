<script setup lang="ts">
/**
 * The moment the pointer is on, as a line down the whole timeline, so a CPU or
 * memory spike points at the tests that ran then: the moment on the axis and,
 * beside the line, what each band's tracks read then, on the side a test
 * bar's tooltip leaves free. Reads the shared hover state, so a pointer move
 * redraws this and nothing else.
 */
import { computed } from 'vue';
import type { SeriesPoint } from '#shared/types';
import { TIMELINE_LAYOUT, formatTimelineTime, timelineTooltipSide } from '~/utils/timeline';
import { cursorLabelSide, trackReadings, type ResourceBand, type ResourceTrack } from '~/utils/resource-tracks';

const props = defineProps<{
  state: {
    on: boolean;
    t: number;
    /** The pointer's X in the viewport, and the X of the plot's edges there. */
    clientX: number;
    bounds: { left: number; right: number };
    /** Whether the pointer is over a test bar, whose tooltip opens beside it. */
    overBar: boolean;
  };
  pxPerMs: number;
  contentHeight: number;
  /** Each band with the tracks it draws and the Y of its top. */
  bands: Array<{ band: ResourceBand; tracks: ResourceTrack[]; top: number }>;
  /** The pages earlier tests left open in each band's workers. */
  leftOpenFor?: (band: ResourceBand) => SeriesPoint[] | null;
}>();

const { labelWidth, axisHeight, trackHeight, trackGap } = TIMELINE_LAYOUT;

const side = computed(() => {
  const { clientX, bounds, overBar } = props.state;
  const tooltip = overBar && typeof window !== 'undefined' ? timelineTooltipSide(clientX, window.innerWidth) : null;
  return cursorLabelSide(clientX, bounds, tooltip);
});

const readings = computed(() =>
  props.state.on
    ? props.bands.flatMap(({ band, tracks, top }) =>
        trackReadings(band, tracks, props.state.t, props.leftOpenFor?.(band)).map((reading, i) => ({
          key: `${band.key}-${reading.kind}`,
          kind: reading.kind,
          y: top + i * (trackHeight + trackGap) + trackHeight / 2,
          text: reading.text,
          read: reading.value !== null,
        })),
      )
    : [],
);
</script>

<template>
  <ResourceCursorLine
    v-if="state.on"
    :x="labelWidth + state.t * pxPerMs"
    :top="axisHeight"
    :bottom="contentHeight"
    :time-y="axisHeight - 8"
    :time="formatTimelineTime(Math.max(0, Math.round(state.t)))"
    :readings="readings"
    :side="side"
  />
</template>

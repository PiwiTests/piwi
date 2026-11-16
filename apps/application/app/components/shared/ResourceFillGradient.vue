<script setup lang="ts">
/**
 * The fill of the area under a resource track: the track's color, faint at its
 * baseline and deepening toward its top, so a high value stands out. Placed in
 * the track's own coordinates (`userSpaceOnUse`, x scaled by the zoom, y in px),
 * so a zoom leaves it as it is.
 */
import { RESOURCE_FILL_STOPS } from '~/utils/resource-tracks';

defineProps<{
  id: string;
  /** Height of the track's plot, in px. */
  height: number;
  /** The track's color, a text color class (`RESOURCE_TRACK_COLOR`). */
  colorClass: string;
}>();
</script>

<template>
  <linearGradient :id="id" gradientUnits="userSpaceOnUse" x1="0" x2="0" :y1="height" y2="0" :class="colorClass">
    <stop offset="0" stop-color="currentColor" :stop-opacity="RESOURCE_FILL_STOPS.bottom" />
    <stop offset="1" stop-color="currentColor" :stop-opacity="RESOURCE_FILL_STOPS.top" />
  </linearGradient>
</template>

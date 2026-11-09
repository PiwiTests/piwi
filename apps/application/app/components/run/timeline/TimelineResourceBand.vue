<script setup lang="ts">
/**
 * One band of resource tracks: the CPU, memory and open pages one reporter
 * measured, stacked above the worker rows of its shard. Each path is built
 * once in milliseconds and scaled to the zoom by its group's transform, so a
 * zoom moves the tracks without rebuilding them. The pointer over the band
 * reports the moment under it, for the readout and the line across the rows.
 */
import { computed } from 'vue';
import type { SeriesPoint } from '#shared/types';
import { TIMELINE_LAYOUT } from '~/utils/timeline';
import {
  RESOURCE_TRACK_KINDS,
  seriesPaths,
  trackPaths,
  type ResourceBand,
  type ResourceTrack,
} from '~/utils/resource-tracks';

const props = defineProps<{
  band: ResourceBand;
  /** The tracks drawn, in order. */
  tracks: ResourceTrack[];
  /** Y of the band's top. */
  y: number;
  pxPerMs: number;
  /** Width of the run's span at the current zoom. */
  plotWidth: number;
  /** The pages earlier tests left open in the band's workers, drawn under the open pages. */
  leftOpen?: SeriesPoint[] | null;
}>();

const emit = defineEmits<{
  hover: [band: ResourceBand, t: number, event: MouseEvent];
  leave: [];
}>();

const { labelWidth, trackHeight, trackGap } = TIMELINE_LAYOUT;
const trackStride = trackHeight + trackGap;

const height = computed(() => props.tracks.length * trackStride);
const clipId = computed(() => `timeline-${props.band.key}-clip`);

const LABEL = Object.fromEntries(RESOURCE_TRACK_KINDS.map((k) => [k.kind, k.label])) as Record<string, string>;

const drawn = computed(() =>
  props.tracks.map((track, i) => ({
    track,
    top: i * trackStride,
    name: props.band.prefix ? `${props.band.prefix} ${LABEL[track.kind]}` : LABEL[track.kind],
    ...trackPaths(track, trackHeight),
    leftOpen:
      track.kind === 'pages' && props.leftOpen?.length
        ? seriesPaths(props.leftOpen, track.yMax, true, trackHeight).area
        : '',
  })),
);

function onMove(event: MouseEvent): void {
  const svg = (event.currentTarget as SVGElement).ownerSVGElement;
  if (!svg) return;
  const x = event.clientX - svg.getBoundingClientRect().left;
  emit('hover', props.band, (x - labelWidth) / props.pxPerMs, event);
}
</script>

<template>
  <g :transform="`translate(0, ${y})`" :data-resource-band="band.key">
    <defs>
      <clipPath :id="clipId">
        <rect :x="labelWidth" :y="0" :width="Math.max(0, plotWidth)" :height="height" />
      </clipPath>
    </defs>
    <g v-for="item in drawn" :key="item.track.kind" :data-resource-track="item.track.kind">
      <text :x="6" :y="item.top + 9" class="fill-gray-500 text-[11px] font-medium">{{ item.name }}</text>
      <text :x="6" :y="item.top + 20" class="fill-gray-400 text-[9px] tabular-nums">{{ item.track.scaleLabel }}</text>
      <line
        :x1="labelWidth"
        :x2="labelWidth + plotWidth"
        :y1="item.top + trackHeight"
        :y2="item.top + trackHeight"
        class="stroke-gray-200 dark:stroke-gray-700"
      />
      <line
        v-if="item.track.atCapacity"
        :x1="labelWidth"
        :x2="labelWidth + plotWidth"
        :y1="item.top"
        :y2="item.top"
        stroke-dasharray="3 3"
        class="stroke-gray-400 dark:stroke-gray-500"
      />
      <g :clip-path="`url(#${clipId})`">
        <g :transform="`translate(${labelWidth}, ${item.top}) scale(${pxPerMs}, 1)`">
          <path :d="item.area" class="fill-gray-400/20 dark:fill-gray-400/15" />
          <path
            v-if="item.leftOpen"
            :d="item.leftOpen"
            class="fill-red-500/35 dark:fill-red-400/35"
            data-resource-left-open
          />
          <path
            :d="item.line"
            fill="none"
            stroke-width="1.5"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
            class="stroke-gray-500 dark:stroke-gray-400"
          />
        </g>
      </g>
    </g>
    <rect
      :x="labelWidth"
      :y="0"
      :width="Math.max(0, plotWidth)"
      :height="height"
      fill="transparent"
      data-testid="timeline-resource-band"
      @mousemove="onMove"
      @mouseenter="onMove"
      @mouseleave="emit('leave')"
    />
  </g>
</template>

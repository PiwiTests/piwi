<script setup lang="ts">
/**
 * The strip under each worker row: one metric for every worker, on one scale
 * so the rows compare. Open pages draw as a level held until it changes, the
 * sampler's readings as a line, a test's cost as a bar across the test, in the
 * color of the matching resource track. Each path is built once in
 * milliseconds and scaled to the zoom by its group's transform, like the
 * resource tracks; the pointer reports the strip under it, and the timeline
 * the moment.
 */
import { computed } from 'vue';
import { TIMELINE_LAYOUT } from '~/utils/timeline';
import {
  seriesPaths,
  spansPath,
  workerMetricColor,
  type WorkerStrip,
  type WorkerStripSet,
} from '~/utils/resource-tracks';

const props = defineProps<{
  set: WorkerStripSet;
  /** Y of each strip's top, by its row's first lane. */
  stripTop: (lane: number) => number | null;
  pxPerMs: number;
  /** Width of the run's span at the current zoom. */
  plotWidth: number;
}>();

const emit = defineEmits<{
  hover: [strip: WorkerStrip];
  leave: [];
}>();

const { labelWidth, stripPlot } = TIMELINE_LAYOUT;

const color = computed(() => workerMetricColor(props.set.kind));

// A mouse reports the strip it is over; a finger reports the strip it taps, which stays until the next tap.
function onEnter(strip: WorkerStrip, event: PointerEvent): void {
  if (event.pointerType !== 'touch') emit('hover', strip);
}
function onTap(strip: WorkerStrip, event: PointerEvent): void {
  if (event.pointerType === 'touch') emit('hover', strip);
}
function onLeave(event: PointerEvent): void {
  if (event.pointerType !== 'touch') emit('leave');
}

const paths = computed(() =>
  props.set.strips.map((strip) => ({
    strip,
    ...(strip.mode === 'spans'
      ? { line: '', area: spansPath(strip.spans, props.set.yMax, stripPlot) }
      : seriesPaths(strip.points, props.set.yMax, strip.mode === 'step', stripPlot)),
    leftOpen: strip.leftOpen.length > 0 ? seriesPaths(strip.leftOpen, props.set.yMax, true, stripPlot).area : '',
  })),
);
</script>

<template>
  <g :data-worker-strips="set.kind">
    <defs>
      <clipPath id="timeline-worker-strip-clip">
        <rect :x="labelWidth" :y="0" :width="Math.max(0, plotWidth)" :height="stripPlot" />
      </clipPath>
      <ResourceFillGradient id="timeline-worker-strip-fill" :height="stripPlot" :color-class="color" />
    </defs>
    <template v-for="item in paths" :key="item.strip.lane">
      <g v-if="stripTop(item.strip.lane) !== null" :transform="`translate(0, ${stripTop(item.strip.lane)})`">
        <text :x="6" :y="stripPlot - 1" class="fill-gray-400 text-[9px] tabular-nums">{{ set.scaleLabel }}</text>
        <line
          :x1="labelWidth"
          :x2="labelWidth + plotWidth"
          :y1="stripPlot"
          :y2="stripPlot"
          class="stroke-gray-200 dark:stroke-gray-700"
        />
        <g clip-path="url(#timeline-worker-strip-clip)">
          <g :transform="`translate(${labelWidth}, 0) scale(${pxPerMs}, 1)`" :class="color">
            <!-- A test's bar has no line over it: its area alone carries its value, so it is filled evenly. -->
            <path
              :d="item.area"
              :fill="item.strip.mode === 'spans' ? 'currentColor' : 'url(#timeline-worker-strip-fill)'"
              :fill-opacity="item.strip.mode === 'spans' ? 0.45 : undefined"
            />
            <path v-if="item.leftOpen" :d="item.leftOpen" class="fill-red-500/45 dark:fill-red-400/40" />
            <path
              v-if="item.line"
              :d="item.line"
              fill="none"
              stroke-width="1"
              vector-effect="non-scaling-stroke"
              stroke="currentColor"
            />
          </g>
        </g>
        <rect
          :x="labelWidth"
          :y="0"
          :width="Math.max(0, plotWidth)"
          :height="stripPlot"
          fill="transparent"
          data-testid="timeline-worker-strip"
          @pointerenter="onEnter(item.strip, $event)"
          @pointerup="onTap(item.strip, $event)"
          @pointerleave="onLeave($event)"
        />
      </g>
    </template>
  </g>
</template>

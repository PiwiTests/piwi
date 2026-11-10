<script setup lang="ts">
/**
 * The strip under each worker row: one metric for every worker, on one scale
 * so the rows compare. Open pages draw as a level held until it changes, the
 * sampler's readings as a line, a test's cost as a bar across the test. Each path is built once in
 * milliseconds and scaled to the zoom by its group's transform, like the
 * resource tracks; the pointer reports the strip and moment under it.
 */
import { computed } from 'vue';
import { TIMELINE_LAYOUT } from '~/utils/timeline';
import { seriesPaths, spansPath, type WorkerStrip, type WorkerStripSet } from '~/utils/resource-tracks';

const props = defineProps<{
  set: WorkerStripSet;
  /** Y of each strip's top, by its row's first lane. */
  stripTop: (lane: number) => number | null;
  pxPerMs: number;
  /** Width of the run's span at the current zoom. */
  plotWidth: number;
}>();

const emit = defineEmits<{
  hover: [strip: WorkerStrip, t: number, event: MouseEvent];
  leave: [];
}>();

const { labelWidth, stripPlot } = TIMELINE_LAYOUT;

const paths = computed(() =>
  props.set.strips.map((strip) => ({
    strip,
    ...(strip.mode === 'spans'
      ? { line: '', area: spansPath(strip.spans, props.set.yMax, stripPlot) }
      : seriesPaths(strip.points, props.set.yMax, strip.mode === 'step', stripPlot)),
    leftOpen: strip.leftOpen.length > 0 ? seriesPaths(strip.leftOpen, props.set.yMax, true, stripPlot).area : '',
  })),
);

function onMove(strip: WorkerStrip, event: MouseEvent): void {
  const svg = (event.currentTarget as SVGElement).ownerSVGElement;
  if (!svg) return;
  const x = event.clientX - svg.getBoundingClientRect().left;
  emit('hover', strip, (x - labelWidth) / props.pxPerMs, event);
}
</script>

<template>
  <g :data-worker-strips="set.kind">
    <defs>
      <clipPath id="timeline-worker-strip-clip">
        <rect :x="labelWidth" :y="0" :width="Math.max(0, plotWidth)" :height="stripPlot" />
      </clipPath>
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
          <g :transform="`translate(${labelWidth}, 0) scale(${pxPerMs}, 1)`">
            <path :d="item.area" class="fill-gray-400/40 dark:fill-gray-400/30" />
            <path v-if="item.leftOpen" :d="item.leftOpen" class="fill-red-500/45 dark:fill-red-400/40" />
            <path
              v-if="item.line"
              :d="item.line"
              fill="none"
              stroke-width="1"
              vector-effect="non-scaling-stroke"
              class="stroke-gray-500 dark:stroke-gray-400"
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
          @mousemove="onMove(item.strip, $event)"
          @mouseenter="onMove(item.strip, $event)"
          @mouseleave="emit('leave')"
        />
      </g>
    </template>
  </g>
</template>

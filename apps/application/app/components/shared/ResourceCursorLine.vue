<script setup lang="ts">
/**
 * The line under the pointer across a timeline that draws resource rows: the
 * moment on the axis and, beside the line, each row's value then, on the side
 * `side` names. The values sit on a halo of the page's background and the
 * moment on a box of it, so they read over the bars, curves and tick labels
 * they cross. Draws only: each timeline works out the moment, the readings and
 * the side.
 */
import { computed } from 'vue';

const props = defineProps<{
  /** X of the line. */
  x: number;
  /** Y of the line's ends. */
  top: number;
  bottom: number;
  /** Y of the moment's label, on the axis. */
  timeY: number;
  time: string;
  /** Each row's value, at the Y of its row's middle; `read` is false where the row has no reading then. */
  readings: Array<{ key: string; kind: string; y: number; text: string; read: boolean }>;
  side: 'left' | 'right';
}>();

/** Space between the line and its labels. */
const LABEL_GAP = 5;
/** The width of a character of the moment's label, in px. */
const TIME_CHAR_WIDTH = 6;
/** How far past the moment's label, on each side, its box hides the axis: half of a tick's label and more. */
const TICK_LABEL_REACH = 22;

const labelX = computed(() => (props.side === 'right' ? props.x + LABEL_GAP : props.x - LABEL_GAP));
const anchor = computed(() => (props.side === 'right' ? 'start' : 'end'));
/** The box under the moment's label: it hides a tick label it would cut, whole rather than in part. */
const timeBox = computed(() => {
  const text = props.time.length * TIME_CHAR_WIDTH;
  const start = props.side === 'right' ? props.x : labelX.value - text;
  const end = props.side === 'right' ? labelX.value + text : props.x;
  return { x: start - TICK_LABEL_REACH, y: props.timeY - 10, width: end - start + TICK_LABEL_REACH * 2, height: 14 };
});
</script>

<template>
  <g class="pointer-events-none" data-testid="resource-cursor">
    <line :x1="x" :x2="x" :y1="top" :y2="bottom" stroke-dasharray="3 3" class="stroke-gray-400 dark:stroke-gray-500" />
    <rect v-bind="timeBox" class="fill-[var(--ui-bg)]" />
    <text
      :x="labelX"
      :y="timeY"
      :text-anchor="anchor"
      class="fill-gray-900 dark:fill-white text-[10px] font-medium tabular-nums"
      data-testid="resource-cursor-time"
    >
      {{ time }}
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
      :class="reading.read ? 'fill-gray-900 dark:fill-white' : 'fill-gray-400 dark:fill-gray-500'"
      :data-resource-reading="reading.kind"
    >
      {{ reading.text }}
    </text>
  </g>
</template>

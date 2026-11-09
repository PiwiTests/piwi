<script setup lang="ts">
/**
 * The objects each worker kept open for nothing, as thin tails under its row:
 * a leak from the end of the test that opened it to its close or the worker's
 * end, a lingering object from its last use to its close. Overlapping tails
 * stack on sub-lines. Each path is built once in milliseconds and scaled to
 * the zoom by its group's transform, like the resource tracks; the pointer
 * reports the tail under it, and a click opens the test it outlived.
 */
import { computed } from 'vue';
import { TIMELINE_LAYOUT } from '~/utils/timeline';
import { MAX_TAIL_LEVELS, tailAt, tailsPath, type RowTails, type SpanTail } from '~/utils/resource-spans';

const props = defineProps<{
  rows: RowTails[];
  /** Y of each row's tails, by its first lane. */
  tailTop: (lane: number) => number | null;
  pxPerMs: number;
  /** Width of the run's span at the current zoom. */
  plotWidth: number;
}>();

const emit = defineEmits<{
  hover: [tail: SpanTail, event: MouseEvent];
  leave: [];
  select: [tail: SpanTail];
}>();

const { labelWidth, tailHeight, tailGap } = TIMELINE_LAYOUT;
const stride = tailHeight + tailGap;

const drawn = computed(() =>
  props.rows.map((row) => ({
    row,
    height: row.levels * stride,
    leaked: tailsPath(row.tails, 'leaked', tailHeight, stride),
    lingering: tailsPath(row.tails, 'lingering', tailHeight, stride),
  })),
);

/** The tail under the pointer in a row's area, if any. */
function tailUnder(row: RowTails, event: MouseEvent): SpanTail | null {
  const svg = (event.currentTarget as SVGElement).ownerSVGElement;
  const top = props.tailTop(row.lane);
  if (!svg || top === null) return null;
  const rect = svg.getBoundingClientRect();
  const t = (event.clientX - rect.left - labelWidth) / props.pxPerMs;
  const level = Math.floor((event.clientY - rect.top - top) / stride);
  // A tail a few pixels wide stays easy to hover: look a little either side of the pointer.
  const reach = 3 / props.pxPerMs;
  return tailAt(row, t, level) ?? tailAt(row, t - reach, level) ?? tailAt(row, t + reach, level);
}

function onMove(row: RowTails, event: MouseEvent): void {
  const tail = tailUnder(row, event);
  if (tail) emit('hover', tail, event);
  else emit('leave');
}

function onClick(row: RowTails, event: MouseEvent): void {
  const tail = tailUnder(row, event);
  if (tail) emit('select', tail);
}
</script>

<template>
  <g data-span-tails>
    <defs>
      <clipPath id="timeline-span-tails-clip">
        <rect :x="labelWidth" :y="0" :width="Math.max(0, plotWidth)" :height="MAX_TAIL_LEVELS * stride" />
      </clipPath>
    </defs>
    <template v-for="item in drawn" :key="item.row.lane">
      <g v-if="tailTop(item.row.lane) !== null" :transform="`translate(0, ${tailTop(item.row.lane)})`">
        <g clip-path="url(#timeline-span-tails-clip)">
          <g :transform="`translate(${labelWidth}, 0) scale(${pxPerMs}, 1)`">
            <path
              v-if="item.leaked"
              :d="item.leaked"
              class="fill-red-500/75 dark:fill-red-400/75"
              data-span-tails-verdict="leaked"
            />
            <path
              v-if="item.lingering"
              :d="item.lingering"
              class="fill-amber-500/75 dark:fill-amber-400/75"
              data-span-tails-verdict="lingering"
            />
          </g>
        </g>
        <rect
          :x="labelWidth"
          :y="0"
          :width="Math.max(0, plotWidth)"
          :height="item.height"
          fill="transparent"
          class="cursor-pointer"
          data-testid="timeline-span-tails"
          @mousemove="onMove(item.row, $event)"
          @mouseenter="onMove(item.row, $event)"
          @mouseleave="emit('leave')"
          @click="onClick(item.row, $event)"
        />
      </g>
    </template>
  </g>
</template>

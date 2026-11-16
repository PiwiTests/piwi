<script setup lang="ts">
/**
 * The line under the pointer on an execution's timeline while its resources
 * rows show: across every lane, the moment on the axis and each row's value
 * beside it, on the side a bar's tooltip leaves free. Reads the hover state
 * the card writes, so a pointer move redraws this and not the card.
 */
import { computed } from 'vue';
import { cursorLabelSide } from '~/utils/resource-tracks';
import { resourceReading, type TimelineResourceRow } from '~/utils/timeline-resource-rows';

const props = defineProps<{
  /** The pointer: its X in the chart and in the viewport, and the moment under it. */
  state: { on: boolean; x: number; clientX: number; at: number };
  rows: TimelineResourceRow[];
  /** Y of the first row's top, and each row's height. */
  rowsTop: number;
  rowHeight: number;
  /** Y of the line's ends, and of the moment's label on the axis. */
  top: number;
  bottom: number;
  timeY: number;
  plotLeft: number;
  plotRight: number;
  /** The moment as the axis words it. */
  formatTime: (at: number) => string;
  /** The left edge of a bar's open tooltip, in the viewport; null when none is open. */
  tooltipX: number | null;
}>();

const side = computed(() => {
  const { x, clientX } = props.state;
  const tooltip = props.tooltipX === null ? null : props.tooltipX > clientX ? 'right' : 'left';
  return cursorLabelSide(x, { left: props.plotLeft, right: props.plotRight }, tooltip);
});

const readings = computed(() =>
  props.rows.map((row, i) => {
    const text = resourceReading(row, props.state.at);
    return {
      key: row.kind,
      kind: row.kind,
      y: props.rowsTop + i * props.rowHeight + props.rowHeight / 2,
      text: text ?? 'not read',
      read: text !== null,
    };
  }),
);
</script>

<template>
  <ResourceCursorLine
    v-if="state.on"
    :x="state.x"
    :top="top"
    :bottom="bottom"
    :time-y="timeY"
    :time="formatTime(state.at)"
    :readings="readings"
    :side="side"
  />
</template>

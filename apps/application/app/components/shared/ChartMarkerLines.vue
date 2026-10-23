<script setup lang="ts">
import type { MarkerInfo } from '~~/types/api';
import { getMarkerCategory } from '#shared/marker-categories';

/**
 * Vertical timeline-marker lines for an SVG trend chart: a dashed line with a
 * flag handle per marker. Rendered inside a `ChartFrame` slot, which shows the
 * hovered marker's tooltip. `xOf` maps a marker's timestamp to a plot-space
 * x position; null hides the marker (outside the plotted range).
 */
const props = defineProps<{
  markers: MarkerInfo[];
  xOf: (occurredAt: string | Date) => number | null;
  plotHeight: number;
  /**
   * Declared as a prop rather than an emit so the lines know whether a parent
   * listens: without a `@marker-click` listener the flags are not clickable.
   */
  onMarkerClick?: (id: number) => void;
}>();

const positioned = computed(() =>
  props.markers
    .map((marker) => ({ marker, x: props.xOf(marker.occurredAt), color: getMarkerCategory(marker.category).hex }))
    .filter((entry): entry is { marker: MarkerInfo; x: number; color: string } => entry.x != null),
);

const { data: hovered, show, move, hide, clickable } = useChartMarkerTooltip();
watchEffect(() => (clickable.value = !!props.onMarkerClick));

// Keyboard focus shows the tooltip beside the flag, as a hover would.
function showFromFocus(e: FocusEvent, marker: MarkerInfo) {
  const rect = (e.currentTarget as Element).getBoundingClientRect();
  show({ clientX: rect.right, clientY: rect.top + rect.height / 2 } as MouseEvent, marker);
}
</script>

<template>
  <g>
    <g
      v-for="{ marker, x, color } in positioned"
      :key="marker.id"
      :class="onMarkerClick ? 'cursor-pointer' : 'cursor-default'"
      :role="onMarkerClick ? 'button' : 'img'"
      :tabindex="onMarkerClick ? 0 : undefined"
      :aria-label="`Marker: ${marker.label}`"
      data-testid="chart-marker"
      @click="onMarkerClick?.(marker.id)"
      @keydown.enter="onMarkerClick?.(marker.id)"
      @mouseenter="show($event, marker)"
      @mousemove="move($event)"
      @mouseleave="hide()"
      @focus="showFromFocus($event, marker)"
      @blur="hide()"
    >
      <line
        :x1="x"
        :x2="x"
        :y1="0"
        :y2="plotHeight"
        :stroke="color"
        :stroke-width="hovered?.id === marker.id ? 2 : 1.5"
        stroke-dasharray="4 3"
        :opacity="hovered?.id === marker.id ? 1 : 0.75"
      />
      <!-- Wider invisible hit areas, so the whole line and a generous zone
           around the flag answer the pointer, not only the 4px dot. -->
      <line :x1="x" :x2="x" :y1="0" :y2="plotHeight" stroke="transparent" stroke-width="8" />
      <circle :cx="x" :cy="0" r="10" fill="transparent" />
      <circle :cx="x" :cy="0" :r="hovered?.id === marker.id ? 6 : 4" :fill="color" stroke="#fff" stroke-width="1.5" />
    </g>
  </g>
</template>

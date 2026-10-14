<script setup lang="ts">
/**
 * The hovered bar, lifted above a translucent wash over the rest of the
 * timeline. A hover changes this one overlay and the copied bars, so moving
 * across hundreds of bars restyles nothing else. The copies ignore the
 * pointer: the bar underneath stays the hover target. Empty stretches of a
 * lane never take the focus. When the hovered test ran more than once, every
 * attempt is lifted with it, joined by arrows in the order they ran.
 */
import { computed } from 'vue';
import { isGapKind, type TimelineItem } from '~/composables/useTimelineModel';
import { TIMELINE_LAYOUT } from '~/utils/timeline';

const props = defineProps<{
  /** The hover state the timeline shares with its tooltip. */
  state: { item: TimelineItem | null };
  contentWidth: number;
  contentHeight: number;
  getBarX: (item: TimelineItem) => number;
  getBarTop: (item: TimelineItem) => number;
  getBarWidth: (item: TimelineItem) => number;
  lockColors: (item: TimelineItem) => string[];
  expandable: (item: TimelineItem) => boolean;
  /** A test's hook sections, lifted with it. */
  hooks: (item: TimelineItem) => TimelineItem[];
  hookGeometry: (item: TimelineItem) => { x: number; width: number };
  /** Every attempt of a test that ran more than once, first attempt first; empty otherwise. */
  attempts: (item: TimelineItem) => TimelineItem[];
}>();

const { labelWidth, axisHeight, barHeight } = TIMELINE_LAYOUT;

const focus = computed(() => {
  const item = props.state.item;
  return item && !isGapKind(item.kind) ? item : null;
});

/** The bars lifted: the hovered one, or every attempt of its test. */
const lifted = computed<TimelineItem[]>(() => {
  const item = focus.value;
  if (!item) return [];
  const attempts = props.attempts(item);
  return attempts.length > 1 ? attempts : [item];
});

/** How high an arrow between two attempts on one lane rises above them. */
const SAME_LANE_RISE = 12;

/**
 * An arrow from the end of each attempt to the start of the next: an arc over
 * the stretch between them on one lane, a curve down or up to another lane.
 */
const arrows = computed(() => {
  const bars = lifted.value;
  const paths: string[] = [];
  for (let i = 1; i < bars.length; i++) {
    const from = bars[i - 1]!;
    const to = bars[i]!;
    const x1 = props.getBarX(from) + props.getBarWidth(from);
    const x2 = props.getBarX(to);
    const y1 = props.getBarTop(from);
    const y2 = props.getBarTop(to);
    if (y1 === y2) {
      const top = y1 - SAME_LANE_RISE;
      const a = Math.max(x1 - 6, props.getBarX(from));
      const b = x2 + 6;
      paths.push(`M ${a} ${y1} C ${a} ${top}, ${b} ${top}, ${b} ${y2}`);
    } else {
      const m1 = y1 + barHeight / 2;
      const m2 = y2 + barHeight / 2;
      const reach = Math.max(24, Math.abs(x2 - x1) / 2);
      paths.push(`M ${x1} ${m1} C ${x1 + reach} ${m1}, ${x2 - reach} ${m2}, ${x2} ${m2}`);
    }
  }
  return paths;
});
</script>

<template>
  <g v-if="focus" class="pointer-events-none" data-timeline-focus>
    <rect
      :x="labelWidth"
      :y="axisHeight"
      :width="Math.max(0, contentWidth - labelWidth)"
      :height="Math.max(0, contentHeight - axisHeight)"
      fill-opacity="0.6"
      :style="{ fill: 'var(--ui-bg-canvas)' }"
    />
    <TimelineBar
      v-for="bar in lifted"
      :key="bar.key"
      :item="bar"
      :x="getBarX(bar)"
      :y="getBarTop(bar)"
      :width="getBarWidth(bar)"
      :lock-colors="lockColors(bar)"
      :expandable="expandable(bar)"
      :hooks="hooks(bar)"
      :hook-geometry="hookGeometry"
    />
    <path
      v-for="(d, i) in arrows"
      :key="i"
      :d="d"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-dasharray="4 3"
      marker-end="url(#timeline-retry-arrow)"
      class="text-gray-600 dark:text-gray-300"
      data-timeline-retry-arrow
    />
  </g>
</template>

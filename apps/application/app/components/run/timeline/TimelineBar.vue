<script setup lang="ts">
import { computed } from 'vue';
import { isGapKind, isHookKind, type TimelineItem } from '~/composables/useTimelineModel';
import {
  TIMELINE_LAYOUT,
  TIMELINE_WAIT_COLORS,
  timelineStatusFill,
  timelineRetriedAttemptStyle,
  timelineHookColors,
  timelineStepColor,
  formatTimelineTime,
} from '~/utils/timeline';

const props = defineProps<{
  item: TimelineItem;
  x: number;
  y: number;
  width: number;
  /** Colors of the locks this bar's execution held, in the run's lock order. */
  lockColors?: string[];
  /** Whether this test row can be expanded into its step waterfall (test bars only). */
  expandable?: boolean;
  /** The test's hook sections, drawn over its bar as plain shapes — test bars only. */
  hooks?: TimelineItem[];
  /** Where a hook section sits, on the same scale as `x` and `width`. */
  hookGeometry?: (item: TimelineItem) => { x: number; width: number };
}>();

const emit = defineEmits<{
  select: [id: number];
  toggleExpand: [id: number];
  /** A hook section was clicked: open its test's steps on the hook. */
  inspectHook: [item: TimelineItem];
  hover: [item: TimelineItem, event: MouseEvent];
  move: [event: MouseEvent];
  leave: [];
}>();

const { barHeight, stepBarHeight, hookMinWidth, failedHookMinWidth } = TIMELINE_LAYOUT;

/** Setup steps render like hooks; they just aren't tied to a test case. */
const isHookLike = computed(() => isHookKind(props.item.kind));
/** An empty stretch of the lane, drawn faintly. */
const isGap = computed(() => isGapKind(props.item.kind));

/** Approximate width of one character of a bar's or a gap's 10px label. */
const LABEL_CHAR_PX = 5.5;

/**
 * A gap's duration, centered on its dashed line when it fits (`↻ 1.1s` for a
 * new worker process, `idle 2.0s`); the line breaks around it.
 */
const gapLabel = computed<{ text: string; from: number; to: number } | null>(() => {
  if (!isGap.value) return null;
  const time = formatTimelineTime(props.item.duration);
  const text = props.item.kind === 'restart' ? `↻ ${time}` : `idle ${time}`;
  const half = (text.length * LABEL_CHAR_PX) / 2 + 4;
  if (props.width < half * 2 + 12) return null;
  const center = props.x + props.width / 2;
  return { text, from: center - half, to: center + half };
});
/**
 * The hook sections this bar draws: itself when it is one (a suite setup step,
 * or the hovered section's copy), else the test's own. A failed one keeps a
 * minimum width so a millisecond teardown failure stays visible; a passed one
 * narrower than a pixel is left out until zooming in makes it visible.
 */
const hookRects = computed(() => {
  let rects: Array<{ item: TimelineItem; x: number; width: number }> = [];
  if (isHookLike.value) rects = [{ item: props.item, x: props.x, width: props.width }];
  else if (props.item.kind === 'test' && props.hooks?.length && props.hookGeometry) {
    const geometry = props.hookGeometry;
    rects = props.hooks.map((hook) => ({ item: hook, ...geometry(hook) }));
  }
  return rects.flatMap((rect) => {
    const failed = rect.item.status === 'failed';
    if (!failed && rect.width < hookMinWidth) return [];
    const width = failed ? Math.max(rect.width, failedHookMinWidth) : rect.width;
    return [{ ...rect, width, stroke: timelineHookColors(rect.item.status).stroke }];
  });
});

/**
 * A test bar's fill: solid in its outcome color, or for an attempt Playwright
 * retried, a pale wash under an outline drawn inside the bar's edge.
 */
const testRect = computed(() => {
  const { x, y, width, item } = props;
  if (!item.retried) return { x, y, width, height: barHeight, style: timelineStatusFill(item.status, item.retries) };
  const inset = Math.min(0.75, width / 4);
  return {
    x: x + inset,
    y: y + 0.75,
    width: width - inset * 2,
    height: barHeight - 1.5,
    style: timelineRetriedAttemptStyle(item.status, item.retries),
  };
});

/**
 * A test bar's label: its duration, led by the attempt number when the test
 * ran more than once and the bar has room for both.
 */
const testLabel = computed<string | null>(() => {
  const time = formatTimelineTime(props.item.duration);
  if (props.item.attemptKeys) {
    const room = props.width - (props.expandable ? 16 : 4) - 4;
    const text = `Attempt ${(props.item.retries ?? 0) + 1} · ${time}`;
    if (text.length * LABEL_CHAR_PX <= room) return text;
  }
  return props.width > 40 ? time : null;
});

/** Label text on a solid bar is white; on a retried attempt's pale wash it is the page's text color. */
const testLabelClass = computed(() => (props.item.retried ? 'fill-gray-800 dark:fill-gray-100' : 'fill-white'));

/** Every bar with an owning test case clicks through to it (suite setup has none). */
const clickable = computed(() => props.item.testCaseId != null);
const cursorClass = computed(() => (clickable.value ? 'cursor-pointer' : 'cursor-default'));

// A step bar is shorter than a test bar and centered in its lane.
const stepY = computed(() => props.y + (barHeight - stepBarHeight) / 2);
const stepFill = computed(() => timelineStepColor(props.item.category ?? 'other', props.item.status === 'failed'));

function onClick(): void {
  if (props.item.testCaseId != null) emit('select', props.item.testCaseId);
}

function onHookClick(hook: TimelineItem): void {
  if (hook.testCaseId != null) emit('inspectHook', hook);
}

// A test's hook section is its own hover target inside the test's group:
// entering it shows the section, leaving it back onto the bar shows the test.
function onHookEnter(hook: TimelineItem, event: MouseEvent): void {
  emit('hover', hook, event);
}

function onHookLeave(event: MouseEvent): void {
  if (!isHookLike.value) emit('hover', props.item, event);
}

// Clicking a test bar expands or collapses its step waterfall; when the row
// can't be expanded (a live run, no execution id) it falls back to selecting.
function onTestClick(): void {
  if (props.item.testCaseId == null) return;
  if (props.expandable) emit('toggleExpand', props.item.testCaseId);
  else emit('select', props.item.testCaseId);
}
</script>

<template>
  <g @mouseenter="emit('hover', item, $event)" @mousemove="emit('move', $event)" @mouseleave="emit('leave')">
    <template v-if="isGap">
      <!-- A hover target over the whole stretch, a dashed midline broken around
           its duration, and for a new worker process a tick where it took over. -->
      <rect
        :x="x"
        :y="y"
        :width="Math.max(width, 6)"
        :height="barHeight"
        fill="transparent"
        data-timeline-gap
        :data-kind="item.kind"
      />
      <line
        v-for="(segment, i) in gapLabel
          ? [
              [x, gapLabel.from],
              [gapLabel.to, x + width],
            ]
          : [[x, x + width]]"
        :key="i"
        :x1="segment[0]"
        :y1="y + barHeight / 2"
        :x2="segment[1]"
        :y2="y + barHeight / 2"
        stroke="currentColor"
        stroke-dasharray="2,4"
        class="text-gray-300 dark:text-gray-600 pointer-events-none"
      />
      <text
        v-if="gapLabel"
        :x="x + width / 2"
        :y="y + barHeight / 2 + 3.5"
        text-anchor="middle"
        class="fill-gray-400 dark:fill-gray-500 text-[10px] tabular-nums pointer-events-none select-none"
      >
        {{ gapLabel.text }}
      </text>
      <template v-if="item.kind === 'restart'">
        <line
          :x1="x + width"
          :y1="y + 2"
          :x2="x + width"
          :y2="y + barHeight - 2"
          stroke="currentColor"
          stroke-width="1.5"
          class="text-gray-400 dark:text-gray-500 pointer-events-none"
        />
        <text
          v-if="!gapLabel && width > 18"
          :x="x + width / 2"
          :y="y + barHeight / 2 + 4"
          text-anchor="middle"
          class="fill-gray-400 dark:fill-gray-500 text-[11px] pointer-events-none select-none"
        >
          ↻
        </text>
      </template>
    </template>
    <template v-else-if="item.kind === 'step'">
      <rect
        :x="x"
        :y="stepY"
        :width="width"
        :height="stepBarHeight"
        :rx="2"
        :ry="2"
        :fill="stepFill"
        class="cursor-pointer opacity-90"
        @click="onClick"
      />
      <text
        v-if="width > 34"
        :x="x + 4"
        :y="stepY + stepBarHeight / 2 + 3.5"
        class="fill-white text-[9px] font-medium pointer-events-none"
      >
        {{ item.title }}
      </text>
    </template>
    <!-- A hook section draws below, with the test's own sections. -->
    <template v-else-if="isHookLike" />
    <template v-else-if="item.kind === 'wait'">
      <!-- slightly taller bar, offset into the row gap above/below -->
      <rect
        :x="x"
        :y="y - 3"
        :width="width"
        :height="barHeight + 6"
        :rx="2"
        :ry="2"
        :fill="TIMELINE_WAIT_COLORS.fill"
        fill-opacity="0.28"
        :stroke="TIMELINE_WAIT_COLORS.stroke"
        stroke-width="1.5"
        class="opacity-90"
        :class="cursorClass"
        @click="onClick"
      />
      <line
        v-if="width > 4"
        :x1="x + 1"
        :y1="y - 3"
        :x2="x + width - 1"
        :y2="y + barHeight + 3"
        :stroke="TIMELINE_WAIT_COLORS.stroke"
        stroke-width="1"
        stroke-opacity="0.25"
        class="pointer-events-none"
      />
      <line
        v-if="width > 4"
        :x1="x + width - 1"
        :y1="y - 3"
        :x2="x + 1"
        :y2="y + barHeight + 3"
        :stroke="TIMELINE_WAIT_COLORS.stroke"
        stroke-width="1"
        stroke-opacity="0.25"
        class="pointer-events-none"
      />
      <text
        v-if="width > 50"
        :x="x + 4"
        :y="y + barHeight / 2 + 4"
        class="fill-yellow-800 dark:fill-yellow-200 text-[9px] font-bold pointer-events-none"
      >
        wasted {{ formatTimelineTime(item.duration) }}
      </text>
    </template>
    <template v-else-if="item.status === 'running'">
      <circle
        :cx="x + 6"
        :cy="y + barHeight / 2"
        r="3"
        :style="{ fill: STATUS_PALETTE.running.color }"
        filter="url(#glow)"
        class="cursor-pointer opacity-90"
        @click="onClick"
      />
      <circle
        :cx="x + 6"
        :cy="y + barHeight / 2"
        r="5"
        fill="none"
        :style="{ stroke: STATUS_PALETTE.running.color }"
        stroke-width="1.5"
        stroke-opacity="0.4"
        filter="url(#glow)"
        class="cursor-pointer opacity-90"
        @click="onClick"
      />
    </template>
    <template v-else>
      <rect
        :x="testRect.x"
        :y="testRect.y"
        :width="testRect.width"
        :height="testRect.height"
        :rx="3"
        :ry="3"
        :style="testRect.style"
        class="cursor-pointer opacity-90"
        data-timeline-test
        :data-title="item.attemptKeys ? item.title : undefined"
        :data-attempt="item.attemptKeys ? (item.retries ?? 0) + 1 : undefined"
        :data-retried="item.retried ? '' : undefined"
        @click="onTestClick"
      />
      <!-- Lock brackets: a thin colored strip along the top edge per held lock. -->
      <rect
        v-for="(color, i) in lockColors ?? []"
        :key="`lock${i}`"
        :x="x"
        :y="y + i * 3"
        :width="width"
        :height="2.5"
        :fill="color"
        class="pointer-events-none"
      />
      <!-- Expand affordance: a chevron that turns down when the step waterfall is open. -->
      <text
        v-if="expandable && width > 22"
        :x="x + 4"
        :y="y + barHeight / 2 + 3.5"
        class="text-[10px] pointer-events-none select-none"
        :class="testLabelClass"
      >
        {{ item.expanded ? '▾' : '▸' }}
      </text>
      <text
        v-if="testLabel"
        :x="expandable ? x + 16 : x + 4"
        :y="y + barHeight / 2 + 4"
        class="text-[10px] font-medium pointer-events-none"
        :class="testLabelClass"
      >
        {{ testLabel }}
      </text>
    </template>
    <!-- Hook time over the test's bar: a wash hatched so it reads as not the test body. -->
    <rect
      v-for="rect in hookRects"
      :key="rect.item.key"
      :x="rect.x"
      :y="y"
      :width="rect.width"
      :height="barHeight"
      :rx="3"
      :ry="3"
      :fill="rect.item.status === 'failed' ? 'url(#timeline-hook-failed)' : 'url(#timeline-hook-passed)'"
      :stroke="rect.stroke"
      stroke-width="1"
      :class="rect.item.testCaseId != null ? 'cursor-pointer' : 'cursor-default'"
      data-timeline-hook
      :data-status="rect.item.status"
      @mouseenter="onHookEnter(rect.item, $event)"
      @mouseleave="onHookLeave"
      @click="onHookClick(rect.item)"
    />
  </g>
</template>

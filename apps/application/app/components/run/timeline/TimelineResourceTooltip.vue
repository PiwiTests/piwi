<script setup lang="ts">
/**
 * The readout of the strip under a worker row at the moment under the
 * pointer: that worker's value then, or why there is none. The resource
 * tracks' values sit beside the line across the timeline
 * (`TimelineResourceCursor`).
 */
import { computed } from 'vue';
import { formatTimelineTime } from '~/utils/timeline';
import { WORKER_METRICS, stripReading, type WorkerStrip, type WorkerStripSet } from '~/utils/resource-tracks';

const props = defineProps<{
  state: {
    strip: { set: WorkerStripSet; strip: WorkerStrip } | null;
    t: number;
    pos: { x: number; y: number };
  };
}>();

/** The hovered strip's worker, metric and value, or why there is none then. */
const stripRow = computed(() => {
  const hovered = props.state.strip;
  if (!hovered) return null;
  const metric = WORKER_METRICS.find((m) => m.kind === hovered.set.kind)!;
  return {
    name: hovered.strip.name,
    label: metric.menuLabel,
    value:
      stripReading(hovered.set, hovered.strip, props.state.t) ??
      (hovered.strip.mode === 'spans' ? 'No test ran then' : 'Not read then'),
  };
});

const TOOLTIP_MAX_WIDTH = 320;
const positionStyle = computed(() => {
  const { x, y } = props.state.pos;
  if (typeof window === 'undefined') return { left: `${x + 12}px`, top: `${y + 12}px` };
  const flipX = x + 12 + TOOLTIP_MAX_WIDTH > window.innerWidth;
  return {
    left: flipX ? undefined : `${x + 12}px`,
    right: flipX ? `${window.innerWidth - x + 12}px` : undefined,
    top: `${y + 12}px`,
  };
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="stripRow"
      class="fixed z-[9999] pointer-events-none rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs shadow-lg max-w-80"
      :style="positionStyle"
      data-testid="timeline-worker-strip-tooltip"
    >
      <div class="mb-1 font-medium text-gray-900 dark:text-white tabular-nums">
        {{ formatTimelineTime(Math.max(0, Math.round(state.t))) }}
        <span class="font-normal text-gray-500"> · {{ stripRow.name }}</span>
      </div>
      <dl class="grid grid-cols-[auto_1fr] gap-x-2">
        <dt class="text-gray-500">{{ stripRow.label }}</dt>
        <dd class="text-gray-900 dark:text-white">{{ stripRow.value }}</dd>
      </dl>
    </div>
  </Teleport>
</template>

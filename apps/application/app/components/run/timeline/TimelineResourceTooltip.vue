<script setup lang="ts">
/**
 * The readout at the moment under the pointer: in a resource band, the
 * machine's CPU, the run's memory and the pages open in each worker then; in a
 * worker's strip, that worker's value then.
 */
import { computed } from 'vue';
import type { SeriesPoint } from '#shared/types';
import { formatTimelineTime } from '~/utils/timeline';
import {
  RESOURCE_TRACK_KINDS,
  WORKER_METRICS,
  formatTrackValue,
  stripReading,
  valueAt,
  type ResourceBand,
  type ResourceTrack,
  type WorkerStrip,
  type WorkerStripSet,
} from '~/utils/resource-tracks';

const props = defineProps<{
  state: {
    band: ResourceBand | null;
    strip: { set: WorkerStripSet; strip: WorkerStrip } | null;
    t: number;
    pos: { x: number; y: number };
  };
  /** The tracks shown in each band, by its key. */
  tracksFor: (band: ResourceBand) => ResourceTrack[];
  /** The pages earlier tests left open in each band's workers. */
  leftOpenFor?: (band: ResourceBand) => SeriesPoint[] | null;
}>();

/** The most workers the readout lists by name. */
const WORKERS_LISTED = 6;

const LABEL = Object.fromEntries(RESOURCE_TRACK_KINDS.map((k) => [k.kind, k.label])) as Record<string, string>;

const rows = computed(() => {
  const band = props.state.band;
  if (!band) return [];
  return props.tracksFor(band).map((track) => {
    const value = valueAt(track.points, props.state.t, track.step);
    let detail: string | null = null;
    if (track.kind === 'memory' && band.memoryKind) detail = band.memoryKind.toUpperCase();
    if (track.kind === 'pages') {
      const open = band.workers
        .map((worker) => ({ name: worker.name, n: valueAt(worker.points, props.state.t, true) ?? 0 }))
        .filter((worker) => worker.n > 0);
      const listed = open.slice(0, WORKERS_LISTED).map((worker) => `${worker.name}: ${worker.n}`);
      if (open.length > WORKERS_LISTED) listed.push(`${open.length - WORKERS_LISTED} more`);
      const leftOpen = props.leftOpenFor?.(band);
      const left = leftOpen?.length ? Math.min(value ?? 0, valueAt(leftOpen, props.state.t, true) ?? 0) : 0;
      if (left > 0) listed.unshift(`${left} left open by earlier tests`);
      detail = listed.join(' · ') || null;
    }
    return {
      kind: track.kind,
      label: LABEL[track.kind],
      value: value === null ? 'not read' : formatTrackValue(track.kind, value),
      detail,
    };
  });
});

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
    <div
      v-else-if="state.band && rows.length > 0"
      class="fixed z-[9999] pointer-events-none rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs shadow-lg max-w-80"
      :style="positionStyle"
      data-testid="timeline-resource-tooltip"
    >
      <div class="mb-1 font-medium text-gray-900 dark:text-white tabular-nums">
        {{ formatTimelineTime(Math.max(0, Math.round(state.t))) }}
        <span v-if="state.band.prefix" class="font-normal text-gray-500"> · shard {{ state.band.shardIndex }}</span>
      </div>
      <dl class="grid grid-cols-[4rem_1fr] gap-x-2 gap-y-0.5">
        <template v-for="row in rows" :key="row.kind">
          <dt class="text-gray-500">{{ row.label }}</dt>
          <dd class="text-gray-900 dark:text-white tabular-nums">
            {{ row.value }}
            <span v-if="row.detail" class="text-gray-500"> · {{ row.detail }}</span>
          </dd>
        </template>
      </dl>
    </div>
  </Teleport>
</template>

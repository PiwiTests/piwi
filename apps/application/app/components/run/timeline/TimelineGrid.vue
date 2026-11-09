<script setup lang="ts">
import type { WorkerRow } from '~/composables/useTimelineModel';
import type { TimelineRowsLayout } from '~/utils/resource-tracks';
import { TIMELINE_LAYOUT } from '~/utils/timeline';

const props = defineProps<{
  workerRows: WorkerRow[];
  tickMarks: Array<{ ms: number; x: number; label: string }>;
  contentWidth: number;
  shardTotal?: number | null;
  /** Where each lane and worker row sits, the resource bands and strips between them. */
  layout: TimelineRowsLayout;
}>();

const { barHeight, rowGap, axisHeight } = TIMELINE_LAYOUT;

function laneTop(lane: number): number {
  return props.layout.laneTop[lane] ?? axisHeight;
}
</script>

<template>
  <g>
    <!-- One shaded band per worker, spanning its test lane, any expanded step lanes and its strip. -->
    <rect
      v-for="(row, i) in props.workerRows"
      :key="'bg-' + i"
      :x="0"
      :y="props.layout.rows[i]?.top ?? laneTop(row.baseLane)"
      :width="props.contentWidth"
      :height="(props.layout.rows[i]?.bottom ?? 0) - (props.layout.rows[i]?.top ?? 0)"
      :class="i % 2 === 1 ? 'fill-black/[0.03] dark:fill-white/[0.03]' : 'fill-transparent'"
    />

    <!-- A faint divider under the test lane of an expanded worker, above its step lanes. -->
    <line
      v-for="row in props.workerRows.filter((r) => r.laneSpan > 1)"
      :key="'steps-sep-' + row.baseLane"
      :x1="TIMELINE_LAYOUT.labelWidth"
      :y1="laneTop(row.baseLane + 1)"
      :x2="props.contentWidth"
      :y2="laneTop(row.baseLane + 1)"
      stroke="currentColor"
      stroke-dasharray="2,3"
      class="stroke-gray-300 dark:stroke-gray-600"
    />

    <!-- Shard separator before each worker whose shard differs from the one above. -->
    <template v-for="(row, i) in props.workerRows" :key="'shard-sep-' + i">
      <line
        v-if="i > 0 && row.shardIndex !== props.workerRows[i - 1]!.shardIndex"
        :x1="0"
        :y1="(props.layout.rows[i]?.sectionTop ?? 0) - rowGap / 2"
        :x2="props.contentWidth"
        :y2="(props.layout.rows[i]?.sectionTop ?? 0) - rowGap / 2"
        stroke="currentColor"
        stroke-dasharray="4,3"
        class="stroke-gray-400 dark:stroke-gray-500"
      />
    </template>

    <line
      :x1="TIMELINE_LAYOUT.labelWidth"
      :y1="axisHeight"
      :x2="props.contentWidth"
      :y2="axisHeight"
      stroke="currentColor"
      class="stroke-gray-300 dark:stroke-gray-600"
    />

    <g v-for="tick in props.tickMarks" :key="tick.ms">
      <line
        :x1="tick.x"
        :y1="axisHeight - 4"
        :x2="tick.x"
        :y2="axisHeight"
        stroke="currentColor"
        class="stroke-gray-300 dark:stroke-gray-600"
      />
      <text :x="tick.x" :y="axisHeight - 8" text-anchor="middle" class="fill-gray-400 text-[10px]">
        {{ tick.label }}
      </text>
    </g>

    <text
      v-for="(row, i) in props.workerRows"
      :key="'label-' + i"
      :x="6"
      :y="laneTop(row.baseLane) + barHeight / 2 + 4"
      class="fill-gray-500 text-[11px] font-medium"
    >
      {{
        row.shardIndex != null && props.shardTotal && props.shardTotal > 1
          ? `S${row.shardIndex} W${row.slot + 1}`
          : `Worker ${row.slot + 1}`
      }}
    </text>
  </g>
</template>

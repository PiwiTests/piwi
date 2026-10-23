<script setup lang="ts">
import type { MarkerInfo } from '~~/types/api';

/**
 * Details of the timeline marker hovered on a trend chart. `ChartFrame`
 * renders it, positioned by `useChartMarkerTooltip`.
 */
defineProps<{
  marker: MarkerInfo | null;
  pos: { x: number; y: number };
  /** The chart opens the marker on click: say so at the bottom. */
  clickable?: boolean;
}>();
</script>

<template>
  <div
    v-if="marker"
    role="tooltip"
    data-testid="chart-marker-tooltip"
    class="fixed z-50 pointer-events-none w-max max-w-[280px] bg-default rounded-lg shadow-lg ring ring-default"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
  >
    <div class="p-3 space-y-1.5 text-sm">
      <MarkerBadge :marker="marker" category-only size="sm" />
      <div class="font-semibold text-highlighted leading-snug break-words">{{ marker.label }}</div>
      <div class="text-xs text-muted">
        {{ prettyDateFormat(marker.occurredAt) }} · {{ formatRelativeTime(marker.occurredAt) }}
      </div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <EnvironmentBadge v-if="marker.environment" :name="marker.environment" />
        <span v-else>All environments</span>
        <span v-if="marker.runId">· Run #{{ marker.runId }}</span>
      </div>
      <p v-if="marker.description" class="text-xs text-default whitespace-pre-line break-words line-clamp-5">
        {{ marker.description }}
      </p>
      <div v-if="clickable" class="text-xs text-dimmed pt-1.5 border-t border-default">
        Click to open it in the markers panel
      </div>
    </div>
  </div>
</template>

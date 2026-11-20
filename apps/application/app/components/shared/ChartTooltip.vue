<script setup lang="ts">
/**
 * Floating tooltip shell for the SVG trend charts, positioned by
 * `useChartTooltip`. The chart renders it (v-if on the tooltip data) with its
 * own markup in the default slot.
 */
defineProps<{
  pos: { x: number; y: number };
  /** A wider tooltip than the default 260 px, in px. */
  maxWidth?: number;
}>();
</script>

<template>
  <div
    class="fixed z-50 pointer-events-none bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 max-w-[260px]"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px`, ...(maxWidth ? { maxWidth: `${maxWidth}px` } : {}) }"
  >
    <div class="p-2 text-sm text-gray-900 dark:text-gray-100">
      <slot />
    </div>
  </div>
</template>

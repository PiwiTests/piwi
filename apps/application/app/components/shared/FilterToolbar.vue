<script setup lang="ts">
/**
 * Wrap-friendly toolbar for list filters. The `start` group (counts, view
 * toggles) and the default group (search, filter pills, selects) sit side by
 * side on wide screens and stack + wrap on phones instead of overflowing
 * horizontally. Every group is `flex-wrap`, so individual controls reflow
 * onto new lines rather than pushing the page wider than the viewport.
 */
</script>

<template>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div v-if="$slots.start" class="flex flex-wrap items-center gap-2 min-w-0">
      <slot name="start" />
    </div>
    <div class="flex flex-wrap items-center gap-2 min-w-0">
      <slot />
    </div>
  </div>
</template>

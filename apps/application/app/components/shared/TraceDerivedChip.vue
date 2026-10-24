<script setup lang="ts">
/**
 * Marks a card whose data was recovered from the uploaded trace because the
 * capture fixtures were absent — so a reader knows it came from the trace, not
 * from Piwi's own capture.
 */
</script>

<template>
  <UBadge color="neutral" variant="soft" size="xs" class="gap-1">
    <UIcon name="i-lucide-file-search" class="size-3" />
    derived from the trace
  </UBadge>
</template>

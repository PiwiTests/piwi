<script setup lang="ts">
import type { StuckAttempt } from '#shared/stuck-tests';

/**
 * How long a running test said to be stuck (`#shared/stuck-tests`) has run, counted on every ten seconds on this
 * browser's clock from what the server last said, against the longest its last passing executions took.
 */
const props = defineProps<{ stuck: StuckAttempt }>();

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 10_000) });
/** When the server's elapsed time was read, on this browser's clock: another clock's start may be skewed. */
const readAt = ref(Date.now());
watch(
  () => props.stuck.elapsedMs,
  () => (readAt.value = Date.now()),
);
const elapsedMs = computed(() => props.stuck.elapsedMs + Math.max(0, now.value - readAt.value));
</script>

<template>
  <span class="tabular-nums" data-testid="stuck-time">
    Running for {{ formatLongDuration(elapsedMs) }}, usually <DurationValue :ms="stuck.usualMs" /> at most
  </span>
</template>

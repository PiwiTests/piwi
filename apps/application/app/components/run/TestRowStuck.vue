<script setup lang="ts">
import type { StuckAttempt } from '#shared/stuck-tests';

/**
 * How long a running test said to be stuck (`#shared/stuck-tests`) has run, counted on every ten seconds, against
 * the longest its last passing executions took.
 */
const props = defineProps<{ stuck: StuckAttempt; startedAt?: number }>();

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 10_000) });
/** From the attempt's start when the row has it, else from when the server said it was stuck. */
const since = Date.now() - props.stuck.elapsedMs;
const elapsedMs = computed(() => Math.max(props.stuck.elapsedMs, now.value - (props.startedAt ?? since)));
</script>

<template>
  <span class="tabular-nums" data-testid="stuck-time">
    Running for {{ formatLongDuration(elapsedMs) }}, usually <DurationValue :ms="stuck.usualMs" /> at most
  </span>
</template>

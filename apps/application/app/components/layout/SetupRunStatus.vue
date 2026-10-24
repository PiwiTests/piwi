<script setup lang="ts">
/**
 * The connect wizard's live line: waiting for the first run, a run reporting
 * right now, or the run that reported last, kept current by the run stream so
 * the page answers "did it work?" without a reload. While it waits or a run
 * reports, it also reads the runs again every 15 seconds, for a run that
 * reported before the stream connected or through a proxy that holds it back.
 */
import type { TestRunForChart } from '~~/types/api';
import { firstRunStatus } from '~/utils/first-run-status';

const {
  data: runs,
  status: fetchStatus,
  refresh,
} = useFetch('/api/test-runs/recent', {
  server: false,
  lazy: true,
  default: () => [] as TestRunForChart[],
  transform: (r: { items: TestRunForChart[] }) => r.items,
});

useRunStream(() => refresh());

const POLL_MS = 15_000;
let poll: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  poll = setInterval(() => {
    if (document.visibilityState === 'visible' && status.value.kind !== 'reported') refresh();
  }, POLL_MS);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
});

const loading = computed(() => fetchStatus.value === 'idle' || fetchStatus.value === 'pending');
const status = computed(() => firstRunStatus(runs.value ?? []));
const project = computed(() =>
  status.value.kind === 'waiting' ? '' : (status.value.run.projectLabel ?? status.value.run.projectName ?? ''),
);
</script>

<template>
  <p class="flex items-center gap-2 text-xs text-muted min-h-5" data-shot="setup-run-status" aria-live="polite">
    <template v-if="loading && status.kind === 'waiting'">&nbsp;</template>
    <template v-else-if="status.kind === 'waiting'">
      <span class="size-2 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse" aria-hidden="true" />
      <span>Waiting for the first run — this line changes as soon as one reports.</span>
    </template>
    <template v-else-if="status.kind === 'reporting'">
      <span class="size-2 shrink-0 rounded-full bg-status-running animate-pulse" aria-hidden="true" />
      <span>
        A run of {{ project }} is reporting now ·
        <NuxtLink :to="`/test-runs/${status.run.id}`" :class="SENTENCE_LINK_CLASS">Watch it</NuxtLink>
      </span>
    </template>
    <template v-else>
      <span class="size-2 shrink-0 rounded-full" :class="statusPalette(status.run.status).bg" aria-hidden="true" />
      <span>
        Last run from {{ project }}, {{ formatRelativeTime(status.run.startTime) }} ·
        <NuxtLink :to="`/test-runs/${status.run.id}`" :class="SENTENCE_LINK_CLASS">Open it</NuxtLink>
      </span>
    </template>
  </p>
</template>

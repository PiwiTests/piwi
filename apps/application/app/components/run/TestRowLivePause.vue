<script setup lang="ts">
/**
 * Where a running test is stopped, on its row: why, in words by its reason (`stopWords`), at which call and where, and,
 * for a stop its reporter told as text, for how long. The stop comes from the run's live view (a CI run, a run shared
 * live), or from a run outside CI while someone has the run open (`test-stopped`). The row's **Watch** opens the view
 * of a live view's page.
 */
import { stopWords } from '~/utils/stop-words';

const props = defineProps<{
  reason: string;
  call: { title: string; file: string | null; line: number | null };
  /** When the stop began (epoch ms), for how long it has stood; none from the live view. */
  since?: number | null;
  /** Piwi project id + name, for the IDE opener of the paused call's place. */
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

const words = computed(() => stopWords(props.reason));
const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 10_000) });
/** How long the stop has stood, once it stood a while. */
const stoodFor = computed(() =>
  props.since && now.value - props.since >= 60_000 ? formatLongDuration(now.value - props.since) : null,
);
const pausedText = computed(() =>
  [props.call.title, props.call.file ? `${props.call.file}:${props.call.line ?? ''}` : ''].filter(Boolean).join(' · '),
);
</script>

<template>
  <span
    class="inline-flex flex-wrap items-center gap-x-1 min-w-0 max-w-full text-xs"
    data-testid="live-paused"
    :data-reason="reason"
    :title="`${words} · ${pausedText}`"
  >
    <UIcon name="i-lucide-pause" class="size-3 shrink-0 text-warning" />
    <span class="font-semibold text-highlighted whitespace-nowrap">{{ words }}</span>
    <span v-if="call.title" class="truncate min-w-0 max-w-full text-muted">· {{ call.title }}</span>
    <span v-if="call.file" class="inline-flex items-center gap-1 min-w-0 max-w-full">
      <span class="text-muted">·</span>
      <OpenInIdeLink
        :file-path="call.file"
        :line="call.line"
        :project-key="projectKey"
        :project-name="projectName"
        class="text-muted"
      />
    </span>
    <span v-if="stoodFor" class="whitespace-nowrap text-muted">· for {{ stoodFor }}</span>
  </span>
</template>

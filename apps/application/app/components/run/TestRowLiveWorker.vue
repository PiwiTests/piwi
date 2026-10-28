<script setup lang="ts">
/**
 * A running test's worker in the run's live view, on its row: **Paused** at the call its test is stopped at, while it
 * is, and **Watch**, which opens the view of the page the worker is on. Watching never steers the test.
 */
import { liveWorkerName, type LiveWorkerState } from '#shared/live-view';

const props = defineProps<{
  worker: LiveWorkerState;
  /** Piwi project id + name, for the IDE opener of the paused call's place. */
  projectKey?: string | number | null;
  projectName?: string | null;
}>();
const emit = defineEmits<{ watch: [] }>();

const paused = computed(() => props.worker.paused?.call ?? null);
const name = computed(() => liveWorkerName(props.worker));
const pausedText = computed(() =>
  paused.value
    ? [paused.value.title, paused.value.file ? `${paused.value.file}:${paused.value.line ?? ''}` : '']
        .filter(Boolean)
        .join(' · ')
    : '',
);
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 max-w-full">
    <span
      v-if="paused"
      class="inline-flex items-center gap-1 min-w-0 max-w-full text-xs"
      data-testid="live-paused"
      :title="`Paused at ${pausedText}`"
    >
      <UIcon name="i-lucide-pause" class="size-3 shrink-0 text-warning" />
      <span class="font-semibold text-highlighted">Paused</span>
      <span class="truncate text-muted">· {{ paused.title }}</span>
      <template v-if="paused.file">
        <span class="text-muted">·</span>
        <OpenInIdeLink
          :file-path="paused.file"
          :line="paused.line"
          :project-key="projectKey"
          :project-name="projectName"
          class="text-muted"
        />
      </template>
    </span>
    <UButton
      size="xs"
      color="neutral"
      variant="outline"
      icon="i-lucide-eye"
      label="Watch"
      :aria-label="`Watch ${name} live`"
      :title="`Watch the page ${name} is on, live`"
      data-testid="live-watch"
      @click.stop="emit('watch')"
    />
  </span>
</template>

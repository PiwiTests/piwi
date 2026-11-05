<script setup lang="ts">
/**
 * Where a running test of the run's live view is stopped, on its row: **Paused** at its call and the call's place. The
 * row's **Watch** opens the view of its page.
 */
import type { LiveStop } from '#shared/live-view';

const props = defineProps<{
  paused: LiveStop;
  /** Piwi project id + name, for the IDE opener of the paused call's place. */
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

const call = computed(() => props.paused.call);
const pausedText = computed(() =>
  [call.value.title, call.value.file ? `${call.value.file}:${call.value.line ?? ''}` : ''].filter(Boolean).join(' · '),
);
</script>

<template>
  <span
    class="inline-flex items-center gap-1 min-w-0 max-w-full text-xs"
    data-testid="live-paused"
    :title="`Paused at ${pausedText}`"
  >
    <UIcon name="i-lucide-pause" class="size-3 shrink-0 text-warning" />
    <span class="font-semibold text-highlighted">Paused</span>
    <span class="truncate text-muted">· {{ call.title }}</span>
    <template v-if="call.file">
      <span class="text-muted">·</span>
      <OpenInIdeLink
        :file-path="call.file"
        :line="call.line"
        :project-key="projectKey"
        :project-name="projectName"
        class="text-muted"
      />
    </template>
  </span>
</template>

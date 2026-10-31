<script setup lang="ts">
import type { RunLiveViewReadiness } from '~/utils/run-live-view-status';
import { runLiveViewStatus } from '~/utils/run-live-view-status';

const props = defineProps<{
  readiness: RunLiveViewReadiness;
  projectId: number;
}>();
const { can } = useAuth();
const status = computed(() => runLiveViewStatus(props.readiness));
</script>

<template>
  <div
    class="inline-flex shrink-0 items-center gap-1 text-xs text-muted max-sm:px-4"
    data-shot="run-live-view-status"
    data-testid="live-view-readiness"
    :data-state="status.kind"
  >
    <span role="status" aria-live="polite">{{ status.label }}</span>
    <HelpHint v-if="status.kind === 'desktop'" topic="run.live-desktop" />
    <HelpHint v-else-if="status.kind === 'demo'" topic="run.live-view-demo" />
    <HelpHint v-else-if="status.kind === 'unshared'" topic="run.live-unshared" />
    <HelpHint v-else topic="run.live-view-setup">
      <template #actions>
        <UButton
          v-if="status.kind === 'disabled' && can('project:manage', projectId)"
          :to="`/projects/${projectId}?tab=settings&section=live-view`"
          size="xs"
          color="neutral"
          variant="link"
          class="justify-start p-0"
        >
          Open live-view settings
        </UButton>
      </template>
    </HelpHint>
  </div>
</template>

<script setup lang="ts">
import type { RunLiveViewReadiness } from '~/utils/run-live-view-status';
import { runLiveViewStatus } from '~/utils/run-live-view-status';

const props = defineProps<{
  readiness: RunLiveViewReadiness;
  projectId: number;
}>();
const emit = defineEmits<{ retry: [] }>();
const { can } = useAuth();
const toast = useToast();
/** Whether the project's live view was turned on from this page, which this run, started without it, does not get. */
const turnedOn = ref(false);
const turningOn = ref(false);
const status = computed(() => runLiveViewStatus({ ...props.readiness, turnedOn: turnedOn.value }));

/** A Project admin turns the project's live view on from here: the runs that start next get it. */
async function turnOn(): Promise<void> {
  turningOn.value = true;
  try {
    await $fetch<unknown>(`/api/projects/${props.projectId}`, { method: 'PATCH', body: { liveView: true } });
    turnedOn.value = true;
  } catch {
    toast.add({ title: 'The live view could not be turned on', color: 'error' });
  } finally {
    turningOn.value = false;
  }
}
</script>

<template>
  <div
    class="inline-flex shrink-0 items-center gap-1 text-xs text-muted max-sm:px-4"
    data-shot="run-live-view-status"
    data-testid="live-view-readiness"
    :data-state="status.kind"
  >
    <span role="status" aria-live="polite">{{ status.label }}</span>
    <template v-if="status.kind === 'stalled'">
      <UButton size="xs" color="neutral" variant="link" class="p-0" @click="emit('retry')">Retry</UButton>
      <HelpHint topic="run.live-stalled" />
    </template>
    <HelpHint v-else-if="status.kind === 'desktop'" topic="run.live-desktop" />
    <HelpHint v-else-if="status.kind === 'demo'" topic="run.live-view-demo" />
    <HelpHint v-else-if="status.kind === 'unshared'" topic="run.live-unshared" />
    <HelpHint v-else-if="status.kind === 'no-workers'" topic="run.live-no-workers" />
    <HelpHint v-else topic="run.live-view-setup">
      <template #actions>
        <UButton
          v-if="status.kind === 'disabled' && can('project:manage', projectId)"
          size="xs"
          color="neutral"
          variant="link"
          class="justify-start p-0"
          :loading="turningOn"
          data-testid="live-view-turn-on"
          @click="turnOn"
        >
          Turn the live view on for the next runs
        </UButton>
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

<script setup lang="ts">
import type { RunLiveViewReadiness } from '~/utils/run-live-view-status';
import { runLiveViewStatus } from '~/utils/run-live-view-status';

const props = defineProps<{
  readiness: RunLiveViewReadiness;
  projectId: number;
}>();
const emit = defineEmits<{ retry: [] }>();
const { can } = useAuth();
const { saving: turningOn, save } = useProjectPatch(() => props.projectId);
/**
 * Whether the project's live view was turned on from this page, which a run that started without it does not get:
 * the status reads it on until the run's stream says so, and off again once the stream says someone turned it off.
 */
const turnedOn = ref(false);
let heardOn = false;
watch(
  () => props.readiness.state?.enabled,
  (enabled) => {
    if (!turnedOn.value) return;
    if (enabled) heardOn = true;
    else if (heardOn) turnedOn.value = heardOn = false;
  },
);
const status = computed(() => {
  const state = props.readiness.state;
  const shown = turnedOn.value && state && !state.enabled ? { ...state, enabled: true } : state;
  return runLiveViewStatus({ ...props.readiness, state: shown, turnedOn: turnedOn.value });
});
/** A run that holds a key gets its own view back as the live view turns on; one without gets none. */
const turnOnLabel = computed(() =>
  props.readiness.state?.keyed ? 'Turn the live view on again' : 'Turn the live view on for the next runs',
);

/** A Project admin turns the project's live view on from here. */
async function turnOn(): Promise<void> {
  if (await save({ liveView: true }, 'Live view turned on')) turnedOn.value = true;
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
          {{ turnOnLabel }}
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

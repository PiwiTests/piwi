<script setup lang="ts">
/**
 * A CI lane's controls for the people who may control the run, in the lane panel, in a local run's words and controls
 * (`@piwitests/run-model`'s `CI_CONTROL_WORDS`): **Pause** while its test runs; and, while the test is paused for its
 * controllers, by whom and until when (`Paused by Ana · until 12:05`, else `Paused`), the call it stopped
 * before and its place, that the CI job's own timeout still runs, and **Resume** and **End the test**. Each asks the
 * instance on the page's watch, which shows the worker in full (`POST …/live-view/control`); a refusal says why. Anyone
 * else watching sees the pause, and no control.
 */
import type { LiveControlCommand, LiveWorkerId } from '@piwitests/core/live-view';
import { CI_CONTROL_WORDS } from '@piwitests/run-model/ci';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import { pausedStopWords, stopWords, type ShownStop } from '~/utils/stop-words';

const props = defineProps<{
  runId: number;
  worker: LiveWorkerId;
  /** The paused stop, as the test's row reads it too (`testStop`): its call, its end and who paused it; null while it runs. */
  stop: ShownStop | null;
  /** The controls this person sees: Pause, or Resume and End the test; none for someone who may not control the run. */
  controls: LiveControlCommand[];
  /** The id of the page's watch of the run, which shows the worker in full; null while none is open. */
  watchId: string | null;
  /** Piwi project id + name, for the IDE opener of the paused call's place. */
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

const toast = useToast();
/** The control asked, until the worker's next stop or its end answers it. */
const asked = ref<LiveControlCommand | null>(null);
const paused = computed(() => (props.stop?.ciPause ? props.stop : null));
const state = computed(() => stopWords('pause'));
const by = computed(() =>
  paused.value?.ciPause ? pausedStopWords({ until: paused.value.ciPause.until }, paused.value.ciPause.pausedBy) : null,
);
// The worker answered: its test paused, or went on; or the controls changed, its test ended unpaused.
watch([paused, () => props.controls.join()], () => (asked.value = null));

const FAILED: Record<LiveControlCommand, string> = {
  pause: 'Could not pause the test',
  resume: 'Could not resume the test',
  end: 'Could not end the test',
};

const ICONS: Record<LiveControlCommand, string> = {
  pause: 'i-lucide-pause',
  resume: 'i-lucide-play',
  end: 'i-lucide-square',
};

function say(control: LiveControlCommand, part: 'label' | 'title'): string {
  return englishRunSpeaker.say(CI_CONTROL_WORDS[control][part].key);
}

async function ask(control: LiveControlCommand): Promise<void> {
  if (asked.value || !props.watchId) return;
  asked.value = control;
  try {
    await $fetch(`/api/test-runs/${props.runId}/live-view/control`, {
      method: 'POST',
      body: { watch: props.watchId, ...props.worker, command: control },
    });
  } catch (e) {
    asked.value = null;
    toast.add({ title: FAILED[control], description: errorMessage(e), color: 'error' });
  }
}
</script>

<template>
  <div
    v-if="paused"
    class="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2"
    role="status"
    data-testid="live-paused-panel"
  >
    <div class="min-w-0 flex-1 space-y-0.5 text-sm">
      <p class="flex flex-wrap items-center gap-x-1.5">
        <UIcon name="i-lucide-pause" class="size-4 shrink-0 text-warning" />
        <span class="font-semibold text-highlighted" data-testid="live-paused-by">{{ by ?? state }}</span>
      </p>
      <p class="break-words text-highlighted">{{ paused.call.title }}</p>
      <OpenInIdeLink
        v-if="paused.call.file"
        :file-path="paused.call.file"
        :line="paused.call.line"
        :project-key="projectKey"
        :project-name="projectName"
        class="text-xs text-muted"
      />
      <p class="text-xs text-muted">{{ englishRunSpeaker.say('runs_heldJobTimeout') }}</p>
    </div>
    <div v-if="controls.length" class="flex flex-wrap gap-2">
      <UButton
        v-for="control in controls"
        :key="control"
        :icon="ICONS[control]"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="asked === control"
        :disabled="!watchId || (!!asked && asked !== control)"
        :title="say(control, 'title')"
        :data-testid="`live-control-${control}`"
        @click="ask(control)"
        >{{ say(control, 'label') }}</UButton
      >
    </div>
  </div>
  <div v-else-if="controls.length" class="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="live-controls">
    <UButton
      v-for="control in controls"
      :key="control"
      :icon="ICONS[control]"
      color="neutral"
      variant="outline"
      size="sm"
      :loading="asked === control"
      :disabled="!watchId || !!asked"
      :title="say(control, 'title')"
      :data-testid="`live-control-${control}`"
      @click="ask(control)"
      >{{ say(control, 'label') }}</UButton
    >
  </div>
</template>

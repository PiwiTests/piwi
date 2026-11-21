<script setup lang="ts">
/**
 * A failed CI test held at its failure for the people who may control the run, in the lane panel: where it stands
 * (`Failed, held at its line`), for whom and until when (`Held for Ana · until 12:05`), the failure it holds and its
 * place, and that the CI job's own timeout still runs. **Let it go** shows when the panel says this person may end it
 * (`canLetGo`: someone who may control the project's runs, `run:control`, of a worker that can hold), and asks the
 * instance to end the hold on the page's watch, which shows the worker in full; the test then tears down as it would
 * have.
 */
import type { LiveWorkerId } from '@piwitests/core/live-view';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import { heldStopWords, stopWords, type ShownStop } from '~/utils/stop-words';

const props = defineProps<{
  runId: number;
  worker: LiveWorkerId;
  /** The held stop, as the test's row reads it too (`testStop`): its call, and its hold's end and controllers. */
  stop: ShownStop;
  /** Whether this person may end the hold: **Let it go** shows. */
  canLetGo: boolean;
  /** The id of the page's watch of the run, which shows the worker in full; null while none is open. */
  watchId: string | null;
  /** Piwi project id + name, for the IDE opener of the failure's place. */
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

const toast = useToast();
const asked = ref(false);
const state = computed(() => stopWords('held'));
const held = computed(() => heldStopWords({ until: props.stop.held?.until }, props.stop.held?.heldFor ?? []));

async function letGo(): Promise<void> {
  if (asked.value || !props.watchId) return;
  asked.value = true;
  try {
    await $fetch(`/api/test-runs/${props.runId}/live-view/let-go`, {
      method: 'POST',
      body: { watch: props.watchId, ...props.worker },
    });
  } catch (e) {
    asked.value = false;
    toast.add({ title: 'Could not let the test go', description: errorMessage(e), color: 'error' });
  }
}
</script>

<template>
  <div
    class="flex flex-col gap-2 rounded-md border border-error/40 bg-error/5 px-3 py-2 sm:flex-row sm:items-start sm:gap-3"
    role="status"
    data-testid="live-held-panel"
  >
    <div class="min-w-0 flex-1 space-y-0.5 text-sm">
      <p class="flex flex-wrap items-center gap-x-1.5">
        <UIcon name="i-lucide-hand" class="size-4 shrink-0 text-error" />
        <span class="font-semibold text-highlighted">{{ state }}</span>
        <span v-if="held" class="text-muted" data-testid="live-held-for">· {{ held }}</span>
      </p>
      <p class="break-words text-highlighted">{{ stop.call.title }}</p>
      <OpenInIdeLink
        v-if="stop.call.file"
        :file-path="stop.call.file"
        :line="stop.call.line"
        :project-key="projectKey"
        :project-name="projectName"
        class="text-xs text-muted"
      />
      <p class="text-xs text-muted">{{ englishRunSpeaker.say('runs_heldJobTimeout') }}</p>
    </div>
    <UButton
      v-if="canLetGo"
      icon="i-lucide-play"
      color="neutral"
      variant="outline"
      size="sm"
      class="self-start"
      :loading="asked"
      :disabled="!watchId"
      :title="englishRunSpeaker.say('runs_letGoTitle')"
      data-testid="live-let-go"
      @click="letGo"
      >{{ englishRunSpeaker.say('runs_letGo') }}</UButton
    >
  </div>
</template>

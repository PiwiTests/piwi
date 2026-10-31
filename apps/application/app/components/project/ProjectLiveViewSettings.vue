<script setup lang="ts">
/**
 * Project settings → Live view: whether people who may open a live CI run of the project, or a run a developer shares
 * from their machine (Share live), can watch the page each of its workers is on, from the run page. Off by default; the
 * section says what goes out, from which runs, to whom, and that nothing is kept.
 */
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const { state, dirty } = useStoredForm(() => ({ liveView: props.project.liveView === true }));
const { saving, save } = useProjectPatch(() => props.project.id);

async function submit() {
  const on = state.value.liveView;
  if (await save({ liveView: on }, on ? 'Live view enabled for new runs' : 'Live view turned off')) emit('saved');
}
</script>

<template>
  <UForm :state="state" @submit="submit">
    <SectionCard
      icon="i-lucide-monitor-play"
      title="Live view"
      subtitle="Watch the page each worker of a running run is on, from the run page"
      help="project.live-view"
      data-shot="project-live-view-settings"
    >
      <div class="space-y-4">
        <UFormField name="liveView">
          <USwitch
            v-model="state.liveView"
            label="Let people who may open a run watch its workers live"
            description="Applies to new runs registered by the reporter's global setup. Restart a run started while this was off to watch it. A local run sends nothing unless its developer chooses Share live."
          />
        </UFormField>
        <dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
          <dt class="font-semibold text-highlighted">What goes out</dt>
          <dd class="text-highlighted leading-relaxed">
            Small images of the test's page, a few a second, each with the call it was taken at. Only from a CI run or a
            run its developer shares, and only while someone watches that worker: a run nobody watches sends no image.
          </dd>
          <dt class="font-semibold text-highlighted">Who sees it</dt>
          <dd class="text-highlighted leading-relaxed">
            The people who may open the run. The images show whatever the page shows, as its screenshots and traces do.
          </dd>
          <dt class="font-semibold text-highlighted">What is kept</dt>
          <dd class="text-highlighted leading-relaxed">
            Nothing: the images are relayed and dropped, never stored, logged or exported. The trace stays the record.
          </dd>
        </dl>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty">Save changes</UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>

<script setup lang="ts">
/**
 * Project settings → Live view: whether people who may open a live CI run of the project, or a run a developer shares
 * from their machine (Share live), can watch the page each of its workers is on, from the run page, and the elements
 * each image paints over beside the secret fields (Playwright locators, one a line). Off by default; the section says
 * what goes out, from which runs, to whom, what is masked, and that nothing is kept.
 */
import { MAX_LIVE_MASKS, liveMaskProblem } from '@piwitests/core/live-view';
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const stored = () => ({
  liveView: props.project.liveView === true,
  masks: (props.project.liveViewMasks ?? []).join('\n'),
});
const { state, dirty } = useStoredForm(stored);
const { saving, save } = useProjectPatch(() => props.project.id);

/** The locators written, one a line, blank lines left out. */
const masks = computed(() =>
  state.value.masks
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
);
const masksError = computed(() => {
  if (masks.value.length > MAX_LIVE_MASKS) return `${MAX_LIVE_MASKS} locators at most.`;
  for (const locator of masks.value) {
    const problem = liveMaskProblem(locator);
    if (problem) return problem;
  }
  return undefined;
});

async function submit() {
  if (masksError.value) return;
  // Only what changed is sent: a switch left as it was keeps what another admin set since.
  const before = stored();
  const on = state.value.liveView;
  const switched = on !== before.liveView;
  const written = masks.value.join('\n');
  const masksChanged = written !== before.masks;
  // The text as the server keeps it: trimmed, without blank lines.
  state.value.masks = written;
  if (!switched && !masksChanged) return;
  let message = 'Live view settings saved';
  if (!masksChanged) message = on ? 'Live view turned on' : 'Live view turned off';
  const saved = await save(
    { ...(switched ? { liveView: on } : {}), ...(masksChanged ? { liveViewMasks: masks.value } : {}) },
    message,
  );
  if (saved) emit('saved');
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
            description="Each CI run of this project the reporter's global setup registers, while it runs. A run on a developer's machine sends nothing unless its developer shares it (Share live)."
          />
        </UFormField>
        <UFormField
          label="Masked elements"
          name="masks"
          :error="masksError"
          description="Painted over in every image before it leaves the worker, beside the fields a browser keeps secret (a password, a one-time code, a card's number or security code), by @piwitests/reporter 0.64.0 or later: an older one masks nothing. One Playwright locator per line."
        >
          <UTextarea
            v-model="state.masks"
            :rows="3"
            autoresize
            class="w-full font-mono"
            placeholder="getByLabel('IBAN')&#10;getByTestId('account-balance')"
            aria-label="Masked elements"
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
            The people who may open the run. The images show what the page shows, as its screenshots and traces do, with
            the secret fields and the masked elements painted over by the worker. A secret written in the page's own
            text is not masked.
          </dd>
          <dt class="font-semibold text-highlighted">What is kept</dt>
          <dd class="text-highlighted leading-relaxed">
            Nothing: the images are relayed and dropped, never stored, logged or exported. The trace stays the record.
          </dd>
        </dl>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty || !!masksError"
            >Save changes</UButton
          >
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>

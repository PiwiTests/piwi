<script setup lang="ts">
/**
 * Project settings → Live view: whether people who may open a live CI run of the project, or a run a developer shares
 * from their machine (Share live), can watch the page each of its workers is on, from the run page, and the elements
 * each image paints over beside the secret fields (Playwright locators, one a line), and whether a signed-in reader of
 * a run nobody shares may ask its developer to share it (Ask to watch, on by default), and whether a CI test that
 * fails while someone who may control the project's runs watches its worker waits at its failure for them, and how
 * long at most (Hold a failing CI test, off by default, 1 to 15 minutes), and whether they may pause a CI test they
 * watch, resume it and end it, as long at most (Let controllers pause a CI test, off by default, which needs the hold
 * on: off with it). The live view is off by default; the section
 * says what goes out (the images, the call's log, the page's events and text, the filmstrip and Inspect's pages), from
 * which runs, to whom, what is masked, and what the instance keeps.
 */
import {
  DEFAULT_LIVE_HOLD_MINUTES,
  MAX_LIVE_HOLD_MINUTES,
  MAX_LIVE_MASKS,
  MIN_LIVE_HOLD_MINUTES,
  liveMaskProblem,
} from '@piwitests/core/live-view';
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const stored = () => ({
  liveView: props.project.liveView === true,
  askToWatch: props.project.askToWatch !== false,
  masks: (props.project.liveViewMasks ?? []).join('\n'),
  hold: props.project.liveViewHold === true,
  holdMinutes: props.project.liveViewHoldMinutes ?? DEFAULT_LIVE_HOLD_MINUTES,
  pause: props.project.liveViewHold === true && props.project.liveViewPause === true,
});
/** The lengths a hold may have, in whole minutes. */
const HOLD_LENGTHS = Array.from({ length: MAX_LIVE_HOLD_MINUTES - MIN_LIVE_HOLD_MINUTES + 1 }, (_, i) => {
  const minutes = MIN_LIVE_HOLD_MINUTES + i;
  return { label: minutes === 1 ? '1 minute' : `${minutes} minutes`, value: minutes };
});
const { state, dirty } = useStoredForm(stored);
// The pause needs the hold: it goes off with it.
watch(
  () => state.value.hold,
  (hold) => {
    if (!hold) state.value.pause = false;
  },
);
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
  const askSwitched = state.value.askToWatch !== before.askToWatch;
  const written = masks.value.join('\n');
  const masksChanged = written !== before.masks;
  const holdSwitched = state.value.hold !== before.hold;
  const lengthChanged = state.value.holdMinutes !== before.holdMinutes;
  const pauseSwitched = state.value.pause !== before.pause;
  // The text as the server keeps it: trimmed, without blank lines.
  state.value.masks = written;
  const others = askSwitched || masksChanged || holdSwitched || lengthChanged || pauseSwitched;
  if (!switched && !others) return;
  let message = 'Live view settings saved';
  if (switched && !others) message = on ? 'Live view enabled for new runs' : 'Live view turned off';
  const saved = await save(
    {
      ...(switched ? { liveView: on } : {}),
      ...(askSwitched ? { askToWatch: state.value.askToWatch } : {}),
      ...(masksChanged ? { liveViewMasks: masks.value } : {}),
      ...(holdSwitched ? { liveViewHold: state.value.hold } : {}),
      ...(lengthChanged ? { liveViewHoldMinutes: state.value.holdMinutes } : {}),
      ...(pauseSwitched ? { liveViewPause: state.value.pause } : {}),
    },
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
            description="Each CI run of this project the reporter's global setup registers from now on, while it runs: a run already going stays without it. Turning it off ends every view at once. A run on a developer's machine sends nothing unless its developer shares it (Share live)."
          />
        </UFormField>
        <UFormField name="askToWatch">
          <USwitch
            v-model="state.askToWatch"
            label="Let signed-in readers ask to watch a run nobody shares"
            description="The developer sees who asks and answers where they launched the run; one ask per person every 5 minutes."
            data-testid="ask-to-watch-setting"
          />
        </UFormField>
        <div class="space-y-2" data-testid="live-hold-setting">
          <UFormField name="hold">
            <USwitch
              v-model="state.hold"
              label="Hold a failing CI test for its controllers"
              description="A CI test that fails while a Maintainer or Project admin watches its worker in full waits at its failure, its page open for Inspect, until Let it go, the length below, or nobody who may control the run watches it any more. Its result is unchanged; the CI job's own timeout still runs, and each hold costs CI minutes. Needs @piwitests/reporter 0.75.0 or later."
            />
          </UFormField>
          <UFormField name="pause" data-testid="live-pause-setting">
            <USwitch
              v-model="state.pause"
              :disabled="!state.hold"
              label="Let controllers pause a CI test"
              :description="
                state.hold
                  ? 'A Maintainer or Project admin who watches a CI worker in full may pause its test before its next call, then resume it or end it, from the run page. A pause ends too at the length below, or as nobody who may control the run watches it any more. The test\'s timeout waits with it; the CI job\'s own timeout still runs. Needs @piwitests/reporter 0.75.0 or later.'
                  : 'Needs Hold a failing CI test on: a pause ends as a hold does, and lasts as long at most.'
              "
            />
          </UFormField>
          <UFormField label="Longest hold or pause" name="holdMinutes" class="max-w-48">
            <USelect
              v-model="state.holdMinutes"
              :items="HOLD_LENGTHS"
              :disabled="!state.hold"
              aria-label="Longest hold or pause"
              class="w-full"
            />
          </UFormField>
        </div>
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
            Small images of the test's page, a few a second, each with the call it was taken at, and the call's log.
            While the panel shows them: the page's events (console and uncaught errors, failed, pending and API
            requests, the errors and warnings the backend logged), its text as roles and names, and a filmstrip of its
            calls. With Inspect open: the page at each call as a document, with its stylesheets, fonts and images. Only
            from a CI run or a run its developer shares, and only while someone watches that worker: a run nobody
            watches sends none of it.
          </dd>
          <dt class="font-semibold text-highlighted">Who sees it</dt>
          <dd class="text-highlighted leading-relaxed">
            The people who may open the run. It shows what the page shows, as its screenshots and traces do. The worker
            paints the secret fields and the masked elements over in the images, removes the secret fields' values from
            the text and Inspect's pages and the masked elements from the text, and hides credentials in addresses and
            in the call's log, typed text too. A secret the page writes as its own text is not masked. A project with
            masked elements gets no Inspect page.
          </dd>
          <dt class="font-semibold text-highlighted">What is kept</dt>
          <dd class="text-highlighted leading-relaxed">
            The images, the log, the events, the text and the filmstrip are relayed and dropped. Inspect's pages and
            their stylesheets, fonts and images stay in the instance's memory while their test runs, and go with the run
            at the latest. None of it is stored, logged or exported. The trace stays the record.
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

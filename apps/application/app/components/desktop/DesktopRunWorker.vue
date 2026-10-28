<script setup lang="ts">
/**
 * Desktop shell only: one worker of a run the shell started, as the bundled server, its hub, tells it. Its test and
 * where it stands; at a stop, the call about to run and its place (a failure's error in their place), its page
 * (`DesktopRunStopPage`), **Resume**, **Step** and **Finish** (Resume alone at a failure), and the code actions the
 * stop takes from the window: **Assert a region** and **Mock a request**, whose code comes to the window to copy;
 * **Pause** while it runs. Every control but Pause names the stop it was drawn for (`since`), so a click made twice
 * never answers the next stop, and while one is on its way the buttons are `aria-disabled`, keeping the focus. A
 * control that goes as the worker runs on gives the keyboard to Pause meanwhile, and takes it back at the next stop
 * (Step, after a step), as the Runs window does. What a command answered, or what a code made at this stop came to,
 * shows under the test, read out, while the worker stands there. Everything the hub sends is shown as text.
 */
import type { HubKeptRequest, HubSession, HubWorker } from '@piwitests/core/run-hub';
import type { DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import {
  desktopCodeActions,
  desktopRunStop,
  desktopSteering,
  desktopStopError,
  desktopStopPlace,
  desktopStopTakes,
  desktopWorkerKey,
  desktopWorkerMeta,
  desktopWorkerState,
  desktopWorkerTest,
  type DesktopSteer,
} from '~/utils/desktop-run-view';

const props = defineProps<{ session: HubSession; worker: HubWorker; count: number }>();
const emit = defineEmits<{ announce: [text: string] }>();

const hub = useDesktopRunHub();

const stop = computed(() => desktopRunStop(props.worker));
const since = computed(() => stop.value?.since ?? null);
const place = computed(() => (stop.value ? desktopStopPlace(stop.value, props.session.root) : null));
const takes = computed(() => (stop.value ? desktopStopTakes(props.worker, stop.value) : []));
const steering = computed(() => desktopSteering(props.worker));
const codeActions = computed(() => (stop.value ? desktopCodeActions(props.worker, stop.value) : []));
const stateText = computed(() => desktopWorkerState(props.worker, props.session.root));
const testText = computed(() => desktopWorkerTest(props.worker));
const metaText = computed(() => desktopWorkerMeta(props.worker));
const failed = computed(() => stop.value?.reason === 'failure');

const STEER: Record<DesktopSteer, { label: string; title: string; icon: string }> = {
  resume: { label: 'Resume', title: 'Let the test go on to its next stop or its end', icon: 'i-lucide-play' },
  step: { label: 'Step', title: 'Run this call and stop before the next one', icon: 'i-lucide-step-forward' },
  finish: {
    label: 'Finish',
    title: 'Turn the breakpoints off and let the test run to its end',
    icon: 'i-lucide-skip-forward',
  },
  pause: {
    label: 'Pause',
    title: 'Stop the test before its next call that acts on or checks the page',
    icon: 'i-lucide-pause',
  },
};
const CODE: Record<'assert-region' | 'mock', { label: string; title: string; icon: string }> = {
  'assert-region': {
    label: 'Assert a region',
    title: 'Pick a region of the page: its ARIA snapshot becomes a toMatchAriaSnapshot check to copy',
    icon: 'i-lucide-layers',
  },
  mock: {
    label: 'Mock a request',
    title: 'Choose a response the page got: it becomes a page.route mock to copy',
    icon: 'i-lucide-network',
  },
};

/** A command is on its way for this worker: the buttons wait for its answer. */
const busy = ref(false);
/** Watch live, left on: each next stop of this worker is watched too, until it is turned off. */
const watchLive = ref(false);
/** What the last command answered, or what a code made here came to, for the stop it was sent at. */
const answer = ref<{ since: string | null; ok: boolean; text: string; locator: string | null; warnings: string[] }>();
/** The responses the test kept, listed for Mock a request at the stop they were asked at. */
const requests = ref<{ since: string; list: HubKeptRequest[] }>();

const shownAnswer = computed(() => (answer.value && answer.value.since === since.value ? answer.value : undefined));
const shownRequests = computed(() =>
  requests.value && requests.value.since === since.value ? requests.value : undefined,
);

function say(
  result: DesktopRunAnswer,
  at: string | null,
  extra: { warnings?: string[]; locator?: string | null } = {},
) {
  answer.value = {
    since: at,
    ok: result.ok,
    text: result.message,
    locator: extra.locator ?? null,
    warnings: extra.warnings ?? [],
  };
  if (result.message) emit('announce', [result.message, ...(extra.warnings ?? [])].join(' '));
}

/** Sends a command for the stop the button was drawn for (`at`, null for Pause), unless one is on its way. */
async function send(body: Record<string, unknown>, at: string | null): Promise<DesktopRunAnswer | null> {
  if (busy.value) return null;
  busy.value = true;
  answer.value = undefined;
  const result = await hub.command({ ref: props.session.ref, worker: props.worker.worker, ...body });
  busy.value = false;
  // An answer for a stop the worker no longer stands at says nothing.
  return since.value === at ? result : null;
}

async function steer(what: DesktopSteer): Promise<void> {
  const at = what === 'pause' ? null : since.value;
  const result = await send({ type: 'runControl', action: what, since: at }, at);
  if (result && !result.ok) say(result, at);
}

async function codeAction(what: 'assert-region' | 'mock'): Promise<void> {
  const at = since.value;
  if (at === null) return;
  if (what === 'mock') {
    if (shownRequests.value) {
      requests.value = undefined;
      return;
    }
    const result = await send({ type: 'requests', since: at }, at);
    if (!result) return;
    if (result.ok && result.requests) {
      requests.value = { since: at, list: result.requests };
      emit(
        'announce',
        result.requests.length === 1 ? '1 response listed.' : `${result.requests.length} responses listed.`,
      );
    } else say(result, at);
    return;
  }
  const result = await send({ type: 'assert-region', since: at }, at);
  if (result) say(result, at);
}

async function mock(id: number): Promise<void> {
  const at = since.value;
  if (at === null) return;
  const result = await send({ type: 'mock', since: at, request: id }, at);
  if (!result) return;
  const outcome = hub.state.outcomes[desktopWorkerKey(props.session.ref, props.worker.worker)];
  // The hub said what the code came to before this answer, with what to check in it: the answer says it again.
  if (!(result.ok && outcome?.since === at && outcome.message === result.message)) say(result, at);
  if (result.ok) requests.value = undefined;
}

// What a code made at this stop came to, whoever asked for it (this window, Piwi Picker).
watch(
  () => hub.state.outcomes[desktopWorkerKey(props.session.ref, props.worker.worker)],
  (outcome) => {
    if (!outcome || outcome.since !== since.value) return;
    say({ ok: outcome.ok, message: outcome.message }, outcome.since, { warnings: outcome.warnings ?? [] });
  },
);

function heardPage(result: DesktopRunAnswer, options: { picked?: boolean }): void {
  const at = since.value;
  if (options.picked) say(result, at, { locator: result.ok ? (result.locator ?? null) : null });
  else if (shownAnswer.value?.text !== result.message) say(result, at);
}

const { copy, copied } = useCopy();

// ── Focus ──
/** This worker's part of the tray. */
const root = ref<HTMLElement | null>(null);
/** The control of this worker the keyboard is on (its `data-focus`), focused again when a redraw takes it away. */
let focusKey: string | null = null;
/** While the worker lends the focus to another of its controls, until the one it was on comes back. */
let lending = false;

function heardFocus(event: FocusEvent): void {
  if (lending) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  focusKey = target && root.value?.contains(target) ? (target.dataset.focus ?? null) : null;
}

/** A press anywhere but on a control: the person put the focus there themselves. */
function heardPress(event: PointerEvent): void {
  if (!(event.target instanceof Element) || !event.target.closest('[data-focus]')) focusKey = null;
}

/**
 * Gives the keyboard back after a redraw took it to the page: to the control it was on (Step, at the next stop), or
 * meanwhile to the first control left (Pause, while the step runs), whose own focus does not replace it.
 */
function restoreFocus(): void {
  const active = document.activeElement;
  if (!focusKey || !root.value || (active && active !== document.body)) return;
  const same = root.value.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`);
  if (same) {
    same.focus();
    return;
  }
  const near = root.value.querySelector<HTMLElement>('[data-focus^="steer:"]');
  if (!near) return;
  lending = true;
  near.focus();
  lending = false;
}

watch([steering, codeActions], restoreFocus, { flush: 'post' });
onMounted(() => {
  document.addEventListener('focusin', heardFocus);
  document.addEventListener('pointerdown', heardPress, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('focusin', heardFocus);
  document.removeEventListener('pointerdown', heardPress, true);
});
</script>

<template>
  <li
    ref="root"
    class="rounded-md border border-default p-2 space-y-2"
    :data-state="worker.state"
    :data-failed="failed || undefined"
    data-shot="desktop-run-worker"
  >
    <p class="flex items-center gap-1.5 text-sm text-highlighted">
      <UIcon
        :name="
          failed
            ? 'i-lucide-circle-x'
            : stop
              ? 'i-lucide-circle-pause'
              : worker.state === 'running'
                ? 'i-lucide-circle-play'
                : 'i-lucide-circle-dot'
        "
        class="size-4 shrink-0"
        :class="failed ? 'text-error' : stop ? 'text-warning' : 'text-muted'"
        aria-hidden="true"
      />
      <span class="min-w-0 break-words">{{ stateText }}</span>
      <span v-if="count > 1" class="ml-auto text-xs text-muted shrink-0">Worker {{ worker.parallelIndex + 1 }}</span>
    </p>
    <div v-if="testText">
      <p class="text-sm text-highlighted break-words">{{ testText }}</p>
      <p v-if="metaText" class="text-xs text-muted">{{ metaText }}</p>
      <p v-if="worker.test?.cannotPause" class="text-xs text-muted">
        This test never stops: {{ worker.test.cannotPause }}
      </p>
    </div>

    <template v-if="stop">
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <template v-if="failed">
          <dt class="text-muted">Error</dt>
          <dd><ErrorText :text="desktopStopError(stop)" mode="block" /></dd>
        </template>
        <template v-else>
          <dt class="text-muted">Next</dt>
          <dd class="font-mono text-xs break-words text-highlighted">{{ stop.title }}</dd>
          <dt class="text-muted">Where</dt>
          <dd class="font-mono text-xs break-all text-highlighted">{{ place }}</dd>
        </template>
      </dl>
      <DesktopRunStopPage
        :run-ref="session.ref"
        :worker="worker.worker"
        :stop="stop"
        :takes="takes"
        :busy="busy"
        v-model:watch-live="watchLive"
        @said="heardPage"
        @picking="busy = $event"
      />
    </template>

    <div v-if="steering.length" class="flex flex-wrap gap-1.5">
      <UButton
        v-for="what in steering"
        :key="what"
        :data-focus="`steer:${what}`"
        size="xs"
        :color="what === 'resume' ? 'primary' : 'neutral'"
        :variant="what === 'resume' ? 'solid' : 'outline'"
        :icon="STEER[what].icon"
        :title="failed && what === 'resume' ? 'End the test as it failed' : STEER[what].title"
        :aria-disabled="busy || undefined"
        @click="!busy && steer(what)"
      >
        {{ STEER[what].label }}
      </UButton>
    </div>
    <div v-if="codeActions.length" role="group" aria-label="Code from this stop" class="flex flex-wrap gap-1.5">
      <UButton
        v-for="what in codeActions"
        :key="what"
        :data-focus="`code:${what}`"
        size="xs"
        color="neutral"
        variant="outline"
        :icon="CODE[what].icon"
        :title="CODE[what].title"
        :aria-disabled="busy || undefined"
        :aria-expanded="what === 'mock' ? !!shownRequests : undefined"
        @click="!busy && codeAction(what)"
      >
        {{ CODE[what].label }}
      </UButton>
    </div>

    <div v-if="shownAnswer && shownAnswer.text" class="space-y-1">
      <p class="flex items-start gap-1.5 text-xs" :class="shownAnswer.ok ? 'text-muted' : 'text-error'">
        <UIcon
          :name="shownAnswer.ok ? 'i-lucide-info' : 'i-lucide-triangle-alert'"
          class="size-3.5 shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <span class="min-w-0 break-words">{{ shownAnswer.text }}</span>
      </p>
      <div v-if="shownAnswer.locator" class="flex items-center gap-1.5 min-w-0">
        <LocatorCode :locator="shownAnswer.locator" truncate class="min-w-0" />
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          @click="copy(shownAnswer.locator, { toast: 'Locator copied' })"
        >
          Copy
        </UButton>
      </div>
      <ul v-if="shownAnswer.warnings.length" aria-label="What to check in the code" class="space-y-0.5">
        <li v-for="warning in shownAnswer.warnings" :key="warning" class="text-xs text-muted">{{ warning }}</li>
      </ul>
    </div>
    <DesktopRunRequests
      v-if="shownRequests"
      :requests="shownRequests.list"
      :busy="busy"
      @mock="mock"
      @close="requests = undefined"
    />
  </li>
</template>

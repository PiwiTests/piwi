<script setup lang="ts">
/**
 * Desktop shell only: a worker's lane in the Local runs tray, where its reporter shows it while its test runs
 * (`watch`), in its card (`DesktopRunPageCard`) while it is watched or the hub said why it would not show it. **Watch**
 * (on the worker's row of controls while its test runs, in the card's head at a stop) shows the page of the lane's
 * running test as it paints, and of each stop it comes to, through its tests and the workers Playwright starts in it,
 * until it is turned off or the run ends (the run page's **Watch** and **Pause and watch** turn it on too, through
 * `useDesktopRunHub`). The frames are drawn into one image (`DesktopRunLiveImage`), which keeps the last one, dimmed
 * and marked as running, until a frame of the page as it is now comes (`laneFrameNow`): across a Step, a Resume and
 * between two tests, as the tray opens again or the window shows again (a frame of an earlier view of the lane), and
 * while the lane says why it sends none. At a stop of a test, the stop takes the clicks, the keys (with **Interact**
 * on, `interact`, which Escape on the image turns off, but while a pick or a check runs in the page, which takes it) and **Pick on the image** on the image as it does on a stop
 * watched live: the window watches the stop through the lane. Turned off, Watch live and Interact go off for the worker
 * too. Who watches the page shows in the card's head, and who drives the stop at its foot (`foot`). **Open the trace so
 * far**, in the card's head while the lane is watched and its worker runs a test whose reporter answers the ask
 * (`canOpenTrace`), asks the hub to open Playwright's trace viewer on that test's trace as it stands when the viewer
 * opens, on the machine the run runs on (`openTrace`): its sentence shows under the test as the worker's other answers
 * do (`said`). **Inspect**, beside it, shows the page of that test at each of its calls under the image
 * (`DesktopRunLaneInspect`), which the app's server reads from the test's own trace while the window has it open
 * (`setInspect`), following the lane's next tests, until it is turned off, the lane is no longer watched or the card
 * goes.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { isViewFrameData } from '@piwitests/core/run-view';
import { driverOf, givesBack } from '@piwitests/run-model/presence';
import { canOpenTrace, laneFrameNow, stopIntents } from '@piwitests/run-model/stop';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import type { DesktopLaneFrame, DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import {
  desktopLaneKey,
  desktopRunStop,
  desktopSay,
  type DesktopLaneAt,
  type DesktopLiveImageHandle,
} from '~/utils/desktop-run-view';

const props = defineProps<{
  session: HubSession;
  worker: HubWorker;
  /** A command for this worker is on its way: a pick waits for it. */
  busy: boolean;
  /** Gives back the stop `since` names, once Interact went off and its input went. */
  giveBack: (since: string) => Promise<void>;
  /** Who watches the page, in the card's head. */
  watchers?: string | null;
}>();

const emit = defineEmits<{
  /** What a pick on the image, the input or Open the trace so far answered, to show under the test. */
  said: [answer: DesktopRunAnswer, options: { picked?: boolean }];
  /** A pick on the image is on its way, or came back. */
  picking: [on: boolean];
  /** The stop is being given back as Interact goes off, or was: the worker's buttons wait meanwhile. */
  releasing: [on: boolean];
}>();

/** What this page holds the worker's buttons for (a pick, a give-back), said to the worker, and let go as it goes. */
const held = { picking: false, releasing: false };
function holding(what: 'picking' | 'releasing', on: boolean): void {
  held[what] = on;
  if (what === 'picking') emit('picking', on);
  else emit('releasing', on);
}
onBeforeUnmount(() => {
  if (held.picking) emit('picking', false);
  if (held.releasing) emit('releasing', false);
});

const hub = useDesktopRunHub();
/** Interact, as the person left it for the worker's lane, kept by the window. */
const interact = defineModel<boolean>('interact', { default: false });

const runRef = computed(() => props.session.ref);
const lane = computed(() => props.worker.parallelIndex);
const watched = computed(() => hub.watchesLane(runRef.value, lane.value));
/** Why the hub would not show the lane, the last time the window asked. */
const refusedLane = computed(() => hub.state.laneRefusals[desktopLaneKey(runRef.value, lane.value)] ?? null);
// A refused lane takes no input: Interact goes off, to be turned on again on a lane that takes it.
watch(refusedLane, (refused) => {
  if (refused && interact.value) interact.value = false;
});
const stop = computed(() => desktopRunStop(props.worker));
const takes = computed(() => (stop.value ? stopIntents(props.worker, stop.value) : []));

// ── The frames ────────────────────────────────────────────────────────────────────────────────────────────────────

const liveImage = useTemplateRef<DesktopLiveImageHandle>('liveImage');
/** Where the image shown stands: the worker that sent it, its test, its stop, and the view of the lane it came in. */
const shown = ref<(DesktopLaneAt & { view: number }) | null>(null);
/** Why the lane sends no frame now, where it stood as it said so. */
const refused = ref<(DesktopLaneAt & { text: string }) | null>(null);
/** How many times the lane said why it sends no frame: a frame drawn before the last time clears none of it. */
let refusals = 0;
/** The image shows the page as it is now: the stop the worker stands at, else the test it runs, in this view. */
const current = computed(
  () =>
    !!shown.value &&
    shown.value.view === hub.laneView(runRef.value, lane.value) &&
    laneFrameNow(shown.value, props.worker),
);
/** Why the lane sends no frame of the page as it is now. */
const refusedNow = computed(() =>
  refused.value && laneFrameNow(refused.value, props.worker) ? refused.value.text : null,
);
/** The image is the page as it is now, and frames of it come. */
const live = computed(() => current.value && !refusedNow.value);
/** Pick on the image is on: the next click on it names the element under the pointer. */
const picking = ref(false);
let unlisten: (() => void) | null = null;

function heard(frame: DesktopLaneFrame, view: number): void {
  const at: DesktopLaneAt = { worker: frame.worker, test: frame.test, since: frame.since };
  if ('refused' in frame) {
    refusals++;
    refused.value = { ...at, text: frame.refused };
    // A frame waiting, or decoding, came before: the image stays as it is, dimmed.
    liveImage.value?.drop();
    return;
  }
  if (!isViewFrameData(frame.data)) return;
  const seen = refusals;
  liveImage.value?.draw(frame, () => {
    shown.value = { ...at, view };
    if (refusals === seen) refused.value = null;
  });
}

/** Listens for the lane's frames while it is watched; its image goes once it is not. */
function listen(on: boolean): void {
  unlisten?.();
  unlisten = null;
  if (on) {
    unlisten = hub.onLaneFrame(runRef.value, lane.value, heard);
    return;
  }
  shown.value = null;
  refused.value = null;
  picking.value = false;
  liveImage.value?.clear();
}

onMounted(() => listen(watched.value));
// Once the card is drawn: the frame kept comes at once, into its image.
watch(watched, listen, { flush: 'post' });
onBeforeUnmount(() => {
  unlisten?.();
  unlisten = null;
});

// ── At a stop ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The stop the image shows takes the clicks and keys on it: Interact sends them. */
const canInteract = computed(() => !!stop.value && current.value && takes.value.includes('input'));
/** Where the clicks and keys on the image go: the stop it shows, while Interact is on. */
const inputTarget = computed(() => {
  const at = stop.value;
  return at && canInteract.value && interact.value
    ? {
        ref: runRef.value,
        worker: props.worker.worker,
        since: at.since,
        clickCounts: takes.value.includes('input-clicks'),
        acting: !!at.acting,
      }
    : null;
});
const pickable = computed(() => !!stop.value && current.value && takes.value.includes('pick-at'));

async function pickAt(point: { x: number; y: number }): Promise<void> {
  const since = stop.value?.since;
  if (!since || !pickable.value || props.busy) return;
  picking.value = false;
  holding('picking', true);
  const answer = await hub.command({
    type: 'pick-at',
    ref: runRef.value,
    worker: props.worker.worker,
    since,
    ...point,
  });
  holding('picking', false);
  emit('said', answer, { picked: true });
}

watch(pickable, (can) => {
  if (!can) picking.value = false;
});

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && picking.value) picking.value = false;
}

onMounted(() => document.addEventListener('keydown', onEscape));
onBeforeUnmount(() => document.removeEventListener('keydown', onEscape));

// ── Watch ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const interactButton = ref<{ $el: HTMLElement } | null>(null);

/** Watch is being turned off, the stop given back first. */
let leaving = false;

async function toggle(): Promise<void> {
  if (leaving || props.busy) return;
  const on = !watched.value;
  // Watch off watches the worker no more, at its stops either, and sends nothing to its page: the stop is given back
  // before the watch ends, which would give it back unsaid.
  if (!on) {
    hub.setWatchLive(runRef.value, props.worker.worker, false);
    if (interact.value) {
      leaving = true;
      await interactOff();
      leaving = false;
    }
  }
  void hub.setLaneWatch(runRef.value, lane.value, on);
}

/** The stop the image's input drove last (all but the pointer's moves). */
const playedAt = ref<string | null>(null);

/**
 * Interact goes off: the input waiting on the image goes first, then a stop the window drives, or reached with its
 * input while nobody else took it, is given back, unless Interact is on again by then.
 */
async function interactOff(): Promise<void> {
  const since = stop.value?.since ?? null;
  const drained = liveImage.value?.release() ?? Promise.resolve();
  interact.value = false;
  holding('releasing', true);
  try {
    await drained;
    const now = stop.value;
    if (!since || interact.value || now?.since !== since) return;
    if (!givesBack(driverOf(now, englishRunSpeaker), playedAt.value === since)) return;
    playedAt.value = null;
    await props.giveBack(since);
  } finally {
    holding('releasing', false);
  }
}

defineExpose({ interactOff, toggle });

// ── Open the trace so far ─────────────────────────────────────────────────────────────────────────────────────────

/** The watched lane's worker runs a test whose reporter says where its trace grows. */
const traceable = computed(() => watched.value && canOpenTrace(props.worker));
/** Its ask waits for the hub's answer: the button waits with it. */
const tracing = ref(false);

/**
 * The hub opens Playwright's trace viewer on the lane's running test, on the machine the run runs on; the window names
 * no file.
 */
async function openTrace(): Promise<void> {
  if (tracing.value || !traceable.value) return;
  tracing.value = true;
  const answer = await hub.command({ type: 'openTrace', ref: runRef.value, lane: lane.value });
  tracing.value = false;
  emit('said', answer, {});
}

// ── Inspect ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Inspect is open on the lane: the server reads its running test's pages from its own trace. */
const inspecting = computed(() => !!hub.inspectOf(runRef.value, lane.value));

/** Opens Inspect on the lane, or closes it; a refusal shows under the test as the worker's other answers do. */
async function toggleInspect(): Promise<void> {
  const on = !inspecting.value;
  if (on && !traceable.value) return;
  const answer = await hub.setInspect(runRef.value, lane.value, on);
  if (!answer.ok) emit('said', answer, {});
}

// Inspect goes with the lane's watch, and with the card.
watch(watched, (on) => {
  if (!on && inspecting.value) void hub.setInspect(runRef.value, lane.value, false);
});
onBeforeUnmount(() => {
  if (inspecting.value) void hub.setInspect(runRef.value, lane.value, false);
});

/** Escape on the image: Interact goes off, and the keyboard to its toggle. */
async function leave(): Promise<void> {
  void interactOff();
  await nextTick();
  interactButton.value?.$el?.focus();
}

/** What the image is: live while frames of the page as it is now come, and whether it takes the clicks and keys. */
const alt = computed(() => {
  if (!live.value) return desktopSay('runs_laneAltLast');
  return desktopSay(inputTarget.value ? 'runs_liveAltInput' : 'runs_liveAlt');
});

/** An image of the lane shows: a frame came in this watch. */
const framed = computed(() => !!liveImage.value?.viewport);

const note = computed((): { icon?: string; text: string } | null => {
  if (!watched.value) return refusedLane.value ? { icon: 'i-lucide-triangle-alert', text: refusedLane.value } : null;
  if (refusedNow.value) return { icon: 'i-lucide-triangle-alert', text: refusedNow.value };
  if (current.value) return null;
  if (stop.value) return { icon: 'i-lucide-clock', text: desktopSay('runs_imageLoading') };
  if (props.worker.state === 'between') return shown.value ? null : { text: 'The page shows as the next test starts.' };
  return shown.value ? null : { icon: 'i-lucide-clock', text: desktopSay('runs_liveStarting') };
});
</script>

<template>
  <DesktopRunPageCard
    v-if="watched || refusedLane"
    :watchers="watchers"
    :data-picking="picking || undefined"
    :data-watching="watched || undefined"
    data-shot="desktop-run-lane"
  >
    <template v-if="stop || traceable || inspecting" #tools>
      <template v-if="stop">
        <UButton
          data-focus="page:watch"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-eye"
          :aria-pressed="watched"
          :aria-disabled="busy || undefined"
          :class="watched ? PRESSED_TOGGLE_CLASS : ''"
          :title="desktopSay('runs_watchTitle')"
          @click="toggle"
        >
          {{ desktopSay('runs_watch') }}
        </UButton>
        <UButton
          v-if="canInteract"
          ref="interactButton"
          data-focus="page:interact"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-hand"
          :aria-pressed="interact"
          :class="interact ? PRESSED_TOGGLE_CLASS : ''"
          :title="desktopSay('runs_interactTitle')"
          :aria-disabled="busy || undefined"
          @click="!busy && (interact ? interactOff() : (interact = true))"
        >
          {{ desktopSay('runs_interact') }}
        </UButton>
        <UButton
          v-if="pickable"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-mouse-pointer-click"
          :aria-pressed="picking"
          :aria-disabled="busy || undefined"
          :class="picking ? PRESSED_TOGGLE_CLASS : ''"
          title="Click the image to name the element under the pointer (or Shift+click it); Escape stops"
          @click="!busy && (picking = !picking)"
        >
          {{ desktopSay('runs_pickAt') }}
        </UButton>
      </template>
      <UButton
        v-if="traceable"
        data-focus="page:trace"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-file-archive"
        :aria-disabled="tracing || undefined"
        :title="desktopSay('runs_openTraceTitle')"
        @click="openTrace"
      >
        {{ desktopSay('runs_openTrace') }}
      </UButton>
      <UButton
        v-if="traceable || inspecting"
        data-focus="page:inspect"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-scan-search"
        :aria-pressed="inspecting"
        :class="inspecting ? PRESSED_TOGGLE_CLASS : ''"
        title="The page at each call of this test, as a document, with a locator picker, read from its own trace on this machine"
        @click="toggleInspect"
      >
        Inspect
      </UButton>
    </template>
    <DesktopRunLiveImage
      ref="liveImage"
      v-model:picking="picking"
      :alt="alt"
      :input="inputTarget"
      :dimmed="!live"
      :mark="live ? 'live' : stop ? null : 'running'"
      @pick="pickAt"
      @said="emit('said', $event, {})"
      @leave="leave"
      @played="playedAt = $event"
    />
    <div v-if="note && watched && !framed" class="grid aspect-[16/10] place-items-center bg-muted px-4 text-center">
      <p class="flex items-center gap-1.5 text-xs text-muted">
        <UIcon v-if="note.icon" :name="note.icon" class="size-3.5 shrink-0" aria-hidden="true" />
        {{ note.text }}
      </p>
    </div>
    <p
      v-else-if="note"
      class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted"
      :class="framed ? 'border-t border-default' : ''"
    >
      <UIcon v-if="note.icon" :name="note.icon" class="size-3.5 shrink-0" aria-hidden="true" />
      {{ note.text }}
    </p>
    <DesktopRunLaneInspect v-if="inspecting && watched" :session="session" :worker="worker" />
    <template v-if="$slots.foot" #foot>
      <slot name="foot" />
    </template>
  </DesktopRunPageCard>
</template>

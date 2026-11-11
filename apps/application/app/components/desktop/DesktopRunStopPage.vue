<script setup lang="ts">
/**
 * Desktop shell only: the page of a stopped worker of a run the shell started, in the Local runs tray, while its lane
 * is not watched (`DesktopRunLaneView` shows it then), in its card (`DesktopRunPageCard`), as Piwi Picker's Runs window
 * draws it. Its image, asked once per stop; **Watch live**, where the stop takes it, which shows the stop's frames in
 * the image's place (`DesktopRunLiveImage`) and stays on for the worker's next stops until it is turned off (the run
 * page's **Pause and watch** turns it on too, through `useDesktopRunHub`); **Interact** beside it, where the stop takes
 * the window's input, which sends the pointer, the wheel and the keys on the view to the page, stays on for the next
 * stops too, and goes off with Watch live or Escape on the view, giving the stop back as the run model says
 * (`givesBack`); **Pick on the image**, or a Shift+click on the image or the view, names the element under the
 * pointer. The view ends with the stop, as the window hides, and when it is turned off. Who watches the page shows in
 * the card's head, why the hub would not show the worker's lane under the image, and who drives the stop at its foot
 * (`foot`).
 */
import type { HubAction, HubImage, HubStop } from '@piwitests/core/run-hub';
import { isViewFrameData } from '@piwitests/core/run-view';
import { driverOf, givesBack } from '@piwitests/run-model/presence';
import { stopError } from '@piwitests/run-model/stop';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import type { DesktopFrame, DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import {
  desktopImagePoint,
  desktopSay,
  isDesktopRunImage,
  type DesktopLiveImageHandle,
} from '~/utils/desktop-run-view';

const props = defineProps<{
  runRef: string;
  worker: number;
  stop: HubStop;
  /** What the stop takes from the window (`stop.intents`). */
  takes: readonly HubAction[];
  /** A command for this worker is on its way: a pick waits for it. */
  busy: boolean;
  /** Why the hub would not show the worker's lane (**Watch**), when it would not. */
  laneRefused?: string | null;
  /** Who watches the page, in the card's head. */
  watchers?: string | null;
  /** Gives back the stop `since` names, once Interact went off and its input went. */
  giveBack: (since: string) => Promise<void>;
}>();

const emit = defineEmits<{
  /** What a pick on the image or the input answered, to show under the test. */
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

// ── The image of the stop ─────────────────────────────────────────────────────────────────────────────────────────

const still = ref<{
  since: string;
  src: string | null;
  viewport: { width: number; height: number } | null;
  note: string;
}>();

async function askImage(since: string): Promise<void> {
  still.value = { since, src: null, viewport: null, note: '' };
  const answer = await hub.command({ type: 'pausedPage', ref: props.runRef, worker: props.worker });
  if (still.value?.since !== since) return;
  const image: HubImage | null | undefined = answer.ok ? answer.image : null;
  const ok = !!image && image.mime === 'image/jpeg' && isDesktopRunImage(image.data);
  still.value = {
    since,
    src: ok ? `data:image/jpeg;base64,${image!.data}` : null,
    viewport: ok && image!.width && image!.height ? { width: image!.width, height: image!.height } : null,
    note: ok ? '' : answer.ok ? desktopSay('runs_imageNone') : answer.message,
  };
}

const stillShown = computed(() => (still.value?.since === props.stop.since ? still.value : undefined));

// ── The live view ─────────────────────────────────────────────────────────────────────────────────────────────────

const canView = computed(() => props.takes.includes('view'));
/** Watch live, as the person left it for the worker, kept by the window: on, each next stop of the worker is watched. */
const watchLive = defineModel<boolean>('watchLive', { default: false });
/** Interact, as the person left it for the worker's lane, kept by the window. */
const interact = defineModel<boolean>('interact', { default: false });
const view = ref<{
  since: string;
  status: 'starting' | 'on' | 'ended' | 'refused';
  note: string;
  /** Why the view sends no frame now: the page is too heavy for it. */
  heavy: string;
}>();
const liveImage = useTemplateRef<DesktopLiveImageHandle>('liveImage');
let unlisten: (() => void) | null = null;
const visible = ref(import.meta.client ? !document.hidden : true);

const live = computed(() => view.value?.since === props.stop.since && ['starting', 'on'].includes(view.value.status));
const framed = computed(() => live.value && !!liveImage.value?.viewport);

function startView(): void {
  endView(false);
  const since = props.stop.since;
  view.value = { since, status: 'starting', note: '', heavy: '' };
  // A view of another stop shows none of its frames.
  liveImage.value?.clear();
  unlisten = hub.onFrame(props.runRef, props.worker, since, (frame) => heardFrame(since, frame));
  void hub.command({ type: 'view', ref: props.runRef, worker: props.worker, since, on: true }).then((answer) => {
    if (view.value?.since !== since || !live.value) return;
    if (answer.ok) view.value.status = 'on';
    else {
      stopListening();
      view.value = { ...view.value, status: 'refused', note: answer.message };
      // A refused view takes no input: Interact goes off, to be turned on again on a view that takes it.
      if (interact.value) interact.value = false;
    }
  });
}

function heardFrame(since: string, frame: DesktopFrame): void {
  if (view.value?.since !== since || !live.value) return;
  if ('refused' in frame) {
    view.value.heavy = frame.refused;
    return;
  }
  if (!isViewFrameData(frame.data)) return;
  liveImage.value?.draw(frame, () => {
    if (view.value?.since === since) view.value.heavy = '';
  });
}

function stopListening(): void {
  unlisten?.();
  unlisten = null;
}

/** The view ends; the hub hears it (`tell`) while it was on. */
function endView(tell: boolean): void {
  const ended = view.value;
  stopListening();
  view.value = undefined;
  if (tell && ended && ['starting', 'on'].includes(ended.status)) {
    void hub.command({ type: 'view', ref: props.runRef, worker: props.worker, since: ended.since, on: false });
  }
}

/** Watch live is being turned off, the stop given back first. */
let leaving = false;

async function toggleLive(): Promise<void> {
  if (leaving || props.busy) return;
  if (live.value) {
    watchLive.value = false;
    // The stop is given back, once its input went, before the view ends, which would give it back unsaid.
    if (interact.value) {
      leaving = true;
      await interactOff();
      leaving = false;
    }
    endView(true);
  } else {
    watchLive.value = true;
    startView();
  }
}

/** The hub accepted the view and the stop takes the clicks and keys on it: Interact sends them. */
const canInteract = computed(() => live.value && view.value?.status === 'on' && props.takes.includes('input'));
/** Where the clicks and keys on the view go, while Interact sends them. */
const inputTarget = computed(() =>
  canInteract.value && interact.value
    ? {
        ref: props.runRef,
        worker: props.worker,
        since: props.stop.since,
        clickCounts: props.takes.includes('input-clicks'),
        acting: !!props.stop.acting,
      }
    : null,
);
const interactButton = ref<{ $el: HTMLElement } | null>(null);

/** The stop the view's input drove last (all but the pointer's moves). */
const playedAt = ref<string | null>(null);

/**
 * Interact goes off: the input waiting on the view goes first, then a stop the window drives, or reached with its
 * input while nobody else took it, is given back, unless Interact is on again by then.
 */
async function interactOff(): Promise<void> {
  const since = props.stop.since;
  const drained = liveImage.value?.release() ?? Promise.resolve();
  interact.value = false;
  holding('releasing', true);
  try {
    await drained;
    if (interact.value || props.stop.since !== since) return;
    if (!givesBack(driverOf(props.stop, englishRunSpeaker), playedAt.value === since)) return;
    playedAt.value = null;
    await props.giveBack(since);
  } finally {
    holding('releasing', false);
  }
}

defineExpose({ interactOff });

/** Escape on the view: Interact goes off, and the keyboard to its toggle. */
async function leave(): Promise<void> {
  void interactOff();
  await nextTick();
  interactButton.value?.$el?.focus();
}

// ── Pick on the image ─────────────────────────────────────────────────────────────────────────────────────────────

const picking = ref(false);
const pickable = computed(() => props.takes.includes('pick-at') && (framed.value || !!stillShown.value?.viewport));

async function pickAt(point: { x: number; y: number } | null): Promise<void> {
  if (!point || !props.takes.includes('pick-at') || props.busy) return;
  picking.value = false;
  holding('picking', true);
  const answer = await hub.command({
    type: 'pick-at',
    ref: props.runRef,
    worker: props.worker,
    since: props.stop.since,
    ...point,
  });
  holding('picking', false);
  emit('said', answer, { picked: true });
}

function onStillPointerDown(event: PointerEvent): void {
  const kept = stillShown.value;
  if (!(event.shiftKey || picking.value) || !kept?.viewport) return;
  event.preventDefault();
  void pickAt(desktopImagePoint(event.currentTarget as HTMLImageElement, event, kept.viewport));
}

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && picking.value) picking.value = false;
}

// ── Following the stop ────────────────────────────────────────────────────────────────────────────────────────────

function followStop(): void {
  if (stillShown.value === undefined) void askImage(props.stop.since);
  if (view.value && view.value.since !== props.stop.since) endView(false);
  if (canView.value && watchLive.value && !live.value && visible.value && view.value?.status !== 'refused') {
    startView();
  }
  if (!pickable.value) picking.value = false;
}

watch(() => [props.stop.since, canView.value, visible.value] as const, followStop, { immediate: true });
// The stream opened again: every view of the one before ended with it.
watch(
  () => hub.state.epoch,
  () => {
    if (!view.value) return;
    const was = live.value;
    endView(false);
    if (was && watchLive.value && canView.value) startView();
  },
);

function onVisibility(): void {
  visible.value = !document.hidden;
  if (document.hidden) endView(true);
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('keydown', onEscape);
});
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility);
  document.removeEventListener('keydown', onEscape);
  endView(true);
});

const imageAlt = computed(() =>
  props.stop.reason === 'failure'
    ? desktopSay('runs_imageAltFailure', { error: stopError(props.stop).split('\n')[0] ?? '' })
    : desktopSay('runs_imageAlt', { call: props.stop.title }),
);

/** An image of the page shows: the view's frame, else the stop's image. */
const shown = computed(() => framed.value || !!stillShown.value?.src);

const note = computed((): { icon?: string; text: string } | null => {
  const v = view.value;
  if (v && v.since === props.stop.since && !live.value) return { icon: 'i-lucide-triangle-alert', text: v.note };
  if (live.value && v?.heavy) return { icon: 'i-lucide-triangle-alert', text: v.heavy };
  if (live.value && !framed.value) return { icon: 'i-lucide-clock', text: desktopSay('runs_liveStarting') };
  if (shown.value) return null;
  if (stillShown.value && stillShown.value.note) return { text: stillShown.value.note };
  return { text: desktopSay('runs_imageLoading') };
});
</script>

<template>
  <DesktopRunPageCard :watchers="watchers" :data-picking="picking || undefined" data-shot="desktop-run-page">
    <template v-if="canView || canInteract || pickable" #tools>
      <UButton
        v-if="canView"
        data-focus="page:watch"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-eye"
        :aria-pressed="live"
        :aria-disabled="busy || undefined"
        :class="live ? PRESSED_TOGGLE_CLASS : ''"
        :title="desktopSay('runs_liveTitle')"
        @click="toggleLive"
      >
        {{ desktopSay('runs_live') }}
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
    <DesktopRunLiveImage
      v-if="live"
      ref="liveImage"
      v-model:picking="picking"
      :alt="desktopSay(inputTarget ? 'runs_liveAltInput' : 'runs_liveAlt')"
      :input="inputTarget"
      mark="live"
      @pick="pickAt"
      @said="emit('said', $event, {})"
      @leave="leave"
      @played="playedAt = $event"
    />
    <img
      v-if="!framed && stillShown?.src"
      :src="stillShown.src"
      :alt="imageAlt"
      draggable="false"
      class="block w-full bg-muted select-none"
      :class="picking ? 'cursor-crosshair' : ''"
      @pointerdown="onStillPointerDown"
    />
    <div v-if="note && !shown" class="grid aspect-[16/10] place-items-center bg-muted px-4 text-center">
      <p class="flex items-center gap-1.5 text-xs text-muted">
        <UIcon v-if="note.icon" :name="note.icon" class="size-3.5 shrink-0" aria-hidden="true" />
        {{ note.text }}
      </p>
    </div>
    <p v-else-if="note" class="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-default text-xs text-muted">
      <UIcon v-if="note.icon" :name="note.icon" class="size-3.5 shrink-0" aria-hidden="true" />
      {{ note.text }}
    </p>
    <p
      v-if="laneRefused"
      class="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-default text-xs text-muted"
      data-testid="desktop-lane-refused"
    >
      <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" aria-hidden="true" />
      {{ laneRefused }}
    </p>
    <template v-if="$slots.foot" #foot>
      <slot name="foot" />
    </template>
  </DesktopRunPageCard>
</template>

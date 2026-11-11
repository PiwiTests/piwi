<script setup lang="ts">
/**
 * Desktop shell only: the page of a stopped worker of a run the shell started, in the Local runs tray, while its lane
 * is not watched (`DesktopRunLaneView` shows it then). Its image, asked once per stop; **Watch live**, where the stop
 * takes it, which shows the stop's frames in the image's place (`DesktopRunLiveImage`) and stays on for the worker's
 * next stops until it is turned off (the run page's **Pause and watch** turns it on too, through `useDesktopRunHub`);
 * **Interact** beside it, where the stop takes the window's input, which sends the pointer, the wheel and the keys on
 * the view to the page, stays on for the next stops too, and goes off with Watch live or Escape on the view;
 * **Pick on the image**,
 * or a Shift+click on the image or the view, names the element under the pointer. The view ends with the stop, as the
 * window hides, and when it is turned off. Why the hub would not show the worker's lane shows under the image.
 */
import type { HubAction, HubImage, HubStop } from '@piwitests/core/run-hub';
import { isViewFrameData } from '@piwitests/core/run-view';
import type { DesktopFrame, DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import {
  desktopImagePoint,
  desktopStopError,
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
    note: ok ? '' : answer.ok ? 'The test has no image of this page.' : answer.message,
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
  emit('releasing', true);
  try {
    await drained;
    if (interact.value || props.stop.since !== since) return;
    const driver = props.stop.driver;
    if (!driver?.self && (driver || playedAt.value !== since)) return;
    playedAt.value = null;
    await props.giveBack(since);
  } finally {
    emit('releasing', false);
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
  emit('picking', true);
  const answer = await hub.command({
    type: 'pick-at',
    ref: props.runRef,
    worker: props.worker,
    since: props.stop.since,
    ...point,
  });
  emit('picking', false);
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
    ? `The page where the test failed: ${desktopStopError(props.stop).split('\n')[0]}`
    : `The page, stopped before ${props.stop.title}`,
);

const note = computed((): { icon?: string; text: string } | null => {
  const v = view.value;
  if (v && v.since === props.stop.since && !live.value) return { icon: 'i-lucide-triangle-alert', text: v.note };
  if (live.value && v?.heavy) return { icon: 'i-lucide-triangle-alert', text: v.heavy };
  if (live.value && !framed.value) return { icon: 'i-lucide-clock', text: 'Starting the live view…' };
  if (framed.value || stillShown.value?.src) return null;
  if (stillShown.value && stillShown.value.note) return { text: stillShown.value.note };
  return { text: 'Taking an image of the page…' };
});
</script>

<template>
  <figure class="space-y-2" :data-picking="picking || undefined" data-shot="desktop-run-page">
    <div v-if="canView || pickable" class="flex flex-wrap gap-1.5">
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
        title="Show the page as it paints, in place of its image: Interact then sends your clicks and keys to it"
        @click="toggleLive"
      >
        Watch live
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
        title="Send your clicks, scrolling and keys to the test's page, driving this stop: Escape gives it back"
        :aria-disabled="busy || undefined"
        @click="!busy && (interact ? interactOff() : (interact = true))"
      >
        Interact
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
        Pick on the image
      </UButton>
    </div>
    <DesktopRunLiveImage
      v-if="live"
      ref="liveImage"
      v-model:picking="picking"
      :alt="inputTarget ? 'The page, live: clicks and keys go to it' : 'The page, live'"
      :input="inputTarget"
      mark="Live"
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
      class="block w-full rounded-md border border-default select-none"
      :class="picking ? 'cursor-crosshair' : ''"
      @pointerdown="onStillPointerDown"
    />
    <p v-if="note" class="flex items-center gap-1.5 text-xs text-muted">
      <UIcon v-if="note.icon" :name="note.icon" class="size-3.5 shrink-0" />
      {{ note.text }}
    </p>
    <p v-if="laneRefused" class="flex items-center gap-1.5 text-xs text-muted" data-testid="desktop-lane-refused">
      <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" />
      {{ laneRefused }}
    </p>
  </figure>
</template>

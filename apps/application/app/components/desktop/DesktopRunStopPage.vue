<script setup lang="ts">
/**
 * Desktop shell only: the page of a stopped worker of a run the shell started, in the Local runs tray, while its lane
 * is not watched (`DesktopRunLaneView` shows it then). Its image, asked once per stop; **Watch live**, where the stop
 * takes it, which shows the stop's frames in the image's place (`DesktopRunLiveImage`, where the pointer, the wheel and
 * the keys go to the page when the stop takes the window's input) and stays on for the worker's next stops until it is
 * turned off (the run page's **Pause and watch** turns it on too, through `useDesktopRunHub`); **Pick on the image**,
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
}>();

const emit = defineEmits<{
  /** What a pick on the image or the input answered, to show under the test. */
  said: [answer: DesktopRunAnswer, options: { picked?: boolean }];
  /** A pick on the image is on its way, or came back. */
  picking: [on: boolean];
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

function toggleLive(): void {
  if (live.value) {
    watchLive.value = false;
    endView(true);
  } else {
    watchLive.value = true;
    startView();
  }
}

/** Where the clicks and keys on the view go, while the view is on and the stop takes them. */
const inputTarget = computed(() =>
  view.value?.status === 'on' && live.value && props.takes.includes('input')
    ? {
        ref: props.runRef,
        worker: props.worker,
        since: props.stop.since,
        clickCounts: props.takes.includes('input-clicks'),
      }
    : null,
);
const liveButton = ref<{ $el: HTMLElement } | null>(null);

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
        ref="liveButton"
        data-focus="page:watch"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-eye"
        :aria-pressed="live"
        title="Show the page as it paints, and let the clicks and keys on it go to the page where the stop takes them"
        @click="toggleLive"
      >
        Watch live
      </UButton>
      <UButton
        v-if="pickable"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-mouse-pointer-click"
        :aria-pressed="picking"
        :aria-disabled="busy || undefined"
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
      @leave="liveButton?.$el?.focus()"
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

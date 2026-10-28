<script setup lang="ts">
/**
 * Desktop shell only: the page of a stopped worker of a run the shell started, in the Local runs tray. Its image,
 * asked once per stop; **Watch live**, where the stop takes it, which shows the stop's frames in the image's place and
 * stays on for the worker's next stops until it is turned off; the pointer, the wheel and the keys on the live view go
 * to the page where the stop takes the window's input (Tab leaves the view unless a click took the keyboard, Escape
 * gives it back); **Pick on the image**, or a Shift+click on the image or the view, names the element under the
 * pointer. The input and the points come from the Runs window's own logic (`view-input.ts`, `pagePoint`). A frame is
 * drawn into the one image element as it comes and is kept nowhere else; the view ends with the stop, as the window
 * hides, and when it is turned off.
 */
import type { HubAction, HubImage, HubStop } from '@piwitests/core/run-hub';
import { isViewFrameData, type ViewButton, type ViewInput } from '@piwitests/core/run-view';
import { pagePoint } from '../../../../extension/src/shared/runs';
import {
  ViewInputBatcher,
  keyOnView,
  pastedText,
  type ViewModifier,
} from '../../../../extension/src/shared/view-input';
import type { DesktopFrame, DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import { desktopStopError, isDesktopRunImage } from '~/utils/desktop-run-view';

const props = defineProps<{
  runRef: string;
  worker: number;
  stop: HubStop;
  /** What the stop takes from the window (`stop.intents`). */
  takes: readonly HubAction[];
  /** A command for this worker is on its way: a pick waits for it. */
  busy: boolean;
}>();

const emit = defineEmits<{
  /** What a pick on the image or the input answered, to show under the test. */
  said: [answer: DesktopRunAnswer, options: { picked?: boolean }];
  /** A pick on the image is on its way, or came back. */
  picking: [on: boolean];
}>();

const hub = useDesktopRunHub();

/** The buttons that go to the page: the middle one stays the window's, as it opens what it clicks in a new tab. */
const BUTTONS: Record<number, ViewButton> = { 0: 'left', 2: 'right' };
const MAC = import.meta.client && /Mac|iPhone|iPad/.test(navigator.platform);

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
/** Watch live, as the person left it, kept by the worker: on, each next stop of the worker is watched too. */
const watchLive = defineModel<boolean>('watchLive', { default: false });
const view = ref<{
  since: string;
  status: 'starting' | 'on' | 'ended' | 'refused';
  note: string;
  viewport: { width: number; height: number } | null;
  /** Why the view sends no frame now: the page is too heavy for it. */
  heavy: string;
}>();
const liveImg = ref<HTMLImageElement | null>(null);
let unlisten: (() => void) | null = null;
/** A frame waiting while the one before decodes: the latest alone. */
let nextFrame: Extract<DesktopFrame, { data: string }> | null = null;
let decoding = false;
const visible = ref(true);

const live = computed(() => view.value?.since === props.stop.since && ['starting', 'on'].includes(view.value.status));
const framed = computed(() => live.value && !!view.value?.viewport);

function startView(): void {
  endView(false);
  const since = props.stop.since;
  view.value = { since, status: 'starting', note: '', viewport: null, heavy: '' };
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
  nextFrame = frame;
  if (!decoding) void drawFrames(since);
}

async function drawFrames(since: string): Promise<void> {
  decoding = true;
  while (nextFrame && view.value?.since === since) {
    const frame = nextFrame;
    nextFrame = null;
    const src = `data:image/jpeg;base64,${frame.data}`;
    // Decoded aside first: the view shows the frame before until this one is whole.
    const decoded = new Image();
    decoded.src = src;
    try {
      await decoded.decode();
    } catch {
      continue;
    }
    if (view.value?.since !== since || !live.value) break;
    view.value.viewport = { width: frame.width, height: frame.height };
    view.value.heavy = '';
    await nextTick();
    if (liveImg.value) liveImg.value.src = src;
  }
  decoding = false;
}

function stopListening(): void {
  unlisten?.();
  unlisten = null;
  nextFrame = null;
  stopInput();
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

// ── The input on the view ─────────────────────────────────────────────────────────────────────────────────────────

const inputOn = computed(() => framed.value && view.value?.status === 'on' && props.takes.includes('input'));
let input: ViewInputBatcher | null = null;
/** A click into the view took the keyboard, Tab included, until Escape gives it back. */
let captured = false;
const liveButton = ref<{ $el: HTMLElement } | null>(null);

function stopInput(): void {
  input?.dispose();
  input = null;
  captured = false;
}

watch(
  inputOn,
  (on) => {
    if (!on) return stopInput();
    const since = props.stop.since;
    input ??= new ViewInputBatcher({
      clickCounts: props.takes.includes('input-clicks'),
      send: async (events: ViewInput[]) => {
        if (view.value?.since !== since) return false;
        const answer = await hub.command({ type: 'input', ref: props.runRef, worker: props.worker, since, events });
        if (!answer.ok && view.value?.since === since) emit('said', answer, {});
        return answer.ok;
      },
    });
  },
  { immediate: true },
);

function modifiersOf(event: MouseEvent): ViewModifier[] {
  const held: ViewModifier[] = [];
  if (event.ctrlKey) held.push('Control');
  if (event.altKey) held.push('Alt');
  if (event.metaKey) held.push('Meta');
  return held;
}

/** Where a pointer event is on an image, in CSS pixels of the viewport it shows. */
function pointOn(img: HTMLImageElement, event: MouseEvent, viewport: { width: number; height: number }) {
  const rect = img.getBoundingClientRect();
  return pagePoint(
    { x: event.clientX - rect.left - img.clientLeft, y: event.clientY - rect.top - img.clientTop },
    { width: img.clientWidth, height: img.clientHeight },
    viewport,
  );
}

let pointed: { x: number; y: number } | null = null;
const at = (event: MouseEvent) =>
  liveImg.value && view.value?.viewport ? pointOn(liveImg.value, event, view.value.viewport) : null;

function onLivePointerDown(event: PointerEvent): void {
  if (event.shiftKey || picking.value) {
    event.preventDefault();
    if (liveImg.value && view.value?.viewport) void pickOn(liveImg.value, event, view.value.viewport);
    return;
  }
  pointed = at(event);
  if (!input || !BUTTONS[event.button] || !pointed) return;
  liveImg.value?.focus({ preventScroll: true });
  captured = true;
  liveImg.value?.setPointerCapture?.(event.pointerId);
}

function onLiveMouseDown(event: MouseEvent): void {
  if (!input) return;
  event.preventDefault();
  const button = BUTTONS[event.button];
  const point = pointed ?? at(event);
  if (button && point) input.down(button, point.x, point.y, { count: event.detail, modifiers: modifiersOf(event) });
}

function onLivePointerMove(event: PointerEvent): void {
  pointed = at(event);
  if (input && pointed) input.move(pointed.x, pointed.y);
}

function onLivePointerUp(event: PointerEvent): void {
  pointed = at(event);
}

function onLiveBlur(): void {
  captured = false;
}

function onLiveMouseUp(event: MouseEvent): void {
  const button = BUTTONS[event.button];
  const point = pointed ?? at(event);
  if (input && button && point) input.up(button, point.x, point.y, { count: event.detail });
}

function onLivePointerCancel(event: PointerEvent): void {
  const point = at(event);
  if (input && point) input.cancel(point.x, point.y);
}

function onLiveWheel(event: WheelEvent): void {
  const point = at(event);
  // The wheel scrolls the page once the view has the focus; until then it scrolls the tray.
  if (!input || !point || document.activeElement !== liveImg.value) return;
  event.preventDefault();
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (view.value?.viewport?.height ?? 600) : 1;
  input.wheel(point.x, point.y, event.deltaX * scale, event.deltaY * scale);
}

function onLiveKeyDown(event: KeyboardEvent): void {
  if (!input) return;
  const decided = keyOnView(
    {
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      altGraph: event.getModifierState?.('AltGraph') ?? false,
      isComposing: event.isComposing,
    },
    { mac: MAC, captured },
  );
  if (decided === 'leave') {
    // The keyboard back to the tray, on Watch live; Pick on the image, waiting, stops too.
    event.preventDefault();
    event.stopPropagation();
    captured = false;
    picking.value = false;
    liveButton.value?.$el?.focus();
    return;
  }
  if (decided === 'window' || decided === 'none') return;
  event.preventDefault();
  input.key(decided.send);
}

function onLivePaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!input || !text) return;
  event.preventDefault();
  for (const typed of pastedText(text)) input.key(typed);
}

// ── Pick on the image ─────────────────────────────────────────────────────────────────────────────────────────────

const picking = ref(false);
const pickable = computed(() => props.takes.includes('pick-at') && (framed.value || !!stillShown.value?.viewport));

async function pickOn(img: HTMLImageElement, event: MouseEvent, viewport: { width: number; height: number }) {
  const point = pointOn(img, event, viewport);
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
  void pickOn(event.currentTarget as HTMLImageElement, event, kept.viewport);
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
    <div v-if="framed || stillShown?.src" class="relative">
      <img
        v-if="framed"
        ref="liveImg"
        :alt="inputOn ? 'The page, live: clicks and keys go to it' : 'The page, live'"
        :tabindex="inputOn ? 0 : undefined"
        draggable="false"
        class="block w-full rounded-md border border-default focus-visible:outline-2 focus-visible:outline-primary select-none"
        :class="picking ? 'cursor-crosshair' : inputOn ? 'cursor-default' : ''"
        @pointerdown="onLivePointerDown"
        @mousedown="onLiveMouseDown"
        @pointermove="onLivePointerMove"
        @pointerup="onLivePointerUp"
        @mouseup="onLiveMouseUp"
        @pointercancel="onLivePointerCancel"
        @contextmenu="inputOn && $event.preventDefault()"
        @wheel="onLiveWheel"
        @keydown="onLiveKeyDown"
        @paste="onLivePaste"
        @blur="onLiveBlur"
      />
      <img
        v-else-if="stillShown?.src"
        :src="stillShown.src"
        :alt="imageAlt"
        draggable="false"
        class="block w-full rounded-md border border-default select-none"
        :class="picking ? 'cursor-crosshair' : ''"
        @pointerdown="onStillPointerDown"
      />
      <span
        v-if="framed"
        aria-hidden="true"
        class="pointer-events-none absolute top-2 left-2 inline-flex items-center gap-1 rounded bg-default/90 px-1.5 py-0.5 text-xs text-highlighted"
      >
        <span class="size-1.5 rounded-full bg-error" />
        Live
      </span>
    </div>
    <p v-if="note" class="flex items-center gap-1.5 text-xs text-muted">
      <UIcon v-if="note.icon" :name="note.icon" class="size-3.5 shrink-0" />
      {{ note.text }}
    </p>
    <p v-if="inputOn" class="text-xs text-muted">
      Clicks and keys on the view go to the page. Escape gives the keyboard back; Tab leaves unless a click took it.
    </p>
  </figure>
</template>

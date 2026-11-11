<script setup lang="ts">
/**
 * Desktop shell only: the one image element a live view of a worker's page draws into, in the Local runs tray, for a
 * stop's view (`DesktopRunStopPage`) and a lane's (`DesktopRunLaneView`). Each frame is decoded aside and shown once
 * whole, the latest alone waiting meanwhile, and is kept nowhere else (`draw`). While the stop it shows takes the
 * window's input (`input`, while Interact is on), the pointer, the wheel and the keys on it go to the page: Tab leaves
 * the image unless a click took the keyboard, and Escape turns Interact off (`leave`), but goes to the page while a pick
 * or a check runs there (`input.acting`) and Pick on the image does not wait. A Shift+click, or a click while
 * `picking`, names the point under the pointer instead (`pick`). The input and the points come from the run model the
 * tray shares with Piwi Picker's Runs window (`@piwitests/run-model/view-input`, `pagePoint`). `dimmed` shows an image
 * that is no longer the page as it is now, and `mark` says over it what it shows. It fills the width of its page card
 * (`DesktopRunPageCard`), and while it takes the input, says how under it.
 */
import type { ViewButton, ViewInput } from '@piwitests/core/run-view';
import { ViewInputBatcher, keyOnView, pastedText, type ViewModifier } from '@piwitests/run-model/view-input';
import type { DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import { desktopImagePoint, desktopSay, type DesktopRunInputTarget } from '~/utils/desktop-run-view';

const props = defineProps<{
  alt: string;
  /** The stop the clicks and keys on the image go to, while it takes them; null while they go nowhere. */
  input: DesktopRunInputTarget | null;
  /** The image is the page as it last showed, not as it is now. */
  dimmed?: boolean;
  /** What the mark over the image says: `Live`, with its dot, or `Running…` (`running`); none when null. */
  mark?: 'live' | 'running' | null;
}>();

const emit = defineEmits<{
  /** What the input answered when the page did not take it, to show under the test. */
  said: [answer: DesktopRunAnswer];
  /** A point of the page to name the element at, in CSS pixels of its viewport. */
  pick: [point: { x: number; y: number }];
  /** Escape on the image: Interact goes off, and its toggle takes the keyboard. */
  leave: [];
  /** Input that drives the stop (all but the pointer's moves) reached the stop `since` names. */
  played: [since: string];
}>();

/** Picking a point: the next click on the image names it. */
const picking = defineModel<boolean>('picking', { default: false });

const hub = useDesktopRunHub();

/** The buttons that go to the page: the middle one stays the window's, as it opens what it clicks in a new tab. */
const BUTTONS: Record<number, ViewButton> = { 0: 'left', 2: 'right' };
const MAC = import.meta.client && /Mac|iPhone|iPad/.test(navigator.platform);

// ── The frames ────────────────────────────────────────────────────────────────────────────────────────────────────

const img = ref<HTMLImageElement | null>(null);
const viewport = ref<{ width: number; height: number } | null>(null);
/** A frame waiting while the one before decodes: the latest alone. */
let next: { frame: { width: number; height: number; data: string }; shown?: () => void } | null = null;
let decoding = false;
/** Goes up as the frames waiting are dropped: one decoding before is not shown. */
let generation = 0;

function draw(frame: { width: number; height: number; data: string }, shown?: () => void): void {
  next = { frame, shown };
  if (!decoding) void drawFrames();
}

async function drawFrames(): Promise<void> {
  decoding = true;
  const at = generation;
  while (next && at === generation) {
    const { frame, shown } = next;
    next = null;
    const src = `data:image/jpeg;base64,${frame.data}`;
    // Decoded aside first: the image shows the frame before until this one is whole.
    const decoded = new Image();
    decoded.src = src;
    try {
      await decoded.decode();
    } catch {
      continue;
    }
    if (at !== generation) break;
    viewport.value = { width: frame.width, height: frame.height };
    await nextTick();
    if (img.value) img.value.src = src;
    shown?.();
  }
  decoding = false;
  if (next) void drawFrames();
}

/** The frame waiting, and one decoding, are not shown: the image keeps the one it shows. */
function drop(): void {
  generation++;
  next = null;
}

function clear(): void {
  drop();
  viewport.value = null;
  img.value?.removeAttribute('src');
}

defineExpose({
  draw,
  drop,
  clear,
  focus: () => img.value?.focus({ preventScroll: true }),
  release,
  viewport,
});

// ── The input on the image ────────────────────────────────────────────────────────────────────────────────────────

const inputOn = computed(() => !!props.input && !!viewport.value);
/** Names the stop the input goes to now: a batcher of its own for each. */
const inputKey = computed(() => {
  const target = props.input;
  return target && viewport.value
    ? `${target.ref}|${target.worker}|${target.since}|${target.clickCounts ? 'counts' : ''}`
    : null;
});
let batcher: ViewInputBatcher | null = null;
/** A click into the image took the keyboard, Tab included, until Escape gives it back. */
let captured = false;

function stopInput(): void {
  batcher?.dispose();
  batcher = null;
  captured = false;
}

/**
 * The image takes no more input, and what it played ends well (`ViewInputBatcher.finish`): resolves once what waited
 * went out, the image unmounted meanwhile included.
 */
function release(): Promise<void> {
  const ending = batcher;
  batcher = null;
  captured = false;
  return ending ? ending.finish() : Promise.resolve();
}

watch(
  inputKey,
  (key) => {
    stopInput();
    const target = props.input;
    if (!key || !target) return;
    const mine = new ViewInputBatcher({
      clickCounts: target.clickCounts,
      send: async (events: ViewInput[]) => {
        const { ref, worker, since } = target;
        const answer = await hub.command({ type: 'input', ref, worker, since, events });
        if (answer.ok && events.some((e) => e.type !== 'mouse' || e.action !== 'move')) emit('played', since);
        if (!answer.ok && batcher === mine) emit('said', answer);
        return answer.ok;
      },
    });
    batcher = mine;
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

let pointed: { x: number; y: number } | null = null;
const at = (event: MouseEvent) =>
  img.value && viewport.value ? desktopImagePoint(img.value, event, viewport.value) : null;

function onPointerDown(event: PointerEvent): void {
  if (event.shiftKey || picking.value) {
    event.preventDefault();
    const point = at(event);
    if (point) emit('pick', point);
    return;
  }
  pointed = at(event);
  if (!batcher || !BUTTONS[event.button] || !pointed) return;
  img.value?.focus({ preventScroll: true });
  captured = true;
  img.value?.setPointerCapture?.(event.pointerId);
}

function onMouseDown(event: MouseEvent): void {
  if (!batcher) return;
  event.preventDefault();
  const button = BUTTONS[event.button];
  const point = pointed ?? at(event);
  if (button && point) batcher.down(button, point.x, point.y, { count: event.detail, modifiers: modifiersOf(event) });
}

function onPointerMove(event: PointerEvent): void {
  pointed = at(event);
  if (batcher && pointed) batcher.move(pointed.x, pointed.y);
}

function onPointerUp(event: PointerEvent): void {
  pointed = at(event);
}

function onBlur(): void {
  captured = false;
}

function onMouseUp(event: MouseEvent): void {
  const button = BUTTONS[event.button];
  const point = pointed ?? at(event);
  if (batcher && button && point) batcher.up(button, point.x, point.y, { count: event.detail });
}

function onPointerCancel(event: PointerEvent): void {
  const point = at(event);
  if (batcher && point) batcher.cancel(point.x, point.y);
}

function onWheel(event: WheelEvent): void {
  const point = at(event);
  // The wheel scrolls the page once the image has the focus; until then it scrolls the tray.
  if (!batcher || !point || document.activeElement !== img.value) return;
  event.preventDefault();
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (viewport.value?.height ?? 600) : 1;
  batcher.wheel(point.x, point.y, event.deltaX * scale, event.deltaY * scale);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!batcher) return;
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
    // An action runs in the test's window at the stop (a pick, a check): its Escape is the page's, unless Pick on the
    // image waits, which Escape stops.
    { mac: MAC, captured, acting: !!props.input?.acting && !picking.value },
  );
  if (decided === 'leave') {
    // The keyboard back to the tray; Pick on the image, waiting, stops too.
    event.preventDefault();
    event.stopPropagation();
    captured = false;
    picking.value = false;
    emit('leave');
    return;
  }
  if (decided === 'window' || decided === 'none') return;
  // A key sent to the page is the page's alone: the dashboard behind the tray never sees it (its shortcuts, the inbox's
  // keys).
  event.preventDefault();
  event.stopPropagation();
  batcher.key(decided.send);
}

function onPaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!batcher || !text) return;
  event.preventDefault();
  event.stopPropagation();
  for (const typed of pastedText(text)) batcher.key(typed);
}

onBeforeUnmount(() => {
  drop();
  stopInput();
});
</script>

<template>
  <div v-show="viewport">
    <div class="relative">
      <img
        ref="img"
        :alt="alt"
        :tabindex="inputOn ? 0 : undefined"
        :data-stale="dimmed || undefined"
        :data-acting="input?.acting ? '' : undefined"
        draggable="false"
        class="block w-full bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary select-none transition-opacity"
        :class="[dimmed ? 'opacity-50' : '', picking ? 'cursor-crosshair' : inputOn ? 'cursor-default' : '']"
        @pointerdown="onPointerDown"
        @mousedown="onMouseDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @mouseup="onMouseUp"
        @pointercancel="onPointerCancel"
        @contextmenu="inputOn && $event.preventDefault()"
        @wheel="onWheel"
        @keydown="onKeyDown"
        @paste="onPaste"
        @blur="onBlur"
      />
      <span
        v-if="mark"
        aria-hidden="true"
        class="pointer-events-none absolute top-2 left-2 inline-flex items-center gap-1 rounded bg-default/90 px-1.5 py-0.5 text-xs text-highlighted"
      >
        <span v-if="mark === 'live'" class="size-1.5 rounded-full bg-error" />
        {{ desktopSay(mark === 'live' ? 'runs_liveBadge' : 'runs_laneRunning') }}
      </span>
    </div>
    <p v-if="inputOn" class="px-2.5 py-1.5 border-t border-default text-xs text-muted">
      {{ desktopSay('runs_liveHint') }}
    </p>
  </div>
</template>

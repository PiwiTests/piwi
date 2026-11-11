<script setup lang="ts">
/**
 * Desktop shell only: a worker's lane in the Local runs tray, where its reporter shows it while its test runs
 * (`watch`). **Watch** shows the page of the lane's running test as it paints, and of each stop it comes to, through
 * its tests and the workers Playwright starts in it, until it is turned off or the run ends (the run page's **Watch**
 * and **Pause and watch** turn it on too, through `useDesktopRunHub`). The frames are drawn into one image
 * (`DesktopRunLiveImage`), which keeps the last one, dimmed and marked as running, until a frame of the page as it is
 * now comes: across a Step, a Resume and between two tests, as the tray opens again or the window shows again (a frame
 * of an earlier view of the lane), and while the lane says why it sends none. At a stop of a test, the stop takes the
 * clicks, the keys (with **Interact** on, `interact`, which Escape on the image turns off) and **Pick on the image** on
 * the image as it does on a stop watched live: the window watches the stop through the lane. Turned off, Watch live
 * and Interact go off for the worker too.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { isViewFrameData } from '@piwitests/core/run-view';
import type { DesktopLaneFrame, DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import {
  desktopLaneFrameCurrent,
  desktopLaneKey,
  desktopRunStop,
  desktopStopTakes,
  type DesktopLaneAt,
  type DesktopLiveImageHandle,
} from '~/utils/desktop-run-view';

const props = defineProps<{
  session: HubSession;
  worker: HubWorker;
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
/** Interact, as the person left it for the worker's lane, kept by the window. */
const interact = defineModel<boolean>('interact', { default: false });

const runRef = computed(() => props.session.ref);
const lane = computed(() => props.worker.parallelIndex);
const watched = computed(() => hub.watchesLane(runRef.value, lane.value));
/** Why the hub would not show the lane, the last time the window asked. */
const refusedLane = computed(() => hub.state.laneRefusals[desktopLaneKey(runRef.value, lane.value)] ?? null);
const stop = computed(() => desktopRunStop(props.worker));
const takes = computed(() => (stop.value ? desktopStopTakes(props.worker, stop.value) : []));

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
    desktopLaneFrameCurrent(shown.value, props.worker),
);
/** Why the lane sends no frame of the page as it is now. */
const refusedNow = computed(() =>
  refused.value && desktopLaneFrameCurrent(refused.value, props.worker) ? refused.value.text : null,
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
watch(watched, listen);
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
      }
    : null;
});
const pickable = computed(() => !!stop.value && current.value && takes.value.includes('pick-at'));

async function pickAt(point: { x: number; y: number }): Promise<void> {
  const since = stop.value?.since;
  if (!since || !pickable.value || props.busy) return;
  picking.value = false;
  emit('picking', true);
  const answer = await hub.command({
    type: 'pick-at',
    ref: runRef.value,
    worker: props.worker.worker,
    since,
    ...point,
  });
  emit('picking', false);
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

function toggle(): void {
  const on = !watched.value;
  // Watch off watches the worker no more, at its stops either, and sends nothing to its page.
  if (!on) {
    hub.setWatchLive(runRef.value, props.worker.worker, false);
    if (interact.value) interact.value = false;
  }
  void hub.setLaneWatch(runRef.value, lane.value, on);
}

/** Escape on the image: Interact goes off, and the keyboard to its toggle. */
async function leave(): Promise<void> {
  interact.value = false;
  await nextTick();
  interactButton.value?.$el?.focus();
}

/** What the image is: live while frames of the page as it is now come, and whether it takes the clicks and keys. */
const alt = computed(() => {
  const what = live.value ? 'The page, live' : 'The page as it last showed';
  return inputTarget.value ? `${what}: clicks and keys go to it` : what;
});

const note = computed((): { icon?: string; text: string } | null => {
  if (!watched.value) return refusedLane.value ? { icon: 'i-lucide-triangle-alert', text: refusedLane.value } : null;
  if (refusedNow.value) return { icon: 'i-lucide-triangle-alert', text: refusedNow.value };
  if (current.value) return null;
  if (stop.value) return { icon: 'i-lucide-clock', text: 'Taking an image of the page…' };
  if (props.worker.state === 'between') return shown.value ? null : { text: 'The page shows as the next test starts.' };
  return shown.value ? null : { icon: 'i-lucide-clock', text: 'Starting the live view…' };
});
</script>

<template>
  <figure
    class="space-y-2"
    :data-picking="picking || undefined"
    :data-watching="watched || undefined"
    data-shot="desktop-run-lane"
  >
    <div class="flex flex-wrap gap-1.5">
      <UButton
        data-focus="page:watch"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-eye"
        :aria-pressed="watched"
        :class="watched ? PRESSED_TOGGLE_CLASS : ''"
        :title="
          watched
            ? 'Stop showing the page of this worker'
            : 'Show the page as the test runs, and at each stop, through its next tests, until you turn it off'
        "
        @click="toggle"
      >
        Watch
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
        @click="interact = !interact"
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
      ref="liveImage"
      v-model:picking="picking"
      :alt="alt"
      :input="inputTarget"
      :dimmed="!live"
      :mark="live ? 'Live' : stop ? null : 'Running…'"
      @pick="pickAt"
      @said="emit('said', $event, {})"
      @leave="leave"
    />
    <p v-if="note" class="flex items-center gap-1.5 text-xs text-muted">
      <UIcon v-if="note.icon" :name="note.icon" class="size-3.5 shrink-0" />
      {{ note.text }}
    </p>
  </figure>
</template>

<script setup lang="ts">
/**
 * Desktop shell only: a worker's lane in the Local runs tray, where its reporter shows it while its test runs
 * (`watch`). **Watch** shows the page of the lane's running test as it paints, and of each stop it comes to, through
 * its tests and the workers Playwright starts in it, until it is turned off or the run ends (the run page's **Watch**
 * and **Pause and watch** turn it on too, through `useDesktopRunHub`). The frames are drawn into one image
 * (`DesktopRunLiveImage`), which keeps the last one across a Step, a Resume and between two tests, dimmed and marked
 * as running, until the next. At a stop, the image of the stopped page shows at once, and the stop takes the clicks,
 * the keys and **Pick on the image** on the image as it does on a stop watched live: the window watches the stop
 * through the lane.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { isViewFrameData } from '@piwitests/core/run-view';
import type { DesktopLaneFrame, DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import {
  desktopLaneFrameCurrent,
  desktopLaneKey,
  desktopRunStop,
  desktopStopTakes,
  isDesktopRunImage,
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

const runRef = computed(() => props.session.ref);
const lane = computed(() => props.worker.parallelIndex);
const watched = computed(() => hub.watchesLane(runRef.value, lane.value));
/** Why the hub would not show the lane, the last time the window asked. */
const refusedLane = computed(() => hub.state.laneRefusals[desktopLaneKey(runRef.value, lane.value)] ?? null);
const stop = computed(() => desktopRunStop(props.worker));
const takes = computed(() => (stop.value ? desktopStopTakes(props.worker, stop.value) : []));

// ── The frames ────────────────────────────────────────────────────────────────────────────────────────────────────

const liveImage = useTemplateRef<DesktopLiveImageHandle>('liveImage');
/** Where the image shown stands: the worker that sent it, its test and its stop. */
const shown = ref<DesktopLaneAt | null>(null);
/** Why the lane sends no frame now, where it stood as it said so. */
const refused = ref<(DesktopLaneAt & { text: string }) | null>(null);
/** The image shows the page as it is now: the stop the worker stands at, else the test it runs. */
const current = computed(() => !!shown.value && desktopLaneFrameCurrent(shown.value, props.worker));
/** Pick on the image is on: the next click on it names the element under the pointer. */
const picking = ref(false);
let unlisten: (() => void) | null = null;
/** The stop whose image was asked last. */
let askedAt: string | null = null;
/** Why the stop's image did not come, for the stop it was asked at. */
const stillRefused = ref<{ since: string; text: string } | null>(null);

function heard(frame: DesktopLaneFrame): void {
  const at: DesktopLaneAt = { worker: frame.worker, test: frame.test, since: frame.since };
  if ('refused' in frame) {
    refused.value = { ...at, text: frame.refused };
    return;
  }
  if (!isViewFrameData(frame.data)) return;
  liveImage.value?.draw(frame, () => {
    shown.value = at;
    refused.value = null;
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
  askedAt = null;
  picking.value = false;
  liveImage.value?.clear();
}

onMounted(() => listen(watched.value));
watch(watched, listen);
onBeforeUnmount(() => {
  unlisten?.();
  unlisten = null;
});

/**
 * The image of a stopped page, asked once per stop: it shows until a frame of the stop comes, as a page that does not
 * paint sends none.
 */
async function askStill(since: string): Promise<void> {
  askedAt = since;
  const { worker } = props.worker;
  const test = props.worker.test?.id ?? null;
  const answer = await hub.command({ type: 'pausedPage', ref: runRef.value, worker });
  const image = answer.ok ? answer.image : null;
  if (!image || image.mime !== 'image/jpeg' || !isDesktopRunImage(image.data) || !image.width || !image.height) {
    stillRefused.value = { since, text: answer.ok ? 'The test has no image of this page.' : answer.message };
    return;
  }
  if (!watched.value || stop.value?.since !== since || shown.value?.since === since) return;
  liveImage.value?.draw({ width: image.width, height: image.height, data: image.data }, () => {
    if (shown.value?.since !== since) shown.value = { worker, test, since };
  });
}

// ── At a stop ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where the clicks and keys on the image go: the stop it shows, while it takes them. */
const inputTarget = computed(() => {
  const at = stop.value;
  return at && current.value && takes.value.includes('input')
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

watch(
  () => [watched.value, stop.value?.since ?? null] as const,
  ([on, since]) => {
    if (on && since && askedAt !== since && shown.value?.since !== since) void askStill(since);
  },
  { immediate: true },
);
watch(pickable, (can) => {
  if (!can) picking.value = false;
});

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && picking.value) picking.value = false;
}

onMounted(() => document.addEventListener('keydown', onEscape));
onBeforeUnmount(() => document.removeEventListener('keydown', onEscape));

// ── Watch ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const watchButton = ref<{ $el: HTMLElement } | null>(null);

function toggle(): void {
  void hub.setLaneWatch(runRef.value, lane.value, !watched.value);
}

const alt = computed(() =>
  inputTarget.value
    ? 'The page, live: clicks and keys go to it'
    : current.value
      ? 'The page, live'
      : 'The page as it last showed',
);

const note = computed((): { icon?: string; text: string } | null => {
  if (!watched.value) return refusedLane.value ? { icon: 'i-lucide-triangle-alert', text: refusedLane.value } : null;
  const why = refused.value && desktopLaneFrameCurrent(refused.value, props.worker) ? refused.value.text : null;
  if (why) return { icon: 'i-lucide-triangle-alert', text: why };
  if (current.value) return null;
  if (stop.value && stillRefused.value?.since === stop.value.since) return { text: stillRefused.value.text };
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
        ref="watchButton"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-eye"
        :aria-pressed="watched"
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
      ref="liveImage"
      v-model:picking="picking"
      :alt="alt"
      :input="inputTarget"
      :dimmed="!current"
      :mark="current ? 'Live' : stop ? null : 'Running…'"
      @pick="pickAt"
      @said="emit('said', $event, {})"
      @leave="watchButton?.$el?.focus()"
    />
    <p v-if="note" class="flex items-center gap-1.5 text-xs text-muted">
      <UIcon v-if="note.icon" :name="note.icon" class="size-3.5 shrink-0" />
      {{ note.text }}
    </p>
  </figure>
</template>

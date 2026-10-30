<script setup lang="ts">
/**
 * The live view of one worker of a running run, for the test of the row it was opened from: the images of its page
 * the worker sends while this view is open, a few a second, each with the call it was taken at. In a CI run, the
 * worker also sends the call its test is in as Playwright logs it: the log's last lines under the image, how long the
 * call has run and the elements its locator matches beside it, and over the image the first one outlined and the point
 * an input action acts on. Watching only: nothing here reaches the test. The view ends as its test ends (the worker
 * says so, or an image or a call log of its next test comes), the worker leaves, the run ends or the project turns its
 * live view off, and as it closes. Nothing is kept: the latest image and call log alone are in this page's memory, until the
 * view closes.
 */
import {
  LIVE_VIEW_END_TEXT,
  liveWorkerName,
  parseLiveViewerMessage,
  type LiveCall,
  type LiveCallLog,
} from '#shared/live-view';

const props = defineProps<{
  runId: number;
  worker: number;
  shard: number | null;
  /** The title of the test whose row the view was opened from. */
  test: string;
  /** Piwi project id + name, for the IDE opener of each call's place. */
  projectKey?: string | number | null;
  projectName?: string | null;
}>();
const open = defineModel<boolean>('open', { required: true });

const WAITING = 'Waiting for the first image of the page…';
const UNAVAILABLE =
  'This worker’s live view is not available now: its test may have ended, or as many people as a run allows watch it.';

const image = ref<string | null>(null);
const call = ref<LiveCall | null>(null);
/** The call log the worker sent last, and when it came, which its time running counts on from. */
const log = ref<LiveCallLog | null>(null);
const logAt = ref(0);
/** When the call log's call was first told ended, and when the last image named its call. */
const endedAt = ref(0);
const callAt = ref(0);
const now = ref(Date.now());
const notice = ref(WAITING);
const ended = ref(false);
let source: EventSource | null = null;

const baseURL = useRuntimeConfig().app.baseURL;

function connect(): void {
  disconnect();
  image.value = null;
  call.value = null;
  log.value = null;
  endedAt.value = 0;
  callAt.value = 0;
  notice.value = WAITING;
  ended.value = false;
  const query = new URLSearchParams({ worker: String(props.worker) });
  if (props.shard !== null) query.set('shard', String(props.shard));
  source = new EventSource(`${baseURL.replace(/\/$/, '')}/api/test-runs/${props.runId}/live-view/watch?${query}`);
  source.onmessage = (event) => {
    const message = parseLiveViewerMessage(String(event.data));
    if (!message) return;
    if (message.type === 'frame') {
      // The worker went on to its next test: the one watched ended.
      if (message.test !== null && message.test !== props.test) return end(LIVE_VIEW_END_TEXT['test-ended']);
      image.value = `data:image/jpeg;base64,${message.data}`;
      call.value = message.call;
      callAt.value = Date.now();
      notice.value = '';
    } else if (message.type === 'call-log') {
      if (message.test !== null && message.test !== props.test) return end(LIVE_VIEW_END_TEXT['test-ended']);
      const before = log.value;
      log.value = message.log;
      logAt.value = Date.now();
      now.value = logAt.value;
      if (message.log.status !== 'running' && (before?.id !== message.log.id || before.status === 'running')) {
        endedAt.value = logAt.value;
      }
    } else if (message.type === 'refused') {
      notice.value = message.message;
    } else {
      end(LIVE_VIEW_END_TEXT[message.reason]);
    }
  };
  source.onerror = () => {
    // A stream the instance refused, or one that cannot open again, is closed for good.
    if (source?.readyState === EventSource.CLOSED) end(image.value ? LIVE_VIEW_END_TEXT['worker-left'] : UNAVAILABLE);
  };
}

function end(why: string): void {
  ended.value = true;
  notice.value = why;
  disconnect();
}

function disconnect(): void {
  source?.close();
  source = null;
}

// The time a running call has run, counted on between two call logs, while the view is open.
let clock: ReturnType<typeof setInterval> | null = null;
function stopClock(): void {
  if (clock) clearInterval(clock);
  clock = null;
}

watch(
  open,
  (isOpen) => {
    if (!import.meta.client) return;
    if (isOpen) {
      connect();
      clock ??= setInterval(() => {
        if (log.value?.status === 'running' && !ended.value) now.value = Date.now();
      }, 500);
    } else {
      disconnect();
      stopClock();
      image.value = null;
      log.value = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disconnect();
  stopClock();
});

/**
 * Whether an image's call is the call log's: the same place in the code, or for a call placed nowhere, a title the
 * log's begins with (the runner titles a call without its locator).
 */
function sameCall(framed: LiveCall, logged: LiveCall): boolean {
  if (framed.file && logged.file) return framed.file === logged.file && framed.line === logged.line;
  return logged.title.startsWith(framed.title);
}
/**
 * The call log while it is of the call the test is in: running, or ended with no image since naming another call (a
 * step of the test's own, an assertion of the runner's, between two calls). A page that does not change sends no
 * image, so the last one may be older than the call.
 */
const currentLog = computed(() => {
  const shown = log.value;
  if (!shown || shown.status === 'running' || !call.value || callAt.value <= endedAt.value) return shown;
  return sameCall(call.value, shown.call) ? shown : null;
});
/** The call shown: the call log's, fresher than an image's, else the image's. */
const shownCall = computed(() => currentLog.value?.call ?? call.value);
/** How long the running call has run, counted on between two call logs, or how long the call that ended took. */
const callMs = computed(() => {
  const shown = currentLog.value;
  if (!shown) return 0;
  return shown.status === 'running' ? shown.ms + Math.max(0, now.value - logAt.value) : shown.ms;
});
/** What the running call's locator matches, said when it explains a wait. */
const targetText = computed(() => {
  const target = currentLog.value?.status === 'running' ? currentLog.value.target : null;
  if (!target) return '';
  if (target.count === 0) return 'No element matches its locator yet';
  if (target.count > 1) return `${target.count} elements match its locator`;
  return target.enabled === false ? 'Its element is not enabled' : '';
});
const logLines = computed(() => (currentLog.value?.lines ?? []).join('\n'));
/**
 * The log's box follows its last line as each call log comes: from a call's start, until the reader scrolls up in it,
 * and again once they scroll back to its end.
 */
const logBox = ref<HTMLElement | null>(null);
let followLog = true;
function onLogScroll(): void {
  const box = logBox.value;
  if (box) followLog = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
}
watch(currentLog, async (shown, before) => {
  if (shown?.id !== before?.id) followLog = true;
  await nextTick();
  if (followLog && logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
});
/**
 * The overlay's drawing, in the page's viewport pixels: the part of the waiting call's element the image shows, and
 * where an input acts, when the image shows it.
 */
const overlay = computed(() => {
  const shown = currentLog.value;
  if (!shown?.viewport || ended.value) return null;
  const { width, height } = shown.viewport;
  const target = shown.status === 'running' ? (shown.target?.box ?? null) : null;
  let box: { x: number; y: number; width: number; height: number } | null = null;
  if (target) {
    const x = Math.max(0, target.x);
    const y = Math.max(0, target.y);
    const right = Math.min(width, target.x + target.width);
    const bottom = Math.min(height, target.y + target.height);
    if (right > x && bottom > y) box = { x, y, width: right - x, height: bottom - y };
  }
  const at = shown.point;
  const point = at && at.x >= 0 && at.x <= width && at.y >= 0 && at.y <= height ? at : null;
  return { viewport: shown.viewport, box, point, radius: Math.max(6, width / 120) };
});

const name = computed(() => liveWorkerName({ shard: props.shard, worker: props.worker }));
const title = computed(() => `${name.value.charAt(0).toUpperCase()}${name.value.slice(1)} · live`);
const alt = computed(
  () => `The page ${name.value} is on${shownCall.value ? `, at ${shownCall.value.title}` : ''}, as the test sees it`,
);
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="test" :ui="{ content: 'sm:max-w-3xl' }">
    <template #body>
      <figure class="space-y-2" data-testid="live-view">
        <div class="relative aspect-[16/10] w-full overflow-hidden rounded-md border border-default bg-elevated">
          <img
            v-if="image"
            :src="image"
            :alt="alt"
            class="size-full object-contain"
            :class="ended ? 'opacity-40' : ''"
            data-testid="live-frame"
          />
          <svg
            v-if="image && overlay"
            class="pointer-events-none absolute inset-0 size-full"
            :viewBox="`0 0 ${overlay.viewport.width} ${overlay.viewport.height}`"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            data-testid="live-overlay"
          >
            <rect
              v-if="overlay.box"
              :x="overlay.box.x - 3"
              :y="overlay.box.y - 3"
              :width="overlay.box.width + 6"
              :height="overlay.box.height + 6"
              rx="4"
              fill="none"
              stroke="var(--ui-warning)"
              stroke-width="3"
              stroke-dasharray="8 5"
              data-testid="live-target-box"
            />
            <circle
              v-if="overlay.point"
              :cx="overlay.point.x"
              :cy="overlay.point.y"
              :r="overlay.radius"
              fill="color-mix(in srgb, var(--ui-error) 35%, transparent)"
              stroke="var(--ui-error)"
              stroke-width="2"
              data-testid="live-point"
            />
          </svg>
          <!-- Always in the page, empty while images show, so a screen reader announces each change. -->
          <p
            role="status"
            aria-live="polite"
            class="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-highlighted"
            data-testid="live-status"
          >
            {{ notice }}
          </p>
        </div>
        <figcaption class="min-h-4 text-xs text-muted" data-testid="live-call">
          <template v-if="shownCall">
            At <span class="font-mono">{{ shownCall.title }}</span
            ><template v-if="shownCall.file">
              ·
              <OpenInIdeLink
                :file-path="shownCall.file"
                :line="shownCall.line"
                :project-key="projectKey"
                :project-name="projectName"
                inline
            /></template>
          </template>
        </figcaption>
        <template v-if="currentLog">
          <p v-if="!ended" class="text-xs text-muted" data-testid="live-call-state">
            <template v-if="currentLog.status === 'running'">Running for {{ formatLongDuration(callMs) }}</template>
            <template v-else
              >{{ currentLog.status === 'failed' ? 'Failed after' : 'Done in' }} <DurationValue :ms="callMs"
            /></template>
            <template v-if="targetText">
              · <span data-testid="live-call-target">{{ targetText }}</span></template
            >
          </p>
          <ErrorText
            v-if="!ended && currentLog.error"
            :text="currentLog.error"
            mode="block"
            data-testid="live-call-error"
          />
          <pre
            v-if="logLines"
            ref="logBox"
            role="region"
            tabindex="0"
            class="max-h-48 overflow-auto sm:max-h-72 rounded-md border border-default bg-elevated px-3 py-2 font-mono text-xs text-highlighted whitespace-pre-wrap"
            aria-label="The call's log, as Playwright writes it"
            @scroll="onLogScroll"
            data-testid="live-call-log"
            >{{ logLines }}</pre>
        </template>
      </figure>
      <p class="mt-3 text-xs text-muted">
        You watch the page; nothing you do here reaches the test. The images are not stored: the run’s trace keeps the
        record.
      </p>
    </template>
  </UModal>
</template>

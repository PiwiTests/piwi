<script setup lang="ts">
/**
 * The live view of one worker of a running run, docked beside the run page (a sheet on a phone), from the test of the
 * row it was opened from: the images of its page the worker sends while this view is open, a few a second, each with
 * the call it was taken at, at the size this view shows them in device pixels (1280 by 800 at most), on the page's one
 * watch of the run (`useLiveWatch`), which **Watch all** shares; it opens on the worker's latest tile when it came
 * within `TILE_OPEN_MS`. The worker also sends the call its test is in as Playwright logs it (in a CI run from its call
 * stream, in a shared run from its in-process instrumentation, the call alone for a browser it connected to): the
 * log's last lines beside the image, how long the call has run and the elements its locator matches, and over the
 * image the first one outlined and the point an input action acts on; **Zoom to the element** crops the image around
 * that element, a click on the image zooms where it points.
 *
 * Under the image, the layers the view asks of the worker while it shows them (`@piwitests/core/live-layers`): the
 * test's filmstrip, one image per call that ended, the whole strip coming to a view that opens late, a click showing
 * one larger; the page's events, newest first (console errors, uncaught errors, failed, pending and API requests, what
 * the backend logged under its request); and, opened, the page's text as roles and names, masked by the worker,
 * searched with case and accents ignored, the lines naming the element the shown call targets marked; and, opened,
 * **Inspect** (`LaneInspect`): the page at each call as a document, the worker sending its snapshots while it is open.
 * Each is of the test the view shows, and let go with it; Inspect's of the lane's next test, sent before its first
 * image, wait for the view to move on to it. Watching only: nothing here reaches the test.
 *
 * A view opened with no test (by its address, a tile with no running row, a move) takes the first it hears. A view of
 * a worker that says its lane (`slot`) follows the lane: it says how each test ended, keeps the lane's earlier tests
 * listed, and goes on with the next, through the worker Playwright starts in the lane again, unless **Follow the
 * worker's next test** is off; one of an older reporter's worker ends with its test. **Follow what needs attention**
 * (`attention`, the page's) lets the page move the view to a lane whose test failed, got stuck or stopped, and the view
 * says why it moved (`movedWhy`). Another worker or row to show starts the view afresh in the same panel, which keeps
 * its full screen, its **Follow the worker's next test** and the focus. A view ends as the worker leaves, the run ends
 * (saying the run's verdict, `verdict`), the project turns its live view off, as it closes, and after
 * `HIDDEN_CLOSE_MS` in a hidden tab; one the instance refuses says why, and offers to try again. Nothing is kept: the
 * latest image and call log, and the layers of the test shown, are in this page's memory alone, until the view closes.
 */
import {
  LIVE_VIEW_END_TEXT,
  liveWorkerKey,
  liveWorkerName,
  type LiveCall,
  type LiveCallLog,
  type LiveTestOutcome,
  type LiveViewEnd,
  type LiveViewerMessage,
} from '#shared/live-view';
import { readLiveViewSize } from '@piwitests/core/live-view';
import { MAX_PAGE_EVENTS_PER_SECOND, type LaneLayer, type LaneText, type LaneThumb } from '@piwitests/core/live-layers';
import { stepLabel } from '@piwitests/core/step-analysis';
import type { LiveFocusEvent, LiveWatchHandle } from '~/composables/useLiveWatch';
import type { ApiResponse } from '~~/types/api';
import type { LiveStepInfo } from '~/utils/live-steps';
import { stepAfterFrame } from '~/utils/live-caption';
import { liveViewRefusalText } from '~/utils/live-view-refusal';
import { stallWatch, STREAM_RECONNECT_STALL_MS } from '~/utils/stream-stall';
import {
  MAX_SHOWN_EVENTS,
  addLaneEvent,
  addLaneThumb,
  emptyLaneEvents,
  laneEventLabel,
  laneEventParts,
  laneTextLines,
  laneTextMatches,
  laneTextTarget,
  laneTextTargets,
  type LaneEvents,
  type LaneTextTarget,
} from '~/utils/live-layers';
import { NO_INSPECT_HEARD, hearInspect, inspectEnd, nextInspectTest, type InspectHeard } from '~/utils/live-inspect';
import { CURRENT_ITEM_RING_CLASS } from '~/utils';

const props = defineProps<{
  runId: number;
  worker: number;
  shard: number | null;
  /** The worker's lane, from a reporter that says it: the view then follows the lane through its next tests. */
  slot?: number | null;
  /** The title of the test whose row the view was opened from, or '' when it was opened with no row. */
  test: string;
  /** The execution of that row, null for none. */
  executionId?: number | null;
  /** How the run ended, in a sentence, once the page knows it: the view says it when the run's end ends it. */
  verdict?: string | null;
  /** The step the run page last heard the worker is on, which the caption names when it began after the image. */
  step?: LiveStepInfo | null;
  /** Whether the panel takes the focus as it opens, and gives it back as it closes: when someone asked for it. */
  takeFocus?: boolean;
  /** Piwi project id + name, for the IDE opener of each call's place. */
  projectKey?: string | number | null;
  projectName?: string | null;
  /** The page's watch of the run, which carries this view's images. */
  live: LiveWatchHandle;
  /** Why **Follow what needs attention** moved the view here, while it shows that lane. */
  movedWhy?: string | null;
}>();
const open = defineModel<boolean>('open', { required: true });
/** **Follow what needs attention**: the page moves the view to a lane whose test failed, got stuck or stopped. */
const attention = defineModel<boolean>('attention', { default: false });

const WAITING = 'Waiting for the first image of the page…';
/** The oldest a worker's kept tile may be, in ms, for the view to open on it. */
const TILE_OPEN_MS = 3_000;
const STALLED =
  'The view’s connection has not opened: the instance does not answer, or, over HTTP/1.1, other Piwi tabs hold the six connections a browser opens to one address. Close some, or serve Piwi over HTTP/2.';

const image = ref<string | null>(null);
const call = ref<LiveCall | null>(null);
/** When the page looked as the image shows, from a reporter that says it: the browser's paint time, at most the worker's. */
const frameAt = ref(0);
/** The element the test waited on last, in its viewport: **Zoom to the element** keeps to it between two calls. */
const lastTarget = ref<{ box: Box; viewport: { width: number; height: number } } | null>(null);
/** How the image is zoomed: not at all, twice around a point of it (fractions of its frame), or to the element. */
const zoom = ref<{ kind: 'point'; x: number; y: number } | { kind: 'element' } | null>(null);
/** Whether the panel covers the whole window. */
const fullscreen = ref(false);
/** The call log the worker sent last, and when it came, which its time running counts on from. */
const log = ref<LiveCallLog | null>(null);
const logAt = ref(0);
/** When the call log's call was first told ended, and when the last image named its call. */
const endedAt = ref(0);
const callAt = ref(0);
const now = ref(Date.now());
const notice = ref(WAITING);
const ended = ref(false);
/** Why the view ended, when the instance said; null for a view it refused or one that is still open. */
const endReason = ref<LiveViewEnd | null>(null);
/** Whether the view ended without the instance saying why, so trying again may open it. */
const canRetry = ref(false);
/** Whether the view follows the worker's lane, which a reporter that says it lets it. */
const follows = computed(() => typeof props.slot === 'number');
/** Whether the view goes on with the lane's next test, else ends with its test. */
const followNext = ref(true);
/** The test the view shows now: the row's, then each next test of the lane. */
const watchedTest = ref(props.test);
/** How the test the view showed last ended, while the lane's next test has not begun. */
const outcome = ref<LiveTestOutcome | null>(null);
/** The view heard its test end, its lane's next test not begun: a page event of another test is of that next one. */
let testDone = false;
/** How each test the view showed ended, the latest last. */
const history = ref<Array<LiveTestOutcome & { test: string }>>([]);

/** The page's events the worker sent of the test the view shows. */
const events = shallowRef<LaneEvents>(emptyLaneEvents());
/** The page's text the worker sent last, or why it sends none; null before either. */
const pageText = shallowRef<{ text: LaneText } | { refused: string } | null>(null);
/** An image of the test's filmstrip, its object URL held by this page until the view lets it go. */
type Shot = { thumb: LaneThumb; url: string };
/** The test's filmstrip, in the order of its calls. */
const strip = shallowRef<Shot[]>([]);
/** The call whose image of the filmstrip shows larger. */
const enlarged = ref<string | null>(null);
/** Whether the page's events and its text show, and what the text is searched for, as the reader left them. */
const eventsOpen = useViewState('lane-events-open', () => true);
const textOpen = useViewState('lane-text-open', () => false);
const textQuery = useViewState('lane-text-query', () => '');
/** Whether Inspect is open, as the reader left it. */
const inspectOpen = useViewState('lane-inspect-open', () => false);
/**
 * What the worker sent for Inspect while it is open: of the test the view shows, and of the lane's next one, heard
 * after the test shown ended or naming another test.
 */
const inspectHeard = shallowRef<InspectHeard>(NO_INSPECT_HEARD);
/** Which test Inspect shows, counted: each next test, and each view started afresh, starts it afresh. */
const inspectTurn = ref(0);

/**
 * Let go of the layers of the test the view showed: the next one's come afresh, but for what Inspect heard of the
 * lane's next test ahead of it (`next`, the view moving on to that test).
 */
function forgetLayers(next = false): void {
  events.value = emptyLaneEvents();
  pageText.value = null;
  inspectHeard.value = next ? nextInspectTest(inspectHeard.value, watchedTest.value) : NO_INSPECT_HEARD;
  inspectTurn.value++;
  for (const shot of strip.value) URL.revokeObjectURL(shot.url);
  strip.value = [];
  enlarged.value = null;
}

/** Ask the worker for its page's text now, while the text shows and the view is open. */
function askText(): void {
  if (textOpen.value && !ended.value) props.live.askText();
}
/**
 * The view goes on with `test`: the first it hears when it has none, else the lane's next one when it follows the
 * lane; false when it does not.
 */
function nextTest(test: string): boolean {
  if (watchedTest.value && (!follows.value || !followNext.value)) return false;
  const before = watchedTest.value;
  watchedTest.value = test;
  outcome.value = null;
  testDone = false;
  log.value = null;
  lastTarget.value = null;
  // A view that heard of no test yet keeps the layers that came before its first image: they are of this one.
  if (before) {
    forgetLayers(true);
    askText();
  }
  return true;
}
/** What stops this view's hold on the page's watch. */
let off: (() => void) | null = null;
let viewOpen = false;
/** Whether the watch opened since this view connected: a view refused then had shown its worker. */
let opened = false;
/** Says so when the view's stream has not been open for a while, through its reconnections. */
const streamStall = stallWatch(
  () => viewOpen,
  () => {
    if (off) notice.value = STALLED;
  },
);

/** Show `bytes` as the view's image, the image shown before it let go. */
function showImage(bytes: Uint8Array | null): void {
  if (image.value) URL.revokeObjectURL(image.value);
  image.value = bytes
    ? URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
    : null;
}

function connect(): void {
  disconnect();
  testDone = false;
  showImage(null);
  call.value = null;
  log.value = null;
  endedAt.value = 0;
  callAt.value = 0;
  notice.value = WAITING;
  ended.value = false;
  endReason.value = null;
  canRetry.value = false;
  frameAt.value = 0;
  lastTarget.value = null;
  zoom.value = null;
  forgetLayers();
  const worker = { shard: props.shard, worker: props.worker, ...(follows.value ? { slot: props.slot! } : {}) };
  // The worker's latest tile, a few seconds old at most, shows while its first full image comes: of the view's test, or
  // of the one the view goes on with.
  const tile = props.live.latest(worker);
  if (
    tile?.image &&
    tile.receivedAt !== null &&
    Date.now() - tile.receivedAt <= TILE_OPEN_MS &&
    (!tile.test || tile.test === watchedTest.value || nextTest(tile.test))
  ) {
    showImage(tile.image);
    call.value = tile.call;
    notice.value = '';
  }
  viewOpen = false;
  opened = false;
  off = props.live.show(worker, hear);
  askText();
  viewOpen = props.live.state.value.kind === 'open';
  if (viewOpen) opened = true;
  else streamStall.arm();
}

/** What the page's watch says to this view. */
function hear(event: LiveFocusEvent): void {
  if (ended.value) return;
  if (event.kind === 'refused') return refused();
  if (event.kind === 'message') return onMessage(event.message);
  const state = event.state;
  if (state.kind === 'open') {
    viewOpen = true;
    opened = true;
    streamStall.disarm();
    if (notice.value === STALLED) notice.value = image.value ? '' : WAITING;
  } else if (state.kind === 'connecting') {
    viewOpen = false;
    streamStall.arm(state.again ? STREAM_RECONNECT_STALL_MS : undefined);
  } else if (state.kind === 'closed') {
    viewOpen = false;
    if (state.reason) end(LIVE_VIEW_END_TEXT[state.reason], state.reason);
    else refused();
  }
}

/** The instance would not show this view, or its watch gave up: the view says why, and offers to try again. */
function refused(): void {
  const hadImage = !!image.value;
  end(hadImage && opened ? LIVE_VIEW_END_TEXT['worker-left'] : 'Asking the instance why the view did not open…');
  canRetry.value = true;
  void whyRefused(hadImage).then((why) => {
    if (ended.value && !endReason.value) notice.value = why;
  });
}

function onMessage(message: LiveViewerMessage): void {
  if (message.type === 'frame') {
    // The worker went on to its next test: a view of its lane goes on with it, a view of one test ends.
    if (message.test !== null && message.test !== watchedTest.value && !nextTest(message.test)) {
      return end(LIVE_VIEW_END_TEXT['test-ended'], 'test-ended');
    }
    // A frame after the test ended is of the lane's next test, of the same title: a retry starts afresh.
    if (testDone && follows.value) {
      outcome.value = null;
      testDone = false;
      log.value = null;
      lastTarget.value = null;
      if (zoom.value?.kind === 'element') zoom.value = null;
      forgetLayers(true);
      askText();
    }
    showImage(message.image);
    call.value = message.call;
    frameAt.value = message.at ?? 0;
    callAt.value = Date.now();
    notice.value = '';
  } else if (message.type === 'call-log') {
    if (message.test !== null && message.test !== watchedTest.value && !nextTest(message.test)) {
      return end(LIVE_VIEW_END_TEXT['test-ended'], 'test-ended');
    }
    const before = log.value;
    log.value = message.log;
    logAt.value = Date.now();
    now.value = logAt.value;
    if (message.log.status !== 'running' && (before?.id !== message.log.id || before.status === 'running')) {
      endedAt.value = logAt.value;
    }
  } else if (message.type === 'snapshot') {
    // Inspect's of the lane's next test (heard after the test shown ended, or naming another test) wait for the view
    // to move on to it: a test's refusal comes before its first image.
    const ofNext = testDone || (message.test !== null && !!watchedTest.value && message.test !== watchedTest.value);
    inspectHeard.value = hearInspect(inspectHeard.value, message, ofNext ? 'next' : 'shown');
  } else if (message.type === 'page-event' || message.type === 'text' || message.type === 'thumb') {
    // A layer of a test the view does not show (the lane's last, sent late; its next, before its first image) goes,
    // but a page event of the lane's next test once the view's test ended moves the view on to it, as a call log
    // does: a test with no page sends no image.
    if (message.test !== null && watchedTest.value && message.test !== watchedTest.value) {
      if (message.type !== 'page-event' || !testDone || !nextTest(message.test)) return;
    }
    if (message.type === 'page-event') events.value = addLaneEvent(events.value, message.event, message.at);
    else if (message.type === 'text')
      pageText.value = 'refused' in message ? { refused: message.refused } : { text: message.text };
    else keepShot(message.thumb, message.image);
  } else if (message.type === 'refused') {
    notice.value = message.message;
  } else if (message.type === 'test-ended') {
    showOutcome(message.outcome);
    testDone = true;
    // Not following the lane: the view ends with its test.
    if (!followNext.value) end(LIVE_VIEW_END_TEXT['test-ended'], 'test-ended');
  } else if (message.type === 'end') {
    if (message.outcome) showOutcome(message.outcome);
    end(LIVE_VIEW_END_TEXT[message.reason], message.reason);
  }
}

/** Keep an image of the test's filmstrip, in its call's place; one of a call the strip holds goes. */
function keepShot(thumb: LaneThumb, image: Uint8Array): void {
  if (strip.value.some((shot) => shot.thumb.call === thumb.call)) return;
  const url = URL.createObjectURL(new Blob([image as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
  const kept = addLaneThumb(strip.value, { thumb, url });
  for (const shot of kept.letGo) URL.revokeObjectURL(shot.url);
  strip.value = kept.strip;
  if (enlarged.value && !kept.strip.some((shot) => shot.thumb.call === enlarged.value)) enlarged.value = null;
}

function showOutcome(shown: LiveTestOutcome | null): void {
  outcome.value = shown;
  if (shown) history.value = [...history.value, { ...shown, test: shown.test ?? watchedTest.value }].slice(-6);
}

function end(why: string, reason: LiveViewEnd | null = null): void {
  ended.value = true;
  endReason.value = reason;
  notice.value = why;
  disconnect();
}

function disconnect(): void {
  streamStall.disarm();
  off?.();
  off = null;
}

/** Why the instance closed the view's stream, from what its workers' endpoint says of the run's live view. */
async function whyRefused(hadImage: boolean): Promise<string> {
  const view = { shard: props.shard, worker: props.worker, slot: props.slot, name: name.value, hadImage };
  try {
    const state = await $fetch<
      ApiResponse<typeof import('~~/server/api/test-runs/[id]/live-view/workers.get').default>
    >(`/api/test-runs/${props.runId}/live-view/workers`);
    return liveViewRefusalText(state, view);
  } catch (error) {
    return liveViewRefusalText({ status: (error as { statusCode?: number }).statusCode ?? null }, view);
  }
}

// The time a running call has run, counted on between two call logs, while the view is open.
let clock: ReturnType<typeof setInterval> | null = null;
function stopClock(): void {
  if (clock) clearInterval(clock);
  clock = null;
}

/**
 * The layers the panel shows beside the image, which the watch asks of the worker while it shows it in full: the
 * filmstrip always, the events and the text while they are open. The text opened is asked for now.
 */
const layersShown = computed<LaneLayer[]>(() => [
  ...(eventsOpen.value ? (['events'] as const) : []),
  ...(textOpen.value ? (['text'] as const) : []),
  'filmstrip',
]);
watch(
  layersShown,
  (shown, before) => {
    props.live.showLayers(shown);
    if (shown.includes('text') && before && !before.includes('text')) askText();
  },
  { immediate: true },
);
// The worker sends its page's snapshots while Inspect is open in an open panel.
watch([inspectOpen, open], ([on, isOpen]) => props.live.showInspect(on && isOpen), { immediate: true });

/** The worker the view shows and the row it was opened from: another starts the view afresh. */
const target = computed(
  () => `${liveWorkerKey({ shard: props.shard, worker: props.worker })}:${props.executionId ?? ''}`,
);
watch(
  [open, target],
  ([isOpen, shown], before) => {
    if (!import.meta.client) return;
    if (before[1] !== undefined && shown !== before[1]) {
      watchedTest.value = props.test;
      outcome.value = null;
      history.value = [];
    }
    if (isOpen) {
      connect();
      clock ??= setInterval(() => {
        if (log.value?.status === 'running' && !ended.value) now.value = Date.now();
      }, 500);
    } else {
      disconnect();
      stopClock();
      showImage(null);
      log.value = null;
      forgetLayers();
      fullscreen.value = false;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  props.live.showInspect(false);
  disconnect();
  stopClock();
  showImage(null);
  forgetLayers();
  if (hiddenTimer) clearTimeout(hiddenTimer);
  if (textTimer) clearTimeout(textTimer);
});

// Following stopped while the view waits for the lane's next test: it ends now.
watch(followNext, (on) => {
  if (!on && outcome.value && !ended.value) end(LIVE_VIEW_END_TEXT['test-ended'], 'test-ended');
});

/** How long a view stays open in a hidden tab, which would otherwise keep its worker sending images all run. */
const HIDDEN_CLOSE_MS = 10 * 60_000;
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
const visibility = useDocumentVisibility();
watch(visibility, (state) => {
  if (hiddenTimer) clearTimeout(hiddenTimer);
  hiddenTimer = null;
  if (state !== 'hidden' || ended.value) return;
  hiddenTimer = setTimeout(() => {
    hiddenTimer = null;
    if (ended.value) return;
    end('The view closed after 10 minutes in a hidden tab.');
    canRetry.value = true;
  }, HIDDEN_CLOSE_MS);
});

/**
 * Whether an image's call is the call log's: the same place in the code, or for a call placed nowhere, a title the
 * log's begins with (an older reporter titles an image's call without its locator).
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
/** The worker's step, when it began after the image was taken: a page that does not change sends no image. */
const laterStep = computed(() => stepAfterFrame(props.step, frameAt.value, watchedTest.value));
/** The call shown: the call log's, fresher than an image's, else the step that began after the image, else its call. */
const shownCall = computed<LiveCall | null>(
  () =>
    currentLog.value?.call ??
    (laterStep.value ? { title: stepLabel(laterStep.value), file: null, line: null } : call.value),
);
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
/** The failed call's error, kept with the test's outcome once the view ended on it. */
const callError = computed(() => (!ended.value || outcome.value ? (currentLog.value?.error ?? '') : ''));
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

/** How long the page's text may take to come before the view says it has not. */
const TEXT_LATE_MS = 10_000;
/** Whether the text was asked `TEXT_LATE_MS` ago and has not come. */
const textLate = ref(false);
let textTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  [textOpen, pageText, ended],
  ([on, text, done]) => {
    if (textTimer) clearTimeout(textTimer);
    textTimer = null;
    textLate.value = false;
    if (on && !text && !done && import.meta.client) {
      textTimer = setTimeout(() => (textLate.value = true), TEXT_LATE_MS);
    }
  },
  { immediate: true },
);
/** The page's text line by line, folded for search once per text. */
const textLines = computed(() =>
  pageText.value && 'text' in pageText.value ? laneTextLines(pageText.value.text.text) : [],
);
/** The element the shown call targets, as its text names it, in words: a call to the same element changes nothing. */
const textTarget = computed(() => JSON.stringify(laneTextTarget(shownCall.value?.title)));
/** The lines of the text naming the element the shown call targets. */
const targetLines = computed(
  () => new Set(laneTextTargets(textLines.value, JSON.parse(textTarget.value) as LaneTextTarget | null)),
);
/** What the search finds in the text: each line's ranges, and how many. */
const textFound = computed(() => laneTextMatches(textLines.value, textQuery.value));
/** Where the text came from, and after which call when the filmstrip names it. */
const textSource = computed(() => {
  const shown = pageText.value && 'text' in pageText.value ? pageText.value.text : null;
  if (!shown) return '';
  const after = shown.call ? strip.value.find((shot) => shot.thumb.call === shown.call)?.thumb.title : null;
  const from =
    shown.source === 'trace'
      ? `From the test’s trace${after ? `, after ${after}` : ''}`
      : 'Read from the page as you asked';
  return shown.cut ? `${from}, cut at its first 96 K characters` : from;
});
/** The filmstrip shows its latest image as one comes, unless one shows larger. */
const stripBox = ref<HTMLElement | null>(null);
watch(strip, async () => {
  await nextTick();
  if (stripBox.value && !enlarged.value) stripBox.value.scrollLeft = stripBox.value.scrollWidth;
});
const enlargedShot = computed(() => strip.value.find((shot) => shot.thumb.call === enlarged.value) ?? null);
/** The page's events as the list shows them: each with its words. */
const eventRows = computed(() =>
  events.value.shown.map((line) => ({
    ...line,
    label: laneEventLabel(line.event),
    parts: laneEventParts(line.event),
    request: 'method' in line.event,
  })),
);
/** What the events list does not show: those the worker left out, and older ones it let go. */
const eventsLeftOut = computed(() => {
  const { dropped, letGo } = events.value;
  const said: string[] = [];
  if (dropped) said.push(`${dropped} more not sent: a worker sends ${MAX_PAGE_EVENTS_PER_SECOND} a second at most`);
  if (letGo) said.push(`${letGo} older ones let go: the list keeps the latest ${MAX_SHOWN_EVENTS}`);
  return said.join('. ');
});
/** What the text says while none shows. */
const textWaiting = computed(() => {
  if (ended.value) return 'The view ended before the page’s text came.';
  if (textLate.value) return 'No text came: the worker’s reporter may not send it, or its page did not answer.';
  return 'Reading the page’s text…';
});

type Box = { x: number; y: number; width: number; height: number };
/**
 * The overlay's drawing, in the page's viewport pixels: the part of the waiting call's element the image shows, and
 * where an input acts, when the image shows it.
 */
const overlay = computed(() => {
  const shown = currentLog.value;
  if (!shown?.viewport || ended.value) return null;
  const { width, height } = shown.viewport;
  const target = shown.status === 'running' ? (shown.target?.box ?? null) : null;
  let box: Box | null = null;
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
watch(overlay, (drawn) => {
  if (drawn?.box) lastTarget.value = { box: drawn.box, viewport: drawn.viewport };
});

const frameBox = ref<HTMLElement | null>(null);
const { width: frameWidth, height: frameHeight } = useElementSize(frameBox);
// The worker sends its images at the size this view shows them, in device pixels, once the view settles.
watchDebounced(
  [frameWidth, frameHeight],
  ([width, height]) => {
    if (!open.value || !width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    const size = readLiveViewSize(Math.round(width * ratio), Math.round(height * ratio));
    if (size) props.live.resize(size);
  },
  { debounce: 400 },
);
/** The image's zoom as a CSS transform of what it draws, the overlay included. */
const zoomStyle = computed(() => {
  const shown = zoom.value;
  if (!shown) return undefined;
  if (shown.kind === 'point') return { transformOrigin: `${shown.x * 100}% ${shown.y * 100}%`, transform: 'scale(2)' };
  const target = lastTarget.value;
  const width = frameWidth.value;
  const height = frameHeight.value;
  if (!target || !width || !height) return undefined;
  // The image fits the frame as `object-contain` draws it; the element, padded, fills the frame up to four times.
  const fit = Math.min(width / target.viewport.width, height / target.viewport.height);
  const left = (width - target.viewport.width * fit) / 2 + target.box.x * fit;
  const top = (height - target.viewport.height * fit) / 2 + target.box.y * fit;
  const pad = 24;
  const scale = Math.max(
    1,
    Math.min(4, width / (target.box.width * fit + pad * 2), height / (target.box.height * fit + pad * 2)),
  );
  const x = Math.min(0, Math.max(width - width * scale, width / 2 - (left + (target.box.width * fit) / 2) * scale));
  const y = Math.min(0, Math.max(height - height * scale, height / 2 - (top + (target.box.height * fit) / 2) * scale));
  return { transformOrigin: '0 0', transform: `translate(${x}px, ${y}px) scale(${scale})` };
});
/** A click on the image zooms twice where it points, and a click on a zoomed image shows it whole. */
function zoomAt(event: MouseEvent): void {
  if (zoom.value) {
    zoom.value = null;
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  zoom.value = {
    kind: 'point',
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}
function toggleElementZoom(): void {
  zoom.value = zoom.value?.kind === 'element' ? null : { kind: 'element' };
}
watch(lastTarget, (target) => {
  if (!target && zoom.value?.kind === 'element') zoom.value = null;
});

/** The docked panel's width, in rem: what it starts at and the range a drag keeps it in. */
const LANE_PANEL_WIDTH = { min: 20, initial: 32, max: 72 } as const;
/** From 1024 px up the panel docks beside the page, at most half its room; below, it is a sheet over it. */
const docked = useMediaQuery('(min-width: 1024px)');
const width = useLocalStorage<number>('piwi-lane-panel-width', LANE_PANEL_WIDTH.initial, { initOnMounted: true });
const { shown: dockedWidth, maxWidth } = useDockedPanelWidth(width, LANE_PANEL_WIDTH);
/**
 * The docked panel opened from a row's Watch takes the focus, so the keyboard reaches it and Escape closes it, and
 * gives it back to what held it as it closes.
 */
const aside = useTemplateRef<HTMLElement>('aside');
let focusedBefore: HTMLElement | null = null;
function focusPanel(panel: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && !panel.contains(active)) focusedBefore = active;
  panel.focus({ preventScroll: true });
}
watch(aside, (panel) => {
  if (panel && props.takeFocus) focusPanel(panel);
  else if (!panel && focusedBefore) {
    if (focusedBefore.isConnected) focusedBefore.focus({ preventScroll: true });
    focusedBefore = null;
  }
});
// Another worker or row someone asked for while the panel is open takes the focus, as opening it does.
watch(target, () => {
  if (aside.value && props.takeFocus) focusPanel(aside.value);
});
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (fullscreen.value) fullscreen.value = false;
  else open.value = false;
}

const name = computed(() =>
  liveWorkerName({ shard: props.shard, worker: props.worker, ...(follows.value ? { slot: props.slot! } : {}) }),
);
function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
const OUTCOME_VERBS: Record<LiveTestOutcome['status'], string> = {
  passed: 'passed',
  failed: 'failed',
  timedOut: 'timed out',
  skipped: 'was skipped',
  interrupted: 'was interrupted',
};
function outcomeWords(shown: LiveTestOutcome, test: string): string {
  return `${test} ${OUTCOME_VERBS[shown.status]} in ${formatLongDuration(shown.ms)}`;
}
function outcomeStatus(shown: LiveTestOutcome): string {
  return shown.status === 'timedOut' ? 'timedout' : shown.status;
}
/** The lane's tests that ended before the one the view shows or waits after, the latest first. */
const earlier = computed(() => (outcome.value ? history.value.slice(0, -1) : [...history.value]).reverse());
/** What the view says over its image: why it ended, with the run's verdict once the run's end ended it. */
const statusLine = computed(() => (endReason.value === 'run-ended' && props.verdict ? props.verdict : notice.value));
const title = computed(() => `${capitalized(name.value)}${ended.value ? '' : ' · live'}`);
const alt = computed(
  () => `The page ${name.value} is on${shownCall.value ? `, at ${shownCall.value.title}` : ''}, as the test sees it`,
);

/** The sheet's content props: `data-testid` names it as the docked panel is named. */
const sheetContent: Record<string, unknown> = { 'data-testid': 'lane-panel' };

const [DefineActions, ReuseActions] = createReusableTemplate();
const [DefineBody, ReuseBody] = createReusableTemplate();
</script>

<template>
  <DefineActions>
    <UButton
      icon="i-lucide-scan-search"
      color="neutral"
      :variant="zoom?.kind === 'element' ? 'subtle' : 'ghost'"
      size="sm"
      :disabled="!lastTarget || !image"
      aria-label="Zoom to the element"
      :aria-pressed="zoom?.kind === 'element'"
      title="Zoom to the element the test waits on"
      data-testid="live-zoom-element"
      @click="toggleElementZoom"
    />
    <UButton
      :icon="fullscreen ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
      color="neutral"
      variant="ghost"
      size="sm"
      :aria-label="fullscreen ? 'Leave full screen' : 'Full screen'"
      :title="fullscreen ? 'Leave full screen' : 'Full screen'"
      data-testid="live-fullscreen"
      @click="fullscreen = !fullscreen"
    />
  </DefineActions>

  <DefineBody>
    <div class="@container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div v-if="!ended" class="flex flex-wrap gap-x-4 gap-y-2">
        <UCheckbox
          v-if="follows"
          v-model="followNext"
          label="Follow the worker's next test"
          size="sm"
          data-testid="live-follow"
        />
        <UCheckbox
          v-if="follows"
          v-model="attention"
          label="Follow what needs attention"
          size="sm"
          title="Move to a worker whose test failed, got stuck or stopped, and say why"
          data-testid="live-follow-attention"
        />
      </div>
      <p v-if="movedWhy && !ended" role="status" class="text-xs text-muted" data-testid="live-moved">
        {{ movedWhy }}
      </p>
      <div class="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(16rem,24rem)] @3xl:items-start">
        <figure class="min-w-0 space-y-2" data-testid="live-view">
          <div
            ref="frameBox"
            class="relative aspect-[16/10] w-full overflow-hidden rounded-md border border-default bg-elevated"
          >
            <div
              class="absolute inset-0 transition-transform duration-200"
              :class="image ? (zoom ? 'cursor-zoom-out' : 'cursor-zoom-in') : ''"
              :style="zoomStyle"
              data-testid="live-stage"
              @click="image && zoomAt($event)"
            >
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
                  vector-effect="non-scaling-stroke"
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
                  vector-effect="non-scaling-stroke"
                  data-testid="live-point"
                />
              </svg>
            </div>
            <!-- Always in the page, empty while images show, so a screen reader announces each change. -->
            <p
              role="status"
              aria-live="polite"
              class="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-highlighted"
              data-testid="live-status"
            >
              {{ statusLine }}
            </p>
          </div>
          <div
            v-if="outcome"
            class="rounded-md border border-default px-3 py-2 text-sm text-highlighted"
            data-testid="live-outcome"
          >
            <UIcon
              :name="getStatusIcon(outcomeStatus(outcome))"
              :class="getStatusTextClass(outcomeStatus(outcome))"
              class="mr-1 size-4 align-text-bottom"
            />{{ outcomeWords(outcome, outcome.test ?? watchedTest)
            }}<template v-if="follows && followNext && !ended"
              ><span class="text-muted"> · waiting for the worker's next test</span></template
            >
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
          <p v-if="currentLog && !ended" class="text-xs text-muted" data-testid="live-call-state">
            <template v-if="currentLog.status === 'running'">Running for {{ formatLongDuration(callMs) }}</template>
            <template v-else
              >{{ currentLog.status === 'failed' ? 'Failed after' : 'Done in' }} <DurationValue :ms="callMs"
            /></template>
            <template v-if="targetText">
              · <span data-testid="live-call-target">{{ targetText }}</span></template
            >
          </p>
          <ErrorText v-if="callError" :text="callError" mode="block" data-testid="live-call-error" />
          <div v-if="strip.length" class="space-y-2" data-testid="live-filmstrip">
            <p class="text-xs text-muted">
              Filmstrip · the page after {{ strip.length }} {{ strip.length === 1 ? 'call' : 'calls' }} of this test
            </p>
            <ol
              ref="stripBox"
              class="flex gap-2 overflow-x-auto pb-1"
              aria-label="The page after each call of the test"
            >
              <li v-for="shot in strip" :key="shot.thumb.call" class="shrink-0">
                <button
                  type="button"
                  class="block overflow-hidden rounded border border-default bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
                  :class="enlarged === shot.thumb.call ? CURRENT_ITEM_RING_CLASS : ''"
                  :aria-pressed="enlarged === shot.thumb.call"
                  :aria-label="`The page after ${shot.thumb.title}`"
                  :title="shot.thumb.title"
                  data-testid="live-filmstrip-shot"
                  @click="enlarged = enlarged === shot.thumb.call ? null : shot.thumb.call"
                >
                  <img
                    :src="shot.url"
                    alt=""
                    :width="shot.thumb.width"
                    :height="shot.thumb.height"
                    class="h-14 w-auto"
                  />
                </button>
              </li>
            </ol>
            <figure v-if="enlargedShot" class="space-y-1" data-testid="live-filmstrip-large">
              <img
                :src="enlargedShot.url"
                :alt="`The page after ${enlargedShot.thumb.title}`"
                class="w-full max-w-md rounded-md border border-default"
              />
              <figcaption class="flex items-start gap-2 text-xs text-muted">
                <span class="min-w-0 flex-1 break-words"
                  >After <span class="font-mono">{{ enlargedShot.thumb.title }}</span></span
                >
                <UButton size="xs" color="neutral" variant="ghost" label="Close" @click="enlarged = null" />
              </figcaption>
            </figure>
          </div>
          <UButton
            v-if="ended && canRetry"
            size="xs"
            color="neutral"
            variant="outline"
            label="Try again"
            data-testid="live-retry-view"
            @click="connect"
          />
        </figure>
        <div class="min-w-0 space-y-3">
          <pre
            v-if="logLines"
            ref="logBox"
            role="region"
            tabindex="0"
            class="max-h-48 overflow-auto rounded-md border border-default bg-elevated px-3 py-2 font-mono text-xs whitespace-pre-wrap text-highlighted sm:max-h-72 @3xl:max-h-[min(32rem,60svh)]"
            aria-label="The call's log, as Playwright writes it"
            data-testid="live-call-log"
            @scroll="onLogScroll"
            >{{ logLines }}</pre>
          <div v-if="earlier.length" class="space-y-1" data-testid="live-earlier">
            <p class="text-xs text-muted">Earlier in this lane</p>
            <ul class="space-y-1">
              <li v-for="(shown, index) in earlier" :key="index" class="truncate text-xs text-highlighted">
                <UIcon
                  :name="getStatusIcon(outcomeStatus(shown))"
                  :class="getStatusTextClass(outcomeStatus(shown))"
                  class="mr-1 size-3.5 align-text-bottom"
                />{{ outcomeWords(shown, shown.test) }}
              </li>
            </ul>
          </div>
        </div>
      </div>
      <UCollapsible v-model:open="inspectOpen" class="border-t border-default pt-2" data-testid="live-inspect-section">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          class="-ml-2.5"
          :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
          title="The page at each call of the test, as a document, with a locator picker"
        >
          Inspect
        </UButton>
        <template #content>
          <LaneInspect
            class="pt-1"
            :run-id="runId"
            :heard="inspectHeard.shown"
            :refused="inspectHeard.refused"
            :watch-id="live.watchId.value"
            :turn="inspectTurn"
            :ended="ended ? inspectEnd(endReason) : null"
          />
        </template>
      </UCollapsible>
      <UCollapsible v-model:open="eventsOpen" class="border-t border-default pt-2" data-testid="live-events">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          class="-ml-2.5"
          :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
        >
          Page events<template v-if="events.shown.length"> · {{ events.shown.length }}</template>
        </UButton>
        <template #content>
          <div class="space-y-2 pt-1">
            <p v-if="!events.shown.length" class="text-xs text-muted">
              None yet. Console errors, uncaught errors, failed and slow requests, what the backend logged of them, and
              the test’s API calls show here as they happen.
            </p>
            <ul v-else class="divide-y divide-default" aria-label="The page’s events, newest first">
              <li
                v-for="line in eventRows"
                :key="line.key"
                class="grid gap-x-3 gap-y-0.5 py-1.5 text-xs @md:grid-cols-[7.5rem_minmax(0,1fr)]"
                :data-kind="line.event.kind"
                data-testid="live-event"
              >
                <span class="text-muted">{{ line.label }}</span>
                <div class="min-w-0 space-y-0.5 text-highlighted">
                  <p class="font-mono" :class="line.request ? 'break-all' : 'whitespace-pre-wrap break-words'">
                    {{ line.parts.code }}
                  </p>
                  <p v-if="line.parts.note" class="text-muted">
                    {{ line.parts.ms === null ? line.parts.note : `${line.parts.note} `
                    }}<DurationValue v-if="line.parts.ms !== null" :ms="line.parts.ms" />
                  </p>
                  <p v-if="line.parts.logged" class="font-mono whitespace-pre-wrap break-words">
                    {{ line.parts.logged }}
                  </p>
                  <p
                    v-for="(logged, i) in line.backend"
                    :key="i"
                    class="font-mono whitespace-pre-wrap break-words"
                    data-testid="live-event-backend"
                  >
                    <span class="font-sans text-muted">Backend {{ logged.level }}:</span> {{ logged.text }}
                  </p>
                </div>
              </li>
            </ul>
            <p v-if="eventsLeftOut" class="text-xs text-muted" data-testid="live-events-left-out">
              {{ eventsLeftOut }}.
            </p>
          </div>
        </template>
      </UCollapsible>
      <UCollapsible v-model:open="textOpen" class="border-t border-default pt-2" data-testid="live-text-section">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          class="-ml-2.5"
          :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
        >
          Page text
        </UButton>
        <template #content>
          <div class="space-y-2 pt-1">
            <div class="flex items-center gap-2">
              <UInput
                v-model="textQuery"
                size="sm"
                icon="i-lucide-search"
                placeholder="Find in the text"
                aria-label="Find in the page’s text"
                class="min-w-0 flex-1"
                data-testid="live-text-search"
              />
              <span v-if="textFound" class="shrink-0 text-xs text-muted" data-testid="live-text-count">
                {{ textFound.count }} {{ textFound.count === 1 ? 'match' : 'matches' }}
              </span>
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                label="Read again"
                :disabled="ended"
                title="Ask the worker for the page’s text now"
                data-testid="live-text-again"
                @click="askText"
              />
            </div>
            <p v-if="pageText && 'refused' in pageText" class="text-xs text-muted" data-testid="live-text-refused">
              {{ pageText.refused }}
            </p>
            <LaneTextLines
              v-else-if="textLines.length"
              :lines="textLines"
              :ranges="textFound?.ranges ?? null"
              :targets="targetLines"
            />
            <p v-else class="text-xs text-muted" data-testid="live-text-waiting">{{ textWaiting }}</p>
            <p v-if="textLines.length" class="text-xs text-muted">
              {{ textSource }}. Each field that holds a secret, and each element the project masks, reads
              <code>&lt;hidden&gt;</code>.<template v-if="targetLines.size">
                The marked lines name the element the call waits on.</template
              >
            </p>
          </div>
        </template>
      </UCollapsible>
      <p class="text-xs text-muted">
        You watch the page; nothing you do here reaches the test. Nothing of the view is stored: the run’s trace keeps
        the record.
      </p>
    </div>
  </DefineBody>

  <aside
    v-if="open && docked"
    ref="aside"
    tabindex="-1"
    class="flex h-full shrink-0 flex-col border-l border-default bg-default outline-none"
    :class="fullscreen ? 'fixed inset-0 z-50' : 'relative max-w-[50%]'"
    :style="fullscreen ? undefined : { width: `${dockedWidth}rem` }"
    :aria-label="title"
    data-testid="lane-panel"
    @keydown="onKeydown"
  >
    <DockedPanelHandle
      v-if="!fullscreen"
      :width="dockedWidth"
      :min="LANE_PANEL_WIDTH.min"
      :max="maxWidth"
      :initial="LANE_PANEL_WIDTH.initial"
      label="Resize the live view"
      @update:width="width = $event"
    />
    <div class="flex h-(--ui-header-height) shrink-0 items-center gap-1.5 border-b border-default px-4">
      <div class="min-w-0 flex-1">
        <h2 class="truncate font-semibold text-highlighted">{{ title }}</h2>
        <p class="truncate text-xs text-muted" :title="watchedTest">{{ watchedTest }}</p>
      </div>
      <ReuseActions />
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Close the live view"
        title="Close"
        @click="open = false"
      />
    </div>
    <ReuseBody />
  </aside>
  <USlideover
    v-else-if="!docked"
    v-model:open="open"
    side="bottom"
    :title="title"
    :description="watchedTest"
    :content="sheetContent"
    :ui="{
      content: fullscreen ? 'h-svh max-h-svh' : 'max-h-[85svh]',
      body: 'p-0 sm:p-0 flex flex-col min-h-0',
    }"
  >
    <template #actions>
      <ReuseActions />
    </template>
    <template #body>
      <ReuseBody />
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import { computed, nextTick, watch, onUnmounted } from 'vue';
import type {
  AttemptOutcome,
  TestRunDetails,
  TestCaseResult,
  ReportInfo,
  TestStepEvent,
  FailureGroup,
  RunClusterMeta,
} from '~~/types/api';
import type { LiveStepsByWorker } from '~/utils/live-steps';
import { liveRowNote } from '~/utils/live-row-note';
import { runSummaryText, runVerdictText } from '~/utils/run-summary';
import { NO_WORKER_GRACE_MS } from '~/utils/run-live-view-status';
import { stallWatch, STREAM_RECONNECT_STALL_MS } from '~/utils/stream-stall';
import { AttentionFollower, attentionSignals, attentionWords } from '~/utils/live-attention';
import { PRESSED_TOGGLE_CLASS } from '@piwitests/run-ui/ui-classes';
import { useLiveWatch } from '~/composables/useLiveWatch';
import { streamReopener } from '~/utils/stream-reopen';
import {
  isFinalRefetch,
  refetchKeeping,
  refetchReason,
  settleInOrder,
  type FinalRefetchFailure,
} from '~/utils/refetch-keeping';
import { runReadEndedNotice } from '~/utils/run-read-ended';
import { desktopEditorRunOf } from '~/utils/desktop-run-view';
import { timelineLaneCount } from '~/composables/useTimelineModel';
import { subscribeDemoEvents } from '~/demo/run-events';
import { useRunEvents, useRunStart, useRunStream } from '~/composables/useRunStream';
import { useReportsPoll } from '~/composables/useReportsPoll';
import { summarizeRunCases } from '#shared/utils/test-counts';
import { applyLiveResourcesToParts } from '#shared/live-resources';
import type { RunResourceTimelinePart } from '#shared/handlers/run-resources';
import type { WireLiveResources } from '#shared/types';
import {
  liveWatchAddress,
  liveWorkerKey,
  parseLiveWatchAddress,
  type LiveAskView,
  type LiveLane,
  type LiveViewRunState,
  type LiveWorkerState,
} from '#shared/live-view';
import { runOrigin, runOriginRef } from '#shared/run-eligibility';
import type { StuckAttempt } from '#shared/stuck-tests';
import type { TestStop } from '@piwitests/core/wire';
import { heldLanes, type Lane } from '#shared/live-lanes';

const route = useRoute();
const router = useRouter();
const runId = route.params.id;
const isDemoMode = Boolean(useRuntimeConfig().public.demoMode);
const baseURL = useRuntimeConfig().app.baseURL.replace(/\/$/, '');
const isDesktop = useIsDesktop();
const { can, authState } = useAuth();
const toast = useToast();

const { data: testRun, error: testRunError } = await useFetch<TestRunDetails>(`/api/test-runs/${runId}`);
if (testRunError.value) showPageLoadError(testRunError.value, 'test run');
// Every later read of the run goes through `reloadRun`: a read that fails (a proxy's 502 while the instance restarts, a
// run deleted meanwhile) leaves the run the page shows, and resolves to why it failed.
let lastReadError: unknown = null;
const readRun = refetchKeeping(testRun, () =>
  $fetch<TestRunDetails>(`/api/test-runs/${runId}`).catch((error: unknown) => {
    lastReadError = error;
    throw error;
  }),
);
/**
 * Why the page can no longer read the run, after a final failure (`isFinalRefetch`): the run was deleted, the session
 * ended, or the viewer's access was removed. The page stops following the run and says why, until a read answers.
 */
const runReadEnded = ref<FinalRefetchFailure | null>(null);
// Each result acts in the order its read started: an older read's answer never undoes a newer one's.
const reloadRun = settleInOrder(readRun, (result) => {
  if (isFinalRefetch(result)) {
    runReadEnded.value = result;
    disconnectStream();
  } else if (result === 'answered' && runReadEnded.value) {
    runReadEnded.value = null;
    if (shouldStream.value) connectToStream();
  }
});
/** A read the person asked for (Refresh, a keep, a label change): one that failed says so, with why. */
async function reloadRunAsked(): Promise<void> {
  if ((await reloadRun()) !== 'failed') return;
  const reason = refetchReason(lastReadError) ?? 'The instance did not answer.';
  toast.add({
    title: 'The run could not be read again',
    description: `${reason} The page shows the run as it last read it.`,
    color: 'error',
  });
}
const authEnabled = Boolean(useRuntimeConfig().public.authEnabled);
/** What the page says once it can no longer read the run, and the action it offers. */
const runReadEndedView = computed(() =>
  runReadEnded.value ? runReadEndedNotice(runReadEnded.value, authEnabled) : null,
);
/** The notice's action as a button: Piwi's sign-in page, coming back here, or the page loaded again. */
const runReadEndedActions = computed(() => {
  const action = runReadEndedView.value?.action;
  if (action === 'sign-in')
    return [
      {
        label: 'Sign in again',
        color: 'neutral' as const,
        variant: 'outline' as const,
        to: { path: '/login', query: { redirect: route.fullPath } },
      },
    ];
  if (action === 'reload')
    return [
      {
        label: 'Load the page again',
        color: 'neutral' as const,
        variant: 'outline' as const,
        onClick: () => reloadNuxtApp(),
      },
    ];
  return [];
});
// The page left: nothing opens a stream for it any more.
let pageLeft = false;

// Lightweight poll for latest run info — avoids reloading full page data on run events
const projectId = testRun.value?.projectId;
provideExternalIdUrl(() => testRun.value?.project?.externalIdUrl);
provideTestManagementKeys(() => testRun.value?.project?.id);
type LatestRunInfo = { id: number; status: string } | null;
const { data: latestRunInfo, refresh: refreshLatestRun } = projectId
  ? await useFetch<LatestRunInfo>(`/api/projects/${projectId}/latest-run`, { key: `latest-run-${projectId}` })
  : { data: ref<LatestRunInfo>(null), refresh: async () => {} };
useRunStream(refreshLatestRun);

// Which of this project's tests are quarantined — marks the matching rows in the
// executions list. `candidates=false` skips the heavier flaky-analysis proposal.
type RunQuarantine = { entries: Array<{ testCaseId: number }> };
const { data: quarantineData } = projectId
  ? await useFetch<RunQuarantine>(`/api/projects/${projectId}/quarantine?candidates=false`, {
      key: `run-quarantine-${projectId}`,
    })
  : { data: ref<RunQuarantine | null>(null) };
// A read that fails keeps the marks the list shows.
const reloadQuarantine = projectId
  ? refetchKeeping(quarantineData, () =>
      $fetch<RunQuarantine>(`/api/projects/${projectId}/quarantine?candidates=false`),
    )
  : async () => 'answered' as const;
const quarantinedCaseIds = computed(() => new Set((quarantineData.value?.entries ?? []).map((e) => e.testCaseId)));

const latestRunId = computed(() => latestRunInfo.value?.id ?? testRun.value?.project?.latestRunId ?? null);
const latestRunStatus = computed(() => latestRunInfo.value?.status ?? testRun.value?.project?.latestRunStatus ?? null);
const isLatestRunActive = computed(() => latestRunStatus.value === 'running' || latestRunStatus.value === 'finalizing');

const { copy } = useCopy();
const isDeleteConfirmOpen = ref(false);
const isKeepOpen = ref(false);
const { release: releaseKeep, canRelease } = useRunKeep();

// Live streaming state
const isLive = computed(() => testRun.value?.status === 'running' || testRun.value?.status === 'finalizing');
const isFinalizing = ref(false);
// Each test's latest attempt, while the run is live: the row the list shows.
const liveTestCases = ref<TestCaseResult[]>([]);
const liveTestCaseKeys = new Map<string, true>();
// The attempts a retry followed, by `liveCaseKey` and retry: the timeline keeps their bars while the run is live.
const liveEarlierAttempts = ref<Record<string, TestCaseResult>>({});
function keepEarlierAttempt(tc: TestCaseResult): void {
  const key = `${liveCaseKey(tc)}#${tc.retries ?? 0}`;
  liveEarlierAttempts.value = { ...liveEarlierAttempts.value, [key]: mergeAttempt(liveEarlierAttempts.value[key], tc) };
}
/**
 * An attempt as one more event tells it: what the event leaves out (a replay of the stream's catch-up sends no start,
 * error or steps; a resent batch's no ids) stays as the attempt kept it.
 */
function mergeAttempt(kept: TestCaseResult | undefined, tc: TestCaseResult): TestCaseResult {
  if (!kept) return tc;
  const merged = { ...kept };
  for (const [field, value] of Object.entries(tc) as Array<[keyof TestCaseResult, unknown]>) {
    if (value !== undefined && value !== null) (merged as Record<string, unknown>)[field] = value;
  }
  if (tc.executionId < 0 && kept.executionId > 0) merged.executionId = kept.executionId;
  if (!tc.testCaseId && kept.testCaseId) merged.testCaseId = kept.testCaseId;
  return merged;
}
// A row the database holds no execution for yet gets a unique negative id, unlinked until its test completes.
let placeholderIds = 0;
const placeholderId = () => -++placeholderIds;
// The step each worker is on, by its shard and its worker (`liveWorkerKey`), from transient SSE step
// events; nothing is persisted from them. Rendered inline on the matching
// running rows in the test-case views.
const liveSteps = ref<LiveStepsByWorker>({});
// What the run's reporters measured so far (CPU, memory, open pages), one part
// per reporter, from the stream's `resources` events. The workers timeline
// draws them while the run is live, and the stored report once it ended.
const liveResources = ref<RunResourceTimelinePart[]>([]);
// The workers in the run's live view, by `liveWorkerKey`, from the stream's `live-worker` events: each running row of
// one offers Watch, and says Paused while its test is stopped.
const liveWorkers = ref<Record<string, LiveWorkerState>>({});
// The run's lanes as they stand, by `laneKey`, from the stream's `lane` events (`heldLanes`): the instance reduces them
// from the run's events, so the page reads each lane's state, test and stop ready. Each catch-up, and the run's end,
// starts them afresh.
const liveLanes = ref<Record<string, Lane>>({});
// Whether the run holds a live view key, from the stream's `live-view` events: its project's live view applies to it.
const liveViewKeyed = ref(false);
// The stream's last `live-view` state, and whether the stream is open: the toolbar's status reads both.
const liveViewState = ref<LiveViewRunState | null>(null);
const liveViewConnected = ref(false);
// The stream has not opened for `STREAM_STALL_MS`, or opened again within `STREAM_RECONNECT_STALL_MS` of a drop: the
// toolbar says so, with Retry.
const liveStreamStalled = ref(false);
const streamStall = stallWatch(
  () => liveViewConnected.value,
  () => (liveStreamStalled.value = true),
);
function stopWatchingForStall() {
  streamStall.disarm();
  liveStreamStalled.value = false;
}
// The run finished on the stream: its status leaves the toolbar before the refetched run says so.
const liveRunEnded = ref(false);
/** How the run ended, in a sentence, once the page read it ended: an open live view says it. */
const runVerdict = computed(() => {
  const run = testRun.value;
  if (!liveRunEnded.value || !run || ['running', 'initializing', 'finalizing'].includes(run.status)) return null;
  return runVerdictText({ status: run.status, total: run.totalTests ?? 0, failed: run.failedTests ?? 0 });
});
// Whether a worker of the run's view connected since the page opened, and whether tests have run for
// `NO_WORKER_GRACE_MS` since the page first heard of one: both, the status says no worker opened the view.
const liveWorkerSeen = ref(false);
const testsRanLong = ref(false);
let testsRanTimer: ReturnType<typeof setTimeout> | null = null;
// What the running rows say where Watch would be, while no worker is in the run's view: in the desktop app, which
// hands out no key, where the tests' pages show. A run nobody shares says so once, in the Tests toolbar.
const liveNote = computed(() =>
  liveRowNote({ live: isLive.value, desktop: isDesktop, workers: Object.keys(liveWorkers.value).length }),
);
// The live runs the desktop app started that report to this run, by the origin it records: their running rows offer
// Pause and watch.
const desktopSessions = useDesktopRunSessions(() => ({
  id: Number(runId),
  kind: runOrigin(testRun.value?.metadata),
  ref: runOriginRef(testRun.value?.metadata),
}));
// The runs of an editor of this machine that report to this page, as the desktop app's server observes them: the
// page says where their tests wait, which the editor answers. Matched by the run's page on this app's own server.
const editorRuns = useDesktopEditorRuns();
const editorRunsHere = computed(() =>
  isDesktop && import.meta.client
    ? editorRuns.value.filter((run) => desktopEditorRunOf(run.session, Number(runId), window.location.origin))
    : [],
);
// The worker someone opened Watch on, its lane, and the execution of the row they opened it from (null when the
// page's address, a tile with no running row or Follow what needs attention opened it): the view starts on that test,
// and follows the lane's next tests when the worker says its lane.
const watching = ref<{
  worker: number;
  shard: number | null;
  slot?: number;
  test: string;
  executionId: number | null;
} | null>(null);
const watchOpen = ref(false);
/** Whether the view opened from a row's Watch, which gives it the focus; the page's address opens it without. */
const watchAsked = ref(false);
// The lane a `?watch=` address names, until a worker of it joins the run's live view: the view then opens on it.
const watchAddress = ref<LiveLane | null>(null);
function watchWorker(worker: LiveWorkerState, testCase: TestCaseResult | null) {
  // The worker shown replaces a lane the address still waits for.
  watchAddress.value = null;
  watchAsked.value = testCase !== null;
  watching.value = {
    worker: worker.worker,
    shard: worker.shard,
    ...(worker.slot !== undefined ? { slot: worker.slot } : {}),
    test: testCase?.title ?? '',
    executionId: testCase?.executionId ?? null,
  };
  watchOpen.value = true;
}
/** The worker in a lane: the newest Playwright started in it, the one the instance serves its views from. */
function laneWorker(lane: LiveLane): LiveWorkerState | null {
  let found: LiveWorkerState | null = null;
  for (const worker of Object.values(liveWorkers.value)) {
    if (worker.shard !== lane.shard || worker.slot !== lane.slot) continue;
    if (!found || worker.worker > found.worker) found = worker;
  }
  return found;
}
/** The step the watched worker is on: of the worker now in the view's lane, none while the lane has none. */
const watchedStep = computed(() => {
  const shown = watching.value;
  if (!shown) return null;
  const now = shown.slot === undefined ? shown : laneWorker({ shard: shown.shard, slot: shown.slot });
  return now ? (liveSteps.value[liveWorkerKey(now)] ?? null) : null;
});
/** Whether the run is over, so no lane of it is waited for. */
const runOver = computed(
  () =>
    liveRunEnded.value ||
    (!!testRun.value && !['running', 'initializing', 'finalizing'].includes(testRun.value.status)),
);
/** Open the view of the lane the address waits for, once a worker of it is in the run's live view. */
function openAddressed(): void {
  const lane = watchAddress.value;
  const worker = lane ? laneWorker(lane) : null;
  if (!worker) return;
  watchAddress.value = null;
  watchWorker(worker, null);
}
// An address that names a lane, as the page opens or as a link reaches the page already open, opens its view.
watch(
  () => route.query.watch,
  (value) => {
    const lane = parseLiveWatchAddress(value);
    const shown = watching.value;
    // The address of the view open now, which the page wrote itself.
    if (!lane || (watchOpen.value && shown?.shard === lane.shard && shown.slot === lane.slot)) return;
    watchAddress.value = runOver.value ? null : lane;
    openAddressed();
  },
  { immediate: true },
);
watch(liveWorkers, openAddressed);
/** The lane the page's address named as the run ended: a run that continues this one opens on it. */
let watchAtEnd: string | null = null;
watch(runOver, (over) => {
  if (!over) return;
  if (typeof route.query.watch === 'string') watchAtEnd = route.query.watch;
  watchAddress.value = null;
});

/**
 * The run that continued this one, shared after it from the same editor window: as the run said it when the page read
 * it, or as the instance tells it while the page is open (`continued` on the run's stream, `run-continued` once it
 * ended). Told while the page is open, the page says so, and opens that run, on the lane its address names, only when
 * it followed this run live: a page opened to read an ended run stays where it is.
 */
const continuedInId = ref<number | null>(testRun.value?.continuedInId ?? null);
watch(
  () => testRun.value?.continuedInId,
  (id) => {
    if (id) continuedInId.value = id;
  },
);
/** The run that continues this one, with the lane the page's address names, as a route. */
const continuedRoute = computed(() => {
  if (!continuedInId.value) return null;
  const lane = typeof route.query.watch === 'string' ? route.query.watch : watchAtEnd;
  return { path: `/test-runs/${continuedInId.value}`, query: lane ? { watch: lane } : {} };
});
/** How long the page says the run continues elsewhere before it opens that run. */
const FOLLOW_DELAY_MS = 1500;
let followTimer: ReturnType<typeof setTimeout> | null = null;
/** The page showed this run live: a run that continues it is followed there. */
let followedLive = false;
watch(
  isLive,
  (live) => {
    if (live) followedLive = true;
  },
  { immediate: true },
);
function followContinuation(next: unknown): void {
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= Number(runId) || followTimer) return;
  continuedInId.value = next;
  if (!followedLive) return;
  followTimer = setTimeout(() => {
    followTimer = null;
    if (!pageLeft && continuedRoute.value) void navigateTo(continuedRoute.value);
  }, FOLLOW_DELAY_MS);
}
/** The page's address names the lane the view follows while it is open, so it can be shared, and a lane it waits for. */
function syncAddress(): void {
  if (!import.meta.client || watchAddress.value) return;
  const shown = watching.value;
  const address =
    watchOpen.value && shown?.slot !== undefined
      ? liveWatchAddress({ shard: shown.shard, slot: shown.slot })
      : undefined;
  if (route.query.watch !== address) void replaceQuery(router, { watch: address });
}
watch([watchOpen, watching, watchAddress], syncAddress);
onMounted(syncAddress);
let eventSource: EventSource | null = null;

// Combined test cases: from server data + live stream. Includes every attempt
// (a retried test has one row per attempt) — the timeline and the per-execution
// links need them all.
const displayTestCases = ref<TestCaseResult[]>([]);

/**
 * One entry per test result, its final attempt (highest retry count), so a
 * retried test is a single row whose outcome is its last attempt, and each
 * `--repeat-each` repetition is a row of its own. Keyed by `testAttemptKey`
 * (the persisted test-case id, browser and repetition once known, else the
 * streaming key), so it collapses live placeholder rows and finished attempt
 * rows alike. Feeds the header counts, the count bar and the grouped list; the
 * timeline keeps the full attempt list.
 */
function dedupeFinalAttempts(cases: TestCaseResult[]): TestCaseResult[] {
  const byKey = new Map<string, TestCaseResult>();
  for (const tc of cases) {
    const key = testAttemptKey(tc);
    const prev = byKey.get(key);
    if (!prev || (tc.retries ?? 0) >= (prev.retries ?? 0)) byKey.set(key, tc);
  }
  return [...byKey.values()];
}

const dedupedDisplayCases = computed(() => dedupeFinalAttempts(displayTestCases.value));

// The page's one watch of the run: the lane panel's full view and Watch all's tiles, on one connection.
const live = useLiveWatch(() => Number(runId));
/** **Watch all**: a tile of every worker in the run's live view, above its tests. */
const watchAll = ref(false);
// The demo runs no worker to watch: its tiles name each lane's step.
watch(watchAll, (on) => !isDemoMode && live.watchAll(on));
// A worker that left the run's live view leaves its tile.
watch(liveWorkers, (workers) => live.keep(Object.keys(workers)));
/**
 * The workers Watch all shows: those in the run's live view; in the demo, which runs no worker, a stand-in of each lane
 * that runs a test.
 */
const watchAllWorkers = computed<LiveWorkerState[]>(() => {
  if (!isDemoMode) return Object.values(liveWorkers.value);
  return Object.values(liveLanes.value).flatMap((lane) =>
    lane.test && lane.state !== 'done'
      ? [
          {
            shard: lane.id.shard,
            worker: lane.worker ?? lane.id.lane,
            slot: lane.id.lane,
            connected: true,
            paused: null,
          },
        ]
      : [],
  );
});
const lanesNow = computed(() => Object.values(liveLanes.value));
/** Whether the run page offers Watch all: a live run with a worker in its live view, or the demo's running lanes. */
const offersWatchAll = computed(
  () => isLive.value && !liveRunEnded.value && (watchAllWorkers.value.length > 0 || watchAll.value),
);
const runningRows = computed(() => dedupedDisplayCases.value.filter((row) => row.status === 'running'));
/** What each lane needs attention for now: its rows' failures and Stuck? marks, and its stop. */
const attentionNow = computed(() => attentionSignals(displayTestCases.value, lanesNow.value));
/** **Follow what needs attention**: the lane panel moves on its own to a lane whose test failed, got stuck or stopped. */
const followAttention = ref(false);
/** Why the lane panel moved where it is, while it shows that lane. */
const movedWhy = ref<string | null>(null);
let follower = new AttentionFollower();
// Turned on, it reads what needs attention afresh, and may move at once.
watch(followAttention, (on) => {
  follower = new AttentionFollower();
  if (!on) movedWhy.value = null;
  else followWhatNeedsAttention();
});
/**
 * Move the lane panel where the follower says, when Follow what needs attention is on. While the panel is closed, the
 * follower notes what needs attention, and nothing moves.
 */
function followWhatNeedsAttention(): void {
  if (!followAttention.value) return;
  if (!watchOpen.value) return follower.note(attentionNow.value, Date.now());
  const shown = watching.value;
  const lane = shown?.slot !== undefined ? { shard: shown.shard, slot: shown.slot } : null;
  const inView = Object.values(liveWorkers.value).flatMap((worker) =>
    worker.slot === undefined ? [] : [{ shard: worker.shard, slot: worker.slot }],
  );
  const move = follower.update(attentionNow.value, lane, inView, Date.now());
  const worker = move ? laneWorker(move.lane) : null;
  if (!move || !worker) return;
  watchWorker(worker, null);
  movedWhy.value = attentionWords(move);
}
watch([attentionNow, liveWorkers], followWhatNeedsAttention);
// The follower's waits end on a clock of their own: a lane holds the view a while, then the next news moves it.
useIntervalFn(followWhatNeedsAttention, 1000);
/**
 * The person shows a worker in the lane panel, from a tile or a row, with the test it runs when the page knows it: the
 * view stays there a while, and what needed attention before moves it nowhere.
 */
function chooseWorker(worker: LiveWorkerState, testCase: TestCaseResult | null): void {
  follower.chose(attentionNow.value, Date.now());
  movedWhy.value = null;
  watchWorker(worker, testCase);
  watchAsked.value = true;
}

/** What the page shows while live: the attempts a retry followed, then each test's latest attempt. */
function showLive(): void {
  displayTestCases.value = [...Object.values(liveEarlierAttempts.value), ...liveTestCases.value];
}

watch(
  [isLive, testRun],
  () => {
    if (isLive.value && liveTestCases.value.length > 0) {
      showLive();
    } else if (testRun.value?.testCases) {
      displayTestCases.value = testRun.value.testCases;
    } else {
      displayTestCases.value = [];
    }
  },
  { immediate: true },
);

// Initialise liveTestCases from persisted data when SSE connects: one row per
// test the stream has not shown yet, its latest attempt.
function seedLiveFromPersisted(cases: TestCaseResult[]) {
  const rows = [...liveTestCases.value];
  const seeded = new Map<string, number>();
  for (const tc of cases) {
    const key = liveCaseKey(tc);
    const idx = seeded.get(key);
    if (idx !== undefined) {
      const [earlier, later] = (tc.retries ?? 0) > (rows[idx]!.retries ?? 0) ? [rows[idx]!, tc] : [tc, rows[idx]!];
      keepEarlierAttempt(earlier);
      rows[idx] = later;
    } else if (!liveTestCaseKeys.has(key)) {
      liveTestCaseKeys.set(key, true);
      seeded.set(key, rows.length);
      rows.push(tc);
    }
  }
  liveTestCases.value = rows;
  showLive();
}

// The planned suite size as the run's stream last reported it: it grows as each
// shard of a sharded run starts, after the page loaded. Feeds the tab's progress.
const plannedTotal = ref<number | null>(null);

// Debounced batch processing of SSE events to avoid cascading re-renders
let pendingEvents: Record<string, unknown>[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingEvents() {
  if (pendingEvents.length === 0) return;
  const events = pendingEvents;
  pendingEvents = [];
  for (const parsed of events) {
    const data = parsed.data as Record<string, unknown>;
    liveLanes.value = heldLanes(liveLanes.value, parsed);
    // 'init' and 'run-progress' carry the server's running counters; the header
    // and bar are derived from the de-duplicated case list instead (see
    // displayProgress), so only their planned suite size is kept.
    if (parsed.type === 'init' || parsed.type === 'run-progress') {
      if (typeof data?.totalTests === 'number') plannedTotal.value = data.totalTests;
    } else if (parsed.type === 'test-begin') {
      const d = data as {
        title: string;
        filePath?: string;
        suitePath?: string[] | null;
        location: string;
        workerIndex?: number;
        parallelIndex?: number | null;
        startedAt?: number;
        browser?: { projectName?: string } | null;
        repeatEachIndex?: number;
        stepCategory?: string | null;
        shardIndex?: number | null;
        stuck?: StuckAttempt | null;
        stop?: TestStop | null;
        retries?: number | null;
        maxRetries?: number | null;
        tags?: string[] | null;
        locks?: string[] | null;
        testMeta?: TestCaseResult['testMeta'];
      };
      // Hook/fixture step-begin events are published as `test-begin` with a
      // `stepCategory`. They are not test cases — ignore them so they don't
      // create phantom rows (which left orphaned "running" dots on the
      // timeline). Hooks render from `stepEvents` once their test completes.
      if (d.stepCategory) continue;
      if (!testsRanTimer && !testsRanLong.value) {
        testsRanTimer = setTimeout(() => (testsRanLong.value = true), NO_WORKER_GRACE_MS);
      }
      const key = liveCaseKey(d);
      if (!liveTestCaseKeys.has(key)) {
        liveTestCaseKeys.set(key, true);
        liveTestCases.value = [
          ...liveTestCases.value,
          {
            // The persisted execution row only exists once the test completes —
            // a unique negative placeholder keeps the row keyed (and unlinked)
            // until test-completed delivers the real id.
            executionId: placeholderId(),
            testCaseId: 0,
            title: d.title,
            filePath: d.filePath,
            suitePath: d.suitePath ?? undefined,
            status: 'running',
            location: d.location,
            workerIndex: d.workerIndex ?? null,
            parallelIndex: d.parallelIndex ?? null,
            shardIndex: d.shardIndex ?? null,
            startedAt: d.startedAt ?? Date.now(),
            browser: d.browser ?? null,
            repeatEachIndex: d.repeatEachIndex ?? 0,
            stuck: d.stuck ?? null,
            liveStop: d.stop ?? null,
            retries: d.retries ?? 0,
            maxRetries: d.maxRetries ?? null,
            tags: d.tags ?? null,
            locks: d.locks ?? null,
            testMeta: d.testMeta ?? null,
          },
        ];
        showLive();
      } else {
        // A known test begins again: a retry starts, or a reconnected stream catches up on a running
        // attempt (its row takes the mark it carries). A reporter that does not say which attempt begins
        // starts a retry when the row's attempt ended.
        const idx = liveTestCases.value.findIndex((tc) => liveCaseKey(tc) === key);
        const existing = idx >= 0 ? liveTestCases.value[idx]! : null;
        if (!existing) continue;
        const retry =
          d.retries ?? (existing.status === 'running' ? (existing.retries ?? 0) : (existing.retries ?? 0) + 1);
        const copy = [...liveTestCases.value];
        if (retry > (existing.retries ?? 0)) {
          // The attempt that ended keeps its bar on the timeline; the row runs as the retry, unlinked until it ends.
          if (existing.status !== 'running') keepEarlierAttempt(existing);
          copy[idx] = {
            ...existing,
            executionId: placeholderId(),
            status: 'running',
            duration: null,
            error: null,
            stepEvents: null,
            wastedTimeMs: null,
            failureClusterId: null,
            retries: retry,
            maxRetries: d.maxRetries ?? existing.maxRetries ?? null,
            workerIndex: d.workerIndex ?? existing.workerIndex,
            parallelIndex: d.parallelIndex ?? existing.parallelIndex,
            shardIndex: d.shardIndex ?? existing.shardIndex,
            startedAt: d.startedAt ?? Date.now(),
            stuck: d.stuck ?? null,
            liveStop: d.stop ?? null,
          };
        } else if (existing.status === 'running' && (d.stuck || d.stop !== undefined)) {
          // A reconnected stream catches up on the mark and the stop the attempt carries.
          copy[idx] = { ...existing, stuck: d.stuck ?? existing.stuck ?? null, liveStop: d.stop ?? null };
        } else continue;
        liveTestCases.value = copy;
        showLive();
      }
    } else if (parsed.type === 'test-stuck') {
      // A running test has run far longer than it usually does: its row says so until it completes.
      const d = data as unknown as {
        title: string;
        location: string;
        browser?: { projectName?: string } | null;
        repeatEachIndex?: number;
      } & StuckAttempt;
      const key = liveCaseKey(d);
      const idx = liveTestCases.value.findIndex((tc) => tc.status === 'running' && liveCaseKey(tc) === key);
      if (idx >= 0) {
        // A new row object, so what the list's search reads of it (`is:stuck`) is read again.
        const copy = [...liveTestCases.value];
        copy[idx] = { ...copy[idx]!, stuck: { elapsedMs: d.elapsedMs, usualMs: d.usualMs } };
        liveTestCases.value = copy;
        showLive();
      }
    } else if (parsed.type === 'test-stopped' || parsed.type === 'test-resumed') {
      // A running test of a run outside CI stopped, or went on: its row says where it stands until then.
      const d = data as unknown as {
        title: string;
        location: string;
        browser?: { projectName?: string } | null;
        repeatEachIndex?: number;
        retries?: number | null;
        stop?: TestStop;
      };
      const key = liveCaseKey(d);
      const row = liveTestCases.value.find(
        (tc) =>
          tc.status === 'running' && liveCaseKey(tc) === key && (d.retries == null || (tc.retries ?? 0) === d.retries),
      );
      if (row) {
        row.liveStop = parsed.type === 'test-stopped' ? (d.stop ?? null) : null;
        liveTestCases.value = [...liveTestCases.value];
        showLive();
      }
    } else if (parsed.type === 'test-completed') {
      const d = data as {
        title: string;
        externalId?: string | null;
        displayTitle?: string | null;
        filePath?: string;
        suitePath?: string[] | null;
        location: string;
        status: string;
        duration?: number;
        error?: string | null;
        stepEvents?: TestStepEvent[] | null;
        wastedTimeMs?: number | null;
        workerIndex?: number;
        parallelIndex?: number | null;
        shardIndex?: number | null;
        startedAt?: number;
        browser?: { projectName?: string } | null;
        stepCategory?: string | null;
        retries?: number | null;
        attempts?: AttemptOutcome[] | null;
        repeatEachIndex?: number;
        executionId?: number | null;
        testCaseId?: number | null;
        tags?: string[] | null;
        locks?: string[] | null;
        testMeta?: TestCaseResult['testMeta'];
        testAnnotations?: TestCaseResult['testAnnotations'];
        failureClusterId?: number | null;
        failureCluster?: { name: string; status: string } | null;
      };
      // Ignore hook/fixture step-end events (published as `test-completed`
      // with a `stepCategory`) — they are not test cases. The hook segments
      // arrive via the owning test's `stepEvents` below.
      if (d.stepCategory) continue;
      // A failure filed under a cluster the page has not read yet: its group shows the event's name and triage status
      // until the read of the run's clusters answers with its known issue.
      if (d.failureClusterId != null && !clusterMeta.value[d.failureClusterId]) {
        if (d.failureCluster) {
          clusterMeta.value = { ...clusterMeta.value, [d.failureClusterId]: { ...d.failureCluster, issue: null } };
        }
        readNewClusterMeta();
      }
      const key = liveCaseKey(d);
      /** The attempt as the event tells it, for a row the list has not shown yet. */
      const completedRow = (): TestCaseResult => ({
        executionId: d.executionId ?? placeholderId(),
        testCaseId: d.testCaseId ?? 0,
        title: d.title,
        externalId: d.externalId ?? null,
        displayTitle: d.displayTitle ?? null,
        filePath: d.filePath,
        suitePath: d.suitePath ?? undefined,
        status: d.status,
        duration: d.duration,
        location: d.location,
        error: d.error,
        stepEvents: d.stepEvents ?? null,
        wastedTimeMs: d.wastedTimeMs ?? null,
        workerIndex: d.workerIndex ?? null,
        parallelIndex: d.parallelIndex ?? null,
        shardIndex: d.shardIndex ?? null,
        startedAt: d.startedAt ?? undefined,
        browser: d.browser ?? null,
        retries: d.retries ?? null,
        attempts: d.attempts ?? null,
        repeatEachIndex: d.repeatEachIndex ?? 0,
        tags: d.tags ?? null,
        locks: d.locks ?? null,
        testMeta: d.testMeta ?? null,
        testAnnotations: d.testAnnotations ?? null,
        failureClusterId: d.failureClusterId ?? null,
      });
      if (liveTestCaseKeys.has(key)) {
        const idx = liveTestCases.value.findIndex((tc) => liveCaseKey(tc) === key);
        if (idx >= 0) {
          const existing = liveTestCases.value[idx]!;
          // An earlier attempt of a test whose later attempt the row shows keeps its bar on the timeline, and leaves
          // the row as it is.
          if ((d.retries ?? 0) < (existing.retries ?? 0)) {
            keepEarlierAttempt(completedRow());
            // The row of a retry that began before its earlier attempt's end came takes the test's id and history, so
            // the two are one test's attempts.
            if (!existing.testCaseId && d.testCaseId) {
              const copy = [...liveTestCases.value];
              copy[idx] = { ...existing, testCaseId: d.testCaseId, attempts: existing.attempts ?? d.attempts ?? null };
              liveTestCases.value = copy;
            }
            showLive();
            continue;
          }
          // A later attempt whose begin the page missed: the one the row showed keeps its bar.
          if ((d.retries ?? 0) > (existing.retries ?? 0) && existing.status !== 'running') keepEarlierAttempt(existing);
          const copy = [...liveTestCases.value];
          copy[idx] = {
            ...existing,
            externalId: d.externalId ?? existing.externalId,
            displayTitle: d.displayTitle ?? existing.displayTitle,
            filePath: d.filePath ?? existing.filePath,
            suitePath: d.suitePath ?? existing.suitePath,
            status: d.status,
            // The attempt said to be stuck, or stopped, ended.
            stuck: null,
            liveStop: null,
            duration: d.duration,
            // A live event always carries the attempt's error, null on a pass; the stream's catch-up of the persisted
            // cases leaves it out, so the error the page loaded stays.
            error: d.error !== undefined ? d.error : existing.error,
            stepEvents: d.stepEvents ?? existing.stepEvents,
            wastedTimeMs: d.wastedTimeMs ?? existing.wastedTimeMs,
            workerIndex: d.workerIndex ?? existing.workerIndex,
            parallelIndex: d.parallelIndex ?? existing.parallelIndex,
            shardIndex: d.shardIndex ?? existing.shardIndex,
            startedAt: d.startedAt ? d.startedAt : existing.startedAt,
            browser: d.browser ?? existing.browser,
            // A later attempt's retry count and attempt history win, so a
            // fail-then-pass test ends up flaky rather than a plain pass.
            retries: d.retries ?? existing.retries,
            attempts: d.attempts ?? existing.attempts,
            // The real ids replace the placeholder once persistence happens;
            // a duplicate event without ids keeps whatever the row already has.
            executionId: d.executionId ?? existing.executionId,
            testCaseId: d.testCaseId ?? existing.testCaseId,
            tags: d.tags ?? existing.tags,
            locks: d.locks ?? existing.locks,
            testMeta: d.testMeta ?? existing.testMeta,
            // The attempt's annotations: a skip ended at a stop reads so on its row and in the header's count.
            testAnnotations: d.testAnnotations !== undefined ? d.testAnnotations : existing.testAnnotations,
            // The cluster the attempt's failure joined, so the row is filed under it at once.
            failureClusterId: d.failureClusterId !== undefined ? d.failureClusterId : existing.failureClusterId,
          };
          liveTestCases.value = copy;
          showLive();
        }
      } else {
        liveTestCaseKeys.set(key, true);
        liveTestCases.value = [...liveTestCases.value, completedRow()];
        showLive();
      }
    } else if (parsed.type === 'step-begin') {
      const d = parsed.data as {
        title: string;
        subtitle?: string | null;
        stepCategory?: string | null;
        parentTitle?: string | null;
        workerIndex?: number;
        shardIndex?: number | null;
        startedAt?: number | null;
      };
      // Suite-level hooks (no worker) keep flowing to the timeline instead.
      if (d.workerIndex == null) continue;
      liveSteps.value = {
        ...liveSteps.value,
        [liveWorkerKey({ shard: d.shardIndex ?? null, worker: d.workerIndex })]: {
          title: d.title,
          subtitle: d.subtitle ?? null,
          category: d.stepCategory ?? null,
          status: undefined,
          parentTitle: d.parentTitle ?? null,
          startedAt: d.startedAt ?? null,
        },
      };
    } else if (parsed.type === 'step-end') {
      const d = parsed.data as {
        title: string;
        subtitle?: string | null;
        stepCategory?: string | null;
        parentTitle?: string | null;
        status?: string;
        workerIndex?: number;
        shardIndex?: number | null;
        startedAt?: number | null;
      };
      if (d.workerIndex == null) continue;
      // Keep the ended step visible (with its outcome) until the next step
      // begins, so the readout shows "last thing this worker did".
      liveSteps.value = {
        ...liveSteps.value,
        [liveWorkerKey({ shard: d.shardIndex ?? null, worker: d.workerIndex })]: {
          title: d.title,
          subtitle: d.subtitle ?? null,
          category: d.stepCategory ?? null,
          status: d.status ?? 'passed',
          parentTitle: d.parentTitle ?? null,
          startedAt: d.startedAt ?? null,
        },
      };
    } else if (parsed.type === 'live-worker') {
      const worker = data as unknown as LiveWorkerState;
      const next = { ...liveWorkers.value };
      if (worker.connected) {
        next[liveWorkerKey(worker)] = worker;
        liveWorkerSeen.value = true;
      } else delete next[liveWorkerKey(worker)];
      liveWorkers.value = next;
    } else if (parsed.type === 'live-view') {
      const state = data as unknown as LiveViewRunState;
      // A key opens the run's live view only while the project has it on.
      liveViewKeyed.value = state.keyed === true && state.enabled !== false;
      liveViewState.value = state;
      // Catch-up starts with the view state and then its current workers.
      if (parsed.seq === 0 || !liveViewKeyed.value) liveWorkers.value = {};
    } else if (parsed.type === 'live-ask') {
      // The viewer's own ask to watch the run changed: the developer answered, or a worker of the run streams.
      if (liveViewState.value) liveViewState.value = { ...liveViewState.value, ask: data as unknown as LiveAskView };
    } else if (parsed.type === 'continued') {
      followContinuation((data as { runId?: unknown }).runId);
    } else if (parsed.type === 'resources') {
      liveResources.value = applyLiveResourcesToParts(liveResources.value, data as unknown as WireLiveResources);
    } else if (parsed.type === 'run-finalizing') {
      // Tests are done, reports/traces are uploading — show progress bar
      isFinalizing.value = true;
    } else if (parsed.type === 'run-finished') {
      onRunEnded();
    }
  }
}

/** The run ended: the page leaves its live state, reads the run again and waits for its reports, once. */
function onRunEnded(): void {
  if (liveRunEnded.value) return;
  // Events still waiting for the batch are of the run that ended.
  pendingEvents = [];
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  isFinalizing.value = false;
  liveRunEnded.value = true;
  liveSteps.value = {};
  liveWorkers.value = {};
  liveLanes.value = {};
  liveViewKeyed.value = false;
  liveViewState.value = null;
  disconnectStream();
  // A run read running again (one its reporter revived) is live again, and its next end runs as the first did.
  void reloadRun().then((result) => {
    if (result === 'answered' && testRun.value?.status === 'running') liveRunEnded.value = false;
  });
  // Nudge the Changes tab to refetch — it keeps its own fetch state and
  // would otherwise show stale/partial data from before the run finalized.
  runRefreshKey.value++;
  pollForReports();
}

// The reporter may upload HTML/Monocart reports and traces after the run
// finishes: the page reads the run again a few times so they appear without a
// manual refresh, and stops when it leaves.
const reportsPoll = useReportsPoll(reloadRun);

function pollForReports(): void {
  if (isDemoMode) return; // demo mode has no file uploads
  reportsPoll.start();
}

function enqueueEvent(event: Record<string, unknown>) {
  pendingEvents.push(event);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPendingEvents, 200);
}

// Demo mode: live events arrive over a BroadcastChannel from the service
// worker instead of an SSE stream (see app/demo/run-events.ts).
let demoUnsubscribe: (() => void) | null = null;

function connectToDemoStream() {
  if (demoUnsubscribe) return;

  // Seed liveTestCases from persisted data so existing cases are visible
  // immediately with correct ids, browser, startedAt, etc.
  if (testRun.value?.testCases?.length) {
    seedLiveFromPersisted(testRun.value.testCases);
  }

  // The service worker answers the catch-up the server's stream sends (the stored executions, then the tests still
  // running); the live events heard meanwhile wait behind it, so a test that completed since is not shown running again.
  let heldEvents: Record<string, unknown>[] | null = [];
  const unsubscribe = subscribeDemoEvents((message) => {
    if (message.scope === 'run' && message.runId === Number(runId)) {
      const event = message.event as unknown as Record<string, unknown>;
      if (heldEvents) heldEvents.push(event);
      else enqueueEvent(event);
    }
  });
  demoUnsubscribe = unsubscribe;
  void $fetch<{ events?: Record<string, unknown>[] }>(`/api/test-runs/${runId}/stream`)
    .catch(() => ({ events: [] }))
    .then((catchUp) => {
      if (demoUnsubscribe !== unsubscribe) return;
      // The demo's catch-up sends no `init`: the lanes it sends are all the page holds.
      liveLanes.value = {};
      for (const event of [...(catchUp.events ?? []), ...(heldEvents ?? [])]) enqueueEvent(event);
      heldEvents = null;
    });
}

function connectToStream() {
  if (!import.meta.client || pageLeft) return;
  // A run that streams again is live again: its next end runs as the first did.
  liveRunEnded.value = false;

  if (isDemoMode) {
    connectToDemoStream();
    return;
  }

  if (eventSource) return;
  if (!isLive.value) return;

  // Seed liveTestCases from persisted data so existing cases are visible
  // immediately with correct ids, browser, startedAt, etc.
  if (testRun.value?.testCases?.length) {
    seedLiveFromPersisted(testRun.value.testCases);
  }

  const source = new EventSource(`${baseURL}/api/test-runs/${runId}/stream`);
  eventSource = source;
  streamStall.arm();

  source.onopen = () => {
    liveViewConnected.value = true;
    stopWatchingForStall();
    liveViewState.value = null;
    reopener.reset();
  };

  source.onmessage = (event) => {
    try {
      enqueueEvent(JSON.parse(event.data) as Record<string, unknown>);
    } catch {
      // Ignore parse errors
    }
  };

  source.onerror = () => {
    liveViewConnected.value = false;
    if (eventSource === source) streamStall.arm(STREAM_RECONNECT_STALL_MS);
    // EventSource reconnects by itself, unless an error answer closed it for good.
    if (source.readyState === EventSource.CLOSED && eventSource === source) reopenStream();
  };
}

// The browser gives up on a stream whose reconnection gets an error answer (a proxy's 502 while the instance restarts,
// an expired session): the page reads the run again and opens the stream again, waiting longer each time. While the
// instance does not answer, the page keeps the run it shows, says the stream stalled, and tries again later. A run
// deleted, a session ended or an access removed stops the tries: `reloadRun` says why (`runReadEnded`).
const reopener = streamReopener(reloadRun, () => {
  if (shouldStream.value) connectToStream();
});

function reopenStream() {
  eventSource?.close();
  eventSource = null;
  reopener.schedule();
}

function disconnectStream() {
  liveViewConnected.value = false;
  stopWatchingForStall();
  reopener.reset();
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (demoUnsubscribe) {
    demoUnsubscribe();
    demoUnsubscribe = null;
  }
}

// Retry, from the toolbar of a stalled stream: a new stream, whose catch-up brings the run's state.
function retryStream() {
  disconnectStream();
  connectToStream();
}

// A run shown as initializing is refetched once it starts, and then streams.
// In demo mode the page already listens while the run initializes, for the
// tests that begin before the refetch lands.
useRunStart(Number(runId), () => testRun.value?.status, reloadRun);
const shouldStream = computed(() => isLive.value || (isDemoMode && testRun.value?.status === 'initializing'));

watch(
  shouldStream,
  (live) => {
    if (live) {
      connectToStream();
    } else {
      disconnectStream();
    }
  },
  { immediate: true },
);

// Leaving drops a reopening that waits or reads the run: it opens no stream after, nor does a read that answers late.
onUnmounted(() => {
  pageLeft = true;
  if (testsRanTimer) clearTimeout(testsRanTimer);
  if (followTimer) clearTimeout(followTimer);
  disconnectStream();
});

// Throttled version for child components that don't need frame-perfect reactivity.
// It starts from the cases the page rendered with, so the server and the
// browser render the same timeline, and each later frame takes the latest list.
let rafId: number | null = null;
const throttledTestCases = ref<TestCaseResult[]>(displayTestCases.value);

watch(displayTestCases, (val) => {
  if (!import.meta.client) {
    throttledTestCases.value = val;
    return;
  }
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    throttledTestCases.value = displayTestCases.value;
    rafId = null;
  });
});
onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
});

// Display progress: the header counts, the count bar and the grouped list are
// all derived from the same de-duplicated case list (one row per test, its
// final attempt), so they cannot disagree — clicking a bar segment always lands
// on exactly that many rows. A flaky test passed after an earlier attempt
// failed, so it counts as passed and as flaky, never as a failure. While
// live the planned suite size the reporter reports at /start is the denominator
// (right from the first render); once finished the persisted case list is
// complete. The stored run columns are only a fallback for a run whose cases are
// not loaded.
const displayProgress = computed(() => {
  if (!testRun.value) return null;
  const cases = dedupedDisplayCases.value;
  if (isLive.value || cases.length > 0) {
    const s = summarizeRunCases(cases);
    return {
      totalTests: Math.max(testRun.value.totalTests ?? 0, s.total),
      passedTests: s.passed,
      failedTests: s.failed,
      skippedTests: s.skipped,
      fixmeTests: s.fixme,
      endedAtStopTests: s.endedAtStop,
      didNotRunTests: s.didNotRun,
      flakyTests: s.flaky,
      interruptedTests: s.interrupted,
    };
  }
  return {
    totalTests: testRun.value.totalTests,
    passedTests: testRun.value.passedTests,
    failedTests: testRun.value.failedTests,
    skippedTests: testRun.value.skippedTests,
    fixmeTests: 0,
    endedAtStopTests: 0,
    didNotRunTests: testRun.value.didNotRunTests ?? 0,
    flakyTests: testRun.value.flakyTests ?? 0,
    interruptedTests: 0,
  };
});

// While the run is in flight the browser tab shows its progress: a badge on the
// favicon and the progress ahead of the title. Done and failed are the header's
// counts; the total is the planned suite size only, so a run that has not
// reported one shows as running without a share done.
const tabIndicator = useTabRunIndicator(() => {
  const run = testRun.value;
  const p = displayProgress.value;
  if (!run || !p) return null;
  return {
    live: isLive.value,
    status: run.status,
    done: p.passedTests + p.failedTests + p.skippedTests + p.didNotRunTests,
    total: plannedTotal.value ?? run.totalTests ?? 0,
    failed: p.failedTests,
  };
});

// A cancelled run (a new run from the same reporter instance replaced it) is
// announced on the global stream only, never on its own, so refetch on it to
// leave the live state. The global stream is closed while the tab is hidden, so
// a live run is also refetched when the tab comes back.
useRunEvents((event) => {
  if (event.runId !== Number(runId)) return;
  // A run shared after this one from the same editor window continues it: the page follows, live or ended.
  if (event.type === 'run-continued') return followContinuation(event.continuedInId);
  if (!isLive.value) return;
  // A cancel comes on the global stream alone; an end, on it too while the run's own stream is not open. The demo's
  // own stream always hears the end.
  if (event.type === 'run-cancelled') reloadRun();
  else if (isDemoMode || liveViewConnected.value) return;
  else if (event.type === 'run-finished' || event.type === 'run-submitted') onRunEnded();
  else if (event.type === 'run-finalizing') reloadRun();
});
const visibility = useDocumentVisibility();
watch(visibility, (state) => {
  if (state === 'visible' && isLive.value) reloadRun();
});

useHead(
  computed(() => {
    // The tab title names the run and its project (display label first); on
    // the page the breadcrumb carries the project.
    const project = testRun.value?.project?.label || testRun.value?.project?.name;
    return {
      title: tabRunTitle(`Test run #${runId}${project ? ` — ${project}` : ''} — Piwi Dashboard`, tabIndicator.value),
    };
  }),
);

const runToDelete = computed(() => [{ id: Number(runId), keptAt: testRun.value?.keptAt ?? null }]);

// A plain-text run summary for the navbar's Copy run summary action.
function buildRunSummary(): string {
  const run = testRun.value;
  if (!run) return '';
  // Count from the same source as the header so the copied summary matches what
  // is on screen; fall back to the stored columns when the cases aren't loaded.
  const p = displayProgress.value;
  return runSummaryText({
    id: run.id,
    status: run.status,
    label: run.label,
    project: run.project?.label ?? run.project?.name ?? '',
    duration: run.duration,
    total: p?.totalTests ?? run.totalTests ?? 0,
    passed: p?.passedTests ?? run.passedTests ?? 0,
    failed: p?.failedTests ?? run.failedTests ?? 0,
    skipped: p?.skippedTests ?? run.skippedTests ?? 0,
    fixme: p?.fixmeTests ?? 0,
    endedAtStop: p?.endedAtStopTests ?? 0,
    flaky: p?.flakyTests ?? run.flakyTests ?? 0,
    didNotRun: p?.didNotRunTests ?? run.didNotRunTests ?? 0,
    interrupted: p?.interruptedTests ?? 0,
  });
}

// Test-cases filter state — lifted here so it survives tab switches, and kept
// for the page so it is still there when the user comes back to the run.
const testCaseSearch = useViewState('run-tests:search', () => '');
// A search the address carries (a stuck test's notification opens its row this way) wins over the kept one,
// then leaves the address, so the user's own searches are not overridden by it later.
watch(
  () => route.query.search,
  (search) => {
    if (typeof search !== 'string') return;
    testCaseSearch.value = search;
    if (import.meta.client) void replaceQuery(router, { search: undefined });
  },
  { immediate: true },
);
const testCaseActiveStatuses = useViewState<string[]>('run-tests:statuses', () => []);

// The count-bar segments toggle the status filters the Tests list applies, and
// switch to the Tests tab so the filtered rows are on screen.
function handleFilterStatus(status: string) {
  if (!status || status === 'all') {
    testCaseActiveStatuses.value = [];
  } else {
    testCaseActiveStatuses.value = testCaseActiveStatuses.value.includes(status)
      ? testCaseActiveStatuses.value.filter((s) => s !== status)
      : [...testCaseActiveStatuses.value, status];
  }
  activeTab.value = 'test-cases';
}

// Reports from the files table
const allReports = computed<ReportInfo[]>(() => testRun.value?.reports || []);

// Total wasted time across all displayed test cases (live or persisted)
const totalWastedTime = computed(() => {
  const cases = displayTestCases.value;
  if (!cases) return 0;
  return cases.reduce((sum, tc) => sum + (tc.wastedTimeMs ?? 0), 0);
});

const activeTab = ref('test-cases');

const hasFailures = computed(() => (displayProgress.value?.failedTests ?? 0) > 0);

// A run whose only problem is flakiness has no failures — the change tabs still
// have content, so they stay enabled whenever there are failures OR flaky tests.
const showFailureTabs = computed(() => hasFailures.value || (testRun.value?.flakyTests ?? 0) > 0);

// Cluster names + triage status for the row chips and the cluster group headers,
// taken from the same failure-groups payload. Fetched whenever the failure tabs
// become available: a flaky-only run has no failedTests yet still has clusters,
// and a live run can gain its first failure mid-stream.
const clusterMeta = ref<RunClusterMeta>({});

async function fetchClusterMeta() {
  if (!import.meta.client) return;
  try {
    const r = await $fetch<{ items: FailureGroup[] }>(`/api/test-runs/${runId}/failure-groups`);
    // Over what the live events named, so a cluster a failure joined after the read began keeps its label.
    clusterMeta.value = {
      ...clusterMeta.value,
      ...Object.fromEntries(
        r.items.map((g) => [
          g.clusterId,
          { name: g.title || `Cluster #${g.clusterId}`, status: g.status ?? null, issue: g.knownIssue ?? null },
        ]),
      ),
    };
  } catch {
    // chips fall back to plain cluster ids, headers to no triage badge
  }
}

// Clusters a live failure names first are read once, together: one read for the clusters that appear within a second.
const NEW_CLUSTER_READ_MS = 1000;
let newClusterTimer: ReturnType<typeof setTimeout> | null = null;
function readNewClusterMeta() {
  if (!import.meta.client || newClusterTimer) return;
  newClusterTimer = setTimeout(() => {
    newClusterTimer = null;
    void fetchClusterMeta();
  }, NEW_CLUSTER_READ_MS);
}
onUnmounted(() => {
  if (newClusterTimer) clearTimeout(newClusterTimer);
});

watch(
  showFailureTabs,
  (show) => {
    if (show) fetchClusterMeta();
  },
  { immediate: true },
);

// A read asked from outside the page (the assistant, once a proposal is applied) goes through the page's own reads,
// which keep what it shows when they fail.
usePageReload(() => Promise.all([reloadRun(), reloadQuarantine(), showFailureTabs.value ? fetchClusterMeta() : null]));

// Increments when a live run finishes, so child tabs that keep their own
// fetch state can refetch instead of showing stale pre-finish data.
const runRefreshKey = ref(0);

// A finishing run can grow its failure-groups payload (new clusters); refetch
// the display names so newly-appearing chips are labelled.
watch(runRefreshKey, () => {
  if (showFailureTabs.value) fetchClusterMeta();
});

/** The cases the workers timeline draws: while the run is live, the latest list once per frame. */
const timelineCases = computed(() => (isLive.value ? throttledTestCases.value : displayTestCases.value));
/** The Timeline tab's count: the lanes the timeline lays out, the workers its header counts. */
const timelineLanes = computed(() => timelineLaneCount(timelineCases.value));

/** The run's final attempts with a video: the Video tab's count, and it stays off when there are none. */
const videoCount = computed(() => testRun.value?.videoCount ?? 0);

const tabItems = computed(() => [
  {
    label: `Tests (${dedupedDisplayCases.value.length})`,
    icon: 'i-lucide-beaker',
    value: 'test-cases',
    slot: 'test-cases',
  },
  {
    label: 'Changes',
    icon: 'i-lucide-git-compare-arrows',
    value: 'changes',
    slot: 'changes',
    disabled: isLive.value,
    disabledReason: isLive.value ? 'available once the run finishes' : undefined,
  },
  {
    label: `Timeline${timelineLanes.value > 0 ? ` (${timelineLanes.value})` : ''}`,
    icon: 'i-lucide-timeline',
    value: 'workers',
    slot: 'workers',
  },
  {
    label: !isLive.value && videoCount.value > 0 ? `Video (${videoCount.value})` : 'Video',
    icon: 'i-lucide-video',
    value: 'video',
    slot: 'video',
    disabled: isLive.value || videoCount.value === 0,
    disabledReason: isLive.value
      ? 'available once the run finishes'
      : videoCount.value === 0
        ? 'no videos in this run'
        : undefined,
  },
  ...(testRun.value?.hasResources
    ? [{ label: 'Resources', icon: 'i-lucide-cpu', value: 'resources', slot: 'resources' }]
    : []),
]);

const tabPanelClass: Record<string, string> = {
  'test-cases': 'overflow-hidden flex flex-col',
};

// The former Failure clusters tab is now the Tests tab's cluster grouping;
// `?tab=failure-groups` lands there. The grouping cookie is written client-side
// so the list opens grouped by cluster.
if (route.query.tab === 'failure-groups') {
  activeTab.value = 'test-cases';
  if (import.meta.client) {
    document.cookie = 'piwi-group-by-run-tests=cluster; path=/; max-age=31536000; sameSite=lax';
    onMounted(() => {
      const query = { ...route.query };
      delete query.cluster;
      query.tab = 'test-cases';
      router.replace({ query });
    });
  }
}

// Deep-links naming the insights, regression or compare tab open the Changes
// tab, and endpoints opens the Tests tab (slow endpoints are on the project
// page), so shared URLs land somewhere sensible.
const LEGACY_TAB_REDIRECTS: Record<string, string> = {
  insights: 'changes',
  regression: 'changes',
  compare: 'changes',
  endpoints: 'test-cases',
};
if (typeof route.query.tab === 'string' && LEGACY_TAB_REDIRECTS[route.query.tab]) {
  const target = LEGACY_TAB_REDIRECTS[route.query.tab]!;
  activeTab.value = target;
  if (import.meta.client) {
    onMounted(() => {
      router.replace({ query: { ...route.query, tab: target } });
    });
  }
}

// Deep-link the active tab via ?tab= so run views can be shared and cross-page
// links land on the right tab. The Changes tab is disabled while a run is live,
// so validate against the currently *enabled* tabs.
const runTabValues = computed(() => tabItems.value.filter((t) => !t.disabled).map((t) => t.value));
if (typeof route.query.tab === 'string' && runTabValues.value.includes(route.query.tab)) {
  activeTab.value = route.query.tab;
}
// A link to this run from the page itself (an assistant answer, the command
// palette) changes only the query, so the tab follows it: the tab it names,
// the one a legacy value lands on, else the Tests tab.
watch(
  () => route.query.tab,
  (raw) => {
    const value = typeof raw === 'string' ? (LEGACY_TAB_REDIRECTS[raw] ?? raw) : '';
    activeTab.value = runTabValues.value.includes(value) ? value : 'test-cases';
  },
);
watch(runTabValues, (vals) => {
  if (!vals.includes(activeTab.value)) activeTab.value = 'test-cases';
});
watch(activeTab, (tab) => {
  const query = { ...route.query };
  delete query.cluster;
  query.tab = tab;
  if (JSON.stringify(query) === JSON.stringify({ ...route.query })) return;
  router.replace({ query });
});

// Ref for TestCasesList to call scrollToCase
const testCasesListRef: {
  value: { scrollToCase: (id: number) => void } | null;
} = ref(null);

function handleSelectTestCase(id: number) {
  activeTab.value = 'test-cases';
  // The timeline lists every attempt, but the Tests list shows one row per test
  // (its final attempt), so redirect a non-final attempt's id to its test's row.
  const source = displayTestCases.value.find((tc) => tc.executionId === id);
  const rowId =
    source && source.testCaseId > 0
      ? (dedupedDisplayCases.value.find(
          (tc) =>
            tc.testCaseId === source.testCaseId &&
            (tc.browser?.projectName ?? '') === (source.browser?.projectName ?? ''),
        )?.executionId ?? id)
      : id;
  nextTick(() => {
    testCasesListRef.value?.scrollToCase(rowId);
  });
}

// ── Navbar More menu ────────────────────────────────────────────────────────
const moreMenuItems = computed(() => {
  const items: {
    label: string;
    icon: string;
    color?: 'error';
    disabled?: boolean;
    'data-tour'?: string;
    onSelect: () => void;
  }[] = [];
  items.push({
    label: 'Copy run summary',
    icon: 'i-lucide-clipboard',
    onSelect: () => copy(buildRunSummary(), { toast: 'Run summary copied' }),
  });
  items.push({ label: 'Refresh', icon: 'i-lucide-refresh-cw', onSelect: () => reloadRunAsked() });
  const kept = !!testRun.value?.keptAt;
  if (!kept) {
    items.push({
      label: 'Keep forever…',
      icon: 'i-lucide-lock',
      'data-tour': 'run-keep',
      onSelect: () => (isKeepOpen.value = true),
    });
  } else if (canRelease(testRun.value?.projectId)) {
    items.push({
      label: 'Release keep',
      icon: 'i-lucide-lock-open',
      onSelect: async () => {
        if (await releaseKeep(Number(runId))) await reloadRunAsked();
      },
    });
  }
  // Its requester deletes their own requested run, as anyone with run:delete deletes any run.
  const ownRequestedRun =
    testRun.value?.origin === 'request' &&
    testRun.value.requesterId != null &&
    testRun.value.requesterId === authState.value.user?.id &&
    can('run:request', testRun.value.projectId);
  if (can('run:delete', testRun.value?.projectId) || ownRequestedRun) {
    // A kept run cannot be deleted until it is released.
    items.push({
      label: kept ? 'Delete run (release it first)' : 'Delete run',
      icon: 'i-lucide-trash-2',
      color: 'error',
      disabled: kept,
      onSelect: () => (isDeleteConfirmOpen.value = true),
    });
  }
  return items;
});
</script>

<template>
  <!-- The run page, and the live view docked beside it while someone watches a worker. -->
  <div class="flex min-h-0 min-w-0 flex-1">
    <UDashboardPanel id="test-run-detail" :ui="{ root: 'lg:not-last:border-e-0' }">
      <template #header>
        <!-- The breadcrumb's current crumb is the page title; a navbar title would repeat it. -->
        <UDashboardNavbar>
          <template #leading>
            <UDashboardSidebarCollapse />
            <BreadcrumbNav
              :items="[
                { label: 'Home', icon: 'i-lucide-house', to: '/' },
                { label: 'Projects', to: '/projects' },
                ...(testRun?.project?.id
                  ? [
                      {
                        label: testRun.project.label || testRun.project.name || 'Project',
                        to: `/projects/${testRun.project.id}`,
                        slot: 'project',
                      },
                    ]
                  : [{ label: 'Project' }]),
                { label: `Run #${runId}` + (testRun?.label ? ` — ${testRun.label}` : '') },
              ]"
            >
              <template #project="{ item }">
                <NuxtLink
                  :to="item?.to"
                  class="text-sm font-medium text-[var(--ui-text-muted)] hover:text-[var(--ui-text)] transition-colors"
                >
                  {{ item?.label }}
                </NuxtLink>
                <RunFreshnessPill
                  class="ml-1"
                  :latest-run-id="latestRunId"
                  :current-run-id="Number(runId)"
                  :is-active="isLatestRunActive"
                />
              </template>
            </BreadcrumbNav>
          </template>
          <template #right>
            <div class="flex items-center shrink-0 min-w-0">
              <ExportMenu
                :endpoint="`/api/test-runs/${runId}/export`"
                :perfetto-endpoint="`/api/test-runs/${runId}/perfetto`"
                :base-name="`piwi-run-${runId}`"
                class="mr-1"
              />
              <UDropdownMenu :items="moreMenuItems">
                <UButton
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-ellipsis-vertical"
                  aria-label="More actions"
                  title="More actions"
                  data-tour="run-more-actions"
                />
              </UDropdownMenu>
            </div>
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <DetailPageLayout
          v-model="activeTab"
          :tab-items="tabItems"
          :tab-panel-class="tabPanelClass"
          :fit-tabs="['video']"
        >
          <template #summary>
            <UAlert
              v-if="runReadEndedView"
              color="warning"
              variant="subtle"
              icon="i-lucide-circle-alert"
              :title="runReadEndedView.title"
              :description="runReadEndedView.description"
              :actions="runReadEndedActions"
              class="mb-4 max-sm:rounded-none max-sm:border-x-0"
              data-testid="run-read-ended"
              data-shot="run-read-ended"
              :data-state="runReadEnded"
            />
            <RunHeader
              v-if="testRun"
              :test-run="testRun"
              :display-progress="displayProgress"
              :all-reports="allReports"
              :finalizing="isFinalizing"
              :live-cases="isLive ? dedupedDisplayCases : null"
              :active-statuses="testCaseActiveStatuses"
              :total-wasted-time="totalWastedTime"
              :stopped="runReadEnded !== null"
              @toggle-status="handleFilterStatus"
              @label-updated="reloadRunAsked"
            />
            <p
              v-if="continuedRoute"
              class="mt-3 text-sm text-highlighted leading-relaxed max-sm:px-4"
              data-testid="run-continued"
              data-shot="run-continued"
            >
              Continued in
              <NuxtLink
                :to="continuedRoute"
                class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
                >run #{{ continuedInId }}</NuxtLink
              >
            </p>
            <DesktopRunHome v-if="isDesktop && isLive && testRun" :run-id="testRun.id" :sessions="desktopSessions" />
            <DesktopEditorRunNote v-if="isLive && editorRunsHere.length" :runs="editorRunsHere" />
          </template>

          <template #tab-test-cases>
            <RunWatchAll
              v-if="watchAll && offersWatchAll"
              class="mb-3 max-h-[45svh] shrink-0 overflow-y-auto"
              :workers="watchAllWorkers"
              :tiles="live.images.value"
              :steps="liveSteps"
              :running="runningRows"
              :lanes="lanesNow"
              :signals="attentionNow"
              :focused="watchOpen ? watching : null"
              :state="live.state.value"
              :demo="isDemoMode"
              @focus="chooseWorker"
              @retry="live.resume()"
            />
            <TestCasesList
              ref="testCasesListRef"
              data-shot="failure-clusters"
              data-tour="run-tests"
              v-model:search="testCaseSearch"
              v-model:active-statuses="testCaseActiveStatuses"
              :test-cases="dedupedDisplayCases"
              :is-live="isLive"
              :total="displayProgress?.totalTests"
              :waiting-since="
                !runReadEnded && (testRun?.status === 'initializing' || testRun?.status === 'running')
                  ? testRun?.startTime
                  : null
              "
              :hears-run="liveViewConnected || isDemoMode"
              :live-steps="liveSteps"
              :live-resources="liveResources"
              :live-workers="liveWorkers"
              :live-note="liveNote"
              :desktop-sessions="isLive ? desktopSessions : null"
              :cluster-meta="clusterMeta"
              :quarantined-case-ids="quarantinedCaseIds"
              :project-key="testRun?.projectId"
              :project-name="testRun?.project?.name"
              :run-id="Number(runId)"
              class="flex-1 min-h-0"
              @quarantine-changed="reloadQuarantine"
              @watch="chooseWorker"
            >
              <template #toolbar-extra>
                <UButton
                  v-if="offersWatchAll"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-layout-grid"
                  label="Watch all"
                  :class="watchAll ? PRESSED_TOGGLE_CLASS : ''"
                  :aria-pressed="watchAll"
                  title="Show every running worker's page as a tile"
                  data-testid="watch-all-toggle"
                  @click="watchAll = !watchAll"
                />
                <RunLiveViewStatus
                  v-if="testRun?.status === 'running' && !isFinalizing && !liveRunEnded && !runReadEnded"
                  :project-id="testRun.projectId"
                  :run-id="testRun.id"
                  :readiness="{
                    desktop: isDesktop,
                    demo: isDemoMode,
                    connected: liveViewConnected,
                    stalled: liveStreamStalled,
                    state: liveViewState,
                    ci: !!testRun.metadata?.ci,
                    workers: Object.keys(liveWorkers).length,
                    testsWithoutWorkers: testsRanLong && !liveWorkerSeen,
                  }"
                  @retry="retryStream"
                />
              </template>
            </TestCasesList>
          </template>

          <template #tab-changes>
            <ChangesView
              data-tour="run-changes"
              :test-run="testRun"
              :test-cases="displayTestCases"
              :cluster-meta="clusterMeta"
              :project-key="testRun?.projectId"
              :project-name="testRun?.project?.name"
              :refresh-key="runRefreshKey"
            />
          </template>

          <template #tab-workers>
            <div class="space-y-6" data-tour="run-workers">
              <WorkersTimeline
                :test-cases="timelineCases"
                :setup-steps="testRun?.setupSteps ?? null"
                :shard-total="testRun?.shardTotal ?? null"
                :live="isLive"
                :wasted-patterns="testRun?.wastedWaitPatterns ?? null"
                :run-id="Number(runId)"
                :has-resources="testRun?.hasResources ?? false"
                :live-resources="liveResources"
                @select-test-case="handleSelectTestCase"
              />
              <RunTimelineExtras
                v-if="!isLive"
                :test-cases="displayTestCases"
                :cluster-meta="clusterMeta"
                :project-key="testRun?.projectId"
                :project-name="testRun?.project?.name"
              />
            </div>
          </template>

          <template #tab-video>
            <RunVideoTab data-tour="run-video" :run-id="Number(runId)" />
          </template>

          <template #tab-resources>
            <RunResources
              data-tour="run-resources"
              :run-id="Number(runId)"
              :project-key="testRun?.projectId"
              :project-name="testRun?.project?.name"
              :refresh-key="runRefreshKey"
              @open-timeline="activeTab = 'workers'"
            />
          </template>
        </DetailPageLayout>
      </template>
    </UDashboardPanel>
    <ClientOnly>
      <LanePanel
        v-if="watching"
        v-model:open="watchOpen"
        :take-focus="watchAsked"
        :run-id="Number(runId)"
        :worker="watching.worker"
        :shard="watching.shard"
        :slot="watching.slot"
        :test="watching.test"
        :execution-id="watching.executionId"
        :verdict="runVerdict"
        :step="watchedStep"
        :project-key="testRun?.projectId"
        :project-name="testRun?.project?.name"
        :live="live"
        :moved-why="movedWhy"
        v-model:attention="followAttention"
      />
    </ClientOnly>
  </div>

  <ClientOnly>
    <RunKeepModal v-model:open="isKeepOpen" :run-id="Number(runId)" @kept="reloadRunAsked" />
  </ClientOnly>

  <ClientOnly>
    <RunsDeleteModal
      v-model:open="isDeleteConfirmOpen"
      :runs="runToDelete"
      @deleted="navigateTo(`/projects/${testRun?.project?.id}`)"
    />
  </ClientOnly>
</template>

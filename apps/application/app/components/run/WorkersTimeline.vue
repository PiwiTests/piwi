<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue';
import type { TestCaseResult, SetupStepEvent, PerformanceStep } from '~~/types/api';
import type { RunExecutionCost, RunResourceTimeline, RunResourceTimelinePart } from '#shared/handlers/run-resources';
import type { UsualDuration } from '#shared/handlers/stuck-tests';
import { runningUsualDurationTest, usualDurationKey } from '#shared/stuck-tests';
import { storedUsualDurationTest } from '~~/server/utils/storable-values';
import type { SeriesPoint } from '#shared/types';
import {
  useTimelineModel,
  isHookKind,
  isShownItem,
  isTestSection,
  type TimelineItem,
} from '~/composables/useTimelineModel';
import { useTimelineViewport } from '~/composables/useTimelineViewport';
import {
  livePlotEnd,
  liveRunNow,
  TIMELINE_HOOK_COLORS,
  TIMELINE_LAYOUT,
  TIMELINE_PAUSE_COLORS,
} from '~/utils/timeline';
import {
  ALL_RESOURCE_TRACKS,
  RESOURCE_TRACK_KINDS,
  WORKER_METRICS,
  availableWorkerMetrics,
  buildResourceBands,
  buildWorkerStrips,
  layOutTimelineRows,
  shownTracks,
  type ResourceBand,
  type ResourceTrackKind,
  type ResourceTrackVisibility,
  type WorkerMetricKind,
  type WorkerStrip,
  type WorkerStripSet,
} from '~/utils/resource-tracks';
import {
  buildSpanTails,
  leftOpenAcross,
  leftOpenPages,
  minSteps,
  type RowTails,
  type SpanTail,
} from '~/utils/resource-spans';

const props = defineProps<{
  testCases: TestCaseResult[];
  setupSteps?: SetupStepEvent[] | null;
  shardTotal?: number | null;
  live?: boolean;
  /** Allowlist of glob patterns classifying which waits count as wasted time. */
  wastedPatterns?: string[] | null;
  /** The run, for its resources over time. */
  runId?: number | null;
  /** Whether a reporter of the run sent resources; the tracks are fetched only then, once the run ended. */
  hasResources?: boolean;
  /** What the run's reporters measured so far, drawn while the run is live. */
  liveResources?: RunResourceTimelinePart[] | null;
}>();

const emit = defineEmits<{
  selectTestCase: [id: number];
}>();

// Which test rows are expanded into their step waterfall, and the steps fetched
// for them (loaded on demand — the run payload omits the heavy `steps` column).
const expandedExecutions = ref(new Set<number>());
const stepsByExecution = ref(new Map<number, PerformanceStep[]>());
const stepsLoading = new Set<number>();

// Each test's usual duration in the run's project, by `usualDurationKey`: the ghost behind its running attempt. Read
// once while the run is live.
const usualDurations = shallowRef<Map<string, number> | null>(null);
async function loadUsualDurations(): Promise<void> {
  if (!props.live || !props.runId || usualDurations.value) return;
  try {
    const res = await $fetch<{ tests: UsualDuration[] }>(`/api/test-runs/${props.runId}/usual-durations`);
    usualDurations.value = new Map(res.tests.map((test) => [usualDurationKey(test), test.usualMs]));
  } catch {
    // The running bars go without their ghost.
  }
}
onMounted(loadUsualDurations);
watch(
  () => props.runId,
  () => (usualDurations.value = null),
);
watch(() => [props.runId, props.live], loadUsualDurations);

// The usual durations are keyed by each test's names as its rows store them; a running attempt's begin event sends
// them as the test named them. Each running test whose stored names differ (a NUL dropped, a long identity shortened,
// `storedUsualDurationTest`) is learned once, and its usual duration is also kept under the key of its sent names.
const storedKeyOf = new Map<string, string | null>();
const sentKeyAliases = shallowRef<ReadonlyMap<string, string>>(new Map());
async function learnStoredKeys(testCases: readonly TestCaseResult[]): Promise<void> {
  const learned: [string, string][] = [];
  await Promise.all(
    testCases.map(async (tc) => {
      if (tc.status !== 'running') return;
      const sent = runningUsualDurationTest(tc);
      const sentKey = usualDurationKey(sent);
      if (storedKeyOf.has(sentKey)) return;
      storedKeyOf.set(sentKey, null);
      try {
        const storedKey = usualDurationKey(await storedUsualDurationTest(sent));
        storedKeyOf.set(sentKey, storedKey);
        if (storedKey !== sentKey) learned.push([sentKey, storedKey]);
      } catch {
        // Without a hash (Web Crypto needs a secure context), the test goes without its ghost.
      }
    }),
  );
  if (learned.length) sentKeyAliases.value = new Map([...sentKeyAliases.value, ...learned]);
}
watch(
  () => (props.live && usualDurations.value ? props.testCases : null),
  (testCases) => {
    if (testCases) void learnStoredKeys(testCases);
  },
  { immediate: true },
);
const usualDurationsBySentKey = computed<ReadonlyMap<string, number> | null>(() => {
  const usual = usualDurations.value;
  if (!usual || sentKeyAliases.value.size === 0) return usual;
  const map = new Map(usual);
  for (const [sentKey, storedKey] of sentKeyAliases.value) {
    const usualMs = usual.get(storedKey);
    if (usualMs !== undefined) map.set(sentKey, usualMs);
  }
  return map;
});

// The run's clock while it is live, read every second once mounted: the browser's, unless the results put the run's
// ahead of it (`liveRunNow`).
const browserNow = ref<number | null>(null);
let clock: ReturnType<typeof setInterval> | null = null;
function runClock(live: boolean | undefined): void {
  if (clock) clearInterval(clock);
  clock = null;
  browserNow.value = live ? Date.now() : null;
  if (live) clock = setInterval(() => (browserNow.value = Date.now()), 1000);
}
onMounted(() => runClock(props.live));
watch(() => props.live, runClock);
onBeforeUnmount(() => runClock(false));
const heard = shallowRef<{ at: number; seenAt: number } | null>(null);
const runNow = computed(() => (browserNow.value === null ? null : liveRunNow(browserNow.value, heard.value)));

// Tests and expanded step spans are always drawn (expanding a row is itself the
// request to see its steps). Hook sections are drawn by default and a failed
// one is drawn even with hooks off; wasted waits are drawn on request.
const showHooks = ref(true);
const showWaits = ref(false);

// Getter-based input so useTimelineModel keeps tracking the component props and
// the expansion refs reactively (a spread would snapshot them).
const modelInput = {
  get testCases() {
    return props.testCases;
  },
  get setupSteps() {
    return props.setupSteps;
  },
  get wastedPatterns() {
    return props.wastedPatterns;
  },
  get expandedExecutions() {
    return expandedExecutions.value;
  },
  get stepsByExecution() {
    return stepsByExecution.value;
  },
  get live() {
    return props.live;
  },
  get now() {
    return props.live ? runNow.value : null;
  },
  get usualDurations() {
    return usualDurationsBySentKey.value;
  },
  get showHooks() {
    return showHooks.value;
  },
};

const {
  timelineData,
  settledData,
  hooksByTest,
  workerRows,
  laneCount,
  maxTime,
  origin,
  knownUntil,
  runLocks,
  lockColorMap,
  barLockColors,
  usualUntil,
} = useTimelineModel(modelInput);

// The latest moment the results tell, and when this page heard it: the run's clock goes on from there.
watch(
  knownUntil,
  (at) => {
    if (at !== null && (heard.value === null || at > heard.value.at)) heard.value = { at, seenAt: Date.now() };
  },
  { immediate: true },
);

// Where a live run's plot ends: some way past now on its clock and past where each running test usually ends, moved
// on once either reaches it.
const liveEnd = ref(0);
watch([runNow, origin, usualUntil], ([now, zero, usualEnd]) => {
  if (now === null || zero === null) {
    liveEnd.value = 0;
    return;
  }
  const reach = Math.max(now - zero, usualEnd);
  if (reach > liveEnd.value) liveEnd.value = livePlotEnd(reach);
});

// The resources each reporter measured over time, and what each execution
// cost: while the run is live, what its reporters posted so far; once it
// ended, the stored report, and what was posted live until it loads.
const storedParts = ref<RunResourceTimelinePart[]>([]);
const resourceParts = computed(() =>
  props.live || storedParts.value.length === 0 ? (props.liveResources ?? []) : storedParts.value,
);
const executionCosts = ref<RunExecutionCost[]>([]);
async function loadResources(): Promise<void> {
  if (!props.runId || props.live || !props.hasResources) {
    storedParts.value = [];
    executionCosts.value = [];
    return;
  }
  try {
    const res = await $fetch<RunResourceTimeline>(`/api/test-runs/${props.runId}/resource-timeline`);
    storedParts.value = res.parts ?? [];
    executionCosts.value = res.executions ?? [];
  } catch {
    storedParts.value = [];
    executionCosts.value = [];
  }
}
onMounted(loadResources);
watch(() => [props.runId, props.live, props.hasResources], loadResources);

const sharded = computed(() => (props.shardTotal ?? 0) > 1);

// Which tracks are shown above the rows, and which metric the strip under each
// worker draws: per-browser preferences, every track and no strip until changed.
const trackVisibility = useLocalStorage<ResourceTrackVisibility>(
  'piwi-timeline-resource-tracks',
  { ...ALL_RESOURCE_TRACKS },
  { initOnMounted: true, mergeDefaults: true, writeDefaults: false },
);
const workerMetric = useLocalStorage<WorkerMetricKind | 'none'>('piwi-timeline-worker-strip', 'none', {
  initOnMounted: true,
  writeDefaults: false,
});

const resourceBands = computed<ResourceBand[]>(() =>
  origin.value === null || resourceParts.value.length === 0
    ? []
    : buildResourceBands(resourceParts.value, workerRows.value, origin.value, sharded.value),
);

// What each worker kept open for nothing, as tails under its row: shown until
// the viewer turns them off, a per-browser preference.
const showLeaks = useLocalStorage('piwi-timeline-leaks', true, { initOnMounted: true, writeDefaults: false });
const spanRows = computed<RowTails[]>(() =>
  origin.value === null || resourceParts.value.length === 0
    ? []
    : buildSpanTails(resourceParts.value, workerRows.value, origin.value, sharded.value),
);
const spanCounts = computed(() => {
  const counts = { leaked: 0, lingering: 0 };
  for (const row of spanRows.value) for (const tail of row.tails) counts[tail.verdict]++;
  return counts;
});
const shownSpanRows = computed(() => (showLeaks.value ? spanRows.value : []));
/** The pages left open in each row, by its first lane, never above the pages open in it. */
const leftOpenByLane = computed(() => {
  const openByLane = new Map<number, SeriesPoint[]>();
  for (const band of resourceBands.value) {
    for (const worker of band.workers) if (worker.lane !== null) openByLane.set(worker.lane, worker.points);
  }
  return new Map(
    shownSpanRows.value.map(
      (row) => [row.lane, minSteps(leftOpenPages(row.tails), openByLane.get(row.lane) ?? [])] as const,
    ),
  );
});
/** The pages left open in each band's workers, by the band's key. */
const leftOpenByBand = computed(() => {
  const out = new Map<string, SeriesPoint[]>();
  for (const band of resourceBands.value) {
    const shard = workerRows.value.find((row) => row.baseLane === band.firstLane)?.shardIndex;
    const lanes = new Set(workerRows.value.filter((row) => row.shardIndex === shard).map((row) => row.baseLane));
    const left = leftOpenAcross(shownSpanRows.value.filter((row) => lanes.has(row.lane)));
    const series = minSteps(left, band.tracks.pages?.points ?? []);
    if (series.length > 0) out.set(band.key, series);
  }
  return out;
});
function leftOpenFor(band: ResourceBand): SeriesPoint[] | null {
  return leftOpenByBand.value.get(band.key) ?? null;
}

/**
 * Where the plot ends: the last test's end, and while the run is live, past
 * now on its clock, where the running tests usually end and the last resource
 * point read, so the running tests, their usual time and what they use show too.
 */
const plotEnd = computed(() => {
  let end = maxTime.value;
  if (!props.live) return end;
  end = Math.max(end, liveEnd.value);
  for (const band of resourceBands.value) {
    for (const track of Object.values(band.tracks)) end = Math.max(end, track?.points.at(-1)?.[0] ?? 0);
    for (const tree of band.sampled) {
      end = Math.max(end, tree.cpuCores.at(-1)?.[0] ?? 0, tree.memoryBytes.at(-1)?.[0] ?? 0);
    }
  }
  return end;
});

/** The tracks the header offers: those some band has data for, with whether they are shown. */
const resourceTrackOptions = computed(() =>
  RESOURCE_TRACK_KINDS.filter(({ kind }) => resourceBands.value.some((band) => band.tracks[kind])).map((k) => ({
    kind: k.kind,
    label: k.menuLabel,
    shown: trackVisibility.value[k.kind] !== false,
  })),
);

function toggleTrack(kind: ResourceTrackKind): void {
  trackVisibility.value = { ...trackVisibility.value, [kind]: trackVisibility.value[kind] === false };
}

/** The metrics the strip under each worker can draw for this run, with the one chosen. */
const workerMetricOptions = computed(() => {
  const available = availableWorkerMetrics(resourceBands.value, executionCosts.value);
  return WORKER_METRICS.filter((m) => available.includes(m.kind)).map((m) => ({
    kind: m.kind,
    label: m.menuLabel,
    shown: workerMetric.value === m.kind,
  }));
});

const testItems = computed(() => timelineData.value.filter((item) => item.kind === 'test'));
/** The test bars as the results tell them, a running one at its start: the same array as the clock ticks. */
const settledTests = computed(() => settledData.value.filter((item) => item.kind === 'test'));

const workerStrips = computed<WorkerStripSet | null>(() => {
  const kind = workerMetric.value;
  if (kind === 'none' || !workerMetricOptions.value.some((m) => m.kind === kind)) return null;
  return buildWorkerStrips(kind, {
    rows: workerRows.value,
    bands: resourceBands.value,
    tests: settledTests.value,
    costs: executionCosts.value,
    sharded: sharded.value,
    leftOpen: leftOpenByLane.value,
  });
});

/** Each band with the tracks it draws and its height; a band whose tracks are all off takes no room. */
const bandLayout = computed(() =>
  resourceBands.value
    .map((band) => {
      const tracks = shownTracks(band, trackVisibility.value);
      const { trackHeight, trackGap, bandGap } = TIMELINE_LAYOUT;
      return { band, tracks, height: tracks.length > 0 ? tracks.length * (trackHeight + trackGap) + bandGap : 0 };
    })
    .filter((entry) => entry.height > 0),
);

/** Where each lane, band and strip sits. */
const rowsLayout = computed(() =>
  layOutTimelineRows(workerRows.value, {
    bandHeights: new Map(bandLayout.value.map((entry) => [entry.band.firstLane, entry.height])),
    tailHeights: new Map(
      shownSpanRows.value.map((row) => [row.lane, row.levels * (TIMELINE_LAYOUT.tailHeight + TIMELINE_LAYOUT.tailGap)]),
    ),
    strips: workerStrips.value !== null,
    stripHeight: TIMELINE_LAYOUT.stripHeight,
    rowHeight: TIMELINE_LAYOUT.rowHeight,
    rowGap: TIMELINE_LAYOUT.rowGap,
    axisHeight: TIMELINE_LAYOUT.axisHeight,
  }),
);

/** Height of what sits above a lane besides the lanes before it: the bands and strips. */
function laneOffset(lane: number): number {
  const top = rowsLayout.value.laneTop[lane];
  return top === undefined ? 0 : top - (lane * TIMELINE_LAYOUT.rowHeight + TIMELINE_LAYOUT.axisHeight);
}
const extraHeight = computed(
  () => rowsLayout.value.height - (laneCount.value * TIMELINE_LAYOUT.rowHeight + TIMELINE_LAYOUT.axisHeight),
);

function bandTop(entry: { band: ResourceBand }): number {
  return rowsLayout.value.bandTop.get(entry.band.firstLane) ?? TIMELINE_LAYOUT.axisHeight;
}

/** Y of the tails under the row whose first lane is `lane`. */
function tailTop(lane: number): number | null {
  const index = workerRows.value.findIndex((row) => row.baseLane === lane);
  return index < 0 ? null : (rowsLayout.value.rows[index]?.tailTop ?? null);
}

/** Y of the strip under the row whose first lane is `lane`. */
function stripTop(lane: number): number | null {
  const index = workerRows.value.findIndex((row) => row.baseLane === lane);
  return index < 0 ? null : (rowsLayout.value.rows[index]?.stripTop ?? null);
}

/** The tracks a band draws, for the readout. */
function tracksFor(band: ResourceBand) {
  return bandLayout.value.find((entry) => entry.band.key === band.key)?.tracks ?? [];
}

const expandedCount = computed(() => expandedExecutions.value.size);

/** A test row can be expanded when it is a persisted execution and the run is not live. */
function barExpandable(item: TimelineItem): boolean {
  return item.kind === 'test' && !props.live && (item.testCaseId ?? 0) > 0;
}

async function toggleExpand(id: number): Promise<void> {
  if (expandedExecutions.value.has(id)) {
    const next = new Set(expandedExecutions.value);
    next.delete(id);
    expandedExecutions.value = next;
    return;
  }
  // Frame the test's own span — at run-fit zoom its steps are sub-pixel.
  const testItem = timelineData.value.find((d) => d.kind === 'test' && d.testCaseId === id);
  await expandSteps(id, testItem ? [testItem.start, testItem.start + testItem.duration] : null);
}

/**
 * A click on a hook section opens its test's steps framed on the hook, so the
 * `beforeAll`, `afterEach` and fixtures it ran, and the one that failed, are
 * legible. A test that cannot expand (a live run) opens its page instead.
 */
async function inspectHook(item: TimelineItem): Promise<void> {
  const id = item.testCaseId;
  if (id == null) return;
  const testItem = timelineData.value.find((d) => d.kind === 'test' && d.testCaseId === id);
  if (!testItem || !barExpandable(testItem)) {
    emit('selectTestCase', id);
    return;
  }
  await expandSteps(id, [item.start, item.start + Math.max(item.duration, 1)]);
}

/** Expand a test row into its step waterfall (fetching the steps once), framing `range` when given. */
async function expandSteps(id: number, range: [number, number] | null): Promise<void> {
  if (!expandedExecutions.value.has(id)) {
    const next = new Set(expandedExecutions.value);
    next.add(id);
    expandedExecutions.value = next;
  }
  if (range) zoomToRange(range[0], range[1]);

  if (stepsByExecution.value.has(id) || stepsLoading.has(id)) return;
  stepsLoading.add(id);
  try {
    const res = await $fetch<{ steps: PerformanceStep[] }>(`/api/test-run-cases/${id}/steps`);
    const map = new Map(stepsByExecution.value);
    map.set(id, res.steps ?? []);
    stepsByExecution.value = map;
  } catch {
    // Leave the row expanded but empty; toggling it again retries the fetch.
  } finally {
    stepsLoading.delete(id);
  }
}

function collapseAll(): void {
  expandedExecutions.value = new Set();
}

const hasLocks = computed(() => runLocks.value.length > 0);
const showLocks = ref(false);

/** A bar with no lock brackets: one shared array, so an unchanged bar keeps equal props and skips re-rendering. */
const NO_LOCK_COLORS: string[] = [];

/** The colors for one bar's locks, in the run's stable lock order. */
function lockColorsFor(item: TimelineItem): string[] {
  if (!showLocks.value || item.kind !== 'test') return NO_LOCK_COLORS;
  return barLockColors.value.get(item.key) ?? NO_LOCK_COLORS;
}

const containerRef = ref<HTMLElement | null>(null);
const rowCount = computed(() => laneCount.value);
const hasData = computed(() => timelineData.value.length > 0);

const {
  renderRange,
  panX,
  pxPerMs,
  isPanning,
  contentWidth,
  contentHeight,
  getBarX,
  getBarWidth,
  getBarTop,
  tickMarks,
  onWheel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  resetView,
  zoomToRange,
} = useTimelineViewport({
  containerRef,
  maxTime: plotEnd,
  rowCount,
  hasData,
  live: () => props.live,
  laneOffset,
  extraHeight,
});

// Header counts, from the items as the results tell them: tests (an attempt
// Playwright retried is not another test), retries, hook sections that failed,
// wasted waits.
const retryCount = computed(() => settledTests.value.filter((d) => d.retried).length);
const testCount = computed(() => settledTests.value.length - retryCount.value);
const hasHooks = computed(() => settledData.value.some((d) => isHookKind(d.kind)));
const hookFailureCount = computed(
  () => settledData.value.filter((d) => isHookKind(d.kind) && d.status === 'failed').length,
);
const waitCount = computed(() => settledData.value.filter((d) => d.kind === 'wait').length);
const pauseCount = computed(() => settledData.value.filter((d) => d.kind === 'pause').length);
const restartCount = computed(() => settledData.value.filter((d) => d.kind === 'restart').length);

const visibleItems = computed(() =>
  timelineData.value.filter((item) => isShownItem(item, { hooks: showHooks.value, waits: showWaits.value })),
);

/** A test with no hook section drawn: one shared array, so its bar keeps equal props. */
const NO_HOOKS: TimelineItem[] = [];

/** The width of a running attempt's usual duration, its ghost; none for every other bar. */
function ghostWidth(item: TimelineItem): number | undefined {
  return item.status === 'running' && item.usualMs != null ? item.usualMs * pxPerMs.value : undefined;
}

/** While a sharded run is live, the shards that have a test on the timeline. */
const shardsStarted = computed(() =>
  props.live && sharded.value
    ? [...new Set(workerRows.value.flatMap((row) => (row.shardIndex == null ? [] : [row.shardIndex])))]
    : null,
);
const stuckCount = computed(() => settledTests.value.filter((d) => d.stuck).length);

// Only the bars near the viewport are drawn: zoomed in on a large run, most of
// them are off-screen, and every zoom step would re-position each one.
const barItems = computed(() => {
  const { start, end } = renderRange.value;
  return visibleItems.value.filter(
    (item) => !isTestSection(item) && item.start <= end && item.start + item.duration >= start,
  );
});

/** Test bars by key, to find the attempts of a test that ran more than once. */
const testsByKey = computed(() => new Map(testItems.value.map((item) => [item.key, item])));

/** A test with no other attempt: one shared array. */
const NO_ATTEMPTS: TimelineItem[] = [];

/** Every attempt of the item's test, first attempt first; empty when it ran once. */
function attemptsFor(item: TimelineItem): TimelineItem[] {
  if (!item.attemptKeys) return NO_ATTEMPTS;
  const map = testsByKey.value;
  return item.attemptKeys.flatMap((key) => map.get(key) ?? []);
}

/**
 * The test's hook sections and stops (`hooksByTest`), drawn by its bar rather than as bars of their own, so a section
 * costs no component when the view zooms.
 */
function hooksFor(item: TimelineItem): TimelineItem[] {
  return item.kind === 'test' && item.testCaseId != null
    ? (hooksByTest.value.get(item.testCaseId) ?? NO_HOOKS)
    : NO_HOOKS;
}

/** A hook section at its true width: the bars' 3px floor would cover a short test's body. */
function hookGeometry(item: TimelineItem): { x: number; width: number } {
  return { x: getBarX(item), width: item.duration * pxPerMs.value };
}

// Hover state, driven by the bars' hover events and read only by the tooltip
// and the focus overlay. The template passes the object itself, never its
// fields, so a hover or a mouse move re-renders those two and not the bars.
const hover = reactive<{ item: TimelineItem | null; pos: { x: number; y: number } }>({
  item: null,
  pos: { x: 0, y: 0 },
});

// Re-resolve the hovered item by key when the data changes: a removed bar
// fires no mouseleave (span-type toggled off, live update dropped it), which
// would otherwise strand the tooltip; a replaced bar carries fresh data the
// tooltip should reflect.
watch(visibleItems, (items) => {
  if (!hover.item) return;
  hover.item = items.find((item) => item.key === hover.item!.key) ?? null;
});

function onBarEnter(item: TimelineItem, event: MouseEvent) {
  hover.item = item;
  hover.pos = { x: event.clientX, y: event.clientY };
}

function onBarMove(event: MouseEvent) {
  hover.pos = { x: event.clientX, y: event.clientY };
}

function onBarLeave() {
  hover.item = null;
}

// The moment under the pointer in a resource band, read only by the readout
// and the line across the rows, like the bars' hover state.
const resourceHover = reactive<{
  band: ResourceBand | null;
  strip: { set: WorkerStripSet; strip: WorkerStrip } | null;
  t: number;
  pos: { x: number; y: number };
}>({ band: null, strip: null, t: 0, pos: { x: 0, y: 0 } });

watch([bandLayout, workerStrips], ([layout, strips]) => {
  if (resourceHover.band && !layout.some((entry) => entry.band.key === resourceHover.band!.key)) {
    resourceHover.band = null;
  }
  if (resourceHover.strip && resourceHover.strip.set !== strips) resourceHover.strip = null;
});

function moveResourceHover(t: number, event: MouseEvent): void {
  resourceHover.t = Math.max(0, Math.min(plotEnd.value, t));
  resourceHover.pos = { x: event.clientX, y: event.clientY };
}

function onResourceHover(band: ResourceBand, t: number, event: MouseEvent): void {
  resourceHover.band = band;
  resourceHover.strip = null;
  moveResourceHover(t, event);
}

function onStripHover(strip: WorkerStrip, t: number, event: MouseEvent): void {
  if (!workerStrips.value) return;
  resourceHover.band = null;
  resourceHover.strip = { set: workerStrips.value, strip };
  moveResourceHover(t, event);
}

function onResourceLeave(): void {
  resourceHover.band = null;
  resourceHover.strip = null;
}

// The tail under the pointer, read only by its tooltip, like the bars' hover state.
const spanHover = reactive<{ tail: SpanTail | null; pos: { x: number; y: number } }>({
  tail: null,
  pos: { x: 0, y: 0 },
});
watch(shownSpanRows, () => {
  spanHover.tail = null;
});

function onSpanHover(tail: SpanTail, event: MouseEvent): void {
  spanHover.tail = tail;
  spanHover.pos = { x: event.clientX, y: event.clientY };
}

function onSpanLeave(): void {
  spanHover.tail = null;
}

/**
 * Open the test an object outlived or lingered in: on its worker's row, the
 * test the span names, nearest to where the tail starts; without a name, the
 * test running when a lingering object was last used, or for a leak the test
 * that ended last before the leak's start.
 */
function selectSpanTest(tail: SpanTail): void {
  const onRow = testItems.value.filter((item) => item.rowIndex === tail.lane && item.testCaseId != null);
  const distance = (item: TimelineItem) => {
    const end = item.start + item.duration;
    return tail.start < item.start ? item.start - tail.start : tail.start > end ? tail.start - end : 0;
  };
  const named = tail.test ? onRow.filter((item) => item.title === tail.test!.title) : [];
  const before = onRow.filter((item) => item.start <= tail.start);
  const host =
    named.sort((a, b) => distance(a) - distance(b))[0] ??
    (tail.verdict === 'lingering'
      ? onRow.find((item) => distance(item) === 0)
      : before.sort((a, b) => b.start + b.duration - (a.start + a.duration))[0]);
  if (host?.testCaseId != null) emit('selectTestCase', host.testCaseId);
}
</script>

<template>
  <div v-if="timelineData.length > 0" class="relative select-none" data-shot="run-timeline" data-tour="run-timeline">
    <TimelineHeader
      :worker-count="workerRows.length"
      :shard-total="shardTotal"
      :test-count="testCount"
      :retry-count="retryCount"
      :hook-failure-count="hookFailureCount"
      :wait-count="waitCount"
      :pause-count="pauseCount"
      :restart-count="restartCount"
      :has-hooks="hasHooks"
      :show-hooks="showHooks"
      :show-waits="showWaits"
      :has-locks="hasLocks"
      :show-locks="showLocks"
      :lock-count="runLocks.length"
      :expanded-count="expandedCount"
      :live="live"
      :resource-tracks="resourceTrackOptions"
      :worker-metrics="workerMetricOptions"
      :left-open-count="spanCounts.leaked"
      :lingering-count="spanCounts.lingering"
      :show-leaks="showLeaks"
      :shards-started="shardsStarted"
      :stuck-count="stuckCount"
      @toggle-hooks="showHooks = $event"
      @toggle-waits="showWaits = $event"
      @toggle-locks="showLocks = $event"
      @toggle-leaks="showLeaks = $event"
      @toggle-resource="toggleTrack"
      @select-worker-metric="workerMetric = $event ?? 'none'"
      @collapse-all="collapseAll"
      @reset="resetView"
    />

    <!-- Legend for the lock brackets, shown only while locks are on. -->
    <div v-if="showLocks && hasLocks" class="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-xs text-gray-500">
      <span class="inline-flex items-center gap-1">
        <UIcon name="i-lucide-lock" class="size-3" />
        Locks
      </span>
      <span v-for="lock in runLocks" :key="lock" class="inline-flex items-center gap-1">
        <span class="inline-block h-2 w-3 rounded-sm" :style="{ backgroundColor: lockColorMap.get(lock) }" />
        {{ lock }}
      </span>
    </div>

    <div
      ref="containerRef"
      class="relative overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 touch-pan-y"
      :class="{ 'cursor-grab': !isPanning, 'cursor-grabbing': isPanning }"
      :style="{ height: contentHeight + 'px' }"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerUp"
    >
      <svg
        class="overflow-visible"
        :style="{ transform: `translateX(${panX}px)` }"
        :width="contentWidth"
        :height="contentHeight"
      >
        <defs>
          <!-- Hook time over a test bar: the status's wash under light diagonal stripes. -->
          <pattern
            v-for="(colors, status) in TIMELINE_HOOK_COLORS"
            :id="`timeline-hook-${status}`"
            :key="status"
            patternUnits="userSpaceOnUse"
            width="6"
            height="6"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" :fill="colors.fill" :fill-opacity="colors.opacity" />
            <rect width="2" height="6" fill="white" fill-opacity="0.35" />
          </pattern>
          <!-- A stop at the pause bar over its test's bar: a pale wash under upright stripes. -->
          <pattern id="timeline-paused" patternUnits="userSpaceOnUse" width="5" height="5">
            <rect
              width="5"
              height="5"
              :fill="TIMELINE_PAUSE_COLORS.fill"
              :fill-opacity="TIMELINE_PAUSE_COLORS.opacity"
            />
            <rect width="1.5" height="5" :fill="TIMELINE_PAUSE_COLORS.stripe" fill-opacity="0.35" />
          </pattern>
          <!-- Arrowhead of the arrows joining the attempts of a retried test. -->
          <marker
            id="timeline-retry-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" class="fill-gray-600 dark:fill-gray-300" />
          </marker>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <TimelineGrid
          :worker-rows="workerRows"
          :tick-marks="tickMarks"
          :content-width="contentWidth"
          :shard-total="shardTotal"
          :layout="rowsLayout"
        />

        <TimelineResourceBand
          v-for="entry in bandLayout"
          :key="entry.band.key"
          :band="entry.band"
          :tracks="entry.tracks"
          :y="bandTop(entry)"
          :px-per-ms="pxPerMs"
          :plot-width="plotEnd * pxPerMs"
          :left-open="leftOpenFor(entry.band)"
          @hover="onResourceHover"
          @leave="onResourceLeave"
        />

        <TimelineSpanTails
          v-if="shownSpanRows.length > 0"
          :rows="shownSpanRows"
          :tail-top="tailTop"
          :px-per-ms="pxPerMs"
          :plot-width="plotEnd * pxPerMs"
          @hover="onSpanHover"
          @leave="onSpanLeave"
          @select="selectSpanTest"
        />

        <TimelineWorkerStrips
          v-if="workerStrips"
          :set="workerStrips"
          :strip-top="stripTop"
          :px-per-ms="pxPerMs"
          :plot-width="plotEnd * pxPerMs"
          @hover="onStripHover"
          @leave="onResourceLeave"
        />

        <TimelineBar
          v-for="item in barItems"
          :key="item.key"
          :item="item"
          :x="getBarX(item)"
          :y="getBarTop(item)"
          :width="getBarWidth(item)"
          :lock-colors="lockColorsFor(item)"
          :expandable="barExpandable(item)"
          :hooks="hooksFor(item)"
          :hook-geometry="hookGeometry"
          :ghost-width="ghostWidth(item)"
          @select="emit('selectTestCase', $event)"
          @toggle-expand="toggleExpand($event)"
          @inspect-hook="inspectHook"
          @hover="onBarEnter"
          @move="onBarMove"
          @leave="onBarLeave"
        />

        <TimelineFocus
          :state="hover"
          :content-width="contentWidth"
          :content-height="contentHeight"
          :get-bar-x="getBarX"
          :get-bar-top="getBarTop"
          :get-bar-width="getBarWidth"
          :lock-colors="lockColorsFor"
          :expandable="barExpandable"
          :hooks="hooksFor"
          :hook-geometry="hookGeometry"
          :attempts="attemptsFor"
          :ghost-width="ghostWidth"
        />

        <TimelineResourceCursor :state="resourceHover" :px-per-ms="pxPerMs" :content-height="contentHeight" />
      </svg>
    </div>

    <TimelineTooltip :state="hover" :lock-color-map="lockColorMap" :attempts="attemptsFor" />
    <TimelineResourceTooltip :state="resourceHover" :tracks-for="tracksFor" :left-open-for="leftOpenFor" />
    <TimelineSpanTooltip :state="spanHover" />
  </div>
  <EmptyState v-else icon="i-lucide-rows-3" text="No worker data available for this run." />
</template>

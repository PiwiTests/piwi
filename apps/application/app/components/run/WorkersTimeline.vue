<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue';
import type { TestCaseResult, SetupStepEvent, PerformanceStep } from '~~/types/api';
import type { RunExecutionCost, RunResourceTimeline, RunResourceTimelinePart } from '#shared/handlers/run-resources';
import { useTimelineModel, isHookKind, type TimelineItem } from '~/composables/useTimelineModel';
import { useTimelineViewport } from '~/composables/useTimelineViewport';
import { lockColorHex, TIMELINE_HOOK_COLORS, TIMELINE_LAYOUT } from '~/utils/timeline';
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
}>();

const emit = defineEmits<{
  selectTestCase: [id: number];
}>();

// Which test rows are expanded into their step waterfall, and the steps fetched
// for them (loaded on demand — the run payload omits the heavy `steps` column).
const expandedExecutions = ref(new Set<number>());
const stepsByExecution = ref(new Map<number, PerformanceStep[]>());
const stepsLoading = new Set<number>();

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
};

const { timelineData, workerRows, laneCount, maxTime, origin, runLocks } = useTimelineModel(modelInput);

// The resources each reporter measured over time, and what each execution
// cost, fetched once the run ended.
const resourceParts = ref<RunResourceTimelinePart[]>([]);
const executionCosts = ref<RunExecutionCost[]>([]);
async function loadResources(): Promise<void> {
  if (!props.runId || props.live || !props.hasResources) {
    resourceParts.value = [];
    executionCosts.value = [];
    return;
  }
  try {
    const res = await $fetch<RunResourceTimeline>(`/api/test-runs/${props.runId}/resource-timeline`);
    resourceParts.value = res.parts ?? [];
    executionCosts.value = res.executions ?? [];
  } catch {
    resourceParts.value = [];
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

const workerStrips = computed<WorkerStripSet | null>(() => {
  const kind = workerMetric.value;
  if (kind === 'none' || !workerMetricOptions.value.some((m) => m.kind === kind)) return null;
  return buildWorkerStrips(kind, {
    rows: workerRows.value,
    bands: resourceBands.value,
    tests: testItems.value,
    costs: executionCosts.value,
    sharded: sharded.value,
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

// Lock name → its color (assigned by the run's sorted lock order, so a lock
// keeps its color across the brackets, the legend and the tooltip).
const lockColorMap = computed(() => {
  const map = new Map<string, string>();
  runLocks.value.forEach((lock, i) => map.set(lock, lockColorHex(i)));
  return map;
});
const hasLocks = computed(() => runLocks.value.length > 0);
const showLocks = ref(false);

/** A bar with no lock brackets: one shared array, so an unchanged bar keeps equal props and skips re-rendering. */
const NO_LOCK_COLORS: string[] = [];

/** The colors for one bar's locks, in the run's stable lock order. */
function lockColorsFor(item: TimelineItem): string[] {
  if (!showLocks.value || item.kind !== 'test' || !item.locks?.length) return NO_LOCK_COLORS;
  return runLocks.value.filter((lock) => item.locks!.includes(lock)).map((lock) => lockColorMap.value.get(lock)!);
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
  maxTime,
  rowCount,
  hasData,
  live: () => props.live,
  laneOffset,
  extraHeight,
});

// Header counts: tests (an attempt Playwright retried is not another test),
// retries, hook sections that failed, wasted waits.
const retryCount = computed(() => testItems.value.filter((d) => d.retried).length);
const testCount = computed(() => testItems.value.length - retryCount.value);
const hasHooks = computed(() => timelineData.value.some((d) => isHookKind(d.kind)));
const hookFailureCount = computed(
  () => timelineData.value.filter((d) => isHookKind(d.kind) && d.status === 'failed').length,
);
const waitCount = computed(() => timelineData.value.filter((d) => d.kind === 'wait').length);
const restartCount = computed(() => timelineData.value.filter((d) => d.kind === 'restart').length);

// Tests and expanded step spans are always drawn (expanding a row is itself the
// request to see its steps). Hook sections are drawn by default and a failed
// one is drawn even with hooks off; wasted waits are drawn on request.
const showHooks = ref(true);
const showWaits = ref(false);
const visibleItems = computed(() =>
  timelineData.value.filter((item) => {
    if (isHookKind(item.kind)) return showHooks.value || item.status === 'failed';
    if (item.kind === 'wait') return showWaits.value;
    return true;
  }),
);

/** A test with no hook section drawn: one shared array, so its bar keeps equal props. */
const NO_HOOKS: TimelineItem[] = [];

/** Whether an item is a test's hook section, which the test's own bar draws. */
function isTestHook(item: TimelineItem): boolean {
  return (item.kind === 'hook' || item.kind === 'fixture') && item.testCaseId != null;
}

// Each test's visible hook sections, drawn by the test's bar rather than as
// bars of their own, so a section costs no component when the view zooms.
const hooksByTest = computed(() => {
  const map = new Map<number, TimelineItem[]>();
  for (const item of visibleItems.value) {
    if (!isTestHook(item)) continue;
    const list = map.get(item.testCaseId!);
    if (list) list.push(item);
    else map.set(item.testCaseId!, [item]);
  }
  return map;
});
// Only the bars near the viewport are drawn: zoomed in on a large run, most of
// them are off-screen, and every zoom step would re-position each one.
const barItems = computed(() => {
  const { start, end } = renderRange.value;
  return visibleItems.value.filter(
    (item) => !isTestHook(item) && item.start <= end && item.start + item.duration >= start,
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
  resourceHover.t = Math.max(0, Math.min(maxTime.value, t));
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
      @toggle-hooks="showHooks = $event"
      @toggle-waits="showWaits = $event"
      @toggle-locks="showLocks = $event"
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
          :plot-width="maxTime * pxPerMs"
          @hover="onResourceHover"
          @leave="onResourceLeave"
        />

        <TimelineWorkerStrips
          v-if="workerStrips"
          :set="workerStrips"
          :strip-top="stripTop"
          :px-per-ms="pxPerMs"
          :plot-width="maxTime * pxPerMs"
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
        />

        <TimelineResourceCursor :state="resourceHover" :px-per-ms="pxPerMs" :content-height="contentHeight" />
      </svg>
    </div>

    <TimelineTooltip :state="hover" :lock-color-map="lockColorMap" :attempts="attemptsFor" />
    <TimelineResourceTooltip :state="resourceHover" :tracks-for="tracksFor" />
  </div>
  <EmptyState v-else icon="i-lucide-rows-3" text="No worker data available for this run." />
</template>

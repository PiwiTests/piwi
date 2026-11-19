<script setup lang="ts">
/**
 * The failure timeline: one SVG time axis that places this execution's steps,
 * console entries, network requests and backend log entries on the same clock,
 * with the moment of failure marked and a default window around the failed step.
 * Below the axis sits one steps table: each step carries its offset from the
 * failure (`t-N s`), its title (the failed step in the failed outcome color,
 * with its error) and its duration; network, console and backend items in the
 * same window are interleaved as their own rows in time order, a request with
 * its duration too. A duration is a number, a share of the test and a bar on the
 * test's clock, colored only when it stands out in the test or against its
 * usual time over the last passing runs (`#shared/duration-standout`, the
 * `usual` the timeline sends with each step and request). A step's parameters show when its title is
 * opened. The *Around the failure* / *Whole test* switch drives both the axis
 * and the table, and so does the type filter beside it: one chip per item type
 * in the window, keying its lane, the choice kept per browser. The axis draws
 * only the items in the window, a bar the window cuts ending in an arrow at the
 * cut edge, and the failing step always shows. A row the Most likely line cites
 * says so in meta text.
 *
 * The table reads the steps as Playwright's tree: a `test.step`'s steps sit
 * indented under it, and the hooks and fixtures that ran before and after the
 * test body fold into a Setup and a Teardown section — open when the failure
 * happened there. The step that failed is the innermost of the failing chain
 * that carries the execution's error; every step around it carries the failed
 * mark too. An error the test caught and went on from (a probe in a
 * `try`/`catch`, a retried `toPass` attempt) is shown muted, never as the
 * failure. The capture's own steps are never listed, and locations read
 * relative to the project.
 *
 * A passing execution has no failure moment: the axis is hidden and the table
 * lists every step without offsets.
 *
 * With the run's resource report, a **Resources** switch (off until the viewer
 * turns it on, the choice kept per browser) adds rows under the lanes on the
 * same clock: the CPU and memory of the worker that ran the test with the
 * browsers it started, and the pages open in that worker, each in its own color;
 * the failure line crosses them. While they show, a line follows the pointer
 * across the whole chart, the lanes included, with the moment on the axis and
 * each row's value beside it; a line under the axis says what the test
 * measured itself.
 *
 * A test that stood paused at an editor breakpoint keeps its clock: each stop
 * is a Paused band on the axis, a row of its own above the lanes and a hatched
 * shade across them, the bars read on the test's whole clock span, and a step
 * that ran across a stop says how long it stood paused, which its share and
 * its rule leave out. A request that ran during a stop keeps its clock time,
 * and its share reads against the test's clock span.
 *
 * The axis data comes pre-built from `/timeline` (the pure `buildFailureTimeline`);
 * step detail (error, params, duration) comes from the `steps` prop. Times
 * shown are relative to the failure moment (`t+0`), so the axis and the table read
 * against the same anchor.
 */
import type { FailureTimeline, TimelineItem, TimelineLane, TimelineLanes } from '#shared/failure-timeline';
import type { AttachmentInfo, PerformanceStep } from '~~/types/api';
import { useClusterSectionLocator } from '~/composables/useClusterSectionLocator';
import { useExecutionTimeline } from '~/composables/useExecutionTimeline';
import { useTraceFrames } from '~/composables/useTraceFrames';
import { useTimelinePageView } from '~/composables/useTimelinePageView';
import { useTimelineTypeFilter } from '~/composables/useTimelineTypeFilter';
import {
  TIMELINE_TYPES,
  TIMELINE_TYPE_META,
  effectiveHiddenTypes,
  isTimelineItemShown,
  timelineItemSeverity,
} from '~/utils/timeline-type-filter';
import SectionCard from '../shared/SectionCard.vue';
import ChartTooltip from '../shared/ChartTooltip.vue';
import ChartLegend from '../shared/ChartLegend.vue';
import OpenInIdeLink from '../shared/OpenInIdeLink.vue';
import StepLabel from './StepLabel.vue';
import StepStatusMark from './StepStatusMark.vue';
import StepParams from './StepParams.vue';
import TimelineDuration from './TimelineDuration.vue';
import TimelineTypeFilter from './TimelineTypeFilter.vue';
import TimelinePagePanel from './TimelinePagePanel.vue';
import TimelineToggle from './TimelineToggle.vue';
import { executionFailed } from '#shared/file-classify';
import { resolveLocationRoot, stepLocations, stripLocationRoot } from '#shared/locator-chain';
import { timelinePauseSpans, type TimelinePause } from '#shared/failure-timeline';
import type { StepFailureRole, StepPhase } from '#shared/step-tree';
import {
  barPlace,
  buildStepTreeView,
  citedItemIds,
  groupRowsBySection,
  sectionSummaryText,
  stepsTrack,
  testTrack,
  windowCutText,
  windowCuts,
  type BarPlace,
  type BarTrack,
  type TimelineCitation,
  type WindowCuts,
} from '~/utils/timeline-rows';
import type { LightboxImage, LightboxSubject } from '~/utils/lightbox';
import {
  MAX_SCREEN_LANES,
  clampFrameAspect,
  frameAspect,
  frameIndexAt,
  frameTiles,
  pageInFront,
  placeTraceFrames,
  stepFrames,
  subjectMoment,
  type PageSubject,
  type PageView,
  type PlacedFramePage,
} from '~/utils/timeline-frames';
import { orderedStepParams, pausedOverlap, stepLabel } from '@piwitests/core/step-analysis';
import { formatTimelineTime, pauseReasonText } from '~/utils/timeline';
import { RESOURCE_TRACK_COLOR, seriesPaths } from '~/utils/resource-tracks';
import { resourceFacts, timelineResourceRows } from '~/utils/timeline-resource-rows';

const props = defineProps<{
  testRunsCaseId: number;
  /** The execution's steps — the table's rows and the per-step share and bar. */
  steps: PerformanceStep[];
  /** The execution's total duration, for the per-step share of the test. */
  durationMs: number | null;
  /** Whether this execution failed — a passing one hides the axis and offsets. */
  hasError?: boolean;
  /** The execution's error text — tells the step that failed the test from an error it caught. */
  error?: string | null;
  /** Execution status — a did-not-run row shows a neutral step marker, and only a failed one marks a filmstrip step failed. */
  status?: string | null;
  /** The test's project-relative file — step locations read relative to the project it shows. */
  testFilePath?: string | null;
  /** The run's working directory (the Playwright config's folder) — the root step locations read relative to. */
  workingDir?: string | null;
  /** Piwi project id/name — passed to the open-in-IDE links for call sites. */
  projectKey?: string | number | null;
  projectName?: string | null;
  /** The execution's attachments — a failure screenshot binds to the failing step for pre-1.63 traces. */
  attachments?: AttachmentInfo[] | null;
  /** The execution's recovered failure-time ARIA tree — shown on the failing step when the trace has no per-action aria. */
  ariaSnapshot?: string | null;
  /** Drop the card frame and padding — render a plain heading row over the body. */
  embedded?: boolean;
  /** The test, named in the details of an enlarged screenshot. */
  subject?: LightboxSubject | null;
  /** What the Most likely line cites: the rows it names are marked. */
  cited?: TimelineCitation[] | null;
  /** The execution's stops at Piwi's pause bar, in epoch ms: the steps that ran across one say how long. */
  pauses?: Array<{ startedAt: number; duration: number }> | null;
}>();

// The axis only exists for a failure; a passing execution reads its steps off the
// prop and never needs the timeline build. The timeline is the one the evidence
// card shares with its Network tab; the cluster page swaps the execution in
// place, so a new one refetches the axis.
const { data: fetchedTimeline } = await useExecutionTimeline(
  () => props.testRunsCaseId,
  () => props.hasError !== false,
);
const data = computed<FailureTimeline | undefined>(() =>
  props.hasError !== false ? (fetchedTimeline.value ?? undefined) : undefined,
);

const locator = useClusterSectionLocator();

// The page section a timeline item's ref maps to. Backend log lines live under
// the network card, so they reveal it too; steps switch to the Steps tab.
const SECTION_ACTION: Record<TimelineItem['ref']['section'], string> = {
  steps: 'steps',
  console: 'console',
  networkRequests: 'networkRequests',
  backendLogs: 'networkRequests',
  dialogs: 'console',
};

// ── Placed items and lanes ───────────────────────────────────────────────────
const allItems = computed<TimelineItem[]>(() => {
  const tl = data.value;
  if (!tl) return [];
  return TIMELINE_TYPES.flatMap((lane) => tl.lanes[lane]);
});

const placedCount = computed(() => allItems.value.length);

// The rows the Most likely line cites say so.
const citedIds = computed(() => citedItemIds(allItems.value, props.cited ?? []));
function isCited(item: TimelineItem | null): boolean {
  return item != null && citedIds.value.has(item.id);
}

// The axis (and the offset column) exist only when there is a failure moment to
// anchor them and at least two items to place; a passing execution shows the
// bare steps table.
const hasFailure = computed(() => Boolean(props.hasError) && Boolean(data.value?.failedStep));
const showAxis = computed(() => hasFailure.value && placedCount.value >= 2);

// ── Window mode ──────────────────────────────────────────────────────────────
type WindowMode = 'around' | 'whole';
const mode = ref<WindowMode>('around');
const WINDOW_MODES: readonly { value: WindowMode; label: string }[] = [
  { value: 'around', label: 'Around the failure' },
  { value: 'whole', label: 'Whole test' },
];
// A range dragged across the axis replaces the window until a window is picked again or the axis double-clicked.
const zoom = ref<{ start: number; end: number } | null>(null);
watch(
  () => props.testRunsCaseId,
  () => (zoom.value = null),
);
function pickMode(value: WindowMode): void {
  mode.value = value;
  zoom.value = null;
}
const span = computed(() => (data.value ? Math.max(1, data.value.end - data.value.origin) : 1));
const domain = computed<{ start: number; end: number }>(() => {
  const tl = data.value;
  if (!tl) return { start: 0, end: 1 };
  if (zoom.value) return zoom.value;
  if (mode.value === 'whole') return { start: 0, end: span.value };
  // A degenerate window (no failed step, or zero-width) falls back to the whole run.
  const w = tl.window;
  return w.end > w.start ? { start: w.start, end: w.end } : { start: 0, end: span.value };
});

/** Whether an item overlaps the window — only those are drawn, listed and counted. */
function inWindow(item: TimelineItem): boolean {
  const { start, end } = domain.value;
  return item.at + (item.duration ?? 0) >= start && item.at <= end;
}

/** Every item in the window, in time order, whatever the type filter hides. */
const windowItems = computed<TimelineItem[]>(() =>
  allItems.value.filter(inWindow).sort((a, b) => a.at - b.at || (a.failed ? -1 : 0)),
);

// ── Type filter ──────────────────────────────────────────────────────────────
// One chip per type with items in the window, once there are two to choose
// between. The stored choice applies only while the chips are on screen, and
// only to the types they show.
const {
  hidden: storedHiddenTypes,
  toggle: toggleType,
  only: onlyType,
  showAll: showAllTypes,
} = useTimelineTypeFilter();
const windowTypes = computed<TimelineLane[]>(() =>
  TIMELINE_TYPES.filter((lane) => windowItems.value.some((item) => item.lane === lane)),
);
const showTypeFilter = computed(() => showAxis.value && windowTypes.value.length >= 2);
const hiddenTypes = computed<TimelineLane[]>(() =>
  showTypeFilter.value ? effectiveHiddenTypes(storedHiddenTypes.value, windowTypes.value) : [],
);
const hiddenTypeSet = computed(() => new Set(hiddenTypes.value));

function isShown(item: TimelineItem): boolean {
  return isTimelineItemShown(item, hiddenTypeSet.value);
}

/** The window's items that pass the type filter — the table's rows. */
const shownWindowItems = computed<TimelineItem[]>(() => windowItems.value.filter(isShown));

/** Each lane's items in the window that pass the type filter — what the axis draws. */
const shownLanes = computed<TimelineLanes>(() => {
  const lanes = data.value?.lanes;
  const keep = (items: TimelineItem[] | undefined) => (items ?? []).filter((item) => inWindow(item) && isShown(item));
  return {
    steps: keep(lanes?.steps),
    network: keep(lanes?.network),
    console: keep(lanes?.console),
    dialogs: keep(lanes?.dialogs),
    backend: keep(lanes?.backend),
  };
});
const visibleLanes = computed<TimelineLane[]>(() => TIMELINE_TYPES.filter((lane) => shownLanes.value[lane].length > 0));

// ── SVG geometry ─────────────────────────────────────────────────────────────
const LABEL_W = 62;
const PAD_R = 12;
const TOP = 8;
const LANE_H = 22;
const AXIS_H = 18;

const CALL_BAND_H = 16;
const PAUSE_BAND_H = 16;

const wrapper = ref<HTMLElement | null>(null);
const { width } = useElementSize(wrapper);
const svgWidth = computed(() => Math.max(0, width.value));
const plotLeft = LABEL_W;
const plotRight = computed(() => Math.max(plotLeft + 1, svgWidth.value - PAD_R));
const plotWidth = computed(() => plotRight.value - plotLeft);
// The "Calls" band sits above the lanes when at least one shown step has a call site, and the "Paused" band under it
// when a stop is in the window.
const hasCallBand = computed(() => shownLanes.value.steps.some((s) => s.origin != null || s.group != null));
const shownPauses = computed<TimelinePause[]>(() =>
  (data.value?.pauses ?? []).filter((p) => p.at + p.duration >= domain.value.start && p.at <= domain.value.end),
);
const hasPauseBand = computed(() => shownPauses.value.length > 0);
const pauseBandTop = computed(() => bandsTop.value + (hasCallBand.value ? CALL_BAND_H : 0));
const bandH = computed(() => (hasCallBand.value ? CALL_BAND_H : 0) + (hasPauseBand.value ? PAUSE_BAND_H : 0));
const lanesTop = computed(() => bandsTop.value + bandH.value);

// ── Screen lanes ─────────────────────────────────────────────────────────────
// The trace's screencast on top of the axis, one lane per page: each tile shows
// the page as it was at the tile's middle, dimmed when no new frame was painted
// since the tile before. Hovering a lane shows the page at that moment, a click
// opens the frames full screen there. On while the trace has frames, until the
// viewer turns it off (kept per browser).
const { data: framesData, frameUrl } = useTraceFrames(
  () => props.testRunsCaseId,
  () => showAxis.value,
);
const framePages = computed<PlacedFramePage[]>(() => {
  const tl = data.value;
  if (!tl) return [];
  return placeTraceFrames(framesData.value, { origin: tl.origin, testStart: tl.testStart }).slice(0, MAX_SCREEN_LANES);
});
const showScreen = useLocalStorage('piwi-failure-timeline-screen', true, { initOnMounted: true });
const screenOn = computed(() => showAxis.value && showScreen.value && framePages.value.length > 0);
/** The list is an even sample of the frames: no tile or line may say no new frame was painted. */
const framesSampled = computed(() => framesData.value?.capped === true);
const SCREEN_TILE_H = 44;
const SCREEN_LANE_H = SCREEN_TILE_H + 6;
const screenAspect = computed(() => frameAspect(framePages.value));
const bandsTop = computed(() => TOP + (screenOn.value ? framePages.value.length * SCREEN_LANE_H : 0));
function screenLaneTop(page: number): number {
  return TOP + page * SCREEN_LANE_H;
}
function screenLaneLabel(page: number): string {
  return framePages.value.length > 1 ? `Page ${page + 1}` : 'Screen';
}
const screenTiles = computed(() => {
  const count = Math.max(1, Math.floor(plotWidth.value / (SCREEN_TILE_H * screenAspect.value)));
  const w = plotWidth.value / count;
  return framePages.value.map((page) => {
    const shown = frameTiles(page.frames, domain.value, count);
    return shown.map((frame, i) => ({
      x: plotLeft + i * w,
      w,
      src: frame >= 0 ? frameUrl(page.frames[frame]!.name) : null,
      repeat: !framesSampled.value && i > 0 && frame === shown[i - 1],
    }));
  });
});

/** The innermost step running at a moment, as its label. */
function stepLabelAt(at: number): string | null {
  let best: TimelineItem | null = null;
  for (const step of data.value?.lanes.steps ?? []) {
    const d = step.duration ?? 0;
    if (step.at <= at && at <= step.at + d && (!best || d < (best.duration ?? 0))) best = step;
  }
  return best?.label ?? null;
}

/** The frame a page showed at the failure. */
function failureFrame(page: PlacedFramePage): number {
  return data.value ? frameIndexAt(page.frames, data.value.failureAt) : -1;
}

interface FrameHover {
  src: string;
  /** The moment under the pointer. */
  at: number;
  /** When the frame shown then was painted. */
  paintedAt: number;
  step: string | null;
  atFailure: boolean;
  aspect: number;
}
const hoveredFrame = ref<FrameHover | null>(null);
// Mutated in place: only the floating element reads its coordinates, so a pointer move redraws it alone.
const framePos = reactive({ x: 0, y: 0 });
const FRAME_PREVIEW_W = 260;
const FRAME_PREVIEW_H = 300;
/** Place a floating element beside the pointer, flipped to stay inside the window. */
function placeFloating(pos: { x: number; y: number }, event: MouseEvent, width: number, height: number): void {
  const margin = 8;
  let x = event.clientX + 14;
  if (x + width > window.innerWidth - margin) x = event.clientX - 14 - width;
  let y = event.clientY + 14;
  if (y + height > window.innerHeight - margin) y = event.clientY - 14 - height;
  pos.x = Math.max(margin, x);
  pos.y = Math.max(margin, y);
}
function hideFrame(): void {
  hoveredFrame.value = null;
}

/** The plot x of a pointer event, held to the plot. */
function plotXOf(event: MouseEvent): number {
  const svg = (event.currentTarget as Element).closest('svg');
  const box = svg?.getBoundingClientRect();
  const x = box ? event.clientX - box.left : plotLeft;
  return Math.max(plotLeft, Math.min(plotRight.value, x));
}
function atOfX(x: number): number {
  const { start, end } = domain.value;
  return start + ((x - plotLeft) / plotWidth.value) * (end - start);
}

function onScreenMove(event: MouseEvent, pageIndex: number): void {
  if (drag.active) return;
  const page = framePages.value[pageIndex];
  const x = plotXOf(event);
  const at = atOfX(x);
  const index = page ? frameIndexAt(page.frames, at) : -1;
  if (!page || index < 0) {
    hideFrame();
    return;
  }
  const frame = page.frames[index]!;
  placeFloating(framePos, event, FRAME_PREVIEW_W, FRAME_PREVIEW_H);
  if (hoveredFrame.value?.paintedAt === frame.at && hoveredFrame.value.src === frameUrl(frame.name)) {
    hoveredFrame.value.at = at;
    hoveredFrame.value.step = stepLabelAt(at);
    return;
  }
  hoveredFrame.value = {
    src: frameUrl(frame.name),
    at,
    paintedAt: frame.at,
    step: stepLabelAt(at),
    atFailure: index === failureFrame(page),
    aspect: clampFrameAspect(frame.width > 0 && frame.height > 0 ? frame.width / frame.height : screenAspect.value),
  };
}
function onScreenLeave(): void {
  hideFrame();
}

// The frames of one page full screen, from the one a click or a key picked.
const lightbox = ref<{ page: number; index: number } | null>(null);
const lightboxImages = computed<LightboxImage[]>(() => {
  const page = lightbox.value ? framePages.value[lightbox.value.page] : null;
  if (!page) return [];
  const atFailure = failureFrame(page);
  return page.frames.map((frame, i) => ({
    src: frameUrl(frame.name),
    name: `Page at ${formatRel(frame.at)}`,
    failed: i === atFailure,
    step: stepLabelAt(frame.at),
    error: i === atFailure ? props.error || null : null,
  }));
});
const lightboxIndex = computed<number | null>({
  get: () => lightbox.value?.index ?? null,
  set: (index) => (lightbox.value = index == null || !lightbox.value ? null : { ...lightbox.value, index }),
});
function openScreenAt(event: MouseEvent, pageIndex: number): void {
  const page = framePages.value[pageIndex];
  if (!page) return;
  hideFrame();
  lightbox.value = { page: pageIndex, index: Math.max(0, frameIndexAt(page.frames, atOfX(plotXOf(event)))) };
}
/** From the keyboard, a lane opens on the page at the failure. */
function openScreenAtFailure(pageIndex: number): void {
  const page = framePages.value[pageIndex];
  if (page) lightbox.value = { page: pageIndex, index: Math.max(0, failureFrame(page)) };
}

// ── Drag to zoom ─────────────────────────────────────────────────────────────
// A mouse drag across the plot zooms the axis and the table to the range it
// covers; the click that ends a drag opens nothing.
const drag = reactive({ from: null as number | null, to: 0, active: false });
let dragEnded = false;
function onPlotDown(event: PointerEvent): void {
  if (event.button !== 0 || event.pointerType !== 'mouse') return;
  const box = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
  const x = event.clientX - box.left;
  const y = event.clientY - box.top;
  if (x < plotLeft || x > plotRight.value || y < TOP || y > marksBottom.value) return;
  Object.assign(drag, { from: x, to: x, active: false });
}
function onPlotPointerMove(event: PointerEvent): void {
  onPlotMove(event);
  if (drag.from == null) return;
  if ((event.buttons & 1) === 0) {
    // The button came up outside the axis: the drag is over without a zoom.
    Object.assign(drag, { from: null, active: false });
    return;
  }
  drag.to = plotXOf(event);
  if (!drag.active && Math.abs(drag.to - drag.from) > 4) {
    drag.active = true;
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    hide();
    onScreenLeave();
  }
}
function onPlotUp(): void {
  if (drag.from != null && drag.active) {
    const a = Math.min(drag.from, drag.to);
    const b = Math.max(drag.from, drag.to);
    if (b - a >= 8) zoom.value = { start: atOfX(a), end: atOfX(b) };
    dragEnded = true;
    setTimeout(() => (dragEnded = false), 0);
  }
  Object.assign(drag, { from: null, active: false });
}
function onPlotClickCapture(event: MouseEvent): void {
  if (!dragEnded) return;
  dragEnded = false;
  event.stopPropagation();
}
const brush = computed(() =>
  drag.active && drag.from != null ? { x: Math.min(drag.from, drag.to), w: Math.abs(drag.to - drag.from) } : null,
);
const lanesHeight = computed(() => visibleLanes.value.length * LANE_H);

// ── Resources rows ───────────────────────────────────────────────────────────
// Off until the viewer turns them on: what the test's worker and its browsers
// used while it ran, and the pages open in that worker, under the lanes.
const RESOURCE_ROW_H = 20;
const showResources = useLocalStorage('piwi-failure-timeline-resources', false, { initOnMounted: true });
const resourceRows = computed(() => timelineResourceRows(data.value?.resources));
const resourcesOn = computed(() => showResources.value && resourceRows.value.length > 0);
const resourcesTop = computed(() => lanesTop.value + lanesHeight.value);
const resourcesHeight = computed(() => (resourcesOn.value ? resourceRows.value.length * RESOURCE_ROW_H : 0));
const resourceFillHeight = RESOURCE_ROW_H - 4;
const resourcePaths = computed(() =>
  resourceRows.value.map((row) => seriesPaths(row.points, row.yMax, row.step, resourceFillHeight)),
);
const resourceFactsText = computed(() => resourceFacts(data.value?.resources).join(' · '));
const resourcesClipId = `failure-timeline-resources-${useId()}`;
/** The rows' paths are built in ms; this places them on the window at the current width. */
function resourceTransform(index: number): string {
  const { start, end } = domain.value;
  const k = end > start ? plotWidth.value / (end - start) : 0;
  return `translate(${plotLeft - start * k}, ${resourcesTop.value + index * RESOURCE_ROW_H + 2}) scale(${k}, 1)`;
}
// The moment under the pointer while the rows show, anywhere over the plot, the lanes included. Only the cursor
// reads it, so a pointer move redraws the cursor and not the card.
const cursorState = reactive({ on: false, x: 0, clientX: 0, at: 0 });
function onPlotMove(event: MouseEvent): void {
  const svg = event.currentTarget as SVGSVGElement;
  const box = svg.getBoundingClientRect();
  const x = event.clientX - box.left;
  const y = event.clientY - box.top;
  if (!resourcesOn.value || x < plotLeft || x > plotRight.value || y < TOP || y > marksBottom.value) {
    cursorState.on = false;
    return;
  }
  const { start, end } = domain.value;
  Object.assign(cursorState, {
    on: true,
    x,
    clientX: event.clientX,
    at: start + ((x - plotLeft) / plotWidth.value) * (end - start),
  });
}

const marksBottom = computed(() => resourcesTop.value + resourcesHeight.value);
const svgHeight = computed(() => marksBottom.value + AXIS_H);

function xOf(at: number): number {
  const { start, end } = domain.value;
  const t = end > start ? (at - start) / (end - start) : 0;
  return plotLeft + Math.max(0, Math.min(1, t)) * plotWidth.value;
}

/** Clamped {x, w} for a bar spanning [at, at+dur], never spilling past the plot. */
function barRect(at: number, dur: number): { x: number; w: number } {
  const x = xOf(at);
  const end = xOf(at + Math.max(0, dur));
  return { x, w: Math.max(2, end - x) };
}

function laneY(lane: TimelineLane): number {
  return lanesTop.value + visibleLanes.value.indexOf(lane) * LANE_H;
}

/** Which edges of the window cut an item's bar: it started before the window, or runs on past it. */
function barCuts(item: TimelineItem): WindowCuts {
  return windowCuts(item, domain.value);
}

// A cut bar ends in a small arrow just outside the plot, on the side it continues.
const CUT_SIDES = ['start', 'end'] as const;
const CUT_ARROW_W = 5;
function cutArrowPath(side: 'start' | 'end', laneTop: number): string {
  const top = laneTop + 4;
  const mid = laneTop + LANE_H / 2;
  const bottom = laneTop + LANE_H - 4;
  if (side === 'end') {
    const x = plotRight.value + 2;
    return `M ${x} ${top} L ${x + CUT_ARROW_W} ${mid} L ${x} ${bottom} Z`;
  }
  const x = plotLeft - 2;
  return `M ${x} ${top} L ${x - CUT_ARROW_W} ${mid} L ${x} ${bottom} Z`;
}

const failureX = computed(() => (data.value ? xOf(data.value.failureAt) : 0));
const failureInView = computed(
  () => data.value != null && data.value.failureAt >= domain.value.start && data.value.failureAt <= domain.value.end,
);
const windowShade = computed(() => {
  const tl = data.value;
  if (!tl || zoom.value || mode.value !== 'whole' || tl.window.end <= tl.window.start) return null;
  const x = xOf(tl.window.start);
  return { x, w: Math.max(1, xOf(tl.window.end) - x) };
});

// ── Axis ticks (relative to the failure moment) ──────────────────────────────
// Precision scales with the magnitude: tenths of a second when close, then
// whole seconds, minutes and hours — so a far-off offset reads as `t+3h`, never
// a spurious `t+10755.8s`.
function formatRel(at: number): string {
  const failureAt = data.value?.failureAt ?? 0;
  const d = (at - failureAt) / 1000;
  const a = Math.abs(d);
  if (a < 0.05) return 't+0';
  const sign = d < 0 ? '-' : '+';
  let mag: string;
  if (a < 10) mag = `${a.toFixed(1)}s`;
  else if (a < 90) mag = `${Math.round(a)}s`;
  else if (a < 3600) mag = `${Math.round(a / 60)}m`;
  else mag = `${Math.round(a / 3600)}h`;
  return `t${sign}${mag}`;
}

const ticks = computed(() => {
  const { start, end } = domain.value;
  const count = 5;
  return Array.from({ length: count }, (_, i) => start + ((end - start) * i) / (count - 1));
});
/** Each tick's label, blank where it would repeat the one before (a short window rounds several to `t+0`). */
const tickLabels = computed(() =>
  ticks.value.map((tick, i, all) => {
    const label = formatTick(tick);
    return i > 0 && formatTick(all[i - 1]!) === label ? '' : label;
  }),
);
/** A moment on the axis: within a minute and a half of the failure, as precise as a short window needs. */
function formatTick(at: number): string {
  const span = domain.value.end - domain.value.start;
  const d = (at - (data.value?.failureAt ?? 0)) / 1000;
  if (span >= 10_000 || Math.abs(d) >= 90) return formatRel(at);
  const digits = span < 1_000 ? 2 : 1;
  return `t${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(digits)}s`;
}

// ── Marks and colors ─────────────────────────────────────────────────────────
// A failure or an error takes the failed outcome color, a warning the warning
// tone; every other mark keeps its lane's hue.
function pointClass(item: TimelineItem): string {
  const severity = timelineItemSeverity(item);
  if (severity === 'error') return 'fill-status-failed';
  if (severity === 'warning') return 'fill-warning';
  return item.kind === 'backend' ? 'fill-violet-500' : 'fill-gray-400 dark:fill-gray-500';
}
function stepClass(item: TimelineItem): string {
  return item.failed ? 'fill-status-failed' : 'fill-gray-300 dark:fill-gray-600';
}
function networkClass(item: TimelineItem): string {
  return item.failed ? 'fill-status-failed' : 'fill-sky-400/80 dark:fill-sky-500/70';
}

const WARNING_COLOR = 'var(--ui-warning)';

const PAUSED_COLOR = 'rgb(107, 114, 128)';

const legendItems = computed(() => {
  const items: { color: string; label: string }[] = [];
  if (hasCallBand.value) items.push({ color: 'rgb(129, 140, 248)', label: 'Calls' });
  if (hasPauseBand.value) items.push({ color: PAUSED_COLOR, label: 'Paused' });
  if (visibleLanes.value.includes('steps')) {
    items.push({ color: STATUS_PALETTE.failed.color, label: 'Failed step' });
    items.push({ color: 'rgb(156, 163, 175)', label: 'Step' });
  }
  if (visibleLanes.value.includes('network')) items.push({ color: 'rgb(56, 189, 248)', label: 'Request' });
  if (visibleLanes.value.includes('console')) items.push({ color: 'rgb(245, 158, 11)', label: 'Console' });
  if (visibleLanes.value.includes('dialogs')) items.push({ color: 'rgb(20, 184, 166)', label: 'Dialog' });
  if (visibleLanes.value.includes('backend')) items.push({ color: 'rgb(139, 92, 246)', label: 'Backend' });
  return items;
});

// Beside the type chips, which key the lanes, the key keeps what they do not
// say: the color of a failure or error, the tone of a warning. The Calls band
// carries its own label on the axis, so the key fits on the chips' row.
const markKeyItems = computed(() => {
  const items: { color: string; label: string }[] = [];
  items.push({ color: STATUS_PALETTE.failed.color, label: 'Failed or error' });
  if (shownWindowItems.value.some((item) => timelineItemSeverity(item) === 'warning')) {
    items.push({ color: WARNING_COLOR, label: 'Warning' });
  }
  return items;
});

// ── Tooltip ──────────────────────────────────────────────────────────────────
const { data: hovered, pos, show, move, hide } = useChartTooltip<TimelineItem>();

// A mark the type filter removes fires no mouseleave, so its tooltip goes with it.
watch(hiddenTypeSet, () => hide());

/** What the hovered bar's tooltip says about the window cutting it, if it does. */
const hoveredCutText = computed(() => (hovered.value ? windowCutText(barCuts(hovered.value)) : null));

function kindTag(item: TimelineItem): string {
  if (item.kind === 'console') return `console ${item.status ?? ''}`.trim();
  if (item.kind === 'backend') return `backend ${item.status ?? ''}`.trim();
  if (item.kind === 'dialogs') return `dialog ${item.status ?? ''}`.trim();
  return '';
}

// ── Call context (which method / test.step each action came from) ─────────────
function basename(file: string): string {
  const parts = file.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? file;
}
/** The band/group key: the method or test.step title, else the call-site file. */
function callKey(item: TimelineItem): string | null {
  return item.group ?? item.origin?.file ?? null;
}
function callLabel(item: TimelineItem): string {
  return item.group ?? (item.origin ? basename(item.origin.file) : '');
}
/** Runs of consecutive shown steps that share a call site, drawn as one span in the band. */
const callSpans = computed(() => {
  const steps = shownLanes.value.steps;
  const spans: Array<{
    id: string;
    key: string;
    label: string;
    start: number;
    end: number;
    origin: TimelineItem['origin'];
  }> = [];
  let cur: (typeof spans)[number] | null = null;
  for (const step of steps) {
    const key = callKey(step);
    if (key == null) {
      cur = null;
      continue;
    }
    const end = step.at + (step.duration ?? 0);
    if (cur && cur.key === key) {
      cur.end = Math.max(cur.end, end);
    } else {
      cur = { id: step.id, key, label: callLabel(step), start: step.at, end, origin: step.origin ?? null };
      spans.push(cur);
    }
  }
  return spans;
});

function bandTitle(span: { label: string; origin: TimelineItem['origin'] }): string {
  const where = span.origin ? ` · ${displayLocation(`${span.origin.file}:${span.origin.line}`)}` : '';
  return `${span.label}${where}`;
}

// ── Stops at the pause bar ───────────────────────────────────────────────────
const pausedPatternId = `failure-timeline-paused-${useId()}`;

/** A stop's band, named on hover: why it stopped, the call it held, where, and how long. */
function pauseTitle(pause: TimelinePause): string {
  const where = pause.location ? ` · ${displayLocation(pause.location.replace(/:\d+$/, ''))}` : '';
  return `${pauseReasonText(pause.reason)} · ${pause.label}${where} · ${formatDuration(pause.duration)}`;
}

// ── The merged steps table ───────────────────────────────────────────────────
// One row per step, with network / console / backend items interleaved in time
// order. A failing execution reads the rows off the axis window and the type
// filter (so both toggles drive the table too) and shows each row's offset from
// the failure; a passing one lists every step off the prop, without offsets.
// The rows then fold into sections: the setup and teardown hooks around the
// test body.
const tree = computed(() => buildStepTreeView(props.steps, props.error));

/** How long the test stood paused while a step ran: from its timeline item, else from the execution's stops. */
function stepPausedMs(row: StepRow): number {
  if (row.item) return row.item.paused ?? 0;
  return pausedOverlap(row.step.startTime, row.step.duration, props.pauses ?? []);
}

type StepRow = {
  kind: 'step';
  item: TimelineItem | null;
  step: PerformanceStep;
  index: number;
  /** The step's part in the failure; null for a step that passed. */
  role: StepFailureRole | null;
  /** The step that failed: its row carries the error and the page at that moment. */
  failing: boolean;
  /** The test caught the step's error and went on: the row is muted and carries the error on one line. */
  recovered: boolean;
  level: number;
};
type EventRow = { kind: 'event'; item: TimelineItem };
type MergedRow = StepRow | EventRow;

function stepRow(step: PerformanceStep, index: number, item: TimelineItem | null): StepRow {
  return {
    kind: 'step',
    item,
    step,
    index,
    role: tree.value.roles[index] ?? null,
    failing: index === tree.value.failingIndex,
    recovered: tree.value.roles[index] === 'recovered',
    level: tree.value.level[index] ?? 0,
  };
}

const mergedRows = computed<MergedRow[]>(() => {
  const hidden = tree.value.hidden;
  if (showAxis.value) {
    return shownWindowItems.value.flatMap<MergedRow>((item) => {
      if (item.kind !== 'step') return [{ kind: 'event', item }];
      const index = item.ref.index;
      const step = props.steps[index];
      return step && !hidden.has(index) ? [stepRow(step, index, item)] : [];
    });
  }
  return props.steps.flatMap<MergedRow>((step, index) => (hidden.has(index) ? [] : [stepRow(step, index, null)]));
});

// ── Setup and teardown sections ──────────────────────────────────────────────
// The hooks and fixtures before and after the test body fold into one header
// row each; a section opens by itself when the failure happened in it.
const failingPhase = computed<StepPhase | null>(() => {
  const failing = tree.value.failingIndex;
  return failing === null ? null : (tree.value.phases[failing] ?? null);
});
const openSections = ref<Set<StepPhase>>(new Set());
function resetOpenSections() {
  const phase = failingPhase.value;
  openSections.value = new Set(phase && phase !== 'body' ? [phase] : []);
}
watch(() => props.testRunsCaseId, resetOpenSections, { immediate: true });
function toggleSection(section: StepPhase) {
  const next = new Set(openSections.value);
  if (next.has(section)) next.delete(section);
  else next.add(section);
  openSections.value = next;
}

const SECTION_LABEL: Record<StepPhase, string> = { setup: 'Setup', body: 'Test', teardown: 'Teardown' };

// ── Step parameters ──────────────────────────────────────────────────────────
// A step that carries parameters has a title that opens them; every step
// starts closed, the failing one too.
const openSteps = ref<Set<number>>(new Set());
watch(
  () => props.testRunsCaseId,
  () => (openSteps.value = new Set()),
);
function hasParams(step: PerformanceStep): boolean {
  return orderedStepParams(step.params).length > 0;
}
function toggleStep(index: number) {
  const next = new Set(openSteps.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  openSteps.value = next;
}
/** The id of a step's parameter list, per layout: the phone cards and the table each render one. */
function paramsId(layout: 'card' | 'row', index: number): string {
  return `step-params-${layout}-${props.testRunsCaseId}-${index}`;
}

/** A step title's color: the failing step in the failed outcome color, a caught error muted. */
function stepTitleClass(row: StepRow): string {
  if (row.failing) return `${STATUS_PALETTE.failed.text} font-medium`;
  return row.recovered ? 'text-muted' : '';
}

type SectionEntry = {
  kind: 'section';
  key: string;
  section: StepPhase;
  label: string;
  summary: string;
  durationMs: number;
  failed: boolean;
  /** The failing step sits in this section, not only another failure. */
  holdsFailure: boolean;
  open: boolean;
  /** The offset of the section's first row, for the Time column. */
  at: number | null;
};
type RenderEntry = SectionEntry | (MergedRow & { key: string; nested: boolean });

const renderList = computed<RenderEntry[]>(() => {
  const blocks = groupRowsBySection(mergedRows.value, (row) =>
    row.kind === 'step' ? (tree.value.phases[row.index] ?? 'body') : null,
  );
  const out: RenderEntry[] = [];
  blocks.forEach((block, b) => {
    const rowKey = (row: MergedRow) => (row.kind === 'step' ? `s-${row.index}` : row.item.id);
    if (block.section === 'body') {
      for (const row of block.rows) out.push({ ...row, key: rowKey(row), nested: false });
      return;
    }
    const summary = tree.value.sections[block.section];
    const open = openSections.value.has(block.section);
    const first = block.rows[0]!;
    out.push({
      kind: 'section',
      key: `section-${block.section}-${b}`,
      section: block.section,
      label: SECTION_LABEL[block.section],
      summary: summary ? sectionSummaryText(summary) : '',
      durationMs: summary?.durationMs ?? 0,
      failed: Boolean(summary?.failed),
      holdsFailure: failingPhase.value === block.section,
      open,
      at: first.kind === 'step' ? (first.item?.at ?? null) : first.item.at,
    });
    if (open) for (const row of block.rows) out.push({ ...row, key: rowKey(row), nested: true });
  });
  return out;
});

// ── The page in the list ─────────────────────────────────────────────────────
// With frames, each row of the list can show the page, three ways the reader
// switches between (kept in a cookie): the side panel, where from `xl` a panel
// beside the table shows the hovered row's page, else the picked one (the
// failing step before it ran until a row's time, a row or a moment is picked);
// a hover card, the page before and after the row under the pointer; or
// thumbnails, a column of the page after each row. Without room for the side
// panel, and on touch, a row's time opens the page under that row. Hovering a
// row also marks its bar on the axis, and hovering a bar marks its row.
const pageView = useTimelinePageView();
const PAGE_VIEW_OPTIONS: readonly { value: PageView; label: string; title: string }[] = [
  {
    value: 'panel',
    label: 'Side panel',
    title: 'The page of the hovered or picked row beside the list, under the row on a narrower screen',
  },
  { value: 'hover', label: 'Hover card', title: 'The page before and after the row under the pointer' },
  { value: 'thumbs', label: 'Thumbnails', title: 'The page after each row, in a column of the list' },
];
const wide = useMediaQuery('(min-width: 80rem)');
// The table shows from `md`, the stacked cards below: the page opens under a row of the one on screen.
const tableShown = useMediaQuery('(min-width: 48rem)');
const pagePanelOn = computed(() => screenOn.value);
const sidePanelOn = computed(() => pagePanelOn.value && wide.value && pageView.value === 'panel');
const hoverCardOn = computed(() => pagePanelOn.value && pageView.value === 'hover');
const thumbsOn = computed(() => pagePanelOn.value && pageView.value === 'thumbs');
/** The table's column count, for a row that spans it. */
const tableCols = computed(() => (showAxis.value ? 4 : 3) + (thumbsOn.value ? 1 : 0));
type StepPhaseView = 'before' | 'after';
const pagePick = ref<{ key: string; phase: StepPhaseView } | { at: number } | null>(null);
const inlinePick = ref<{ key: string; phase: StepPhaseView } | null>(null);
const hoverKey = ref<string | null>(null);
watch(
  () => props.testRunsCaseId,
  () => {
    pagePick.value = null;
    inlinePick.value = null;
    hoverKey.value = null;
  },
);

const entriesByKey = computed(() => new Map(renderList.value.map((entry) => [entry.key, entry])));
const failingEntry = computed(
  () => renderList.value.find((entry) => entry.kind === 'step' && entry.failing && entry.item) ?? null,
);

/** A row of the list as what the panel shows the page for; null for a section or a row off the axis. */
function rowSubject(entry: RenderEntry | undefined | null, phase: StepPhaseView): PageSubject | null {
  if (!entry || entry.kind === 'section' || !entry.item) return null;
  const item = entry.item;
  if (entry.kind === 'step') {
    const end = item.at + (item.duration ?? 0);
    return {
      kind: 'step',
      key: entry.key,
      label: stepLabel(entry.step),
      at: item.at,
      end,
      failed: entry.failing,
      phase,
    };
  }
  if (item.kind === 'step') return null;
  return { kind: 'event', key: entry.key, label: item.label, at: item.at, event: item.kind };
}

const panelSubject = computed<PageSubject | null>(() => {
  const tl = data.value;
  if (!sidePanelOn.value || !tl) return null;
  const hovered = hoverKey.value ? entriesByKey.value.get(hoverKey.value) : undefined;
  const hovering = hovered ? rowSubject(hovered, rowPhase(hovered)) : null;
  if (hovering) return hovering;
  const pick = pagePick.value;
  if (pick && 'at' in pick) return { kind: 'moment', at: pick.at, label: stepLabelAt(pick.at) };
  const picked = pick ? rowSubject(entriesByKey.value.get(pick.key), pick.phase) : null;
  return (
    picked ??
    rowSubject(failingEntry.value, 'before') ?? { kind: 'moment', at: tl.failureAt, label: stepLabelAt(tl.failureAt) }
  );
});
/** The row the side panel shows when no row is hovered. */
const pickedKey = computed(() => {
  const pick = pagePick.value;
  if (pick && 'at' in pick) return null;
  return pick && entriesByKey.value.has(pick.key) ? pick.key : (failingEntry.value?.key ?? null);
});
const inlineSubject = computed<PageSubject | null>(() =>
  inlinePick.value && !sidePanelOn.value
    ? rowSubject(entriesByKey.value.get(inlinePick.value.key), inlinePick.value.phase)
    : null,
);

/** The phase a row opens on: the picked one for the picked row, else after a step, before the failing one. */
function rowPhase(entry: RenderEntry): StepPhaseView {
  const pick = pagePick.value;
  if (pick && 'key' in pick && pick.key === entry.key) return pick.phase;
  return entry.kind === 'step' && !entry.failing ? 'after' : 'before';
}
/** Show a row's page: in the side panel when it shows, else under the row (a second tap closes it). */
function pickRow(entry: RenderEntry): void {
  if (entry.kind === 'section') return;
  const phase = rowPhase(entry);
  if (sidePanelOn.value) pagePick.value = { key: entry.key, phase };
  else inlinePick.value = inlinePick.value?.key === entry.key ? null : { key: entry.key, phase };
}
/** A click on a step row picks it, unless it lands on something of its own (a button, a link, a view). */
function onStepRowClick(event: MouseEvent, entry: RenderEntry): void {
  if (!pagePanelOn.value || window.getSelection()?.toString()) return;
  if ((event.target as Element).closest('button, a, input, iframe, [role="tab"], [role="tablist"]')) return;
  pickRow(entry);
}
function onPanelPhase(phase: StepPhaseView): void {
  const subject = panelSubject.value;
  if (subject?.kind === 'step') pagePick.value = { key: subject.key, phase };
}
function onInlinePhase(phase: StepPhaseView): void {
  if (inlinePick.value) inlinePick.value = { ...inlinePick.value, phase };
}
function onPanelOpen(page: number, frame: number): void {
  hideFrame();
  lightbox.value = { page, index: frame };
}

// The hover card follows the pointer over a row, kept inside the window.
const HOVER_CARD_W = 368;
const HOVER_CARD_H = 300;
const hoverCardPos = reactive({ x: 0, y: 0 });
function onRowMove(event: MouseEvent): void {
  if (hoverCardOn.value) placeFloating(hoverCardPos, event, HOVER_CARD_W, HOVER_CARD_H);
}
/** The image of the page a placement names, with its caption. */
function placedShot(place: { page: number; frame: number } | null, caption: string, at: number) {
  const frame = place ? framePages.value[place.page]?.frames[place.frame] : null;
  return frame ? { src: frameUrl(frame.name), caption: `${caption} · ${formatRel(at)}` } : null;
}
/** The hovered row's page: before and after a step, when it happened for an event. */
const hoverCard = computed(() => {
  const tl = data.value;
  if (!hoverCardOn.value || !hoverKey.value || !tl) return null;
  const subject = rowSubject(entriesByKey.value.get(hoverKey.value), 'before');
  if (!subject || subject.kind === 'moment') return null;
  if (subject.kind === 'event') {
    const shot = placedShot(pageInFront(framePages.value, subject.at), 'When it happened', subject.at);
    return shot ? { shots: [shot], unchanged: false, failedLast: false } : null;
  }
  const frames = stepFrames(framePages.value, subject, tl.failureAt, framesSampled.value);
  const afterAt = subjectMoment({ ...subject, phase: 'after' }, tl.failureAt);
  const shots = [
    placedShot(frames.before, 'Before', subject.at),
    placedShot(frames.after, subject.failed ? 'At the failure' : 'After', afterAt),
  ].filter((shot) => shot != null);
  return shots.length ? { shots, unchanged: frames.unchanged, failedLast: subject.failed } : null;
});

/** A row's thumbnail: the page after a step (at the failure for the failing one), when an event happened. */
function rowFrame(entry: RenderEntry): { page: number; frame: number; src: string } | null {
  const tl = data.value;
  const subject = thumbsOn.value && tl ? rowSubject(entry, 'after') : null;
  if (!subject || !tl) return null;
  const place = pageInFront(framePages.value, subjectMoment(subject, tl.failureAt));
  const frame = place ? framePages.value[place.page]!.frames[place.frame]! : null;
  return place && frame ? { ...place, src: frameUrl(frame.name) } : null;
}
function openRowFrame(entry: RenderEntry): void {
  const frame = rowFrame(entry);
  if (frame) onPanelOpen(frame.page, frame.frame);
}

/** The item of the hovered row, whose bar the axis marks. */
const hotItemId = computed(() => {
  const entry = hoverKey.value ? entriesByKey.value.get(hoverKey.value) : undefined;
  return entry && entry.kind !== 'section' ? (entry.item?.id ?? null) : null;
});
/** A row whose bar is hovered, or that is hovered itself. */
function isHotRow(entry: RenderEntry): boolean {
  return (
    entry.kind !== 'section' &&
    entry.item != null &&
    (hoverKey.value === entry.key || hovered.value?.id === entry.item.id)
  );
}
/** The row background: the picked row's selection, else the hover mark. */
function rowStateClass(entry: RenderEntry): string {
  if (sidePanelOn.value && pickedKey.value === entry.key && !hoverKey.value) return SELECTED_ROW_CLASS;
  if (!isHotRow(entry)) return '';
  const failed = entry.kind === 'step' ? entry.failing : entry.kind === 'event' && entry.item.failed;
  return failed ? 'ring-1 ring-inset ring-accented' : 'bg-elevated/50';
}
/** A row's time as a button: it shows the page at that moment, beside the list or under the row. */
function timeButtonAttrs(entry: RenderEntry) {
  const at = entry.kind !== 'section' && entry.item ? formatRel(entry.item.at) : '';
  return {
    type: 'button' as const,
    class:
      'rounded underline decoration-dotted underline-offset-2 hover:decoration-solid hover:text-default outline-none focus-visible:outline-2 focus-visible:outline-primary',
    title: 'Show the page at this moment',
    'aria-label': `Show the page at ${at}`,
    'aria-pressed': sidePanelOn.value ? pickedKey.value === entry.key : undefined,
    'aria-expanded': sidePanelOn.value ? undefined : inlinePick.value?.key === entry.key,
  };
}
/** What every page panel under a row is given. */
const inlinePanelProps = computed(() => ({
  pages: framePages.value,
  frameUrl,
  formatTime: formatRel,
  failureAt: data.value?.failureAt ?? 0,
  sampled: framesSampled.value,
  onOpen: onPanelOpen,
  onPhase: onInlinePhase,
}));
function hotBarClass(item: TimelineItem): string {
  return item.id === hotItemId.value ? 'stroke-gray-900 dark:stroke-white' : '';
}

/** The left inset of a step's title: its depth in the tree, plus one inside a section. */
function stepIndent(row: StepRow & { nested: boolean }): Record<string, string> {
  const level = row.level + (row.nested ? 1 : 0);
  return level > 0 ? { paddingInlineStart: `${level * 1.25}rem` } : {};
}

// Step locations read relative to the project: the run's working directory,
// else the root found from the test's own file.
const locationRoot = computed(() =>
  resolveLocationRoot(stepLocations(props.steps), props.testFilePath ?? null, props.workingDir),
);
function displayLocation(location: string): string {
  return stripLocationRoot(location, locationRoot.value);
}

// The steps of the test body that did the work: listed, and holding no other
// step (a test.step's time is its children's).
const bodyLeafIndices = computed(() =>
  props.steps
    .map((_, i) => i)
    .filter((i) => tree.value.phases[i] === 'body' && !tree.value.hidden.has(i) && !tree.value.groups.has(i)),
);

// A setup failure stops the test before its body; a body with no steps of its
// own (a test that makes no Playwright calls) still ran.
const bodyNeverRan = computed(() => bodyLeafIndices.value.length === 0 && Boolean(tree.value.sections.setup?.failed));

// Per-category rollup for the summary line above the table, over the test
// body's steps, each without the time the test stood paused while it ran;
// setup and teardown follow as one figure each, then the time paused.
const stepSummary = computed(() => {
  const pauses = props.pauses ?? [];
  const byCat = new Map<string, { count: number; duration: number }>();
  for (const i of bodyLeafIndices.value) {
    const s = props.steps[i]!;
    const entry = byCat.get(s.category) ?? { count: 0, duration: 0 };
    entry.count += 1;
    entry.duration += (s.duration || 0) - pausedOverlap(s.startTime, s.duration, pauses);
    byCat.set(s.category, entry);
  }
  return Array.from(byCat, ([category, v]) => ({ category, ...v })).sort((a, b) => b.duration - a.duration);
});
const pausedTotal = computed(() => {
  const pauses = props.pauses ?? [];
  if (pauses.length === 0) return 0;
  const start = Math.min(...pauses.map((p) => p.startedAt));
  const end = Math.max(...pauses.map((p) => p.startedAt + p.duration));
  return pausedOverlap(start, end - start, pauses);
});
const sectionTimes = computed(() =>
  (['setup', 'teardown'] as const).flatMap((section) => {
    const summary = tree.value.sections[section];
    return summary && summary.durationMs > 0
      ? [{ label: SECTION_LABEL[section].toLowerCase(), ms: summary.durationMs }]
      : [];
  }),
);

const maxStepDuration = computed(() =>
  mergedRows.value.reduce((m, row) => (row.kind === 'step' ? Math.max(m, row.step.duration || 0) : m), 0),
);

// With an axis, every row is a timeline item, and its bar reads on the test's
// clock: from the test's start, as long as the test (else up to the timeline's
// end). A step's bar and a request's bar line up, a request that outlasts the
// test runs to the end of its track, and evidence stamped before the test
// started never pushes the bars right.
const track = computed<BarTrack>(() =>
  data.value ? testTrack(data.value, props.durationMs) : { start: 0, length: 1 },
);
function itemBar(item: TimelineItem): BarPlace {
  return barPlace(item.at, item.duration, track.value);
}
function stepBar(row: StepRow): BarPlace {
  return row.item ? itemBar(row.item) : stepBarStyle(row.step);
}

const timelinePauses = computed(() => timelinePauseSpans(data.value));

/**
 * The test time a request's share reads: the test's duration, or for a request that ran while the test stood paused
 * at Piwi's pause bar, the test's span on the clock, which holds the stops as the request's own time does.
 */
function requestTestMs(item: TimelineItem): number | null {
  const pauses = timelinePauses.value;
  if (pauses.length > 0 && pausedOverlap(item.at, item.duration, pauses) > 0) return track.value.length;
  return props.durationMs;
}

// Without an axis, a true waterfall needs a startTime on every step (only a
// recent reporter records them); otherwise the bars fall back to left-aligned
// magnitude.
const ownTrack = computed(() => stepsTrack(props.steps, props.durationMs, props.pauses ?? []));

/** Bar place for a step: a real waterfall when timings exist, else magnitude. */
function stepBarStyle(step: PerformanceStep): BarPlace {
  if (ownTrack.value) return barPlace(step.startTime as number, step.duration, ownTrack.value);
  const width = maxStepDuration.value > 0 ? Math.max(2, ((step.duration || 0) / maxStepDuration.value) * 100) : 0;
  return { left: 0, width };
}

// An interleaved event row: its type's icon (named on hover), the kind of a
// console, backend or dialog entry as a prefix, and a request's duration.
function eventIcon(item: TimelineItem): string {
  return TIMELINE_TYPE_META[item.lane]?.icon ?? 'i-lucide-dot';
}
function eventIconClass(item: TimelineItem): string {
  const severity = timelineItemSeverity(item);
  if (severity === 'error') return 'text-status-failed';
  if (severity === 'warning') return 'text-warning';
  if (item.kind === 'console') return 'text-gray-400 dark:text-gray-500';
  return TIMELINE_TYPE_META[item.lane]?.iconClass ?? '';
}
function eventTitle(item: TimelineItem): string {
  const text = kindTag(item) || TIMELINE_TYPE_META[item.lane]?.one || item.kind;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A request (or one of its backend logs) and a console entry are marked in their
// own tab; a step or a dialog only opens it.
function revealItem(item: TimelineItem) {
  const sectionId = SECTION_ACTION[item.ref.section];
  const marksRow = item.ref.section !== 'steps' && item.ref.section !== 'dialogs';
  if (locator.canLocate(sectionId)) locator.open(sectionId, marksRow ? item.ref.index : undefined);
}
</script>

<template>
  <SectionCard
    v-if="steps.length > 0 || (data && placedCount >= 2)"
    :embedded="embedded"
    :icon="embedded ? undefined : showAxis ? 'i-lucide-activity' : 'i-lucide-list-checks'"
    :title="embedded ? '' : showAxis ? 'Failure timeline' : 'Steps'"
    :count="embedded ? null : showAxis ? null : steps.length || null"
    :help="embedded ? undefined : 'case.timeline'"
  >
    <div class="space-y-3">
      <!-- One row: the window, the type filter and the key. The window and the
           chips both drive the axis and the table below; the chips key the
           lanes and the key the other marks. A window with a single type has
           nothing to filter and keeps the full legend. -->
      <div v-if="showAxis" class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          role="group"
          aria-label="Timeline window"
          class="inline-flex shrink-0 gap-0.5 rounded-md bg-elevated/60 p-0.5"
        >
          <button
            v-for="option in WINDOW_MODES"
            :key="option.value"
            type="button"
            :aria-pressed="!zoom && mode === option.value ? 'true' : 'false'"
            class="rounded px-2 py-0.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            :class="!zoom && mode === option.value ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
            @click="pickMode(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
        <span v-if="zoom" class="inline-flex items-center gap-1.5 text-xs text-muted tabular-nums">
          {{ formatTick(zoom.start) }} to {{ formatTick(zoom.end) }}
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            data-testid="timeline-zoom-reset"
            title="Show the window again (a double-click on the lanes under the Screen lane does it too)"
            @click="zoom = null"
          >
            Reset zoom
          </UButton>
        </span>
        <TimelineTypeFilter
          v-if="showTypeFilter"
          :types="windowTypes"
          :items="windowItems"
          :hidden="hiddenTypes"
          @toggle="toggleType($event, windowTypes)"
          @only="onlyType"
          @show-all="showAllTypes"
        />
        <TimelineToggle
          v-if="framePages.length > 0"
          v-model="showScreen"
          data-testid="timeline-screen-toggle"
          icon="i-lucide-film"
          label="Screen"
          title-on="Hide the page as the trace recorded it"
          title-off="Show the page as the trace recorded it"
        />
        <TimelineToggle
          v-if="resourceRows.length > 0"
          v-model="showResources"
          data-testid="timeline-resources-toggle"
          icon="i-lucide-cpu"
          label="Resources"
          title-on="Hide the CPU, memory and open pages of the worker that ran the test"
          title-off="Show the CPU, memory and open pages of the worker that ran the test"
        />
        <ChartLegend :items="showTypeFilter ? markKeyItems : legendItems" class="ml-auto" />
      </div>

      <!-- SVG axis -->
      <div v-if="showAxis && data" ref="wrapper" class="w-full">
        <svg
          v-if="plotWidth > 0"
          :width="svgWidth"
          :height="svgHeight"
          class="block select-none"
          :class="brush ? 'cursor-ew-resize' : ''"
          @pointerdown="onPlotDown"
          @pointermove="onPlotPointerMove"
          @pointerup="onPlotUp"
          @pointercancel="onPlotUp"
          @click.capture="onPlotClickCapture"
          @dblclick="zoom = null"
          @mouseleave="cursorState.on = false"
        >
          <!-- Default-window shade (only meaningful in whole-test view) -->
          <rect
            v-if="windowShade"
            :x="windowShade.x"
            :y="TOP"
            :width="windowShade.w"
            :height="marksBottom - TOP"
            class="fill-gray-400/10 dark:fill-gray-300/5"
          />

          <!-- Screen lanes: the page as the trace's screencast recorded it, one lane per page -->
          <g v-if="screenOn" data-timeline-screen>
            <g v-for="(tiles, p) in screenTiles" :key="framePages[p]!.pageId" :data-timeline-screen-page="p">
              <text
                :x="0"
                :y="screenLaneTop(p) + SCREEN_TILE_H / 2"
                dominant-baseline="middle"
                class="fill-gray-500 dark:fill-gray-400 text-[10px]"
              >
                {{ screenLaneLabel(p) }}
              </text>
              <rect
                :x="plotLeft"
                :y="screenLaneTop(p)"
                :width="plotWidth"
                :height="SCREEN_TILE_H"
                rx="3"
                class="fill-gray-100 dark:fill-gray-800"
              />
              <template v-for="(tile, i) in tiles" :key="i">
                <image
                  v-if="tile.src"
                  :href="tile.src"
                  :x="tile.x + 0.5"
                  :y="screenLaneTop(p)"
                  :width="Math.max(1, tile.w - 1)"
                  :height="SCREEN_TILE_H"
                  preserveAspectRatio="xMidYMin slice"
                  :opacity="tile.repeat ? 0.45 : 1"
                  class="pointer-events-none"
                />
              </template>
              <rect
                :x="plotLeft"
                :y="screenLaneTop(p)"
                :width="plotWidth"
                :height="SCREEN_TILE_H"
                fill="transparent"
                class="cursor-zoom-in outline-none focus-visible:stroke-primary focus-visible:stroke-2"
                role="button"
                tabindex="0"
                :aria-label="`${screenLaneLabel(p)}: open the page as the trace recorded it, at the failure`"
                data-testid="timeline-screen-lane"
                @mousemove="onScreenMove($event, p)"
                @mouseleave="onScreenLeave"
                @click="openScreenAt($event, p)"
                @keydown.enter.prevent="openScreenAtFailure(p)"
                @keydown.space.prevent="openScreenAtFailure(p)"
              />
            </g>
          </g>

          <!-- Calls band: which method / test.step each run of actions came from -->
          <g v-if="hasCallBand">
            <text
              :x="0"
              :y="bandsTop + CALL_BAND_H / 2"
              dominant-baseline="middle"
              class="fill-gray-500 dark:fill-gray-400 text-[10px]"
            >
              Calls
            </text>
            <g v-for="span in callSpans" :key="span.id">
              <rect
                :x="barRect(span.start, span.end - span.start).x"
                :y="bandsTop + 2"
                :width="barRect(span.start, span.end - span.start).w"
                :height="CALL_BAND_H - 4"
                rx="2"
                class="fill-indigo-600 dark:fill-indigo-500/60"
              >
                <title>{{ bandTitle(span) }}</title>
              </rect>
              <text
                v-if="barRect(span.start, span.end - span.start).w > 44"
                :x="barRect(span.start, span.end - span.start).x + 4"
                :y="bandsTop + CALL_BAND_H / 2"
                dominant-baseline="middle"
                class="fill-white text-[9px] pointer-events-none"
                :style="{ clipPath: `inset(0 0 0 0)` }"
              >
                {{
                  span.label.length > Math.floor((barRect(span.start, span.end - span.start).w - 8) / 5.5)
                    ? span.label.slice(
                        0,
                        Math.max(1, Math.floor((barRect(span.start, span.end - span.start).w - 8) / 5.5) - 1),
                      ) + '…'
                    : span.label
                }}
              </text>
            </g>
          </g>

          <!-- Stops at the pause bar: a row of their own, and a hatched shade across the lanes -->
          <g v-if="hasPauseBand" data-timeline-paused>
            <defs>
              <pattern
                :id="pausedPatternId"
                patternUnits="userSpaceOnUse"
                width="6"
                height="6"
                patternTransform="rotate(45)"
              >
                <rect width="2" height="6" class="fill-gray-400/40 dark:fill-gray-500/40" />
              </pattern>
            </defs>
            <text
              :x="0"
              :y="pauseBandTop + PAUSE_BAND_H / 2"
              dominant-baseline="middle"
              class="fill-gray-500 dark:fill-gray-400 text-[10px]"
            >
              Paused
            </text>
            <g v-for="pause in shownPauses" :key="pause.id">
              <rect
                :x="barRect(pause.at, pause.duration).x"
                :y="lanesTop"
                :width="barRect(pause.at, pause.duration).w"
                :height="lanesHeight"
                :fill="`url(#${pausedPatternId})`"
                class="pointer-events-none"
              />
              <rect
                :x="barRect(pause.at, pause.duration).x"
                :y="pauseBandTop + 2"
                :width="barRect(pause.at, pause.duration).w"
                :height="PAUSE_BAND_H - 4"
                rx="2"
                class="fill-gray-600 dark:fill-gray-400/60"
              >
                <title>{{ pauseTitle(pause) }}</title>
              </rect>
              <text
                v-if="barRect(pause.at, pause.duration).w > 44"
                :x="barRect(pause.at, pause.duration).x + 4"
                :y="pauseBandTop + PAUSE_BAND_H / 2"
                dominant-baseline="middle"
                class="fill-white text-[9px] pointer-events-none"
              >
                {{ formatTimelineTime(pause.duration) }}
              </text>
            </g>
          </g>

          <!-- Lane rows -->
          <g v-for="lane in visibleLanes" :key="lane">
            <text
              :x="0"
              :y="laneY(lane) + LANE_H / 2"
              dominant-baseline="middle"
              class="fill-gray-500 dark:fill-gray-400 text-[10px]"
            >
              {{ TIMELINE_TYPE_META[lane].label }}
            </text>
            <line
              :x1="plotLeft"
              :x2="plotRight"
              :y1="laneY(lane) + LANE_H"
              :y2="laneY(lane) + LANE_H"
              class="stroke-gray-100 dark:stroke-gray-800"
            />
          </g>

          <!-- Step bars, each ending in an arrow where the window cuts it -->
          <template v-for="item in shownLanes.steps" :key="item.id">
            <rect
              :x="barRect(item.at, item.duration ?? 0).x"
              :y="laneY('steps') + 4"
              :width="barRect(item.at, item.duration ?? 0).w"
              :height="LANE_H - 8"
              rx="2"
              class="cursor-pointer"
              :class="[stepClass(item), hotBarClass(item)]"
              :stroke-width="item.id === hotItemId ? 1.5 : 0"
              @click="revealItem(item)"
              @mouseenter="show($event, item)"
              @mousemove="move($event)"
              @mouseleave="hide()"
            />
            <template v-for="side in CUT_SIDES" :key="side">
              <path
                v-if="barCuts(item)[side]"
                :d="cutArrowPath(side, laneY('steps'))"
                data-testid="timeline-cut-arrow"
                class="pointer-events-none"
                :class="stepClass(item)"
              />
            </template>
          </template>

          <!-- Network bars, each ending in an arrow where the window cuts it -->
          <template v-for="item in shownLanes.network" :key="item.id">
            <rect
              :x="barRect(item.at, item.duration ?? 0).x"
              :y="laneY('network') + 4"
              :width="barRect(item.at, item.duration ?? 0).w"
              :height="LANE_H - 8"
              rx="2"
              class="cursor-pointer"
              :class="[networkClass(item), hotBarClass(item)]"
              :stroke-width="item.id === hotItemId ? 1.5 : 0"
              @click="revealItem(item)"
              @mouseenter="show($event, item)"
              @mousemove="move($event)"
              @mouseleave="hide()"
            />
            <template v-for="side in CUT_SIDES" :key="side">
              <path
                v-if="barCuts(item)[side]"
                :d="cutArrowPath(side, laneY('network'))"
                data-testid="timeline-cut-arrow"
                class="pointer-events-none"
                :class="networkClass(item)"
              />
            </template>
          </template>

          <!-- Console marks -->
          <template v-for="item in shownLanes.console" :key="item.id">
            <circle
              :cx="xOf(item.at)"
              :cy="laneY('console') + LANE_H / 2"
              r="4"
              class="cursor-pointer"
              :class="[pointClass(item), hotBarClass(item)]"
              :stroke-width="item.id === hotItemId ? 1.5 : 0"
              @click="revealItem(item)"
              @mouseenter="show($event, item)"
              @mousemove="move($event)"
              @mouseleave="hide()"
            />
          </template>

          <!-- Dialog marks -->
          <template v-for="item in shownLanes.dialogs" :key="item.id">
            <circle
              :cx="xOf(item.at)"
              :cy="laneY('dialogs') + LANE_H / 2"
              r="4"
              class="cursor-pointer fill-teal-500"
              :class="hotBarClass(item)"
              :stroke-width="item.id === hotItemId ? 1.5 : 0"
              @click="revealItem(item)"
              @mouseenter="show($event, item)"
              @mousemove="move($event)"
              @mouseleave="hide()"
            />
          </template>

          <!-- Backend marks -->
          <template v-for="item in shownLanes.backend" :key="item.id">
            <circle
              :cx="xOf(item.at)"
              :cy="laneY('backend') + LANE_H / 2"
              r="4"
              class="cursor-pointer"
              :class="[pointClass(item), hotBarClass(item)]"
              :stroke-width="item.id === hotItemId ? 1.5 : 0"
              @click="revealItem(item)"
              @mouseenter="show($event, item)"
              @mousemove="move($event)"
              @mouseleave="hide()"
            />
          </template>

          <!-- Resources: the worker's CPU and memory, the pages open in it -->
          <g v-if="resourcesOn" data-timeline-resources>
            <defs>
              <clipPath :id="resourcesClipId">
                <rect :x="plotLeft" :y="resourcesTop" :width="plotWidth" :height="resourcesHeight" />
              </clipPath>
              <ResourceFillGradient
                v-for="row in resourceRows"
                :id="`${resourcesClipId}-${row.kind}-fill`"
                :key="row.kind"
                :height="resourceFillHeight"
                :color-class="RESOURCE_TRACK_COLOR[row.kind]"
              />
            </defs>
            <g v-for="(row, i) in resourceRows" :key="row.kind" :data-timeline-resource="row.kind">
              <text
                :x="0"
                :y="resourcesTop + i * RESOURCE_ROW_H + RESOURCE_ROW_H / 2"
                dominant-baseline="middle"
                class="fill-gray-500 dark:fill-gray-400 text-[10px]"
              >
                {{ row.label }}
                <title>{{ row.scaleLabel }}</title>
              </text>
              <line
                :x1="plotLeft"
                :x2="plotRight"
                :y1="resourcesTop + (i + 1) * RESOURCE_ROW_H"
                :y2="resourcesTop + (i + 1) * RESOURCE_ROW_H"
                class="stroke-gray-100 dark:stroke-gray-800"
              />
              <g :clip-path="`url(#${resourcesClipId})`">
                <g :transform="resourceTransform(i)" :class="RESOURCE_TRACK_COLOR[row.kind]">
                  <path :d="resourcePaths[i]?.area" :fill="`url(#${resourcesClipId}-${row.kind}-fill)`" />
                  <path
                    :d="resourcePaths[i]?.line"
                    fill="none"
                    stroke-width="1.5"
                    stroke-linejoin="round"
                    vector-effect="non-scaling-stroke"
                    stroke="currentColor"
                  />
                </g>
              </g>
            </g>
          </g>

          <!-- Failure marker line -->
          <line
            v-if="failureInView"
            :x1="failureX"
            :x2="failureX"
            :y1="TOP"
            :y2="marksBottom"
            class="stroke-status-failed"
            stroke-width="1.5"
            stroke-dasharray="4 3"
          />

          <!-- The range a drag zooms to -->
          <rect
            v-if="brush"
            :x="brush.x"
            :y="TOP"
            :width="brush.w"
            :height="marksBottom - TOP"
            class="fill-gray-500/10 stroke-gray-500 dark:fill-gray-400/10 dark:stroke-gray-400 pointer-events-none"
            data-testid="timeline-zoom-brush"
          />

          <!-- Axis ticks -->
          <g>
            <text
              v-for="(tick, i) in ticks"
              :key="i"
              :x="Math.max(plotLeft, Math.min(plotRight, xOf(tick)))"
              :y="marksBottom + 12"
              :text-anchor="i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'"
              class="fill-gray-400 dark:fill-gray-500 text-[10px] tabular-nums"
            >
              {{ tickLabels[i] }}
            </text>
          </g>

          <!-- The moment under the pointer: a line across the whole chart, its time on the axis, each row's value beside it -->
          <FailureTimelineCursor
            v-if="resourcesOn"
            :state="cursorState"
            :rows="resourceRows"
            :rows-top="resourcesTop"
            :row-height="RESOURCE_ROW_H"
            :top="TOP"
            :bottom="marksBottom"
            :time-y="marksBottom + 12"
            :plot-left="plotLeft"
            :plot-right="plotRight"
            :format-time="formatRel"
            :tooltip-x="hovered ? pos.x : null"
          />
        </svg>
      </div>

      <!-- What the test measured itself. -->
      <p
        v-if="showAxis && resourcesOn && resourceFactsText"
        data-testid="timeline-resources-facts"
        class="text-xs text-muted tabular-nums"
      >
        {{ resourceFactsText }}
      </p>

      <ScreenshotLightbox v-model="lightboxIndex" :images="lightboxImages" :subject="subject" />

      <!-- Filmstrip: the page before each step, from this run's trace screen snapshots, where no lane shows the page. -->
      <TraceFilmstrip
        v-if="!screenOn"
        :test-runs-case-id="testRunsCaseId"
        :error="error"
        :failed="executionFailed(status)"
        :subject="subject"
      />

      <!-- Estimated-positions note -->
      <p v-if="showAxis && data?.estimated" class="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
        <UIcon name="i-lucide-info" class="size-3.5 shrink-0" />
        Step positions are derived from durations — this run’s reporter did not record step start times.
      </p>

      <!-- The failure happened outside any recorded step. -->
      <UAlert
        v-if="isFailedStatus(status ?? '') && mergedRows.length > 0 && tree.failingIndex === null"
        color="warning"
        variant="subtle"
        icon="i-lucide-info"
        title="The failure was not captured at step level"
        description="The test failed, but none of the recorded steps is marked failed — the error happened outside the step list."
      />

      <template v-if="steps.length > 0">
        <!-- Per-category summary line: the test body's steps, then setup and teardown -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p class="text-xs text-muted tabular-nums" data-testid="timeline-step-summary">
            <template v-if="bodyLeafIndices.length"
              >{{ bodyLeafIndices.length }} step{{ bodyLeafIndices.length === 1 ? '' : 's' }}</template
            >
            <template v-else-if="bodyNeverRan">The test body never ran</template>
            <template v-else>No steps in the test body</template>
            <template v-for="c in stepSummary" :key="c.category"
              ><span aria-hidden="true"> · </span>{{ c.category }} ×{{ c.count }} <DurationValue :ms="c.duration"
            /></template>
            <template v-for="t in sectionTimes" :key="t.label"
              ><span aria-hidden="true"> · </span>{{ t.label }} <DurationValue :ms="t.ms"
            /></template>
            <template v-if="pausedTotal > 0"
              ><span aria-hidden="true"> · </span>paused <DurationValue :ms="pausedTotal"
            /></template>
          </p>
          <div v-if="pagePanelOn" class="ml-auto flex items-center gap-2">
            <span class="text-xs text-muted">Show the page</span>
            <div
              role="group"
              aria-label="How the list shows the page"
              class="inline-flex shrink-0 gap-0.5 rounded-md bg-elevated/60 p-0.5"
              data-testid="timeline-page-view"
            >
              <button
                v-for="option in PAGE_VIEW_OPTIONS"
                :key="option.value"
                type="button"
                :title="option.title"
                :aria-pressed="pageView === option.value ? 'true' : 'false'"
                class="rounded px-2 py-0.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary"
                :class="pageView === option.value ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
                @click="pageView = option.value"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
        </div>

        <!-- Phone layout (below `md`): one stacked card per row, so the Step and
             Duration columns are never cut and the page never scrolls sideways.
             The `md`-and-up table below carries the same rows unchanged. -->
        <div class="md:hidden space-y-2">
          <template v-for="entry in renderList" :key="`m-${entry.key}`">
            <!-- A setup / teardown section: one row that folds its hooks and fixtures -->
            <button
              v-if="entry.kind === 'section'"
              type="button"
              class="flex w-full items-start gap-2 rounded-lg border border-default bg-elevated/40 p-2.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-primary"
              :aria-expanded="entry.open ? 'true' : 'false'"
              @click="toggleSection(entry.section)"
            >
              <UIcon
                :name="entry.open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                class="mt-0.5 size-4 shrink-0 text-muted"
              />
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2 text-sm">
                  <span class="font-medium" :class="entry.failed ? STATUS_PALETTE.failed.text : ''">{{
                    entry.label
                  }}</span>
                  <DurationValue :ms="entry.durationMs" class="ml-auto text-xs text-muted" />
                </span>
                <span v-if="entry.summary" class="mt-0.5 block break-words text-xs text-muted">{{
                  entry.summary
                }}</span>
              </span>
            </button>

            <!-- A step row -->
            <div
              v-else-if="entry.kind === 'step'"
              class="rounded-lg border border-default p-2.5"
              :class="entry.failing ? STATUS_PALETTE.failed.tint : ''"
              :style="{ marginInlineStart: `${Math.min(entry.level + (entry.nested ? 1 : 0), 4) * 0.75}rem` }"
              :data-cited="isCited(entry.item) ? '' : undefined"
            >
              <div class="flex items-center gap-2">
                <StepStatusMark :role="entry.role" :not-run="status === 'didnotrun'" />
                <span v-if="isCited(entry.item)" class="text-xs text-muted">Cited by Most likely</span>
                <button
                  v-if="showAxis && entry.item && pagePanelOn"
                  v-bind="timeButtonAttrs(entry)"
                  class="ml-auto tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap"
                  @click.stop="pickRow(entry)"
                >
                  {{ formatRel(entry.item.at) }}
                </button>
                <span
                  v-else-if="showAxis && entry.item"
                  class="ml-auto tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap"
                >
                  {{ formatRel(entry.item.at) }}
                </span>
              </div>
              <div class="mt-1.5 text-sm">
                <button
                  v-if="hasParams(entry.step)"
                  type="button"
                  class="inline-flex max-w-full items-start gap-1 rounded text-left break-words outline-none focus-visible:outline-2 focus-visible:outline-primary"
                  :class="stepTitleClass(entry)"
                  :aria-expanded="openSteps.has(entry.index) ? 'true' : 'false'"
                  :aria-controls="openSteps.has(entry.index) ? paramsId('card', entry.index) : undefined"
                  data-testid="step-params-toggle"
                  @click="toggleStep(entry.index)"
                >
                  <StepLabel :step="entry.step" />
                  <UIcon
                    :name="openSteps.has(entry.index) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                    class="mt-0.5 size-4 shrink-0 text-muted"
                  />
                </button>
                <p v-else class="break-words" :class="stepTitleClass(entry)">
                  <StepLabel :step="entry.step" />
                </p>
              </div>
              <button
                v-if="rowFrame(entry)"
                type="button"
                class="mt-1.5 block w-32 overflow-hidden rounded border border-default bg-elevated cursor-zoom-in outline-none focus-visible:outline-2 focus-visible:outline-primary"
                :aria-label="`Open the page full screen, ${entry.item ? formatRel(entry.item.at) : ''}`"
                @click.stop="openRowFrame(entry)"
              >
                <img
                  :src="rowFrame(entry)!.src"
                  alt=""
                  loading="lazy"
                  class="block aspect-video w-full object-cover object-top"
                />
              </button>
              <StepParams
                v-if="openSteps.has(entry.index)"
                :id="paramsId('card', entry.index)"
                :params="entry.step.params"
                class="mt-1"
              />
              <ErrorText
                v-if="entry.failing && entry.step.error?.message"
                mode="block"
                :text="entry.step.error.message"
                class="mt-1"
              />
              <div v-else-if="entry.recovered" class="mt-1">
                <p class="text-xs text-muted">Error caught, the test continued</p>
                <ErrorText v-if="entry.step.error?.message" :text="entry.step.error.message" />
              </div>
              <OpenInIdeLink
                v-if="entry.step.location"
                :location="displayLocation(entry.step.location)"
                :project-key="projectKey ?? undefined"
                :project-name="projectName ?? undefined"
                class="text-xs text-gray-400 dark:text-gray-500 mt-0.5"
              />
              <TimelineDuration
                :ms="entry.step.duration"
                :test-ms="durationMs"
                :usual-ms="entry.item?.usual ?? null"
                :bar="stepBar(entry)"
                :group="tree.groups.has(entry.index)"
                :failed="entry.failing"
                :paused-ms="stepPausedMs(entry)"
                class="mt-1.5"
              />
              <TimelinePagePanel
                v-if="!tableShown && inlineSubject && inlinePick?.key === entry.key && data"
                inline
                class="mt-2.5 border-t border-default pt-2.5"
                :subject="inlineSubject"
                v-bind="inlinePanelProps"
              />
              <FailingStepSnapshot
                v-if="entry.failing"
                data-shot="failing-step-evidence"
                :test-runs-case-id="testRunsCaseId"
                :attachments="attachments"
                :aria-snapshot="ariaSnapshot"
                :step="stepLabel(entry.step)"
                :error="error || entry.step.error?.message"
                :subject="subject"
                class="mt-2.5"
              />
            </div>

            <!-- An interleaved network / console / backend row -->
            <div
              v-else
              class="rounded-lg border border-default p-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60"
              :class="entry.item.failed ? STATUS_PALETTE.failed.tint : ''"
              :style="entry.nested ? { marginInlineStart: '0.75rem' } : undefined"
              :data-cited="isCited(entry.item) ? '' : undefined"
              @click="revealItem(entry.item)"
            >
              <div class="flex items-start gap-2">
                <UIcon
                  :name="eventIcon(entry.item)"
                  class="mt-0.5 size-4 shrink-0"
                  :class="eventIconClass(entry.item)"
                  :title="eventTitle(entry.item)"
                />
                <span class="min-w-0 font-mono text-xs break-all text-gray-700 dark:text-gray-300">
                  <span v-if="kindTag(entry.item)" class="mr-1.5 font-sans text-muted">{{ kindTag(entry.item) }}</span
                  >{{ entry.item.label
                  }}<span v-if="entry.item.kind === 'network'" class="text-gray-500"> → {{ entry.item.status }}</span>
                </span>
                <span v-if="isCited(entry.item)" class="ml-auto shrink-0 text-xs text-muted whitespace-nowrap"
                  >Cited by Most likely</span
                >
                <button
                  v-if="showAxis && pagePanelOn"
                  v-bind="timeButtonAttrs(entry)"
                  class="shrink-0 tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap"
                  :class="isCited(entry.item) ? '' : 'ml-auto'"
                  @click.stop="pickRow(entry)"
                >
                  {{ formatRel(entry.item.at) }}
                </button>
                <span
                  v-else-if="showAxis"
                  class="shrink-0 tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap"
                  :class="isCited(entry.item) ? '' : 'ml-auto'"
                >
                  {{ formatRel(entry.item.at) }}
                </span>
              </div>
              <button
                v-if="rowFrame(entry)"
                type="button"
                class="mt-1.5 block w-32 overflow-hidden rounded border border-default bg-elevated cursor-zoom-in outline-none focus-visible:outline-2 focus-visible:outline-primary"
                :aria-label="`Open the page full screen, ${entry.item ? formatRel(entry.item.at) : ''}`"
                @click.stop="openRowFrame(entry)"
              >
                <img
                  :src="rowFrame(entry)!.src"
                  alt=""
                  loading="lazy"
                  class="block aspect-video w-full object-cover object-top"
                />
              </button>
              <TimelineDuration
                v-if="entry.item.duration != null"
                :ms="entry.item.duration"
                :test-ms="requestTestMs(entry.item)"
                :usual-ms="entry.item.usual ?? null"
                :bar="itemBar(entry.item)"
                :failed="entry.item.failed"
                class="mt-1.5"
              />
              <TimelinePagePanel
                v-if="!tableShown && inlineSubject && inlinePick?.key === entry.key && data"
                inline
                class="mt-2.5 cursor-default border-t border-default pt-2.5"
                :subject="inlineSubject"
                @click.stop
                v-bind="inlinePanelProps"
              />
            </div>
          </template>
        </div>

        <!-- One table: steps, with network / console / backend items interleaved
             in time order. `min-width` keeps the columns readable while the
             wrapper (not the page) scrolls; on a phone the stacked cards above
             replace it, so the table shows from `md` up. -->
        <div
          :class="sidePanelOn ? 'hidden md:grid grid-cols-[minmax(0,1fr)_22rem] items-start gap-3' : 'hidden md:block'"
          @mouseleave="hoverKey = null"
        >
          <TableScroller min-width="34rem" :bleed="false">
            <table class="w-full min-w-[34rem] border-separate border-spacing-0 text-sm">
              <thead>
                <tr
                  class="[&>th]:bg-elevated/50 [&>th]:border-y [&>th]:border-default [&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium [&>th]:text-xs [&>th]:text-gray-500 dark:[&>th]:text-gray-400"
                >
                  <th v-if="showAxis" class="w-16 first:rounded-l-lg first:border-l">Time</th>
                  <!-- `relative` keeps the hidden label inside the table's scroller -->
                  <th class="relative w-8" :class="showAxis ? '' : 'first:rounded-l-lg first:border-l'">
                    <span class="sr-only">Kind</span>
                  </th>
                  <th v-if="thumbsOn" class="w-24">Page</th>
                  <th>Step</th>
                  <th class="w-40 last:rounded-r-lg last:border-r">Duration</th>
                </tr>
              </thead>
              <tbody @mouseleave="sidePanelOn || (hoverKey = null)">
                <template v-for="entry in renderList" :key="entry.key">
                  <!-- A setup / teardown section: one row that folds its hooks and fixtures -->
                  <tr
                    v-if="entry.kind === 'section'"
                    class="bg-elevated/40 [&>td]:border-b [&>td]:border-default [&>td]:px-3 [&>td]:py-2 [&>td]:align-top"
                  >
                    <td v-if="showAxis" class="tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">
                      {{ entry.at != null ? formatRel(entry.at) : '' }}
                    </td>
                    <td>
                      <span
                        v-if="entry.failed"
                        class="inline-flex items-center justify-center size-5 rounded-full text-xs leading-none"
                        :class="STATUS_PALETTE.failed.chip"
                        :title="entry.holdsFailure ? 'The failure happened here' : 'A step failed here too'"
                        >✗</span
                      >
                    </td>
                    <td v-if="thumbsOn" />
                    <td>
                      <button
                        type="button"
                        class="inline-flex max-w-full items-start gap-1.5 rounded text-left outline-none focus-visible:outline-2 focus-visible:outline-primary"
                        :aria-expanded="entry.open ? 'true' : 'false'"
                        @click="toggleSection(entry.section)"
                      >
                        <UIcon
                          :name="entry.open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                          class="mt-0.5 size-4 shrink-0 text-muted"
                        />
                        <span class="font-medium" :class="entry.failed ? STATUS_PALETTE.failed.text : ''">{{
                          entry.label
                        }}</span>
                        <span v-if="entry.summary" class="min-w-0 break-words text-xs leading-5 text-muted">{{
                          entry.summary
                        }}</span>
                      </button>
                    </td>
                    <td>
                      <DurationValue :ms="entry.durationMs" class="text-sm text-muted" unit-class="opacity-60" />
                    </td>
                  </tr>

                  <!-- A step row -->
                  <template v-else-if="entry.kind === 'step'">
                    <tr
                      class="[&>td]:border-b [&>td]:border-default [&>td]:px-3 [&>td]:py-2 [&>td]:align-top"
                      :class="[entry.failing ? STATUS_PALETTE.failed.tint : '', rowStateClass(entry)]"
                      :data-cited="isCited(entry.item) ? '' : undefined"
                      @mouseenter="hoverKey = entry.key"
                      @mousemove="onRowMove"
                      @click="onStepRowClick($event, entry)"
                    >
                      <td
                        v-if="showAxis"
                        class="tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap"
                      >
                        <button
                          v-if="pagePanelOn && entry.item"
                          v-bind="timeButtonAttrs(entry)"
                          data-testid="timeline-row-page"
                          @click.stop="pickRow(entry)"
                        >
                          {{ formatRel(entry.item.at) }}
                        </button>
                        <template v-else>{{ entry.item ? formatRel(entry.item.at) : '' }}</template>
                      </td>
                      <td>
                        <StepStatusMark :role="entry.role" :not-run="status === 'didnotrun'" />
                      </td>
                      <td v-if="thumbsOn">
                        <button
                          v-if="rowFrame(entry)"
                          type="button"
                          class="block w-20 overflow-hidden rounded border border-default bg-elevated cursor-zoom-in outline-none focus-visible:outline-2 focus-visible:outline-primary"
                          :aria-label="`Open the page full screen, ${entry.item ? formatRel(entry.item.at) : ''}`"
                          data-testid="timeline-row-thumbnail"
                          @click.stop="openRowFrame(entry)"
                        >
                          <img
                            :src="rowFrame(entry)!.src"
                            alt=""
                            loading="lazy"
                            class="block aspect-video w-full object-cover object-top"
                          />
                        </button>
                      </td>
                      <td class="min-w-0">
                        <div :style="stepIndent(entry)">
                          <!-- A step with parameters opens them from its title. -->
                          <div class="min-w-0">
                            <button
                              v-if="hasParams(entry.step)"
                              type="button"
                              class="inline-flex max-w-full items-start gap-1 rounded text-left break-words outline-none focus-visible:outline-2 focus-visible:outline-primary"
                              :class="stepTitleClass(entry)"
                              :aria-expanded="openSteps.has(entry.index) ? 'true' : 'false'"
                              :aria-controls="openSteps.has(entry.index) ? paramsId('row', entry.index) : undefined"
                              data-testid="step-params-toggle"
                              @click="toggleStep(entry.index)"
                            >
                              <StepLabel :step="entry.step" />
                              <UIcon
                                :name="openSteps.has(entry.index) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                                class="mt-0.5 size-4 shrink-0 text-muted"
                              />
                            </button>
                            <span v-else class="break-words" :class="stepTitleClass(entry)">
                              <StepLabel :step="entry.step" />
                            </span>
                            <span v-if="isCited(entry.item)" class="ml-1.5 text-xs text-muted whitespace-nowrap"
                              >Cited by Most likely</span
                            >
                          </div>
                          <StepParams
                            v-if="openSteps.has(entry.index)"
                            :id="paramsId('row', entry.index)"
                            :params="entry.step.params"
                            class="mt-1"
                          />
                          <ErrorText
                            v-if="entry.failing && entry.step.error?.message"
                            mode="block"
                            :text="entry.step.error.message"
                            class="mt-1"
                          />
                          <!-- Contained: the one-line error must not widen the column to its full length. -->
                          <div v-else-if="entry.recovered" class="mt-1 [contain:inline-size]">
                            <p class="text-xs text-muted">Error caught, the test continued</p>
                            <ErrorText v-if="entry.step.error?.message" :text="entry.step.error.message" />
                          </div>
                          <OpenInIdeLink
                            v-if="entry.step.location"
                            :location="displayLocation(entry.step.location)"
                            :project-key="projectKey ?? undefined"
                            :project-name="projectName ?? undefined"
                            class="text-xs text-gray-400 dark:text-gray-500 mt-0.5 break-all"
                          />
                          <!-- The page at the failing step: screenshot, DOM and ARIA, in the step's own block. -->
                          <FailingStepSnapshot
                            v-if="entry.failing"
                            :test-runs-case-id="testRunsCaseId"
                            :attachments="attachments"
                            :aria-snapshot="ariaSnapshot"
                            :step="stepLabel(entry.step)"
                            :error="error || entry.step.error?.message"
                            :subject="subject"
                            class="mt-2.5"
                          />
                        </div>
                      </td>
                      <td>
                        <TimelineDuration
                          :ms="entry.step.duration"
                          :test-ms="durationMs"
                          :usual-ms="entry.item?.usual ?? null"
                          :bar="stepBar(entry)"
                          :group="tree.groups.has(entry.index)"
                          :failed="entry.failing"
                          :paused-ms="stepPausedMs(entry)"
                          class="min-w-[6rem]"
                        />
                      </td>
                    </tr>
                    <tr v-if="tableShown && inlineSubject && inlinePick?.key === entry.key && data">
                      <td :colspan="tableCols" class="border-b border-default bg-elevated/30 px-3 py-3">
                        <TimelinePagePanel inline class="max-w-md" :subject="inlineSubject" v-bind="inlinePanelProps" />
                      </td>
                    </tr>
                  </template>

                  <!-- An interleaved network / console / backend row -->
                  <template v-else>
                    <tr
                      class="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 [&>td]:border-b [&>td]:border-default [&>td]:px-3 [&>td]:py-2 [&>td]:align-top"
                      :class="[entry.item.failed ? STATUS_PALETTE.failed.tint : '', rowStateClass(entry)]"
                      :data-cited="isCited(entry.item) ? '' : undefined"
                      @mouseenter="hoverKey = entry.key"
                      @mousemove="onRowMove"
                      @click="revealItem(entry.item)"
                    >
                      <td
                        v-if="showAxis"
                        class="tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap"
                      >
                        <button
                          v-if="pagePanelOn"
                          v-bind="timeButtonAttrs(entry)"
                          data-testid="timeline-row-page"
                          @click.stop="pickRow(entry)"
                        >
                          {{ formatRel(entry.item.at) }}
                        </button>
                        <template v-else>{{ formatRel(entry.item.at) }}</template>
                      </td>
                      <td>
                        <UIcon
                          :name="eventIcon(entry.item)"
                          class="size-4"
                          :class="eventIconClass(entry.item)"
                          :title="eventTitle(entry.item)"
                        />
                      </td>
                      <td v-if="thumbsOn">
                        <button
                          v-if="rowFrame(entry)"
                          type="button"
                          class="block w-20 overflow-hidden rounded border border-default bg-elevated cursor-zoom-in outline-none focus-visible:outline-2 focus-visible:outline-primary"
                          :aria-label="`Open the page full screen, ${entry.item ? formatRel(entry.item.at) : ''}`"
                          data-testid="timeline-row-thumbnail"
                          @click.stop="openRowFrame(entry)"
                        >
                          <img
                            :src="rowFrame(entry)!.src"
                            alt=""
                            loading="lazy"
                            class="block aspect-video w-full object-cover object-top"
                          />
                        </button>
                      </td>
                      <td>
                        <div :style="entry.nested ? { paddingInlineStart: '1.25rem' } : undefined">
                          <span v-if="kindTag(entry.item)" class="mr-1.5 text-xs text-muted">{{
                            kindTag(entry.item)
                          }}</span>
                          <span class="font-mono text-xs [overflow-wrap:anywhere] text-gray-700 dark:text-gray-300">{{
                            entry.item.label
                          }}</span>
                          <span v-if="entry.item.kind === 'network'" class="font-mono text-xs text-gray-500">
                            → {{ entry.item.status }}</span
                          >
                          <span v-if="isCited(entry.item)" class="ml-1.5 text-xs text-muted whitespace-nowrap"
                            >Cited by Most likely</span
                          >
                        </div>
                      </td>
                      <td>
                        <TimelineDuration
                          v-if="entry.item.duration != null"
                          :ms="entry.item.duration"
                          :test-ms="requestTestMs(entry.item)"
                          :usual-ms="entry.item.usual ?? null"
                          :bar="itemBar(entry.item)"
                          :failed="entry.item.failed"
                          class="min-w-[6rem]"
                        />
                      </td>
                    </tr>
                    <tr v-if="tableShown && inlineSubject && inlinePick?.key === entry.key && data">
                      <td :colspan="tableCols" class="border-b border-default bg-elevated/30 px-3 py-3">
                        <TimelinePagePanel inline class="max-w-md" :subject="inlineSubject" v-bind="inlinePanelProps" />
                      </td>
                    </tr>
                  </template>
                </template>
              </tbody>
            </table>
          </TableScroller>
          <!-- The page at the hovered or picked row, from the trace's screencast. -->
          <aside v-if="sidePanelOn && panelSubject && data" class="sticky top-3" data-shot="timeline-page-panel">
            <TimelinePagePanel
              :subject="panelSubject"
              :pages="framePages"
              :frame-url="frameUrl"
              :format-time="formatRel"
              :failure-at="data.failureAt"
              :sampled="framesSampled"
              @open="onPanelOpen"
              @move="(at) => (pagePick = { at })"
              @phase="onPanelPhase"
            />
          </aside>
        </div>
      </template>
      <EmptyState v-else icon="i-lucide-list-checks" text="No steps recorded for this execution" />
    </div>

    <Teleport to="body">
      <ChartTooltip v-if="hovered" :pos="pos">
        <p class="tabular-nums text-gray-500 dark:text-gray-400">{{ formatRel(hovered.at) }}</p>
        <p class="font-mono break-words">{{ hovered.label }}</p>
        <p v-if="hovered.kind === 'network'" class="text-gray-500">
          → {{ hovered.status
          }}<template v-if="hovered.duration != null"> · <DurationValue :ms="hovered.duration" no-title /></template>
        </p>
        <p v-else-if="hovered.kind === 'step' && hovered.duration != null" class="text-gray-500">
          <DurationValue :ms="hovered.duration" no-title /><template v-if="hovered.paused">
            · paused <DurationValue :ms="hovered.paused" no-title /></template
          ><span v-if="hovered.failed" :class="STATUS_PALETTE.failed.text"> · failed</span>
        </p>
        <p v-else-if="hovered.status" class="text-gray-500">{{ hovered.status }}</p>
        <p v-if="hoveredCutText" class="text-gray-500">{{ hoveredCutText }}</p>
      </ChartTooltip>
      <ChartTooltip v-if="hoveredFrame" :pos="framePos" data-testid="timeline-screen-preview">
        <img
          :src="hoveredFrame.src"
          alt=""
          class="block w-60 rounded border border-default bg-elevated object-cover object-top"
          :style="{ aspectRatio: String(hoveredFrame.aspect) }"
        />
        <p class="mt-1.5 tabular-nums text-gray-500 dark:text-gray-400">{{ formatRel(hoveredFrame.at) }}</p>
        <p v-if="hoveredFrame.step" class="font-mono break-words">{{ hoveredFrame.step }}</p>
        <p class="text-gray-500 tabular-nums">
          Painted at {{ formatRel(hoveredFrame.paintedAt)
          }}<template v-if="hoveredFrame.atFailure"> · on screen at the failure</template>
        </p>
      </ChartTooltip>
      <ChartTooltip
        v-else-if="hoverCard"
        :pos="hoverCardPos"
        :max-width="HOVER_CARD_W"
        data-testid="timeline-page-hover-card"
      >
        <div :style="{ width: `${HOVER_CARD_W - 18}px` }">
          <div :class="hoverCard.shots.length > 1 ? 'grid grid-cols-2 gap-2' : ''">
            <figure v-for="(shot, i) in hoverCard.shots" :key="i" class="min-w-0">
              <img
                :src="shot.src"
                alt=""
                class="block w-full rounded border bg-elevated object-cover object-top"
                :class="
                  hoverCard.failedLast && i === hoverCard.shots.length - 1 ? 'border-status-failed' : 'border-default'
                "
                :style="{ aspectRatio: String(clampFrameAspect(screenAspect)) }"
              />
              <figcaption class="mt-1 text-xs text-muted tabular-nums">{{ shot.caption }}</figcaption>
            </figure>
          </div>
          <p v-if="hoverCard.unchanged" class="mt-1.5 text-xs text-muted">
            No new frame was painted while this step ran.
          </p>
        </div>
      </ChartTooltip>
    </Teleport>
  </SectionCard>
</template>

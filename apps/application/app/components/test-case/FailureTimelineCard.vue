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
import { findLocationRoot, stepLocations, stripLocationRoot } from '#shared/locator-chain';
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
import type { LightboxSubject } from '~/utils/lightbox';
import { orderedStepParams, pausedOverlap, stepLabel } from '@piwitests/core/step-analysis';
import { formatTimelineTime, pauseReasonText } from '~/utils/timeline';

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
  /** Execution status — a did-not-run row shows a neutral step marker. */
  status?: string | null;
  /** The test's project-relative file — step locations read relative to the project it shows. */
  testFilePath?: string | null;
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
const span = computed(() => (data.value ? Math.max(1, data.value.end - data.value.origin) : 1));
const domain = computed<{ start: number; end: number }>(() => {
  const tl = data.value;
  if (!tl) return { start: 0, end: 1 };
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
const pauseBandTop = computed(() => TOP + (hasCallBand.value ? CALL_BAND_H : 0));
const bandH = computed(() => (hasCallBand.value ? CALL_BAND_H : 0) + (hasPauseBand.value ? PAUSE_BAND_H : 0));
const lanesTop = computed(() => TOP + bandH.value);
const lanesHeight = computed(() => visibleLanes.value.length * LANE_H);
const marksBottom = computed(() => lanesTop.value + lanesHeight.value);
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
const windowShade = computed(() => {
  const tl = data.value;
  if (!tl || mode.value !== 'whole' || tl.window.end <= tl.window.start) return null;
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
    const label = formatRel(tick);
    return i > 0 && formatRel(all[i - 1]!) === label ? '' : label;
  }),
);

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
  const where = span.origin ? ` · ${span.origin.file}:${span.origin.line}` : '';
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

/** The left inset of a step's title: its depth in the tree, plus one inside a section. */
function stepIndent(row: StepRow & { nested: boolean }): Record<string, string> {
  const level = row.level + (row.nested ? 1 : 0);
  return level > 0 ? { paddingInlineStart: `${level * 1.25}rem` } : {};
}

// Step locations read relative to the project, found from the test's own file.
const locationRoot = computed(() => findLocationRoot(stepLocations(props.steps), props.testFilePath ?? null));
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
            :aria-pressed="mode === option.value ? 'true' : 'false'"
            class="rounded px-2 py-0.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            :class="mode === option.value ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
            @click="mode = option.value"
          >
            {{ option.label }}
          </button>
        </div>
        <TimelineTypeFilter
          v-if="showTypeFilter"
          :types="windowTypes"
          :items="windowItems"
          :hidden="hiddenTypes"
          @toggle="toggleType($event, windowTypes)"
          @only="onlyType"
          @show-all="showAllTypes"
        />
        <ChartLegend :items="showTypeFilter ? markKeyItems : legendItems" class="ml-auto" />
      </div>

      <!-- SVG axis -->
      <div v-if="showAxis && data" ref="wrapper" class="w-full">
        <svg v-if="plotWidth > 0" :width="svgWidth" :height="svgHeight" class="block">
          <!-- Default-window shade (only meaningful in whole-test view) -->
          <rect
            v-if="windowShade"
            :x="windowShade.x"
            :y="TOP"
            :width="windowShade.w"
            :height="marksBottom - TOP"
            class="fill-gray-400/10 dark:fill-gray-300/5"
          />

          <!-- Calls band: which method / test.step each run of actions came from -->
          <g v-if="hasCallBand">
            <text
              :x="0"
              :y="TOP + CALL_BAND_H / 2"
              dominant-baseline="middle"
              class="fill-gray-500 dark:fill-gray-400 text-[10px]"
            >
              Calls
            </text>
            <g v-for="span in callSpans" :key="span.id">
              <rect
                :x="barRect(span.start, span.end - span.start).x"
                :y="TOP + 2"
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
                :y="TOP + CALL_BAND_H / 2"
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
              :class="stepClass(item)"
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
              :class="networkClass(item)"
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
              :class="pointClass(item)"
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
              :class="pointClass(item)"
              @click="revealItem(item)"
              @mouseenter="show($event, item)"
              @mousemove="move($event)"
              @mouseleave="hide()"
            />
          </template>

          <!-- Failure marker line -->
          <line
            :x1="failureX"
            :x2="failureX"
            :y1="TOP"
            :y2="marksBottom"
            class="stroke-status-failed"
            stroke-width="1.5"
            stroke-dasharray="4 3"
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
        </svg>
      </div>

      <!-- Filmstrip: the page before each step, from this run's trace screen snapshots. -->
      <TraceFilmstrip :test-runs-case-id="testRunsCaseId" :error="error" :subject="subject" />

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
                <span
                  v-if="showAxis && entry.item"
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
                <span
                  v-if="showAxis"
                  class="shrink-0 tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap"
                  :class="isCited(entry.item) ? '' : 'ml-auto'"
                >
                  {{ formatRel(entry.item.at) }}
                </span>
              </div>
              <TimelineDuration
                v-if="entry.item.duration != null"
                :ms="entry.item.duration"
                :test-ms="requestTestMs(entry.item)"
                :usual-ms="entry.item.usual ?? null"
                :bar="itemBar(entry.item)"
                :failed="entry.item.failed"
                class="mt-1.5"
              />
            </div>
          </template>
        </div>

        <!-- One table: steps, with network / console / backend items interleaved
             in time order. `min-width` keeps the columns readable while the
             wrapper (not the page) scrolls; on a phone the stacked cards above
             replace it, so the table shows from `md` up. -->
        <TableScroller min-width="34rem" :bleed="false" class="hidden md:block">
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
                <th>Step</th>
                <th class="w-40 last:rounded-r-lg last:border-r">Duration</th>
              </tr>
            </thead>
            <tbody>
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
                    :class="entry.failing ? STATUS_PALETTE.failed.tint : ''"
                    :data-cited="isCited(entry.item) ? '' : undefined"
                  >
                    <td v-if="showAxis" class="tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">
                      {{ entry.item ? formatRel(entry.item.at) : '' }}
                    </td>
                    <td>
                      <StepStatusMark :role="entry.role" :not-run="status === 'didnotrun'" />
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
                </template>

                <!-- An interleaved network / console / backend row -->
                <tr
                  v-else
                  class="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 [&>td]:border-b [&>td]:border-default [&>td]:px-3 [&>td]:py-2 [&>td]:align-top"
                  :class="entry.item.failed ? STATUS_PALETTE.failed.tint : ''"
                  :data-cited="isCited(entry.item) ? '' : undefined"
                  @click="revealItem(entry.item)"
                >
                  <td v-if="showAxis" class="tabular-nums text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">
                    {{ formatRel(entry.item.at) }}
                  </td>
                  <td>
                    <UIcon
                      :name="eventIcon(entry.item)"
                      class="size-4"
                      :class="eventIconClass(entry.item)"
                      :title="eventTitle(entry.item)"
                    />
                  </td>
                  <td>
                    <div :style="entry.nested ? { paddingInlineStart: '1.25rem' } : undefined">
                      <span v-if="kindTag(entry.item)" class="mr-1.5 text-xs text-muted">{{
                        kindTag(entry.item)
                      }}</span>
                      <span class="font-mono text-xs break-all text-gray-700 dark:text-gray-300">{{
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
              </template>
            </tbody>
          </table>
        </TableScroller>
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
    </Teleport>
  </SectionCard>
</template>

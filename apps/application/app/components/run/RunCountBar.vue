<script setup lang="ts">
/**
 * The run's one count bar: a proportional stacked bar with each count written
 * on its segment, followed by its label, or a short label, when it fits. Each
 * segment is a filter — clicking it toggles that status in the Tests tab's
 * filter set and switches to the Tests tab. Zero-count segments are hidden
 * unless selected. Flaky (passed on retry) is a subset of passed, so it is
 * subtracted from the passed segment to avoid double-counting; fixme is a
 * subset of skipped the same way, drawn in the second grey.
 */
import { useResizeObserver } from '@vueuse/core';

const props = defineProps<{
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  /** `test.fixme()` skips — a subset of `skipped`. */
  fixme?: number;
  didNotRun: number;
  total: number;
  /** The status filters currently active, which the Tests list applies. */
  activeStatuses: string[];
}>();

const emit = defineEmits<{ 'toggle-status': [status: string] }>();

interface Segment {
  key: string;
  status: string;
  label: string;
  /** Written in place of the label on a segment too narrow for it. */
  short?: string;
  count: number;
  palette: StatusPaletteEntry;
}

const segments = computed<Segment[]>(() => {
  const passedOnly = Math.max(0, props.passed - props.flaky);
  const fixme = Math.min(props.fixme ?? 0, props.skipped);
  const all: Segment[] = [
    { key: 'passed', status: 'passed', label: 'passed', count: passedOnly, palette: STATUS_PALETTE.passed },
    { key: 'failed', status: 'failed', label: 'failed', count: props.failed, palette: STATUS_PALETTE.failed },
    {
      key: 'flaky',
      status: 'flaky',
      label: 'passed on retry',
      short: 'flaky',
      count: props.flaky,
      palette: STATUS_PALETTE.flaky,
    },
    {
      key: 'skipped',
      status: 'skipped',
      label: 'skipped',
      count: props.skipped - fixme,
      palette: STATUS_PALETTE.skipped,
    },
    { key: 'fixme', status: 'fixme', label: 'fixme', count: fixme, palette: STATUS_PALETTE.fixme },
    {
      key: 'didnotrun',
      status: 'didnotrun',
      label: "didn't run",
      short: 'dnr',
      count: props.didNotRun,
      palette: STATUS_PALETTE.didnotrun,
    },
  ];
  // A selected outcome keeps its segment at zero (a live retry can take the
  // last failure away), so the filter can still be turned off.
  return all.filter((s) => s.count > 0 || isActive(s.status));
});

function isActive(status: string): boolean {
  return props.activeStatuses.includes(status);
}

// While a run is live the tests without an outcome yet are bare track after the segments.
const remaining = computed(() => Math.max(0, props.total - segments.value.reduce((sum, s) => sum + s.count, 0)));

// ── Fitting the text ─────────────────────────────────────────────────────────
// A segment's horizontal padding (`px-2`), the gap between its count and label
// (`gap-x-1`) and the gap between segments (`gap-0.5`).
const SEGMENT_PADDING_PX = 16;
const LABEL_GAP_PX = 4;
const SEGMENT_GAP_PX = 2;

const track = useTemplateRef<HTMLElement>('track');

// The track's and each segment's width (the track under `track`), and the text
// measured in the segments' font: both read in the browser only, so the server
// render leaves every choice to the CSS.
const widths = ref<Record<string, number>>({});
let context: CanvasRenderingContext2D | null = null;
const fontVersion = ref(0);

function readFont() {
  if (!track.value) return;
  context ??= document.createElement('canvas').getContext('2d');
  if (!context) return;
  context.font = getComputedStyle(track.value).font;
  fontVersion.value++;
}

// The segment elements, collected again whenever the set of segments changes:
// a template ref list on a `v-for` is not reactive.
const segmentEls = shallowRef<HTMLElement[]>([]);
function collectSegments() {
  const el = track.value;
  segmentEls.value = el ? [...el.querySelectorAll<HTMLElement>('[data-segment]')] : [];
  const keys = new Set(['track', ...segments.value.map((s) => s.key)]);
  widths.value = Object.fromEntries(Object.entries(widths.value).filter(([key]) => keys.has(key)));
  if (el && !fontVersion.value) readFont();
}

onMounted(() => {
  collectSegments();
  // The web font may land after mount; measure again with it.
  document.fonts?.ready.then(readFont);
});
watch([track, () => segments.value.map((s) => s.key).join(' ')], collectSegments, { flush: 'post' });

useResizeObserver(
  () => (track.value ? [track.value, ...segmentEls.value] : []),
  (entries) => {
    const next = { ...widths.value };
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const key = el === track.value ? 'track' : el.dataset.segment;
      if (key) next[key] = entry.borderBoxSize[0]?.inlineSize ?? el.offsetWidth;
    }
    widths.value = next;
  },
);

/** The width the count and a label take on a segment, or null before the font is read. */
function textWidth(count: number, label?: string): number | null {
  if (!fontVersion.value || !context) return null;
  const countWidth = context.measureText(String(count)).width;
  return label ? countWidth + LABEL_GAP_PX + context.measureText(label).width : countWidth;
}

/** The width a segment needs to show its count and a label. */
function segmentWidthFor(seg: Segment, label?: string): number {
  return Math.ceil(textWidth(seg.count, label) ?? 0) + SEGMENT_PADDING_PX + 1;
}

/**
 * The label a segment writes after its count: the label when it fits, else the
 * short one, else none. Before anything is measured it offers the label, and
 * the segment's one clipped line wraps a label that does not fit out of sight.
 */
function shownLabel(seg: Segment): string | undefined {
  const width = widths.value[seg.key];
  if (width == null || textWidth(seg.count) == null) return seg.label;
  if (segmentWidthFor(seg, seg.label) <= width + 0.5) return seg.label;
  return seg.short && segmentWidthFor(seg, seg.short) <= width + 0.5 ? seg.short : undefined;
}

/** What the segment is called: the text it shows first, then the whole label when it shows less. */
function segmentName(seg: Segment): string {
  const shown = shownLabel(seg);
  return shown && shown !== seg.label ? `${seg.count} ${shown}, ${seg.label}` : `${seg.count} ${seg.label}`;
}

/**
 * Each segment's minimum width: what its count needs, and for a selected one
 * what its whole label, else its short label, needs, as long as every segment
 * still fits on the track. Before anything is measured, an estimate of the count.
 */
const minWidths = computed<Record<string, string>>(() => {
  const list = segments.value;
  if (textWidth(0) == null) {
    return Object.fromEntries(list.map((s) => [s.key, `${String(s.count).length * 0.55 + 1}rem`]));
  }
  const px = list.map((s) => segmentWidthFor(s));
  const gaps = SEGMENT_GAP_PX * (list.length - 1 + (remaining.value > 0 ? 1 : 0));
  const room = (widths.value.track ?? Infinity) - gaps;
  let total = px.reduce((sum, w) => sum + w, 0);
  list.forEach((s, i) => {
    if (!isActive(s.status)) return;
    for (const label of [s.label, s.short]) {
      if (!label) continue;
      const wide = segmentWidthFor(s, label);
      if (total - px[i]! + wide <= room) {
        total += wide - px[i]!;
        px[i] = wide;
        break;
      }
    }
  });
  return Object.fromEntries(list.map((s, i) => [s.key, `${px[i]}px`]));
});

/**
 * Each segment grows in proportion to its count, but never narrower than its
 * minimum width. A selected segment carries an inner ring; while any status
 * filter is on, the segments it leaves out fade. The track is a pill that clips
 * its segments, and the segments at its ends round their outer corners too, so
 * a selected or focused end segment keeps the pill's curve.
 */
function segmentStyle(seg: Segment): Record<string, string> {
  return { flex: `${seg.count} 1 0%`, minWidth: minWidths.value[seg.key] ?? '0' };
}

function segmentClass(seg: Segment): string[] {
  const active = isActive(seg.status);
  const faded = props.activeStatuses.length > 0 && !active;
  return [
    seg.palette.bg,
    seg.palette.onBg,
    active ? 'inset-ring-2 inset-ring-current/60' : '',
    faded ? 'opacity-50 hover:opacity-75' : 'hover:opacity-90',
  ];
}
</script>

<template>
  <div v-if="total > 0" class="flex items-center gap-3">
    <span class="shrink-0 text-xs text-muted tabular-nums">{{ total }} tests</span>
    <div
      ref="track"
      class="flex flex-1 min-w-0 h-6 gap-0.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700 text-xs font-semibold"
    >
      <button
        v-for="seg in segments"
        :key="seg.key"
        type="button"
        :data-segment="seg.key"
        class="flex flex-wrap justify-center gap-x-1 h-6 overflow-hidden px-2 first:rounded-l-full last:rounded-r-full leading-6 whitespace-nowrap text-shadow-xs cursor-pointer transition-[flex-grow,min-width,opacity] duration-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
        :class="segmentClass(seg)"
        :style="segmentStyle(seg)"
        :aria-label="segmentName(seg)"
        :aria-pressed="isActive(seg.status)"
        :title="`${seg.count} ${seg.label}`"
        @click="emit('toggle-status', seg.status)"
      >
        <span>{{ seg.count }}</span>
        <span v-if="shownLabel(seg)" class="font-medium">{{ shownLabel(seg) }}</span>
      </button>
      <div v-if="remaining > 0" :style="{ flex: `${remaining} 1 0%` }" aria-hidden="true" />
    </div>
  </div>
</template>

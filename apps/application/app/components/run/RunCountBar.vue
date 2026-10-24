<script setup lang="ts">
/**
 * The run's one count bar: a proportional stacked bar with each count written
 * on its segment, followed by its label, or a short label, when it fits. Each
 * segment is a filter — clicking it toggles that status in the Tests tab's
 * filter set and switches to the Tests tab. Zero-count segments are hidden.
 * Flaky (passed on retry) is a subset of passed, so it is subtracted from the
 * passed segment to avoid double-counting; fixme is a subset of skipped the
 * same way, drawn in the second grey.
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
  return (
    [
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
    ] satisfies Segment[]
  ).filter((s) => s.count > 0);
});

function isActive(status: string): boolean {
  return props.activeStatuses.includes(status);
}

// While a run is live the tests without an outcome yet are bare track after the segments.
const remaining = computed(() => Math.max(0, props.total - segments.value.reduce((sum, s) => sum + s.count, 0)));

// ── Fitting the text ─────────────────────────────────────────────────────────
// A segment's horizontal padding (`px-2`) and the gap between its count and label (`gap-x-1`).
const SEGMENT_PADDING_PX = 16;
const LABEL_GAP_PX = 4;

const track = useTemplateRef<HTMLElement>('track');
const segmentEls = useTemplateRef<HTMLElement[]>('segment');

// Each segment's width, and the text measured in the segments' font: both read
// in the browser only, so the server render leaves every choice to the CSS.
const segmentWidths = ref<Record<string, number>>({});
let context: CanvasRenderingContext2D | null = null;
const fontReady = ref(0);

function readFont() {
  if (!track.value) return;
  context ??= document.createElement('canvas').getContext('2d');
  if (!context) return;
  context.font = getComputedStyle(track.value).font;
  fontReady.value++;
}

onMounted(() => {
  readFont();
  // The web font may land after mount; measure again with it.
  document.fonts?.ready.then(readFont);
});

useResizeObserver(
  () => segmentEls.value ?? [],
  (entries) => {
    const widths = { ...segmentWidths.value };
    for (const entry of entries) {
      const key = (entry.target as HTMLElement).dataset.segment;
      if (key) widths[key] = entry.borderBoxSize[0]?.inlineSize ?? (entry.target as HTMLElement).offsetWidth;
    }
    segmentWidths.value = widths;
  },
);

/** The width the count and a label take on a segment, or null before the font is read. */
function textWidth(count: number, label: string | undefined): number | null {
  if (!fontReady.value || !context) return null;
  const countWidth = context.measureText(String(count)).width;
  return label ? countWidth + LABEL_GAP_PX + context.measureText(label).width : countWidth;
}

/**
 * The label a segment writes after its count: the label when it fits, else the
 * short one, else none. Before anything is measured it offers the label, and
 * the segment's one clipped line wraps a label that does not fit out of sight.
 */
function shownLabel(seg: Segment): string | undefined {
  const width = segmentWidths.value[seg.key];
  const full = textWidth(seg.count, seg.label);
  if (width == null || full == null) return seg.label;
  const room = width - SEGMENT_PADDING_PX + 0.5;
  if (full <= room) return seg.label;
  const short = textWidth(seg.count, seg.short);
  return seg.short && short != null && short <= room ? seg.short : undefined;
}

/**
 * Each segment grows in proportion to its count, but never narrower than its
 * count needs; a selected one is wide enough for its whole label. While any
 * status filter is on, the segments it leaves out fade. The track is a pill
 * that clips its segments, and the segments at its ends round their outer
 * corners too, so a selected or focused end segment keeps the pill's curve.
 */
function segmentStyle(seg: Segment): Record<string, string> {
  const needed = textWidth(seg.count, isActive(seg.status) ? seg.label : undefined);
  const minWidth =
    needed == null ? `${String(seg.count).length * 0.55 + 1}rem` : `${Math.ceil(needed) + SEGMENT_PADDING_PX + 1}px`;
  return { flex: `${seg.count} 1 0%`, minWidth };
}

function segmentClass(seg: Segment): string[] {
  const faded = props.activeStatuses.length > 0 && !isActive(seg.status);
  return [seg.palette.bg, seg.palette.onBg, faded ? 'opacity-50 hover:opacity-75' : 'hover:opacity-90'];
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
        ref="segment"
        :key="seg.key"
        type="button"
        :data-segment="seg.key"
        class="flex flex-wrap justify-center gap-x-1 h-6 overflow-hidden px-2 first:rounded-l-full last:rounded-r-full leading-6 whitespace-nowrap text-shadow-xs cursor-pointer transition-[flex-grow,min-width,opacity] duration-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
        :class="segmentClass(seg)"
        :style="segmentStyle(seg)"
        :aria-label="`${seg.count} ${seg.label}`"
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

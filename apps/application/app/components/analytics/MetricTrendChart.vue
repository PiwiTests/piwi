<script setup lang="ts">
import type { AnalyticsMetricWidget, AnalyticsSeriesPoint } from '#shared/analytics/types';
import { barGeometry, bucketTimeToX, dayTickIndices, formatTickDate } from '~/utils/chart';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const {
  data: widget,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsMetricWidget>(
  'metric',
  () => props.query,
  () => props.options,
);

const f = computed(() => metricFormatter());
const cardTitle = computed(() => {
  if (props.title) return props.title;
  const w = widget.value;
  if (!w) return 'Metric';
  return w.breakdown ? `${w.value.label} by ${w.breakdown.label.toLowerCase()}` : w.value.label;
});
const showMarkers = computed(() => props.options?.markers !== false);

/** The drawn numbers as a table: one row per bucket, or per group of a breakdown. */
const exportData = computed(() => {
  const w = widget.value;
  if (!w) return null;
  if (w.breakdown) {
    const withPoints = w.breakdown.groups.filter((g) => g.points);
    if (withPoints.length > 0 && (w.display === 'line' || w.display === 'heatmap')) {
      const dates = withPoints[0]!.points!.map((p) => p.date);
      return {
        name: cardTitle.value,
        header: ['date', ...withPoints.map((g) => g.label)],
        rows: dates.map((date, i) => [date, ...withPoints.map((g) => g.points![i]?.value ?? null)]),
      };
    }
    return {
      name: cardTitle.value,
      header: [w.breakdown.label, w.value.label, 'change'],
      rows: w.breakdown.groups.map((g) => [g.label, g.value.value, g.value.delta]),
    };
  }
  if (w.points.length === 0) return { name: cardTitle.value, header: [w.value.label], rows: [[w.value.value]] };
  return {
    name: cardTitle.value,
    header: ['date', w.value.label, ...(w.previousPoints ? [w.comparisonLabel ?? 'comparison'] : [])],
    rows: w.points.map((p, i) => [p.date, p.value, ...(w.previousPoints ? [w.previousPoints[i]?.value ?? null] : [])]),
  };
});

/** With one project in scope, a bucket opens the list behind the metric for those days. */
const drill = computed(() => {
  const w = widget.value;
  const list = w ? metricDrillList(w.value.metric) : null;
  return w && list ? bucketDrill(props.query, w.bucketDays, list) : null;
});

const LINE_COLOR = 'var(--ui-primary)';
const PREVIOUS_COLOR = 'var(--ui-text-dimmed)';

const points = computed(() => widget.value?.points ?? []);
const previous = computed(() => {
  const series = widget.value?.previousPoints ?? null;
  return series && series.some((p) => p.value !== null) ? series : null;
});
const dates = computed(() => points.value.map((p) => new Date(`${p.date}T00:00:00Z`)));
const hasData = computed(() => points.value.some((p) => p.value !== null));

const target = computed(() => widget.value?.target ?? null);
const targetColor = computed(() =>
  target.value?.met === false ? STATUS_PALETTE.failed.color : STATUS_PALETTE.passed.color,
);

const yMax = computed(() => {
  if (widget.value?.value.unit === 'percent') return 100;
  const values = [...points.value, ...(previous.value ?? [])].map((p) => p.value ?? 0);
  return Math.max(1, target.value?.value ?? 0, ...values);
});

const targetText = computed(() => {
  const w = widget.value;
  const t = target.value;
  if (!w || !t) return null;
  const outcome = t.met === null ? 'nothing to judge yet' : t.met ? 'met' : 'missed';
  return `Target ${t.direction === 'min' ? '≥' : '≤'} ${f.value.value(t.value, w.value.unit, w.value.precision, w.value.currency)} · ${outcome}`;
});

const legend = computed(() => {
  if (widget.value?.display !== 'line' || widget.value.breakdown) return [];
  const items: { color: string; label: string }[] = [];
  if (previous.value) {
    items.push({ color: LINE_COLOR, label: 'This period' });
    items.push({ color: PREVIOUS_COLOR, label: widget.value?.comparisonLabel ?? 'Comparison' });
  }
  if (target.value) items.push({ color: targetColor.value, label: 'Target' });
  return items;
});

/** A path through the non-null points; a gap in the data is a gap in the line. */
function pathOf(series: AnalyticsSeriesPoint[], plotWidth: number, yScale: (v: number) => number): string {
  const { centerOf } = barGeometry(series.length, plotWidth);
  let d = '';
  let pen = false;
  series.forEach((p, i) => {
    if (p.value === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${centerOf(i)},${yScale(p.value)}`;
    pen = true;
  });
  return d;
}

function dots(plotWidth: number, yScale: (v: number) => number) {
  const { centerOf } = barGeometry(points.value.length, plotWidth);
  return points.value.flatMap((p, i) => (p.value === null ? [] : [{ x: centerOf(i), y: yScale(p.value), p }]));
}

function xTicks(plotWidth: number) {
  const { centerOf } = barGeometry(points.value.length, plotWidth);
  return dayTickIndices(dates.value, Math.max(2, Math.floor(plotWidth / 80))).map((i) => ({
    x: centerOf(i),
    label: formatTickDate(dates.value[i] as Date),
  }));
}

function yFormat(value: number): string {
  const unit = widget.value?.value.unit;
  return unit === 'percent' ? `${value}%` : unit === 'minutes' ? `${value}m` : String(value);
}

const scopeSummary = injectAnalyticsScopeSummary();
const markers = computed(() => (showMarkers.value ? (scopeSummary.value?.markers ?? []) : []));
function markerX(plotWidth: number, occurredAt: string | Date): number | null {
  const { centerOf } = barGeometry(points.value.length, plotWidth);
  const end = scopeSummary.value ? new Date(scopeSummary.value.period.to).getTime() : Date.now();
  return bucketTimeToX(
    dates.value,
    points.value.map((_, i) => centerOf(i)),
    new Date(occurredAt).getTime(),
    end,
  );
}

const { data: tooltipData, pos: tooltipPos, show, move, hide } = useChartTooltip<{ i: number }>(240);
</script>

<template>
  <ChartCard
    icon="i-lucide-chart-spline"
    :title="cardTitle"
    :legend="legend"
    help="analytics.metric"
    data-tour="analytics-metric"
    :export-data="exportData"
    data-shot="analytics-metric"
  >
    <template v-if="widget" #actions>
      <span class="text-sm font-semibold tabular-nums" :class="metricValueClass(widget.value)">
        {{ formatMetric(widget.value, f) }}
      </span>
      <span v-if="f.delta(widget.value)" class="text-xs tabular-nums" :class="metricTrendClass(widget.value.trend)">
        {{ f.delta(widget.value) }}
      </span>
      <span
        v-if="targetText"
        class="text-xs tabular-nums"
        :class="targetClass(target?.met ?? null)"
        data-testid="metric-target"
        >{{ targetText }}</span
      >
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load ${cardTitle.toLowerCase()}: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <div v-else-if="widget && widget.display === 'stat'" class="py-2">
      <p class="text-2xl font-semibold tabular-nums" :class="metricValueClass(widget.value)">
        {{ formatMetric(widget.value, f) }}
      </p>
      <p v-if="sampleNote(widget.value)" class="text-xs text-muted">{{ sampleNote(widget.value) }}</p>
      <p class="text-xs text-muted">{{ widget.value.definition }}</p>
    </div>
    <MetricDisplay v-else-if="widget && (widget.breakdown || widget.display !== 'line')" :widget="widget" />
    <EmptyState v-else-if="!hasData" text="No runs in this period." />
    <div v-else class="w-full">
      <ChartFrame v-slot="{ plotWidth, plotHeight, yScale }" :height="220" :y-max="yMax" :y-format="yFormat">
        <path
          v-if="previous"
          :d="pathOf(previous, plotWidth, yScale)"
          fill="none"
          :stroke="PREVIOUS_COLOR"
          stroke-width="1.5"
          stroke-dasharray="4 3"
          opacity="0.7"
        />
        <line
          v-if="target"
          :x1="0"
          :x2="plotWidth"
          :y1="yScale(target.value)"
          :y2="yScale(target.value)"
          :style="{ stroke: targetColor }"
          stroke-width="1.5"
          stroke-dasharray="2 3"
          data-testid="metric-target-line"
        />
        <path :d="pathOf(points, plotWidth, yScale)" fill="none" :stroke="LINE_COLOR" stroke-width="2" />
        <circle
          v-for="dot in dots(plotWidth, yScale)"
          :key="dot.p.date"
          :cx="dot.x"
          :cy="dot.y"
          r="2.5"
          :fill="LINE_COLOR"
        />
        <text
          v-for="tick in xTicks(plotWidth)"
          :key="tick.x"
          :x="tick.x"
          :y="plotHeight + 14"
          text-anchor="middle"
          class="fill-gray-400 dark:fill-gray-500 text-[10px]"
        >
          {{ tick.label }}
        </text>
        <rect
          v-for="(p, i) in points"
          :key="`hover-${p.date}`"
          :x="i * (plotWidth / points.length)"
          :y="0"
          :width="plotWidth / points.length"
          :height="plotHeight"
          :fill="tooltipData?.i === i ? 'rgb(148 163 184 / 0.15)' : 'transparent'"
          :class="drill ? 'cursor-pointer' : ''"
          @click="drill && navigateTo(drill(p.date))"
          @mouseenter="show($event, { i })"
          @mousemove="move($event)"
          @mouseleave="hide()"
        />
        <ChartMarkerLines
          :markers="markers"
          :x-of="(occurredAt) => markerX(plotWidth, occurredAt)"
          :plot-height="plotHeight"
        />
      </ChartFrame>

      <ChartTooltip v-if="tooltipData && widget" :pos="tooltipPos">
        <div class="font-semibold mb-1">{{ f.date(points[tooltipData.i]!.date) }}</div>
        <div>
          {{ f.value(points[tooltipData.i]!.value, widget.value.unit, widget.value.precision, widget.value.currency) }}
        </div>
        <div v-if="previous" class="text-gray-400 text-xs">
          {{ widget.comparisonLabel }}:
          {{
            f.value(
              previous[tooltipData.i]?.value ?? null,
              widget.value.unit,
              widget.value.precision,
              widget.value.currency,
            )
          }}
        </div>
      </ChartTooltip>
    </div>
  </ChartCard>
</template>

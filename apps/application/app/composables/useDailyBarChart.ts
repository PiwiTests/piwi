import type { Ref } from 'vue';
import { barGeometry, bucketTimeToX, dayTickIndices, formatTickDate, stackSegments } from '~/utils/chart';

/**
 * What an Analytics chart of one bucket per day shares: a slot per bucket, its
 * stacked bar when the chart draws bars, the date ticks, the x of a timeline
 * marker of the period (the analytics page provides the markers), the tooltip,
 * and the bucket's runs a click opens when one project is in scope.
 */
export function useDailyBarChart<T extends { date: Date }>(options: {
  points: Ref<T[]>;
  /** The days a bucket spans, once the data is loaded. */
  bucketDays: () => number | null | undefined;
  /** The analytics query the chart reads, which names the projects in scope. */
  query: () => Record<string, string>;
  /** A bar's segments, bottom-up; a chart without bars leaves it out. */
  segments?: (point: T) => Array<{ color: string; value: number }>;
}) {
  const scopeSummary = injectAnalyticsScopeSummary();
  const markers = computed(() => scopeSummary.value?.markers ?? []);
  const tooltip = useChartTooltip<T>(240);

  function geometry(plotWidth: number) {
    return barGeometry(options.points.value.length, plotWidth);
  }

  /** The x of each bucket's center. */
  function centers(plotWidth: number): number[] {
    const { centerOf } = geometry(plotWidth);
    return options.points.value.map((_, i) => centerOf(i));
  }

  /** One slot per bucket: the hover target, and the stacked bar inside it. */
  function layout(plotWidth: number, plotHeight: number, yScale: (value: number) => number) {
    const geo = geometry(plotWidth);
    return options.points.value.map((d, i) => ({
      d,
      slotX: i * geo.slotWidth,
      slotWidth: geo.slotWidth,
      barX: geo.xOf(i),
      barWidth: geo.barWidth,
      segments: options.segments ? stackSegments(options.segments(d), plotHeight, yScale) : [],
    }));
  }

  function xTicks(plotWidth: number) {
    const xs = centers(plotWidth);
    const dates = options.points.value.map((d) => d.date);
    return dayTickIndices(dates, Math.max(2, Math.floor(plotWidth / 80))).map((i) => ({
      x: xs[i]!,
      label: formatTickDate(dates[i] as Date),
    }));
  }

  function markerX(plotWidth: number, occurredAt: string | Date): number | null {
    const end = scopeSummary.value ? new Date(scopeSummary.value.period.to).getTime() : Date.now();
    return bucketTimeToX(
      options.points.value.map((d) => d.date),
      centers(plotWidth),
      new Date(occurredAt).getTime(),
      end,
    );
  }

  /** With one project in scope, a bucket opens that project's runs of those days. */
  const drill = computed(() => {
    const days = options.bucketDays();
    return days == null ? null : bucketDrill(options.query(), days);
  });

  function openBucket(date: Date) {
    const href = drill.value?.(date.toISOString().slice(0, 10));
    if (href) void navigateTo(href);
  }

  return { markers, tooltip, centers, layout, xTicks, markerX, drill, openBucket };
}

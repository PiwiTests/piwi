<script setup lang="ts">
import type { AnalyticsWastedTime } from '#shared/analytics/types';
import { TIMELINE_WAIT_COLORS } from '~/utils/timeline';
import { formatMoney } from '#shared/ci-cost';

const props = defineProps<{ query: Record<string, string> }>();

const {
  data: wasted,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsWastedTime>('wasted-time', () => props.query);

type DataPoint = { date: Date; waitMinutes: number; failedExecMinutes: number };

const chartData = computed<DataPoint[]>(
  () =>
    wasted.value?.points.map((p) => ({
      date: new Date(p.date),
      waitMinutes: p.waitMinutes,
      failedExecMinutes: p.failedExecMinutes,
    })) ?? [],
);

const hasData = computed(() => chartData.value.some((p) => p.waitMinutes > 0 || p.failedExecMinutes > 0));

const areaColors = [TIMELINE_WAIT_COLORS.swatch, STATUS_PALETTE.failed.color] as const;

const yMax = computed(() => Math.max(1, ...chartData.value.map((d) => d.waitMinutes + d.failedExecMinutes)));

// One stacked bar per day: wait minutes on the baseline, failed-run minutes above.
const { markers, tooltip, layout, xTicks, markerX, drill, openBucket } = useDailyBarChart({
  points: chartData,
  bucketDays: () => wasted.value?.bucketDays,
  query: () => props.query,
  segments: (d) => [
    { color: areaColors[0], value: d.waitMinutes },
    { color: areaColors[1], value: d.failedExecMinutes },
  ],
});
const { data: tooltipData, pos: tooltipPos, show, move, hide } = tooltip;

const legendItems = [
  { color: areaColors[0], label: 'Wait steps' },
  { color: areaColors[1], label: 'Failed attempts' },
];

const exportData = computed(() =>
  wasted.value
    ? {
        name: 'wasted-ci-time',
        header: ['date', 'wait minutes', 'failed attempt minutes'],
        rows: wasted.value.points.map((p) => [p.date, p.waitMinutes, p.failedExecMinutes]),
      }
    : null,
);

const subtitle = computed(() => {
  if (!wasted.value) return undefined;
  const total = wasted.value.totalWaitMinutes + wasted.value.totalFailedExecMinutes;
  const label = total < 60 ? `${Math.round(total)} min` : `${Math.round((total / 60) * 10) / 10} h`;
  const cost = wasted.value.cost;
  const money = cost ? ` (${formatMoney(cost.amount, cost.currency, viewerLocale())})` : '';
  return `${label}${money} of CI time produced no signal`;
});

const reclaim = computed(() => wasted.value?.timeoutReclaimable ?? null);
const reclaimLabel = computed(() => {
  const m = reclaim.value?.estimatedMinutes ?? 0;
  return m < 60 ? `${Math.round(m)} min` : `${Math.round((m / 60) * 10) / 10} h`;
});
</script>

<template>
  <ChartCard
    icon="i-lucide-hourglass"
    title="Wasted CI time"
    :subtitle="subtitle"
    help="analytics.wasted-time"
    data-tour="analytics-wasted-time"
    :legend="legendItems"
    :export-data="exportData"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load wasted time: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!hasData" text="No wasted time recorded in this period." />
    <div v-else class="w-full">
      <ChartFrame
        v-slot="{ plotWidth, plotHeight, yScale }"
        :height="220"
        :y-max="yMax"
        :y-format="(value) => `${value}m`"
      >
        <template v-for="bar in layout(plotWidth, plotHeight, yScale)" :key="bar.d.date.getTime()">
          <rect
            v-for="segment in bar.segments"
            :key="segment.color"
            :x="bar.barX"
            :y="segment.y"
            :width="bar.barWidth"
            :height="segment.height"
            :style="{ fill: segment.color }"
          />
        </template>

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
          v-for="bar in layout(plotWidth, plotHeight, yScale)"
          :key="`hover-${bar.d.date.getTime()}`"
          :x="bar.slotX"
          :y="0"
          :width="bar.slotWidth"
          :height="plotHeight"
          :fill="tooltipData === bar.d ? 'rgb(148 163 184 / 0.15)' : 'transparent'"
          :class="drill ? 'cursor-pointer' : ''"
          @click="openBucket(bar.d.date)"
          @mouseenter="show($event, bar.d)"
          @mousemove="move($event)"
          @mouseleave="hide()"
        />
        <ChartMarkerLines
          :markers="markers"
          :x-of="(occurredAt) => markerX(plotWidth, occurredAt)"
          :plot-height="plotHeight"
        />
      </ChartFrame>

      <ChartTooltip v-if="tooltipData" :pos="tooltipPos">
        <div class="font-semibold mb-1">
          {{ tooltipData.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }}
        </div>
        <div><span :style="{ color: areaColors[0] }">&#9679;</span> Wait steps: {{ tooltipData.waitMinutes }} min</div>
        <div>
          <span :style="{ color: areaColors[1] }">&#9679;</span> Failed attempts:
          {{ tooltipData.failedExecMinutes }} min
        </div>
      </ChartTooltip>

      <div
        v-if="reclaim"
        class="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm dark:border-amber-900/50 dark:bg-amber-950/30"
      >
        <UIcon name="i-lucide-scissors" class="mt-0.5 shrink-0 text-amber-500" />
        <div class="text-gray-700 dark:text-gray-300">
          Up to <span class="font-semibold">≈{{ reclaimLabel }}</span> of this is avoidable —
          {{ reclaim.oversizedCount }} oversized {{ reclaim.oversizedCount === 1 ? 'timeout' : 'timeouts' }} and
          {{ reclaim.staleSlowCount }} stale <code class="text-xs">test.slow()</code>
          {{ reclaim.staleSlowCount === 1 ? 'mark' : 'marks' }} inflate the failed-attempt time above.
          <NuxtLink
            v-if="reclaim.topProjectId"
            :to="`/projects/${reclaim.topProjectId}#performance`"
            class="text-primary hover:underline"
            >Review</NuxtLink
          >
        </div>
      </div>

      <div v-if="wasted && wasted.byProject.length > 0" class="mt-4 space-y-1">
        <div
          v-for="project in wasted.byProject.slice(0, 5)"
          :key="project.projectId"
          class="flex items-center justify-between text-sm"
        >
          <NuxtLink :to="`/projects/${project.projectId}`" class="truncate hover:text-primary">
            {{ project.label || project.name }}
          </NuxtLink>
          <span class="tabular-nums text-gray-500 dark:text-gray-400 shrink-0">
            {{ Math.round(project.waitMinutes + project.failedExecMinutes) }} min
          </span>
        </div>
      </div>
    </div>
  </ChartCard>
</template>

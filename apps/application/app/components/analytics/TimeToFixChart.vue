<script setup lang="ts">
import type { AnalyticsTimeToFix } from '#shared/analytics/types';
import type { TrendLine } from '~/utils/chart';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const {
  data: ttf,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsTimeToFix>('time-to-fix', () => props.query);

const OPENED_COLOR = STATUS_PALETTE.failed.color;
const FIXED_COLOR = STATUS_PALETTE.passed.color;

const lines = computed<TrendLine[]>(() => [
  {
    label: 'Opened',
    color: OPENED_COLOR,
    points: (ttf.value?.points ?? []).map((p) => ({ date: p.date, value: p.opened })),
  },
  {
    label: 'Fixed',
    color: FIXED_COLOR,
    points: (ttf.value?.points ?? []).map((p) => ({ date: p.date, value: p.fixed })),
  },
]);
const legend = [
  { color: OPENED_COLOR, label: 'Failure causes opened' },
  { color: FIXED_COLOR, label: 'Fixed' },
];

const hasData = computed(() => {
  const t = ttf.value;
  return !!t && (t.opened > 0 || t.fixed > 0 || t.openByAge.some((g) => g.count > 0));
});
const openTotal = computed(() => ttf.value?.openByAge.reduce((sum, g) => sum + g.count, 0) ?? 0);
const ageMax = computed(() => Math.max(1, ...(ttf.value?.openByAge.map((g) => g.count) ?? [])));

const f = computed(() => metricFormatter());
const days = (value: number | null) => f.value.value(value, 'days', 1);

const change = computed(() => {
  const t = ttf.value;
  if (!t || t.medianDays === null || t.previousMedianDays === null) return null;
  const delta = Math.round((t.medianDays - t.previousMedianDays) * 10) / 10;
  return {
    text: `${delta > 0 ? '+' : ''}${delta} days vs previous period`,
    class: metricTrendClass(delta === 0 ? 'same' : delta < 0 ? 'better' : 'worse'),
  };
});

const exportData = computed(() =>
  ttf.value
    ? {
        name: 'time-to-fix',
        header: ['date', 'failure causes opened', 'failure causes fixed'],
        rows: ttf.value.points.map((p) => [p.date, p.opened, p.fixed]),
      }
    : null,
);
</script>

<template>
  <ChartCard
    icon="i-lucide-wrench"
    :title="title ?? 'Time to fix'"
    help="analytics.time-to-fix"
    data-tour="analytics-time-to-fix"
    :legend="legend"
    :export-data="exportData"
    data-shot="analytics-time-to-fix"
  >
    <template #actions>
      <span v-if="change" class="text-xs tabular-nums" :class="change.class">{{ change.text }}</span>
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the time to fix: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!hasData || !ttf" icon="i-lucide-shield-check" text="No failure cause in this period." />
    <div v-else class="space-y-3">
      <StatTileGrid>
        <StatTile label="Median time to fix" :value="days(ttf.medianDays)" data-testid="ttf-median" />
        <StatTile label="p90 time to fix" :value="days(ttf.p90Days)" />
        <StatTile label="Fixes that held" :value="f.value(ttf.fixesHeldPct, 'percent', 1)" />
        <StatTile label="Opened / fixed" :value="`${ttf.opened} / ${ttf.fixed}`" />
      </StatTileGrid>
      <TrendLinesChart :series="lines" :height="150" :bucket-href="bucketDrill(query, ttf.bucketDays, 'clusters')" />
      <div v-if="openTotal > 0" class="space-y-1">
        <p class="text-xs font-medium text-muted">Open failure causes by age</p>
        <ul class="space-y-1">
          <li v-for="group in ttf.openByAge" :key="group.label" class="flex items-center gap-2 text-xs">
            <span class="w-24 shrink-0 text-muted">{{ group.label }}</span>
            <span class="h-2 flex-1 rounded bg-elevated">
              <span
                class="block h-2 rounded"
                :class="STATUS_PALETTE.failed.bg"
                :style="{ width: `${(group.count / ageMax) * 100}%` }"
              />
            </span>
            <span class="w-8 shrink-0 text-right tabular-nums text-highlighted">{{ group.count }}</span>
          </li>
        </ul>
      </div>
    </div>
  </ChartCard>
</template>

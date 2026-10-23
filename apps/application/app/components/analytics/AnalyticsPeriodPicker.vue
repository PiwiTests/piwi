<script setup lang="ts">
import { encodePeriod, parsePeriod, type Granularity, type PeriodSpec } from '#shared/analytics/period';
import type { AnalyticsMarker, AnalyticsScopeSummary } from '#shared/analytics/types';

/**
 * The period of the analytics scope, its comparison and its granularity, in
 * one popover, the Period group of the Filters block. Presets cover rolling
 * and calendar periods, release cycles and All time; a custom range, a marker and
 * a sprint cadence take their own inputs.
 */
const props = defineProps<{
  period: string;
  compare: string;
  granularity: Granularity;
  summary: AnalyticsScopeSummary | null | undefined;
}>();

const emit = defineEmits<{
  'update:period': [value: string];
  'update:compare': [value: string];
  'update:granularity': [value: Granularity];
}>();

const open = ref(false);

const spec = computed<PeriodSpec | null>(() => parsePeriod(props.period));

const PRESET_GROUPS: Array<{ label: string; items: Array<{ label: string; value: string }> }> = [
  {
    label: 'Rolling',
    items: [
      { label: 'Last 7 days', value: 'last-7d' },
      { label: 'Last 14 days', value: 'last-14d' },
      { label: 'Last 30 days', value: 'last-30d' },
      { label: 'Last 6 weeks', value: 'last-42d' },
      { label: 'Last 90 days', value: 'last-90d' },
      { label: 'Last 12 months', value: 'last-365d' },
    ],
  },
  {
    label: 'Calendar',
    items: [
      { label: 'This week', value: 'this-week' },
      { label: 'Last week', value: 'last-week' },
      { label: 'This month', value: 'this-month' },
      { label: 'Last month', value: 'last-month' },
      { label: 'This quarter', value: 'this-quarter' },
      { label: 'Last quarter', value: 'last-quarter' },
      { label: 'This year', value: 'this-year' },
      { label: 'Last year', value: 'last-year' },
    ],
  },
  {
    label: 'Releases',
    items: [
      { label: 'This release cycle', value: 'release-0' },
      { label: 'Previous release cycle', value: 'release-1' },
      { label: 'All time', value: 'all' },
    ],
  },
];

const PRESET_LABELS = new Map(PRESET_GROUPS.flatMap((g) => g.items.map((i) => [i.value, i.label] as const)));

const COMPARE_ITEMS = computed(() => {
  const unit =
    spec.value?.kind === 'calendar'
      ? `Previous ${spec.value.unit}`
      : spec.value?.kind === 'release'
        ? 'Previous release cycle'
        : spec.value?.kind === 'sprint'
          ? 'Previous sprint'
          : null;
  return [
    { label: 'Previous period', value: 'previous' },
    ...(unit ? [{ label: unit, value: 'previous-unit' }] : []),
    { label: 'Same period a year earlier', value: 'year' },
    { label: 'No comparison', value: 'none' },
  ];
});

const GRANULARITY_ITEMS: Array<{ label: string; value: Granularity }> = [
  { label: 'Automatic', value: 'auto' },
  { label: 'Daily', value: 'day' },
  { label: 'Weekly', value: 'week' },
  { label: 'Monthly', value: 'month' },
];

const compareModel = computed({
  get: () => (COMPARE_ITEMS.value.some((i) => i.value === props.compare) ? props.compare : 'previous'),
  set: (value: string) => emit('update:compare', value),
});

const granularityModel = computed({
  get: () => props.granularity,
  set: (value: Granularity) => emit('update:granularity', value),
});

function pick(value: string) {
  emit('update:period', value);
  // A comparison by unit only exists for calendar, release and sprint periods.
  const next = parsePeriod(value);
  if (props.compare === 'previous-unit' && next && !['calendar', 'release', 'sprint'].includes(next.kind)) {
    emit('update:compare', 'previous');
  }
  open.value = false;
}

// ── Custom range ─────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const rangeFrom = ref(spec.value?.kind === 'range' ? spec.value.from : today);
const rangeTo = ref(spec.value?.kind === 'range' ? spec.value.to : today);
function applyRange() {
  if (!rangeFrom.value || !rangeTo.value) return;
  pick(encodePeriod({ kind: 'range', from: rangeFrom.value, to: rangeTo.value }));
}

// ── Since a marker ───────────────────────────────────────────────────────────
const anchors = computed<AnalyticsMarker[]>(() => props.summary?.anchors ?? []);
const markerItems = computed(() => anchors.value.map((m) => ({ label: m.label, value: m.id })));
const markerId = ref<number | undefined>(spec.value?.kind === 'since-marker' ? spec.value.markerId : undefined);
function applyMarker() {
  if (markerId.value) pick(encodePeriod({ kind: 'since-marker', markerId: markerId.value }));
}

// ── Sprint ───────────────────────────────────────────────────────────────────
const sprintStart = ref(spec.value?.kind === 'sprint' ? spec.value.start : today);
const sprintLength = ref(spec.value?.kind === 'sprint' ? spec.value.lengthDays : 14);
function applySprint(offset: number) {
  if (!sprintStart.value || !(sprintLength.value > 0)) return;
  pick(encodePeriod({ kind: 'sprint', offset, start: sprintStart.value, lengthDays: Math.round(sprintLength.value) }));
}

/** What the button reads: the preset's name, else the resolved label from the server. */
const buttonLabel = computed(() => {
  const preset = PRESET_LABELS.get(props.period);
  if (preset) return preset;
  if (props.summary?.period && !props.summary.period.fallback) return props.summary.period.label;
  if (spec.value?.kind === 'range') return `${spec.value.from} to ${spec.value.to}`;
  if (spec.value?.kind === 'sprint') return spec.value.offset === 0 ? 'This sprint' : 'Last sprint';
  return 'Period';
});
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start' }">
    <UButton
      color="neutral"
      variant="outline"
      size="sm"
      icon="i-lucide-calendar-range"
      trailing-icon="i-lucide-chevron-down"
      :title="
        summary?.period
          ? `${summary.period.label}, compared with ${summary.comparison?.label.toLowerCase() ?? 'nothing'}`
          : 'Period'
      "
      data-testid="analytics-period"
      data-tour="analytics-period-button"
    >
      <span class="truncate max-w-[12rem]">{{ buttonLabel }}</span>
    </UButton>

    <template #content>
      <div
        class="w-[min(22rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto p-3 space-y-4 text-sm"
        data-tour="analytics-period"
      >
        <div class="flex items-center gap-1">
          <span class="text-xs font-medium text-muted">Period</span>
          <HelpHint topic="analytics.period" />
        </div>

        <div v-for="group in PRESET_GROUPS" :key="group.label" class="space-y-1">
          <p class="text-xs text-muted">{{ group.label }}</p>
          <div class="flex flex-wrap gap-1">
            <UButton
              v-for="item in group.items"
              :key="item.value"
              size="xs"
              color="neutral"
              :variant="period === item.value ? 'solid' : 'outline'"
              @click="pick(item.value)"
            >
              {{ item.label }}
            </UButton>
          </div>
        </div>

        <div class="space-y-1">
          <p class="text-xs text-muted">Custom range</p>
          <div class="flex flex-wrap items-center gap-2">
            <UInput v-model="rangeFrom" type="date" size="xs" aria-label="From" class="w-36" />
            <UInput v-model="rangeTo" type="date" size="xs" aria-label="To" class="w-36" />
            <UButton size="xs" color="neutral" variant="outline" @click="applyRange">Apply</UButton>
          </div>
        </div>

        <div class="space-y-1">
          <p class="text-xs text-muted">Since a marker</p>
          <div v-if="markerItems.length > 0" class="flex flex-wrap items-center gap-2">
            <USelectMenu
              v-model="markerId"
              :items="markerItems"
              value-key="value"
              searchable
              size="xs"
              placeholder="Pick a marker"
              class="min-w-48 max-w-full"
            />
            <UButton size="xs" color="neutral" variant="outline" :disabled="!markerId" @click="applyMarker">
              Apply
            </UButton>
          </div>
          <p v-else class="text-xs text-muted">No timeline markers in these projects yet.</p>
        </div>

        <div class="space-y-1">
          <p class="text-xs text-muted">Sprint</p>
          <div class="flex flex-wrap items-center gap-2">
            <UInput v-model="sprintStart" type="date" size="xs" aria-label="First sprint starts" class="w-36" />
            <UInput
              v-model.number="sprintLength"
              type="number"
              min="1"
              max="90"
              size="xs"
              aria-label="Sprint length in days"
              class="w-20"
            />
            <span class="text-xs text-muted">days</span>
            <UButton size="xs" color="neutral" variant="outline" @click="applySprint(0)">This sprint</UButton>
            <UButton size="xs" color="neutral" variant="outline" @click="applySprint(1)">Last sprint</UButton>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-default">
          <div class="space-y-1" data-tour="analytics-comparison">
            <div class="flex items-center gap-1">
              <span class="text-xs font-medium text-muted">Compare with</span>
              <HelpHint topic="analytics.comparison" />
            </div>
            <USelect v-model="compareModel" :items="COMPARE_ITEMS" size="xs" class="w-full" />
          </div>
          <div class="space-y-1" data-tour="analytics-buckets">
            <div class="flex items-center gap-1">
              <span class="text-xs font-medium text-muted">Buckets</span>
              <HelpHint topic="analytics.granularity" />
            </div>
            <USelect v-model="granularityModel" :items="GRANULARITY_ITEMS" size="xs" class="w-full" />
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>

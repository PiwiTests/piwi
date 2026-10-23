<script setup lang="ts">
/**
 * *Configure* in the dashboard editor: a widget's title, its options (the
 * form follows the widget's options schema) and its own scope: a period that
 * replaces the dashboard's, and filters that only narrow it.
 */
import type { DashboardWidget } from '#shared/analytics/dashboards';
import {
  getAnalyticsWidget,
  LIST_SOURCES,
  METRIC_DISPLAYS,
  metricBreakdowns,
  parseWidgetOptions,
  WIDGET_METRIC_IDS,
} from '#shared/analytics/registry';
import { DIMENSIONS, getMetric, type MetricId } from '#shared/analytics/metrics';
import { encodePeriod, parsePeriod } from '#shared/analytics/period';
import { MARKER_CATEGORIES } from '#shared/marker-categories';
import type { AnalyticsScope } from '#shared/analytics/scope';
import type { ProjectMenuItem } from '~~/types/api';

const props = defineProps<{ widget: DashboardWidget | null; projects: ProjectMenuItem[] }>();
const emit = defineEmits<{ apply: [widget: DashboardWidget] }>();
const open = defineModel<boolean>('open', { default: false });

const title = ref('');
const options = ref<Record<string, any>>({});
const period = ref('');
const projectIds = ref<number[]>([]);
const selection = ref('');
const tags = ref('');
const browsers = ref('');

const meta = computed(() => (props.widget ? getAnalyticsWidget(props.widget.type) : null));

function list(text: string): string[] {
  return text
    .split(',')
    .map((v) => v.trim().replace(/^@+/, ''))
    .filter(Boolean);
}

watch(
  [open, () => props.widget],
  ([isOpen]) => {
    if (!isOpen || !props.widget) return;
    const w = props.widget;
    title.value = w.title ?? '';
    options.value = { ...parseWidgetOptions(w.type, w.options ?? {}) };
    period.value = w.scope?.period ? encodePeriod(w.scope.period) : DASHBOARD_PERIOD;
    projectIds.value = [...(w.scope?.projectIds ?? [])];
    selection.value = w.scope?.selection ?? '';
    tags.value = (w.scope?.tests?.tags ?? []).join(', ');
    browsers.value = (w.scope?.browsers ?? []).join(', ');
  },
  { immediate: true },
);

/** The period item that keeps the dashboard's period (a select item cannot carry an empty value). */
const DASHBOARD_PERIOD = 'dashboard';
const PERIODS = [
  { label: 'The dashboard’s period', value: DASHBOARD_PERIOD },
  { label: 'Last 7 days', value: 'last-7d' },
  { label: 'Last 14 days', value: 'last-14d' },
  { label: 'Last 30 days', value: 'last-30d' },
  { label: 'Last 90 days', value: 'last-90d' },
  { label: 'This week', value: 'this-week' },
  { label: 'Last week', value: 'last-week' },
  { label: 'This month', value: 'this-month' },
  { label: 'Last month', value: 'last-month' },
  { label: 'This quarter', value: 'this-quarter' },
  { label: 'Last quarter', value: 'last-quarter' },
  { label: 'This year', value: 'this-year' },
];
const periodItems = computed(() =>
  !PERIODS.some((p) => p.value === period.value) ? [...PERIODS, { label: period.value, value: period.value }] : PERIODS,
);

const { state: capabilityState } = await useInstanceCapabilities();
// A metric whose capability this instance declined is not offered.
const metricItems = WIDGET_METRIC_IDS.filter((id) => {
  const capability = getMetric(id).capability;
  return !capability || capabilityState(capability) !== 'declined';
}).map((id) => ({ label: getMetric(id).label, value: id }));
const DISPLAY_LABELS: Record<(typeof METRIC_DISPLAYS)[number], string> = {
  stat: 'Number',
  line: 'Line',
  bar: 'Bars',
  table: 'Table',
  heatmap: 'Heatmap',
};
const displayItems = METRIC_DISPLAYS.map((d) => ({ label: DISPLAY_LABELS[d], value: d }));
/** The breakdown item that keeps the metric whole. */
const NO_BREAKDOWN = 'none';
const breakdownItems = computed(() => [
  { label: 'No breakdown', value: NO_BREAKDOWN },
  ...metricBreakdowns((options.value.metric as MetricId) ?? 'test-pass-rate').map((id) => ({
    label: DIMENSIONS.find((d) => d.id === id)?.label ?? id,
    value: id,
  })),
]);
const SOURCE_LABELS: Record<(typeof LIST_SOURCES)[number], string> = {
  runs: 'Latest runs',
  'failure-clusters': 'Open failure causes',
  'flaky-tests': 'Flakiest tests',
  'scenario-gaps': 'Open scenario gaps',
};
const sourceItems = LIST_SOURCES.map((s) => ({ label: SOURCE_LABELS[s], value: s }));
const categoryItems = MARKER_CATEGORIES.map((c) => ({ label: c.label, value: c.id }));
const projectItems = computed(() => props.projects.map((p) => ({ label: p.label || p.name, value: p.id })));

// A breakdown the new metric cannot cut is dropped.
watch(
  () => options.value.metric,
  (metric) => {
    if (!metric || !options.value.breakdown) return;
    if (!metricBreakdowns(metric as MetricId).includes(options.value.breakdown)) delete options.value.breakdown;
  },
);

const breakdown = computed({
  get: () => (options.value.breakdown as string | undefined) ?? NO_BREAKDOWN,
  set: (value: string) => {
    if (value && value !== NO_BREAKDOWN) options.value.breakdown = value;
    else delete options.value.breakdown;
  },
});

function apply() {
  const w = props.widget;
  if (!w) return;
  const scope: Partial<AnalyticsScope> = {};
  const parsed = parsePeriod(period.value);
  if (parsed) scope.period = parsed;
  if (projectIds.value.length > 0) scope.projectIds = [...projectIds.value];
  if (selection.value.trim()) scope.selection = selection.value.trim();
  if (list(tags.value).length > 0) scope.tests = { tags: list(tags.value) };
  if (list(browsers.value).length > 0) scope.browsers = list(browsers.value);
  const next: DashboardWidget = { key: w.key, type: w.type, size: w.size };
  if (title.value.trim()) next.title = title.value.trim();
  if (meta.value?.options) next.options = { ...options.value };
  if (Object.keys(scope).length > 0) next.scope = scope;
  emit('apply', next);
  open.value = false;
}
</script>

<template>
  <USlideover v-model:open="open" :title="`Configure ${meta?.title ?? 'widget'}`" :ui="{ content: 'max-w-md' }">
    <template #body>
      <form v-if="widget && meta" class="space-y-4" data-testid="widget-config" @submit.prevent="apply">
        <UFormField label="Title">
          <UInput v-model="title" :placeholder="meta.title" class="w-full" data-testid="widget-title" />
        </UFormField>

        <template v-if="widget.type === 'metric'">
          <UFormField label="Metric">
            <USelect
              v-model="options.metric"
              :items="metricItems"
              class="w-full"
              aria-label="Metric"
              data-testid="widget-metric"
            />
          </UFormField>
          <UFormField label="Display">
            <USelect
              v-model="options.display"
              :items="displayItems"
              class="w-full"
              aria-label="Display"
              data-testid="widget-display"
            />
          </UFormField>
          <UFormField label="Breakdown" :help="options.display === 'stat' ? 'A number shows no breakdown.' : undefined">
            <USelect
              v-model="breakdown"
              :items="breakdownItems"
              class="w-full"
              aria-label="Breakdown"
              data-testid="widget-breakdown"
            />
          </UFormField>
          <UFormField v-if="breakdown !== NO_BREAKDOWN" label="Groups shown" help="The rest are grouped as Other.">
            <UInputNumber v-model="options.top" :min="5" :max="25" class="w-full" aria-label="Groups shown" />
          </UFormField>
          <USwitch v-model="options.comparison" label="Compare with the comparison period" />
          <USwitch v-model="options.markers" label="Draw timeline markers" />
          <USwitch v-model="options.target" label="Draw the project's target" />
        </template>

        <UFormField v-else-if="widget.type === 'stats'" label="Metrics">
          <USelectMenu
            v-model="options.metrics"
            :items="metricItems"
            value-key="value"
            multiple
            class="w-full"
            aria-label="Metrics"
          />
        </UFormField>

        <template v-else-if="widget.type === 'list'">
          <UFormField label="Show">
            <USelect v-model="options.source" :items="sourceItems" class="w-full" aria-label="List source" />
          </UFormField>
          <UFormField label="Items">
            <UInputNumber v-model="options.limit" :min="5" :max="25" class="w-full" aria-label="Items" />
          </UFormField>
        </template>

        <UFormField v-else-if="widget.type === 'markers'" label="Categories" help="None picked shows every category.">
          <USelectMenu
            v-model="options.categories"
            :items="categoryItems"
            value-key="value"
            multiple
            class="w-full"
            aria-label="Marker categories"
          />
        </UFormField>

        <UFormField
          v-else-if="widget.type === 'text'"
          label="Note"
          help="Markdown: headings, lists, links, code. Raw HTML is shown as text."
        >
          <UTextarea v-model="options.markdown" :rows="8" autoresize class="w-full" data-testid="widget-markdown" />
        </UFormField>

        <UFormField
          v-else-if="widget.type === 'coverage-trend'"
          label="Lines beside every suite"
          help="Areas are the named parts of each project’s code, set in its coverage settings."
        >
          <USelect
            v-model="options.split"
            :items="[
              { label: 'One per suite', value: 'suites' },
              { label: 'One per area', value: 'areas' },
            ]"
            class="w-full"
            aria-label="Lines beside every suite"
          />
        </UFormField>

        <UFormField v-else-if="'limit' in options" label="Rows">
          <UInputNumber v-model="options.limit" :min="5" :max="25" class="w-full" aria-label="Rows" />
        </UFormField>

        <div class="space-y-3 border-t border-default pt-4" data-tour="widget-scope">
          <div class="flex items-center gap-1">
            <h3 class="text-xs font-medium text-muted">This widget’s scope</h3>
            <HelpHint topic="dashboards.widget-scope" />
          </div>
          <UFormField label="Period">
            <USelect v-model="period" :items="periodItems" class="w-full" aria-label="Widget period" />
          </UFormField>
          <UFormField label="Only these projects">
            <USelectMenu
              v-model="projectIds"
              :items="projectItems"
              value-key="value"
              multiple
              placeholder="Every project of the dashboard"
              class="w-full"
              aria-label="Widget projects"
            />
          </UFormField>
          <UFormField label="Only this selection">
            <UInput v-model="selection" placeholder="smoke" class="w-full" aria-label="Widget selection" />
          </UFormField>
          <UFormField label="Only tests tagged">
            <UInput v-model="tags" placeholder="critical, checkout" class="w-full" aria-label="Widget test tags" />
          </UFormField>
          <UFormField label="Only these browsers">
            <UInput v-model="browsers" placeholder="webkit" class="w-full" aria-label="Widget browsers" />
          </UFormField>
        </div>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton color="primary" label="Apply" data-testid="widget-config-apply" @click="apply" />
      </div>
    </template>
  </USlideover>
</template>

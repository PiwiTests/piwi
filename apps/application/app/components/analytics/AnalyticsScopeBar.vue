<script setup lang="ts">
/**
 * The Filters block at the top of an analytics dashboard: the scope every widget
 * counts, grouped by what each control filters (Period, Runs, Tests), with
 * *Reset* in the block's header. Below `sm` the block starts folded to a
 * one-line summary of the active filters; wider, it starts open.
 */
import { hasTestFilter } from '#shared/analytics/scope';
import {
  DEFAULT_ANALYTICS_SCOPE_STATE,
  isDefaultScopeState,
  scopeFromState,
  type AnalyticsScopeState,
} from '#shared/analytics/scope-state';
import type { AnalyticsScopeSummary } from '#shared/analytics/types';
import type { FilterBarState } from '~/components/shared/FilterBar.vue';
import type { ProjectMenuItem } from '~~/types/api';

const props = withDefaults(
  defineProps<{
    modelValue: AnalyticsScopeState;
    availableProjects: ProjectMenuItem[];
    availableEnvironments: string[];
    availableBranches?: string[];
    summary?: AnalyticsScopeSummary | null;
    /** The block's heading: *Default filters* while a dashboard is edited. */
    title?: string;
  }>(),
  { availableBranches: () => [], summary: null, title: 'Filters' },
);

const emit = defineEmits<{
  'update:modelValue': [value: AnalyticsScopeState];
}>();

function patch(change: Partial<AnalyticsScopeState>) {
  emit('update:modelValue', { ...props.modelValue, ...change });
}

const projectItems = computed(() => props.availableProjects.map((p) => ({ label: p.label || p.name, value: p.id })));

const projectIds = computed({
  get: () => props.modelValue.projectIds,
  set: (val: number[]) => patch({ projectIds: val }),
});

function projectLabel(id: number) {
  return projectItems.value.find((item) => item.value === id)?.label ?? `#${id}`;
}

/** The one project in scope, for *Save as selection*. */
const singleProjectId = computed(() => {
  if (props.modelValue.projectIds.length === 1) return props.modelValue.projectIds[0]!;
  return props.availableProjects.length === 1 ? props.availableProjects[0]!.id : null;
});

// The default branch, or every branch. Picking branches by
// hand overrides the policy, so the policy control steps aside.
const allBranches = computed({
  get: () => props.modelValue.allBranches,
  set: (val: boolean) => patch({ allBranches: val }),
});

// The environment, branch and full-runs controls come from the shared FilterBar,
// so analytics never grows its own copy of them. The project and branch policy
// pickers are analytics-only and ride in FilterBar's slots.
const filterBar = computed<FilterBarState>({
  get: () => ({
    environments: props.modelValue.environments,
    branches: props.modelValue.branches,
    fullRunsOnly: props.modelValue.fullRunsOnly,
  }),
  set: (val) => patch({ environments: val.environments, branches: val.branches, fullRunsOnly: val.fullRunsOnly }),
});

const isDefault = computed(() => isDefaultScopeState(props.modelValue));

function reset() {
  emit('update:modelValue', { ...DEFAULT_ANALYTICS_SCOPE_STATE });
}

/** "Sep 1, 2026 to Sep 24, 2026" for the resolved period (`to` is exclusive, so the last day shows). */
function periodRange(summary: AnalyticsScopeSummary): string {
  const prefs = activeLocalePrefs();
  const locale = prefs.locale === 'auto' ? undefined : prefs.locale;
  const timeZone = prefs.timeZone === 'auto' ? undefined : prefs.timeZone;
  const from = new Date(summary.period.from);
  const last = new Date(Math.max(from.getTime(), new Date(summary.period.to).getTime() - 1));
  const fmt = (d: Date) => d.toLocaleDateString(locale, { dateStyle: 'medium', timeZone });
  return `${fmt(from)} to ${fmt(last)}`;
}

/** "Last 30 days · vs previous period · 3 projects · default branch": what the folded block reads. */
const activeSummary = computed(() => {
  const state = props.modelValue;
  const parts: string[] = [props.summary?.period.label ?? state.period];
  if (props.summary?.comparison) parts.push(`vs ${props.summary.comparison.label.toLowerCase().replace(/^the /, '')}`);
  if (state.projectIds.length === 1) parts.push(projectLabel(state.projectIds[0]!));
  else if (state.projectIds.length > 1) parts.push(`${state.projectIds.length} projects`);
  if (state.environments.length === 1) parts.push(state.environments[0]!);
  else if (state.environments.length > 1) parts.push(`${state.environments.length} environments`);
  if (state.branches.length === 1) parts.push(state.branches[0]!);
  else if (state.branches.length > 1) parts.push(`${state.branches.length} branches`);
  else parts.push(state.allBranches ? 'all branches' : 'default branch');
  if (!state.fullRunsOnly) parts.push('partial runs included');
  if (hasTestFilter(scopeFromState(state))) parts.push('test filter');
  return parts.join(' · ');
});
</script>

<template>
  <FiltersBlock
    :title="title"
    :summary="activeSummary"
    :resettable="!isDefault"
    test-id="analytics-filters"
    data-shot="analytics-scope-bar"
    data-tour="analytics-filters"
    @reset="reset"
  >
    <dl class="grid gap-y-3 gap-x-4 sm:grid-cols-[4rem_minmax(0,1fr)] sm:items-start">
      <dt class="text-xs font-medium text-muted sm:pt-1.5">Period</dt>
      <dd class="min-w-0 space-y-1">
        <AnalyticsPeriodPicker
          :period="modelValue.period"
          :compare="modelValue.compare"
          :granularity="modelValue.granularity"
          :summary="summary"
          @update:period="patch({ period: $event })"
          @update:compare="patch({ compare: $event })"
          @update:granularity="patch({ granularity: $event })"
        />
        <p v-if="summary" class="text-xs text-muted" data-testid="analytics-scope-line">
          <ClientOnly>
            <span>{{ periodRange(summary) }}</span>
          </ClientOnly>
          <template v-if="summary.comparison"> · compared with {{ summary.comparison.label.toLowerCase() }} </template>
          <template v-for="note in [summary.period.fallback, ...summary.notes].filter(Boolean)" :key="note!">
            · {{ note }}
          </template>
        </p>
      </dd>

      <dt class="text-xs font-medium text-muted sm:pt-1.5">Runs</dt>
      <dd class="min-w-0">
        <FilterBar
          v-model="filterBar"
          :available-environments="availableEnvironments"
          :available-branches="availableBranches"
          branch-placeholder="Pick branches"
          :show-reset="false"
        >
          <template #leading>
            <USelectMenu
              v-if="projectItems.length > 0"
              v-model="projectIds"
              :items="projectItems"
              value-key="value"
              multiple
              searchable
              size="sm"
              class="min-w-[170px]"
              placeholder="All projects"
            >
              <template #default="{ modelValue: selected }">
                <div class="flex items-center gap-1.5">
                  <UIcon
                    name="i-lucide-folder"
                    class="size-3.5 shrink-0"
                    :class="(selected as number[]).length ? 'text-primary' : 'text-gray-400'"
                  />
                  <span v-if="!(selected as number[]).length" class="text-gray-500">All projects</span>
                  <span v-else-if="(selected as number[]).length === 1" class="truncate">{{
                    projectLabel((selected as number[])[0]!)
                  }}</span>
                  <span v-else>{{ (selected as number[]).length }} projects</span>
                </div>
              </template>
            </USelectMenu>
          </template>

          <template #after-branches>
            <BranchPolicySelect
              v-if="modelValue.branches.length === 0"
              v-model="allBranches"
              help="analytics.branch-policy"
              data-testid="analytics-branch-policy"
              data-tour="analytics-branch-policy"
            />
          </template>
        </FilterBar>
      </dd>

      <dt class="text-xs font-medium text-muted sm:pt-1.5">Tests</dt>
      <dd class="min-w-0">
        <AnalyticsTestFilter
          :selection="modelValue.selection"
          :tests="modelValue.tests"
          :browsers="modelValue.browsers"
          :summary="summary"
          :single-project-id="singleProjectId"
          @update:selection="patch({ selection: $event })"
          @update:tests="patch({ tests: $event })"
          @update:browsers="patch({ browsers: $event })"
        />
      </dd>
    </dl>
  </FiltersBlock>
</template>

<script setup lang="ts">
import type { EnvironmentFilterItem } from '~/utils/environment-filter';

/**
 * The scope controls shared by every list on a screen: an environment select, a
 * branch select and a *Full runs only* toggle. One instance drives the runs
 * table, the trend chart, the flaky analysis and the performance tab of a
 * project, so they never disagree on what is in scope. The caller owns the
 * value and persists it (the project page keeps one cookie per project).
 *
 * Environments and branches are multi-select so a run matches when it is in any
 * of the chosen values. An environment choice is a value or a `{ label, value }`
 * (a project's environment, stored by its key and shown by its name). With
 * `branchPolicy`, a branch select with nothing picked sits beside the policy for
 * that case: the default branch, or every branch.
 * A control renders only when the data offers more than nothing to pick from.
 *
 * Slots: `leading` before the environment select, `after-branches` right after
 * the branch select (a control that belongs with it), `trailing` at the end.
 */
export interface FilterBarState {
  environments: string[];
  branches: string[];
  fullRunsOnly: boolean;
  /** With no branch picked: every branch, or only the default branch. Read where the bar offers the policy. */
  allBranches?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: FilterBarState;
    availableEnvironments: Array<string | EnvironmentFilterItem>;
    availableBranches: string[];
    /** Hide the built-in reset button when the caller supplies its own via #trailing. */
    showReset?: boolean;
    /** What the branch select reads with nothing picked (the caller's branch policy); *Pick branches* beside the built-in policy. */
    branchPlaceholder?: string;
    /** Offer the branch policy (default branch or every branch) while no branch is picked. */
    branchPolicy?: boolean;
    /** The default branch the policy names. */
    defaultBranch?: string | null;
  }>(),
  { showReset: true, branchPlaceholder: 'All branches', branchPolicy: false, defaultBranch: null },
);

const emit = defineEmits<{
  'update:modelValue': [value: FilterBarState];
}>();

const environmentItems = computed<EnvironmentFilterItem[]>(() =>
  props.availableEnvironments.map((item) => (typeof item === 'string' ? { label: item, value: item } : item)),
);

/** The words an environment value shows: its item's label, else the value. */
function environmentLabel(value: string): string {
  return environmentItems.value.find((item) => item.value === value)?.label ?? value;
}

const environments = computed({
  get: () => props.modelValue.environments,
  set: (val) => emit('update:modelValue', { ...props.modelValue, environments: val }),
});

const branches = computed({
  get: () => props.modelValue.branches,
  set: (val) => emit('update:modelValue', { ...props.modelValue, branches: val }),
});

const fullRunsOnly = computed({
  get: () => props.modelValue.fullRunsOnly,
  set: (val) => emit('update:modelValue', { ...props.modelValue, fullRunsOnly: val }),
});

const allBranches = computed({
  get: () => !!props.modelValue.allBranches,
  set: (val) => emit('update:modelValue', { ...props.modelValue, allBranches: val }),
});

// The policy matters only while no branch is picked and some run is off the default branch.
const showBranchPolicy = computed(
  () =>
    props.branchPolicy &&
    props.modelValue.branches.length === 0 &&
    props.availableBranches.some((branch) => branch !== props.defaultBranch),
);

const branchSelectPlaceholder = computed(() => (showBranchPolicy.value ? 'Pick branches' : props.branchPlaceholder));

const hasActiveFilters = computed(
  () =>
    props.modelValue.environments.length > 0 ||
    props.modelValue.branches.length > 0 ||
    !props.modelValue.fullRunsOnly ||
    (props.branchPolicy && !!props.modelValue.allBranches),
);

function reset() {
  emit('update:modelValue', { environments: [], branches: [], fullRunsOnly: true, allBranches: false });
}
</script>

<template>
  <div class="flex items-center gap-3 flex-wrap">
    <slot name="leading" />

    <USelectMenu
      v-if="environmentItems.length > 0"
      v-model="environments"
      :items="environmentItems"
      value-key="value"
      label-key="label"
      multiple
      placeholder="All environments"
      size="sm"
      class="min-w-[160px]"
    >
      <template #default="{ modelValue: selected }">
        <div class="flex items-center gap-1.5">
          <UIcon
            name="i-lucide-server"
            class="size-3.5 shrink-0"
            :class="(selected as string[]).length ? 'text-primary' : 'text-gray-400'"
          />
          <span v-if="!(selected as string[]).length" class="text-gray-500">All environments</span>
          <span v-else-if="(selected as string[]).length === 1">{{
            environmentLabel((selected as string[])[0]!)
          }}</span>
          <span v-else>{{ (selected as string[]).length }} environments</span>
        </div>
      </template>
    </USelectMenu>

    <USelectMenu
      v-if="availableBranches.length > 0"
      v-model="branches"
      :items="availableBranches"
      multiple
      searchable
      :placeholder="branchSelectPlaceholder"
      size="sm"
      class="min-w-[160px] max-w-[16rem]"
    >
      <template #default="{ modelValue: selected }">
        <div class="flex items-center gap-1.5 min-w-0">
          <UIcon
            name="i-lucide-git-branch"
            class="size-3.5 shrink-0"
            :class="(selected as string[]).length ? 'text-primary' : 'text-gray-400'"
          />
          <span v-if="!(selected as string[]).length" class="text-gray-500">{{ branchSelectPlaceholder }}</span>
          <span v-else-if="(selected as string[]).length === 1" class="truncate">{{ (selected as string[])[0] }}</span>
          <span v-else>{{ (selected as string[]).length }} branches</span>
        </div>
      </template>
    </USelectMenu>

    <BranchPolicySelect v-if="showBranchPolicy" v-model="allBranches" :default-branch="defaultBranch" />

    <slot name="after-branches" />

    <label
      class="flex items-center gap-1.5 cursor-pointer select-none text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
    >
      <UCheckbox v-model="fullRunsOnly" size="sm" />
      Full runs only
    </label>

    <slot name="trailing" />

    <UButton
      v-if="showReset && hasActiveFilters"
      variant="ghost"
      size="sm"
      color="neutral"
      icon="i-lucide-x"
      @click="reset"
    >
      Reset
    </UButton>
  </div>
</template>

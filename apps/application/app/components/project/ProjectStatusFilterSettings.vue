<script setup lang="ts">
/**
 * Project settings → Status: the status filter, the runs that set the
 * project's status (its badge in the sidebar, its latest run in the Projects
 * list). Off, every run does; on, the runs in a scope read like the project
 * page's Filters, which the section can copy.
 */
import type { ProjectWithTestRuns } from '~~/types/api';
import type { FilterBarState } from '~/components/shared/FilterBar.vue';
import { describeProjectRunScope, resolveProjectRunScope } from '#shared/project-run-scope';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const { state, dirty } = useStoredForm(() => {
  const stored = resolveProjectRunScope(props.project.statusFilter);
  return { enabled: stored !== null, filter: (stored ?? defaultProjectFilters()) as FilterBarState };
});

const defaultBranch = computed(
  () => props.project.effectiveDefaultBranch || props.project.defaultBranch?.trim() || 'main',
);

const availableEnvironments = computed(() =>
  [...new Set(props.project.testRuns.map((run) => run.environment).filter((env): env is string => !!env))].sort(),
);
const availableBranches = computed(() =>
  [
    ...new Set(
      props.project.testRuns
        .map((run) => run.branch ?? run.metadata?.scm?.branch)
        .filter((branch): branch is string => !!branch),
    ),
  ].sort(),
);

const pageFilters = useProjectFilters(props.project.id);
function copyPageFilters() {
  state.value.filter = { ...defaultProjectFilters(), ...pageFilters.value };
}

const summary = computed(() => {
  const scope = resolveProjectRunScope(state.value.filter);
  if (!state.value.enabled || !scope) return 'The latest run sets the status, whatever its environment and branch.';
  return `The latest run on ${describeProjectRunScope(scope, defaultBranch.value)} sets the status.`;
});

const { saving, save } = useProjectPatch(() => props.project.id);

async function submit() {
  const stored = await save(
    { statusFilter: state.value.enabled ? resolveProjectRunScope(state.value.filter) : null },
    'Status filter saved',
  );
  if (!stored) return;
  await refreshNuxtData('projects');
  emit('saved');
}
</script>

<template>
  <UForm :state="state" data-shot="project-status-filter" @submit="submit">
    <SectionCard
      icon="i-lucide-circle-check-big"
      title="Status"
      subtitle="The runs that set the status beside this project in the sidebar and the Projects list"
      help="project.status-filter"
    >
      <div class="space-y-4">
        <USwitch
          v-model="state.enabled"
          label="Only runs in a filter"
          description="Leave off for the latest run of any environment and branch."
          data-testid="project-status-filter-enabled"
        />

        <div v-if="state.enabled" class="space-y-3">
          <FilterBar
            v-model="state.filter"
            :available-environments="availableEnvironments"
            :available-branches="availableBranches"
            branch-policy
            :default-branch="defaultBranch"
            :show-reset="false"
          />
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-copy"
            title="Use the filters picked on this project's pages"
            @click="copyPageFilters"
          >
            Copy the project page filters
          </UButton>
        </div>

        <p class="text-xs text-muted" data-testid="project-status-filter-summary">{{ summary }}</p>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty">Save changes</UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>

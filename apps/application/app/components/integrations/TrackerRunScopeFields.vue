<script setup lang="ts">
/**
 * A run scope in the tracker binding form: branch names or `*` patterns, typed
 * comma-separated, the project's default branch, and environments, picked from
 * the project's or typed (`prod*`). The line under the fields says the scope in
 * words.
 */
import { describeRunScope } from '#shared/integrations/automation';
import { runScopeFromForm, type RunScopeForm } from '~/utils/tracker-binding-form';

const scope = defineModel<RunScopeForm>({ required: true });
defineProps<{
  /** The project whose environments the scope picks from. */
  projectId: number;
  /** Leave out the line saying the scope in words, when the caller says more around it. */
  hideSummary?: boolean;
}>();

const summary = computed(() => describeRunScope(runScopeFromForm(scope.value)));
</script>

<template>
  <div>
    <div class="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
      <UFormField label="Branches">
        <UInput v-model="scope.branches" placeholder="main, release/*" class="w-full" />
      </UFormField>
      <USwitch
        v-model="scope.defaultBranch"
        label="Default branch"
        class="sm:pb-1.5"
        title="The project's default branch, whatever it is named"
      />
      <UFormField label="Environments">
        <EnvironmentSelectorsInput v-model="scope.environments" :project-id="projectId" class="w-full" />
      </UFormField>
    </div>
    <p v-if="!hideSummary" class="text-xs text-muted mt-1">Runs on {{ summary }}.</p>
  </div>
</template>

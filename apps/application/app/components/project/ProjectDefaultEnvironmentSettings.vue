<script setup lang="ts">
/**
 * Project settings → Environments: the default environment, which the project page and its tabs, the flaky list,
 * Analytics, quarantine candidates, pull request feedback and MCP's flaky list read when no environment is picked, as
 * they read the default branch. Its managers pick one of the environments that are not archived, or every environment.
 */
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

/** The select's value for every environment. */
const ALL = 'all';

const { can } = useAuth();
const canManage = computed(() => can('project:manage', props.project.id));
const { active } = useProjectEnvironments(() => props.project.id);

const stored = () => ({ value: String(props.project.effectiveDefaultEnvironment?.id ?? ALL) });
const { state, dirty } = useStoredForm(stored);
const { saving, save } = useProjectPatch(() => props.project.id);

const items = computed(() => [
  { label: 'All environments', value: ALL },
  ...[...active.value]
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((environment) => ({ label: environment.name, value: String(environment.id) })),
]);

async function submit() {
  const defaultEnvironmentId = state.value.value === ALL ? null : Number(state.value.value);
  const saved = await save({ defaultEnvironmentId }, 'Default environment saved');
  if (saved) emit('saved');
}
</script>

<template>
  <UForm
    :state="state"
    data-shot="project-default-environment"
    data-tour="project-default-environment"
    @submit="submit"
  >
    <SectionCard
      icon="i-lucide-server"
      title="Default environment"
      subtitle="The environment this project's views read when you pick none"
      help="project.default-environment"
    >
      <div class="space-y-3">
        <p class="text-sm text-highlighted leading-relaxed">
          The project page, its tabs and Analytics read only its runs until you pick another environment or All
          environments, as they read the default branch. A run with no environment shows only under All environments.
        </p>
        <USelect
          v-model="state.value"
          :items="items"
          :disabled="!canManage"
          class="w-full sm:w-72"
          aria-label="Default environment"
          data-testid="default-environment-select"
        />
      </div>

      <template v-if="canManage" #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty">Save changes</UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>

<script setup lang="ts">
/**
 * The environment picker beside a command Piwi gives to copy: the command then sets the environment's run variables
 * and `PIWI_ENVIRONMENT`, and for a protected one keeps to its required tags. Compact, and shown only when the project
 * has an environment to pick. The model is the page's choice (`useCommandEnvironment`). For a command that cannot
 * keep to required tags, `protectedRefused` says why its protected environments cannot be picked.
 */
defineOptions({ inheritAttrs: false });

const environmentId = defineModel<number | null>({ required: true });

const props = defineProps<{
  projectId: number | string | null | undefined;
  /** Why a protected environment cannot be picked for this command; unset offers it to the project's managers. */
  protectedRefused?: string;
}>();

const project = computed(() => {
  const value = Number(props.projectId ?? Number.NaN);
  return Number.isInteger(value) && value > 0 ? value : null;
});
const { active } = useProjectEnvironments(project);
</script>

<template>
  <EnvironmentPicker
    v-if="active.length > 0"
    v-model="environmentId"
    :project-id="project"
    :protected-refused="protectedRefused"
    size="xs"
    aria-label="Environment of the command"
    title="The environment the command is for: its run variables and PIWI_ENVIRONMENT"
    data-testid="command-environment"
    v-bind="$attrs"
  />
</template>

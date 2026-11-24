<script setup lang="ts">
/**
 * Project settings → CI: the CI actions Piwi starts (their targets, inputs,
 * defaults and environments). A CI server action names a credential of
 * Settings → Credentials, picked in the action's editor; no secret is typed
 * here.
 */
import type { ProjectWithTestRuns } from '~~/types/api';
import type { CiActionsSettings } from '#shared/ci-actions';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const { state, dirty } = useStoredForm(() => {
  const ci = props.project.ciRerun;
  return {
    ciRerun: {
      enabled: ci?.enabled ?? false,
      actions: ci?.actions ?? [],
      defaults: ci?.defaults ?? {},
    } satisfies CiActionsSettings,
  };
});
const { saving, save } = useProjectPatch(() => props.project.id);

const instanceUrl = computed(() => props.project.ciServerInstanceUrl ?? null);
const instanceAllowedInputs = computed(() => props.project.ciServerInstanceAllowedInputs ?? null);

async function submit() {
  if (await save({ ciRerun: state.value.ciRerun }, 'CI saved')) emit('saved');
}
</script>

<template>
  <UForm :state="state" @submit="submit">
    <SectionCard icon="i-lucide-workflow" title="CI" subtitle="Named ways to start CI from a failure’s page">
      <FormFieldGroup
        label="CI actions"
        help="project.ci-rerun"
        description="Each action has its own target, inputs and environment, and a CI server action names the credential it sends. Maintainers, Project admins and administrators can use them. Off by default."
        data-tour="project-ci-rerun"
      >
        <ProjectCiActions
          v-model="state.ciRerun"
          :project-id="project.id"
          :repository-url="project.repositoryUrl ?? null"
          :instance-url="instanceUrl"
          :instance-allowed-inputs="instanceAllowedInputs"
        />
      </FormFieldGroup>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty" data-testid="ci-save">
            Save changes
          </UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>

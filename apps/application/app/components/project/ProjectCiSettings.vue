<script setup lang="ts">
/**
 * Project settings → CI: the CI actions Piwi starts (their targets, inputs,
 * defaults and environments) and the one CI server token they share. The token
 * is write-only, bound to the one base URL the actions send under, and sent only
 * by this section's Save, never by the action editor.
 */
import type { ProjectWithTestRuns } from '~~/types/api';
import { ciServerTokenBinding, type CiActionsSettings } from '#shared/ci-actions';

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
const ciServerToken = ref('');
const { saving, save } = useProjectPatch(() => props.project.id);

const instanceUrl = computed(() => props.project.ciServerInstanceUrl ?? null);
const hasToken = computed(() => Boolean(props.project.hasCiServerToken));
const storedUrl = computed(() => props.project.ciServerTokenUrl ?? null);

/** Whether the token applies: CI actions are on and one of them targets a CI server. */
const tokenApplies = computed(
  () => state.value.ciRerun.enabled && state.value.ciRerun.actions.some((a) => a.target.type === 'ci-server'),
);
/** The one base URL the token would be bound to, or why there is none. */
const binding = computed(() => ciServerTokenBinding(state.value.ciRerun, instanceUrl.value));
const typedToken = computed(() => ciServerToken.value.trim());
const blocked = computed(() => Boolean(typedToken.value) && tokenApplies.value && binding.value.error !== null);

async function submit() {
  if (blocked.value) return;
  const stored = await save(
    {
      ciRerun: state.value.ciRerun,
      ciServerToken: (tokenApplies.value && typedToken.value) || undefined,
    },
    'CI saved',
  );
  if (!stored) return;
  ciServerToken.value = '';
  emit('saved');
}

async function removeCiServerToken() {
  if (await save({ ciServerToken: null }, 'CI server token removed')) emit('saved');
}
</script>

<template>
  <UForm :state="state" @submit="submit">
    <SectionCard
      icon="i-lucide-workflow"
      title="CI"
      subtitle="Named ways to start CI from a failure’s page, and the token they send"
    >
      <div class="space-y-5">
        <UFormField
          name="ciRerun"
          data-tour="project-ci-rerun"
          description="Each action has its own target, inputs and environment. Maintainers, Project admins and administrators can use them. Off by default."
        >
          <template #label>
            <span class="inline-flex items-center gap-1">CI actions <HelpHint topic="project.ci-rerun" /></span>
          </template>
          <ProjectCiActions
            v-model="state.ciRerun"
            :project-id="project.id"
            :instance-url="instanceUrl"
            :has-token="hasToken"
            :token-url="storedUrl"
          />
        </UFormField>

        <UFormField
          v-if="tokenApplies"
          name="ciServerToken"
          label="CI server token"
          data-testid="ci-server-token"
          data-shot="ci-server-token"
          :error="blocked ? (binding.error ?? undefined) : undefined"
        >
          <template #description>
            <span data-testid="ci-server-token-description">
              <template v-if="binding.url">
                One token for the project’s CI server actions, sealed to
                <span class="font-mono">{{ binding.url }}</span> and sent only under it.
              </template>
              <template v-else>One token for the project’s CI server actions, sealed to one base URL.</template>
              <template v-if="hasToken">
                A token is stored for <span class="font-mono">{{ storedUrl }}</span
                >: leave empty to keep it, or enter a new value to replace it.
              </template>
            </span>
          </template>
          <UInput
            v-model="ciServerToken"
            type="password"
            autocomplete="off"
            :placeholder="hasToken ? '•••••••• (unchanged)' : 'API token'"
            aria-label="CI server token"
            class="w-full font-mono"
          />
          <p v-if="!binding.url && !blocked" class="mt-1 text-xs text-muted">{{ binding.error }}</p>
          <UButton
            v-if="hasToken"
            size="xs"
            color="error"
            variant="link"
            class="px-0 mt-1"
            icon="i-lucide-trash-2"
            :disabled="saving"
            data-testid="ci-server-token-remove"
            @click="removeCiServerToken"
          >
            Remove stored token
          </UButton>
        </UFormField>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton
            type="submit"
            icon="i-lucide-check"
            :loading="saving"
            :disabled="blocked || (!dirty && !(tokenApplies && typedToken))"
            data-testid="ci-save"
          >
            Save changes
          </UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>

<script setup lang="ts">
/**
 * Add or edit one environment of a project in a modal: its key and name, a description, its aliases, its run
 * variables, whether the app under test is built from the checkout, whether it is protected with its required tags,
 * and its env file. Each field is checked as it is typed with the rules the instance applies again on save, which
 * stores it at once.
 */
import { ENVIRONMENT_LIMITS } from '@piwitests/core/environments';
import { RUN_VARIABLE_LIMITS } from '@piwitests/core/run-variables';
import type { EnvironmentRecord } from '#shared/environments';
import {
  environmentDraft,
  environmentDraftBody,
  environmentDraftHasProblem,
  environmentDraftProblems,
  type EnvironmentDraft,
  type EnvironmentDraftProblems,
} from '~/utils/environment-form';

const props = defineProps<{
  projectId: number;
  /** The environment to edit, or null to add one. */
  environment: EnvironmentRecord | null;
  /** The project's other environments, whose keys and aliases this one may not take. */
  others: EnvironmentRecord[];
}>();
const emit = defineEmits<{ saved: [environment: EnvironmentRecord] }>();
const open = defineModel<boolean>('open', { default: false });

const draft = ref<EnvironmentDraft>(environmentDraft(null));
const saving = ref(false);
const error = ref<string | null>(null);
/** Whether Save was clicked: an empty field's problem shows from then on. */
const submitted = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) return;
  draft.value = environmentDraft(props.environment);
  error.value = null;
  submitted.value = false;
});

const problems = computed(() => environmentDraftProblems(draft.value, props.others));
/** The problems the form shows: a field's once it holds something, every field's once Save was clicked. */
const shown = computed<EnvironmentDraftProblems>(() => {
  const all = problems.value;
  if (submitted.value) return all;
  const typed = draft.value;
  return {
    ...all,
    key: typed.key ? all.key : undefined,
    name: typed.name ? all.name : undefined,
    requiredTags: typed.requiredTags.length > 0 ? all.requiredTags : undefined,
  };
});
const keyRenamed = computed(
  () => !!props.environment && draft.value.key.trim().toLowerCase() !== props.environment.key.toLowerCase(),
);
const fullRunVariables = computed(() => draft.value.runVariables.length >= RUN_VARIABLE_LIMITS.count);

function addRunVariable() {
  if (!fullRunVariables.value) draft.value.runVariables.push({ name: '', value: '' });
}

async function submit() {
  submitted.value = true;
  if (environmentDraftHasProblem(problems.value) || saving.value) return;
  saving.value = true;
  error.value = null;
  try {
    const body = environmentDraftBody(draft.value);
    const answer = props.environment
      ? await $fetch<{ environment: EnvironmentRecord }>(
          `/api/projects/${props.projectId}/environments/${props.environment.id}`,
          { method: 'PATCH', body },
        )
      : await $fetch<{ environment: EnvironmentRecord }>(`/api/projects/${props.projectId}/environments`, {
          method: 'POST',
          body,
        });
    emit('saved', answer.environment);
    open.value = false;
  } catch (e) {
    error.value = errorMessage(e, 'The environment could not be saved.');
  } finally {
    saving.value = false;
  }
}

/** A field of a two-column row: its label and description on the row's first line, its input on the second. */
const PAIRED_FIELD_UI = { root: 'sm:row-span-2 sm:grid sm:grid-rows-subgrid' };
</script>

<template>
  <UModal
    v-model:open="open"
    :title="environment ? `Edit ${environment.name}` : 'Add an environment'"
    description="A deployment of the application this project's tests run against."
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <form
        class="space-y-5"
        method="post"
        data-testid="environment-editor"
        data-shot="environment-editor"
        @submit.prevent="submit"
      >
        <!-- The two fields share the grid's rows, so their inputs line up whatever their descriptions' length. -->
        <div class="grid gap-x-3 gap-y-3 sm:grid-cols-2 sm:gap-y-0">
          <UFormField
            label="Key"
            name="environmentKey"
            required
            :ui="PAIRED_FIELD_UI"
            :error="shown.key"
            :description="
              keyRenamed
                ? `The old key, ${environment?.key}, stays as an alias.`
                : 'The label its runs report, matched ignoring case.'
            "
          >
            <UInput
              v-model="draft.key"
              placeholder="staging"
              :maxlength="ENVIRONMENT_LIMITS.keyChars"
              class="w-full font-mono"
              autocomplete="off"
              spellcheck="false"
              data-testid="environment-key"
            />
          </UFormField>
          <UFormField
            label="Name"
            name="environmentName"
            required
            :ui="PAIRED_FIELD_UI"
            :error="shown.name"
            description="Shown everywhere."
          >
            <UInput
              v-model="draft.name"
              placeholder="Staging"
              :maxlength="ENVIRONMENT_LIMITS.nameChars"
              class="w-full"
              data-testid="environment-name"
            />
          </UFormField>
        </div>

        <UFormField
          label="Description"
          name="environmentDescription"
          :error="shown.description"
          description="For people and the AI diagnosis: what is special about it."
        >
          <UTextarea
            v-model="draft.description"
            :rows="2"
            autoresize
            placeholder="Data reset every night at 02:00"
            :maxlength="ENVIRONMENT_LIMITS.descriptionChars"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Aliases"
          name="environmentAliases"
          :error="shown.aliases ?? shown.list"
          description="Other labels its runs report, or * patterns (pr-*), matched ignoring case."
        >
          <UInputTags
            v-model="draft.aliases"
            placeholder="stg, pr-*"
            :max="ENVIRONMENT_LIMITS.aliases"
            add-on-blur
            add-on-paste
            class="w-full font-mono"
            data-testid="environment-aliases"
          />
        </UFormField>

        <fieldset class="space-y-2" data-testid="environment-run-variables">
          <legend class="text-sm text-highlighted">Run variables</legend>
          <p class="text-xs text-muted">
            Set over the project's run variables on every run Piwi starts for this environment, with
            <code>PIWI_ENVIRONMENT</code> set to its key. Never a secret: commands and confirmations show them.
          </p>
          <div v-for="(row, index) in draft.runVariables" :key="index" class="space-y-1">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
              <UInput
                v-model="row.name"
                class="sm:w-48 font-mono"
                placeholder="TEST_ENV"
                :aria-label="`Name of run variable ${index + 1}`"
                autocomplete="off"
                spellcheck="false"
              />
              <span class="hidden text-muted sm:inline" aria-hidden="true">=</span>
              <UInput
                v-model="row.value"
                class="min-w-0 flex-1 font-mono"
                placeholder="staging"
                :aria-label="`Value of run variable ${index + 1}`"
                autocomplete="off"
                spellcheck="false"
              />
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-trash-2"
                :aria-label="`Remove run variable ${index + 1}`"
                class="self-end sm:self-auto"
                @click="draft.runVariables.splice(index, 1)"
              />
            </div>
            <p v-if="shown.runVariables[index]" class="text-xs text-error" role="alert">
              {{ shown.runVariables[index] }}
            </p>
          </div>
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            icon="i-lucide-plus"
            :disabled="fullRunVariables"
            @click="addRunVariable"
          >
            Add a variable
          </UButton>
        </fieldset>

        <UFormField
          label="Env file"
          name="environmentEnvFile"
          :error="shown.envFile"
          description="The file its secrets are in on each machine, which the config loads. Piwi never reads it."
        >
          <UInput
            v-model="draft.envFile"
            placeholder=".env.staging"
            class="w-full sm:max-w-xs font-mono"
            autocomplete="off"
            spellcheck="false"
            data-testid="environment-env-file"
          />
        </UFormField>

        <USwitch
          v-model="draft.appFromCheckout"
          label="Built from the checkout"
          description="The app under test is built from the same commit as the tests: a webServer in the config, a preview deployment."
          data-testid="environment-app-from-checkout"
        />

        <div class="space-y-3">
          <USwitch
            v-model="draft.protected"
            label="Protected"
            description="Only the project's managers start runs against it from Piwi, after a confirmation, and only for the tests carrying a required tag."
            data-testid="environment-protected"
          />
          <UFormField
            v-if="draft.protected"
            label="Required tags"
            name="environmentRequiredTags"
            required
            :error="shown.requiredTags"
            description="Its runs keep to the tests carrying one of them."
          >
            <UInputTags
              v-model="draft.requiredTags"
              placeholder="@smoke"
              :max="ENVIRONMENT_LIMITS.requiredTags"
              add-on-blur
              add-on-paste
              class="w-full font-mono"
              data-testid="environment-required-tags"
            />
          </UFormField>
        </div>

        <p v-if="error" class="text-sm text-error" role="alert" data-testid="environment-error">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="outline" label="Cancel" @click="open = false" />
        <UButton
          color="primary"
          :label="environment ? 'Save environment' : 'Add environment'"
          :loading="saving"
          data-testid="environment-save"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>

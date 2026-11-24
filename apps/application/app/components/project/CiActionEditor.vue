<script setup lang="ts">
/**
 * Add or edit one CI action in a modal: its name, where it sends its request
 * (a GitHub workflow, a GitLab or Bitbucket pipeline, a Jenkins job or a custom
 * request), the inputs it sends beside the Playwright arguments, what it
 * accepts, its environment, and which kinds it is the default for. Saving hands
 * the action to the list; nothing is stored until the settings are saved.
 *
 * The target's jobs and the picked job's fields are read from the target
 * (`useCiJobListing`) and offered as choices; any name can still be typed.
 * Picking a job here fills what it declares: the arguments input it names,
 * and the inputs GitHub requires with no default.
 */
import {
  CI_ACTION_KIND_LABELS,
  CI_ACTION_KINDS,
  MAX_CI_ACTION_NAME_LENGTH,
  MAX_CI_INPUT_VALUE_LENGTH,
  type CiAction,
  type CiActionKind,
} from '#shared/ci-actions';
import { missingRequiredFields, undeclaredNames } from '#shared/ci-job-fields';
import {
  CI_ACTION_TARGET_ITEMS,
  ciActionDraft,
  ciActionFromDraft,
  ciListingTargetOfDraft,
  draftJob,
  draftSentNames,
  fieldItem,
  fieldsToAdd,
  fieldSummary,
  fillFromDeclared,
  inputDraftFromField,
  jobItem,
  newInputDraft,
  previewInputPairs,
  requiredFieldsToAdd,
  type CiActionDraft,
} from '~/utils/ci-action-form';

const props = defineProps<{
  /** The action to edit, or null to add one. */
  action: CiAction | null;
  /** The kinds the action opens as the default for. */
  defaultFor: CiActionKind[];
  /** The names the project's other actions have. */
  otherNames: string[];
  instanceUrl: string | null;
  /** The project the action belongs to, whose credentials a CI server target picks from. */
  projectId: number;
  /** The project's repository, whose API a GitHub, GitLab or Bitbucket action's credential must hold. */
  repositoryUrl?: string | null;
}>();
const emit = defineEmits<{ save: [action: CiAction, defaultFor: CiActionKind[]] }>();
const open = defineModel<boolean>('open', { default: false });

const draft = ref<CiActionDraft>(ciActionDraft(null));
const error = ref<string | null>(null);
/** What the CI server target says a save of the project would refuse about its credential. */
const credentialProblem = ref<string | null>(null);

watch(open, (isOpen) => {
  if (!isOpen) return;
  draft.value = ciActionDraft(props.action);
  draft.value.defaultFor = [...props.defaultFor];
  error.value = null;
  jobPicked.value = false;
});

const isCiServer = computed(() => draft.value.type === 'jenkins' || draft.value.type === 'custom');
/** The repository host a GitHub, GitLab or Bitbucket action dispatches on, whose SCM credential it may name. */
const repositoryHost = computed(() =>
  draft.value.type === 'github' || draft.value.type === 'gitlab' || draft.value.type === 'bitbucket'
    ? draft.value.type
    : null,
);
// Another host takes another credential: a change of the target's type within one draft drops the one picked.
watch(
  () => [draft.value, draft.value.type] as const,
  ([current, type], [previous, previousType]) => {
    if (current === previous && type !== previousType) current.scmCredentialId = null;
  },
);
const sendsInputs = computed(() => draft.value.type !== 'custom');

const listing = useCiJobListing(
  () => props.projectId,
  () => (open.value ? ciListingTargetOfDraft(draft.value) : null),
  () => draft.value.name,
  () => draft.value.id,
);
const jobItems = computed(() => listing.jobs.value?.map(jobItem) ?? null);
/** The picked workflow's file, beside its label, when the menu shows it by its name. */
const workflowFile = computed(() => {
  const workflow = draft.value.github.workflow.trim();
  const job = listing.jobs.value?.find((j) => j.id === workflow);
  return job && job.label !== job.id ? workflow : undefined;
});
const fieldItems = computed(() => listing.fields.value?.map(fieldItem) ?? null);
const declaredByName = computed(() => new Map((listing.fields.value ?? []).map((f) => [f.name, f])));
const listingLoading = computed(() => listing.jobsLoading.value || listing.fieldsLoading.value);
/** What the listing says, for the line under the target: what is being read, or why something is not listed. */
const listingStatus = computed(() => {
  if (listingLoading.value) return 'Reading what the target declares…';
  return [...new Set([listing.jobsMessage.value, listing.fieldsMessage.value].filter(Boolean))].join(' ') || null;
});
const fieldsToPick = computed(() =>
  listing.fields.value ? fieldsToAdd(draft.value, listing.fields.value).map(fieldItem) : [],
);
/** The declared input the add menu shows as picked, cleared once the row is added so the next pick is seen. */
const declaredPick = ref<string | undefined>(undefined);
/** What the target calls its job, by the targets that declare their names; GitLab takes any variable. */
const JOB_NOUN: Partial<Record<CiActionDraft['type'], string>> = {
  github: 'workflow',
  bitbucket: 'custom pipeline',
  jenkins: 'job',
};
/** What happens to a name the job does not declare, where the CI says. */
const UNDECLARED_EFFECT: Partial<Record<CiActionDraft['type'], string>> = {
  github: 'GitHub rejects a dispatch that sends an input the workflow does not declare.',
  jenkins: 'Jenkins drops a parameter its job does not declare.',
};
/** What the target calls one of the names a dispatch sends. */
const INPUT_NOUN: Record<CiActionDraft['type'], string> = {
  github: 'input',
  gitlab: 'variable',
  bitbucket: 'variable',
  jenkins: 'parameter',
  custom: 'input',
};
const undeclared = computed(() =>
  listing.fields.value && JOB_NOUN[draft.value.type]
    ? undeclaredNames(listing.fields.value, draftSentNames(draft.value))
    : [],
);
const requiredMissing = computed(() =>
  listing.fields.value && draft.value.type === 'github'
    ? missingRequiredFields(listing.fields.value, draftSentNames(draft.value))
    : [],
);
/** The required inputs the draft can add: a name Piwi cannot send stays in the warning only. */
const requiredToAdd = computed(() =>
  listing.fields.value && draft.value.type === 'github' ? requiredFieldsToAdd(draft.value, listing.fields.value) : [],
);

function addField(name: unknown) {
  const field = listing.fields.value?.find((f) => f.name === name);
  if (field) draft.value.inputs.push(inputDraftFromField(field));
  void nextTick(() => (declaredPick.value = undefined));
}

function addRequired() {
  for (const field of requiredToAdd.value) draft.value.inputs.push(inputDraftFromField(field));
}

// A job picked in this editor fills what it declares once its fields are read: never an action opened as saved.
const jobPicked = ref(false);
watch(
  () => [draft.value, draftJob(draft.value)] as const,
  ([current, job], [previous, previousJob]) => {
    if (current === previous && job !== previousJob) jobPicked.value = true;
  },
);
watch(listing.fieldsLoading, (loading) => {
  if (loading || !jobPicked.value) return;
  jobPicked.value = false;
  if (listing.fields.value) fillFromDeclared(draft.value, listing.fields.value);
});

const KIND_HELP: Partial<Record<CiActionKind, string>> = {
  tests: 'Re-run the failed tests of a cluster or one test',
  tags: 'Run the tests carrying the tags picked on the project page, as one --grep',
  flakeLab: 'Run a Flake Lab experiment for a flaky test',
};
const kindItems = CI_ACTION_KINDS.map((kind) => ({ kind, label: CI_ACTION_KIND_LABELS[kind], help: KIND_HELP[kind] }));
const defaultLabels: Record<CiActionKind, string> = {
  tests: 'Default for re-runs',
  suite: `Default for ${CI_ACTION_KIND_LABELS.suite}`,
  tags: 'Default for tagged tests',
  flakeLab: 'Default for Flake Lab',
};

function toggle(list: CiActionKind[], kind: CiActionKind, on: boolean) {
  const at = list.indexOf(kind);
  if (on && at < 0) list.push(kind);
  if (!on && at >= 0) list.splice(at, 1);
}

function setAccepts(kind: CiActionKind, on: boolean) {
  toggle(draft.value.accepts, kind, on);
  // A default only makes sense for a kind the action accepts.
  if (!on) toggle(draft.value.defaultFor, kind, false);
}

const inputPairs = computed(() => previewInputPairs(draft.value));

function submit() {
  if (isCiServer.value && credentialProblem.value) {
    error.value = credentialProblem.value;
    return;
  }
  const result = ciActionFromDraft(draft.value, { otherNames: props.otherNames, instanceUrl: props.instanceUrl });
  if (!result.action) {
    error.value = result.error;
    return;
  }
  error.value = null;
  emit(
    'save',
    result.action,
    result.action.accepts.length ? draft.value.defaultFor.filter((k) => result.action.accepts.includes(k)) : [],
  );
  open.value = false;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="action ? 'Edit CI action' : 'Add a CI action'"
    description="Where Piwi starts CI, and what it sends."
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <form
        class="space-y-5"
        method="post"
        data-testid="ci-action-editor"
        data-shot="ci-action-editor"
        @submit.prevent="submit"
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="Name" name="ciActionName" required>
            <UInput
              v-model="draft.name"
              placeholder="e.g. Smoke · staging"
              :maxlength="MAX_CI_ACTION_NAME_LENGTH"
              class="w-full"
              data-testid="ci-action-name"
            />
          </UFormField>
          <UFormField label="Target" name="ciActionType">
            <USelect
              v-model="draft.type"
              :items="[...CI_ACTION_TARGET_ITEMS]"
              class="w-full"
              aria-label="Target type"
              data-testid="ci-action-type"
            />
          </UFormField>
        </div>

        <div v-if="draft.type === 'github'" class="grid gap-3 sm:grid-cols-2">
          <UFormField label="Ref" name="ciActionGithubRef">
            <UInput
              v-model="draft.github.ref"
              placeholder="e.g. main"
              aria-label="GitHub ref"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField label="Workflow" name="ciActionGithubWorkflow" :hint="workflowFile">
            <CiDeclaredValueInput
              v-model="draft.github.workflow"
              :items="jobItems"
              :loading="listing.jobsLoading.value"
              placeholder="file, e.g. e2e.yml"
              aria-label="GitHub workflow file"
              data-testid="ci-action-github-workflow"
            />
          </UFormField>
          <UFormField label="Arguments input" name="ciActionGithubArgs">
            <CiDeclaredValueInput
              v-model="draft.github.argsInput"
              :items="fieldItems"
              placeholder="e.g. args"
              aria-label="GitHub arguments input"
            />
          </UFormField>
          <UFormField label="Dispatch id input" name="ciActionGithubDispatchId" hint="Optional">
            <CiDeclaredValueInput
              v-model="draft.github.dispatchIdInput"
              :items="fieldItems"
              optional
              placeholder="e.g. dispatch_id"
              aria-label="GitHub dispatch id input"
            />
          </UFormField>
        </div>
        <div v-else-if="draft.type === 'gitlab'" class="grid gap-3 sm:grid-cols-2">
          <UFormField label="Ref" name="ciActionGitlabRef">
            <UInput
              v-model="draft.gitlab.ref"
              placeholder="e.g. main"
              aria-label="GitLab ref"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField label="Arguments variable" name="ciActionGitlabArgs">
            <CiDeclaredValueInput
              v-model="draft.gitlab.argsVariable"
              :items="fieldItems"
              :loading="listing.fieldsLoading.value"
              placeholder="e.g. PIWI_RERUN_ARGS"
              aria-label="GitLab arguments variable"
            />
          </UFormField>
        </div>
        <div v-else-if="draft.type === 'bitbucket'" class="grid gap-3 sm:grid-cols-2">
          <UFormField label="Custom pipeline" name="ciActionBitbucketPipeline">
            <CiDeclaredValueInput
              v-model="draft.bitbucket.pipeline"
              :items="jobItems"
              :loading="listing.jobsLoading.value"
              placeholder="e.g. rerun"
              aria-label="Bitbucket custom pipeline"
            />
          </UFormField>
          <UFormField label="Arguments variable" name="ciActionBitbucketArgs">
            <CiDeclaredValueInput
              v-model="draft.bitbucket.argsVariable"
              :items="fieldItems"
              placeholder="e.g. PIWI_RERUN_ARGS"
              aria-label="Bitbucket arguments variable"
            />
          </UFormField>
        </div>
        <CiListingStatus
          v-if="repositoryHost"
          :status="listingStatus"
          :loading="listingLoading"
          @refresh="listing.refresh()"
        />
        <FormFieldGroup
          v-if="repositoryHost"
          label="Credential"
          help="settings.credentials"
          description="The SCM credential its dispatch and Check carry: a token scoped to CI, while the project’s keeps reading and writing feedback."
          data-testid="ci-action-scm-credential"
          data-shot="ci-action-scm-credential"
        >
          <ScmCredentialPicker
            v-model="draft.scmCredentialId"
            :project-id="projectId"
            :host="repositoryHost"
            :repository-url="repositoryUrl ?? null"
            none-label="The project’s SCM credential, else the instance’s"
            label="Dispatch credential"
          />
        </FormFieldGroup>
        <div v-if="isCiServer" class="rounded-md border border-default p-3">
          <CiServerTargetFields
            v-model="draft.ciServer"
            v-model:problem="credentialProblem"
            :instance-url="instanceUrl"
            :project-id="projectId"
            :inputs="inputPairs"
            :job-items="jobItems"
            :field-items="fieldItems"
            :jobs-loading="listing.jobsLoading.value"
          />
        </div>
        <CiListingStatus
          v-if="draft.type === 'jenkins'"
          :status="listingStatus"
          :loading="listingLoading"
          @refresh="listing.refresh()"
        />

        <fieldset v-if="sendsInputs" class="space-y-2" data-testid="ci-action-inputs">
          <legend class="text-sm text-highlighted">Inputs</legend>
          <p class="text-xs text-muted">
            Sent with every dispatch, beside the arguments and never inside them. A fixed input always has one value; a
            choice has a default and a list of options. Names start with a letter or an underscore, then letters, digits
            and underscores.
          </p>
          <div
            v-for="(row, index) in draft.inputs"
            :key="row.key"
            class="grid gap-2 rounded-md border border-default p-2 sm:grid-cols-[1fr_auto_2fr_auto]"
          >
            <UInput
              v-model="row.name"
              placeholder="name, e.g. TARGET_ENV"
              maxlength="100"
              :aria-label="`Input ${index + 1} name`"
              class="font-mono"
            />
            <USelect
              v-model="row.kind"
              :items="[
                { label: 'Fixed', value: 'fixed' },
                { label: 'Choice', value: 'choice' },
              ]"
              :aria-label="`Input ${index + 1} type`"
            />
            <UInput
              v-if="row.kind === 'fixed'"
              v-model="row.value"
              placeholder="value, e.g. staging"
              :maxlength="MAX_CI_INPUT_VALUE_LENGTH"
              :aria-label="`Input ${index + 1} value`"
              class="font-mono"
            />
            <div v-else class="space-y-2">
              <UTextarea
                v-model="row.options"
                :rows="2"
                autoresize
                placeholder="one option per line"
                :aria-label="`Input ${index + 1} options`"
                class="w-full font-mono"
              />
              <UInput
                v-model="row.default"
                placeholder="default option (the first when empty)"
                :maxlength="MAX_CI_INPUT_VALUE_LENGTH"
                :aria-label="`Input ${index + 1} default`"
                class="w-full font-mono"
              />
            </div>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-x"
              :aria-label="`Remove input ${index + 1}`"
              @click="draft.inputs.splice(index, 1)"
            />
            <p
              v-if="declaredByName.get(row.name.trim())"
              class="text-xs text-muted sm:col-span-4"
              data-testid="ci-action-input-declared"
            >
              {{ fieldSummary(declaredByName.get(row.name.trim())!) }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <USelectMenu
              v-if="fieldsToPick.length > 0"
              v-model="declaredPick"
              :items="fieldsToPick"
              value-key="value"
              :placeholder="`Add a declared ${INPUT_NOUN[draft.type]}`"
              :search-input="{ placeholder: 'Search the declared names…' }"
              icon="i-lucide-plus"
              color="neutral"
              variant="outline"
              size="xs"
              class="w-full sm:w-64"
              data-testid="ci-action-add-declared-input"
              @update:model-value="addField"
            />
            <UButton
              color="neutral"
              variant="outline"
              size="xs"
              icon="i-lucide-plus"
              data-testid="ci-action-add-input"
              @click="draft.inputs.push(newInputDraft())"
            >
              {{ fieldsToPick.length > 0 ? 'Add another input' : 'Add an input' }}
            </UButton>
          </div>
          <div role="status" class="space-y-1">
            <template v-if="undeclared.length > 0 || requiredMissing.length > 0">
              <div data-testid="ci-action-declared-warnings" class="space-y-1">
                <p v-if="undeclared.length > 0" class="text-xs text-warning">
                  The {{ JOB_NOUN[draft.type] }} does not declare {{ undeclared.join(', ') }}.
                  {{ UNDECLARED_EFFECT[draft.type] }}
                </p>
                <p v-if="requiredMissing.length > 0" class="flex flex-wrap items-center gap-2 text-xs text-warning">
                  The workflow requires {{ requiredMissing.map((f) => f.name).join(', ') }}, with no default: GitHub
                  rejects a dispatch without {{ requiredMissing.length > 1 ? 'them' : 'it' }}.
                  <UButton
                    v-if="requiredToAdd.length > 0"
                    color="neutral"
                    variant="link"
                    size="xs"
                    class="p-0"
                    @click="addRequired"
                  >
                    Add {{ requiredToAdd.map((f) => f.name).join(', ') }}
                  </UButton>
                </p>
              </div>
            </template>
          </div>
        </fieldset>

        <fieldset class="space-y-2">
          <legend class="text-sm text-highlighted">Accepts</legend>
          <div class="space-y-2">
            <UCheckbox
              v-for="item in kindItems"
              :key="item.kind"
              :model-value="draft.accepts.includes(item.kind)"
              :label="item.label"
              :description="item.help"
              :data-testid="`ci-action-accepts-${item.kind}`"
              @update:model-value="setAccepts(item.kind, $event === true)"
            />
          </div>
        </fieldset>

        <UFormField
          label="Environment"
          name="ciActionEnvironment"
          description="The environment this action runs in. A run of that environment starts this action first."
        >
          <SettingEnvironmentPicker
            v-model:environment-id="draft.environmentId"
            v-model:label="draft.environment"
            :project-id="projectId"
            none-label="Any environment"
            class="w-full sm:max-w-xs"
            data-testid="ci-action-environment"
          />
        </UFormField>

        <fieldset class="space-y-2">
          <legend class="text-sm text-highlighted">Defaults</legend>
          <div class="space-y-2">
            <USwitch
              v-for="kind in CI_ACTION_KINDS"
              :key="kind"
              :model-value="draft.defaultFor.includes(kind)"
              :label="defaultLabels[kind]"
              :disabled="!draft.accepts.includes(kind)"
              :data-testid="`ci-action-default-${kind}`"
              @update:model-value="toggle(draft.defaultFor, kind, $event === true)"
            />
          </div>
        </fieldset>

        <p v-if="error" class="text-sm text-error" role="alert" data-testid="ci-action-error">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="outline" label="Cancel" @click="open = false" />
        <UButton color="primary" label="Save action" data-testid="ci-action-save" @click="submit" />
      </div>
    </template>
  </UModal>
</template>

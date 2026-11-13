<script setup lang="ts">
/**
 * Add or edit one CI action in a modal: its name, where it sends its request
 * (a GitHub workflow, a GitLab or Bitbucket pipeline, a Jenkins job or a custom
 * request), the inputs it sends beside the Playwright arguments, what it
 * accepts, its environment, and which kinds it is the default for. Saving hands
 * the action to the list; nothing is stored until the settings are saved.
 */
import { CI_ACTION_KIND_LABELS, CI_ACTION_KINDS, type CiAction, type CiActionKind } from '#shared/ci-actions';
import {
  CI_ACTION_TARGET_ITEMS,
  ciActionDraft,
  ciActionFromDraft,
  newInputDraft,
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
  hasToken: boolean;
  tokenUrl: string | null;
  saving: boolean;
}>();
const emit = defineEmits<{ save: [action: CiAction, defaultFor: CiActionKind[]]; removeToken: [] }>();
const open = defineModel<boolean>('open', { default: false });
const token = defineModel<string>('token', { required: true });

const draft = ref<CiActionDraft>(ciActionDraft(null));
const error = ref<string | null>(null);

watch(open, (isOpen) => {
  if (!isOpen) return;
  draft.value = ciActionDraft(props.action);
  draft.value.defaultFor = [...props.defaultFor];
  error.value = null;
});

const isCiServer = computed(() => draft.value.type === 'jenkins' || draft.value.type === 'custom');
const sendsInputs = computed(() => draft.value.type !== 'custom');

const KIND_HELP: Record<CiActionKind, string> = {
  tests: 'Re-run the failed tests of a cluster or one test',
  suite: 'Run the whole suite from the project page',
  flakeLab: 'Run a Flake Lab experiment for a flaky test',
};
const kindItems = CI_ACTION_KINDS.map((kind) => ({ kind, label: CI_ACTION_KIND_LABELS[kind], help: KIND_HELP[kind] }));
const defaultLabels: Record<CiActionKind, string> = {
  tests: 'Default for re-runs',
  suite: 'Default for Run on CI',
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

const inputPairs = computed<[string, string][]>(() =>
  draft.value.inputs.flatMap((row) => {
    const name = row.name.trim();
    if (!name) return [];
    return [[name, row.kind === 'fixed' ? row.value.trim() : (row.options.split('\n')[0] ?? '').trim()]];
  }),
);

function submit() {
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
              maxlength="80"
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

        <div v-if="draft.type === 'github'" class="grid gap-2 sm:grid-cols-3">
          <UInput
            v-model="draft.github.workflow"
            placeholder="workflow file, e.g. e2e.yml"
            aria-label="GitHub workflow file"
            class="font-mono"
            data-testid="ci-action-github-workflow"
          />
          <UInput v-model="draft.github.ref" placeholder="ref, e.g. main" aria-label="GitHub ref" class="font-mono" />
          <UInput
            v-model="draft.github.argsInput"
            placeholder="arguments input, e.g. args"
            aria-label="GitHub arguments input"
            class="font-mono"
          />
          <UInput
            v-model="draft.github.dispatchIdInput"
            placeholder="dispatch id input (optional)"
            aria-label="GitHub dispatch id input"
            class="font-mono sm:col-span-3 sm:max-w-xs"
          />
        </div>
        <div v-else-if="draft.type === 'gitlab'" class="grid gap-2 sm:grid-cols-2">
          <UInput v-model="draft.gitlab.ref" placeholder="ref, e.g. main" aria-label="GitLab ref" class="font-mono" />
          <UInput
            v-model="draft.gitlab.argsVariable"
            placeholder="arguments variable, e.g. PIWI_RERUN_ARGS"
            aria-label="GitLab arguments variable"
            class="font-mono"
          />
        </div>
        <div v-else-if="draft.type === 'bitbucket'" class="grid gap-2 sm:grid-cols-2">
          <UInput
            v-model="draft.bitbucket.pipeline"
            placeholder="custom pipeline name, e.g. rerun"
            aria-label="Bitbucket custom pipeline"
            class="font-mono"
          />
          <UInput
            v-model="draft.bitbucket.argsVariable"
            placeholder="arguments variable, e.g. PIWI_RERUN_ARGS"
            aria-label="Bitbucket arguments variable"
            class="font-mono"
          />
        </div>
        <div v-else class="rounded-md border border-default p-3">
          <CiServerTargetFields
            v-model="draft.ciServer"
            v-model:token="token"
            :instance-url="instanceUrl"
            :has-token="hasToken"
            :token-url="tokenUrl"
            :saving="saving"
            :inputs="inputPairs"
            @remove-token="emit('removeToken')"
          />
        </div>

        <fieldset v-if="sendsInputs" class="space-y-2" data-testid="ci-action-inputs">
          <legend class="text-sm text-highlighted">Inputs</legend>
          <p class="text-xs text-muted">
            Sent with every dispatch, beside the arguments and never inside them. A fixed input always has one value; a
            choice has a default and the options a button can offer.
          </p>
          <div
            v-for="(row, index) in draft.inputs"
            :key="row.key"
            class="grid gap-2 rounded-md border border-default p-2 sm:grid-cols-[1fr_auto_2fr_auto]"
          >
            <UInput
              v-model="row.name"
              placeholder="name, e.g. TARGET_ENV"
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
          </div>
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            icon="i-lucide-plus"
            data-testid="ci-action-add-input"
            @click="draft.inputs.push(newInputDraft())"
          >
            Add an input
          </UButton>
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
          description="The environment this action runs in, such as staging. A run in that environment starts this action first."
        >
          <UInput
            v-model="draft.environment"
            placeholder="optional, e.g. staging"
            maxlength="80"
            class="w-full sm:max-w-xs"
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

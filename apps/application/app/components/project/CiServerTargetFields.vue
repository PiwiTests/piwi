<script setup lang="ts">
/**
 * The CI server target of a CI action: the preset (Jenkins, or a Custom
 * request), the credential its requests carry and the base URL, the preset's
 * fields, and the request a dispatch would send. The credential is picked from
 * the ones shared with the project (Settings → Credentials), or created here
 * for it; with none, the instance's is sent under its URL.
 */
import { isUnderBaseUrl, normalizeCiServerBaseUrl } from '#shared/ci-server';
import type { CredentialOption, CredentialSummary } from '#shared/credentials';
import type { ApiResponse } from '~~/types/api';
import { ciServerRequestPreview, customizeCiServerForm, type CiServerFormState } from '~/utils/ci-server-form';
import type { CiDeclaredItem } from '~/utils/ci-action-form';

const props = defineProps<{
  /** The instance's `PIWI_CI_SERVER_URL`, or null when it sets none. */
  instanceUrl: string | null;
  /** The action inputs a request carrying the instance's credential may send; null when unknown. */
  instanceAllowedInputs?: string[] | null;
  /** The project the action belongs to, whose credentials the picker lists. */
  projectId: number;
  /** The action's inputs as name and value pairs, shown in the request preview. */
  inputs?: [string, string][];
  /** The jobs the CI server lists, offered for the job; null while it lists none. */
  jobItems?: CiDeclaredItem[] | null;
  /** The parameters the job declares, offered for the arguments and dispatch id parameters; null while unknown. */
  fieldItems?: CiDeclaredItem[] | null;
  jobsLoading?: boolean;
}>();
const state = defineModel<CiServerFormState>({ required: true });
/** Why a save of the project would refuse this target's credential, or null: the editor refuses it first. */
const problem = defineModel<string | null>('problem', { default: null });

type CredentialsAnswer = ApiResponse<typeof import('~~/server/api/credentials/index.get').default>;
const {
  data: listed,
  refresh,
  status,
} = useFetch<CredentialsAnswer>('/api/credentials', {
  key: `ci-credentials-${props.projectId}`,
  query: { projectId: props.projectId, service: 'ci-server' },
  server: false,
});
const credentials = computed(() => (listed.value?.credentials ?? []) as CredentialOption[]);
const chosen = computed(() => credentials.value.find((c) => c.id === state.value.credentialId) ?? null);
/** Whether the list has answered: until then a named credential is not known to be missing. */
const listedOk = computed(() => status.value === 'success');
const canEncrypt = computed(() => listed.value?.canEncrypt ?? true);

/** No credential picked: the instance's, when it sets one. */
const NONE = -1;
const credentialItems = computed(() => [
  { label: props.instanceUrl ? 'The instance credential' : 'No credential', value: NONE },
  ...credentials.value.map((c) => ({
    label: c.disabled ? `${c.name} (disabled)` : c.name,
    value: c.id,
    // A per-user credential runs the action in the name of whoever starts it, with their own token.
    description: c.perUser
      ? `In the name of whoever starts it · ${c.destination}`
      : c.user
        ? `${c.user} · ${c.destination}`
        : c.destination,
  })),
]);
const credentialValue = computed({
  get: () => state.value.credentialId ?? NONE,
  set: (value: number) => {
    state.value.credentialId = value === NONE ? null : value;
  },
});

const previewOpts = computed(() => ({
  instanceUrl: props.instanceUrl,
  instanceAllowedInputs: props.instanceAllowedInputs ?? null,
  credential: chosen.value,
  inputs: props.inputs,
}));
/** What the preview calls the credential that leaves inputs out. */
const droppingCredential = computed(() =>
  preview.value.credential === 'instance' ? 'The instance credential' : `“${chosen.value?.name ?? ''}”`,
);
const preview = computed(() => ciServerRequestPreview(state.value, 'rerun', previewOpts.value));
/** The preview waits for the list when the action names a credential, whose destination may be its base URL. */
const previewReady = computed(() => listedOk.value || state.value.credentialId === null);

/** The base URL a request uses when the field is empty: the credential's destination, else the instance's. */
const fallbackUrl = computed(() => chosen.value?.destination ?? props.instanceUrl);

const credentialDescription = computed(() => {
  if (state.value.credentialId && !listedOk.value) {
    return status.value === 'error'
      ? 'The credentials shared with this project could not be read.'
      : 'Reading the credentials shared with this project…';
  }
  const request = preview.value;
  if (request.carriesAuth === false) return 'This request carries no credential: its auth is none.';
  const credential = chosen.value;
  if (state.value.credentialId && !credential) {
    return 'The credential this action names is not shared with this project any more: pick another one.';
  }
  if (credential) {
    if (credential.disabled) return `“${credential.name}” is disabled: a dispatch is refused until it is enabled.`;
    if (credential.secretEnvSet === false) {
      return `“${credential.name}” reads its secret from ${credential.secretEnv}, which is not set on the server: a dispatch is refused.`;
    }
    if (request.url && !isUnderBaseUrl(credential.destination, request.url)) {
      return `“${credential.name}” is sent only under ${credential.destination}, and this request goes elsewhere: a dispatch is refused.`;
    }
    if (state.value.preset === 'custom' && !credential.customRequests) {
      return `“${credential.name}” does not go with a Custom request: a dispatch is refused.`;
    }
    return `“${credential.name}” is sent with this request, and each use is logged.`;
  }
  if (state.value.preset === 'custom') return 'A Custom request carries only a credential it names.';
  if (!props.instanceUrl) return 'The instance has no CI server credential, so this request carries none.';
  if (request.url && !isUnderBaseUrl(props.instanceUrl, request.url)) {
    return `This request is not under the instance CI server URL (${props.instanceUrl}), so it carries no credential.`;
  }
  return 'The instance credential is sent, only under the instance CI server URL.';
});

const creating = ref(false);
watch(
  [chosen, listedOk, () => state.value.preset, () => state.value.baseUrl, () => state.value.credentialId],
  () => {
    const credential = chosen.value;
    const baseUrl = normalizeCiServerBaseUrl(state.value.baseUrl);
    if (!state.value.credentialId || !listedOk.value) problem.value = null;
    else if (!credential) problem.value = 'Pick a credential shared with this project.';
    else if (baseUrl && !isUnderBaseUrl(credential.destination, baseUrl)) {
      problem.value = `The base URL is not under ${credential.destination}, where “${credential.name}” is sent: clear it, or pick another credential.`;
    } else if (state.value.preset === 'custom' && !credential.customRequests) {
      problem.value = `“${credential.name}” does not go with a Custom request: pick another credential.`;
    } else problem.value = null;
  },
  { immediate: true },
);

async function created(credential: CredentialSummary) {
  await refresh();
  // A credential no longer shared with this project, once its scope was edited in the form, is not picked.
  if (!credential.scope.allProjects && !credential.scope.projectIds.includes(props.projectId)) return;
  state.value.credentialId = credential.id;
  if (normalizeCiServerBaseUrl(state.value.baseUrl) === credential.destination) state.value.baseUrl = '';
}

function customize() {
  state.value = customizeCiServerForm(state.value);
}
</script>

<template>
  <div class="space-y-3" data-testid="ci-server-target" data-shot="ci-server-target">
    <FormFieldGroup label="Credential" help="settings.credentials" data-testid="ci-server-credential">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <USelect
          v-model="credentialValue"
          :items="credentialItems"
          aria-label="CI server credential"
          class="w-full sm:max-w-sm"
        />
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-key-round"
          :disabled="!canEncrypt"
          :title="canEncrypt ? undefined : 'Set PIWI_SECRET_KEY on the server to save a credential'"
          data-testid="ci-server-credential-new"
          @click="creating = true"
        >
          New credential
        </UButton>
      </div>
      <p class="mt-1 text-xs text-muted" data-testid="ci-server-credential-description">{{ credentialDescription }}</p>
    </FormFieldGroup>

    <UFormField label="Base URL" name="ciServerBaseUrl">
      <UInput
        v-model="state.baseUrl"
        :placeholder="fallbackUrl ?? 'https://jenkins.example.com/'"
        aria-label="CI server base URL"
        class="w-full font-mono"
      />
      <p v-if="!state.baseUrl.trim()" class="mt-1 text-xs text-muted">
        {{
          chosen
            ? 'Uses the credential’s destination.'
            : instanceUrl
              ? 'Uses the instance’s CI server.'
              : 'Enter its URL, or pick a credential.'
        }}
      </p>
    </UFormField>

    <template v-if="state.preset === 'jenkins'">
      <div class="space-y-2">
        <p class="text-xs text-muted">
          The job as Jenkins shows its path (<code class="font-mono">polaris/e2e</code>;
          <code class="font-mono">polaris/e2e/{branch}</code> for a multibranch pipeline, read on its default branch)
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="Job" name="ciServerJob">
            <CiDeclaredValueInput
              v-model="state.rerun.job"
              :items="jobItems ?? null"
              :loading="jobsLoading"
              placeholder="e.g. polaris/e2e"
              aria-label="Jenkins job"
            />
          </UFormField>
          <UFormField label="Default branch" name="ciServerRef">
            <UInput
              v-model="state.rerun.ref"
              placeholder="e.g. main"
              aria-label="Jenkins default branch"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField label="Arguments parameter" name="ciServerArgs">
            <CiDeclaredValueInput
              v-model="state.rerun.argsParameter"
              :items="fieldItems ?? null"
              optional
              placeholder="PIWI_RERUN_ARGS"
              aria-label="Jenkins arguments parameter"
            />
          </UFormField>
          <UFormField label="Dispatch id parameter" name="ciServerDispatchId">
            <CiDeclaredValueInput
              v-model="state.rerun.dispatchParameter"
              :items="fieldItems ?? null"
              optional
              placeholder="PIWI_ORIGIN_REF"
              aria-label="Jenkins dispatch id parameter"
            />
          </UFormField>
        </div>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-code" @click="customize">
          Customize the request
        </UButton>
      </div>
    </template>

    <template v-else>
      <UFormField
        label="Request"
        name="ciServerCustom"
        description="JSON: auth (none, basic, bearer or { header }) and rerun, the request: { method, path, query, headers, body, link, buildNumber }. Placeholders: {{args}}, {{dispatchId}}, {{ref}}, {{commit}}, {{branchJob}}."
      >
        <UTextarea
          v-model="state.customJson"
          :rows="10"
          autoresize
          aria-label="Custom CI server request"
          class="w-full font-mono"
        />
      </UFormField>
      <UInput
        v-model="state.customRef"
        placeholder="default branch, e.g. main"
        aria-label="Custom request default branch"
        class="w-full font-mono sm:max-w-xs"
      />
    </template>

    <div class="space-y-1">
      <p class="text-xs text-muted">The request this action sends, with sample values</p>
      <template v-if="previewReady">
        <template v-if="preview.text">
          <CodeBlock :code="preview.text" lang="text" />
          <p v-if="preview.droppedInputs.length" class="text-xs text-warning" data-testid="ci-server-dropped-inputs">
            {{ droppingCredential }} does not allow {{ preview.droppedInputs.join(', ') }}: a dispatch leaves
            {{ preview.droppedInputs.length > 1 ? 'them' : 'it' }} out.
          </p>
        </template>
        <p v-else class="text-xs text-error">{{ preview.error }}</p>
      </template>
      <p v-else class="text-xs text-muted">Reading the credential…</p>
    </div>

    <CredentialFormModal
      v-model:open="creating"
      :credential="null"
      service="ci-server"
      :project-id="projectId"
      @saved="created"
    />
  </div>
</template>

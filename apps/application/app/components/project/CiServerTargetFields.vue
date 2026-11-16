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

const props = defineProps<{
  /** The instance's `PIWI_CI_SERVER_URL`, or null when it sets none. */
  instanceUrl: string | null;
  /** The project the action belongs to, whose credentials the picker lists. */
  projectId: number;
  /** The action's inputs as name and value pairs, shown in the request preview. */
  inputs?: [string, string][];
}>();
const state = defineModel<CiServerFormState>({ required: true });

type CredentialsAnswer = ApiResponse<typeof import('~~/server/api/credentials/index.get').default>;
const { data: listed, refresh } = useFetch<CredentialsAnswer>('/api/credentials', {
  key: `ci-credentials-${props.projectId}`,
  query: { projectId: props.projectId, service: 'ci-server' },
  server: false,
});
const credentials = computed(() => (listed.value?.credentials ?? []) as CredentialOption[]);
const chosen = computed(() => credentials.value.find((c) => c.id === state.value.credentialId) ?? null);

/** No credential picked: the instance's, when it sets one. */
const NONE = -1;
const credentialItems = computed(() => [
  { label: props.instanceUrl ? 'The instance credential' : 'No credential', value: NONE },
  ...credentials.value.map((c) => ({
    label: c.disabled ? `${c.name} (disabled)` : c.name,
    value: c.id,
    description: c.user ? `${c.user} · ${c.destination}` : c.destination,
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
  credential: chosen.value,
  inputs: props.inputs,
}));
const preview = computed(() => ciServerRequestPreview(state.value, 'rerun', previewOpts.value));

/** The base URL a request uses when the field is empty: the credential's destination, else the instance's. */
const fallbackUrl = computed(() => chosen.value?.destination ?? props.instanceUrl);

const credentialDescription = computed(() => {
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
async function created(credential: CredentialSummary) {
  await refresh();
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
          Job, as Jenkins shows its path (<code class="font-mono">polaris/e2e</code>;
          <code class="font-mono">polaris/e2e/{branch}</code> for a multibranch pipeline)
        </p>
        <div class="grid gap-2 sm:grid-cols-2">
          <UInput
            v-model="state.rerun.job"
            placeholder="job, e.g. polaris/e2e"
            aria-label="Jenkins job"
            class="font-mono"
          />
          <UInput
            v-model="state.rerun.ref"
            placeholder="default branch, e.g. main"
            aria-label="Jenkins default branch"
            class="font-mono"
          />
          <UInput
            v-model="state.rerun.argsParameter"
            placeholder="arguments parameter: PIWI_RERUN_ARGS"
            aria-label="Jenkins arguments parameter"
            class="font-mono"
          />
          <UInput
            v-model="state.rerun.dispatchParameter"
            placeholder="dispatch id parameter: PIWI_ORIGIN_REF"
            aria-label="Jenkins dispatch id parameter"
            class="font-mono"
          />
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
      <CodeBlock v-if="preview.text" :code="preview.text" lang="text" />
      <p v-else class="text-xs text-error">{{ preview.error }}</p>
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

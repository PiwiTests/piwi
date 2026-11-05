<script setup lang="ts">
/**
 * The CI server a project's CI re-run dispatches to: the preset (Jenkins, or a
 * Custom request), the base URL and credential, the preset's fields for the
 * re-run and for Flake Lab, and the request a dispatch would send. The token is
 * write-only: a blank field keeps the stored one, which is sent only under the
 * base URL it was saved with.
 */
import { CI_SERVER_PRESET_REGISTRY, normalizeCiServerBaseUrl } from '#shared/ci-server';
import {
  ciServerPreviewCredential,
  ciServerRequestPreview,
  ciServerTokenState,
  customizeCiServerForm,
  type CiServerFormState,
} from '~/utils/ci-server-form';

const props = defineProps<{
  /** The instance's `PIWI_CI_SERVER_URL`, or null when it sets none. */
  instanceUrl: string | null;
  hasToken: boolean;
  /** The base URL the stored token is bound to. */
  tokenUrl: string | null;
  saving: boolean;
}>();
const state = defineModel<CiServerFormState>({ required: true });
const token = defineModel<string>('token', { required: true });
const emit = defineEmits<{ removeToken: [] }>();

const presetItems = [
  { label: CI_SERVER_PRESET_REGISTRY.jenkins.label, value: 'jenkins' },
  { label: 'Custom request', value: 'custom' },
];

const effectiveBaseUrl = computed(() => normalizeCiServerBaseUrl(state.value.baseUrl) ?? props.instanceUrl);
const tokenState = computed(() =>
  props.hasToken ? ciServerTokenState(effectiveBaseUrl.value, props.tokenUrl) : 'none',
);
const tokenDescription = computed(() => {
  if (tokenState.value === 'bound') {
    return `A token is stored for ${props.tokenUrl} and sent only under it. Leave empty to keep it.`;
  }
  if (tokenState.value === 'elsewhere') {
    return `The stored token is bound to ${props.tokenUrl}, so it is not sent to this base URL: enter it again.`;
  }
  return state.value.preset === 'custom'
    ? 'Sent with every request. A Custom request never carries the instance token.'
    : 'Leave empty to use the instance token, sent only under the instance CI server URL.';
});

const previewOpts = computed(() => ({
  instanceUrl: props.instanceUrl,
  credential: ciServerPreviewCredential(state.value, {
    instanceUrl: props.instanceUrl,
    typedToken: Boolean(token.value.trim()),
    tokenUrl: props.hasToken ? props.tokenUrl : null,
  }),
}));
const preview = computed(() => ciServerRequestPreview(state.value, 'rerun', previewOpts.value));
const flakeLabPreview = computed(() =>
  state.value.preset === 'custom' || state.value.flakeLab.job.trim()
    ? ciServerRequestPreview(state.value, 'flakeLab', previewOpts.value)
    : null,
);

function customize() {
  state.value = customizeCiServerForm(state.value);
}
</script>

<template>
  <div class="space-y-3" data-testid="ci-server-target">
    <div class="grid gap-2 sm:grid-cols-2">
      <UFormField label="CI server" name="ciServerPreset">
        <USelect v-model="state.preset" :items="presetItems" class="w-full" aria-label="CI server preset" />
      </UFormField>
      <UFormField label="Base URL" name="ciServerBaseUrl">
        <UInput
          v-model="state.baseUrl"
          :placeholder="instanceUrl ?? 'https://jenkins.example.com/'"
          aria-label="CI server base URL"
          class="w-full font-mono"
        />
        <p v-if="!state.baseUrl.trim()" class="mt-1 text-xs text-muted">
          {{ instanceUrl ? 'Uses the instance’s CI server.' : 'The instance sets no CI server: enter its URL.' }}
        </p>
      </UFormField>
    </div>

    <div class="grid gap-2 sm:grid-cols-2">
      <UFormField label="User" name="ciServerUser">
        <UInput
          v-model="state.user"
          placeholder="the user the token belongs to"
          autocomplete="off"
          aria-label="CI server user"
          class="w-full font-mono"
        />
      </UFormField>
      <UFormField label="API token" name="ciServerToken">
        <UInput
          v-model="token"
          type="password"
          autocomplete="off"
          :placeholder="hasToken ? '•••••••• (unchanged)' : 'API token'"
          aria-label="CI server API token"
          class="w-full font-mono"
        />
      </UFormField>
    </div>
    <p class="text-xs text-muted">
      {{ tokenDescription }}
      <UButton
        v-if="hasToken"
        size="xs"
        color="error"
        variant="link"
        class="px-0"
        icon="i-lucide-trash-2"
        :disabled="saving"
        @click="emit('removeToken')"
      >
        Remove stored token
      </UButton>
    </p>

    <template v-if="state.preset === 'jenkins'">
      <div class="space-y-2">
        <p class="text-xs text-muted">
          Re-run job, as Jenkins shows its path (<code class="font-mono">polaris/e2e</code>;
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
      <div class="space-y-2" data-testid="ci-server-flake-lab">
        <p class="text-xs text-muted">
          Flake Lab job (optional): runs <code class="font-mono">npx @piwitests/reporter $PIWI_RERUN_ARGS</code>, which
          receives <code class="font-mono">flake 12</code> or <code class="font-mono">flake verify 12</code>
        </p>
        <div class="grid gap-2 sm:grid-cols-2">
          <UInput
            v-model="state.flakeLab.job"
            placeholder="job, e.g. polaris/flake-lab"
            aria-label="Jenkins Flake Lab job"
            class="font-mono"
          />
          <UInput
            v-model="state.flakeLab.argsParameter"
            placeholder="arguments parameter: PIWI_RERUN_ARGS"
            aria-label="Jenkins Flake Lab arguments parameter"
            class="font-mono"
          />
        </div>
      </div>
      <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-code" @click="customize">
        Customize the request
      </UButton>
    </template>

    <template v-else>
      <UFormField
        label="Request"
        name="ciServerCustom"
        description="JSON: auth (none, basic, bearer or { header }), rerun and an optional flakeLab, each { method, path, query, headers, body, link, buildNumber }. Placeholders: {{args}}, {{dispatchId}}, {{ref}}, {{commit}}, {{branchJob}}."
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
      <p class="text-xs text-muted">The request a re-run sends, with sample values</p>
      <CodeBlock v-if="preview.text" :code="preview.text" lang="text" />
      <p v-else class="text-xs text-error">{{ preview.error }}</p>
      <template v-if="flakeLabPreview">
        <CodeBlock v-if="flakeLabPreview.text" :code="flakeLabPreview.text" lang="text" filename="Flake Lab" />
        <p v-else-if="state.preset !== 'custom'" class="text-xs text-error">{{ flakeLabPreview.error }}</p>
      </template>
    </div>
  </div>
</template>

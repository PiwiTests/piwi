<script setup lang="ts">
/**
 * The CI server target of a CI action: the preset (Jenkins, or a Custom
 * request), the base URL and credential, the preset's fields, and the request a
 * dispatch would send. The project's CI server token is not set here: it is one
 * field in the CI section, bound to one base URL, and this form only says
 * whether it applies to the request.
 */
import { isUnderBaseUrl, normalizeCiServerBaseUrl } from '#shared/ci-server';
import {
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
  /** The action's inputs as name and value pairs, shown in the request preview. */
  inputs?: [string, string][];
}>();
const state = defineModel<CiServerFormState>({ required: true });

const previewOpts = computed(() => ({
  instanceUrl: props.instanceUrl,
  tokenUrl: props.hasToken ? props.tokenUrl : null,
  inputs: props.inputs,
}));
const preview = computed(() => ciServerRequestPreview(state.value, 'rerun', previewOpts.value));

/** The stored token is judged on the re-run request's URL, as the server judges it; else on the base URL. */
const effectiveBaseUrl = computed(() => normalizeCiServerBaseUrl(state.value.baseUrl) ?? props.instanceUrl);
const tokenState = computed(() =>
  props.hasToken ? ciServerTokenState(preview.value.url ?? effectiveBaseUrl.value, props.tokenUrl) : 'none',
);
const tokenDescription = computed(() => {
  const request = preview.value;
  if (request.carriesAuth === false) return 'This request carries no credential: its auth is none.';
  if (tokenState.value === 'bound') {
    return `The project’s CI server token (${props.tokenUrl}) is sent with this request. Set it in the CI section.`;
  }
  if (tokenState.value === 'elsewhere') {
    return `The project’s CI server token is bound to ${props.tokenUrl}, so a request outside it goes without it. Set it again in the CI section.`;
  }
  if (state.value.preset === 'custom') {
    return 'A Custom request carries the project’s CI server token, set in the CI section, and never the instance token.';
  }
  if (!props.instanceUrl) {
    return 'The instance has no CI server, so no token is sent unless the CI section holds one for this base URL.';
  }
  if (request.url && !isUnderBaseUrl(props.instanceUrl, request.url)) {
    return `This request is not under the instance CI server URL (${props.instanceUrl}), so no token is sent unless the CI section holds one for it.`;
  }
  return 'The instance token is sent, only under the instance CI server URL. The CI section can hold a project token instead.';
});

function customize() {
  state.value = customizeCiServerForm(state.value);
}
</script>

<template>
  <div class="space-y-3" data-testid="ci-server-target" data-shot="ci-server-target">
    <div class="grid gap-2 sm:grid-cols-2">
      <UFormField label="Base URL" name="ciServerBaseUrl" class="sm:col-span-2">
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

    <UFormField label="User" name="ciServerUser" class="sm:max-w-sm">
      <UInput
        v-model="state.user"
        placeholder="the user the token belongs to"
        autocomplete="off"
        aria-label="CI server user"
        class="w-full font-mono"
      />
    </UFormField>
    <p class="text-xs text-muted">{{ tokenDescription }}</p>

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
  </div>
</template>

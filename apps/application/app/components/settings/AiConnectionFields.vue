<script setup lang="ts">
/**
 * One role's own provider connection in Settings → AI: only the fields its tile
 * needs (the API key, the server address, the model, the temperature), then a
 * test whose result stays in view. A key typed here is saved as a credential
 * (Settings → Credentials) bound to the role's endpoint; a saved one can be
 * picked instead. A command-line tool shows its status and sign-in instead of
 * a key. Env-managed, the key and address are the server's.
 */
import { aiEndpoint, credentialsServingEveryProject, type CredentialSummary } from '#shared/credentials';
import type { AiModelRole, ApiResponse } from '~~/types/api';
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';
import {
  type LocalCliProvider,
  isLocalCliProvider,
  providerLabel,
  providerTile,
  suggestedModel,
} from '~/utils/ai-provider-catalog';
import { ROLE_PURPOSE } from '~/composables/useAiSettingsForm';

const props = defineProps<{ role: AiModelRole }>();

const form = useAiSettingsForm();
const r = computed(() => form.roles[props.role]);
const tile = computed(() => providerTile(r.value.tile));
const purpose = computed(() => ROLE_PURPOSE[props.role]);
const env = computed(() => form.envManaged.value);
const cliProvider = computed<LocalCliProvider | null>(() =>
  isLocalCliProvider(r.value.provider) ? r.value.provider : null,
);
const isCli = computed(() => cliProvider.value !== null);
const keyStored = computed(() => form.keyStored(props.role));
const stored = computed(() => form.stored(props.role));

const ENV_PREFIX: Record<AiModelRole, string> = {
  diagnosis: 'PIWI_AI_',
  research: 'PIWI_AI_RESEARCH_',
  embedding: 'PIWI_AI_EMBEDDING_',
  assistant: 'PIWI_AI_ASSISTANT_',
};
const envVar = (name: string) => [`${ENV_PREFIX[props.role]}${name}` as PiwiEnvVarName];

const showKey = ref(false);
const replacingKey = ref(false);
const addingKey = ref(false);
const editingUrl = ref(false);
watch(
  () => r.value.tile,
  () => {
    replacingKey.value = false;
    addingKey.value = false;
    editingUrl.value = false;
  },
);

const title = computed(() => {
  const label = tile.value?.label ?? providerLabel(r.value.provider, r.value.baseUrl);
  return isCli.value ? `${label} on this machine` : `Connect to ${label}`;
});

const hasKeyField = computed(() => {
  if (isCli.value || !tile.value) return false;
  if (tile.value.key !== 'none') return true;
  return keyStored.value || addingKey.value || Boolean(r.value.apiKey);
});

/**
 * The stored key belongs to another provider or address, and this one needs a
 * key: the server asks for it again. Where a key is optional, saving drops it.
 */
const keyNeedsReentry = computed(
  () =>
    tile.value?.key === 'required' &&
    !keyStored.value &&
    stored.value?.provider === r.value.provider &&
    Boolean(stored.value?.hasApiKey) &&
    !stored.value?.reuse &&
    !r.value.apiKey,
);

/** A cloud tile's address is its own; it shows read-only until changed. */
const urlFixed = computed(() => tile.value?.group === 'cloud' && Boolean(tile.value.baseUrl) && !editingUrl.value);

const placeholder = computed(() => {
  const suggestion = suggestedModel(r.value.tile, purpose.value);
  if (suggestion) return `e.g. ${suggestion}`;
  return purpose.value === 'embed' ? 'Embedding model ID' : 'Model ID';
});

const secretKeyCommand = `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`;

type CredentialsAnswer = ApiResponse<typeof import('~~/server/api/credentials/index.get').default>;
const { data: listed } = useFetch<CredentialsAnswer>('/api/credentials', { key: 'ai-credentials', server: false });
/** The endpoint the role's key goes to, as the form reads now. */
const endpoint = computed(() => aiEndpoint(r.value.provider, r.value.baseUrl));
/** The saved AI keys the role may name: shared with all projects, sent under its endpoint. */
const savedKeys = computed(() =>
  credentialsServingEveryProject((listed.value?.credentials ?? []) as CredentialSummary[], 'ai', endpoint.value),
);
// A move to another endpoint drops a pick that is not sent there.
watch([endpoint, listed], () => {
  const picked = r.value.credentialId;
  if (typeof picked === 'number' && listed.value && !savedKeys.value.some((c) => c.id === picked)) {
    r.value.credentialId = undefined;
  }
});
const savedKeyItems = computed(() =>
  savedKeys.value.map((c) => ({ label: c.disabled ? `${c.name} (disabled)` : c.name, value: c.id })),
);
/** The credential the role names now: the one picked, else the stored one. */
const namedId = computed(() =>
  r.value.credentialId !== undefined ? r.value.credentialId : stored.value?.credentialId,
);
const namedName = computed(
  () => ((listed.value?.credentials ?? []) as CredentialSummary[]).find((c) => c.id === namedId.value)?.name ?? null,
);
const pickedKey = computed({
  get: () => namedId.value ?? undefined,
  set: (id: number | undefined) => {
    r.value.credentialId = id ?? null;
    r.value.apiKey = '';
    replacingKey.value = false;
  },
});
</script>

<template>
  <div class="space-y-4 rounded-lg border border-default bg-elevated/25 p-4">
    <p class="flex items-center gap-2 text-sm font-semibold text-highlighted">
      {{ title }}
    </p>

    <div class="grid max-w-xl gap-4">
      <AiCliStatus v-if="cliProvider" :provider="cliProvider" />

      <SettingsField
        v-if="hasKeyField || (env && !isCli)"
        label="API key"
        :env-managed="env"
        :env-vars="envVar('API_KEY')"
        :description="tile?.key === 'optional' || tile?.key === 'none' ? 'Only if the server asks for one.' : undefined"
      >
        <p v-if="env" class="text-sm text-muted">Set on the server.</p>
        <div v-else-if="!form.canStoreSecrets.value" class="space-y-2">
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-key-round"
            title="This server cannot store keys yet"
            data-testid="ai-no-secret-key"
          >
            <template #description>
              Keys are encrypted with <code class="font-mono text-xs">PIWI_SECRET_KEY</code>, which is not set. Generate
              one, set it on the server, then restart. Ollama, LM Studio and the command-line tools need no key.
            </template>
          </UAlert>
          <CodeBlock :code="secretKeyCommand" lang="bash" />
        </div>
        <div v-else-if="keyStored && !replacingKey" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="flex items-center gap-1.5 text-sm text-highlighted">
            <template v-if="namedName">The key is saved in “{{ namedName }}”.</template>
            <template v-else>A key is stored, encrypted.</template>
          </span>
          <UButton color="neutral" variant="link" size="sm" class="px-0" @click="replacingKey = true">Replace</UButton>
        </div>
        <div v-else class="space-y-1">
          <UInput
            v-model="r.apiKey"
            :type="showKey ? 'text' : 'password'"
            :placeholder="tile?.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'"
            autocomplete="off"
            class="w-full font-mono"
            :ui="{ trailing: 'pe-1' }"
          >
            <template #trailing>
              <UButton
                color="neutral"
                variant="link"
                size="sm"
                :icon="showKey ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                :aria-label="showKey ? 'Hide key' : 'Show key'"
                @click="showKey = !showKey"
              />
            </template>
          </UInput>
          <p v-if="keyStored" class="text-xs text-muted">
            The stored key stays until you save a new one.
            <button
              type="button"
              class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
              @click="
                replacingKey = false;
                r.apiKey = '';
              "
            >
              Keep the stored key
            </button>
          </p>
          <p v-else-if="keyNeedsReentry" class="text-xs text-muted">
            A saved key is only sent to the provider and address it was saved for: enter it again.
          </p>
          <p v-else-if="tile?.hint && tile.key === 'required'" class="text-xs text-muted">{{ tile.hint }}</p>
        </div>
      </SettingsField>
      <div v-else-if="tile?.key === 'none' && !isCli && !env">
        <UButton color="neutral" variant="link" size="sm" class="px-0" @click="addingKey = true">
          Add an API key
        </UButton>
      </div>

      <SettingsField
        v-if="!env && !isCli && savedKeyItems.length > 0"
        label="Saved key"
        description="A key saved under Settings → Credentials, sent to this provider's address. A key typed above replaces the one the role names."
      >
        <USelect
          v-model="pickedKey"
          :items="savedKeyItems"
          placeholder="Pick a saved key"
          aria-label="Saved AI key"
          class="w-full sm:max-w-sm"
          data-testid="ai-saved-key"
        />
      </SettingsField>

      <SettingsField
        v-if="r.provider === 'openai' || (env && !isCli && r.baseUrl)"
        label="Server address"
        :env-managed="env"
        :env-vars="envVar('BASE_URL')"
      >
        <p v-if="env" class="text-sm text-muted">Set on the server.</p>
        <div v-else-if="urlFixed" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <code class="font-mono text-xs text-highlighted">{{ r.baseUrl }}</code>
          <UButton color="neutral" variant="link" size="sm" class="px-0" @click="editingUrl = true">Change</UButton>
        </div>
        <div v-else class="space-y-1">
          <UInput
            v-model="r.baseUrl"
            :placeholder="tile?.baseUrl || 'https://llm.example.com/v1'"
            class="w-full font-mono"
            spellcheck="false"
          />
          <p class="text-xs text-muted">
            {{ tile?.group === 'cloud' ? 'Change it only to go through a proxy or a gateway.' : tile?.hint }}
          </p>
        </div>
      </SettingsField>

      <SettingsField label="Model" :description="isCli ? 'Blank uses the tool\'s default model.' : undefined">
        <ModelFieldInput
          v-model="r.model"
          :provider-resolved="r.provider"
          :models="form.models[role]"
          :loading-models="form.loadingModels[role]"
          :placeholder-anthropic="placeholder"
          :placeholder-openai="placeholder"
          @load-models="form.loadModels(role)"
        />
      </SettingsField>

      <details v-if="r.provider === 'openai' && purpose !== 'embed'" class="group text-sm">
        <summary
          class="inline-flex cursor-pointer list-none items-center gap-1 text-muted outline-none hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden"
        >
          <UIcon name="i-lucide-chevron-right" class="size-4 transition-transform group-open:rotate-90" />
          Advanced
        </summary>
        <SettingsField
          class="mt-3"
          label="Temperature"
          description="Blank uses the model's default. Reasoning models (o1, o3, GPT-5 class) accept no other value."
        >
          <UInput
            :model-value="String(r.temperature ?? '')"
            type="number"
            step="0.1"
            min="0"
            max="2"
            placeholder="Model default"
            @update:model-value="(value: string | number) => (r.temperature = value ?? '')"
            class="w-40"
          />
        </SettingsField>
      </details>

      <AiTestButton :role="role" />
    </div>
  </div>
</template>

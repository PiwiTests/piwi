<script setup lang="ts">
/**
 * One model-role editor (diagnosis / research / embedding) for Settings → AI.
 * Rendered once per role; each instance owns its own scope and generated field
 * ids, so the three cards never collide. State is the shared reactive role form,
 * bound via v-model.
 */
import type { AiModelRole, ModelInfo } from '~~/types/api';
import type { HelpTopicKey } from '~/utils/help-content';
import { helpEnvVars } from '~/utils/help-content';
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';
import type { RoleForm } from '~/utils/ai-settings-form';

interface RoleMeta {
  key: AiModelRole;
  title: string;
  icon: string;
  help: HelpTopicKey;
  optional: boolean;
  enableLabel: string;
  blurb: string;
  /** Optional standing explanation shown when the role is expanded (e.g. why embeddings are OpenAI-only). */
  note?: string;
  reuseTargets: readonly AiModelRole[];
  modelPlaceholderAnthropic: string;
  modelPlaceholderOpenai: string;
}

const props = defineProps<{
  meta: RoleMeta;
  hasApiKey: boolean;
  /** False when the server has no `PIWI_SECRET_KEY`, so an API key cannot be stored. */
  canStoreSecrets: boolean;
  reuseOptions: Array<{ label: string; value: string }>;
  providerOptions: Array<{ label: string; value: string }>;
  presetOptions: Array<{ label: string; value: string }>;
  disabled: boolean;
  envManaged: boolean;
  models: ModelInfo[];
  loadingModels: boolean;
  providerResolved: string;
  testing: boolean;
}>();

const emit = defineEmits<{ applyPreset: [label: string]; loadModels: []; test: [] }>();

const model = defineModel<RoleForm>({ required: true });

// 'own' sentinel ↔ null (configure own provider). Proxied so the <USelect> can
// use a plain v-model with non-empty option values.
const reuseModel = computed<string>({
  get: () => model.value.reuse ?? 'own',
  set: (v) => (model.value.reuse = v === 'own' ? null : (v as AiModelRole)),
});

// Env vars backing this role's provider/key/baseUrl (resolved from the help
// topic), shown as lock badges when the form is env-managed.
const roleEnvVars = computed<PiwiEnvVarName[]>(() => helpEnvVars(props.meta.help));
</script>

<template>
  <div
    class="rounded-lg border border-default p-4 space-y-4"
    :class="meta.optional && !model.enabled ? 'opacity-80' : ''"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-start gap-2">
        <UIcon :name="meta.icon" class="size-5 mt-0.5 text-primary" />
        <div>
          <p class="font-medium inline-flex items-center gap-1">{{ meta.title }} <HelpHint :topic="meta.help" /></p>
          <p class="text-sm text-gray-500">{{ meta.blurb }}</p>
        </div>
      </div>
      <USwitch
        v-if="meta.optional"
        v-model="model.enabled"
        :disabled="disabled && !envManaged"
        :aria-label="meta.enableLabel"
      />
    </div>

    <template v-if="!meta.optional || model.enabled">
      <div v-if="meta.note" class="flex items-start gap-2 rounded-md bg-elevated/50 px-3 py-2 text-sm text-muted">
        <UIcon name="i-lucide-info" class="size-4 mt-0.5 shrink-0 text-primary" />
        <span>{{ meta.note }}</span>
      </div>

      <UFormField v-if="meta.reuseTargets.length" label="Provider source">
        <USelect v-model="reuseModel" :items="reuseOptions" :disabled="disabled && !envManaged" class="w-full" />
      </UFormField>

      <template v-if="!model.reuse">
        <UFormField label="Provider">
          <template #label>
            <span class="inline-flex items-center gap-1">
              Provider
              <EnvManagedBadge v-if="disabled" :env-vars="roleEnvVars" />
            </span>
          </template>
          <USelect
            v-model="model.provider"
            :items="providerOptions"
            :disabled="disabled"
            placeholder="Choose a provider…"
            class="w-full"
          />
        </UFormField>

        <div
          v-if="model.provider === 'claude-cli' || model.provider === 'codex-cli'"
          class="flex items-start gap-2 rounded-md bg-elevated/50 px-3 py-2 text-sm text-muted"
        >
          <UIcon name="i-lucide-terminal" class="size-4 mt-0.5 shrink-0 text-primary" />
          <span>
            Runs the local
            <code class="font-mono">{{ model.provider === 'codex-cli' ? 'codex' : 'claude' }}</code> command, so it uses
            your {{ model.provider === 'codex-cli' ? 'ChatGPT' : 'Claude Code' }} sign-in — no API key to enter. Sign-in
            status and usage are managed at the top of this section.
          </span>
        </div>

        <UFormField
          v-if="model.provider === 'openai'"
          label="Preset"
          description="Pick a known provider to auto-fill the URL and model, then adjust as needed"
        >
          <USelect
            :items="presetOptions"
            placeholder="Choose a preset…"
            :disabled="disabled"
            class="w-full"
            @update:model-value="(v: string) => emit('applyPreset', v)"
          />
        </UFormField>

        <UFormField
          v-if="model.provider && model.provider !== 'claude-cli' && model.provider !== 'codex-cli'"
          label="API key"
          :description="
            !canStoreSecrets && !disabled
              ? 'Needs PIWI_SECRET_KEY set on the server to be stored'
              : hasApiKey
                ? 'Leave empty to keep the stored key, or enter a new value to replace it'
                : 'Required for Anthropic; optional for local OpenAI-compatible servers'
          "
        >
          <template #label>
            <span class="inline-flex items-center gap-1">
              API key
              <EnvManagedBadge v-if="disabled" :env-vars="roleEnvVars" />
            </span>
          </template>
          <UInput
            v-model="model.apiKey"
            type="password"
            :placeholder="hasApiKey ? '•••••••• (unchanged)' : 'sk-…'"
            :disabled="disabled || !canStoreSecrets"
            class="w-full font-mono"
          />
        </UFormField>

        <UFormField
          v-if="model.provider === 'openai'"
          label="Base URL"
          description="Required, e.g. http://localhost:11434/v1"
        >
          <template #label>
            <span class="inline-flex items-center gap-1">
              Base URL
              <EnvManagedBadge v-if="disabled" :env-vars="roleEnvVars" />
            </span>
          </template>
          <UInput v-model="model.baseUrl" placeholder="http://localhost:11434/v1" :disabled="disabled" class="w-full" />
        </UFormField>

        <UFormField
          v-if="model.provider === 'openai'"
          label="Temperature"
          description="Leave blank to use the model's default. Reasoning models (o1, o3, GPT-5-class) reject any explicit value and must be left blank."
        >
          <template #label>
            <span class="inline-flex items-center gap-1">
              Temperature
              <EnvManagedBadge v-if="disabled" :env-vars="roleEnvVars" />
            </span>
          </template>
          <UInput
            v-model="model.temperature"
            type="number"
            step="0.1"
            min="0"
            max="2"
            placeholder="Default"
            :disabled="disabled"
            class="w-full"
          />
        </UFormField>
      </template>

      <UFormField
        v-if="model.reuse || model.provider"
        label="Model"
        :description="model.reuse ? 'Leave empty to use the reused role\'s model' : undefined"
      >
        <ModelFieldInput
          v-model="model.model"
          :provider-resolved="providerResolved"
          :models="models"
          :loading-models="loadingModels"
          :placeholder-anthropic="meta.modelPlaceholderAnthropic"
          :placeholder-openai="meta.modelPlaceholderOpenai"
          @load-models="emit('loadModels')"
        />
      </UFormField>

      <div v-if="providerResolved" class="flex justify-end">
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-lucide-plug"
          :loading="testing"
          data-tour="test-ai-connection"
          @click="emit('test')"
        >
          Test connection
        </UButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The model of an optional AI feature in Settings → AI (two-stage diagnosis,
 * semantic clustering, the assistant): on the diagnosis provider with a model
 * of its own, or on another provider. Semantic clustering needs a provider
 * with an embeddings API, so it offers only those tiles.
 */
import type { ProviderTileId } from '~/utils/ai-provider-catalog';
import { providerLabel, suggestedModel } from '~/utils/ai-provider-catalog';
import { SEGMENTED_SELECTED_CLASS } from '~/utils';
import { FEATURE_LABEL, ROLE_PURPOSE, type OptionalAiRole, type RoleSource } from '~/composables/useAiSettingsForm';

const props = defineProps<{ role: OptionalAiRole }>();

const form = useAiSettingsForm();
const r = computed(() => form.roles[props.role]);
const purpose = computed(() => ROLE_PURPOSE[props.role]);
const source = computed(() => form.roleSource(props.role));
const env = computed(() => form.envManaged.value);

const mainLabel = computed(() => providerLabel(form.roles.diagnosis.provider, form.roles.diagnosis.baseUrl));
const sameAllowed = computed(() => props.role !== 'embedding' || form.mainHasEmbeddings.value);

const options = computed(() => {
  const out: { value: RoleSource; label: string; detail?: string; disabled?: boolean }[] = [
    { value: 'diagnosis', label: 'Same provider', detail: mainLabel.value, disabled: !sameAllowed.value },
  ];
  // Kept for a stored config that reuses the research provider; not offered otherwise.
  if (props.role !== 'research' && source.value === 'research') {
    out.push({ value: 'research', label: 'Same as two-stage diagnosis' });
  }
  out.push({ value: 'own', label: 'Another provider' });
  return out;
});

const tile = computed<ProviderTileId | null>({
  get: () => r.value.tile,
  set: (id) => {
    if (id) form.pickTile(props.role, id);
  },
});

const suggestion = computed(() => suggestedModel(form.roles[form.sourceRole(props.role)].tile, purpose.value));
const placeholder = computed(() => (suggestion.value ? `e.g. ${suggestion.value}` : 'Model ID'));
</script>

<template>
  <div class="space-y-4 rounded-lg border border-default p-4">
    <p v-if="env" class="text-sm text-muted">
      Runs on the provider the server sets for {{ FEATURE_LABEL[role].toLowerCase() }}, or on the main one when it sets
      none.
    </p>
    <template v-else>
      <div
        role="radiogroup"
        :aria-label="`Provider for ${FEATURE_LABEL[role].toLowerCase()}`"
        class="inline-flex max-w-full flex-wrap gap-0.5 rounded-md bg-elevated/60 p-0.5"
      >
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="source === option.value ? 'true' : 'false'"
          :disabled="option.disabled"
          class="rounded px-2.5 py-1 text-sm whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          :class="source === option.value ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
          @click="form.setSource(role, option.value)"
        >
          {{ option.label }}<span v-if="option.detail" class="text-muted"> · {{ option.detail }}</span>
        </button>
      </div>
      <UAlert
        v-if="!sameAllowed"
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        :description="`${mainLabel} has no embeddings API, so semantic clustering needs a provider of its own. Ollama runs nomic-embed-text on your own machine, with no key.`"
      />
    </template>

    <template v-if="source !== 'own' || env">
      <SettingsField label="Model" class="max-w-xl">
        <ModelFieldInput
          v-model="r.model"
          :provider-resolved="form.resolvedProvider(role)"
          :models="form.models[role]"
          :loading-models="form.loadingModels[role]"
          :placeholder-anthropic="placeholder"
          :placeholder-openai="placeholder"
          @load-models="form.loadModels(role)"
        />
        <p v-if="suggestion && r.model !== suggestion" class="mt-1 text-xs text-muted">
          Suggested:
          <button
            type="button"
            class="font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid"
            @click="r.model = suggestion"
          >
            {{ suggestion }}</button
          >{{ purpose === 'fast' ? ', faster and cheaper' : '' }}
        </p>
      </SettingsField>
      <AiTestButton :role="role" label="Test this model" />
    </template>
    <template v-else>
      <AiProviderPicker
        v-model="tile"
        :purpose="purpose"
        :label="`Provider for ${FEATURE_LABEL[role].toLowerCase()}`"
        compact
      />
      <AiConnectionFields v-if="r.provider" :role="role" />
    </template>
  </div>
</template>

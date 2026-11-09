<script setup lang="ts">
import type { AiSettings } from '~~/types/api';
import type { ProviderTileId } from '~/utils/ai-provider-catalog';
import { providerLabel } from '~/utils/ai-provider-catalog';
import { AI_SETTINGS_FORM, createAiSettingsForm, type ContextLimitsResponse } from '~/composables/useAiSettingsForm';

const { data: settings, refresh: refreshSettings } = await useFetch<AiSettings>('/api/settings/ai');
const { data: limitsData } = await useFetch<ContextLimitsResponse>('/api/settings/ai/limits');

const form = createAiSettingsForm(settings, limitsData, async () => {
  await refreshSettings();
});
provide(AI_SETTINGS_FORM, form);

const mainTile = computed<ProviderTileId | null>({
  get: () => form.roles.diagnosis.tile,
  set: (id) => {
    if (id) form.pickTile('diagnosis', id);
  },
});
const envProvider = computed(() => providerLabel(form.roles.diagnosis.provider, form.roles.diagnosis.baseUrl));
</script>

<template>
  <CapabilityDeclinedGuard capability="ai" label="AI diagnosis">
    <div class="space-y-6" data-tour="ai-page">
      <EnvManagedAlert
        v-if="form.envManaged.value"
        title="Provider set by environment variables"
        description="PIWI_AI_PROVIDER is set on the server, so the providers, keys and addresses are read-only here. Models, features and everything below still save from this page."
      />

      <AiStatusSummary />

      <SectionCard
        icon="i-lucide-cloud"
        title="Provider"
        help="settings.ai-provider"
        subtitle="The service that runs the model. Piwi sends it the evidence of each failure it diagnoses."
        data-tour="ai-model-providers"
        data-shot="ai-model-providers"
      >
        <template v-if="!form.envManaged.value && form.settings.value?.roles.diagnosis" #actions>
          <UButton color="neutral" variant="ghost" size="sm" @click="form.turnOff()">Turn AI off</UButton>
        </template>
        <div class="space-y-5">
          <p v-if="form.envManaged.value" class="flex items-center gap-1.5 text-sm text-highlighted">
            Set on the server: <span class="font-semibold">{{ envProvider }}</span>
            <EnvManagedBadge :env-vars="['PIWI_AI_PROVIDER']" />
          </p>
          <AiProviderPicker v-else v-model="mainTile" purpose="main" label="Provider" />
          <AiConnectionFields v-if="form.roles.diagnosis.provider" role="diagnosis" data-tour="ai-diagnosis-model" />
        </div>
      </SectionCard>

      <AiFeaturesCard />
      <AiWritingCard />
      <AiDataSentCard />
      <AiSaveBar />
      <AiUsagePanel />
    </div>
  </CapabilityDeclinedGuard>
</template>

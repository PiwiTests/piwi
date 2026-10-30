<script setup lang="ts">
/**
 * The Features card of Settings → AI: what the AI does with the provider,
 * feature by feature. Failure diagnosis runs on the provider itself;
 * two-stage diagnosis, semantic clustering and the assistant each run on it
 * with a model of their own, or on another provider.
 */
import { isLocalCliProvider, providerLabel } from '~/utils/ai-provider-catalog';
import { SEGMENTED_SELECTED_CLASS } from '~/utils';

const form = useAiSettingsForm();
const roles = form.roles;
const configured = computed(() => form.mainConfigured.value);
const mainLabel = computed(() => providerLabel(roles.diagnosis.provider, roles.diagnosis.baseUrl));

const {
  permission: notifPermission,
  supported: notifSupported,
  active: notifActive,
  requestPermission: requestNotifPermission,
  toggleEnabled: toggleNotifEnabled,
} = useDiagnosisNotification();

/** The local CLI the assistant answers through, if any: it then runs inside it, with Piwi's tools only. */
const assistantCli = computed(() => {
  const provider = form.resolvedProvider(roles.assistant.enabled ? 'assistant' : 'diagnosis');
  return isLocalCliProvider(provider) ? provider : null;
});
const assistantCliLabel = computed(() => (assistantCli.value ? providerLabel(assistantCli.value) : ''));
</script>

<template>
  <SectionCard
    icon="i-lucide-zap"
    title="Features"
    subtitle="What the AI does. Each feature uses your provider unless you choose another."
    data-tour="ai-features"
  >
    <p v-if="!configured" class="mb-4 text-sm text-muted">
      Choose a provider first: these features turn on once it is set.
    </p>

    <div class="divide-y divide-default">
      <AiFeatureRow
        title="Failure diagnosis"
        description="Explains why a failure cluster fails and proposes a fix. Run it from any failure cluster."
      >
        <template #control>
          <span class="text-xs text-muted">{{ configured ? 'On' : 'Off' }}</span>
        </template>
        <p v-if="configured" class="text-xs text-muted">
          <template v-if="roles.diagnosis.model">
            Model <code class="font-mono">{{ roles.diagnosis.model }}</code> from {{ mainLabel }}, set above.
          </template>
          <template v-else>The default model of {{ mainLabel }}, set above.</template>
        </p>
        <SettingsField
          label="Auto-diagnose"
          help="settings.auto-diagnose"
          :env-managed="form.envManaged.value"
          data-tour="ai-auto-diagnose"
        >
          <div class="flex items-start gap-3">
            <USwitch
              v-model="form.autoDiagnose.value"
              :disabled="form.envManaged.value || !configured"
              aria-label="Auto-diagnose"
            />
            <span class="text-sm text-muted">
              When a run finishes, diagnose up to 3 of its new failure clusters and title them. Each diagnosis takes one
              or two model calls.
            </span>
          </div>
        </SettingsField>
        <SettingsField
          label="Diagnosis notifications"
          help="settings.ai-notifications"
          data-tour="ai-diagnosis-notifications"
        >
          <ClientOnly>
            <div class="flex items-start gap-3">
              <span v-if="!notifSupported" class="text-sm text-muted"
                >This browser does not support notifications.</span
              >
              <span v-else-if="notifPermission === 'denied'" class="text-sm text-muted">
                Notifications are blocked in your browser settings.
              </span>
              <template v-else-if="notifPermission === 'default'">
                <UButton
                  size="sm"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-bell"
                  @click="requestNotifPermission"
                >
                  Enable notifications
                </UButton>
                <span class="text-sm text-muted">A browser notification when a diagnosis finishes.</span>
              </template>
              <template v-else>
                <USwitch
                  :model-value="notifActive"
                  aria-label="Diagnosis notifications"
                  @update:model-value="toggleNotifEnabled"
                />
                <span class="text-sm text-muted">
                  A browser notification when a diagnosis finishes. Applies right away, to this browser only.
                </span>
              </template>
            </div>
          </ClientOnly>
        </SettingsField>
      </AiFeatureRow>

      <AiFeatureRow
        title="Two-stage diagnosis"
        help="settings.ai-research"
        description="A faster, cheaper model reads the evidence first, then the diagnosis model writes the answer. It also names failure clusters."
        data-tour="ai-research-model"
      >
        <template #control>
          <USwitch
            :model-value="roles.research.enabled"
            :disabled="!configured"
            aria-label="Two-stage diagnosis"
            @update:model-value="(on: boolean) => form.setFeature('research', on)"
          />
        </template>
        <AiSecondaryModel v-if="roles.research.enabled && configured" role="research" />
      </AiFeatureRow>

      <AiFeatureRow
        title="Semantic clustering"
        help="settings.embedding-model"
        description="Groups failures whose errors mean the same thing, even when their text differs. Needs a model that produces embeddings."
        data-tour="ai-embedding-model"
      >
        <template #control>
          <USwitch
            :model-value="roles.embedding.enabled"
            :disabled="!configured"
            aria-label="Semantic clustering"
            @update:model-value="(on: boolean) => form.setFeature('embedding', on)"
          />
        </template>
        <AiSecondaryModel v-if="roles.embedding.enabled && configured" role="embedding" />
      </AiFeatureRow>

      <AiFeatureRow
        title="Assistant"
        help="settings.ai-assistant"
        description="Ask Piwi, the in-app assistant: it answers questions about your runs, failures and tests."
        data-tour="ai-assistant-model"
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span id="ai-assistant-answers-with" class="text-xs text-muted">Answers with</span>
          <div
            role="radiogroup"
            aria-labelledby="ai-assistant-answers-with"
            class="inline-flex max-w-full flex-wrap gap-0.5 rounded-md bg-elevated/60 p-0.5"
          >
            <button
              v-for="option in [
                { on: false, label: 'The diagnosis model' },
                { on: true, label: 'A different model' },
              ]"
              :key="option.label"
              type="button"
              role="radio"
              :aria-checked="roles.assistant.enabled === option.on ? 'true' : 'false'"
              :disabled="!configured"
              class="rounded px-2.5 py-1 text-sm whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              :class="
                roles.assistant.enabled === option.on ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'
              "
              @click="form.setFeature('assistant', option.on)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <AiSecondaryModel v-if="roles.assistant.enabled && configured" role="assistant" />
        <p v-if="assistantCli" class="text-xs text-muted">
          The assistant runs inside {{ assistantCliLabel }}, with Piwi's tools only, none of its own.
          <template v-if="assistantCli === 'claude-cli'">
            The usage limit of your Claude subscription shows in the assistant panel.
          </template>
        </p>
      </AiFeatureRow>
    </div>
  </SectionCard>
</template>

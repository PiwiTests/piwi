<script setup lang="ts">
/**
 * How the AI writes, instance-wide, in Settings → AI: the response language
 * and the global analysis instructions. A project overrides the language and
 * adds its own instructions in its settings.
 */
const form = useAiSettingsForm();

const LANGUAGES = ['French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Dutch', 'Japanese', 'Chinese', 'Korean'];
</script>

<template>
  <SectionCard
    icon="i-lucide-languages"
    title="How the AI writes"
    subtitle="For every project. A project can override the language and add its own instructions in its settings."
  >
    <div class="space-y-5">
      <SettingsField
        label="Response language"
        :env-managed="form.languageEnvManaged.value"
        :env-vars="['PIWI_AI_LANGUAGE']"
        description="Diagnoses, root causes and cluster titles are written in this language. Code, locators, file paths and error text stay as they are."
        data-tour="ai-response-language"
      >
        <UInput
          v-model="form.language.value"
          list="ai-response-languages"
          placeholder="English"
          autocomplete="off"
          class="w-full sm:max-w-xs"
        />
        <datalist id="ai-response-languages">
          <option v-for="language in LANGUAGES" :key="language" :value="language" />
        </datalist>
      </SettingsField>

      <SettingsField
        label="Global analysis instructions"
        help="settings.ai-instructions"
        description="Added to the prompt of every diagnosis. They shape the analysis, but cannot change the answer format or the confidence rule."
        data-tour="ai-instructions"
      >
        <UTextarea
          v-model="form.instructions.value"
          :rows="5"
          placeholder="e.g. Always suggest running failing tests with --repeat-each 5 to confirm flakiness. Prefer network evidence over ARIA snapshots."
          class="w-full font-mono text-sm"
        />
      </SettingsField>
    </div>
  </SectionCard>
</template>

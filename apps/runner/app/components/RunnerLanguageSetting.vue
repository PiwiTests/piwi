<script setup lang="ts">
/**
 * The language of Piwi Runner's own texts: the system's until the person chooses one, each language by its own name.
 * The shell saves the choice and says the tray, its questions and this window in it. While a draft translation is on
 * screen, a line says so and links to the form for a correction.
 */
import {
  RUNNER_LANGUAGES,
  RUNNER_TRANSLATION_ISSUE_URL,
  isDraftRunnerLanguage,
  runnerLanguageName,
  type RunnerLanguage,
} from '~/utils/runner-language';

const SYSTEM = 'system';

const { t } = useRunnerWords();
const { info, choose } = useRunnerLanguage();
const toast = useToast();
const saving = ref(false);

const items = computed(() => [
  { label: t('runner_languageSystem', { language: runnerLanguageName(info.value.system) }), value: SYSTEM },
  ...RUNNER_LANGUAGES.map((language) => ({ label: runnerLanguageName(language.code), value: language.code })),
]);
const selected = computed(() => info.value.chosen ?? SYSTEM);
const draft = computed(() => isDraftRunnerLanguage(info.value.language));

async function pick(value: string) {
  if (saving.value || value === selected.value) return;
  saving.value = true;
  try {
    await choose(value === SYSTEM ? null : (value as RunnerLanguage));
  } catch (error) {
    toast.add({
      title: t('runner_languageFailed'),
      description: error instanceof Error ? error.message : String(error),
      color: 'error',
    });
  } finally {
    saving.value = false;
  }
}

function suggestCorrection() {
  tauriCore()
    ?.invoke('desktop_open_external', { url: RUNNER_TRANSLATION_ISSUE_URL })
    .catch(() => {});
}
</script>

<template>
  <UCard v-if="tauriCore()" data-testid="runner-language">
    <template #header>
      <h2 class="text-sm font-semibold">{{ t('runner_languageHeading') }}</h2>
    </template>
    <div class="space-y-2">
      <USelect
        :model-value="selected"
        :items="items"
        :disabled="saving"
        :aria-label="t('runner_languageHeading')"
        class="w-full sm:w-72"
        @update:model-value="pick(String($event))"
      />
      <p class="text-xs text-muted">{{ t('runner_languageHint') }}</p>
      <p v-if="draft" class="text-xs text-muted" data-testid="runner-language-draft">
        {{ `${t('runner_languageDraft')} ` }}
        <ULink as="button" class="text-xs underline" @click="suggestCorrection">{{
          t('runner_languageDraftLink')
        }}</ULink>
      </p>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import { de, en, es, fr, pt_br } from '@nuxt/ui/locale';

/**
 * Piwi Runner's window: connect to a team instance, link folders, confirm the run requests it sends, and watch the
 * runs. It holds no project data and no account; the shell keeps the instance's key in the OS keychain.
 */
const { listen, startRequest } = useRunnerRuns();
const words = useRunUiWords();
const { t } = useRunnerWords();
const { info } = useRunnerLanguage();

/** Nuxt UI's own texts (a close button's label) in the language on screen. */
const UI_LOCALES = { en, fr, de, es, pt_BR: pt_br };
const uiLocale = computed(() => UI_LOCALES[info.value.language]);
useHead({ htmlAttrs: { lang: () => runnerLanguageTag(info.value.language) } });

onMounted(() => {
  void listen();
});
</script>

<template>
  <UApp :locale="uiLocale">
    <main class="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 class="text-xl font-semibold">Piwi Runner</h1>
        <p class="text-sm text-muted">{{ t('runner_tagline') }}</p>
      </header>
      <UCard data-testid="runner-connection">
        <template #header>
          <h2 class="text-sm font-semibold">{{ t('runner_connectionHeading') }}</h2>
          <p class="text-xs text-muted">{{ connectionIntro(words) }}</p>
        </template>
        <DesktopTeamInstance app-name="Piwi Runner" />
      </UCard>
      <RunnerRunList />
      <RunnerBackgroundSettings />
      <RunnerLanguageSetting />
    </main>
    <DesktopTeamRunRequestModal @start="startRequest" />
  </UApp>
</template>

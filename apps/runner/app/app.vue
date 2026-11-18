<script setup lang="ts">
import type { HubSession } from '@piwitests/core/run-hub';
import { de, en, es, fr, pt_br } from '@nuxt/ui/locale';

/**
 * Piwi Runner's window: connect to a team instance, link folders, confirm the run requests it sends, and watch the
 * runs. It holds no project data and no account; the shell keeps the instance's key in the OS keychain.
 *
 * Two views under the header (`RunnerHeader`): the runs, with the welcome and its connection card in their place
 * while the window is not connected, and the settings (the connection, the background, the language, About). The runs
 * stay drawn while the settings show, so a run's card keeps what it had open, and a confirmed request brings the runs
 * back.
 */
const { runs, listen, startRequest } = useRunnerRuns();
const { connection } = useDesktopTeamRequests();
const hub = useDesktopRunHub();
const words = useRunUiWords();
const { t } = useRunnerWords();
const { info } = useRunnerLanguage();

/** Nuxt UI's own texts (a close button's label) in the language on screen. */
const UI_LOCALES = { en, fr, de, es, pt_BR: pt_br };
const uiLocale = computed(() => UI_LOCALES[info.value.language]);
useHead({ htmlAttrs: { lang: () => runnerLanguageTag(info.value.language) } });

/** The view on screen: `runs` or `settings`. */
const view = ref('runs');
const connected = computed(() => ['connecting', 'online', 'offline'].includes(connection.value.state));
/** Whether there is a run to show: one of this window's, or one the hub still has. */
const anyRun = computed(
  () => runs.value.length > 0 || (Object.values(hub.state.sessions) as HubSession[]).some((s) => !s.ended),
);

function start(run: Parameters<typeof startRequest>[0]) {
  view.value = 'runs';
  void startRequest(run);
}

onMounted(() => {
  void listen();
});
</script>

<template>
  <UApp :locale="uiLocale">
    <RunnerHeader v-model:view="view" />
    <main class="mx-auto max-w-3xl p-4 sm:p-6">
      <div v-show="view === 'runs'" class="space-y-8">
        <RunnerWelcome v-if="!connected" />
        <RunnerRunList v-if="connected || anyRun" />
      </div>
      <div v-if="view === 'settings'" class="space-y-4" data-testid="runner-settings">
        <RunnerSection
          icon="i-lucide-monitor-play"
          :title="t('runner_connectionHeading')"
          :description="connectionIntro(words)"
          data-testid="runner-connection"
        >
          <DesktopTeamInstance app-name="Piwi Runner" />
        </RunnerSection>
        <RunnerBackgroundSettings />
        <RunnerLanguageSetting />
        <RunnerAbout />
      </div>
    </main>
    <DesktopTeamRunRequestModal @start="start" />
  </UApp>
</template>

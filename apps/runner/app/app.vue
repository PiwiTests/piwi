<script setup lang="ts">
import type { HubSession } from '@piwitests/core/run-hub';
import { de, en, es, fr, pt_br } from '@nuxt/ui/locale';

/**
 * Piwi Runner's window: connect to a team instance, link folders, confirm the run requests it sends, and watch the
 * runs. It holds no project data and no account; the shell keeps the instance's key in the OS keychain.
 *
 * Two views under the header (`RunnerHeader`): the runs, with the welcome in their place while the window is not
 * connected, and the settings, a section at a time (`RunnerSettings`). The runs stay drawn while the settings show, so
 * a run keeps what it had open; each view comes back where it was scrolled, and a confirmed request brings the runs
 * back.
 */
const { runs, listen, startRequest } = useRunnerRuns();
const { connection, connected, loadConnection, loadFolders } = useDesktopTeamConnection();
const hub = useDesktopRunHub();
const { info } = useRunnerLanguage();

/** Nuxt UI's own texts (a close button's label) in the language on screen. */
const UI_LOCALES = { en, fr, de, es, pt_BR: pt_br };
const uiLocale = computed(() => UI_LOCALES[info.value.language]);
useHead({ htmlAttrs: { lang: () => runnerLanguageTag(info.value.language) } });

/** The view on screen, `runs` or `settings`, and the section of the settings. */
const view = ref('runs');
const section = ref('connection');
/** Whether there is a run to show: one of this window's, or one the hub still has. */
const anyRun = computed(
  () => runs.value.length > 0 || (Object.values(hub.state.sessions) as HubSession[]).some((s) => !s.ended),
);

/** Where each view was scrolled, to come back there. */
const scrolled: Record<string, number> = {};
watch(view, async (next, previous) => {
  scrolled[previous] = window.scrollY;
  await nextTick();
  window.scrollTo({ top: scrolled[next] ?? 0 });
});

function openConnection() {
  section.value = 'connection';
  view.value = 'settings';
}

function start(run: Parameters<typeof startRequest>[0]) {
  view.value = 'runs';
  void startRequest(run);
}

// The linked folders, for every view that shows them: read again as the connection or its projects change.
watch(() => [connection.value.state, connection.value.linkedProjectIds.join(',')], loadFolders, { immediate: true });

onMounted(() => {
  void listen();
  void loadConnection();
});
</script>

<template>
  <UApp :locale="uiLocale">
    <RunnerHeader v-model:view="view" @connection="openConnection" />
    <main class="mx-auto max-w-3xl p-4 sm:p-6">
      <div v-show="view === 'runs'" class="space-y-8">
        <RunnerWelcome v-if="!connected" />
        <RunnerRunList v-if="connected || anyRun" />
      </div>
      <RunnerSettings v-if="view === 'settings'" v-model:section="section" />
    </main>
    <DesktopTeamRunRequestModal @start="start" />
  </UApp>
</template>

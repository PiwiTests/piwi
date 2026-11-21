<script setup lang="ts">
import type { HubSession } from '@piwitests/core/run-hub';
import { de, en, es, fr, pt_br } from '@nuxt/ui/locale';

/**
 * Piwi Runner's window: connect to a team instance, link folders, confirm the run requests it sends, and watch the
 * runs. It holds no project data and no account; the shell keeps the instance's key in the OS keychain.
 *
 * Two views under the header (`RunnerHeader`), drawn once the connection is known: the runs, which fill the window
 * below it, with the welcome above them while the window is not connected, and the settings, a section at a time
 * (`RunnerSettings`). The runs stay drawn while the settings show, so the run shown and its live view go on; the
 * settings come back where they were scrolled, and a confirmed request or a stop brings the runs back.
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
/** Whether the connection is known: the host's answer or its event stream told it. */
const known = ref(false);
watch(connection, () => (known.value = true), { once: true });
/** Whether there is a run to show: one of this window's, or one the hub still has. */
const anyRun = computed(
  () => runs.value.length > 0 || (Object.values(hub.state.sessions) as HubSession[]).some((s) => !s.ended),
);

/** Where each view was scrolled, to come back there: the settings scroll the window, the runs their own panes. */
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

/** How long the keyboard waits for the confirmation to close before it goes to the runs' tab. */
const DIALOG_CLOSE_WAIT_MS = 3_000;

/**
 * Once the confirmation has closed, the keyboard goes to the runs' tab when it found nowhere to go back to: the
 * setting it came from is not drawn any more.
 */
function focusRunsOnceClosed(since = performance.now()) {
  if (document.querySelector('[role="dialog"]')) {
    if (performance.now() - since < DIALOG_CLOSE_WAIT_MS) requestAnimationFrame(() => focusRunsOnceClosed(since));
    return;
  }
  setTimeout(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    document.querySelector<HTMLElement>('[data-testid="runner-header"] [role="tab"][data-state="active"]')?.focus();
  });
}

function start(run: Parameters<typeof startRequest>[0]) {
  const fromSettings = view.value !== 'runs';
  view.value = 'runs';
  void startRequest(run);
  if (fromSettings) requestAnimationFrame(() => focusRunsOnceClosed());
}

// A stop waits for the person on the runs: the window, brought to the front, shows them.
const stopHeard = hub.onStop(() => {
  view.value = 'runs';
});
onScopeDispose(stopHeard);

// The linked folders, for every view that shows them: read again as the connection or its projects change.
watch(() => [connection.value.state, connection.value.linkedProjectIds.join(',')], loadFolders, { immediate: true });

onMounted(async () => {
  void listen();
  await loadConnection();
  known.value = true;
});
</script>

<template>
  <UApp :locale="uiLocale">
    <div :class="view === 'runs' ? 'flex h-svh flex-col' : ''">
      <RunnerHeader v-model:view="view" :known="known" @connection="openConnection" />
      <main
        v-if="known"
        :class="view === 'runs' ? 'flex min-h-0 flex-1 flex-col overflow-y-auto' : 'mx-auto max-w-3xl p-4 sm:p-6'"
      >
        <div v-show="view === 'runs'" class="flex min-h-0 flex-1 flex-col">
          <RunnerWelcome v-if="!connected" class="mx-auto w-full max-w-3xl shrink-0 p-4 sm:p-6" />
          <RunnerRunList v-if="connected || anyRun" />
        </div>
        <RunnerSettings v-if="view === 'settings'" v-model:section="section" />
      </main>
    </div>
    <DesktopTeamRunRequestModal @start="start" />
  </UApp>
</template>

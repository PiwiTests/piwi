<script setup lang="ts">
/**
 * Piwi Runner's window: connect to a team instance, link folders, confirm the run requests it sends, and watch the
 * runs. It holds no project data and no account; the shell keeps the instance's key in the OS keychain.
 */
const { listen, startRequest } = useRunnerRuns();
const words = useRunUiWords();
const { t } = useRunnerWords();

onMounted(() => {
  void listen();
});
</script>

<template>
  <UApp>
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
    </main>
    <DesktopTeamRunRequestModal @start="startRequest" />
  </UApp>
</template>

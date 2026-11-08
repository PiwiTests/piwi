<script setup lang="ts">
/**
 * Piwi Runner's window: connect to a team instance, link folders, confirm the run requests it sends, and watch the
 * runs. It holds no project data and no account; the shell keeps the instance's key in the OS keychain.
 */
const { listen, startRequest } = useRunnerRuns();

onMounted(() => {
  void listen();
});
</script>

<template>
  <UApp>
    <main class="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 class="text-xl font-semibold">Piwi Runner</h1>
        <p class="text-sm text-muted">Runs the tests a team instance asks for, on this machine.</p>
      </header>
      <UCard data-testid="runner-connection">
        <template #header>
          <h2 class="text-sm font-semibold">Run on my machine</h2>
          <p class="text-xs text-muted">{{ CONNECTION_INTRO }}</p>
        </template>
        <DesktopTeamInstance />
      </UCard>
      <RunnerRunList />
    </main>
    <DesktopTeamRunRequestModal @start="startRequest" />
  </UApp>
</template>

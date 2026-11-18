<script setup lang="ts">
/**
 * The window while it is not connected: Piwi Runner's mark and what it does, the instance's address to connect to (or
 * the code to allow it there, while the sign-in waits), and the three steps from a test on the instance to its run
 * here.
 */
const words = useRunUiWords();
const { t } = useRunnerWords();

const steps = computed(() => [
  t('runner_stepConnect'),
  t('runner_stepRequest'),
  t('runner_stepConfirm', { run: words.t('runui_requestRun') }),
]);
</script>

<template>
  <section class="space-y-6" data-testid="runner-welcome">
    <div class="flex flex-col items-center gap-3 pt-2 text-center">
      <RunnerLogo class="size-16 rounded-2xl shadow-md" />
      <div class="space-y-1">
        <h2 class="text-lg font-semibold text-highlighted">{{ t('runner_welcomeHeading') }}</h2>
        <p class="mx-auto max-w-md text-sm text-muted">{{ t('runner_tagline') }}</p>
      </div>
    </div>
    <UCard :ui="{ body: 'p-4 sm:p-5' }">
      <RunnerConnection />
    </UCard>
    <div class="space-y-3">
      <h3 class="text-xs font-semibold tracking-wide text-muted uppercase">{{ t('runner_stepsHeading') }}</h3>
      <ol class="grid gap-3 sm:grid-cols-3">
        <li
          v-for="(step, index) in steps"
          :key="index"
          class="flex gap-3 rounded-lg border border-default bg-default p-3"
        >
          <span
            aria-hidden="true"
            class="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
            >{{ words.number(index + 1) }}</span
          >
          <p class="min-w-0 text-sm text-default">{{ step }}</p>
        </li>
      </ol>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * The About card: Piwi Runner's mark, the version installed and what it does, where the tray menu's updates and logs
 * are, and its documentation, its release notes and the form to report a problem, which open in the browser.
 */
const { t } = useRunnerWords();
const version = String(useRuntimeConfig().public.runnerVersion ?? '');

const links = computed(() => [
  { label: t('runner_documentation'), icon: 'i-lucide-book-open', to: 'https://piwitests.dev/features/piwi-runner' },
  { label: t('runner_releaseNotes'), icon: 'i-lucide-scroll-text', to: 'https://github.com/PiwiTests/piwi/releases' },
  { label: t('runner_reportProblem'), icon: 'i-lucide-bug', to: 'https://github.com/PiwiTests/piwi/issues/new/choose' },
]);
</script>

<template>
  <RunnerSection icon="i-lucide-info" :title="t('runner_aboutHeading')" data-testid="runner-about">
    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <RunnerLogo class="size-12 shrink-0 rounded-xl shadow-sm" />
        <div class="min-w-0">
          <p class="text-sm font-semibold text-highlighted">Piwi Runner</p>
          <p v-if="version" class="text-xs text-muted" data-testid="runner-version">
            {{ t('runner_version', { version }) }}
          </p>
        </div>
      </div>
      <p class="text-sm text-muted">{{ t('runner_tagline') }}</p>
      <p class="flex items-start gap-2 text-xs text-muted">
        <UIcon name="i-lucide-app-window" class="mt-0.5 size-3.5 shrink-0" />
        <span>{{ t('runner_trayHint', { updates: t('shell_checkUpdates'), logs: t('shell_showLogs') }) }}</span>
      </p>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          target="_blank"
          :icon="link.icon"
          size="sm"
          color="neutral"
          variant="outline"
          >{{ link.label }}</UButton
        >
      </div>
    </div>
  </RunnerSection>
</template>

<script setup lang="ts">
/**
 * The app's updates, the same in Piwi Desktop's Settings → About and Piwi Runner's: check for a newer version, the one
 * on offer, install it with its progress, and the restart the person asks for. An update the shell's startup check
 * already found shows without a click, a build without an update channel says so and links the latest release, a
 * latest release without this system's package yet says to try again in a few minutes, and a checkbox turns the
 * startup check's notification on or off. What is new in the version on offer is the host's `notes` slot, which takes
 * the version and the install. What frames the panel (a card, a section, the version installed, a link to the release
 * notes) stays in the host. `useDesktopUpdate` does the work.
 */
defineProps<{
  /** The app's name, in the sentence that offers the check. */
  appName: string;
}>();

defineSlots<{
  /** What is new in the version on offer. */
  notes?(props: { version: string; install: () => Promise<void>; installing: boolean; installed: boolean }): unknown;
}>();

const LATEST_RELEASE = 'https://github.com/PiwiTests/piwi/releases/latest';
const PROSE_LINK = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';

const {
  supported,
  notifyOnStartup,
  savingNotify,
  status,
  checking,
  installing,
  installed,
  progressPercent,
  check,
  install,
  restart,
  setNotifyOnStartup,
} = useDesktopUpdate();
const { t } = useRunUiWords();
</script>

<template>
  <div class="space-y-3 text-sm" data-testid="desktop-update-panel">
    <div v-if="!status" class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-muted">{{ t('runui_updateCheckPrompt', { app: appName }) }}</p>
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-refresh-cw"
        :loading="checking"
        @click="check"
        >{{ t('runui_updateCheck') }}</UButton
      >
    </div>

    <p v-else-if="status.state === 'unsupported'" class="text-muted">
      <RunUiText name="runui_updateUnsupported">
        <template #release>
          <ULink :to="LATEST_RELEASE" target="_blank" rel="noopener noreferrer" :class="PROSE_LINK">{{
            t('runui_updateLatestRelease')
          }}</ULink>
        </template>
      </RunUiText>
    </p>

    <div
      v-else-if="status.state === 'uptodate' || status.state === 'unpublished'"
      class="flex flex-wrap items-center justify-between gap-3"
    >
      <p v-if="status.state === 'uptodate'" class="flex items-center gap-2 text-highlighted">
        <UIcon name="i-lucide-check-circle" class="size-4 shrink-0 text-success" aria-hidden="true" />
        {{ t('runui_updateLatest') }}
      </p>
      <p v-else class="min-w-0 text-highlighted" data-testid="desktop-update-unpublished">
        {{ t('runui_updateUnpublished') }}
      </p>
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-refresh-cw"
        :loading="checking"
        @click="check"
        >{{ t('runui_updateCheckAgain') }}</UButton
      >
    </div>

    <template v-else>
      <div class="flex flex-wrap items-start justify-between gap-3" data-shot="desktop-update-card">
        <div class="min-w-0 space-y-1">
          <p class="font-medium text-highlighted">
            {{ t('runui_updateAvailable', { version: status.version ?? '' }) }}
          </p>
          <slot
            name="notes"
            :version="status.version ?? ''"
            :install="install"
            :installing="installing"
            :installed="installed"
          />
        </div>
        <UButton v-if="!installed" size="xs" icon="i-lucide-download" :loading="installing" @click="install">{{
          installing ? t('runui_updateInstalling') : t('runui_updateInstall')
        }}</UButton>
        <UButton v-else size="xs" icon="i-lucide-rotate-cw" @click="restart">{{ t('runui_updateRestart') }}</UButton>
      </div>
      <UProgress v-if="installing && progressPercent !== null" :model-value="progressPercent" size="sm" />
      <p v-if="installed" class="text-xs text-muted">{{ t('runui_updateInstalled') }}</p>
    </template>

    <UCheckbox
      v-if="supported"
      :model-value="notifyOnStartup"
      :disabled="savingNotify"
      :label="t('runui_updateNotify')"
      :description="t('runui_updateNotifyHint')"
      @update:model-value="setNotifyOnStartup($event === true)"
    />
  </div>
</template>

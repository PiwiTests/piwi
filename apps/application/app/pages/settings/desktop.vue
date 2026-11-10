<script setup lang="ts">
/**
 * Settings → Desktop app: the desktop build's own wiring. This app's address
 * and access token for the runs discovery does not reach, pairing Piwi Picker,
 * where the data lives and the background service. Any other build shows one
 * line instead: the nav lists the page in the desktop build alone. Run on my
 * machine connects the app to a team instance it takes run requests from.
 */
import type { AdminStats } from '~~/types/api';

const isDesktop = useIsDesktop();

const { data: stats } = await useFetch<AdminStats | null>('/api/admin/stats', {
  immediate: isDesktop,
  default: () => null,
});
const { data: reporterConfig } = await useFetch<{ url: string; token: string } | null>('/api/desktop/reporter-config', {
  immediate: isDesktop,
  default: () => null,
});
</script>

<template>
  <p v-if="!isDesktop" class="py-6 text-sm text-muted max-sm:px-4">These settings are in the desktop app only.</p>
  <div v-else class="space-y-6" data-tour="desktop-settings-page">
    <DesktopReporterCard v-if="reporterConfig" :url="reporterConfig.url" :token="reporterConfig.token" />
    <DesktopPickerCard v-if="reporterConfig" :url="reporterConfig.url" :token="reporterConfig.token" />
    <DesktopTeamInstanceCard />
    <DataLocationCard v-if="stats" :database="stats.databaseLocation" :storage="stats.storageLocation" />
    <DesktopServiceCard />
  </div>
</template>

<script setup lang="ts">
/**
 * Settings → Team instance: the desktop app's connection to a team instance, which Run on my machine takes requests
 * from and Compare with team instance reads the CI of, and which team project each project's folder is linked to. Any
 * other build shows one line instead: the nav lists the page in the desktop build alone.
 */
const isDesktop = useIsDesktop();
</script>

<template>
  <p v-if="!isDesktop" class="py-6 text-sm text-muted max-sm:px-4">These settings are in the desktop app only.</p>
  <div v-else class="space-y-6" data-tour="team-instance-settings-page">
    <DesktopTeamInstanceCard />
    <DesktopTeamProjectLinks />
  </div>
</template>

<script setup lang="ts">
/**
 * Desktop shell only: the app's updates, in Settings → About. Renders nothing without the IPC bridge. The panel is
 * Piwi Runner's too (`DesktopUpdatePanel`: check, install with its progress, the restart the person asks for, the
 * startup notification); this card frames it with the version installed and Changelog, which opens the changelog
 * shipped with that version (`ChangelogModal`), and fills its `notes` slot with the summary of the release notes
 * between the installed and the offered version (`DesktopUpdateNotes`).
 */
import { DESKTOP_APP_NAME } from '#shared/piwi-ecosystem';

defineProps<{ currentVersion?: string | null }>();

const { openChangelog } = useChangelog();

const available = ref(false);
onMounted(() => {
  available.value = !!tauriCore();
});
</script>

<template>
  <SectionCard v-if="available" icon="i-lucide-arrow-up-circle" title="Updates" data-shot="desktop-updates">
    <template #subtitle>
      Updates install from GitHub releases and apply on restart{{
        currentVersion ? ` — you are on v${currentVersion}` : ''
      }}.
    </template>
    <template #actions>
      <UButton size="xs" color="neutral" variant="outline" data-testid="update-card-changelog" @click="openChangelog">
        Changelog
      </UButton>
    </template>

    <DesktopUpdatePanel :app-name="DESKTOP_APP_NAME">
      <template #notes="{ version, install, installing, installed }">
        <DesktopUpdateNotes :version="version" :installing="installing" :installed="installed" @install="install" />
      </template>
    </DesktopUpdatePanel>
  </SectionCard>
</template>

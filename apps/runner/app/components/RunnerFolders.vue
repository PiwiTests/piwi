<script setup lang="ts">
/** The Folders section of the settings: what a linked folder is for, and the layer's list of them (`DesktopTeamFolders`). */
const words = useRunUiWords();
const { t } = useRunnerWords();
</script>

<template>
  <RunnerSection
    icon="i-lucide-folder-git-2"
    :title="words.t('runui_connectionLinkedFolders')"
    :description="t('runner_foldersHint')"
    data-testid="runner-folders"
  >
    <DesktopTeamFolders />
  </RunnerSection>
</template>

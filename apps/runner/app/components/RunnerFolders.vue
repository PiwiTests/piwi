<script setup lang="ts">
/**
 * The folders linked to the instance's projects, by the name the instance gives each project (its id when it gives
 * none), with Unlink: the next request for that project asks for its folder again.
 */
const { connection, folders, unlink } = useDesktopTeamConnection();
const words = useRunUiWords();
const { t } = useRunnerWords();
const unlinking = ref<string | null>(null);

const entries = computed(() =>
  Object.entries(folders.value)
    .map(([projectId, folder]) => ({
      projectId,
      folder,
      name: connection.value.projectNames[Number(projectId)] || words.t('runui_connectionProject', { id: projectId }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

async function remove(projectId: string) {
  unlinking.value = projectId;
  try {
    await unlink(projectId);
  } finally {
    unlinking.value = null;
  }
}
</script>

<template>
  <RunnerSection
    icon="i-lucide-folder-git-2"
    :title="words.t('runui_connectionLinkedFolders')"
    :description="t('runner_foldersHint')"
    data-testid="runner-folders"
  >
    <p v-if="!entries.length" class="text-sm text-muted">{{ words.t('runui_connectionNoLinkedFolder') }}</p>
    <ul v-else class="divide-y divide-default rounded-md border border-default">
      <li v-for="entry in entries" :key="entry.projectId" class="flex items-center gap-3 px-3 py-2.5">
        <UIcon name="i-lucide-folder" class="size-4 shrink-0 text-muted" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-highlighted">{{ entry.name }}</p>
          <code class="block text-xs break-all text-muted">{{ entry.folder }}</code>
        </div>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-unlink"
          :loading="unlinking === entry.projectId"
          @click="remove(entry.projectId)"
          >{{ words.t('runui_connectionUnlink') }}</UButton
        >
      </li>
    </ul>
  </RunnerSection>
</template>

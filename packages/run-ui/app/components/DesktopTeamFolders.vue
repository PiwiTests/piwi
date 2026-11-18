<script setup lang="ts">
/**
 * Desktop shell only: the folders linked to the team instance's projects, by the name the instance gives each project
 * (its id when it gives none), with **Unlink**: the next request for that project asks for its folder again.
 */
const { connection, folders, unlink } = useDesktopTeamConnection();
const { t } = useRunUiWords();
/** The projects whose Unlink is on its way. */
const unlinking = ref(new Set<string>());

const entries = computed(() =>
  Object.entries(folders.value)
    .map(([projectId, folder]) => ({
      projectId,
      folder,
      name: connection.value.projectNames[Number(projectId)] || t('runui_connectionProject', { id: projectId }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

async function remove(projectId: string) {
  if (unlinking.value.has(projectId)) return;
  unlinking.value = new Set([...unlinking.value, projectId]);
  try {
    await unlink(projectId);
  } finally {
    const left = new Set(unlinking.value);
    left.delete(projectId);
    unlinking.value = left;
  }
}
</script>

<template>
  <p v-if="!entries.length" class="text-xs text-muted">{{ t('runui_connectionNoLinkedFolder') }}</p>
  <ul v-else class="divide-y divide-default rounded-md border border-default" data-testid="team-instance-folders">
    <li v-for="entry in entries" :key="entry.projectId" class="flex min-w-0 items-center gap-3 px-3 py-2">
      <UIcon name="i-lucide-folder" class="size-4 shrink-0 text-muted" />
      <div class="min-w-0 flex-1">
        <div class="text-xs font-medium text-highlighted">{{ entry.name }}</div>
        <code class="block text-xs break-all text-muted">{{ entry.folder }}</code>
      </div>
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-unlink"
        :loading="unlinking.has(entry.projectId)"
        @click="remove(entry.projectId)"
        >{{ t('runui_connectionUnlink') }}</UButton
      >
    </li>
  </ul>
</template>

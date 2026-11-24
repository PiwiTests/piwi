<script setup lang="ts">
/**
 * Desktop shell only: the folder on this machine linked to this project, shown
 * on the project page as status — the link powers the run button's This computer and IDE links.
 * Managing the link (choose, change, unlink) lives with the rest of the
 * project settings in the Settings tab; this card only reports and points there.
 * Renders nothing without the IPC bridge, so the page mounts it unconditionally.
 */
import type { DesktopFolderInspection } from '~/composables/useDesktopFolderInspect';

const props = defineProps<{ projectId: string | number }>();

const { available, link } = useDesktopProjectLink(() => props.projectId);

const inspection = ref<DesktopFolderInspection | null>(null);

watch(
  () => link.value?.path,
  async (path) => {
    inspection.value = path && link.value?.exists ? await inspectDesktopFolder(path) : null;
  },
  { immediate: true },
);

const ready = computed(() => isFolderPiwiReady(inspection.value));
</script>

<template>
  <!-- shrink-0: the project page body is a flex column, which would otherwise squash this card -->
  <UCard v-if="available" class="shrink-0" :ui="{ body: 'p-3 sm:p-3' }">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2 min-w-0 text-sm">
        <UIcon
          :name="link ? (link.exists ? 'i-lucide-folder-check' : 'i-lucide-folder-x') : 'i-lucide-folder-symlink'"
          class="size-4 shrink-0"
          :class="link ? (link.exists ? 'text-success' : 'text-warning') : 'text-muted'"
        />
        <template v-if="link">
          <code class="text-xs break-all">{{ link.path }}</code>
          <UBadge v-if="!link.exists" color="warning" variant="subtle" size="sm">missing</UBadge>
          <UBadge v-else-if="ready" color="success" variant="subtle" size="sm">ready</UBadge>
          <UBadge v-else-if="inspection" color="warning" variant="subtle" size="sm">needs setup</UBadge>
        </template>
        <span v-else class="text-muted">
          No local folder linked: link the folder that holds this project’s Playwright config to run its tests here and
          open its files in your IDE.
        </span>
      </div>
      <UButton
        size="xs"
        color="neutral"
        variant="soft"
        :icon="link ? 'i-lucide-settings-2' : 'i-lucide-folder-plus'"
        :to="`/projects/${projectId}/edit#local-folder`"
        :title="link ? 'Manage the linked folder in project settings' : 'Link a folder in project settings'"
      >
        {{ link ? 'Manage' : 'Link folder' }}
      </UButton>
    </div>
  </UCard>
</template>

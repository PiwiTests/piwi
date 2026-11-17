<script setup lang="ts">
/**
 * Desktop shell only: start a new project from a folder on this machine, the
 * one that holds its Playwright config. Picking a folder inspects it (project
 * name, Playwright/Piwi setup) and emits the result so the create form can
 * prefill; the parent links the folder to the project it creates. A folder with
 * no config at its root (a monorepo's root) offers the config folders found
 * above or below it. Renders nothing without the IPC bridge, so the create
 * modal can mount it unconditionally.
 */
import type { DesktopFolderCandidate, DesktopFolderInspection } from '~/composables/useDesktopFolderInspect';

const folder = defineModel<string | null>('folder', { default: null });

const emit = defineEmits<{ detected: [inspection: DesktopFolderInspection] }>();

const toast = useToast();

/** The IPC bridge exists — resolved on mount so SSR renders nothing. */
const available = ref(false);
onMounted(() => {
  available.value = !!tauriCore();
});

const inspection = ref<DesktopFolderInspection | null>(null);
/** The config folders above or below the chosen one, when it holds no config. */
const alternatives = ref<DesktopFolderCandidate[]>([]);
const busy = ref(false);

async function choose() {
  busy.value = true;
  try {
    const path = await pickDesktopFolder({
      title: 'Choose the folder that holds the Playwright config',
      start: folder.value,
    });
    if (path) folder.value = path;
  } catch (error) {
    toast.add({ title: 'Could not open the folder picker', description: errorMessage(error), color: 'error' });
  } finally {
    busy.value = false;
  }
}

function clear() {
  folder.value = null;
}

watch(
  folder,
  async (path) => {
    alternatives.value = [];
    const inspected = path ? await inspectDesktopFolder(path) : null;
    if (folder.value !== path) return;
    inspection.value = inspected;
    if (!inspected) return;
    emit('detected', inspected);
    if (!path || !inspected.exists || inspected.playwrightConfig) return;
    const found = (await checkDesktopProjectFolder(path, [], null))?.alternatives ?? [];
    if (folder.value === path) alternatives.value = found;
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="available">
    <div v-if="!folder" class="rounded-lg border border-dashed border-default p-3 flex flex-wrap items-center gap-3">
      <UIcon name="i-lucide-folder-search" class="size-5 shrink-0 text-muted" />
      <div class="min-w-0 flex-1 text-sm">
        <p class="font-medium">Start from a folder on this machine</p>
        <p class="text-xs text-muted">
          The folder that holds the Playwright config (in a monorepo, the config's subfolder). Detects the project name
          and checks the Playwright and Piwi reporter setup.
        </p>
      </div>
      <UButton color="neutral" variant="soft" size="sm" icon="i-lucide-folder-open" :loading="busy" @click="choose">
        Choose folder…
      </UButton>
    </div>

    <div v-else class="rounded-lg border border-default p-3 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0 text-sm">
          <UIcon name="i-lucide-folder-check" class="size-4 shrink-0 text-primary" />
          <code class="text-xs break-all">{{ folder }}</code>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-folder-search"
            :loading="busy"
            @click="choose"
          >
            Change
          </UButton>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :disabled="busy" @click="clear">
            Clear
          </UButton>
        </div>
      </div>

      <div v-if="alternatives.length" class="space-y-1.5" data-testid="desktop-new-project-alternatives">
        <p class="text-sm text-highlighted">The Playwright config is in a folder above or below it. Did you mean:</p>
        <ul class="space-y-1.5">
          <li
            v-for="alternative in alternatives"
            :key="alternative.path"
            class="flex flex-wrap items-center justify-between gap-2"
          >
            <code class="min-w-0 text-xs font-mono break-all">{{ alternative.path }}</code>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :aria-label="`Use ${alternative.path}`"
              @click="folder = alternative.path"
            >
              Use this folder
            </UButton>
          </li>
        </ul>
      </div>

      <DesktopFolderChecklist v-if="inspection" :inspection="inspection" />

      <p class="text-xs text-muted">The folder is linked to the new project for local runs and IDE links.</p>
    </div>
  </div>
</template>

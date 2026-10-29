<script setup lang="ts">
/**
 * Desktop shell only: the project's linked local folder, managed in the
 * project's Settings tab alongside the other project settings, with the
 * default options every run button of the project starts from. Changes apply
 * immediately — the link lives in the shell's own store and the defaults in
 * the app's storage, both on this machine, never in the server database.
 * Renders nothing without the IPC bridge.
 */
import type { ComponentPublicInstance } from 'vue';
import type { DesktopFolderInspection } from '~/composables/useDesktopFolderInspect';

const props = defineProps<{ projectId: string | number; projectName?: string | null }>();

const { available, link, busy, pickAndLink, unlink } = useDesktopProjectLink(() => props.projectId);
const store = useDesktopLocalRuns();

/** The project's default run options: what a run button of the project starts from. */
const runDefaults = computed({
  get: () => store.getProjectOptions(props.projectId),
  set: (value) => store.saveProjectOptions(props.projectId, value),
});
const { propose: proposePrevRuns } = useDesktopImportPrevRuns();

const inspection = ref<DesktopFolderInspection | null>(null);

watch(
  () => link.value?.path,
  async (path) => {
    inspection.value = path && link.value?.exists ? await inspectDesktopFolder(path) : null;
  },
  { immediate: true },
);

const route = useRoute();
const card = ref<ComponentPublicInstance | null>(null);

const KEEP_IN_VIEW_MS = 3000;
const READER_SCROLL_EVENTS = ['wheel', 'touchmove', 'keydown'];

// A link to `#local-folder` lands on this card. It renders once the shell is detected, while the cards above it are
// still loading, so it stays at the top of the view as they grow — until the reader scrolls or the time is up.
watch(
  available,
  (isAvailable) => {
    const el = card.value?.$el as HTMLElement | undefined;
    if (!isAvailable || route.hash !== '#local-folder' || !el?.parentElement) return;
    const scrollToCard = () => el.scrollIntoView({ block: 'start' });
    const observer = new ResizeObserver(scrollToCard);
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
      for (const name of READER_SCROLL_EVENTS) window.removeEventListener(name, stop);
    };
    const timer = setTimeout(stop, KEEP_IN_VIEW_MS);
    for (const name of READER_SCROLL_EVENTS) window.addEventListener(name, stop, { once: true });
    observer.observe(el.parentElement);
    scrollToCard();
  },
  { flush: 'post' },
);

/** Link (or re-link) the folder, then offer to import the runs already in it. */
async function chooseAndPropose() {
  const linked = await pickAndLink();
  if (linked) void proposePrevRuns(props.projectName, link.value?.path);
}
</script>

<template>
  <SectionCard
    v-if="available"
    id="local-folder"
    ref="card"
    icon="i-lucide-folder-symlink"
    title="Local folder"
    help="project.local-folder"
  >
    <template #subtitle>
      The checkout of this project on this machine — used to run tests locally and open files in your IDE.
    </template>
    <template #actions>
      <UBadge v-if="link && !link.exists" color="warning" variant="subtle" size="sm">missing</UBadge>
      <UBadge v-else-if="inspection && isFolderPiwiReady(inspection)" color="success" variant="subtle" size="sm">
        ready
      </UBadge>
      <UBadge v-else-if="inspection" color="warning" variant="subtle" size="sm">needs setup</UBadge>
    </template>

    <div v-if="link" class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0 text-sm">
          <UIcon
            :name="link.exists ? 'i-lucide-folder-check' : 'i-lucide-folder-x'"
            class="size-4 shrink-0"
            :class="link.exists ? 'text-success' : 'text-warning'"
          />
          <code class="text-xs break-all">{{ link.path }}</code>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-folder-search"
            :loading="busy"
            @click="chooseAndPropose"
          >
            Change
          </UButton>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-unlink" :disabled="busy" @click="unlink">
            Unlink
          </UButton>
        </div>
      </div>

      <p v-if="!link.exists" class="text-sm text-warning">
        The folder is gone from this machine — pick the checkout again.
      </p>

      <DesktopFolderChecklist v-if="inspection" :inspection="inspection" />

      <div class="space-y-2 pt-1" data-shot="local-folder-run-defaults">
        <h3 class="text-sm font-semibold text-highlighted">Default run options</h3>
        <p class="text-xs text-muted">
          What every Re-run button of this project starts from. A button's menu changes them for its own runs only.
        </p>
        <DesktopRunOptionsFields v-model="runDefaults" />
      </div>
    </div>

    <div v-else class="flex items-center justify-between gap-3">
      <p class="text-sm text-muted">No folder linked on this machine yet.</p>
      <UButton size="xs" icon="i-lucide-folder-plus" :loading="busy" @click="chooseAndPropose">Choose folder…</UButton>
    </div>
  </SectionCard>
</template>

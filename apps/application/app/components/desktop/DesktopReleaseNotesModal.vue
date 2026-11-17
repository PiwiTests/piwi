<script setup lang="ts">
/**
 * Desktop shell only: what changed between the installed version and the
 * update on offer, read from the GitHub release of each version in between.
 * Breaking changes of every release come first, then one fold per release,
 * the newest open (`ReleaseNotesAccordion`). Release bodies are external
 * content: they are parsed with `parseReleaseNotes` and each entry renders
 * through `releaseNoteHtml`.
 */
const props = defineProps<{
  notes: DesktopReleaseNotes;
  installing: boolean;
  installed: boolean;
}>();

const emit = defineEmits<{ install: [] }>();

const open = defineModel<boolean>('open', { default: false });

const releases = computed(() => props.notes.releases.map(updateReleaseItem));

const summary = computed(() => summarizeReleaseNotes(releases.value.map((r) => r.parsed)));

const openReleases = ref<string[]>([]);
watch(
  () => props.notes.offered,
  () => {
    openReleases.value = props.notes.releases[0] ? [props.notes.releases[0].version] : [];
  },
  { immediate: true },
);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const PROSE_LINK = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';

function install() {
  emit('install');
  open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" :title="`What's new since v${notes.installed}`" :ui="{ content: 'sm:max-w-2xl' }">
    <template #description>
      v{{ notes.installed }} → v{{ notes.offered }}, {{ plural(summary.count, 'release', 'releases') }} ·
      <ULink
        :to="compareUrl(notes.installed, notes.offered)"
        target="_blank"
        rel="noopener noreferrer"
        :class="PROSE_LINK"
        >Full diff on GitHub</ULink
      >
    </template>

    <template #body>
      <div class="space-y-4" data-shot="desktop-release-notes">
        <UAlert
          v-if="summary.breaking.length"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="plural(summary.breaking.length, 'breaking change', 'breaking changes')"
          data-testid="release-notes-breaking"
        >
          <template #description>
            <ReleaseNotesEntryList class="mt-2" :entries="summary.breaking" />
          </template>
        </UAlert>

        <p v-if="!releases.length" class="text-sm text-highlighted leading-relaxed">
          GitHub lists no release notes between these versions. The
          <ULink
            :to="compareUrl(notes.installed, notes.offered)"
            target="_blank"
            rel="noopener noreferrer"
            :class="PROSE_LINK"
            >comparison on GitHub</ULink
          >
          shows every change.
        </p>

        <ReleaseNotesAccordion v-else v-model="openReleases" :releases="releases" breaking-above />

        <p v-if="!notes.complete" class="text-xs text-muted">
          <ULink :to="RELEASES_PAGE_URL" target="_blank" rel="noopener noreferrer" :class="PROSE_LINK"
            >Older releases are on GitHub</ULink
          >.
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="outline" @click="open = false">Close</UButton>
        <UButton v-if="!installed" icon="i-lucide-download" :loading="installing" @click="install">
          Install update
        </UButton>
      </div>
    </template>
  </UModal>
</template>

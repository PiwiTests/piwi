<script setup lang="ts">
/**
 * Desktop shell only: what is new in the version the updates panel offers (`DesktopUpdatePanel`'s `notes` slot). The
 * shell reads the release notes of every version in between from GitHub (`desktop_get_release_notes`, once per offered
 * version): this sums them up (how many releases, how many breaking changes, the newest highlights) and What's new
 * opens them in full, with the install. Without them it links to the releases page, and installing works the same.
 */
import { parseReleaseNotes } from '#shared/changelog';

const props = defineProps<{
  /** The version on offer. */
  version: string;
  installing: boolean;
  installed: boolean;
}>();

const emit = defineEmits<{ install: [] }>();

const notes = ref<DesktopReleaseNotes | null>(null);
const notesError = ref<string | null>(null);
const notesLoading = ref(false);
const notesOpen = ref(false);

/** The version whose notes were last asked for, so each offered version is read once. */
let notesFor: string | null = null;

async function loadNotes(version: string) {
  const core = tauriCore();
  if (!core || notesFor === version) return;
  notesFor = version;
  notesLoading.value = true;
  notesError.value = null;
  try {
    const answer = await core.invoke<DesktopReleaseNotes>('desktop_get_release_notes');
    if (notesFor !== version) return;
    if (answer.offered === version) notes.value = answer;
    else notesError.value = `the notes found are for v${answer.offered}; check for updates again`;
  } catch (error) {
    if (notesFor === version) {
      notes.value = null;
      notesError.value = (typeof error === 'string' ? error : errorMessage(error)).replace(/\.$/, '');
    }
  } finally {
    if (notesFor === version) notesLoading.value = false;
  }
}

/** Ask the shell again after a failure. */
function retryNotes() {
  notesFor = null;
  void loadNotes(props.version);
}

watch(
  () => props.version,
  (version) => {
    if (version) void loadNotes(version);
  },
  { immediate: true },
);

const notesSummary = computed(() =>
  notes.value ? summarizeReleaseNotes(notes.value.releases.map(parseReleaseNotes)) : null,
);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const PROSE_LINK = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';
</script>

<template>
  <p v-if="notesLoading" class="text-xs text-muted">Loading what's new…</p>
  <p v-else-if="notesError" class="text-xs text-muted">
    What's new is unavailable: {{ notesError }}.
    <ULink :to="RELEASES_PAGE_URL" target="_blank" rel="noopener noreferrer" :class="PROSE_LINK"
      >Read the release notes on GitHub</ULink
    >
    or
    <button type="button" :class="PROSE_LINK" @click="retryNotes">try again</button>.
  </p>
  <template v-else-if="notes && notesSummary">
    <p class="text-xs text-muted" data-testid="release-notes-summary">
      <template v-if="notesSummary.count">
        {{ plural(notesSummary.count, 'release', 'releases') }} since v{{ notes.installed }}
      </template>
      <template v-else>No release notes found since v{{ notes.installed }}</template>
      <template v-if="notesSummary.breaking.length">
        · {{ plural(notesSummary.breaking.length, 'breaking change', 'breaking changes') }}
      </template>
    </p>
    <ul v-if="notesSummary.preview.length" class="space-y-0.5">
      <!-- eslint-disable-next-line vue/no-v-html -- releaseNoteHtml escapes before it adds its tags -->
      <li
        v-for="(line, i) in notesSummary.preview"
        :key="i"
        class="text-sm text-highlighted leading-relaxed line-clamp-3 before:content-['•'] before:mr-2 before:text-muted"
        v-html="releaseNoteHtml(line)"
      />
    </ul>
    <UButton
      size="xs"
      color="neutral"
      variant="outline"
      class="mt-1"
      data-testid="release-notes-open"
      @click="notesOpen = true"
    >
      What's new
    </UButton>
    <DesktopReleaseNotesModal
      v-model:open="notesOpen"
      :notes="notes"
      :installing="installing"
      :installed="installed"
      @install="emit('install')"
    />
  </template>
</template>

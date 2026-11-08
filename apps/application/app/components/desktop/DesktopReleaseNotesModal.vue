<script setup lang="ts">
/**
 * Desktop shell only: what changed between the installed version and the
 * update on offer, read from the GitHub release of each version in between.
 * Breaking changes of every release come first, then one fold per release,
 * the newest open. Release bodies are external content: they are parsed with
 * `parseReleaseNotes` and each entry renders through `inlineMarkdownHtml`.
 */
import { CHANGELOG_ENTRY_KINDS, parseReleaseNotes, type ChangelogEntryKind } from '#shared/changelog';

const props = defineProps<{
  notes: DesktopReleaseNotes;
  installing: boolean;
  installed: boolean;
}>();

const emit = defineEmits<{ install: [] }>();

const open = defineModel<boolean>('open', { default: false });

const KIND_LABELS: Record<Exclude<ChangelogEntryKind, 'breaking'>, string> = {
  highlights: 'Highlights',
  features: 'Features',
  fixes: 'Bug fixes',
  performance: 'Performance',
  other: 'Other changes',
};

/** Breaking changes show once, gathered above every release. */
const SHOWN_KINDS = CHANGELOG_ENTRY_KINDS.filter(
  (kind): kind is Exclude<ChangelogEntryKind, 'breaking'> => kind !== 'breaking',
);

const releases = computed(() =>
  props.notes.releases.map((note) => {
    const parsed = parseReleaseNotes(note);
    const sections = SHOWN_KINDS.filter((kind) => parsed.entries[kind].length).map((kind) => ({
      kind,
      title: KIND_LABELS[kind],
      entries: parsed.entries[kind].map((text) => ({ text })),
    }));
    const empty = !parsed.intro && CHANGELOG_ENTRY_KINDS.every((kind) => !parsed.entries[kind].length);
    return { note, parsed, sections, empty };
  }),
);

const summary = computed(() => summarizeReleaseNotes(releases.value.map((r) => r.parsed)));

const accordionItems = computed(() =>
  releases.value.map((release) => ({ label: `v${release.note.version}`, value: release.note.version, release })),
);
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

        <UAccordion
          v-else
          v-model="openReleases"
          type="multiple"
          :items="accordionItems"
          :ui="{ trigger: 'py-2.5', body: 'pb-4' }"
        >
          <template #default="{ item }">
            <span class="flex flex-wrap items-baseline gap-x-2 min-w-0">
              <span class="text-sm font-semibold text-highlighted">{{ item.label }}</span>
              <ClientDate
                v-if="item.release.note.date"
                :date="item.release.note.date"
                date-only
                class="text-xs text-muted"
              />
            </span>
          </template>
          <template #body="{ item }">
            <div class="space-y-3" :data-release="item.value">
              <p class="text-xs text-muted">
                <ULink :to="item.release.note.url" target="_blank" rel="noopener noreferrer" :class="PROSE_LINK"
                  >Release page</ULink
                >
              </p>
              <p v-if="item.release.empty" class="text-sm text-highlighted leading-relaxed">
                No notes for this release.
              </p>
              <!-- eslint-disable-next-line vue/no-v-html -- inlineMarkdownHtml escapes before it adds its tags -->
              <p
                v-if="item.release.parsed.intro"
                class="text-sm text-highlighted leading-relaxed"
                v-html="inlineMarkdownHtml(item.release.parsed.intro)"
              />
              <template v-for="section in item.release.sections" :key="section.kind">
                <!-- Bug fixes fold behind their count. -->
                <UCollapsible v-if="section.kind === 'fixes'">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    trailing-icon="i-lucide-chevron-down"
                    class="-ml-2.5"
                    :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
                  >
                    {{ plural(section.entries.length, 'bug fix', 'bug fixes') }}
                  </UButton>
                  <template #content>
                    <ReleaseNotesEntryList class="pt-1" :entries="section.entries" />
                  </template>
                </UCollapsible>
                <ReleaseNotesEntryList v-else :title="section.title" :entries="section.entries" />
              </template>
            </div>
          </template>
        </UAccordion>

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

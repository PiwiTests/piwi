<script setup lang="ts">
/**
 * One fold per release: its date, its release page, its intro, then its entries
 * by kind, bug fixes folded behind their count. With `breakingAbove`, the
 * caller lists every release's breaking changes above the folds and a release
 * leaves its own out; otherwise a release lists them after its highlights. A
 * GitHub timestamp is shown in the viewer's time zone, a changelog day as the
 * calendar day it names (`formatReleaseDate`). Entries render only through
 * `ReleaseNotesEntryList` and `releaseNoteHtml`, which escape first.
 */
import { CHANGELOG_ENTRY_KINDS, type ChangelogEntryKind } from '#shared/changelog';

const props = defineProps<{
  releases: ReleaseNotesItem[];
  breakingAbove?: boolean;
}>();

const openReleases = defineModel<string[]>({ default: () => [] });

const KIND_LABELS: Record<ChangelogEntryKind, string> = {
  highlights: 'Highlights',
  breaking: 'Breaking changes',
  features: 'Features',
  fixes: 'Bug fixes',
  performance: 'Performance',
  other: 'Other changes',
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;

const items = computed(() =>
  props.releases.map((release) => {
    const kinds = CHANGELOG_ENTRY_KINDS.filter((kind) => !(props.breakingAbove && kind === 'breaking'));
    const sections = kinds
      .filter((kind) => release.parsed.entries[kind].length)
      .map((kind) => ({
        kind,
        title: KIND_LABELS[kind],
        entries: release.parsed.entries[kind].map((text) => ({ text })),
      }));
    const empty = !release.parsed.intro && !sections.length;
    const emptyText =
      props.breakingAbove && release.parsed.entries.breaking.length
        ? 'Its breaking changes are listed above.'
        : 'No notes for this release.';
    const timestamp = release.date && TIMESTAMP.test(release.date) ? release.date : null;
    const day = release.date && !timestamp ? release.date : null;
    return { label: release.label, value: release.key, release, sections, empty, emptyText, timestamp, day };
  }),
);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const PROSE_LINK = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';
</script>

<template>
  <UAccordion v-model="openReleases" type="multiple" :items="items" :ui="{ trigger: 'py-2.5', body: 'pb-4' }">
    <template #default="{ item }">
      <span class="flex flex-wrap items-baseline gap-x-2 min-w-0">
        <span class="text-sm font-semibold text-highlighted">{{ item.label }}</span>
        <ClientDate v-if="item.timestamp" :date="item.timestamp" date-only class="text-xs text-muted" />
        <ClientOnly v-else-if="item.day">
          <span class="text-xs text-muted">{{ formatReleaseDate(item.day, activeLocalePrefs().locale) }}</span>
        </ClientOnly>
        <span v-if="item.release.current" class="text-xs text-muted" data-testid="release-notes-current">
          · this version
        </span>
      </span>
    </template>
    <template #body="{ item }">
      <div class="space-y-3" :data-release="item.value">
        <p class="text-xs text-muted">
          <ULink :to="item.release.pageUrl" target="_blank" rel="noopener noreferrer" :class="PROSE_LINK"
            >Release page</ULink
          >
        </p>
        <p v-if="item.empty" class="text-sm text-highlighted leading-relaxed">{{ item.emptyText }}</p>
        <!-- eslint-disable-next-line vue/no-v-html -- releaseNoteHtml escapes before it adds its tags -->
        <p
          v-if="item.release.parsed.intro"
          class="text-sm text-highlighted leading-relaxed"
          v-html="releaseNoteHtml(item.release.parsed.intro)"
        />
        <template v-for="section in item.sections" :key="section.kind">
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
</template>

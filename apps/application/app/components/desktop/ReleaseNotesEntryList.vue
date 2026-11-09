<script setup lang="ts">
/**
 * One section of release notes: an optional label and its entries. A raw
 * entry's `**scope:**` prefix shows as a meta label before its sentence, and an
 * entry carrying a version (a breaking change gathered from several releases)
 * names it after the sentence. Entries come from GitHub, so they render only
 * through `releaseNoteHtml`, which escapes first.
 */
import { splitEntryScope } from '#shared/changelog';

const props = defineProps<{
  title?: string;
  entries: { text: string; version?: string }[];
}>();

const rows = computed(() =>
  props.entries.map((entry) => {
    const { scope, text } = splitEntryScope(entry.text);
    return { scope, html: releaseNoteHtml(text), version: entry.version ?? null };
  }),
);
</script>

<template>
  <div class="space-y-1">
    <p v-if="title" class="text-sm font-semibold text-highlighted">{{ title }}</p>
    <ul class="space-y-1.5">
      <li v-for="(row, i) in rows" :key="i" class="flex gap-2 text-sm text-highlighted leading-relaxed min-w-0">
        <span v-if="row.scope" class="text-xs text-muted font-mono shrink-0 pt-0.5">{{ row.scope }}</span>
        <span class="min-w-0 break-words">
          <!-- eslint-disable-next-line vue/no-v-html -- releaseNoteHtml escapes before it adds its tags -->
          <span v-html="row.html" />
          <span v-if="row.version" class="block text-xs text-muted">v{{ row.version }}</span>
        </span>
      </li>
    </ul>
  </div>
</template>

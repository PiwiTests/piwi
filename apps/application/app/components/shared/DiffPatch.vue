<script setup lang="ts">
/**
 * A unified diff, one colored row per line with its code highlighted for the
 * file's language, scrolling sideways inside itself. The root carries
 * `data-diff`, which `app:measure` counts as one text style. Rows whose
 * head-side line lies in `marked` (the suspect lines) carry a bar on their
 * left edge and `data-suspect`.
 */
import { lineInRanges, type LineRange } from '@piwitests/core/coverage';
import { highlightDiffRows, languageForPath } from '#shared/highlight';
import { patchHeadLines } from '~/utils/suspect-lines';

const props = defineProps<{
  patch: string;
  /** The patched file's path; its extension picks the language the code is highlighted in. */
  file?: string | null;
  /** Head-side line ranges to mark, normalized. */
  marked?: LineRange[] | null;
}>();

const rows = computed(() => {
  const lines = parsePatchLines(props.patch);
  const html = highlightDiffRows(lines, languageForPath(props.file));
  const marked = props.marked?.length ? props.marked : null;
  const heads = marked ? patchHeadLines(lines) : [];
  return lines.map((line, i) => {
    const head = heads[i] ?? null;
    return { ...line, html: html[i] ?? null, suspect: Boolean(marked && head !== null && lineInRanges(marked, head)) };
  });
});
</script>

<template>
  <div data-diff class="overflow-x-auto text-xs font-mono">
    <div
      v-for="(line, i) in rows"
      :key="i"
      class="px-3 py-px whitespace-pre leading-5 min-w-0"
      :class="[patchLineClass[line.type], line.suspect ? SUSPECT_ROW_CLASS : '']"
      :data-suspect="line.suspect ? '' : undefined"
      :title="line.suspect ? 'Suspect line: in the failing tests’ coverage' : undefined"
    >
      <template v-if="line.html === null">{{ line.text || ' ' }}</template>
      <template v-else
        >{{ line.text.charAt(0) || ' ' }}<span class="text-gray-800 dark:text-gray-200" v-html="line.html"
      /></template>
    </div>
  </div>
</template>

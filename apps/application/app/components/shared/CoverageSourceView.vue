<script setup lang="ts">
/**
 * A source file with its coverage marked: every line, highlighted for the
 * file's language, the lines that ran carrying the bar the diff draws on
 * suspect rows (`data-executed`), and the executable lines that did not run
 * a lighter bar (`data-not-executed`). The functions that ran are listed
 * above it, each a link that brings its first line into view. Without the
 * source, the line numbers alone say what ran and what did not. The
 * `annotation` slot adds a narrow column after each line number (a count of
 * tests, for instance).
 */
import { lineInRanges, type LineRange } from '@piwitests/core/coverage';
import { highlightLines, languageForPath } from '#shared/highlight';
import { lineRangesText } from '~/utils/suspect-lines';
import { NOT_RUN_ROW_CLASS, functionNameAt } from '~/utils/coverage-view';

const props = withDefaults(
  defineProps<{
    /** Repository-relative path; its extension picks the language. */
    path: string;
    /** The file's content at the version the line numbers refer to; null shows the line numbers alone. */
    content: string | null;
    /** The lines that ran, normalized. */
    executed: LineRange[];
    /** The executable lines that did not run, normalized; null when they are not known. */
    notExecuted?: LineRange[] | null;
    /** The functions that ran, as their first and last line. */
    functions?: LineRange[];
    /** The line scrolled to first; the first line that ran when absent. */
    focusLine?: number | null;
    /** Hover text of a line that ran. */
    executedTitle?: string;
    /** Hover text of an executable line that did not run. */
    notExecutedTitle?: string;
  }>(),
  {
    notExecuted: null,
    functions: () => [],
    focusLine: null,
    executedTitle: 'Ran',
    notExecutedTitle: 'Executable, did not run',
  },
);

defineSlots<{
  /** A narrow column after the line number of each line. */
  annotation?(props: { line: number; executed: boolean; notExecuted: boolean }): unknown;
}>();

const sourceLines = computed(() => {
  if (props.content === null) return null;
  const lines = props.content.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
});

const rows = computed(() => {
  const lines = sourceLines.value;
  if (!lines) return [];
  const html = highlightLines(lines, languageForPath(props.path));
  const gaps = props.notExecuted ?? [];
  return lines.map((_, i) => {
    const line = i + 1;
    const executed = lineInRanges(props.executed, line);
    return { line, html: html[i] ?? '', executed, notExecuted: !executed && lineInRanges(gaps, line) };
  });
});

/** Wide enough for the last line number, the same on every row. */
const gutterWidth = computed(() => `calc(${String(Math.max(rows.value.length, 1)).length}ch + 1.5rem)`);

/** The functions that ran, each with the name its first line gives it. */
const ranFunctions = computed(() =>
  props.functions.map(([start, end]) => ({
    start,
    end,
    name: functionNameAt(sourceLines.value?.[start - 1]) ?? `line ${start}`,
  })),
);

const scroller = ref<HTMLElement | null>(null);
const flashed = ref<number | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
});

/** Scroll the source so `line` sits near its top; with `flash`, mark the line for a moment. */
function reveal(line: number, flash = false) {
  const box = scroller.value;
  const row = box?.querySelector<HTMLElement>(`[data-line="${line}"]`);
  if (!box || !row) return;
  box.scrollTop = Math.max(0, row.offsetTop - row.offsetHeight * 3);
  if (!flash) return;
  flashed.value = line;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flashed.value = null), 1500);
}

onMounted(() => {
  const first = props.focusLine ?? props.executed[0]?.[0] ?? null;
  if (first != null) nextTick(() => reveal(first));
});

defineExpose({ reveal });
</script>

<template>
  <div data-coverage-source class="space-y-2">
    <p v-if="ranFunctions.length" class="text-xs text-muted">
      Functions that ran:
      <template v-for="(fn, i) in ranFunctions" :key="`${fn.start}-${fn.end}`">
        <template v-if="i > 0">, </template>
        <button
          v-if="content !== null"
          type="button"
          class="font-mono"
          :class="SENTENCE_LINK_CLASS"
          :title="`Show line ${fn.start}`"
          @click="reveal(fn.start, true)"
        >
          {{ fn.name }}</button
        ><span v-else class="font-mono">{{ fn.name }}</span>
      </template>
    </p>

    <template v-if="content !== null">
      <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-3 w-[3px] bg-[var(--ui-text-highlighted)]" aria-hidden="true" />{{
            executedTitle
          }}
        </span>
        <span v-if="notExecuted" class="inline-flex items-center gap-1.5">
          <span class="inline-block h-3 w-[3px] bg-[var(--ui-border-accented)]" aria-hidden="true" />{{
            notExecutedTitle
          }}
        </span>
      </p>
      <div
        ref="scroller"
        class="relative max-h-[28rem] overflow-auto rounded-md border border-default text-xs font-mono"
        :aria-label="`Source of ${path}`"
        tabindex="0"
      >
        <div class="min-w-max py-1">
          <div
            v-for="row in rows"
            :key="row.line"
            :data-line="row.line"
            :data-executed="row.executed ? '' : undefined"
            :data-not-executed="row.notExecuted ? '' : undefined"
            :title="row.executed ? executedTitle : row.notExecuted ? notExecutedTitle : undefined"
            class="flex leading-5 transition-colors"
            :class="[
              row.executed ? SUSPECT_ROW_CLASS : row.notExecuted ? NOT_RUN_ROW_CLASS : '',
              flashed === row.line ? 'bg-elevated' : '',
            ]"
          >
            <span class="shrink-0 select-none pl-3 pr-3 text-right text-muted" :style="{ minWidth: gutterWidth }">
              {{ row.line }}
            </span>
            <span v-if="$slots.annotation" class="shrink-0 select-none pr-3">
              <slot name="annotation" :line="row.line" :executed="row.executed" :not-executed="row.notExecuted" />
            </span>
            <span class="whitespace-pre pr-3 text-gray-800 dark:text-gray-200" v-html="row.html || ' '" />
          </div>
        </div>
      </div>
    </template>

    <dl v-else class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt class="text-xs text-muted">{{ executedTitle }}</dt>
      <dd data-executed-lines class="text-sm text-highlighted break-words">
        {{ executed.length ? lineRangesText(executed) : 'no line' }}
      </dd>
      <template v-if="notExecuted">
        <dt class="text-xs text-muted">{{ notExecutedTitle }}</dt>
        <dd data-not-executed-lines class="text-sm text-highlighted break-words">
          {{ notExecuted.length ? lineRangesText(notExecuted) : 'none' }}
        </dd>
      </template>
    </dl>
  </div>
</template>

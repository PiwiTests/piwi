<script setup lang="ts">
/**
 * Renders a failure's in-project call stack as a sequence of source snippets —
 * the line that actually threw (innermost, "Failed here") plus the callers above
 * it — so the interesting code isn't limited to the test line that triggered the
 * failure. Each frame shows its project-relative path:line and its code
 * syntax-highlighted, with the marked failing line on a red band. The frame the
 * failure enters the test's code at offers Debug in my editor beside its path.
 */
import type { TestSourceFrame } from '~~/types/api';
import type { DebugInIdeTarget } from '~/composables/useOpenInIde';
import { atFailurePlace } from '~/utils/ide-links';
import { highlightLines, languageForPath } from '#shared/highlight';
import { parseSourceSnippet } from '#shared/source-snippet';

const props = defineProps<{
  frames: TestSourceFrame[];
  /** Piwi project id + name, threaded so the IDE opener can resolve a workspace root. */
  projectKey?: string | number | null;
  projectName?: string | null;
  /** Debug in my editor's target, offered on the first frame at its failing line. */
  debugTarget?: DebugInIdeTarget | null;
}>();

const debugIndex = computed(() => props.frames.findIndex((frame) => atFailurePlace(frame, props.debugTarget)));

/** Each frame's rows: the gutter as the snippet wrote it, and the code as highlighted HTML. */
const frameRows = computed(() =>
  props.frames.map((frame) => {
    const rows = parseSourceSnippet(frame.snippet);
    const html = highlightLines(
      rows.map((row) => row.code),
      languageForPath(frame.file),
    );
    return rows.map((row, i) => ({ ...row, html: html[i] ?? '' }));
  }),
);
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="(frame, i) in frames"
      :key="`${frame.file}:${frame.line}:${i}`"
      class="rounded-lg border border-default overflow-hidden"
    >
      <div class="flex items-center gap-2 px-3 py-1.5 bg-elevated/40 border-b border-default text-xs">
        <UIcon
          :name="i === 0 ? 'i-lucide-circle-x' : 'i-lucide-corner-left-up'"
          :class="i === 0 ? 'text-red-500' : 'text-gray-400'"
          class="size-3.5 shrink-0"
        />
        <OpenInIdeLink
          :file-path="frame.file"
          :line="frame.line"
          :project-key="projectKey"
          :project-name="projectName"
          class="min-w-0"
        />
        <span class="ml-auto flex shrink-0 items-center gap-2">
          <DebugInEditorButton v-if="debugTarget && i === debugIndex" :target="debugTarget" />
          <UBadge :color="i === 0 ? 'error' : 'neutral'" variant="subtle" size="xs" class="shrink-0">
            {{ i === 0 ? 'Failed here' : 'Caller' }}
          </UBadge>
        </span>
      </div>
      <div class="overflow-x-auto text-xs font-mono leading-relaxed py-1">
        <div class="min-w-max">
          <div
            v-for="(row, j) in frameRows[i]"
            :key="j"
            class="px-3 whitespace-pre text-gray-800 dark:text-gray-200"
            :class="row.failing ? 'bg-red-50 dark:bg-red-950/30 font-medium' : ''"
          >
            <span
              class="select-none"
              :class="row.failing ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'"
              >{{ row.gutter }}</span
            ><span v-html="row.html" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

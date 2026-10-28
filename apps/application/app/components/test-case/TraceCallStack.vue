<script setup lang="ts">
/**
 * Renders the trace-derived full call stack: every frame of the failing
 * action with real source read from the trace's embedded files. Extends the
 * visual language of TestSourceStack (frame blocks, highlighted code, red
 * failing line) with line-number gutters, function names, and consecutive
 * dependency frames folded into a single expandable group so the in-project
 * story stays scannable. The frame the failure enters the test's code at
 * offers Debug in my editor beside its path.
 */
import type { TraceStackFrame } from '~~/types/api';
import type { DebugInIdeTarget } from '~/composables/useOpenInIde';
import { atFailurePlace } from '~/utils/ide-links';
import { highlightLines, languageForPath } from '#shared/highlight';

const props = defineProps<{
  frames: TraceStackFrame[];
  /** Piwi project id + name, threaded so the IDE opener can resolve a workspace root. */
  projectKey?: string | number | null;
  projectName?: string | null;
  /** Debug in my editor's target, offered on the first in-project frame at its failing line. */
  debugTarget?: DebugInIdeTarget | null;
}>();

const debugIndex = computed(() =>
  props.frames.findIndex((frame) => frame.inProject && atFailurePlace(frame, props.debugTarget)),
);

type Row =
  | { kind: 'frame'; frame: TraceStackFrame; frameIndex: number }
  | { kind: 'group'; frames: TraceStackFrame[]; key: string };

/**
 * Fold runs of out-of-project frames into one group row. When nothing is
 * recognizably in-project (root inference failed) folding would swallow the
 * whole stack, so everything renders flat instead.
 */
const rows = computed<Row[]>(() => {
  const hasInProject = props.frames.some((f) => f.inProject);
  if (!hasInProject) return props.frames.map((frame, frameIndex) => ({ kind: 'frame', frame, frameIndex }));

  const out: Row[] = [];
  let pending: TraceStackFrame[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    out.push({ kind: 'group', frames: pending, key: `group-${out.length}` });
    pending = [];
  };
  props.frames.forEach((frame, frameIndex) => {
    if (frame.inProject) {
      flush();
      out.push({ kind: 'frame', frame, frameIndex });
    } else {
      pending.push(frame);
    }
  });
  flush();
  return out;
});

/** Index of the innermost in-project frame — the "Failed here" one. */
const failedFrameIndex = computed(() => {
  const i = props.frames.findIndex((f) => f.inProject);
  return i >= 0 ? i : 0;
});

const openGroups = ref<Set<string>>(new Set());
function toggleGroup(key: string) {
  const next = new Set(openGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openGroups.value = next;
}

/** Each frame's source lines, numbered and syntax-highlighted, indexed like `frames`. */
const frameSourceRows = computed(() =>
  props.frames.map((frame) => {
    if (!frame.source) return [];
    const { startLine, lines } = frame.source;
    const html = highlightLines(lines, languageForPath(frame.file));
    return lines.map((_, i) => ({ lineNo: startLine + i, html: html[i] ?? '', failing: startLine + i === frame.line }));
  }),
);
</script>

<template>
  <div class="space-y-2">
    <template v-for="row in rows" :key="row.kind === 'frame' ? `f-${row.frameIndex}` : row.key">
      <!-- One stack frame with (when the trace has sources) its code around the line -->
      <div v-if="row.kind === 'frame'" class="rounded-lg border border-default overflow-hidden">
        <div
          class="flex items-center gap-2 px-3 py-1.5 bg-elevated/40 text-xs"
          :class="row.frame.source ? 'border-b border-default' : ''"
        >
          <UIcon
            :name="row.frameIndex === failedFrameIndex ? 'i-lucide-circle-x' : 'i-lucide-corner-left-up'"
            :class="row.frameIndex === failedFrameIndex ? 'text-red-500' : 'text-gray-400'"
            class="size-3.5 shrink-0"
          />
          <OpenInIdeLink
            v-if="row.frame.inProject"
            :file-path="row.frame.file"
            :line="row.frame.line"
            :column="row.frame.column"
            :project-key="projectKey"
            :project-name="projectName"
            class="min-w-0"
          />
          <code v-else class="truncate text-gray-500 dark:text-gray-400" :title="row.frame.absFile || row.frame.file">
            {{ row.frame.file }}:{{ row.frame.line }}
          </code>
          <span v-if="row.frame.functionName" class="truncate text-gray-400 dark:text-gray-500">
            in <span class="font-mono">{{ row.frame.functionName }}</span>
          </span>
          <span class="ml-auto flex shrink-0 items-center gap-2">
            <DebugInEditorButton v-if="debugTarget && row.frameIndex === debugIndex" :target="debugTarget" />
            <UBadge
              :color="row.frameIndex === failedFrameIndex ? 'error' : 'neutral'"
              variant="subtle"
              size="xs"
              class="shrink-0"
            >
              {{ row.frameIndex === failedFrameIndex ? 'Failed here' : 'Caller' }}
            </UBadge>
          </span>
        </div>
        <div v-if="row.frame.source" class="overflow-x-auto text-xs font-mono leading-relaxed py-1">
          <div class="min-w-max">
            <div
              v-for="line in frameSourceRows[row.frameIndex]"
              :key="line.lineNo"
              class="px-3 whitespace-pre flex text-gray-800 dark:text-gray-200"
              :class="line.failing ? 'bg-red-50 dark:bg-red-950/30 font-medium' : ''"
            >
              <span
                class="w-10 shrink-0 text-right pr-3 tabular-nums select-none"
                :class="line.failing ? 'text-red-400 dark:text-red-500' : 'text-gray-300 dark:text-gray-600'"
                >{{ line.lineNo }}</span
              >
              <span v-html="line.html" />
            </div>
          </div>
        </div>
      </div>

      <!-- A run of dependency / out-of-project frames, folded to one line -->
      <div v-else class="rounded-lg border border-dashed border-default">
        <button
          type="button"
          class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          @click="toggleGroup(row.key)"
        >
          <UIcon
            :name="openGroups.has(row.key) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-3.5 shrink-0"
          />
          {{ row.frames.length }} frame{{ row.frames.length === 1 ? '' : 's' }} in dependencies
        </button>
        <div v-if="openGroups.has(row.key)" class="px-3 pb-2 space-y-1">
          <div
            v-for="(frame, i) in row.frames"
            :key="i"
            class="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 min-w-0"
          >
            <UIcon name="i-lucide-corner-left-up" class="size-3 shrink-0" />
            <code class="truncate" :title="frame.absFile || frame.file">{{ frame.file }}:{{ frame.line }}</code>
            <span v-if="frame.functionName" class="truncate font-mono shrink-0">{{ frame.functionName }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

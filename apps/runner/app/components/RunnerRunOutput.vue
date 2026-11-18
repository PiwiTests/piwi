<script setup lang="ts">
/**
 * A run's output as its terminal printed it, Playwright's colors included (`renderAnsi`), on a dark pane: its last
 * `SHOWN_LINES` lines, following the end while the reader is there, and **Copy output**, which copies every line the
 * window keeps, without colors. It opens on its own once the run failed or could not run.
 */
import type { RunnerRun } from '~/utils/runner-runs';

const props = defineProps<{ run: RunnerRun }>();

const SHOWN_LINES = 300;
/** How close to the end, in pixels, the reader is still at the end. */
const AT_END = 24;

const { t, tn } = useRunnerWords();
const words = useRunUiWords();
const { copy, copied } = useCopy();
const pane = useTemplateRef<HTMLElement>('pane');

const html = computed(() => renderAnsi(props.run.lines.slice(-SHOWN_LINES).join('\n'), { onDark: true }));
const ended = computed(() => props.run.status === 'failed' || props.run.status === 'error');

function toEnd() {
  if (pane.value) pane.value.scrollTop = pane.value.scrollHeight;
}

watch(
  () => props.run.lines.length,
  async () => {
    const el = pane.value;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END;
    await nextTick();
    if (atEnd) toEnd();
  },
);

function onToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open) void nextTick(toEnd);
}
</script>

<template>
  <details :open="ended" class="group" data-testid="runner-run-output" @toggle="onToggle">
    <summary
      class="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs text-muted hover:text-default [&::-webkit-details-marker]:hidden"
    >
      <UIcon name="i-lucide-chevron-right" class="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
      <span class="font-medium">{{ t('runner_output') }}</span>
      <span aria-hidden="true">·</span>
      <span class="min-w-0 flex-1">{{ tn('runner_outputLines', run.lines.length) }}</span>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        @click.prevent="copy(stripAnsi(run.lines.join('\n')))"
        >{{ copied ? words.t('runui_commonCopied') : t('runner_copyOutput') }}</UButton
      >
    </summary>
    <div class="px-4 pb-4">
      <!-- eslint-disable vue/no-v-html — renderAnsi escapes the text before wrapping it in styled spans -->
      <pre
        ref="pane"
        class="max-h-80 overflow-auto rounded-md bg-neutral-950 p-3 font-mono text-xs leading-relaxed text-neutral-200 ring ring-neutral-800"
        v-html="html"
      />
      <!-- eslint-enable vue/no-v-html -->
    </div>
  </details>
</template>

<script setup lang="ts">
/**
 * A run's output as its terminal printed it, Playwright's colors included (`renderAnsi`), on a dark pane: its last
 * `SHOWN_LINES` lines, following the end while the reader is there, and **Copy output**, which copies every line the
 * window keeps, without colors. Folded until the person opens it, or until the run failed or could not run; the run's
 * card and its row both keep what the person chose (`useRunnerDisclosures`).
 */
import type { RunnerRun } from '~/utils/runner-runs';

const props = defineProps<{ run: RunnerRun }>();

const SHOWN_LINES = 300;
/** How close to the end, in pixels, the reader is still at the end. */
const AT_END = 24;

const { t, tn } = useRunnerWords();
const words = useRunUiWords();
const { copy, copied } = useCopy();
const disclosures = useRunnerDisclosures();
const pane = useTemplateRef<HTMLElement>('pane');

const html = computed(() => renderAnsi(props.run.lines.slice(-SHOWN_LINES).join('\n'), { onDark: true }));
const id = computed(() => `output:${props.run.key}`);
const open = computed(() =>
  disclosures.isOpen(id.value, props.run.status === 'failed' || props.run.status === 'error'),
);

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
  const shown = (event.target as HTMLDetailsElement).open;
  if (shown !== open.value) disclosures.choose(id.value, shown);
  if (shown) void nextTick(toEnd);
}
</script>

<template>
  <details :open="open" class="group" data-testid="runner-run-output" @toggle="onToggle">
    <summary
      class="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs text-muted hover:text-default [&::-webkit-details-marker]:hidden"
    >
      <UIcon name="i-lucide-chevron-right" class="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
      <span class="font-medium">{{ t('runner_output') }}</span>
      <span aria-hidden="true">·</span>
      <span class="min-w-0 flex-1">{{ tn('runner_outputLines', run.lines.length) }}</span>
    </summary>
    <div class="space-y-2 px-4 pb-4">
      <div class="flex justify-end">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          @click="copy(stripAnsi(run.lines.join('\n')))"
          >{{ copied ? words.t('runui_commonCopied') : t('runner_copyOutput') }}</UButton
        >
      </div>
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

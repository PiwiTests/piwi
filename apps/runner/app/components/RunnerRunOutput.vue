<script setup lang="ts">
/**
 * A run's output, folded under how many lines it printed: the layer's pane (`DesktopRunOutputPane`), Playwright's
 * colors included, following the end while the reader is there, with its filter, Go to the first error and Copy
 * output. Folded until the person opens it, or until the run failed or could not run; the run's card and its row both
 * keep what the person chose (`useRunnerDisclosures`).
 */
import type { RunnerRun } from '~/utils/runner-runs';

const props = defineProps<{ run: RunnerRun }>();

const { t, tn } = useRunnerWords();
const disclosures = useRunnerDisclosures();

const id = computed(() => `output:${props.run.key}`);
const open = computed(() =>
  disclosures.isOpen(id.value, props.run.status === 'failed' || props.run.status === 'error'),
);

function onToggle(event: Event) {
  const shown = (event.target as HTMLDetailsElement).open;
  if (shown !== open.value) disclosures.choose(id.value, shown);
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
      <span class="min-w-0 flex-1">{{ tn('runner_outputLines', run.linesTotal) }}</span>
    </summary>
    <div class="px-4 pb-4">
      <DesktopRunOutputPane v-if="open" :lines="run.lines" />
    </div>
  </details>
</template>

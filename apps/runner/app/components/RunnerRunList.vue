<script setup lang="ts">
/** The runs of this window: what each is, where it stands, its output, and Stop while it runs. */
import type { RunnerRun, RunnerRunStatus } from '~/utils/runner-runs';

const { runs, stopRun } = useRunnerRuns();

const STATUS: Record<RunnerRunStatus, { label: string; color: 'primary' | 'success' | 'error' | 'neutral' }> = {
  running: { label: 'Running', color: 'primary' },
  passed: { label: 'Passed', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  stopped: { label: 'Stopped', color: 'neutral' },
  error: { label: 'Could not run', color: 'error' },
};
const SHOWN_LINES = 200;

function host(instance: string): string {
  try {
    return new URL(instance).host;
  } catch {
    return instance;
  }
}

function output(run: RunnerRun): string {
  return run.lines.slice(-SHOWN_LINES).join('\n');
}
</script>

<template>
  <section class="space-y-3" data-testid="runner-runs">
    <h2 class="text-sm font-semibold text-muted">Runs</h2>
    <p v-if="!runs.length" class="text-sm text-muted">
      No runs yet. When a team instance asks for tests, you confirm them here first.
    </p>
    <UCard v-for="run in runs" :key="run.key" :ui="{ body: 'space-y-2' }">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">{{ run.title }}</p>
          <p class="truncate text-xs text-muted">{{ host(run.instance) }}</p>
        </div>
        <UBadge :color="STATUS[run.status].color" variant="subtle">
          {{ run.stopRequested && run.status === 'running' ? 'Stopping…' : STATUS[run.status].label }}
        </UBadge>
        <UButton
          v-if="run.status === 'running'"
          size="xs"
          color="neutral"
          variant="outline"
          :disabled="run.shellId === null"
          @click="stopRun(run)"
        >
          {{ run.stopRequested ? 'Stop now' : 'Stop' }}
        </UButton>
      </div>
      <details v-if="run.lines.length">
        <summary class="cursor-pointer text-xs text-muted">Output</summary>
        <pre class="mt-2 max-h-72 overflow-auto rounded bg-elevated p-2 text-xs">{{ output(run) }}</pre>
      </details>
    </UCard>
  </section>
</template>

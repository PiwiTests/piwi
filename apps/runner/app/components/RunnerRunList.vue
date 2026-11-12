<script setup lang="ts">
/**
 * The runs of this window: what each is, where it stands, and Stop while it runs; then, live, its workers as the hub
 * tells them (`DesktopRunSession`, the layer's, as the dashboard's tray shows them): each worker's test, Pause, Step,
 * Resume and the stopped test's page, with **Hold failures**, which keeps a failure no pause bar shows waiting here.
 * The code made at a stop and the locators picked wait above the runs, to copy (`DesktopRunCopyList`). Its output
 * follows.
 */
import type { HubSession } from '@piwitests/core/run-hub';
import { isRunnerRunRef, type RunnerRun, type RunnerRunStatus } from '~/utils/runner-runs';

const { runs, stopRun, setHold } = useRunnerRuns();
const hub = useDesktopRunHub();

const STATUS: Record<RunnerRunStatus, { label: string; color: 'primary' | 'success' | 'error' | 'neutral' }> = {
  running: { label: 'Running', color: 'primary' },
  passed: { label: 'Passed', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  stopped: { label: 'Stopped', color: 'neutral' },
  error: { label: 'Could not run', color: 'error' },
};
const SHOWN_LINES = 200;

function output(run: RunnerRun): string {
  return run.lines.slice(-SHOWN_LINES).join('\n');
}

/** The hub's live run of a run of this window, while it runs and the window hears the hub. */
function sessionOf(run: RunnerRun): HubSession | null {
  if (run.status !== 'running') return null;
  return (
    (Object.values(hub.state.sessions) as HubSession[]).find((session) => isRunnerRunRef(session.ref, run.shellId)) ??
    null
  );
}

/** What the live region reads out: what a command answered. */
const announcement = ref('');
function announce(text: string) {
  announcement.value = '';
  requestAnimationFrame(() => {
    announcement.value = text;
  });
}
</script>

<template>
  <section class="space-y-3" data-testid="runner-runs">
    <h2 class="text-sm font-semibold text-muted">Runs</h2>
    <p v-if="!runs.length" class="text-sm text-muted">
      No runs yet. When a team instance asks for tests, you confirm them here first.
    </p>
    <DesktopRunCopyList v-if="hub.state.kept.length" :kept="hub.state.kept" :roots="hub.state.roots" />
    <UCard v-for="run in runs" :key="run.key" :ui="{ body: 'space-y-2' }" data-testid="runner-run">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">{{ run.title }}</p>
          <p class="truncate text-xs text-muted">{{ teamInstanceHost(run.instance) }}</p>
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
      <template v-if="sessionOf(run)">
        <USwitch
          :model-value="run.holdFailures"
          size="sm"
          label="Hold failures"
          description="A failed test waits here for you to look before the run goes on."
          data-testid="runner-hold-failures"
          @update:model-value="setHold(run, $event)"
        />
        <DesktopRunSession :session="sessionOf(run)!" @announce="announce" />
      </template>
      <details v-if="run.lines.length">
        <summary class="cursor-pointer text-xs text-muted">Output</summary>
        <pre class="mt-2 max-h-72 overflow-auto rounded bg-elevated p-2 text-xs">{{ output(run) }}</pre>
      </details>
    </UCard>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </section>
</template>

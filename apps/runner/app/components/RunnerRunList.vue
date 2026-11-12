<script setup lang="ts">
/**
 * The runs of this window: what each is, where it stands, and Stop while it runs; then, live, its workers as the hub
 * tells them (`DesktopRunSession`, the layer's, as the dashboard's tray shows them): each worker's test, Pause, Step,
 * Resume and the stopped test's page, with **Hold failures**, which keeps a failure no pause bar shows waiting here.
 * The code made at a stop and the locators picked wait above the runs, to copy (`DesktopRunCopyList`). Its output
 * follows. A run nobody attends offers no Hold failures. A run the hub still has that this window holds no entry for (the
 * window was reloaded while it went on) shows live under its name, with Stop.
 */
import { isUnattendedRef } from '@piwitests/core/run-channel';
import type { HubSession } from '@piwitests/core/run-hub';
import { isRunnerRunRef, runnerShellIdOf, type RunnerRun, type RunnerRunStatus } from '~/utils/runner-runs';

const { runs, stopRun, setHold, stopShellRun } = useRunnerRuns();
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

const sessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);

/** The hub's live run of a run of this window, while it runs and the window hears the hub. */
function sessionOf(run: RunnerRun): HubSession | null {
  if (run.status !== 'running') return null;
  return sessions.value.find((session) => isRunnerRunRef(session.ref, run.shellId)) ?? null;
}

/** The hub's live runs no run of this window is: the window was reloaded while they went on. */
const unlisted = computed(() =>
  sessions.value.filter(
    (session) => !session.ended && !runs.value.some((run) => isRunnerRunRef(session.ref, run.shellId)),
  ),
);
/** The runs of `unlisted` whose Stop was asked. */
const stopping = ref(new Set<string>());
function stopUnlisted(session: HubSession) {
  const shellId = runnerShellIdOf(session.ref);
  if (shellId === null) return;
  stopping.value = new Set([...stopping.value, session.ref]);
  void stopShellRun(shellId);
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
    <p v-if="!runs.length && !unlisted.length" class="text-sm text-muted">
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
          v-if="!isUnattendedRef(sessionOf(run)!.ref)"
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
    <UCard v-for="session in unlisted" :key="session.ref" :ui="{ body: 'space-y-2' }" data-testid="runner-unlisted-run">
      <div class="flex items-center gap-3">
        <p class="min-w-0 flex-1 truncate text-xs text-muted">Still running from before the window reloaded</p>
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :disabled="stopping.has(session.ref)"
          @click="stopUnlisted(session)"
        >
          {{ stopping.has(session.ref) ? 'Stopping…' : 'Stop' }}
        </UButton>
      </div>
      <DesktopRunSession :session="session" named @announce="announce" />
    </UCard>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </section>
</template>

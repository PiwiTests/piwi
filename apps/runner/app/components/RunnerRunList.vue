<script setup lang="ts">
/**
 * The runs of this window, newest first, one card each (`RunnerRunCard`), with **Clear finished**, which leaves the
 * running ones alone. While there is none, it says how one comes and opens the instance in the browser. The code made
 * at a stop and the locators picked wait above the runs, to copy (`DesktopRunCopyList`). A run the hub still has that
 * this window holds no entry for (the window was reloaded while it went on) shows live under its name, with Stop.
 */
import type { HubSession } from '@piwitests/core/run-hub';
import { isRunnerRunRef, runnerShellIdOf } from '~/utils/runner-runs';

const { runs, stopShellRun, clearFinished } = useRunnerRuns();
const { connection } = useDesktopTeamRequests();
const hub = useDesktopRunHub();
const words = useRunUiWords();
const { t } = useRunnerWords();

const sessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);

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

const anyFinished = computed(() => runs.value.some((run) => run.status !== 'running'));
const empty = computed(() => !runs.value.length && !unlisted.value.length);
/** The instance, to open from the empty list while connected. */
const instance = computed(() =>
  connection.value.instance && connection.value.state === 'online' ? connection.value.instance : null,
);

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
    <div class="flex min-h-7 items-center gap-3">
      <h2 class="flex-1 text-sm font-semibold text-highlighted">{{ t('runner_runsHeading') }}</h2>
      <UButton
        v-if="anyFinished"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-brush-cleaning"
        data-testid="runner-clear-finished"
        @click="clearFinished"
        >{{ t('runner_clearFinished') }}</UButton
      >
    </div>
    <div
      v-if="empty"
      class="flex flex-col items-center gap-3 rounded-lg border border-dashed border-accented bg-default px-6 py-10 text-center"
      data-testid="runner-no-runs"
    >
      <span class="flex size-12 items-center justify-center rounded-full bg-elevated text-muted">
        <UIcon name="i-lucide-inbox" class="size-6" />
      </span>
      <p class="max-w-sm text-sm text-muted">{{ t('runner_noRuns') }}</p>
      <UButton
        v-if="instance"
        :to="instance"
        target="_blank"
        size="sm"
        color="neutral"
        variant="outline"
        trailing-icon="i-lucide-external-link"
        >{{ t('runner_openInstance', { host: teamInstanceHost(instance, words) }) }}</UButton
      >
    </div>
    <DesktopRunCopyList v-if="hub.state.kept.length" :kept="hub.state.kept" :roots="hub.state.roots" />
    <RunnerRunCard v-for="run in runs" :key="run.key" :run="run" @announce="announce" />
    <UCard
      v-for="session in unlisted"
      :key="session.ref"
      :ui="{ body: 'space-y-3 p-4 sm:p-4' }"
      data-testid="runner-unlisted-run"
    >
      <div class="flex items-center gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
        </span>
        <p class="min-w-0 flex-1 text-xs text-muted">{{ t('runner_stillRunning') }}</p>
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-square"
          :disabled="stopping.has(session.ref)"
          @click="stopUnlisted(session)"
        >
          {{ stopping.has(session.ref) ? t('runner_stopping') : t('runner_stop') }}
        </UButton>
      </div>
      <DesktopRunSession :session="session" named @announce="announce" />
    </UCard>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </section>
</template>

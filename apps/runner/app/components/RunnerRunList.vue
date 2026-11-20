<script setup lang="ts">
/**
 * The runs of this window, in two lists: **Running now**, a card each with its live view (`RunnerRunCard`), and
 * **Finished**, a row each (`RunnerRunRow`), the last to end first, with **Clear finished**. A run the hub still has that this
 * window holds no entry for (the window was reloaded while it went on) shows live under its name, with Stop and Force
 * stop. While
 * there is none, the window says how one comes and opens the instance in the browser; while the instance does not
 * answer, a line above says so. The code made at a stop and the locators picked wait on top, to copy
 * (`DesktopRunCopyList`).
 */
import type { HubSession } from '@piwitests/core/run-hub';
import { runnerFinishedRuns, runnerShellIdOf, runnerUnlistedSessions } from '~/utils/runner-runs';

const { runs, stopShellRun, clearFinished } = useRunnerRuns();
const { connection } = useDesktopTeamRequests();
const hub = useDesktopRunHub();
const words = useRunUiWords();
const { t } = useRunnerWords();

const sessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);
const running = computed(() => runs.value.filter((run) => run.status === 'running'));
const finished = computed(() => runnerFinishedRuns(runs.value));

/** The hub's live runs no run of this window is: the window was reloaded while they went on. */
const unlisted = computed(() => runnerUnlistedSessions(sessions.value, runs.value));
/**
 * The runs of `unlisted` whose Stop was asked, and when, kept while the window shows another view: a second ask (Force
 * stop) kills the process.
 */
const stopping = useState<Record<string, number>>('runner-unlisted-stops', () => ({}));
function stopUnlisted(session: HubSession) {
  const shellId = runnerShellIdOf(session.ref);
  if (shellId === null) return;
  if (stopping.value[session.ref] === undefined) stopping.value = { ...stopping.value, [session.ref]: Date.now() };
  void stopShellRun(shellId);
}

const empty = computed(() => !runs.value.length && !unlisted.value.length);
const host = computed(() => teamInstanceHost(connection.value.instance, words));
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
  <section class="space-y-6" data-testid="runner-runs">
    <div
      v-if="connection.state === 'offline'"
      role="status"
      class="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-default"
      data-testid="runner-offline"
    >
      <UIcon name="i-lucide-wifi-off" class="mt-0.5 size-4 shrink-0 text-warning" />
      <p class="min-w-0">{{ t('runner_offline', { host }) }}</p>
    </div>
    <DesktopRunCopyList v-if="hub.state.kept.length" :kept="hub.state.kept" :roots="hub.state.roots" />

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
        >{{ t('runner_openInstance', { host }) }}</UButton
      >
    </div>

    <div v-if="running.length || unlisted.length" class="space-y-3" data-testid="runner-running">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-highlighted">
        {{ t('runner_runningHeading') }}
        <UBadge size="sm" color="primary" variant="subtle">{{ words.number(running.length + unlisted.length) }}</UBadge>
      </h2>
      <RunnerRunCard v-for="run in running" :key="run.key" :run="run" @announce="announce" />
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
          <DesktopRunStopButton
            :stopping="stopping[session.ref] !== undefined"
            :since="stopping[session.ref]"
            @stop="stopUnlisted(session)"
            @force="stopUnlisted(session)"
          />
        </div>
        <DesktopRunSession :session="session" named @announce="announce" />
      </UCard>
    </div>

    <div v-if="finished.length" class="space-y-3" data-testid="runner-finished">
      <div class="flex min-h-7 items-center gap-3">
        <h2 class="flex flex-1 items-center gap-2 text-sm font-semibold text-highlighted">
          {{ t('runner_finishedHeading') }}
          <UBadge size="sm" color="neutral" variant="subtle">{{ words.number(finished.length) }}</UBadge>
        </h2>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-brush-cleaning"
          data-testid="runner-clear-finished"
          @click="clearFinished"
          >{{ t('runner_clearFinished') }}</UButton
        >
      </div>
      <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default bg-default">
        <RunnerRunRow v-for="run in finished" :key="run.key" :run="run" />
      </ul>
    </div>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </section>
</template>

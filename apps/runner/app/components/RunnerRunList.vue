<script setup lang="ts">
/**
 * The runs of this window in the layer's runs panel (`DesktopRunsPanel`), as the dashboard's Local runs tray shows its
 * own. On the left, **Running now**, with the runs the hub still has that this window holds no entry for (the window
 * was reloaded while they went on), then **Finished**, the last to end first, with **Clear finished**: each line says
 * how its run stands, whether a test of it waits at a stop, and how long it ran. On the right, the run shown
 * (`RunnerRunDetail`; a run the window holds no entry for shows live under its name, with Stop and Force stop): the one
 * the person chose (`chosen`), else a running run a test of which waits at a stop, else the newest running, else the
 * last to end. A run the person confirms shows (`startRequest`); a stop the window hears shows its run, unless the
 * keyboard is in the run shown. Every running run stays drawn while another shows, so its live view goes on. While
 * there is none, the window says how one comes and opens the instance in the browser; while the instance does not
 * answer, a line above says so. The code made at a stop and the locators picked wait on top of the run shown, to copy
 * (`DesktopRunCopyList`).
 */
import type { HubSession } from '@piwitests/core/run-hub';
import type { DesktopRunsPanel } from '#components';
import { desktopRunName, desktopRunWaits } from '@piwitests/run-ui/run-view';
import {
  isRunnerRunRef,
  runnerFinishedRuns,
  runnerShellIdOf,
  runnerUnlistedSessions,
  type RunnerRun,
} from '~/utils/runner-runs';

const { runs, chosen, stopShellRun, clearFinished } = useRunnerRuns();
const { connection } = useDesktopTeamRequests();
const hub = useDesktopRunHub();
const words = useRunUiWords();
const { t } = useRunnerWords();
const view = useRunnerRunView();

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

/** Whether a test of a run going on waits at a stop, by the hub's live run of it. */
function waits(run: RunnerRun): boolean {
  if (run.status !== 'running') return false;
  const session = sessions.value.find((each) => isRunnerRunRef(each.ref, run.shellId));
  return !!session && desktopRunWaits(session);
}

/**
 * The key of the run shown: the one chosen while the list holds it, else a running run a test of which waits at a
 * stop, else the newest running, else the last to end.
 */
const shownKey = computed<number | string | null>(() => {
  const picked = chosen.value;
  if (typeof picked === 'number' && runs.value.some((run) => run.key === picked)) return picked;
  if (typeof picked === 'string' && unlisted.value.some((session) => session.ref === picked)) return picked;
  return (
    running.value.find(waits)?.key ??
    unlisted.value.find(desktopRunWaits)?.ref ??
    running.value[0]?.key ??
    unlisted.value[0]?.ref ??
    finished.value[0]?.key ??
    null
  );
});

// The run shown is kept as chosen, so it does not move as other runs go on.
watch(
  shownKey,
  (key) => {
    if (key !== null) chosen.value = key;
  },
  { immediate: true },
);

const panel = useTemplateRef<InstanceType<typeof DesktopRunsPanel>>('panel');

// A stop shows its run, unless the person works in the run shown; its line marks it all the same.
const stopHeard = hub.onStop((session) => {
  if (panel.value?.isWorking()) return;
  const run = runs.value.find((each) => isRunnerRunRef(session.ref, each.shellId));
  chosen.value = run ? run.key : session.ref;
});
onScopeDispose(stopHeard);

/** The runs drawn on the right, the one shown visible: every running run, so showing another ends none of their views. */
const drawn = computed(() => {
  const shownEnded = finished.value.find((run) => run.key === shownKey.value);
  return shownEnded ? [...running.value, shownEnded] : running.value;
});

/** A run's line in the list. */
function lineOf(run: RunnerRun) {
  const status = view.status(run);
  return {
    key: run.key,
    title: view.name(run),
    status: { label: status.words, color: status.tone },
    waits: waits(run),
    duration: view.duration(run),
  };
}

const groups = computed(() => [
  {
    key: 'running',
    title: t('runner_runningHeading'),
    items: [
      ...running.value.map(lineOf),
      ...unlisted.value.map((session) => ({
        key: session.ref,
        title: desktopRunName(session, words),
        status: {
          label: stopping.value[session.ref] === undefined ? t('runner_statusRunning') : t('runner_stopping'),
          color: 'primary' as const,
        },
        waits: desktopRunWaits(session),
      })),
    ],
  },
  { key: 'finished', title: t('runner_finishedHeading'), items: finished.value.map(lineOf) },
]);

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
  <section class="flex min-h-0 flex-1 flex-col" data-testid="runner-runs">
    <div
      v-if="connection.state === 'offline'"
      role="status"
      class="flex shrink-0 items-start gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-default"
      data-testid="runner-offline"
    >
      <UIcon name="i-lucide-wifi-off" class="mt-0.5 size-4 shrink-0 text-warning" />
      <p class="min-w-0">{{ t('runner_offline', { host }) }}</p>
    </div>

    <div v-if="empty" class="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <DesktopRunCopyList v-if="hub.state.kept.length" :kept="hub.state.kept" :roots="hub.state.roots" />
      <div
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
    </div>

    <div v-else class="flex min-h-80 flex-1 flex-col">
      <DesktopRunsPanel ref="panel" :groups="groups" :shown="shownKey" @select="chosen = $event">
        <template #group-actions="{ group }">
          <UButton
            v-if="group.key === 'finished'"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-brush-cleaning"
            data-testid="runner-clear-finished"
            @click="clearFinished"
            >{{ t('runner_clearFinished') }}</UButton
          >
        </template>
        <DesktopRunCopyList v-if="hub.state.kept.length" :kept="hub.state.kept" :roots="hub.state.roots" class="mb-4" />
        <RunnerRunDetail
          v-for="run in drawn"
          v-show="run.key === shownKey"
          :key="run.key"
          :run="run"
          @announce="announce"
        />
        <article
          v-for="session in unlisted"
          v-show="session.ref === shownKey"
          :key="session.ref"
          :aria-label="desktopRunName(session, words)"
          class="space-y-3"
          data-testid="runner-unlisted-run"
        >
          <div class="flex flex-wrap items-center gap-3">
            <p class="min-w-0 flex-1 basis-48 text-xs text-muted">{{ t('runner_stillRunning') }}</p>
            <DesktopRunStopButton
              :stopping="stopping[session.ref] !== undefined"
              :since="stopping[session.ref]"
              @stop="stopUnlisted(session)"
              @force="stopUnlisted(session)"
            />
          </div>
          <DesktopRunSession :session="session" named @announce="announce" />
        </article>
      </DesktopRunsPanel>
    </div>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </section>
</template>

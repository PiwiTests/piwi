<script setup lang="ts">
/**
 * Desktop shell only: the "Local runs" tray — a fixed bottom-right panel
 * listing this session's local test runs with their streaming consoles, the
 * desktop cousin of a browser's downloads tray. Mounted once in the default
 * layout; runs keep going while it is closed, and closing it never stops
 * anything. Renders nothing without the IPC bridge.
 *
 * Each run shows its workers live, as the bundled server, the hub of the runs
 * the shell starts, tells them (`useDesktopRunHub`): the test each one runs
 * and, at a stop, the page, the controls and the code a stop can make, to copy
 * (`DesktopRunCopyList`). The window holds the hub's stream from a plugin
 * (`desktop-run-hub.client.ts`), which opens the tray on every stop it hears;
 * here, the stop's run expands, its worker scrolls into view, and the live
 * region reads it out; a stop that opens the tray shows its worker's tab, in a
 * run of several workers, which show one at a time as in Piwi Picker's Runs
 * window (`DesktopRunSession`). A worker's **Watch** shows its page as its test
 * runs, and at each stop (`DesktopRunLaneView`). The tray also
 * opens on the worker the run page's **Show its page** names (`showWorker`),
 * and on the first test that waits at the system tray menu's **Show the
 * stopped test**, its run expanded, its tab shown and the focus on that worker. A running
 * run's **Hold failures** switch, off by default and on from the start for a
 * reproduction,
 * makes a failure no pause bar shows wait at its line (`hold` for its live
 * steps, and `show`, said by the plugin from the store's `holds`, for its
 * steps to come); it shows the run's own, which Piwi Picker or an agent may
 * change too. A run nobody attends (a Flake Lab, a
 * bisect, a run repeating its tests or in UI mode) holds none, and its switch
 * says why.
 *
 * A run's output can move to a separate window of the app
 * (`DesktopRunOutputWindow`), which stays open when the tray closes, and
 * closes with the run's entry, with this component, and when the dashboard
 * window loads another page.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import {
  flakeLabOutcome,
  localRunCompareTo,
  localRunDuration,
  localRunTitle,
  type LocalRun,
} from '~/composables/useDesktopLocalRuns';
import { desktopRunOf, desktopStopSaid, desktopWorkerKey } from '~/utils/desktop-run-view';
import { endedAtStopWords } from '@piwitests/run-model/outcome';
import { englishRunSpeaker } from '@piwitests/run-model/words';

const store = useDesktopLocalRuns();
const { runs, trayOpen, shownWorker, activeCount, trayMounts } = store;
const toast = useToast();

const available = ref(false);
onMounted(() => {
  available.value = !!tauriCore();
});

const hub = useDesktopRunHub();
const liveSessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);

/** The run of the tray a hub's run is, by the name its step gave it; none for a run another window started. */
function runOf(session: HubSession): LocalRun | undefined {
  const ref = desktopRunOf(session.ref);
  return runs.value.find((run) => run.hubRefs.includes(ref));
}

/** The hub's live runs of a run of the tray: those of its steps' names. */
function sessionsOf(run: LocalRun): HubSession[] {
  return liveSessions.value.filter((session) => run.hubRefs.includes(desktopRunOf(session.ref)));
}

/** The hub's live runs no run of the tray names: another window started them, or this one before a reload. */
const otherSessions = computed(() => liveSessions.value.filter((session) => !runOf(session)));

/** What the live region reads out: a test stopped, what a command answered. */
const announcement = ref('');
function announce(text: string) {
  announcement.value = '';
  requestAnimationFrame(() => {
    announcement.value = text;
  });
}

/**
 * Every stop the window hears is shown: the plugin opens the tray, its run expands, its worker scrolls into view, and
 * the live region reads it out.
 */
async function heardStop(session: HubSession, worker: HubWorker) {
  const stop = worker.stop;
  if (!stop) return;
  // The stop opened the tray: its worker's tab shows.
  if (!openShown) hub.chooseTab(session.ref, worker.parallelIndex);
  const run = runOf(session);
  if (run) expandedByKey.value = { ...expandedByKey.value, [run.key]: true };
  announce(desktopStopSaid(session, worker, stop));
  await nextTick();
  document
    .querySelector<HTMLElement>(`[data-worker="${desktopWorkerKey(session.ref, worker.worker)}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

/** Whether the tray showed open before the stop it hears now: the plugin opens it first, on every stop. */
let openShown = trayOpen.value;
watch(
  trayOpen,
  (open) => {
    openShown = open;
  },
  { flush: 'post' },
);

let stopListening: (() => void) | null = null;
onMounted(() => {
  trayMounts.value++;
  stopListening = hub.onStop((session, worker) => void heardStop(session, worker));
});
onBeforeUnmount(() => {
  trayMounts.value--;
  stopListening?.();
});

// This component is mounted once in the layout, which makes it the natural
// owner of the store's Piwi-run correlation: every server run event (the
// reporter checking in counts) re-checks pending local runs.
useRunStream(() => store.correlatePiwiRuns());

/** Manual expand/collapse choices; unset falls back to the default below. */
const expandedByKey = ref<Record<number, boolean>>({});

function isExpanded(run: LocalRun): boolean {
  return expandedByKey.value[run.key] ?? (run.status === 'running' || run.key === runs.value[0]?.key);
}

function toggleExpanded(run: LocalRun) {
  expandedByKey.value = { ...expandedByKey.value, [run.key]: !isExpanded(run) };
}

/**
 * A worker the window was asked to show (the run page's Show its page, the system tray's Show the stopped test): its run
 * expands, its tab shows, and the focus moves to the worker once it is drawn.
 */
async function showAsked(shown: { ref: string; worker: number } | null) {
  if (!shown) return;
  shownWorker.value = null;
  const session = hub.state.sessions[shown.ref];
  const run = session ? runOf(session) : undefined;
  if (run) expandedByKey.value = { ...expandedByKey.value, [run.key]: true };
  const lane = session?.workers.find((worker) => worker.worker === shown.worker)?.parallelIndex;
  if (lane !== undefined) hub.chooseTab(shown.ref, lane);
  await nextTick();
  document.querySelector<HTMLElement>(`[data-worker="${desktopWorkerKey(shown.ref, shown.worker)}"]`)?.focus();
}
watch(shownWorker, (shown) => void showAsked(shown));
// One asked before this tray was mounted, as the page changed to one that holds it.
onMounted(() => void showAsked(shownWorker.value));

/** The runs whose output shows in a separate window instead of the tray. */
const separateByKey = ref<Record<number, boolean>>({});
const separateRuns = computed(() => runs.value.filter((run) => separateByKey.value[run.key]));

function setSeparate(run: LocalRun, on: boolean) {
  separateByKey.value = { ...separateByKey.value, [run.key]: on };
}

/** What the run's window button does: open its output in a separate window, or bring it back here. */
function separateLabel(run: LocalRun): string {
  return separateByKey.value[run.key] ? 'Show the output here' : 'Open the output in a separate window';
}

function separateClosed(run: LocalRun, opened: boolean) {
  setSeparate(run, false);
  if (!opened) {
    toast.add({
      title: 'Could not open a separate window',
      description: 'The output stays in the tray.',
      color: 'error',
    });
  }
}

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });

function duration(run: LocalRun): string {
  return localRunDuration(run.startedAt, run.finishedAt, now.value);
}

/** How many tests of a run's steps were ended at a stop (End the test), as the hub heard them end. */
function endedAtStopIn(run: LocalRun): number {
  return Object.entries(hub.state.endedAtStop).reduce(
    (sum, [ref, count]) => sum + (run.hubRefs.includes(desktopRunOf(ref)) ? count : 0),
    0,
  );
}

function badge(run: LocalRun): { label: string; color: 'info' | 'success' | 'error' | 'neutral' } {
  switch (run.status) {
    case 'running':
      return { label: localRunProgressLabel(run), color: run.stopRequested ? 'neutral' : 'info' };
    case 'passed': {
      if (run.kind === 'flake') {
        return flakeLabOutcome(run.exitCode) === 'reproduced'
          ? { label: 'Reproduced', color: 'success' }
          : { label: 'Not reproduced', color: 'neutral' };
      }
      // A test ended at a stop is skipped: the run passed, marked so.
      const ended = endedAtStopWords(endedAtStopIn(run), englishRunSpeaker);
      return { label: ended ? `Passed · ${ended}` : 'Passed', color: 'success' };
    }
    case 'failed':
      return { label: run.exitCode != null ? `Failed (exit ${run.exitCode})` : 'Failed', color: 'error' };
    case 'stopped':
      return { label: 'Stopped', color: 'neutral' };
    default:
      return { label: 'Could not run', color: 'error' };
  }
}

const hasFinished = computed(() => runs.value.some((r) => r.status !== 'running'));

/** The row's second line: the project, then the command the current step runs, when it has one. */
function runDetail(run: LocalRun): string {
  const project = run.projectLabel || `Project ${run.projectId}`;
  const command = run.steps[run.stepIndex]?.display;
  return command ? `${project} · ${command}` : project;
}
</script>

<template>
  <Teleport to="body">
    <!-- Outside the tray, so a stop that opens it is read out from a region already there. -->
    <p v-if="available" class="sr-only" aria-live="polite">{{ announcement }}</p>
    <section
      v-if="available && trayOpen"
      aria-label="Local runs"
      class="fixed bottom-4 right-4 z-40 w-[600px] max-w-[calc(100vw-2rem)] rounded-lg border border-default bg-default shadow-xl"
    >
      <header class="flex items-center gap-2 px-3 py-2 border-b border-default">
        <UIcon name="i-lucide-terminal" class="size-4 text-muted shrink-0" />
        <h2 class="text-sm font-semibold">Local runs</h2>
        <UBadge v-if="activeCount > 0" color="info" variant="subtle" size="sm">{{ activeCount }} active</UBadge>
        <span class="flex-1" />
        <UTooltip v-if="hasFinished" text="Clear finished runs">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-trash-2"
            aria-label="Clear finished runs"
            @click="store.clearFinished()"
          />
        </UTooltip>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          aria-label="Close local runs"
          @click="trayOpen = false"
        />
      </header>

      <div class="max-h-[70vh] overflow-y-auto divide-y divide-default">
        <p v-if="runs.length === 0 && otherSessions.length === 0" class="px-3 py-6 text-sm text-muted text-center">
          No local runs yet — start one from the Re-run button of a run, an execution or a cluster, or a test's Run this
          test.
        </p>

        <DesktopRunCopyList :kept="hub.state.kept" :roots="hub.state.roots" />

        <section v-if="otherSessions.length" aria-label="Other runs of the desktop app" class="px-3 py-2 space-y-2">
          <DesktopRunSession
            v-for="session in otherSessions"
            :key="session.ref"
            :session="session"
            named
            @announce="announce"
          />
        </section>

        <article v-for="run in runs" :key="run.key" class="px-3 py-2">
          <div class="flex items-center gap-2 min-w-0">
            <UBadge :color="badge(run).color" variant="subtle" size="sm" class="shrink-0">
              {{ badge(run).label }}
            </UBadge>
            <span class="text-sm font-medium truncate flex-1 min-w-0" :title="localRunTitle(run)">
              {{ localRunTitle(run) }}
            </span>
            <span class="text-xs text-muted tabular-nums shrink-0">{{ duration(run) }}</span>
            <UTooltip v-if="run.status === 'running' && run.stopRequested" text="Kill the process without waiting">
              <UButton size="xs" color="error" variant="solid" icon="i-lucide-square" @click="store.stopRun(run)">
                Force stop
              </UButton>
            </UTooltip>
            <UButton
              v-else-if="run.status === 'running'"
              size="xs"
              color="error"
              variant="soft"
              icon="i-lucide-square"
              @click="store.stopRun(run)"
            >
              Stop
            </UButton>
            <UTooltip
              v-else-if="(run.kind !== 'flake' || run.flake) && run.kind !== 'request'"
              :text="`Run again: ${localRunTitle(run)}, with the same options`"
            >
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                icon="i-lucide-rotate-ccw"
                aria-label="Run again"
                @click="store.rerun(run)"
              />
            </UTooltip>
            <UTooltip :text="separateLabel(run)">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="separateByKey[run.key] ? 'i-lucide-panel-bottom-open' : 'i-lucide-app-window'"
                :aria-label="separateLabel(run)"
                @click="setSeparate(run, !separateByKey[run.key])"
              />
            </UTooltip>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="isExpanded(run) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-left'"
              :aria-label="isExpanded(run) ? 'Collapse output' : 'Expand output'"
              @click="toggleExpanded(run)"
            />
          </div>
          <p class="mt-0.5 font-mono text-[11px] text-muted truncate" :title="runDetail(run)">{{ runDetail(run) }}</p>
          <DesktopRunHoldSwitch
            v-if="run.status === 'running'"
            :run="run"
            :described-id="`desktop-run-hold-${run.key}`"
            class="mt-1.5"
            data-shot="desktop-run-hold"
          />
          <div v-if="run.piwiRunId != null" class="mt-1.5 flex flex-wrap items-center gap-2">
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-external-link"
              :to="`/test-runs/${run.piwiRunId}`"
              @click="trayOpen = false"
            >
              Open run #{{ run.piwiRunId }}
            </UButton>
            <UButton
              v-if="run.sourceRunId != null && run.sourceRunId !== run.piwiRunId"
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-git-compare"
              :to="localRunCompareTo(run)!"
              :title="`What changed between run #${run.sourceRunId}, where these tests come from, and this one`"
              @click="trayOpen = false"
            >
              Compare with run #{{ run.sourceRunId }}
            </UButton>
          </div>
          <template v-if="isExpanded(run)">
            <DesktopRunSession
              v-for="session in sessionsOf(run)"
              :key="session.ref"
              :session="session"
              class="mt-2"
              @announce="announce"
            />
            <p v-if="separateByKey[run.key]" class="mt-2 text-xs text-muted">The output is in a separate window.</p>
            <DesktopLocalRunConsole v-else :lines="run.lines" class="mt-2" />
          </template>
        </article>
      </div>
    </section>

    <DesktopRunOutputWindow
      v-for="run in separateRuns"
      :key="run.key"
      :run="run"
      :title="localRunTitle(run)"
      :status="badge(run)"
      :detail="runDetail(run)"
      @stop="store.stopRun(run)"
      @closed="(opened: boolean) => separateClosed(run, opened)"
    />
  </Teleport>
</template>

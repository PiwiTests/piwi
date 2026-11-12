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
 * A running run counts its tests as its own process does (`3 of 9 tests · 1
 * failed`, `useDesktopRunBadge`); a failed one that reported a Piwi run leads
 * to its failure (**Open the failure**, `failurePage`). **Compact list**, a
 * choice the window remembers, shows each run as one line (its state, name,
 * progress and the one action it needs now: show its stop, stop it, open its
 * failure or its run, run it again), a click expanding it to its whole card.
 *
 * A run's output can move to a separate window of the app (`separate`,
 * `DesktopRunOutputWindows`), which stays open when the tray closes or
 * reloads, and closes with the run's entry or when the person closes it.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import {
  localRunCompareTo,
  localRunDetail,
  localRunDuration,
  localRunProgressLabel,
  localRunTitle,
  type LocalRun,
} from '~/composables/useDesktopLocalRuns';
import { desktopRunOf } from '~/utils/desktop-run-view';
import { desktopStopSaid, desktopWorkerKey } from '@piwitests/run-ui/run-view';
import { progressWords } from '@piwitests/run-model/outcome';
import { englishRunSpeaker } from '@piwitests/run-model/words';

const store = useDesktopLocalRuns();
const { runs, trayOpen, shownWorker, activeCount, trayMounts, separate } = store;
const { badge, count } = useDesktopRunBadge();

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

/** The hub's live runs no run of the tray names: another window started them. */
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

/** Each run as one line, a click expanding it: the window's choice, kept. */
const compact = useLocalStorage('piwi:desktop-local-runs-compact', false);

/** Manual expand/collapse choices; unset falls back to the default below. */
const expandedByKey = ref<Record<number, boolean>>({});

/** A run shows whole: in the compact list once opened, else by default while it runs, and the newest one. */
function isExpanded(run: LocalRun): boolean {
  const chosen = expandedByKey.value[run.key];
  if (compact.value) return chosen ?? false;
  return chosen ?? (run.status === 'running' || run.key === runs.value[0]?.key);
}

function setExpanded(run: LocalRun, on: boolean) {
  expandedByKey.value = { ...expandedByKey.value, [run.key]: on };
}

/** Moves the focus to a worker once it is drawn. */
async function focusWorker(ref: string, worker: number) {
  await nextTick();
  document.querySelector<HTMLElement>(`[data-worker="${desktopWorkerKey(ref, worker)}"]`)?.focus();
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
  if (run) setExpanded(run, true);
  const lane = session?.workers.find((worker) => worker.worker === shown.worker)?.parallelIndex;
  if (lane !== undefined) hub.chooseTab(shown.ref, lane);
  await focusWorker(shown.ref, shown.worker);
}
watch(shownWorker, (shown) => void showAsked(shown));
// One asked before this tray was mounted, as the page changed to one that holds it.
onMounted(() => void showAsked(shownWorker.value));

/** The first worker of a run that stands at a stop, with its run on the hub; null while none does. */
function stoppedOf(run: LocalRun): { session: HubSession; worker: HubWorker } | null {
  for (const session of sessionsOf(run)) {
    const worker = session.workers.find((one) => one.state === 'stopped');
    if (worker) return { session, worker };
  }
  return null;
}

/** What the run's window button does: open its output in a separate window, or bring it back here. */
function separateLabel(run: LocalRun): string {
  return separate.value[run.key] ? 'Show the output here' : 'Open the output in a separate window';
}

function toggleSeparate(run: LocalRun) {
  separate.value = { ...separate.value, [run.key]: !separate.value[run.key] };
}

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });

function duration(run: LocalRun): string {
  return localRunDuration(run.startedAt, run.finishedAt, now.value);
}

const hasFinished = computed(() => runs.value.some((r) => r.status !== 'running'));

/** Opens the page a failed run's end leads to: its first failure, else its run. */
async function openFailure(run: LocalRun) {
  const page = await store.failurePage(run);
  trayOpen.value = false;
  await navigateTo(page);
}

/** Whether a run offers Run again: one it can start as it ran. */
function rerunnable(run: LocalRun): boolean {
  return (run.kind !== 'flake' || !!run.flake) && run.kind !== 'request';
}

// ── The compact list ──────────────────────────────────────────────────────────────────────────────────────────────

/** A run's state on its line: waiting at a stop, stopping, running, or how it ended. */
function lineState(run: LocalRun): { label: string; color: 'info' | 'warning' | 'neutral' | 'success' | 'error' } {
  if (run.status !== 'running') {
    const ended = badge(run);
    return { label: ended.label, color: ended.color as 'neutral' | 'success' | 'error' };
  }
  if (run.stopRequested) return { label: 'Stopping…', color: 'neutral' };
  if (stoppedOf(run)) return { label: 'Waiting', color: 'warning' };
  return { label: 'Running', color: 'info' };
}

/** How far a run is on its line: its tests as its process counts them, else its phase; empty when nothing says. */
function lineProgress(run: LocalRun): string {
  const counted = count(run);
  if (counted) return progressWords(counted, englishRunSpeaker).join(' · ');
  if (run.status !== 'running') return duration(run);
  const label = localRunProgressLabel(run);
  return label === 'Running…' || label === 'Stopping…' ? '' : label;
}

/** The one action a run needs now, on its line. */
interface LineAction {
  label: string;
  icon: string;
  color: 'error' | 'neutral' | 'warning';
  run: () => void;
}

function lineAction(run: LocalRun): LineAction | null {
  if (run.status === 'running') {
    const stopped = stoppedOf(run);
    if (stopped) {
      return {
        label: 'Show the stop',
        icon: 'i-lucide-circle-pause',
        color: 'warning',
        run: () => {
          setExpanded(run, true);
          hub.chooseTab(stopped.session.ref, stopped.worker.parallelIndex);
          void focusWorker(stopped.session.ref, stopped.worker.worker);
        },
      };
    }
    return run.stopRequested
      ? { label: 'Force stop', icon: 'i-lucide-square', color: 'error', run: () => void store.stopRun(run) }
      : { label: 'Stop', icon: 'i-lucide-square', color: 'error', run: () => void store.stopRun(run) };
  }
  if (run.status === 'failed' && run.piwiRunId != null) {
    return {
      label: 'Open the failure',
      icon: 'i-lucide-external-link',
      color: 'neutral',
      run: () => void openFailure(run),
    };
  }
  if (run.piwiRunId != null) {
    const to = `/test-runs/${run.piwiRunId}`;
    return {
      label: `Open run #${run.piwiRunId}`,
      icon: 'i-lucide-external-link',
      color: 'neutral',
      run: () => {
        trayOpen.value = false;
        void navigateTo(to);
      },
    };
  }
  if (rerunnable(run)) {
    return { label: 'Run again', icon: 'i-lucide-rotate-ccw', color: 'neutral', run: () => void store.rerun(run) };
  }
  return null;
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
      :data-compact="compact || undefined"
    >
      <header class="flex items-center gap-2 px-3 py-2 border-b border-default">
        <UIcon name="i-lucide-terminal" class="size-4 text-muted shrink-0" />
        <h2 class="text-sm font-semibold">Local runs</h2>
        <UBadge v-if="activeCount > 0" color="info" variant="subtle" size="sm">{{ activeCount }} active</UBadge>
        <span class="flex-1" />
        <UTooltip :text="compact ? 'Show each run whole' : 'Show each run as one line'">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-rows-3"
            aria-label="Compact list"
            :aria-pressed="compact"
            :class="compact ? PRESSED_TOGGLE_CLASS : ''"
            @click="compact = !compact"
          />
        </UTooltip>
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

        <template v-for="run in runs" :key="run.key">
          <div
            v-if="compact && !isExpanded(run)"
            class="flex items-center gap-2 px-3 py-1.5 min-w-0"
            data-shot="desktop-run-line"
            :data-run="run.key"
          >
            <button
              type="button"
              class="flex flex-1 items-center gap-2 min-w-0 rounded-md py-0.5 text-left hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
              aria-expanded="false"
              :title="`Show ${localRunTitle(run)} whole`"
              @click="setExpanded(run, true)"
            >
              <UBadge :color="lineState(run).color" variant="subtle" size="sm" class="shrink-0">
                {{ lineState(run).label }}
              </UBadge>
              <span class="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                <span class="text-sm font-medium truncate min-w-0 sm:flex-1">{{ localRunTitle(run) }}</span>
                <span v-if="lineProgress(run)" class="text-xs text-muted tabular-nums truncate sm:shrink-0">
                  {{ lineProgress(run) }}
                </span>
              </span>
            </button>
            <UButton
              v-if="lineAction(run)"
              size="xs"
              :color="lineAction(run)!.color"
              variant="soft"
              :icon="lineAction(run)!.icon"
              class="shrink-0"
              @click="lineAction(run)!.run()"
            >
              {{ lineAction(run)!.label }}
            </UButton>
          </div>
          <article v-else class="px-3 py-2" :data-run="run.key">
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
              <UTooltip v-else-if="rerunnable(run)" :text="`Run again: ${localRunTitle(run)}, with the same options`">
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
                  :icon="separate[run.key] ? 'i-lucide-panel-bottom-open' : 'i-lucide-app-window'"
                  :aria-label="separateLabel(run)"
                  @click="toggleSeparate(run)"
                />
              </UTooltip>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="isExpanded(run) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-left'"
                :aria-label="compact ? 'Show as one line' : isExpanded(run) ? 'Collapse output' : 'Expand output'"
                @click="setExpanded(run, !isExpanded(run))"
              />
            </div>
            <p class="mt-0.5 font-mono text-[11px] text-muted truncate" :title="localRunDetail(run)">
              {{ localRunDetail(run) }}
            </p>
            <DesktopRunHoldSwitch
              v-if="run.status === 'running'"
              :run="run"
              :described-id="`desktop-run-hold-${run.key}`"
              class="mt-1.5"
              data-shot="desktop-run-hold"
            />
            <div v-if="run.piwiRunId != null" class="mt-1.5 flex flex-wrap items-center gap-2">
              <UButton
                v-if="run.status === 'failed'"
                size="xs"
                color="neutral"
                variant="outline"
                icon="i-lucide-external-link"
                @click="openFailure(run)"
              >
                Open the failure
              </UButton>
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
              <p v-if="separate[run.key]" class="mt-2 text-xs text-muted">The output is in a separate window.</p>
              <DesktopLocalRunConsole v-else :lines="run.lines" class="mt-2" />
            </template>
          </article>
        </template>
      </div>
    </section>
  </Teleport>
</template>

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
 * (`DesktopRunCopyList`). The window holds the hub's stream only while a run
 * of the tray runs or the hub still has a live run: while it does, a headless
 * stop waits for the window, so the tray opens on every stop it hears, and a
 * notification says so of a failure or a `page.pause()` when the window is in
 * the background. A running run's **Hold failures** switch, off by default
 * and on from the start for a reproduction, makes a failure no pause bar shows
 * wait at its line (`show`); a run nobody attends (a Flake Lab, a bisect, a
 * run repeating its tests or in UI mode) holds none, and its switch says why.
 *
 * A run's output can move to a separate window of the app
 * (`DesktopRunOutputWindow`), which stays open when the tray closes, and
 * closes with the run's entry, with this component, and when the dashboard
 * window loads another page.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { isUnattendedDesktopRun } from '#shared/desktop-runs';
import {
  flakeLabOutcome,
  localRunCompareTo,
  localRunDuration,
  localRunTitle,
  type LocalRun,
} from '~/composables/useDesktopLocalRuns';
import {
  desktopHoldRefusal,
  desktopHoldsByDefault,
  desktopRunName,
  desktopRunOf,
  desktopStopPlace,
  desktopWorkerTest,
} from '~/utils/desktop-run-view';

const store = useDesktopLocalRuns();
const { runs, trayOpen, activeCount } = store;
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

/** The hub's live runs no run of the tray names: another window of the app started them. */
const otherSessions = computed(() => liveSessions.value.filter((session) => !runOf(session)));

// The stream, only while it has something to show: a run of the tray runs, or the hub still has a live one.
watch(
  () => available.value && (activeCount.value > 0 || liveSessions.value.length > 0),
  (on) => hub.want(on),
  { immediate: true },
);

/** What the live region reads out: a test stopped, what a command answered. */
const announcement = ref('');
function announce(text: string) {
  announcement.value = '';
  requestAnimationFrame(() => {
    announcement.value = text;
  });
}

/**
 * Every stop the window hears is shown: the tray opens on its run, and the live region reads it out. A failure and a
 * `page.pause()` are also said by the system while the window is in the background; a step, a pause or a line run to,
 * which the person's own controls asked for here or in Piwi Picker, is not.
 */
function heardStop(session: HubSession, worker: HubWorker) {
  const stop = worker.stop;
  if (!stop) return;
  trayOpen.value = true;
  const run = runOf(session);
  if (run) expandedByKey.value = { ...expandedByKey.value, [run.key]: true };
  const test = desktopWorkerTest(worker) ?? desktopRunName(session);
  const place = desktopStopPlace(stop, session.root);
  const said = stop.reason === 'failure' ? `${test} failed at ${place}.` : `${test} stopped at ${place}.`;
  announce(said);
  if (stop.reason !== 'failure' && stop.reason !== 'page-pause') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden && document.hasFocus()) return;
  try {
    new Notification(stop.reason === 'failure' ? 'A test failed and waits' : 'A test waits at page.pause()', {
      body: said,
    });
  } catch {
    // Notifications unavailable in this webview — the tray still shows the stop.
  }
}

let stopListening: (() => void) | null = null;
onMounted(() => {
  stopListening = hub.onStop(heardStop);
});
onBeforeUnmount(() => {
  stopListening?.();
  hub.want(false);
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

/** Each run's Hold failures choice; unset falls back to its kind's (`desktopHoldsByDefault`). */
const holdByKey = ref<Record<number, boolean>>({});

/** Why a run holds no failure whatever is chosen: one nobody attends, by its kind or as the hub names its steps. */
function holdRefusal(run: LocalRun): string | null {
  const refused = desktopHoldRefusal(run);
  if (refused) return refused;
  return sessionsOf(run).some((session) => isUnattendedDesktopRun(session.ref))
    ? 'Nobody attends a run of this kind: it goes on past each failure.'
    : null;
}

function holdsFailures(run: LocalRun): boolean {
  return !holdRefusal(run) && (holdByKey.value[run.key] ?? desktopHoldsByDefault(run));
}

function setHold(run: LocalRun, on: boolean) {
  holdByKey.value = { ...holdByKey.value, [run.key]: on };
}

/**
 * The runs the window shows live, so a failure no pause bar shows is held in them: the running ones whose Hold failures
 * is on, by each step's name as the step starts, before its workers connect, so a failure right after they do waits
 * too. Opening or closing the tray, or a run's part of it, changes nothing.
 */
const shownRefs = computed(() => {
  const held = runs.value.filter((run) => run.status === 'running' && holdsFailures(run));
  return [...new Set(held.flatMap((run) => run.hubRefs))].sort();
});
watch(
  () => shownRefs.value.join(' '),
  () => hub.show(shownRefs.value),
  { immediate: true },
);

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });

function duration(run: LocalRun): string {
  return localRunDuration(run.startedAt, run.finishedAt, now.value);
}

function badge(run: LocalRun): { label: string; color: 'info' | 'success' | 'error' | 'neutral' } {
  switch (run.status) {
    case 'running':
      return { label: localRunProgressLabel(run), color: run.stopRequested ? 'neutral' : 'info' };
    case 'passed':
      if (run.kind === 'flake') {
        return flakeLabOutcome(run.exitCode) === 'reproduced'
          ? { label: 'Reproduced', color: 'success' }
          : { label: 'Not reproduced', color: 'neutral' };
      }
      return { label: 'Passed', color: 'success' };
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
              v-else-if="run.kind !== 'flake' || run.flake"
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
          <div
            v-if="run.status === 'running'"
            class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1"
            data-shot="desktop-run-hold"
          >
            <USwitch
              :model-value="holdsFailures(run)"
              :disabled="!!holdRefusal(run)"
              label="Hold failures"
              size="sm"
              :aria-describedby="`desktop-run-hold-${run.key}`"
              :ui="{ label: 'text-xs font-medium' }"
              @update:model-value="(on: boolean) => setHold(run, on)"
            />
            <p :id="`desktop-run-hold-${run.key}`" class="min-w-0 text-xs text-muted">
              {{ holdRefusal(run) ?? 'A failing test waits at its line for you to look at it and resume.' }}
            </p>
          </div>
          <div v-if="run.piwiRunId != null" class="mt-1.5 flex flex-wrap items-center gap-2">
            <UButton
              size="xs"
              color="success"
              variant="soft"
              icon="i-lucide-external-link"
              :to="`/test-runs/${run.piwiRunId}`"
              @click="trayOpen = false"
            >
              Live in Piwi — Run #{{ run.piwiRunId }}
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

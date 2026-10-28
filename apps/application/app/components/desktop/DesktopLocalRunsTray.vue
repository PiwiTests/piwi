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
 * the background. A run whose part of the tray the person opened themselves
 * (Expand output) is shown live (`show`), so a failure no pause bar shows
 * waits there too; one open by default or by a stop is not, and the server
 * holds no failure of a run nobody attends (a Flake Lab, a bisect).
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { flakeLabOutcome, type LocalRun } from '~/composables/useDesktopLocalRuns';
import { desktopRunName, desktopRunOf, desktopStopPlace, desktopWorkerTest } from '~/utils/desktop-run-view';

const store = useDesktopLocalRuns();
const { runs, trayOpen, activeCount } = store;

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
  if (run) {
    // Open, but not by the person: the run is not shown live for it.
    if (expandedByKey.value[run.key] === false) {
      const choices = { ...expandedByKey.value };
      delete choices[run.key];
      expandedByKey.value = choices;
    }
    openedByStop.value = { ...openedByStop.value, [run.key]: true };
  }
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
/** The runs a stop opened: open, as the person's choice and the default leave them, never shown live for it. */
const openedByStop = ref<Record<number, true>>({});

function isExpanded(run: LocalRun): boolean {
  return (
    expandedByKey.value[run.key] ??
    (!!openedByStop.value[run.key] || run.status === 'running' || run.key === runs.value[0]?.key)
  );
}

function toggleExpanded(run: LocalRun) {
  expandedByKey.value = { ...expandedByKey.value, [run.key]: !isExpanded(run) };
}

/**
 * The runs the window shows live, so a failure no pause bar shows is held in them: those the person opened in the open
 * tray themselves (Expand output), never one open by default or by a stop, nor another window's. Each step's name is
 * shown as the step starts, before its workers connect, so a failure right after they do waits too.
 */
const shownRefs = computed(() => {
  if (!trayOpen.value) return [];
  const opened = runs.value.filter((run) => expandedByKey.value[run.key] === true);
  return [...new Set(opened.flatMap((run) => run.hubRefs))].sort();
});
watch(
  () => shownRefs.value.join(' '),
  () => hub.show(shownRefs.value),
  { immediate: true },
);

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });

function duration(run: LocalRun): string {
  const ms = (run.finishedAt ?? now.value) - run.startedAt;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
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
          No local runs yet — start one from a “Run locally” button.
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
            <span class="text-sm font-medium truncate shrink-0 max-w-40">
              {{ run.projectLabel || `Project ${run.projectId}` }}
            </span>
            <code class="text-[11px] text-muted truncate flex-1 min-w-0" :title="run.steps[run.stepIndex]?.display">
              {{ run.steps[run.stepIndex]?.display }}
            </code>
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
            <UTooltip v-else-if="run.kind !== 'flake' || run.flake" text="Run again with the same options">
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                icon="i-lucide-rotate-ccw"
                aria-label="Run again"
                @click="store.rerun(run)"
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
          <div v-if="run.piwiRunId != null" class="mt-1.5">
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
          </div>
          <template v-if="isExpanded(run)">
            <DesktopRunSession
              v-for="session in sessionsOf(run)"
              :key="session.ref"
              :session="session"
              class="mt-2"
              @announce="announce"
            />
            <DesktopLocalRunConsole :lines="run.lines" class="mt-2" />
          </template>
        </article>
      </div>
    </section>
  </Teleport>
</template>

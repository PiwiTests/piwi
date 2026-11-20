<script setup lang="ts">
/**
 * Desktop shell only: the "Local runs" tray, docked at the bottom of the dashboard window under the page, which gives
 * it its height (`--desktop-runs-height`, which every page's panel takes off its own). Its top edge drags it taller
 * or shorter, the keyboard's arrows on it too, **Maximize** gives it most of the window, and the window remembers its
 * height. Mounted once in the default layout's main column; runs keep going while it is closed, and closing it never
 * stops anything. Renders nothing without the IPC bridge.
 *
 * On its left, the runs: **Running now**, the runs another window of the app started, then **Finished**, each line
 * saying how the run stands (`useDesktopRunBadge`: `3 of 9 tests · 1 failed` while it runs, how it ended after),
 * whether a test of it waits at a stop, and how long it ran. On its right, the run chosen there (`selected`, else a
 * run waiting at a stop, else the newest running, else the newest): its command, **Stop**, which gives way to **Force
 * stop** while it winds down (`DesktopRunStopButton`), or **Run again** and **More actions** (**Copy the command**,
 * **Remove from the list**) once it ended, its separate output window, its Hold failures, its links, its workers live
 * (`DesktopRunSession`), what it failed on (`DesktopLocalRunResults`) and its output (`DesktopRunOutputPane`). A run
 * that starts is shown, but one a result's Run again starts, so the run it came from stays (`keep-open`).
 *
 * The workers come live from the bundled server, the hub of the runs the shell starts (`useDesktopRunHub`): the test
 * each one runs and, at a stop, the page, the controls and the code a stop can make, to copy (`DesktopRunCopyList`).
 * The window holds the hub's stream from a plugin (`desktop-run-hub.client.ts`), which opens the tray on every stop it
 * hears; here, the stop's run is shown, its worker scrolls into view, and the live region reads it out; a stop that
 * opens the tray shows its worker's tab, in a run of several workers. The tray also opens on the worker the run page's
 * **Show its page** names (`showWorker`), and on the first test that waits at the system tray menu's **Show the
 * stopped test**, its run shown, its tab chosen and the focus on that worker. A running run's **Hold failures**
 * switch makes a failure no pause bar shows wait at its line; a run nobody attends holds none, and its switch says why.
 *
 * A reproduction, a bisect step or a Flake Lab the shell ran on an editor's run channel is the editor's to steer: its
 * run says where its tests wait, in that editor, read only (`DesktopEditorRunNote`), with no Hold failures switch. A
 * run started for an environment names it with the command the shell runs, and says when the label its Piwi run
 * reported resolves to another environment; its Run again reads the environment again and, for a protected one, asks
 * the person to confirm again (`DesktopEnvironmentQuestion`). A run's output can move to a separate window of the app
 * (`separate`, `DesktopRunOutputWindows`). Opening the tray marks every run that ended as seen (`markSeen`), and `g`
 * then `t` opens or closes it.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import {
  localRunCompareTo,
  localRunCopyCommand,
  localRunDetail,
  localRunDuration,
  localRunEnvironmentNote,
  localRunTitle,
  type LocalRun,
} from '~/composables/useDesktopLocalRuns';
import { desktopEditorRunsOf, desktopRunOf } from '~/utils/desktop-run-view';
import { desktopRunName, desktopStopSaid, desktopWorkerKey } from '@piwitests/run-ui/run-view';

const store = useDesktopLocalRuns();
const { runs, trayOpen, shownWorker, activeCount, trayMounts, separate } = store;
const { badge } = useDesktopRunBadge();

const available = ref(false);
onMounted(() => {
  available.value = !!tauriCore();
});

const hub = useDesktopRunHub();
const words = useRunUiWords();
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

const editorRuns = useDesktopEditorRuns();

/**
 * The editors' runs of a run of the tray: its steps the shell ran on an editor's run channel, in a throwaway checkout
 * of a folder the editor's workspace holds. The editor's hub owns their stops and Hold failures: the tray says where
 * they wait, read only, and the run's own verdict when it ends.
 */
function editorRunsOf(run: LocalRun) {
  return desktopEditorRunsOf(run, editorRuns.value);
}

/** The hub's live runs no run of the tray names: another window started them. */
const otherSessions = computed(() => liveSessions.value.filter((session) => !runOf(session)));

const running = computed(() => runs.value.filter((run) => run.status === 'running'));
const finished = computed(() => runs.value.filter((run) => run.status !== 'running'));

/** The first worker of a run that stands at a stop, with its run on the hub; null while none does. */
function stoppedOf(run: LocalRun): { session: HubSession; worker: HubWorker } | null {
  for (const session of sessionsOf(run)) {
    const worker = session.workers.find((one) => one.state === 'stopped');
    if (worker) return { session, worker };
  }
  return null;
}

/** Whether a test of a run waits at a stop: its own, or one an editor holds. */
function waits(run: LocalRun): boolean {
  if (run.status !== 'running') return false;
  return !!stoppedOf(run) || editorRunsOf(run).some((one) => one.session.workers.some((worker) => worker.stop));
}

// ── What the right side shows ─────────────────────────────────────────────────────────────────────────────────────

/** The run chosen on the left (`chosen` of the store): a run's key, or the ref of a run another window started. */
const selected = store.chosen;

/** The run the right side shows: the one chosen, else one waiting at a stop, else the newest running, else the newest. */
const shownRun = computed<LocalRun | null>(() => {
  if (typeof selected.value === 'string' && otherSessions.value.some((s) => s.ref === selected.value)) return null;
  const chosen = typeof selected.value === 'number' ? runs.value.find((run) => run.key === selected.value) : undefined;
  return chosen ?? running.value.find(waits) ?? running.value[0] ?? runs.value[0] ?? null;
});

/** A run another window started, shown on the right: the one chosen, else the first while the tray holds no run. */
const shownSession = computed<HubSession | null>(() => {
  if (shownRun.value) return null;
  return otherSessions.value.find((s) => s.ref === selected.value) ?? otherSessions.value[0] ?? null;
});

function select(target: number | string) {
  selected.value = target;
}

// The default shown is kept as chosen, so it does not move as other runs go on.
watch(
  () => shownRun.value?.key,
  (key) => {
    if (selected.value === null && key !== undefined) selected.value = key;
  },
  { immediate: true },
);

/** The right side, which the keyboard may be in. */
const detail = useTemplateRef<HTMLElement>('detail');

/**
 * Shows `target` on the right as a run starts or stops, unless the person works in the run shown: the keyboard is in
 * it (a control, the live view's Interact, the output's filter). The list marks a stop all the same.
 */
function showUnlessWorking(target: number | string) {
  const working = !!detail.value && !!document.activeElement && detail.value.contains(document.activeElement);
  if (!working) select(target);
}

/** How long a result's Run again keeps the run it came from shown: the run it starts may wait on its environment. */
const KEEP_SHOWN_MS = 10_000;
let keepShownUntil = 0;
function keepRunShown(run: LocalRun) {
  keepShownUntil = Date.now() + KEEP_SHOWN_MS;
  select(run.key);
}

// A run that starts here is shown, by a key the tray did not hold: a run cleared or removed shows nothing new.
let heldKeys = new Set(runs.value.map((run) => run.key));
watch(
  () => runs.value.map((run) => run.key),
  (keys) => {
    const started = runs.value.find((run) => !heldKeys.has(run.key) && run.status === 'running');
    heldKeys = new Set(keys);
    if (!started) return;
    if (Date.now() < keepShownUntil) {
      keepShownUntil = 0;
      return;
    }
    showUnlessWorking(started.key);
  },
);

// ── Its height ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The tray's least height, how much the keyboard's arrows move its top edge, and its share of the window at first. */
const MIN_HEIGHT = 160;
const KEY_STEP = 40;
const FIRST_SHARE = 0.4;

/** The height the person gave the tray; null until they do, the tray then taking its first share of the window. */
const height = useLocalStorage<number | null>('piwi:desktop-local-runs-height', null, {
  serializer: {
    read: (stored) => (Number.isFinite(Number.parseFloat(stored)) ? Number.parseFloat(stored) : null),
    write: (value) => (value == null ? '' : String(value)),
  },
});
const maximized = ref(false);
const { height: windowHeight } = useWindowSize();
const maxHeight = computed(() => Math.max(MIN_HEIGHT, Math.round(windowHeight.value * 0.85)));
const clampHeight = (value: number) => Math.min(maxHeight.value, Math.max(MIN_HEIGHT, Math.round(value)));
const shownHeight = computed(() =>
  maximized.value ? maxHeight.value : clampHeight(height.value ?? windowHeight.value * FIRST_SHARE),
);

// The page above gives the tray its height: every page's panel takes it off its own.
watchEffect(() => {
  if (!import.meta.client) return;
  const taken = available.value && trayOpen.value ? `${shownHeight.value}px` : '0px';
  document.documentElement.style.setProperty('--desktop-runs-height', taken);
});
onBeforeUnmount(() => document.documentElement.style.removeProperty('--desktop-runs-height'));

/** Drags the top edge with the main button: the tray grows as the pointer goes up; a click alone changes nothing. */
function startResize(event: PointerEvent) {
  if (event.button !== 0) return;
  const edge = event.currentTarget as HTMLElement;
  const startY = event.clientY;
  const start = shownHeight.value;
  edge.setPointerCapture(event.pointerId);
  const move = (moved: PointerEvent) => {
    if ((moved.buttons & 1) === 0) return end();
    if (moved.clientY === startY) return;
    maximized.value = false;
    height.value = clampHeight(start + startY - moved.clientY);
  };
  const end = () => {
    edge.removeEventListener('pointermove', move);
    edge.removeEventListener('pointerup', end);
    edge.removeEventListener('pointercancel', end);
    edge.removeEventListener('lostpointercapture', end);
  };
  edge.addEventListener('pointermove', move);
  edge.addEventListener('pointerup', end);
  edge.addEventListener('pointercancel', end);
  edge.addEventListener('lostpointercapture', end);
}

function resizeByKey(event: KeyboardEvent) {
  const by = event.key === 'ArrowUp' ? KEY_STEP : event.key === 'ArrowDown' ? -KEY_STEP : 0;
  if (by === 0) return;
  event.preventDefault();
  maximized.value = false;
  height.value = clampHeight(shownHeight.value + by);
}

// ── Stops, and the worker asked for ───────────────────────────────────────────────────────────────────────────────

/** What the live region reads out: a test stopped, what a command answered. */
const announcement = ref('');
function announce(text: string) {
  announcement.value = '';
  requestAnimationFrame(() => {
    announcement.value = text;
  });
}

/**
 * Every stop the window hears is shown: the plugin opens the tray, its run shows, its worker scrolls into view, and the
 * live region reads it out.
 */
async function heardStop(session: HubSession, worker: HubWorker) {
  const stop = worker.stop;
  if (!stop) return;
  // The stop opened the tray: its worker's tab shows.
  if (!openShown) hub.chooseTab(session.ref, worker.parallelIndex);
  const run = runOf(session);
  showUnlessWorking(run ? run.key : session.ref);
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

// The tray shows: the runs that ended while it was closed are seen.
watch(trayOpen, (open) => open && store.markSeen(), { immediate: true });

defineShortcuts({
  'g-t': () => {
    if (available.value) trayOpen.value = !trayOpen.value;
  },
});

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

/** Moves the focus to a worker once it is drawn. */
async function focusWorker(ref: string, worker: number) {
  await nextTick();
  document.querySelector<HTMLElement>(`[data-worker="${desktopWorkerKey(ref, worker)}"]`)?.focus();
}

/**
 * A worker the window was asked to show (the run page's Show its page, the system tray's Show the stopped test): its run
 * shows, its tab is chosen, and the focus moves to the worker once it is drawn.
 */
async function showAsked(shown: { ref: string; worker: number } | null) {
  if (!shown) return;
  shownWorker.value = null;
  const session = hub.state.sessions[shown.ref];
  const run = session ? runOf(session) : undefined;
  if (run) select(run.key);
  else if (session) select(session.ref);
  const lane = session?.workers.find((worker) => worker.worker === shown.worker)?.parallelIndex;
  if (lane !== undefined) hub.chooseTab(shown.ref, lane);
  await focusWorker(shown.ref, shown.worker);
}
watch(shownWorker, (shown) => void showAsked(shown));
// One asked before this tray was mounted, as the page changed to one that holds it.
onMounted(() => void showAsked(shownWorker.value));

// ── A run's actions ───────────────────────────────────────────────────────────────────────────────────────────────

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

/** Opens the page a failed run's end leads to: its first failure, else its run. */
async function openFailure(run: LocalRun) {
  const page = await store.failurePage(run);
  trayOpen.value = false;
  await navigateTo(page);
}

/** The run's Run again, here: the run it starts is shown, as the person just asked for it. */
async function runAgain(run: LocalRun) {
  const next = await store.rerun(run);
  if (next) select(next.key);
}

/** Whether a run offers Run again: one it can start as it ran. */
function rerunnable(run: LocalRun): boolean {
  return (run.kind !== 'flake' || !!run.flake) && run.kind !== 'request';
}

const { copy } = useCopy();
const { shell } = useCommandShell();

/** The **More actions** menu of a run that ended: what it shows no button for. */
function moreActions(run: LocalRun) {
  const items: { label: string; icon: string; onSelect: () => void }[] = [];
  const command = localRunCopyCommand(run, shell.value);
  if (command) {
    items.push({
      label: 'Copy the command',
      icon: 'i-lucide-copy',
      onSelect: () => void copy(command, { toast: 'Command copied' }),
    });
  }
  items.push({ label: 'Remove from the list', icon: 'i-lucide-x', onSelect: () => store.removeRun(run) });
  return [items];
}

const empty = computed(() => runs.value.length === 0 && otherSessions.value.length === 0);

/**
 * The runs drawn on the right, the one shown visible: every running run, so showing another ends none of its live views
 * or answers, and the run shown.
 */
const drawnRuns = computed(() =>
  shownRun.value && !running.value.includes(shownRun.value) ? [...running.value, shownRun.value] : running.value,
);

/** Whether a test of a run another window started waits at a stop. */
function sessionWaits(session: HubSession): boolean {
  return session.workers.some((worker) => worker.stop);
}

/** Whether the tray is wide enough for the list beside the run shown; narrower, a select names the run shown. */
const wide = useMediaQuery('(min-width: 768px)');

/** The select's choices, narrow: each run of the tray with how it stands, then the runs another window started. */
const runChoices = computed(() => [
  ...runs.value.map((run) => ({ label: `${localRunTitle(run)} · ${badge(run).label}`, value: `run:${run.key}` })),
  ...otherSessions.value.map((session) => ({
    label: desktopRunName(session, words),
    value: `session:${session.ref}`,
  })),
]);
const chosenChoice = computed({
  get: () =>
    shownRun.value ? `run:${shownRun.value.key}` : shownSession.value ? `session:${shownSession.value.ref}` : undefined,
  set: (value: string | undefined) => {
    if (!value) return;
    const at = value.indexOf(':');
    select(value.slice(0, at) === 'run' ? Number(value.slice(at + 1)) : value.slice(at + 1));
  },
});
</script>

<template>
  <Teleport to="body">
    <DesktopEnvironmentQuestion v-if="available" />
    <!-- Outside the tray, so a stop that opens it is read out from a region already there. -->
    <p v-if="available" class="sr-only" aria-live="polite">{{ announcement }}</p>
  </Teleport>
  <section
    v-if="available && trayOpen"
    aria-label="Local runs"
    class="relative flex shrink-0 flex-col border-t border-default bg-default"
    :style="{ height: `${shownHeight}px` }"
    data-shot="desktop-runs-tray"
  >
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize local runs"
      :aria-valuenow="shownHeight"
      :aria-valuemin="MIN_HEIGHT"
      :aria-valuemax="maxHeight"
      tabindex="0"
      class="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
      @pointerdown="startResize"
      @keydown="resizeByKey"
    />
    <header class="flex shrink-0 items-center gap-2 border-b border-default px-3 py-1.5">
      <UIcon name="i-lucide-terminal" class="size-4 shrink-0 text-muted" />
      <h2 class="text-sm font-semibold">Local runs</h2>
      <UBadge v-if="activeCount > 0" color="info" variant="subtle" size="sm">{{ activeCount }} active</UBadge>
      <span class="flex-1" />
      <UTooltip v-if="finished.length > 0" text="Clear finished runs">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-trash-2"
          aria-label="Clear finished runs"
          @click="store.clearFinished()"
        />
      </UTooltip>
      <UTooltip :text="maximized ? 'Restore its height' : 'Give it most of the window'">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="maximized ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
          :aria-label="maximized ? 'Restore local runs' : 'Maximize local runs'"
          @click="maximized = !maximized"
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

    <div v-if="empty" class="min-h-0 flex-1 overflow-y-auto">
      <DesktopRunCopyList :kept="hub.state.kept" :roots="hub.state.roots" />
      <p class="px-3 py-6 text-center text-sm text-muted">
        No local runs yet — start one from the Re-run button of a run, an execution or a cluster, or a test's Run this
        test.
      </p>
    </div>

    <div v-else class="flex min-h-0 flex-1" :class="wide ? 'flex-row' : 'flex-col'">
      <!-- Narrow, a select names the run shown, so the run keeps the tray's height. -->
      <div v-if="!wide" class="shrink-0 border-b border-default p-2">
        <USelect v-model="chosenChoice" :items="runChoices" aria-label="Run shown" class="w-full" />
      </div>
      <nav v-else aria-label="Runs" class="w-72 shrink-0 overflow-y-auto border-r border-default">
        <template
          v-for="group in [
            { title: 'Running now', items: running },
            { title: 'Finished', items: finished },
          ]"
          :key="group.title"
        >
          <section v-if="group.items.length > 0" :aria-label="group.title">
            <h3 class="px-3 pt-2 pb-1 text-xs text-muted">{{ group.title }}</h3>
            <ul>
              <li v-for="run in group.items" :key="run.key">
                <button
                  type="button"
                  class="flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-elevated/60 focus-visible:outline-2 focus-visible:outline-primary"
                  :class="run.key === shownRun?.key ? SELECTED_ROW_CLASS : ''"
                  :aria-current="run.key === shownRun?.key || undefined"
                  :aria-label="localRunTitle(run)"
                  :aria-describedby="`desktop-run-line-${run.key}`"
                  data-run-line
                  :data-key="run.key"
                  @click="select(run.key)"
                >
                  <span class="truncate text-sm font-medium" :title="localRunTitle(run)">{{ localRunTitle(run) }}</span>
                  <!-- The line is named by its run's title alone; how the run stands describes it. -->
                  <span :id="`desktop-run-line-${run.key}`" class="flex min-w-0 items-center gap-2">
                    <UBadge :color="badge(run).color" variant="subtle" size="sm" class="min-w-0 truncate">
                      {{ badge(run).label }}
                    </UBadge>
                    <span v-if="waits(run)" class="flex shrink-0 items-center text-warning">
                      <UIcon name="i-lucide-circle-pause" class="size-3.5" aria-hidden="true" />
                      <span class="sr-only">A test waits at a stop</span>
                    </span>
                    <span class="ml-auto shrink-0 text-xs text-muted tabular-nums">{{ duration(run) }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>
          <section
            v-if="group.title === 'Running now' && otherSessions.length > 0"
            aria-labelledby="desktop-runs-other-windows"
          >
            <h3 id="desktop-runs-other-windows" class="px-3 pt-2 pb-1 text-xs text-muted">Started in another window</h3>
            <ul>
              <li v-for="session in otherSessions" :key="session.ref">
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated/60 focus-visible:outline-2 focus-visible:outline-primary"
                  :class="session.ref === shownSession?.ref ? SELECTED_ROW_CLASS : ''"
                  :aria-current="session.ref === shownSession?.ref || undefined"
                  @click="select(session.ref)"
                >
                  <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ desktopRunName(session, words) }}</span>
                  <span v-if="sessionWaits(session)" class="flex shrink-0 items-center text-warning">
                    <UIcon name="i-lucide-circle-pause" class="size-3.5" aria-hidden="true" />
                    <span class="sr-only">A test waits at a stop</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </template>
      </nav>

      <div ref="detail" class="min-w-0 flex-1 overflow-y-auto px-3 py-2">
        <DesktopRunCopyList :kept="hub.state.kept" :roots="hub.state.roots" />
        <article
          v-for="run in drawnRuns"
          v-show="run.key === shownRun?.key"
          :key="run.key"
          :data-run="run.key"
          :aria-label="localRunTitle(run)"
          class="space-y-2"
        >
          <div class="flex flex-wrap items-center gap-2">
            <p class="min-w-0 flex-1 basis-60 truncate font-mono text-[11px] text-muted" :title="localRunDetail(run)">
              {{ localRunDetail(run) }}
            </p>
            <div class="ml-auto flex shrink-0 items-center gap-1">
              <DesktopRunStopButton
                v-if="run.status === 'running'"
                :stopping="run.stopRequested"
                :since="run.stopRequestedAt"
                @stop="store.stopRun(run)"
                @force="store.stopRun(run)"
              />
              <UTooltip v-else-if="rerunnable(run)" :text="`Run again: ${localRunTitle(run)}, with the same options`">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-rotate-ccw"
                  aria-label="Run again"
                  @click="void runAgain(run)"
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
              <UDropdownMenu v-if="run.status !== 'running'" :items="moreActions(run)">
                <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-ellipsis" aria-label="More actions" />
              </UDropdownMenu>
            </div>
          </div>
          <p v-if="localRunEnvironmentNote(run)" class="text-xs text-warning" data-testid="local-run-environment-note">
            {{ localRunEnvironmentNote(run) }}
          </p>
          <DesktopRunHoldSwitch
            v-if="run.status === 'running' && !editorRunsOf(run).length"
            :run="run"
            :described-id="`desktop-run-hold-${run.key}`"
            data-shot="desktop-run-hold"
          />
          <div v-if="run.piwiRunId != null" class="flex flex-wrap items-center gap-2">
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
          <DesktopEditorRunNote v-if="editorRunsOf(run).length" :runs="editorRunsOf(run)" />
          <DesktopRunSession
            v-for="session in sessionsOf(run)"
            :key="session.ref"
            :session="session"
            @announce="announce"
          />
          <DesktopLocalRunResults :run="run" @keep-open="keepRunShown(run)" />
          <p v-if="separate[run.key]" class="text-xs text-muted">The output is in a separate window.</p>
          <DesktopRunOutputPane v-else :lines="run.lines" />
        </article>
        <DesktopRunSession v-if="shownSession" :session="shownSession" named @announce="announce" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * Desktop shell only: one worker of a run the shell started, as the bundled server, its hub, tells it, drawn as Piwi
 * Picker's Runs window draws one, from the run model they share (`@piwitests/run-model`), top to bottom. Its test's
 * name, then its project and attempt, and why it never stops when it cannot. Where it stands, in a card of its tone
 * (`workerStatus`): its state, a Pause waiting in a call naming the call and how long it has run, then the call about
 * to run and its place, or a failure's error. Its controls (`controlsOf`): **Resume**, **Step** and **Finish** joined,
 * and apart at the row's end **Show the browser** and **End the test**, which ends it there, skipped (Resume alone at a
 * failure); **Pause** while it runs, with **Watch** where its reporter shows its lane (held, saying to update the
 * reporter, where it does not); while a Pause waits for the call the test runs, **End the test**, which gives the call
 * up; then, under **Code**, **Assert a region** and **Mock a request**, whose code comes to the window to copy, held
 * until the page is watched where the stop takes them only then (`heldUntilWatched`). What a command answered, or what
 * a code made at this stop came to, shows under them, read out, while the worker stands there. Then its page, in its
 * card: the lane's while it is watched (`DesktopRunLaneView`), else the stop's (`DesktopRunStopPage`), who watches it
 * in its head, and who drives the stop at its foot (`DesktopRunDriver`): **Take control** from an agent, which waits
 * until **Give back**, or **Interact** on its page, turned off again the same.
 *
 * Every control but Pause and End the test while a Pause waits names the stop it was drawn for (`since`), so a click
 * made twice never answers the next stop, and while one is on its way, or a command of the run's (`runBusy`), the
 * buttons are `aria-disabled`, keeping the focus; the run's Resume all and Pause all wait for its own (`busy`). A control that goes as the worker runs on gives the keyboard to Pause
 * meanwhile, and takes it back at the next stop (Step, after a step), as the Runs window does. Resume or End the test
 * at the worker a run's tabs show moves them to the next stopped test (`advanceTab`). Everything the hub sends is shown
 * as text.
 */
import type { HubKeptRequest, HubSession, HubWorker } from '@piwitests/core/run-hub';
import { CONTROLS, JOINED, STEERING, controlTitle, controlsOf, type Control } from '@piwitests/run-model/controls';
import { driverOf, watchersLine } from '@piwitests/run-model/presence';
import { workerStatus } from '@piwitests/run-model/status';
import {
  heldUntilWatched,
  laneWatchOf,
  runFile,
  stopError,
  stopIntents,
  stopPlace,
  testName,
} from '@piwitests/run-model/stop';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import type { DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import {
  DESKTOP_RUN_HUB,
  DESKTOP_RUN_ICONS,
  DESKTOP_TONE_COLORS,
  desktopLaneKey,
  desktopRunStop,
  desktopSaidAround,
  desktopSay,
  desktopWaitedFor,
  desktopWorkerKey,
} from '~/utils/desktop-run-view';

const props = defineProps<{
  session: HubSession;
  worker: HubWorker;
  /** A command of the whole run (Pause all, Resume all) is on its way: the buttons wait for it too. */
  runBusy?: boolean;
}>();
const emit = defineEmits<{ announce: [text: string]; busy: [on: boolean] }>();

const hub = useDesktopRunHub();

const stop = computed(() => desktopRunStop(props.worker));
const since = computed(() => stop.value?.since ?? null);
const place = computed(() => (stop.value ? stopPlace(stop.value, props.session.root) : null));

/**
 * The window that shows the worker: the app's main window, which alone holds the shell's commands (Open in a window,
 * the editor's launcher), or a worker's window, which holds none. Outside the shell (no window), the main window's.
 */
const mainWindow = ref(true);
/** Open in a window: offered in the app's main window alone, whose tray shows the worker. */
const windowable = ref(false);
onMounted(() => {
  const label = tauriWindowLabel();
  mainWindow.value = label === null || label === 'main';
  windowable.value = !!tauriCore() && label === 'main';
});

const toast = useToast();
/** This worker in a window of its own, kept above the others, its status, controls and page live; by its lane. */
async function openWindow() {
  try {
    await tauriCore()?.invoke('desktop_open_worker_window', {
      runRef: props.session.ref,
      lane: props.worker.parallelIndex,
    });
  } catch (error) {
    toast.add({ title: 'The window could not open', description: errorMessage(error), color: 'error' });
  }
}
/**
 * The stop's file in the run's folder, which opens in the editor, relative to it; null for one outside it. The folder
 * is the file's as it spells it, but for a Windows path, whose case the file system ignores.
 */
const placeFile = computed(() => {
  const root = props.session.root;
  if (!stop.value || !root || !stop.value.uri.startsWith('file:')) return null;
  const whole = runFile(stop.value.uri, null);
  const file = runFile(stop.value.uri, root);
  if (file === whole) return null;
  const base = whole.slice(0, whole.length - file.length - 1);
  return /^[A-Za-z]:/.test(base) || base === root.replace(/\\/g, '/').replace(/\/+$/, '') ? file : null;
});
const takes = computed(() => (stop.value ? stopIntents(props.worker, stop.value) : []));
const failed = computed(() => stop.value?.reason === 'failure');

// ── The test and where it stands ──────────────────────────────────────────────────────────────────────────────────

const testText = computed(() => (props.worker.test ? testName(props.worker.test) : null));
/** Its project and attempt, on the test's line where they fit. */
const metaText = computed(() => {
  const test = props.worker.test;
  if (!test) return null;
  return [test.project, desktopSay('runs_attempt', { attempt: String(test.retry + 1) })].filter(Boolean).join(' · ');
});
const status = computed(() => workerStatus(props.worker, place.value));
const toneColor = computed(() => DESKTOP_TONE_COLORS[status.value.tone]);
const stateText = computed(() => desktopSay(status.value.message.key, status.value.message.args));
/** The words around the call a Pause waits in, which shows as code. */
const pausingIn = computed(() => desktopSaidAround('runs_statePausingIn', 'call'));
/** The clock that counts how long the call a Pause waits in has run. */
const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });
const waitedText = computed(() => desktopWaitedFor(props.worker, now.value));

// ── Its lane and its page ─────────────────────────────────────────────────────────────────────────────────────────

/** Whether its lane can be watched while it runs (`watch`), or its reporter cannot show it (`outdated`). */
const laneWatch = computed(() => laneWatchOf(DESKTOP_RUN_HUB, props.worker));
const watchedLane = computed(() => hub.watchesLane(props.session.ref, props.worker.parallelIndex));
/**
 * The lane's page shows: while it runs, or at a stop of a test while the window watches the lane. A stop outside a
 * test is no frame of the lane: its own page shows it.
 */
const laneShown = computed(
  () => laneWatch.value === 'watch' && (!stop.value || (!!props.worker.test && watchedLane.value)),
);
/** Why the hub would not show the worker's lane, the last time the window asked. */
const laneRefused = computed(
  () => hub.state.laneRefusals[desktopLaneKey(props.session.ref, props.worker.parallelIndex)] ?? null,
);
/** The page shows in a card: a stop's, or the lane's while it is watched or the hub said why it would not show it. */
const pageCard = computed(() =>
  laneShown.value ? !!stop.value || watchedLane.value || !!laneRefused.value : !!stop.value,
);
/** The page can be watched here: through its lane, or the stop's own view. */
const pageWatchable = computed(
  () => (laneWatch.value === 'watch' && (!stop.value || !!props.worker.test)) || takes.value.includes('view'),
);
/** Who watches the worker's page, said only while the window hears the hub. */
const watchers = computed(() => (hub.state.connected ? watchersLine(props.worker.watchers, englishRunSpeaker) : null));

// ── Who drives the stop ───────────────────────────────────────────────────────────────────────────────────────────

const driver = computed(() => (stop.value && hub.state.connected ? driverOf(stop.value, englishRunSpeaker) : null));
const agentFollows = computed(() => !!props.session.presence?.some((tool) => tool.kind === 'agent'));
/**
 * Who drives the stop shows while another tool or an agent drives it, an agent follows the run, or this window drives
 * it while another tool has the run open.
 */
const driverShown = computed(() => {
  if (!stop.value || !hub.state.connected) return false;
  const othersOpen = !!props.session.presence?.some((tool) => !tool.self);
  return (!!driver.value && (driver.value.who !== 'self' || othersOpen)) || agentFollows.value;
});
const driverWords = computed(() => driver.value?.words ?? 'An agent may act on this stop');
const drivesIt = computed(() => driver.value?.who === 'self');

// ── The controls ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The actions in the test's window the stop takes once the page is watched, shown held until then. */
const held = computed((): Control[] =>
  stop.value ? heldUntilWatched(props.worker, stop.value, pageWatchable.value) : [],
);
const controls = computed(() => controlsOf(props.worker, stop.value, held.value));
/** Resume, Step and Finish, joined. */
const joined = computed(() => controls.value.filter((what) => JOINED.has(what)));
/** The other controls that steer the test: at the row's end beside the joined ones, else at its start. */
const steering = computed(() => controls.value.filter((what) => STEERING.has(what) && !JOINED.has(what)));
/** The code a stop can write, under its label. */
const code = computed(() => controls.value.filter((what) => !STEERING.has(what)));
/** Watch, beside Pause while no stop shows. */
const runningWatch = computed(() => (stop.value ? null : laneWatch.value));

/** The tray's own titles: the code a stop makes comes to this window to copy, never to an editor. */
const TITLES: Partial<Record<Control, string>> = {
  'assert-region': 'Pick a region of the page: its ARIA snapshot becomes a toMatchAriaSnapshot check to copy',
  mock: 'Choose a response the page got: it becomes a page.route mock to copy',
};

/** A control's button: its words, icon and look, Resume the one solid primary button. */
function look(what: Control) {
  const control = CONTROLS[what];
  const primary = 'tone' in control && control.tone === 'primary';
  const waits = held.value.includes(what);
  return {
    label: desktopSay(control.label),
    attrs: {
      'data-focus': `${STEERING.has(what) ? 'steer' : 'code'}:${what}`,
      color: primary ? ('primary' as const) : ('neutral' as const),
      variant: primary ? ('solid' as const) : ('outline' as const),
      icon: DESKTOP_RUN_ICONS[control.icon],
      title: waits ? desktopSay('runs_watchToUse') : (TITLES[what] ?? desktopSay(controlTitle(what, stop.value))),
      'aria-disabled': waits || waiting.value || undefined,
      'aria-expanded': what === 'mock' ? !!shownRequests.value : undefined,
    },
  };
}

/** A command is on its way for this worker: the buttons wait for its answer, and so do the run's (`busy`). */
const busy = ref(false);
watch(busy, (on) => emit('busy', on));
/** A command of this worker's, or of its run's, is on its way. */
const waiting = computed(() => busy.value || !!props.runBusy);

/** A control pressed: one held or waiting says nothing; the others send themselves. */
function press(what: Control): void {
  if (waiting.value || held.value.includes(what)) return;
  if (STEERING.has(what)) void steer(what);
  else void codeAction(what);
}

/** Watch live, kept by the window: on, each next stop of this worker is watched, until it is turned off. */
const watchLive = computed({
  get: () => hub.watchesLive(props.session.ref, props.worker.worker),
  set: (on: boolean) => hub.setWatchLive(props.session.ref, props.worker.worker, on),
});
/**
 * Interact, kept by the window for the worker's lane while the worker is watched: on, the clicks, the wheel and the
 * keys on its view go to the page, and the first of them drives the stop. Turned off on the page, the stop is given
 * back once its input went (`giveBackAt`), the worker's buttons waiting meanwhile (`busy`).
 */
const interact = computed({
  get: () => hub.interacts(props.session.ref, props.worker.parallelIndex),
  set: (on: boolean) => hub.setInteract(props.session.ref, props.worker.parallelIndex, on),
});

/** The worker's page is watched: its own stop's Watch live, or its lane. */
const watched = computed(() => watchLive.value || watchedLane.value);
// Interact goes off with watching, a worker Playwright starts in the lane without Watch live included.
watch(
  watched,
  (on) => {
    if (!on && interact.value) interact.value = false;
  },
  { immediate: true },
);
/** What the last command answered, or what a code made here came to, for the stop it was sent at. */
const answer = ref<{ since: string | null; ok: boolean; text: string; locator: string | null; warnings: string[] }>();
/** The responses the test kept, listed for Mock a request at the stop they were asked at. */
const requests = ref<{ since: string; list: HubKeptRequest[] }>();

const shownAnswer = computed(() => (answer.value && answer.value.since === since.value ? answer.value : undefined));
const shownRequests = computed(() =>
  requests.value && requests.value.since === since.value ? requests.value : undefined,
);

function say(
  result: DesktopRunAnswer,
  at: string | null,
  extra: { warnings?: string[]; locator?: string | null } = {},
) {
  answer.value = {
    since: at,
    ok: result.ok,
    text: result.message,
    locator: extra.locator ?? null,
    warnings: extra.warnings ?? [],
  };
  if (result.message) emit('announce', [result.message, ...(extra.warnings ?? [])].join(' '));
}

/** Sends a command for the stop the button was drawn for (`at`, null for Pause), unless one is on its way. */
async function send(body: Record<string, unknown>, at: string | null): Promise<DesktopRunAnswer | null> {
  if (waiting.value) return null;
  busy.value = true;
  answer.value = undefined;
  const result = await hub.command({ ref: props.session.ref, worker: props.worker.worker, ...body });
  busy.value = false;
  // An answer for a stop the worker no longer stands at says nothing.
  return since.value === at ? result : null;
}

async function steer(what: Control): Promise<void> {
  // Pause, and End the test while a Pause waits for a call, answer no stop.
  const at = what === 'pause' || what === 'give-up' ? null : since.value;
  // Resumed or ended here, the next stopped test takes the run's tab once this one leaves the stop.
  if (what === 'resume' || what === 'end') hub.advanceTab(props.session.ref, props.worker.parallelIndex, at);
  // Show the browser is the hub's own command; the others are run controls.
  const body = what === 'front' ? { type: 'front', since: at } : { type: 'runControl', action: what, since: at };
  const result = await send(body, at);
  if (result && !result.ok) say(result, at);
}

/**
 * Gives back the stop `at` names as Interact goes off on its page, past any command on its way, leaving what the last
 * one answered in place.
 */
async function giveBackAt(at: string): Promise<void> {
  if (since.value !== at || !hub.state.connected) return;
  const result = await hub.command({
    ref: props.session.ref,
    worker: props.worker.worker,
    type: 'drive',
    since: at,
    on: false,
  });
  if (since.value !== at) return;
  if (!result.ok) say(result, at);
  else if (result.message) emit('announce', result.message);
}

const lanePage = useTemplateRef<{ interactOff(): Promise<void>; toggle(): Promise<void> }>('lanePage');
const stopPage = useTemplateRef<{ interactOff(): Promise<void> }>('stopPage');

/** Watch, on the row of a worker that runs: its lane's page shows as it runs, and at each stop. */
function toggleWatch(): void {
  if (waiting.value || laneWatch.value !== 'watch') return;
  if (lanePage.value) void lanePage.value.toggle();
  else void hub.setLaneWatch(props.session.ref, props.worker.parallelIndex, !watchedLane.value);
}

/** Give back: with Interact on, it goes off on the page, which gives the stop back once its input went. */
function giveBack(): void {
  const page = lanePage.value ?? stopPage.value;
  if (interact.value && page) void page.interactOff();
  else void drive(false);
}

/** Drives the stop (`on`: an agent waits until it is given back), or gives it back. */
async function drive(on: boolean): Promise<void> {
  const at = since.value;
  if (at === null) return;
  const result = await send({ type: 'drive', since: at, on }, at);
  if (!result) return;
  if (result.ok) emit('announce', result.message);
  else say(result, at);
}

async function codeAction(what: Control): Promise<void> {
  const at = since.value;
  if (at === null) return;
  if (what === 'mock') {
    if (shownRequests.value) {
      requests.value = undefined;
      return;
    }
    const result = await send({ type: 'requests', since: at }, at);
    if (!result) return;
    if (result.ok && result.requests) {
      requests.value = { since: at, list: result.requests };
      emit(
        'announce',
        result.requests.length === 1 ? '1 response listed.' : `${result.requests.length} responses listed.`,
      );
    } else say(result, at);
    return;
  }
  const result = await send({ type: what, since: at }, at);
  if (result) say(result, at);
}

async function mock(id: number): Promise<void> {
  const at = since.value;
  if (at === null) return;
  const result = await send({ type: 'mock', since: at, request: id }, at);
  if (!result) return;
  const outcome = hub.state.outcomes[desktopWorkerKey(props.session.ref, props.worker.worker)];
  // The hub said what the code came to before this answer, with what to check in it: the answer says it again.
  if (!(result.ok && outcome?.since === at && outcome.message === result.message)) say(result, at);
  if (result.ok) requests.value = undefined;
}

// What a code made at this stop came to, whoever asked for it (this window, Piwi Picker).
watch(
  () => hub.state.outcomes[desktopWorkerKey(props.session.ref, props.worker.worker)],
  (outcome) => {
    if (!outcome || outcome.since !== since.value) return;
    say({ ok: outcome.ok, message: outcome.message }, outcome.since, { warnings: outcome.warnings ?? [] });
  },
);

function heardPage(result: DesktopRunAnswer, options: { picked?: boolean }): void {
  const at = since.value;
  if (options.picked) say(result, at, { locator: result.ok ? (result.locator ?? null) : null });
  else if (shownAnswer.value?.text !== result.message) say(result, at);
}

const { copy, copied } = useCopy();

// ── Focus ──
/** This worker's part of the tray. */
const root = ref<HTMLElement | null>(null);
/** The control of this worker the keyboard is on (its `data-focus`), focused again when a redraw takes it away. */
let focusKey: string | null = null;
/** While the worker lends the focus to another of its controls, until the one it was on comes back. */
let lending = false;

function heardFocus(event: FocusEvent): void {
  if (lending) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  focusKey = target && root.value?.contains(target) ? (target.dataset.focus ?? null) : null;
}

/** A press anywhere but on a control: the person put the focus there themselves. */
function heardPress(event: PointerEvent): void {
  if (!(event.target instanceof Element) || !event.target.closest('[data-focus]')) focusKey = null;
}

/**
 * Gives the keyboard back after a redraw took it to the page: to the control it was on (Step, at the next stop), or
 * meanwhile to the first control left (Pause, while the step runs), whose own focus does not replace it.
 */
function restoreFocus(): void {
  const active = document.activeElement;
  if (!focusKey || !root.value || (active && active !== document.body)) return;
  const same = root.value.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`);
  if (same) {
    same.focus();
    return;
  }
  // Never End the test, which a key pressed again would answer.
  const near = root.value.querySelector<HTMLElement>('[data-focus^="steer:"]:not([data-focus="steer:give-up"])');
  if (!near) return;
  lending = true;
  near.focus();
  lending = false;
}

watch([controls, laneShown, runningWatch, driverShown, drivesIt], restoreFocus, { flush: 'post' });
onMounted(() => {
  document.addEventListener('focusin', heardFocus);
  document.addEventListener('pointerdown', heardPress, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('focusin', heardFocus);
  document.removeEventListener('pointerdown', heardPress, true);
  if (busy.value) emit('busy', false);
});
</script>

<template>
  <div
    ref="root"
    class="flex flex-col gap-2.5 p-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
    tabindex="-1"
    :data-worker="desktopWorkerKey(session.ref, worker.worker)"
    :data-state="worker.state"
    :data-failed="failed || undefined"
    data-shot="desktop-run-worker"
  >
    <!-- The test: its name, then its project and attempt, on one line where they fit. -->
    <div v-if="testText" class="space-y-0.5">
      <div class="flex flex-wrap items-baseline gap-x-2.5">
        <p class="min-w-0 flex-auto text-sm font-semibold text-highlighted break-words">{{ testText }}</p>
        <p v-if="metaText" class="ml-auto max-w-full text-xs text-muted break-words">{{ metaText }}</p>
        <UButton
          v-if="windowable"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-picture-in-picture-2"
          title="Open in a window, kept above the others"
          aria-label="Open this worker in a window, kept above the others"
          data-testid="desktop-worker-window"
          @click="openWindow"
        />
      </div>
      <p v-if="worker.test?.cannotPause" class="text-xs text-muted">
        This test never stops: {{ worker.test.cannotPause }}
      </p>
    </div>

    <!-- Where it stands, in a card of its tone. -->
    <div
      class="desktop-run-status rounded-md px-2.5 py-2"
      :style="{ '--tone': toneColor }"
      :data-tone="status.tone"
      data-testid="desktop-worker-status"
    >
      <p class="desktop-run-state flex items-center gap-1.5 text-sm font-medium">
        <UIcon :name="DESKTOP_RUN_ICONS[status.icon]" class="size-4 shrink-0" aria-hidden="true" />
        <span v-if="status.waiting" class="min-w-0 break-words">
          {{ pausingIn[0] }}<code class="font-mono text-xs text-highlighted">{{ status.waiting.title }}</code
          >{{ pausingIn[1] }}
          <span v-if="waitedText" class="whitespace-nowrap font-normal text-muted" data-testid="desktop-waited">{{
            waitedText
          }}</span>
        </span>
        <span v-else class="min-w-0 break-words">{{ stateText }}</span>
      </p>
      <ErrorText v-if="stop && failed" :text="stopError(stop)" mode="block" class="mt-1.5" />
      <dl v-else-if="stop" class="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        <dt class="text-muted">{{ desktopSay('runs_nextLabel') }}</dt>
        <dd class="font-mono break-words text-highlighted">{{ stop.title }}</dd>
        <dt class="text-muted">{{ desktopSay('runs_whereLabel') }}</dt>
        <dd class="min-w-0 text-highlighted">
          <OpenInIdeLink
            v-if="placeFile && mainWindow"
            :file-path="placeFile"
            :line="stop.line + 1"
            :root="session.root"
            inline
          />
          <span v-else class="font-mono break-all">{{ place }}</span>
        </dd>
      </dl>
    </div>

    <!-- The controls that steer the test, then the code a stop can write. -->
    <div v-if="controls.length || runningWatch" class="flex flex-col gap-1.5">
      <div v-if="joined.length || steering.length || runningWatch" class="flex flex-wrap items-center gap-1.5">
        <UFieldGroup v-if="joined.length" size="xs">
          <UButton v-for="what in joined" :key="what" v-bind="look(what).attrs" @click="press(what)">
            {{ look(what).label }}
          </UButton>
        </UFieldGroup>
        <template v-if="!joined.length">
          <UButton v-for="what in steering" :key="what" size="xs" v-bind="look(what).attrs" @click="press(what)">
            {{ look(what).label }}
          </UButton>
        </template>
        <UButton
          v-if="runningWatch === 'watch'"
          data-focus="page:watch"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-eye"
          :aria-pressed="watchedLane"
          :aria-disabled="waiting || undefined"
          :class="watchedLane ? PRESSED_TOGGLE_CLASS : ''"
          :title="desktopSay('runs_watchTitle')"
          @click="toggleWatch"
        >
          {{ desktopSay('runs_watch') }}
        </UButton>
        <UButton
          v-else-if="runningWatch === 'outdated'"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-eye"
          aria-disabled="true"
          :title="desktopSay('runs_watchOutdated')"
          data-testid="desktop-watch-needs-update"
        >
          {{ desktopSay('runs_watch') }}
        </UButton>
        <div v-if="joined.length && steering.length" class="ml-auto flex flex-wrap gap-1.5">
          <UButton v-for="what in steering" :key="what" size="xs" v-bind="look(what).attrs" @click="press(what)">
            {{ look(what).label }}
          </UButton>
        </div>
      </div>
      <div
        v-if="code.length"
        role="group"
        :aria-label="desktopSay('runs_codeActions')"
        class="flex flex-wrap items-center gap-1.5"
      >
        <span class="mr-0.5 text-xs text-muted" aria-hidden="true">{{ desktopSay('runs_codeLabel') }}</span>
        <UButton v-for="what in code" :key="what" size="xs" v-bind="look(what).attrs" @click="press(what)">
          {{ look(what).label }}
        </UButton>
      </div>
    </div>

    <!-- What a command answered: the answer, the locator to copy, what to review, the requests to mock. -->
    <div v-if="shownAnswer && shownAnswer.text" class="space-y-1">
      <p class="flex items-start gap-1.5 text-xs" :class="shownAnswer.ok ? 'text-muted' : 'text-error'">
        <UIcon
          :name="shownAnswer.ok ? 'i-lucide-info' : 'i-lucide-triangle-alert'"
          class="size-3.5 shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <span class="min-w-0 break-words">{{ shownAnswer.text }}</span>
      </p>
      <div v-if="shownAnswer.locator" class="flex items-center gap-1.5 min-w-0">
        <LocatorCode :locator="shownAnswer.locator" truncate class="min-w-0" />
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          @click="copy(shownAnswer.locator, { toast: 'Locator copied' })"
        >
          Copy
        </UButton>
      </div>
      <ul v-if="shownAnswer.warnings.length" :aria-label="desktopSay('runs_codeWarnings')" class="space-y-0.5">
        <li v-for="warning in shownAnswer.warnings" :key="warning" class="text-xs text-muted">{{ warning }}</li>
      </ul>
    </div>
    <DesktopRunRequests
      v-if="shownRequests"
      :requests="shownRequests.list"
      :busy="waiting"
      @mock="mock"
      @close="requests = undefined"
    />

    <!-- Its page, in its card; who watches it on a line of its own while no card shows. -->
    <DesktopRunLaneView
      v-if="laneShown"
      ref="lanePage"
      :session="session"
      :worker="worker"
      :busy="waiting"
      :give-back="giveBackAt"
      :watchers="watchers"
      v-model:interact="interact"
      @said="heardPage"
      @picking="busy = $event"
      @releasing="busy = $event"
    >
      <template v-if="driverShown" #foot>
        <DesktopRunDriver :words="driverWords" :mine="drivesIt" :busy="waiting" @take="drive(true)" @give="giveBack" />
      </template>
    </DesktopRunLaneView>
    <DesktopRunStopPage
      v-else-if="stop"
      ref="stopPage"
      :run-ref="session.ref"
      :worker="worker.worker"
      :stop="stop"
      :takes="takes"
      :busy="waiting"
      :lane-refused="laneRefused"
      :give-back="giveBackAt"
      :watchers="watchers"
      v-model:watch-live="watchLive"
      v-model:interact="interact"
      @said="heardPage"
      @picking="busy = $event"
      @releasing="busy = $event"
    >
      <template v-if="driverShown" #foot>
        <DesktopRunDriver :words="driverWords" :mine="drivesIt" :busy="waiting" @take="drive(true)" @give="giveBack" />
      </template>
    </DesktopRunStopPage>
    <p
      v-if="watchers && !pageCard"
      class="flex items-center gap-1.5 text-xs text-muted"
      data-testid="desktop-worker-watchers"
    >
      <UIcon name="i-lucide-eye" class="size-3 shrink-0" aria-hidden="true" />
      {{ watchers }}
    </p>
  </div>
</template>

<style scoped>
/* Where the test stands, in a card of its tone: tinted, its left edge in the tone, its state darkened toward the text. */
.desktop-run-status {
  border: 1px solid color-mix(in srgb, var(--tone) 28%, var(--ui-border));
  border-left: 3px solid var(--tone);
  background: color-mix(in srgb, var(--tone) 7%, var(--ui-bg));
}
.desktop-run-state {
  color: color-mix(in srgb, var(--tone) 65%, var(--ui-text-highlighted));
}
</style>

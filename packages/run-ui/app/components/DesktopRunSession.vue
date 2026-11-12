<script setup lang="ts">
/**
 * Desktop shell only: the workers of a run the shell started, live, as its hub (the bundled server) tells them, each
 * with its test and where it stands (`DesktopRunWorker`), its number and page once its reporter names them
 * (`DesktopRunPageLink`), and **Share live** for a run whose reporter shares it (`DesktopRunShare`). `named` puts the
 * run's name above them, for a run the Local runs tray does not list itself (one another window of the app started).
 * While it runs, who else has it open: Piwi Picker, an editor, an agent (`presenceLine`).
 *
 * A run of several workers shows one at a time, as Piwi Picker's Runs window does: a tab each (`role="tablist"`),
 * named by its lane and marked with its state's icon and tone (`tabStatus`), the arrow keys, Home and End moving
 * between them (one tab stop), and a `tabpanel` each, named by its tab. Which one shows is the hub's to follow
 * (`useDesktopRunHub`, `tabsAfter`); the person's choice holds until a stop is answered there, or, while that worker
 * runs and nobody watches it, until a new stop comes. The workers not shown stay drawn, hidden, so their views, answers
 * and lists stay as they were, and a run that goes from several workers to one, or back, keeps each worker drawn. When
 * the tabs move on from the worker the keyboard was in, it goes to the tab of the worker shown. Above them, **Resume all** and **Pause all** (`runLevelControls`), their buttons and the workers' waiting while
 * one is on its way, and waiting themselves while a worker they name has a command of its own on its way.
 */
import type { HubSession } from '@piwitests/core/run-hub';
import { runLevelControls } from '@piwitests/run-model/controls';
import { presenceLine } from '@piwitests/run-model/presence';
import { tabStatus } from '@piwitests/run-model/status';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import { DESKTOP_RUN_ICONS, DESKTOP_TONE_COLORS, desktopRunName, desktopSay } from '../utils/run-view';

const props = defineProps<{ session: HubSession; named?: boolean }>();
const emit = defineEmits<{ announce: [text: string] }>();

const hub = useDesktopRunHub();
/** Who else has the run open while it runs, said only while the window hears the hub. */
const presence = computed(() =>
  props.session.ended || !hub.state.connected ? null : presenceLine(props.session.presence, englishRunSpeaker),
);
const workers = computed(() => [...props.session.workers].sort((a, b) => a.parallelIndex - b.parallelIndex));

// ── The worker tabs ───────────────────────────────────────────────────────────────────────────────────────────────

/** The run's tabs, while it has several workers; the worker shown, by its lane. */
const tabs = computed(() => (props.session.ended ? null : hub.tabsOf(props.session.ref)));
const shown = computed(() => tabs.value?.shown ?? null);
const idBase = useId();
const tabId = (lane: number) => `${idBase}-tab-${lane}`;
const panelId = (lane: number) => `${idBase}-panel-${lane}`;

/** Each worker's tab: its name, and its state's words, icon and tone. */
const tabList = computed(() =>
  workers.value.map((worker) => {
    const status = tabStatus(worker);
    const colored = status.tone === 'stopped' || status.tone === 'failed';
    return {
      worker,
      lane: worker.parallelIndex,
      name: desktopSay('runs_worker', { number: String(worker.parallelIndex + 1) }),
      words: desktopSay(status.message.key, status.message.args),
      icon: DESKTOP_RUN_ICONS[status.icon],
      tone: status.tone,
      style: colored ? { '--tone': DESKTOP_TONE_COLORS[status.tone] } : undefined,
    };
  }),
);

async function choose(lane: number, focus = false): Promise<void> {
  hub.chooseTab(props.session.ref, lane);
  if (!focus) return;
  await nextTick();
  document.getElementById(tabId(lane))?.focus();
}

/** The arrow keys, Home and End move between the tabs, showing the worker of the tab they reach. */
function onTabKey(event: KeyboardEvent, index: number): void {
  const count = tabList.value.length;
  const to =
    event.key === 'ArrowRight'
      ? (index + 1) % count
      : event.key === 'ArrowLeft'
        ? (index - 1 + count) % count
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? count - 1
            : null;
  if (to === null) return;
  event.preventDefault();
  void choose(tabList.value[to]!.lane, true);
}

// ── The run's own controls ────────────────────────────────────────────────────────────────────────────────────────

const level = computed(() => runLevelControls(props.session));
const levelShown = computed(() => hub.state.connected && (level.value.pauseAll || level.value.resumeAll.length > 0));
/** Pause all or Resume all is on its way: its buttons and the workers' wait for the answers. */
const runBusy = ref(false);
/** The workers with a command of their own on its way, by `worker`. */
const busyWorkers = ref(new Set<number>());

function workerBusy(worker: number, on: boolean): void {
  const next = new Set(busyWorkers.value);
  if (on) next.add(worker);
  else next.delete(worker);
  busyWorkers.value = next;
}

/** Resume all waits while a worker it resumes has a command on its way, Pause all while any worker of the run has. */
const resumeAllBusy = computed(
  () => runBusy.value || level.value.resumeAll.some((c) => c.worker !== null && busyWorkers.value.has(c.worker)),
);
const pauseAllBusy = computed(
  () => runBusy.value || props.session.workers.some((worker) => busyWorkers.value.has(worker.worker)),
);

async function runControl(commands: ReadonlyArray<{ worker: number | null; since: string | null }>, action: string) {
  if (runBusy.value) return;
  runBusy.value = true;
  const said = await Promise.all(
    commands.map((c) =>
      hub.command({ type: 'runControl', ref: props.session.ref, worker: c.worker, action, since: c.since }),
    ),
  );
  runBusy.value = false;
  const refused = said.find((answer) => !answer.ok);
  if (refused?.message) emit('announce', refused.message);
}

function resumeAll(): void {
  if (!resumeAllBusy.value) void runControl(level.value.resumeAll, 'resume');
}

function pauseAll(): void {
  if (!pauseAllBusy.value) void runControl([{ worker: null, since: null }], 'pause');
}

// ── Focus ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const root = ref<HTMLElement | null>(null);
/** The keyboard is on a control of one of the run's workers, until it goes elsewhere. */
let onWorker = false;

function heardFocus(event: FocusEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : null;
  onWorker = !!target?.closest('[data-focus]') && !!root.value?.contains(target);
}

/** A press anywhere but on a control of this run's workers: the person put the focus there themselves. */
function heardPress(event: PointerEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest('[data-focus]') || !root.value?.contains(target)) onWorker = false;
}

onMounted(() => {
  document.addEventListener('focusin', heardFocus);
  document.addEventListener('pointerdown', heardPress, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('focusin', heardFocus);
  document.removeEventListener('pointerdown', heardPress, true);
});

/**
 * The tabs moved on while the keyboard was on a control of the worker now hidden: it goes to the tab of the worker
 * shown, never to one of its controls, which a key pressed again would answer.
 */
watch(shown, async (lane, before) => {
  if (lane === null || before === null || lane === before || !onWorker) return;
  await nextTick();
  const active = document.activeElement;
  const hidden = active instanceof HTMLElement && active.closest('[role="tabpanel"]')?.id === panelId(before);
  if (active && active !== document.body && !hidden) return;
  document.getElementById(tabId(lane))?.focus();
});
</script>

<template>
  <div class="space-y-1.5" data-shot="desktop-run-session">
    <p v-if="named" class="text-sm font-semibold text-highlighted">{{ desktopRunName(session) }}</p>
    <p v-if="presence" class="text-xs text-muted" data-testid="desktop-run-presence">{{ presence }}</p>
    <DesktopRunPageLink v-if="session.page" :page="session.page" />
    <div
      v-if="levelShown"
      role="group"
      :aria-label="desktopSay('runs_runControls')"
      class="flex flex-wrap items-center gap-1.5"
      data-testid="desktop-run-controls"
    >
      <UButton
        v-if="level.resumeAll.length"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-play"
        :title="desktopSay('runs_resumeAllTitle')"
        :aria-disabled="resumeAllBusy || undefined"
        @click="resumeAll()"
      >
        {{ desktopSay('runs_resumeAll') }}
      </UButton>
      <UButton
        v-if="level.pauseAll"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-pause"
        :title="desktopSay('runs_pauseAllTitle')"
        :aria-disabled="pauseAllBusy || undefined"
        @click="pauseAll()"
      >
        {{ desktopSay('runs_pauseAll') }}
      </UButton>
    </div>
    <DesktopRunShare :session="session" @announce="emit('announce', $event)" />
    <p v-if="workers.length === 0" class="text-xs text-muted">Starting a worker…</p>
    <div v-else ref="root" class="overflow-hidden rounded-md border border-default">
      <div
        v-if="tabs"
        role="tablist"
        :aria-label="desktopSay('runs_workerTabs')"
        class="flex gap-0.5 overflow-x-auto px-2 pt-1.5 shadow-[inset_0_-1px_0_var(--ui-border)]"
      >
        <button
          v-for="(tab, index) in tabList"
          :id="tabId(tab.lane)"
          :key="tab.lane"
          type="button"
          role="tab"
          class="desktop-run-tab inline-flex shrink-0 items-center gap-1.5 rounded-t-md px-2.5 py-1.5 text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
          :class="
            tab.lane === shown
              ? 'font-semibold text-highlighted shadow-[inset_0_-2px_0_var(--ui-text-highlighted)]'
              : 'text-muted hover:bg-elevated hover:text-highlighted'
          "
          :style="tab.style"
          :title="tab.words"
          :aria-selected="tab.lane === shown"
          :aria-controls="panelId(tab.lane)"
          :tabindex="tab.lane === shown ? 0 : -1"
          :data-lane="tab.lane"
          :data-status="tab.tone"
          @click="choose(tab.lane)"
          @keydown="onTabKey($event, index)"
        >
          <UIcon :name="tab.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          {{ tab.name }}
        </button>
      </div>
      <div
        :role="tabs ? undefined : 'list'"
        :aria-label="tabs ? undefined : `The workers of ${desktopRunName(session)}`"
        :class="{ 'divide-y divide-default': !tabs }"
      >
        <div
          v-for="worker in workers"
          v-show="!tabs || worker.parallelIndex === shown"
          :id="tabs ? panelId(worker.parallelIndex) : undefined"
          :key="worker.worker"
          :role="tabs ? 'tabpanel' : 'listitem'"
          :aria-labelledby="tabs ? tabId(worker.parallelIndex) : undefined"
          :data-lane="worker.parallelIndex"
        >
          <DesktopRunWorker
            :session="session"
            :worker="worker"
            :run-busy="runBusy"
            @announce="emit('announce', $event)"
            @busy="workerBusy(worker.worker, $event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* A stopped or failed worker's tab says so in its tone, darkened toward the text so it keeps its contrast. */
.desktop-run-tab[data-status='stopped'],
.desktop-run-tab[data-status='failed'] {
  color: color-mix(in srgb, var(--tone) 65%, var(--ui-text-highlighted));
}
</style>

<script setup lang="ts">
/**
 * Desktop shell only: a local run in a window of its own, named `name`, for as long as this component is mounted. It
 * has the shell open the window (`desktop_open_output_window`) on the dashboard's `/desktop/run-output` page and feeds
 * that page over `RUN_OUTPUT_CHANNEL`: the run's header, what it offers (its Hold failures, Run again, its pages), what
 * it failed on once it ended (`useDesktopLocalRunRows`), then the lines the page does not have yet. It does what the
 * page asks of the run it shows, as the tray would, and nothing it asks of another: Stop, Hold failures, Run again of
 * the run or of one of its tests, one at a time, which moves the window to the run it starts (`moveWindow`) while the
 * window is still wanted, a page of the run opened here, and the run shown in the tray again. A Run again that asks the
 * person to confirm a protected environment brings this window to the front, where the question shows. A window
 * the page before a reload had open (`kept`) is asked whether it is still there and fed again from its last line, never
 * opened again; one that does not answer within `KEPT_ANSWER_MS` is closed by its name, whatever shows in it. It
 * renders nothing here. Emits `closed` once the window is gone, with `opened` false when it could not open; unmounting
 * it closes the window.
 */
import {
  localRunCompareTo,
  localRunDetail,
  localRunEnvironmentNote,
  localRunRerunnable,
  localRunTitle,
  type LocalRun,
} from '~/composables/useDesktopLocalRuns';
import type { RunOutputLine } from '@piwitests/run-ui/run-output';
import { desktopEditorRunsOf } from '~/utils/desktop-run-view';
import {
  isAppPath,
  outputWindowNameOf,
  RUN_OUTPUT_CHANNEL,
  type RunOutputMessage,
  type RunOutputState,
  type RunWindowPage,
} from '~/utils/run-output-channel';

const props = defineProps<{
  run: LocalRun;
  name: string;
  /** The page before a reload had the window open: it is asked for, not opened again. */
  kept?: boolean;
}>();
const emit = defineEmits<{ closed: [opened: boolean] }>();

/** The event the shell emits with a run output window's label once it is gone. */
const OUTPUT_WINDOW_CLOSED_EVENT = 'piwi:output-window-closed';

/** How long a window the page before had open has to answer before it counts as closed. */
const KEPT_ANSWER_MS = 3000;

const store = useDesktopLocalRuns();
const { badge } = useDesktopRunBadge();
const hold = useDesktopRunHold();
const editorRuns = useDesktopEditorRuns();
const { rows, rerunnable: rowsRerunnable, canHold } = useDesktopLocalRunRows(() => props.run);

const name = props.name;
/** The window is open: opened here, or a kept one that answered. */
let open = false;
let keptWait: ReturnType<typeof setTimeout> | null = null;
let unmounted = false;
let channel: BroadcastChannel | null = null;
let stopListening: (() => void) | null = null;
/** The id of the last line the page has; null until it says it is ready. */
let sentThrough: number | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;
/** A Run again the window asked for is starting: the window asks for no other until it started or did not. */
const startingAgain = ref(false);

/** Everything the page shows of the run but its lines. */
const header = computed((): Omit<RunOutputState, 'type' | 'name' | 'lines'> => {
  const run = props.run;
  const running = run.status === 'running';
  const status = badge(run);
  return {
    key: run.key,
    title: localRunTitle(run),
    status: { label: status.label, color: status.color },
    detail: localRunDetail(run),
    note: localRunEnvironmentNote(run),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    running,
    stopRequested: run.stopRequested,
    stopRequestedAt: run.stopRequestedAt ?? null,
    refs: [...run.hubRefs],
    hold:
      running && desktopEditorRunsOf(run, editorRuns.value).length === 0
        ? { on: hold.holdsFailures(run), chosen: hold.chosen(run), refusal: hold.refusal(run) }
        : null,
    rerunnable: !running && localRunRerunnable(run),
    startingAgain: startingAgain.value,
    piwiRunId: run.piwiRunId,
    failed: run.status === 'failed',
    sourceRunId: run.sourceRunId != null && run.sourceRunId !== run.piwiRunId ? run.sourceRunId : null,
    projectId: run.projectId,
    projectLabel: run.projectLabel,
    rows: rows.value.map(({ key, status: outcome, title, place, project, error, executionId, retry }) => ({
      key,
      status: outcome,
      title,
      place,
      project,
      error: [...error],
      executionId,
      rerunnable: rowsRerunnable.value && !!retry,
    })),
    rowsHold: rowsRerunnable.value && canHold.value,
  };
});

function send() {
  pending = null;
  if (!channel || sentThrough === null) return;
  const since = sentThrough;
  const lines: RunOutputLine[] = props.run.lines
    .filter((line) => line.id > since)
    .map(({ id, text, error, ansi }) => (ansi === undefined ? { id, text, error } : { id, text, error, ansi }));
  const state: RunOutputState = { type: 'state', name, ...header.value, lines };
  channel.postMessage(state);
  sentThrough = lines.at(-1)?.id ?? since;
}

function schedule() {
  pending ??= setTimeout(send, 100);
}

watch(() => [props.run.linesTotal, JSON.stringify(header.value)], schedule);
// The window shows another run (a Run again from it): the page gets that run's lines from its first.
watch(
  () => props.run.key,
  () => {
    if (sentThrough !== null) sentThrough = 0;
    schedule();
  },
);

/** Brings the dashboard window to the front, where what the window asked for shows. */
function toFront() {
  void tauriCore()
    ?.invoke('desktop_bring_to_front')
    .catch(() => {});
}

/**
 * Runs `start` (a Run again), which may ask the person to confirm a protected environment in the dashboard window,
 * brought to the front as it asks; the run it starts shows in this window, while the window still shows the run it
 * came from.
 */
async function runAgain(start: () => Promise<LocalRun | null>) {
  if (startingAgain.value) return;
  startingAgain.value = true;
  const from = props.run;
  const asking = watch(store.environmentQuestion, (question) => question && toFront(), { immediate: true });
  try {
    const next = await start();
    const wanted = !unmounted && props.run === from && store.separate.value[from.key];
    if (next && wanted) store.moveWindow(from, next);
  } finally {
    asking();
    startingAgain.value = false;
  }
}

/** The path of the page `page` names of the run, as the window may ask for it; null for none. */
async function pathOf(run: LocalRun, page: RunWindowPage): Promise<string | null> {
  if (page === 'failure') return run.status === 'failed' && run.piwiRunId != null ? store.failurePage(run) : null;
  if (page === 'run') return run.piwiRunId != null ? `/test-runs/${run.piwiRunId}` : null;
  if (page === 'compare') return localRunCompareTo(run);
  if ('execution' in page) {
    return rows.value.some((row) => row.executionId === page.execution) ? `/test-run-cases/${page.execution}` : null;
  }
  return typeof page.path === 'string' && isAppPath(page.path) ? page.path : null;
}

/** Opens a page of the run in the dashboard window, brought to the front. */
async function openPage(page: RunWindowPage) {
  const path = await pathOf(props.run, page);
  if (!path) return;
  store.trayOpen.value = false;
  await navigateTo(path);
  toFront();
}

function hear(data: RunOutputMessage) {
  const run = props.run;
  if (data.type === 'ready') {
    open = true;
    if (keptWait) clearTimeout(keptWait);
    keptWait = null;
    // A window that shows another run than this one has none of its lines.
    sentThrough = data.key === undefined || data.key === run.key ? (data.through ?? 0) : 0;
    send();
    return;
  }
  if (!('key' in data) || data.key !== run.key) return;
  switch (data.type) {
    case 'stop':
      if (run.status === 'running') void store.stopRun(run);
      return;
    case 'hold':
      if (header.value.hold && typeof data.on === 'boolean' && !header.value.hold.refusal) hold.setHold(run, data.on);
      return;
    case 'rerun':
      if (run.status !== 'running' && localRunRerunnable(run)) void runAgain(() => store.rerun(run));
      return;
    case 'rerun-test': {
      const row = rows.value.find((each) => each.key === data.row);
      if (!row?.retry || !rowsRerunnable.value || (data.hold && !canHold.value)) return;
      const { retry, piwiRunId } = row;
      void runAgain(() => store.rerunTests(run, [retry], data.hold ? { holdFailures: true } : {}, piwiRunId));
      return;
    }
    case 'open':
      void openPage(data.page);
      return;
    case 'back':
      store.showRun(run.key);
      toFront();
      return;
  }
}

onMounted(async () => {
  channel = new BroadcastChannel(RUN_OUTPUT_CHANNEL);
  channel.onmessage = ({ data }: MessageEvent<RunOutputMessage>) => {
    if (data && 'name' in data && data.name === name) hear(data);
  };
  const unlisten = await tauriEvent()
    ?.listen<string>(OUTPUT_WINDOW_CLOSED_EVENT, ({ payload }) => {
      if (outputWindowNameOf(payload) !== name) return;
      open = false;
      emit('closed', true);
    })
    .catch(() => null);
  stopListening = unlisten ?? null;
  if (unmounted) {
    stopListening?.();
    if (props.kept && !open) closeByName();
    return;
  }
  if (props.kept) {
    channel.postMessage({ type: 'ask', name } satisfies RunOutputMessage);
    keptWait = setTimeout(() => {
      keptWait = null;
      if (open || unmounted) return;
      closeByName();
      emit('closed', true);
    }, KEPT_ANSWER_MS);
    return;
  }
  let label: string | null = null;
  try {
    label = (await tauriCore()?.invoke<string>('desktop_open_output_window', { name })) ?? null;
  } catch {
    label = null;
  }
  open = !!label;
  if (unmounted) {
    closeWindow();
    stopListening?.();
  } else if (!label) {
    emit('closed', false);
  }
});

/** Has the shell close the window of this name, if it has one. */
function closeByName() {
  tauriCore()
    ?.invoke('desktop_close_output_window', { name })
    .catch(() => {});
}

function closeWindow() {
  if (open) closeByName();
  open = false;
}

onBeforeUnmount(() => {
  unmounted = true;
  if (pending) clearTimeout(pending);
  // A kept window that has not answered yet may still be open.
  if (keptWait) {
    clearTimeout(keptWait);
    closeByName();
  }
  channel?.close();
  stopListening?.();
  closeWindow();
});
</script>

<template>
  <span hidden />
</template>

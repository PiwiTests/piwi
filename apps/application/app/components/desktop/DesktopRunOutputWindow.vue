<script setup lang="ts">
/**
 * Desktop shell only: a local run's output in a window of its own, for as long as this component is mounted. It has
 * the shell open the window (`desktop_open_output_window`) on the dashboard's `/desktop/run-output` page and feeds
 * that page over `RUN_OUTPUT_CHANNEL`: the run's header, then the lines the page does not have yet. A window the page
 * before a reload had open (`kept`) is asked whether it is still there and fed again from its last line, never opened
 * again; one that does not answer within `KEPT_ANSWER_MS` was closed meanwhile. It renders nothing here. Emits `stop`
 * when the window's Stop is pressed, and `closed` once the window is gone, with `opened` false when it could not
 * open; unmounting it closes the window.
 */
import type { LocalRun, LocalRunLine } from '~/composables/useDesktopLocalRuns';
import type { BadgeColor } from '~/utils';
import {
  outputWindowNameOf,
  RUN_OUTPUT_CHANNEL,
  runOutputWindowName,
  type RunOutputMessage,
  type RunOutputState,
} from '~/utils/run-output-channel';

const props = defineProps<{
  run: LocalRun;
  title: string;
  status: { label: string; color: BadgeColor };
  detail: string;
  /** The page before a reload had the window open: it is asked for, not opened again. */
  kept?: boolean;
}>();
const emit = defineEmits<{ stop: []; closed: [opened: boolean] }>();

/** The event the shell emits with a run output window's label once it is gone. */
const OUTPUT_WINDOW_CLOSED_EVENT = 'piwi:output-window-closed';

/** How long a window the page before had open has to answer before it counts as closed. */
const KEPT_ANSWER_MS = 3000;

const name = runOutputWindowName(props.run.key);
/** The window is open: opened here, or a kept one that answered. */
let open = false;
let keptWait: ReturnType<typeof setTimeout> | null = null;
let unmounted = false;
let channel: BroadcastChannel | null = null;
let stopListening: (() => void) | null = null;
/** The id of the last line the page has; null until it says it is ready. */
let sentThrough: number | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

function send() {
  pending = null;
  if (!channel || sentThrough === null) return;
  const since = sentThrough;
  const lines: LocalRunLine[] = props.run.lines
    .filter((line) => line.id > since)
    .map(({ id, text, error, ansi }) => (ansi === undefined ? { id, text, error } : { id, text, error, ansi }));
  const state: RunOutputState = {
    type: 'state',
    name,
    title: props.title,
    status: { label: props.status.label, color: props.status.color },
    detail: props.detail,
    startedAt: props.run.startedAt,
    finishedAt: props.run.finishedAt,
    running: props.run.status === 'running',
    stopRequested: props.run.stopRequested,
    lines,
  };
  channel.postMessage(state);
  sentThrough = lines.at(-1)?.id ?? since;
}

function schedule() {
  pending ??= setTimeout(send, 100);
}

watch(
  () => [
    props.run.linesTotal,
    props.run.status,
    props.run.finishedAt,
    props.run.stopRequested,
    props.title,
    props.status.label,
    props.status.color,
    props.detail,
  ],
  schedule,
);

onMounted(async () => {
  channel = new BroadcastChannel(RUN_OUTPUT_CHANNEL);
  channel.onmessage = ({ data }: MessageEvent<RunOutputMessage>) => {
    if (data?.name !== name) return;
    if (data.type === 'ready') {
      open = true;
      if (keptWait) clearTimeout(keptWait);
      keptWait = null;
      sentThrough = data.through ?? 0;
      send();
    } else if (data.type === 'stop') {
      emit('stop');
    }
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
    return;
  }
  if (props.kept) {
    channel.postMessage({ type: 'ask', name } satisfies RunOutputMessage);
    keptWait = setTimeout(() => {
      keptWait = null;
      if (!open && !unmounted) emit('closed', true);
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

function closeWindow() {
  if (open)
    tauriCore()
      ?.invoke('desktop_close_output_window', { name })
      .catch(() => {});
  open = false;
}

onBeforeUnmount(() => {
  unmounted = true;
  if (pending) clearTimeout(pending);
  if (keptWait) clearTimeout(keptWait);
  channel?.close();
  stopListening?.();
  closeWindow();
});
</script>

<template>
  <span hidden />
</template>

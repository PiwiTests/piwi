<script setup lang="ts">
import { DESKTOP_APP_NAME } from '#shared/piwi-ecosystem';
/**
 * Desktop shell only: a local run's output in a window of its own, which the Local runs tray has the shell open on
 * this page (`DesktopRunOutputWindow`), named by `?name=`. The tray feeds it over `RUN_OUTPUT_CHANNEL`: the run's
 * header, then its new lines (`DesktopRunOutputPane`); Stop, then Force stop, asks the tray to stop the run
 * (`DesktopRunStopButton`). It outlives a reload of the dashboard window, whose
 * next page asks whether it is still there and feeds it again from the last line it has. A window of its own: no
 * layout.
 */
import { LOCAL_RUN_MAX_LINES, localRunDuration } from '~/composables/useDesktopLocalRuns';
import type { RunOutputLine } from '@piwitests/run-ui/run-output';
import {
  mergeRunOutputLines,
  RUN_OUTPUT_CHANNEL,
  type RunOutputMessage,
  type RunOutputState,
} from '~/utils/run-output-channel';

definePageMeta({ layout: false });

const name = String(useRoute().query.name ?? '');
const header = shallowRef<Omit<RunOutputState, 'lines'> | null>(null);
const lines = shallowRef<RunOutputLine[]>([]);
let channel: BroadcastChannel | null = null;

/** Says the window is ready for the run's state, from the line after the last one it has. */
function ready() {
  channel?.postMessage({ type: 'ready', name, through: lines.value.at(-1)?.id ?? 0 } satisfies RunOutputMessage);
}

function stop() {
  channel?.postMessage({ type: 'stop', name } satisfies RunOutputMessage);
}

onMounted(() => {
  channel = new BroadcastChannel(RUN_OUTPUT_CHANNEL);
  channel.onmessage = ({ data }: MessageEvent<RunOutputMessage>) => {
    if (data?.name !== name) return;
    if (data.type === 'ask') return ready();
    if (data.type !== 'state') return;
    const { lines: sent, ...rest } = data;
    header.value = rest;
    lines.value = mergeRunOutputLines(lines.value, { ...rest, lines: sent }, LOCAL_RUN_MAX_LINES);
  };
  ready();
});

onBeforeUnmount(() => channel?.close());

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });

useHead(() => ({ title: `${header.value?.title ?? 'Run output'} · ${DESKTOP_APP_NAME}` }));
</script>

<template>
  <section aria-label="Run output" class="flex h-dvh flex-col gap-2 bg-default p-3">
    <header class="flex min-w-0 items-center gap-2">
      <template v-if="header">
        <UBadge :color="header.status.color" variant="subtle" size="sm" class="shrink-0">
          {{ header.status.label }}
        </UBadge>
        <h1 class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted" :title="header.title">
          {{ header.title }}
        </h1>
        <span class="shrink-0 text-xs text-muted tabular-nums">
          {{ localRunDuration(header.startedAt, header.finishedAt, now) }}
        </span>
        <DesktopRunStopButton
          v-if="header.running"
          :stopping="header.stopRequested"
          :since="header.stopRequestedAt"
          @stop="stop"
          @force="stop"
        />
      </template>
      <h1 v-else class="text-sm font-semibold text-highlighted">Run output</h1>
    </header>
    <p v-if="header" class="truncate font-mono text-xs text-muted" :title="header.detail">{{ header.detail }}</p>
    <DesktopRunOutputPane :lines="lines" fill class="min-h-0 flex-1" />
  </section>
</template>

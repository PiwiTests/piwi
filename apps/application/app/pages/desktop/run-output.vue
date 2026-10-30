<script setup lang="ts">
/**
 * Desktop shell only: a local run's output in a window of its own, which the Local runs tray has the shell open on
 * this page (`DesktopRunOutputWindow`), named by `?name=`. The tray feeds it over `RUN_OUTPUT_CHANNEL`: the run's
 * header, then its new lines; Stop asks the tray to stop the run. A window of its own: no layout.
 */
import { LOCAL_RUN_MAX_LINES, localRunDuration, type LocalRunLine } from '~/composables/useDesktopLocalRuns';
import {
  mergeRunOutputLines,
  RUN_OUTPUT_CHANNEL,
  type RunOutputMessage,
  type RunOutputState,
} from '~/utils/run-output-channel';

definePageMeta({ layout: false });

const name = String(useRoute().query.name ?? '');
const header = shallowRef<Omit<RunOutputState, 'lines'> | null>(null);
const lines = shallowRef<LocalRunLine[]>([]);
let channel: BroadcastChannel | null = null;

function post(type: 'ready' | 'stop') {
  channel?.postMessage({ type, name } satisfies RunOutputMessage);
}

onMounted(() => {
  channel = new BroadcastChannel(RUN_OUTPUT_CHANNEL);
  channel.onmessage = ({ data }: MessageEvent<RunOutputMessage>) => {
    if (data?.type !== 'state' || data.name !== name) return;
    const { lines: sent, ...rest } = data;
    header.value = rest;
    lines.value = mergeRunOutputLines(lines.value, { ...rest, lines: sent }, LOCAL_RUN_MAX_LINES);
  };
  post('ready');
});

onBeforeUnmount(() => channel?.close());

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });

useHead(() => ({ title: `${header.value?.title ?? 'Run output'} · Piwi Dashboard` }));
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
        <UButton
          v-if="header.running"
          size="xs"
          color="error"
          :variant="header.stopRequested ? 'solid' : 'soft'"
          icon="i-lucide-square"
          @click="post('stop')"
        >
          {{ header.stopRequested ? 'Force stop' : 'Stop' }}
        </UButton>
      </template>
      <h1 v-else class="text-sm font-semibold text-highlighted">Run output</h1>
    </header>
    <p v-if="header" class="truncate font-mono text-xs text-muted" :title="header.detail">{{ header.detail }}</p>
    <DesktopLocalRunConsole :lines="lines" fill class="min-h-0 flex-1" />
  </section>
</template>

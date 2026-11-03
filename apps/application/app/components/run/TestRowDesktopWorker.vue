<script setup lang="ts">
/**
 * A running test's worker in a run the desktop shell started, on its row of the run page, as the runs' hub tells it.
 * While the test runs, **Pause and watch** stops it before its next call that acts on or checks the page, with Watch
 * live on for its worker: the Local runs tray, which opens at the stop, shows its page live there. At a stop, where
 * the test stands, and **Show its page**, which opens the tray again. A test that never stops says why. The tray
 * steers the stop; this row only asks for it.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { desktopRunStop, desktopStopPlace, desktopWorkerState } from '~/utils/desktop-run-view';

const props = defineProps<{
  session: HubSession;
  worker: HubWorker;
  /** Piwi project id + name, for the IDE opener of the stop's place. */
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

const hub = useDesktopRunHub();
const { trayOpen } = useDesktopLocalRuns();
const toast = useToast();

const stop = computed(() => desktopRunStop(props.worker));
const failed = computed(() => stop.value?.reason === 'failure');
/** Why the test stopped, as the tray's worker says it; a failure's place shows beside it, as a link. */
const stopWords = computed(() => (failed.value ? 'Failed' : desktopWorkerState(props.worker, props.session.root)));
const place = computed(() => (stop.value ? desktopStopPlace(stop.value, props.session.root) : ''));
const stopText = computed(() =>
  stop.value ? [stopWords.value, failed.value ? '' : stop.value.title, place.value].filter(Boolean).join(' · ') : '',
);
const cannotPause = computed(() => props.worker.test?.cannotPause ?? null);
/** The pause is on its way to the hub, or reached the worker, which has not stopped yet. */
const busy = ref(false);
const pausing = computed(() => !stop.value && (busy.value || props.worker.pausing));

async function pauseAndWatch(): Promise<void> {
  if (pausing.value) return;
  const runRef = props.session.ref;
  const index = props.worker.worker;
  const watched = hub.watchesLive(runRef, index);
  hub.setWatchLive(runRef, index, true);
  busy.value = true;
  const answer = await hub.command({ type: 'runControl', ref: runRef, worker: index, action: 'pause', since: null });
  busy.value = false;
  if (answer.ok) return;
  if (!watched) hub.setWatchLive(runRef, index, false);
  toast.add({ title: 'The test was not paused', description: answer.message, color: 'error' });
}

function onClick(): void {
  if (stop.value) trayOpen.value = true;
  else void pauseAndWatch();
}
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 max-w-full" @click.stop>
    <span v-if="cannotPause" class="text-xs text-muted" data-testid="desktop-cannot-pause">
      This test never stops: {{ cannotPause }}
    </span>
    <template v-else>
      <span
        v-if="stop"
        class="inline-flex items-center gap-1 min-w-0 max-w-full text-xs"
        data-testid="desktop-stopped"
        :title="stopText"
      >
        <UIcon v-if="failed" name="i-lucide-circle-x" class="size-3 shrink-0 text-error" />
        <UIcon v-else name="i-lucide-pause" class="size-3 shrink-0 text-warning" />
        <span class="font-semibold text-highlighted">{{ stopWords }}</span>
        <span v-if="!failed" class="truncate text-muted">· {{ stop.title }}</span>
        <span class="text-muted">·</span>
        <OpenInIdeLink :location="place" :project-key="projectKey" :project-name="projectName" class="text-muted" />
      </span>
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        :icon="pausing ? 'i-lucide-clock' : 'i-lucide-eye'"
        :label="stop ? 'Show its page' : pausing ? 'Pausing…' : 'Pause and watch'"
        :title="
          stop
            ? 'Open Local runs, where the stopped page shows'
            : pausing
              ? 'The test stops before its next call that acts on or checks the page'
              : 'Stop the test before its next call that acts on or checks the page, and watch its page live in Local runs'
        "
        :aria-disabled="pausing || undefined"
        data-testid="desktop-watch"
        @click="onClick"
      />
    </template>
  </span>
</template>

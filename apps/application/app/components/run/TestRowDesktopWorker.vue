<script setup lang="ts">
/**
 * A running test's worker in a run the desktop shell started, on its row of the run page, as the runs' hub tells it.
 * While the test runs, **Pause and watch** stops it before its next call that acts on or checks the page, with Watch
 * live on for its worker: the Local runs tray, which opens at the stop, shows its page live there. At a stop, where
 * the test stands, and **Show its page**, which opens the tray on the worker and moves the focus there. A test that
 * never stops says why. The tray steers the stop; this row only asks for it.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import {
  desktopRunStop,
  desktopStopLink,
  desktopStopPlace,
  desktopWorkerState,
  desktopWorkerTest,
} from '~/utils/desktop-run-view';

const props = defineProps<{
  session: HubSession;
  worker: HubWorker;
  /** Piwi project id + name, for the IDE opener of the stop's place. */
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

const hub = useDesktopRunHub();
const { showWorker } = useDesktopLocalRuns();
const toast = useToast();

const stop = computed(() => desktopRunStop(props.worker));
const failed = computed(() => stop.value?.reason === 'failure');
/** Why the test stopped, as the tray's worker says it; a failure's place shows beside it. */
const stopWords = computed(() => (failed.value ? 'Failed' : desktopWorkerState(props.worker, props.session.root)));
const place = computed(() => (stop.value ? desktopStopPlace(stop.value, props.session.root) : ''));
const link = computed(() => (stop.value ? desktopStopLink(stop.value, props.session.root) : null));
const stopText = computed(() =>
  stop.value ? [stopWords.value, failed.value ? '' : stop.value.title, place.value].filter(Boolean).join(' · ') : '',
);
const cannotPause = computed(() => props.worker.test?.cannotPause ?? null);
/** The pause is on its way to the hub, or reached the worker, which has not stopped yet. */
const busy = ref(false);
const pausing = computed(() => !stop.value && (busy.value || props.worker.pausing));
const label = computed(() => (stop.value ? 'Show its page' : pausing.value ? 'Pausing…' : 'Pause and watch'));
/** The button's name: its label, then the test, so each running row's reads apart. */
const name = computed(() => {
  const test = desktopWorkerTest(props.worker);
  return test ? `${label.value}: ${test}` : label.value;
});

async function pauseAndWatch(): Promise<void> {
  if (pausing.value) return;
  // Watch live stays on whatever the hub answers: a test that stopped meanwhile is watched at that stop.
  hub.setWatchLive(props.session.ref, props.worker.worker, true);
  busy.value = true;
  const answer = await hub.command({
    type: 'runControl',
    ref: props.session.ref,
    worker: props.worker.worker,
    action: 'pause',
    since: null,
  });
  busy.value = false;
  if (!answer.ok) toast.add({ title: 'Pause and watch', description: answer.message, icon: 'i-lucide-info' });
}

function onClick(): void {
  if (stop.value) showWorker(props.session.ref, props.worker.worker);
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
        <OpenInIdeLink
          v-if="link"
          :file-path="link.file"
          :line="link.line"
          :project-key="projectKey"
          :project-name="projectName"
          class="text-muted"
        />
        <span v-else class="font-mono text-muted break-all">{{ place }}</span>
      </span>
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        :icon="pausing ? 'i-lucide-clock' : 'i-lucide-eye'"
        :label="label"
        :aria-label="name"
        :title="
          stop
            ? 'Open Local runs on this test, where its stopped page shows'
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

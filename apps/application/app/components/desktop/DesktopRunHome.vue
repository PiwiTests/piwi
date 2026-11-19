<script setup lang="ts">
/**
 * Desktop shell only: a run of this window's Local runs on its own run page, the run's home while it goes on: its
 * **Stop** (`DesktopRunStopButton`), its **Hold failures**, each worker with its controls and its page live (`DesktopRunSession`, as the tray
 * shows them), and its output. Shown for the tray's running run whose Piwi run is the page's (`piwiRunId`), with the
 * hub's runs that report to it (`sessions`, the page's `useDesktopRunSessions`). While the Local runs tray is open
 * under the page, which shows the run's workers and output, the card keeps its Stop and **Show in Local runs** alone,
 * so the page keeps its height.
 */
import type { HubSession } from '@piwitests/core/run-hub';
import { localRunTitle, type LocalRun } from '~/composables/useDesktopLocalRuns';

const props = defineProps<{
  /** The page's Piwi run. */
  runId: number;
  /** The hub's live runs that report to it. */
  sessions: HubSession[];
}>();

const store = useDesktopLocalRuns();
const { runs } = store;

/** The tray is open under the page: it shows the run, which the card only names. */
const trayShows = computed(() => store.trayOpen.value && store.trayMounts.value > 0);

/** The tray's run of this page's run, while it goes on. */
const run = computed<LocalRun | undefined>(() =>
  runs.value.find((candidate) => candidate.piwiRunId === props.runId && candidate.status === 'running'),
);

const outputShown = ref(false);

/** What the live region reads out: what a command answered. */
const announcement = ref('');
function announce(text: string) {
  announcement.value = '';
  requestAnimationFrame(() => {
    announcement.value = text;
  });
}
</script>

<template>
  <SectionCard
    v-if="run"
    title="On your machine"
    icon="i-lucide-monitor-play"
    :subtitle="localRunTitle(run)"
    class="mt-4"
    data-shot="desktop-run-home"
  >
    <template #actions>
      <UButton
        v-if="trayShows"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-panel-bottom-open"
        @click="store.showRun(run.key)"
      >
        Show in Local runs
      </UButton>
      <DesktopRunStopButton
        :stopping="run.stopRequested"
        :since="run.stopRequestedAt"
        @stop="store.stopRun(run)"
        @force="store.stopRun(run)"
      />
    </template>
    <p v-if="trayShows" class="text-sm text-muted">Its workers and its output are in Local runs, under the page.</p>
    <!-- From lg the page's summary does not scroll: the card scrolls inside, so the tabs below keep their room. -->
    <div v-else class="flex flex-col gap-3 lg:max-h-[40dvh] lg:overflow-y-auto">
      <DesktopRunHoldSwitch :run="run" :described-id="`desktop-run-home-hold-${run.key}`" />
      <DesktopRunSession
        v-for="session in sessions"
        :key="session.ref"
        :session="session"
        class="rounded-md border border-default"
        @announce="announce"
      />
      <div>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="outputShown ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          :aria-expanded="outputShown"
          @click="outputShown = !outputShown"
        >
          Output
        </UButton>
        <DesktopRunOutputPane v-if="outputShown" :lines="run.lines" class="mt-1" />
      </div>
    </div>
    <p role="status" aria-live="polite" class="sr-only">{{ announcement }}</p>
  </SectionCard>
</template>

<script setup lang="ts">
/**
 * Desktop shell only: a run of this window's Local runs on its own run page, the run's home while it goes on: its
 * **Stop**, its **Hold failures**, each worker with its controls and its page live (`DesktopRunSession`, as the tray
 * shows them), and its output. Shown for the tray's running run whose Piwi run is the page's (`piwiRunId`), with the
 * hub's runs that report to it (`sessions`, the page's `useDesktopRunSessions`); the tray keeps showing the run too.
 */
import type { HubSession } from '@piwitests/core/run-hub';
import { localRunTitle, type LocalRun } from '~/composables/useDesktopLocalRuns';
import { desktopHeldSessions, desktopRunHoldRefusal, desktopRunHolds } from '~/utils/desktop-run-view';

const props = defineProps<{
  /** The page's Piwi run. */
  runId: number;
  /** The hub's live runs that report to it. */
  sessions: HubSession[];
}>();

const store = useDesktopLocalRuns();
const { runs, holds } = store;
const hub = useDesktopRunHub();
const liveSessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);

/** The tray's run of this page's run, while it goes on. */
const run = computed<LocalRun | undefined>(() =>
  runs.value.find((candidate) => candidate.piwiRunId === props.runId && candidate.status === 'running'),
);

const holdRefusal = computed(() => (run.value ? desktopRunHoldRefusal(run.value, liveSessions.value) : null));
const holdsFailures = computed(() =>
  run.value ? desktopRunHolds(run.value, holds.value[run.value.key], liveSessions.value) : false,
);

/** The person turns the run's Hold failures over, as in the tray: its live steps at once, the steps to come as they start. */
function setHold(on: boolean) {
  const current = run.value;
  if (!current) return;
  for (const session of desktopHeldSessions(current, liveSessions.value)) {
    void hub.command({ type: 'hold', ref: session.ref, on });
  }
  holds.value = { ...holds.value, [current.key]: on };
}

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
        v-if="run.stopRequested"
        size="xs"
        color="error"
        variant="solid"
        icon="i-lucide-square"
        title="Kill the process without waiting"
        @click="store.stopRun(run)"
      >
        Force stop
      </UButton>
      <UButton v-else size="xs" color="neutral" variant="outline" icon="i-lucide-square" @click="store.stopRun(run)">
        Stop
      </UButton>
    </template>
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <USwitch
          :model-value="holdsFailures"
          :disabled="!!holdRefusal"
          label="Hold failures"
          size="sm"
          :aria-describedby="`desktop-run-home-hold-${run.key}`"
          :ui="{ label: 'text-xs font-medium' }"
          @update:model-value="(on: boolean) => setHold(on)"
        />
        <p :id="`desktop-run-home-hold-${run.key}`" class="min-w-0 text-xs text-muted">
          {{ holdRefusal ?? 'A failing test waits at its line for you to look at it and resume.' }}
        </p>
      </div>
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
        <DesktopLocalRunConsole v-if="outputShown" :lines="run.lines" class="mt-1" />
      </div>
    </div>
    <p role="status" aria-live="polite" class="sr-only">{{ announcement }}</p>
  </SectionCard>
</template>

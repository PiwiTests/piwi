<script setup lang="ts">
/**
 * Desktop shell only: the **Hold failures** switch of a running run of the Local runs tray, with the sentence that
 * says what it does or why the run holds none (a run nobody attends, by its kind or as the hub names its steps). The
 * tray shows it under each running run, and the run page's **On your machine** card under its own.
 */
import type { HubSession } from '@piwitests/core/run-hub';
import type { LocalRun } from '~/composables/useDesktopLocalRuns';
import { desktopHeldSessions, desktopRunHoldRefusal, desktopRunHolds } from '~/utils/desktop-run-view';

const props = defineProps<{
  run: LocalRun;
  /** The id of the sentence, unique on the page. */
  describedId: string;
}>();

const { holds } = useDesktopLocalRuns();
const hub = useDesktopRunHub();
const liveSessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);

const refusal = computed(() => desktopRunHoldRefusal(props.run, liveSessions.value));
const holdsFailures = computed(() => desktopRunHolds(props.run, holds.value[props.run.key], liveSessions.value));

/** The person turns the run's Hold failures over: its live steps at once, the steps to come as they start. */
function setHold(on: boolean) {
  for (const session of desktopHeldSessions(props.run, liveSessions.value)) {
    void hub.command({ type: 'hold', ref: session.ref, on });
  }
  holds.value = { ...holds.value, [props.run.key]: on };
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
    <USwitch
      :model-value="holdsFailures"
      :disabled="!!refusal"
      label="Hold failures"
      size="sm"
      :aria-describedby="describedId"
      :ui="{ label: 'text-xs font-medium' }"
      @update:model-value="(on: boolean) => setHold(on)"
    />
    <p :id="describedId" class="min-w-0 text-xs text-muted">
      {{ refusal ?? 'A failing test waits at its line for you to look at it and resume.' }}
    </p>
  </div>
</template>

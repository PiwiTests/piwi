<script setup lang="ts">
/**
 * Desktop shell only: the **Hold failures** switch of a running run of the Local runs tray, with the sentence that
 * says what it does or why the run holds none (a run nobody attends, by its kind or as the hub names its steps). The
 * tray shows it under each running run, and the run page's **On your machine** card under its own.
 */
import type { LocalRun } from '~/composables/useDesktopLocalRuns';

const props = defineProps<{
  run: LocalRun;
  /** The id of the sentence, unique on the page. */
  describedId: string;
}>();

const hold = useDesktopRunHold();
const refusal = computed(() => hold.refusal(props.run));
const holdsFailures = computed(() => hold.holdsFailures(props.run));

/** The person turns the run's Hold failures over: its live steps at once, the steps to come as they start. */
function setHold(on: boolean) {
  hold.setHold(props.run, on);
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

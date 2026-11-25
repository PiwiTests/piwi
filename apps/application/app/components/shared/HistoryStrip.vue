<script setup lang="ts">
/**
 * A test's recent executions as a row of squares, oldest to newest, colored by
 * outcome with the current execution ringed, each naming its run and outcome on
 * hover. Each square links to its execution, unless `linked` is false: then the
 * row is drawn inside a control of its own (the History line of an execution's
 * situation block, one link to the test's page). No chart, no table: the full
 * history lives on the test page.
 */
import type { TestCaseHistoryPoint } from '~~/types/api';

const props = withDefaults(
  defineProps<{
    history: TestCaseHistoryPoint[];
    /** The current execution's id: ringed in the strip. */
    currentId?: number | null;
    /** Each square links to its execution; false inside a control of its own. */
    linked?: boolean;
  }>(),
  { currentId: null, linked: true },
);

/** Oldest → newest, capped at 24, for the strip. */
const strip = computed(() => props.history.slice(0, 24).slice().reverse());

const SQUARE_CLASS = 'size-3.5 rounded-sm inline-block';

function pointLabel(point: TestCaseHistoryPoint): string {
  return `Execution in run #${point.runId}: ${formatExecutionStatus(point.status, point.passedAfterFailure)}`;
}
</script>

<template>
  <div
    v-if="strip.length"
    class="flex items-center gap-1 flex-wrap"
    :role="linked ? 'group' : undefined"
    :aria-label="linked ? 'Recent executions of this test, oldest to newest' : undefined"
  >
    <UTooltip v-for="point in strip" :key="point.id" :text="pointLabel(point)">
      <NuxtLink
        v-if="linked"
        :to="`/test-run-cases/${point.id}`"
        :aria-label="pointLabel(point)"
        :aria-current="point.id === currentId ? 'true' : undefined"
        class="transition-opacity hover:opacity-80 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        :class="[
          SQUARE_CLASS,
          statusPalette(point.status, point.passedAfterFailure).bg,
          point.id === currentId ? CURRENT_ITEM_RING_CLASS : '',
        ]"
      />
      <span
        v-else
        :class="[
          SQUARE_CLASS,
          statusPalette(point.status, point.passedAfterFailure).bg,
          point.id === currentId ? CURRENT_ITEM_RING_CLASS : '',
        ]"
      />
    </UTooltip>
  </div>
</template>

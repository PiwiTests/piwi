<script setup lang="ts">
/**
 * The History line of an execution's situation block: the test's recent
 * executions as one strip of squares in the outcome colors, oldest to newest,
 * this execution ringed, then a sentence anchored to this execution: how many
 * runs in a row it has failed and the last run it passed in. Each square opens
 * its execution and names its run and outcome on hover; the strip is one
 * keyboard stop, and its name counts the outcomes for a screen reader. A
 * passing execution's line is the strip alone, which already says how the test
 * has been doing. The test's own page opens from the navbar's Test history.
 */
import type { TestCaseHistoryPoint } from '~~/types/api';
import { HISTORY_STRIP_LENGTH, historyStreak } from '~/utils/history-streak';

const props = defineProps<{
  history: TestCaseHistoryPoint[];
  /** The execution being viewed: ringed in the strip and the sentence's anchor. */
  currentId: number;
}>();

const streak = computed(() => historyStreak(props.history, props.currentId));

/** The strip's name: how many of the executions it shows ended each way, and this one's outcome. */
const stripLabel = computed(() => {
  const shown = props.history.slice(0, HISTORY_STRIP_LENGTH);
  const counts = new Map<string, number>();
  for (const point of shown) {
    const outcome = formatExecutionStatus(point.status, point.passedAfterFailure);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const current = shown.find((point) => point.id === props.currentId);
  const parts = [...counts].map(([outcome, count]) => `${count} ${outcome}`);
  const self = current ? `, this one ${formatExecutionStatus(current.status, current.passedAfterFailure)}` : '';
  return `Last ${shown.length} executions of this test, oldest to newest: ${parts.join(', ')}${self}`;
});

/** The sentence without the last pass's run and date, which render as a link and a relative time. */
const lead = computed(() => {
  const s = streak.value;
  if (!s || s.count < 1) return null;
  const failing = s.count === 1 ? 'Failing for 1 run' : `Failing for ${s.count} runs in a row`;
  if (s.lastPass) return failing;
  if (s.total > 1) return `${failing}, no passing run in the ${s.total} recorded`;
  return 'First recorded run of this test';
});
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1" data-shot="execution-history">
    <HistoryStrip class="min-w-0 max-w-full" :history="history" :current-id="currentId" :label="stripLabel" />
    <span v-if="lead"
      >{{ lead
      }}<template v-if="streak?.lastPass"
        >, last passed in
        <NuxtLink :to="`/test-run-cases/${streak.lastPass.id}`" :class="SENTENCE_LINK_CLASS"
          >run #{{ streak.lastPass.runId }}</NuxtLink
        ><ClientOnly
          >,
          <span :title="prettyDateFormat(streak.lastPass.startTime)">{{
            formatRelativeTime(streak.lastPass.startTime)
          }}</span></ClientOnly
        ></template
      ></span
    >
  </div>
</template>

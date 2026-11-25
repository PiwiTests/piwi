<script setup lang="ts">
/**
 * The History line of an execution's situation block: the test's recent
 * executions as one strip of squares in the outcome colors, oldest to newest,
 * this execution ringed, then a sentence anchored to this execution: how many
 * runs in a row it has failed and the last run it passed in. The strip is one
 * link, to the test's own page, where each square opens its execution; a
 * square names its run and outcome on hover, and the link's name counts the
 * outcomes for a screen reader. A passing execution's line is the strip alone,
 * which already says how the test has been doing. Without a recent execution
 * the line is the link alone.
 */
import type { TestCaseHistoryPoint } from '~~/types/api';
import { HISTORY_STRIP_LENGTH, historyStreak } from '~/utils/history-streak';

const props = defineProps<{
  history: TestCaseHistoryPoint[];
  /** The execution being viewed: ringed in the strip and the sentence's anchor. */
  currentId: number;
  /** The test's id, for the link to its page. */
  testCaseId: number;
}>();

const streak = computed(() => historyStreak(props.history, props.currentId));

/** The link's name: how many of the executions the strip shows ended each way, and this one's outcome. */
const linkLabel = computed(() => {
  const shown = props.history.slice(0, HISTORY_STRIP_LENGTH);
  const counts = new Map<string, number>();
  for (const point of shown) {
    const outcome = formatExecutionStatus(point.status, point.passedAfterFailure);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const current = shown.find((point) => point.id === props.currentId);
  const parts = [...counts].map(([outcome, count]) => `${count} ${outcome}`);
  const self = current ? `, this one ${formatExecutionStatus(current.status, current.passedAfterFailure)}` : '';
  return `Last ${shown.length} executions of this test: ${parts.join(', ')}${self}. Open the test history`;
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
    <NuxtLink
      :to="`/test-cases/${testCaseId}`"
      :aria-label="history.length ? linkLabel : undefined"
      data-tour="execution-test-history"
      class="min-w-0 max-w-full rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      :class="history.length ? '' : SENTENCE_LINK_CLASS"
    >
      <HistoryStrip v-if="history.length" :history="history" :current-id="currentId" :linked="false" />
      <template v-else>Test history</template>
    </NuxtLink>
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

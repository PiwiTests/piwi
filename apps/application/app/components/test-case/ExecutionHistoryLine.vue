<script setup lang="ts">
/**
 * The History line of an execution's situation block: the test's recent
 * executions as one strip of squares in the outcome colors, oldest to newest,
 * this execution ringed, then a sentence anchored to this execution: how many
 * runs in a row it has failed and the last run it passed in. The strip is one
 * link, to the test's own page, where each square opens its execution; a
 * square names its run and outcome on hover. A passing execution's line is the
 * strip alone, which already says how the test has been doing.
 */
import type { TestCaseHistoryPoint } from '~~/types/api';
import { historyStreak } from '~/utils/history-streak';

const props = defineProps<{
  history: TestCaseHistoryPoint[];
  /** The execution being viewed: ringed in the strip and the sentence's anchor. */
  currentId: number;
  /** The test's id, for the link to its page. */
  testCaseId: number;
}>();

const streak = computed(() => historyStreak(props.history, props.currentId));

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
      aria-label="Recent executions of this test, oldest to newest. Open the test history"
      title="Open the test history"
      data-tour="execution-test-history"
      class="shrink-0 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <HistoryStrip :history="history" :current-id="currentId" :linked="false" />
    </NuxtLink>
    <span v-if="lead"
      >{{ lead
      }}<template v-if="streak?.lastPass"
        >, last passed in
        <NuxtLink :to="`/test-run-cases/${streak.lastPass.id}`" :class="SENTENCE_LINK_CLASS"
          >run #{{ streak.lastPass.runId }}</NuxtLink
        ><ClientOnly>, {{ formatRelativeTime(streak.lastPass.startTime) }}</ClientOnly></template
      ></span
    >
  </div>
</template>

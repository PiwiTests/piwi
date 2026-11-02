<script setup lang="ts">
/**
 * This test's recent executions as a row of clickable squares, oldest to newest,
 * colored by status with the current execution ringed, above a one-line streak
 * sentence anchored to the execution being viewed. Each square links to its
 * execution. No chart, no table — the full history lives on the test page.
 */
import type { TestCaseHistoryPoint } from '~~/types/api';
import { historyStreak } from '~/utils/history-streak';

const props = withDefaults(
  defineProps<{
    history: TestCaseHistoryPoint[];
    /** The current execution's id — ringed in the strip and the streak anchor. */
    currentId?: number | null;
    /**
     * Squares only, no descriptive label and no streak sentence — for the test
     * history chart's footer, where the facts line already carries the numbers.
     */
    compact?: boolean;
  }>(),
  { currentId: null, compact: false },
);

/** Oldest → newest, capped at 24, for the strip. */
const strip = computed(() => props.history.slice(0, 24).slice().reverse());

/** The verdict about the execution being viewed (`historyStreak`). */
const streak = computed(() => historyStreak(props.history, props.currentId));

const stripLabelId = useId();
</script>

<template>
  <div v-if="strip.length" class="space-y-2">
    <div>
      <p v-if="!compact" :id="stripLabelId" class="text-xs text-gray-400 mb-1">
        Recent executions of this test (oldest → newest)
      </p>
      <div
        class="flex items-center gap-1 flex-wrap"
        role="group"
        :aria-labelledby="compact ? undefined : stripLabelId"
        :aria-label="compact ? 'Recent executions of this test, oldest to newest' : undefined"
      >
        <UTooltip
          v-for="point in strip"
          :key="point.id"
          :text="`Execution in run #${point.runId}: ${formatExecutionStatus(point.status, point.retries)}`"
        >
          <NuxtLink
            :to="`/test-run-cases/${point.id}`"
            :aria-label="`Execution in run #${point.runId}: ${formatExecutionStatus(point.status, point.retries)}`"
            :aria-current="point.id === currentId ? 'true' : undefined"
            class="size-3.5 rounded-sm inline-block transition-opacity hover:opacity-80 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :class="[
              statusPalette(point.status, point.retries).bg,
              point.id === currentId ? CURRENT_ITEM_RING_CLASS : '',
            ]"
          />
        </UTooltip>
      </div>
    </div>

    <p v-if="!compact && streak && streak.count >= 1" class="text-sm text-gray-600 dark:text-gray-400">
      Failing for
      <strong class="text-gray-800 dark:text-gray-200">{{ streak.count }}</strong>
      consecutive run{{ streak.count === 1 ? '' : 's' }}.
      <template v-if="streak.lastPass">
        Last passed in
        <NuxtLink :to="`/test-run-cases/${streak.lastPass.id}`" :class="SENTENCE_LINK_CLASS">
          run #{{ streak.lastPass.runId }}
        </NuxtLink>
        ({{ formatRelativeTime(streak.lastPass.startTime) }}).
      </template>
      <template v-else-if="streak.total > 1"> No passing run in the last {{ streak.total }} recorded. </template>
      <template v-else> First recorded run of this test. </template>
    </p>
    <p v-else-if="!compact && streak?.anchorPassed" class="text-sm text-gray-600 dark:text-gray-400">
      This execution passed.
    </p>
  </div>
</template>

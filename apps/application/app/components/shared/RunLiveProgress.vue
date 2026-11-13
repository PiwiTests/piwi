<script setup lang="ts">
import { liveProgress, tallyResults, type RunTally } from '~/utils/live-run-progress';

/**
 * How far a running run is, in a row of a runs list: the shared count bar of its results so far against its planned
 * total, then "120 of 400 · 2 failed". Nothing before the run says its total or reports a result. The run page has
 * the full story.
 */
const props = defineProps<{ run: RunTally }>();

const progress = computed(() => liveProgress(props.run));
/** A retry counts again until the run ends, so the bar's scale holds every result. */
const barTotal = computed(() => Math.max(props.run.totalTests, tallyResults(props.run)));
</script>

<template>
  <div v-if="progress.total > 0 || progress.done > 0" class="min-w-0 space-y-1" data-live-progress>
    <TestStatusBar
      v-if="progress.total > 0"
      :passed="run.passedTests"
      :failed="run.failedTests"
      :skipped="run.skippedTests"
      :did-not-run="run.didNotRunTests"
      :flaky="0"
      :total="barTotal"
    />
    <p class="text-xs text-muted tabular-nums">
      <span>{{ progress.label }}</span>
      <span v-if="progress.failed > 0">
        · <span :class="STATUS_PALETTE.failed.text">{{ progress.failed }} failed</span></span
      >
    </p>
  </div>
</template>

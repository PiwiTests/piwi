<script setup lang="ts">
const props = defineProps<{
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  total: number;
  didNotRun?: number;
  /** `test.fixme()` skips — a subset of `skipped`, drawn in its second grey. */
  fixme?: number;
  /** Results an interruption cut short: in no outcome, a neutral segment that names the gap they leave. */
  interrupted?: number;
}>();

const segments = computed(() => {
  if (!props.total) return [];

  // Flaky tests are counted as a subset of passed by the reporter, so subtract
  // them to avoid double-counting in the bar. Fixme is a subset of skipped the
  // same way.
  const passedCount = props.passed - props.flaky;
  const fixmeCount = Math.min(props.fixme ?? 0, props.skipped);

  return [
    { key: 'passed', label: 'Passed', count: passedCount, color: STATUS_PALETTE.passed.bg },
    { key: 'failed', label: 'Failed', count: props.failed, color: STATUS_PALETTE.failed.bg },
    { key: 'flaky', label: 'Flaky', count: props.flaky, color: STATUS_PALETTE.flaky.bg },
    { key: 'skipped', label: 'Skipped', count: props.skipped - fixmeCount, color: STATUS_PALETTE.skipped.bg },
    { key: 'fixme', label: 'Fixme', count: fixmeCount, color: STATUS_PALETTE.fixme.bg },
    { key: 'didNotRun', label: "Didn't run", count: props.didNotRun ?? 0, color: STATUS_PALETTE.didnotrun.bg },
    { key: 'interrupted', label: 'Interrupted', count: props.interrupted ?? 0, color: STATUS_PALETTE.interrupted.bg },
  ]
    .filter((s) => s.count > 0)
    .map((s) => ({
      ...s,
      widthPct: (s.count / props.total) * 100,
      displayPct: ((s.count / props.total) * 100).toFixed(1),
    }));
});

// Names every segment the bar visibly renders, so the announced summary
// matches what the eyes see (flaky, didn't-run and interrupted included).
const accessibleLabel = computed(() => {
  const parts = segments.value.map((s) => `${s.count} ${s.label.toLowerCase()}`);
  return `Test results: ${parts.join(', ')}`;
});
</script>

<template>
  <DeferredTooltip :ui="{ content: 'overflow-visible !p-0' }">
    <!-- 2px gaps let the track show between segments, so adjacent fills stay
         separable for colorblind readers (green|red is near-identical under
         deuteranopia). -->
    <div
      v-if="total > 0"
      role="progressbar"
      :aria-label="accessibleLabel"
      :aria-valuemin="0"
      :aria-valuemax="total"
      :aria-valuenow="props.passed + props.failed + props.skipped + (props.didNotRun ?? 0) + (props.interrupted ?? 0)"
      class="flex gap-0.5 h-2.5 w-full min-w-30 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
    >
      <div
        v-for="seg in segments"
        :key="seg.key"
        :class="[seg.color, 'h-full transition-all']"
        :style="{ width: seg.widthPct + '%' }"
      />
    </div>
    <div v-else class="text-xs text-zinc-400 dark:text-zinc-500 italic">No tests</div>

    <template #content>
      <div class="min-w-52 space-y-1.5 rounded-md bg-zinc-900 px-3 py-2 text-sm shadow-lg">
        <div class="font-semibold text-white">{{ total }} tests total</div>
        <div v-for="seg in segments" :key="seg.key" class="flex items-center gap-2 whitespace-nowrap">
          <span :class="[seg.color, 'inline-block h-2.5 w-2.5 shrink-0 rounded-sm']" />
          <span class="text-white">{{ seg.label }}</span>
          <span class="ml-4 tabular-nums font-medium text-white">{{ seg.count }}</span>
          <span class="ml-auto tabular-nums text-zinc-300 text-xs">{{ seg.displayPct }}%</span>
        </div>
      </div>
    </template>
  </DeferredTooltip>
</template>

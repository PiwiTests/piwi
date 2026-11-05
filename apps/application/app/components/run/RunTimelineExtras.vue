<script setup lang="ts">
/**
 * The two summaries that sit beneath the workers timeline: the ten slowest
 * executions in the run (as the shared TestRow) and how the run's tests spread
 * across parallel workers, with a note when one worker carried far more than
 * another. Both read the run's own executions — no baseline, so they render for
 * any finished run.
 */
import { computed } from 'vue';
import type { RunClusterMeta, TestCaseResult } from '~~/types/api';
import { useTimelineModel } from '~/composables/useTimelineModel';
import { formatTimelineTime, lockColorHex } from '~/utils/timeline';

const props = defineProps<{
  testCases: TestCaseResult[];
  clusterMeta?: RunClusterMeta;
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

// Reuse the timeline's own interval model so the held time, the serialization
// estimate and the worker lanes line up exactly with the bars above.
const { runLocks, lockSummary, timelineData, workerRows } = useTimelineModel(props);

/** Lock name → color, matching the timeline's brackets and legend. */
const lockColor = computed(() => {
  const map = new Map<string, string>();
  runLocks.value.forEach((lock, i) => map.set(lock, lockColorHex(i)));
  return map;
});

/** The lock whose hold runs into the tail of the run, if any, for the hint line. */
const tailLock = computed(() => lockSummary.value.find((row) => row.dominatesTail) ?? null);
function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

const slowest = computed(() =>
  [...props.testCases]
    .filter((tc) => tc.duration != null)
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, 10),
);

// Tests per timeline lane: a worker slot, whichever of its processes ran them,
// so a process replaced after a failure does not read as a worker that idled.
const workerCounts = computed(() => {
  const counts = new Map<number, number>();
  for (const item of timelineData.value) {
    if (item.kind === 'test') counts.set(item.rowIndex, (counts.get(item.rowIndex) ?? 0) + 1);
  }
  const sharded = new Set(workerRows.value.map((row) => row.shardIndex)).size > 1;
  return workerRows.value.map((row) => ({
    key: row.baseLane,
    label: sharded && row.shardIndex != null ? `S${row.shardIndex} W${row.slot + 1}` : `W${row.slot + 1}`,
    count: counts.get(row.baseLane) ?? 0,
  }));
});

const maxWorkerCount = computed(() => Math.max(1, ...workerCounts.value.map((w) => w.count)));

// One worker doing far more than another points at poor parallelization.
const imbalanceWarning = computed<string | null>(() => {
  const counts = workerCounts.value;
  if (counts.length < 2) return null;
  const max = Math.max(...counts.map((w) => w.count));
  const min = Math.min(...counts.map((w) => w.count));
  if (min > 0 && max >= min * 1.5) {
    const maxW = counts.find((w) => w.count === max)?.label;
    const minW = counts.find((w) => w.count === min)?.label;
    const ratio = Math.round((max / min) * 10) / 10;
    return `Worker ${maxW} ran ${ratio}× more tests than worker ${minW}`;
  }
  return null;
});

function clusterName(tc: TestCaseResult): string | null {
  return tc.failureClusterId != null ? (props.clusterMeta?.[tc.failureClusterId]?.name ?? null) : null;
}

function clusterIssue(tc: TestCaseResult) {
  return tc.failureClusterId != null ? (props.clusterMeta?.[tc.failureClusterId]?.issue ?? null) : null;
}
</script>

<template>
  <div class="space-y-4">
    <SectionCard v-if="slowest.length > 0" icon="i-lucide-clock" icon-class="text-amber-500" title="Slowest tests">
      <div class="-m-4">
        <TestRow
          v-for="tc in slowest"
          :key="tc.executionId"
          :test-case="tc"
          :cluster-name="clusterName(tc)"
          :issue="clusterIssue(tc)"
          :project-key="projectKey"
          :project-name="projectName"
        />
      </div>
    </SectionCard>

    <SectionCard v-if="lockSummary.length > 0" icon="i-lucide-lock" icon-class="text-violet-500" title="Locks">
      <p v-if="tailLock" class="flex items-start gap-1.5 text-xs text-amber-600 mb-3">
        <UIcon name="i-lucide-alert-triangle" class="size-3.5 shrink-0 mt-0.5" />
        <span>
          <span class="font-medium">{{ tailLock.lock }}</span> was held for most of the run's tail — its holders run one
          at a time, so the last workers idle while they wait.
        </span>
      </p>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-muted border-b border-default">
              <th class="py-1.5 pr-3 font-medium">Lock</th>
              <th class="py-1.5 px-3 font-medium text-right">Tests</th>
              <th class="py-1.5 px-3 font-medium text-right">Held</th>
              <th class="py-1.5 px-3 font-medium text-right">Share</th>
              <th class="py-1.5 pl-3 font-medium text-right">
                <span title="Estimated time that ran serialized behind another holder">Serialized (est.)</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in lockSummary" :key="row.lock" class="border-b border-default/60 last:border-0">
              <td class="py-1.5 pr-3">
                <span class="inline-flex items-center gap-1.5">
                  <span
                    class="inline-block h-2.5 w-3 rounded-sm shrink-0"
                    :style="{ backgroundColor: lockColor.get(row.lock) }"
                  />
                  <span class="font-medium">{{ row.lock }}</span>
                </span>
              </td>
              <td class="py-1.5 px-3 text-right tabular-nums">{{ row.testCount }}</td>
              <td class="py-1.5 px-3 text-right tabular-nums">{{ formatTimelineTime(row.heldMs) }}</td>
              <td class="py-1.5 px-3 text-right tabular-nums">{{ pct(row.share) }}</td>
              <td class="py-1.5 pl-3 text-right tabular-nums">
                {{ row.serializationMs > 0 ? formatTimelineTime(row.serializationMs) : '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </SectionCard>

    <SectionCard
      v-if="workerCounts.length > 1"
      icon="i-lucide-users"
      icon-class="text-gray-500"
      title="Worker distribution"
    >
      <div v-if="imbalanceWarning" class="flex items-center gap-1.5 text-xs text-amber-600 mb-3">
        <UIcon name="i-lucide-alert-triangle" class="size-3.5 shrink-0" />
        <span>{{ imbalanceWarning }}</span>
      </div>
      <div class="flex items-end gap-2 h-20">
        <div v-for="w in workerCounts" :key="w.key" class="flex-1 flex flex-col items-center gap-1">
          <span class="text-xs text-muted tabular-nums">{{ w.count }}</span>
          <div
            class="w-full bg-blue-400 rounded-t"
            :style="{ height: Math.max(4, (w.count / maxWorkerCount) * 60) + 'px' }"
          />
          <span class="text-xs text-muted">{{ w.label }}</span>
        </div>
      </div>
    </SectionCard>
  </div>
</template>

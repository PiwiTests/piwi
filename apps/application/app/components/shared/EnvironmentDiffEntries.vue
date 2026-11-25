<script setup lang="ts">
/**
 * The keys that differ between two executions' environments, as stacked rows (mobile-safe, no table): the meaningful
 * ones grouped by where they belong, titled only when more than one group changed, each with this execution's value
 * and the other's; then, in one line, the keys that vary naturally between runs. `thisLabel` and `otherLabel` name
 * the two sides. Shared by the environment diff card (against the last pass) and the comparison with the team's CI
 * (against the closest CI pass).
 */
import type { EnvironmentDiffEntry, EnvironmentGroup } from '#shared/environment-diff';

const props = defineProps<{
  entries: EnvironmentDiffEntry[];
  thisLabel: string;
  otherLabel: string;
}>();

const GROUP_TITLES: Record<EnvironmentGroup, string> = {
  run: 'Run',
  runner: 'Runner',
  browser: 'Browser',
  server: 'Server under test',
};
const meaningful = computed(() => props.entries.filter((e) => !e.informational));
const groups = computed(() =>
  (['run', 'runner', 'browser', 'server'] as const)
    .map((group) => ({ group, title: GROUP_TITLES[group], entries: meaningful.value.filter((e) => e.group === group) }))
    .filter((g) => g.entries.length > 0),
);
const informational = computed(() => props.entries.filter((e) => e.informational));
</script>

<template>
  <div v-if="entries.length > 0" class="space-y-2">
    <!-- Which side is which: this execution on the left, the other on the right -->
    <div class="flex items-center gap-1.5 text-xs font-medium px-3">
      <span class="hidden sm:block sm:w-40 shrink-0" aria-hidden="true" />
      <span class="text-red-700 dark:text-red-400">{{ thisLabel }}</span>
      <UIcon name="i-lucide-arrow-left" class="size-3 shrink-0 text-gray-400" />
      <span class="text-green-700 dark:text-green-400">{{ otherLabel }}</span>
    </div>
    <template v-for="g in groups" :key="g.group">
      <h4 v-if="groups.length > 1" class="text-sm font-semibold text-highlighted px-3 pt-1">{{ g.title }}</h4>
      <div
        v-for="entry in g.entries"
        :key="entry.key"
        class="rounded-lg border border-default p-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
        :data-inferred="entry.failingInferred || entry.baselineInferred || undefined"
      >
        <span class="text-xs font-medium text-gray-500 dark:text-gray-400 sm:w-40 shrink-0 break-all">{{
          entry.label
        }}</span>
        <div class="flex flex-wrap items-center gap-1.5 min-w-0 text-xs font-mono">
          <code class="rounded bg-red-50 px-1.5 py-0.5 text-red-700 dark:bg-red-950/30 dark:text-red-400 break-all">
            {{ entry.failing ?? '(unset)' }}
          </code>
          <UIcon name="i-lucide-arrow-left" class="size-3 shrink-0 text-gray-400" />
          <code
            class="rounded bg-green-50 px-1.5 py-0.5 text-green-700 dark:bg-green-950/30 dark:text-green-400 break-all"
          >
            {{ entry.baseline ?? '(unset)' }}
          </code>
        </div>
      </div>
    </template>

    <!-- Worker/shard placement varies naturally between runs — de-emphasized -->
    <p v-if="informational.length > 0" class="text-xs text-gray-400 dark:text-gray-500">
      Also changed (varies naturally between runs):
      <span v-for="(entry, i) in informational" :key="entry.key">
        {{ entry.label.toLowerCase() }} {{ entry.baseline ?? '—' }} → {{ entry.failing ?? '—'
        }}<span v-if="i < informational.length - 1">, </span>
      </span>
    </p>
  </div>
</template>

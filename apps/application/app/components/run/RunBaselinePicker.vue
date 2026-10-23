<script setup lang="ts">
/**
 * The two ways to pick the Changes tab's baseline: a base branch (the
 * automatic ladder restricted to that branch) or one earlier run. Each run
 * option names the run's branch, environment, start and outcome, so a run on
 * another branch or environment is recognizable before it is picked. Renders
 * nothing when there is neither another branch nor an earlier run to offer.
 */
import { computed } from 'vue';
import type { InsightsEarlierRun, RunInsightsResult } from '#shared/handlers/run-insights';

const props = defineProps<{
  insights: RunInsightsResult;
  /** The base branch the URL asks for, or null for the automatic choice. */
  baseBranch: string | null;
}>();

const emit = defineEmits<{
  /** A run to compare with, or null to return to the automatic choice. */
  'select-run': [id: number | null];
  /** A base branch, or null to return to the automatic choice. */
  'select-base-branch': [name: string | null];
}>();

// Base-branch choices: the automatic ladder, then every branch a baseline can
// come from. Offered only when a branch other than the run's own has one —
// otherwise there is nothing to choose.
const AUTO_BASE = '';
interface BaseBranchOption {
  label: string;
  value: string;
}
const baseBranchOptions = computed<BaseBranchOption[]>(() => {
  const d = props.insights;
  if (!d.baseBranches.some((b) => b !== d.run.branch)) return [];
  const own = d.run.branch;
  const fallback = d.fallbackBranch.branch;
  const ladder = !own ? 'most recent' : own === fallback ? own : `${own}, then ${fallback}`;
  const auto = { label: `Automatic (${ladder})`, value: AUTO_BASE };
  return [auto, ...d.baseBranches.map((b) => ({ label: b, value: b }))];
});

const baseBranchValue = computed<BaseBranchOption | undefined>({
  get: () => baseBranchOptions.value.find((o) => o.value === (props.baseBranch ?? AUTO_BASE)),
  set: (opt) => emit('select-base-branch', opt?.value || null),
});

interface RunOption {
  label: string;
  value: number;
  run: InsightsEarlierRun;
}

// The label is what the menu's search matches: id, branch, environment and outcome.
const runOptions = computed<RunOption[]>(() =>
  props.insights.earlierRuns.map((run) => ({
    label: [
      `Run #${run.id}`,
      run.branch ?? 'no branch',
      run.environment ?? 'no environment',
      formatStatusLabel(run.status),
      ...(run.isFullRun ? [] : ['partial run']),
    ].join(' · '),
    value: run.id,
    run,
  })),
);

const runValue = computed<RunOption | undefined>({
  get: () => {
    const d = props.insights;
    return d.baselineSource === 'run' ? runOptions.value.find((o) => o.value === d.baseline?.id) : undefined;
  },
  set: (opt) => emit('select-run', opt?.value ?? null),
});

function runMeta(run: InsightsEarlierRun): string {
  return [
    formatRelativeTime(run.startTime),
    formatStatusLabel(run.status),
    ...(run.isFullRun ? [] : ['partial run']),
  ].join(' · ');
}

// The run just before this one, for the "Previous run" shortcut.
const previousRun = computed<InsightsEarlierRun | null>(() => {
  const previous = props.insights.earlierRuns[0];
  return previous && previous.id !== props.insights.baseline?.id ? previous : null;
});

// Without a baseline, the fallback-branch line says nothing worth reading.
const showBaseBranch = computed(() => baseBranchOptions.value.length > 0 || props.insights.hasBaseline);
const showAutomatic = computed(() => props.insights.baselineSource !== 'auto' || props.baseBranch != null);
</script>

<template>
  <div
    v-if="showBaseBranch || runOptions.length > 0 || showAutomatic"
    class="flex flex-wrap items-center gap-x-2 gap-y-2"
    data-tour="run-baseline-picker"
  >
    <template v-if="showBaseBranch">
      <span class="text-xs font-medium text-muted">Base branch</span>
      <USelectMenu
        v-if="baseBranchOptions.length > 0"
        v-model="baseBranchValue"
        :items="baseBranchOptions"
        size="xs"
        class="w-full sm:w-64"
        title="Take the baseline from this branch only"
      >
        <template #default="{ modelValue: selected }">
          <BranchLabel v-if="selected?.value" :name="selected.value" />
          <span v-else class="inline-flex items-center gap-1.5 min-w-0">
            <UIcon name="i-lucide-git-branch" class="size-3 shrink-0 text-muted" />
            <span class="truncate">{{ selected?.label ?? 'Automatic' }}</span>
          </span>
        </template>
        <template #item-label="{ item }">
          <BranchLabel v-if="item.value" :name="item.value" />
          <span v-else>{{ item.label }}</span>
        </template>
      </USelectMenu>
      <span v-else class="inline-flex items-center gap-1 text-xs text-muted">
        <BranchLabel :name="insights.fallbackBranch.branch" copyable /> (no other branch has an earlier run to compare
        with)
      </span>
    </template>
    <template v-if="runOptions.length > 0">
      <span class="text-xs font-medium text-muted" :class="showBaseBranch && 'sm:ml-2'">Run</span>
      <USelectMenu
        v-model="runValue"
        :items="runOptions"
        size="xs"
        placeholder="Pick a run…"
        class="w-full sm:w-80"
        title="Compare against one earlier run"
      >
        <template #default="{ modelValue: selected }">
          <span v-if="selected" class="inline-flex items-center gap-2 min-w-0">
            <span class="shrink-0">Run #{{ selected.value }}</span>
            <BranchLabel :name="selected.run.branch" />
            <EnvironmentBadge :name="selected.run.environment" />
          </span>
          <span v-else class="text-muted">Pick a run…</span>
        </template>
        <template #item-label="{ item }">
          <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
            <span class="shrink-0">Run #{{ item.value }}</span>
            <BranchLabel :name="item.run.branch" />
            <EnvironmentBadge :name="item.run.environment" />
            <span class="text-xs text-muted">{{ runMeta(item.run) }}</span>
          </span>
        </template>
      </USelectMenu>
      <UButton
        v-if="previousRun"
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-arrow-left"
        label="Previous run"
        :title="`Compare with run #${previousRun.id}, the run just before this one`"
        @click="emit('select-run', previousRun.id)"
      />
    </template>
    <UButton
      v-if="showAutomatic"
      size="xs"
      variant="ghost"
      color="neutral"
      icon="i-lucide-rotate-ccw"
      label="Automatic"
      title="Back to the automatic baseline"
      @click="emit('select-run', null)"
    />
  </div>
</template>

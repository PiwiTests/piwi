<script setup lang="ts">
/**
 * Desktop shell only: the run button of the tests selected in a run's test list. A request to an app and a CI
 * dispatch cannot name a selection, so its one Where is **This computer** (`useThisComputer`): its face re-runs the
 * selection there, and its menu and dialog are This computer's, for the environment of the run.
 */
import type { RetryCase } from '~/utils/retry-command';
import type { RunWhat } from '~/composables/useRunPlace';

const props = defineProps<{
  projectId: number;
  projectLabel?: string | null;
  cases: RetryCase[];
  runId?: number | null;
  environmentId?: number | null;
}>();

const selectionWhat = computed<RunWhat>(() => {
  const selected = `${props.cases.length} selected test${props.cases.length === 1 ? '' : 's'}`;
  return {
    key: 'selection',
    label: 'The selected tests',
    count: props.cases.length,
    tests: props.cases.map((c) => c.title),
    app: null,
    ci: null,
    local: { label: `Re-run ${selected}`, cases: props.cases, runTitle: `${selected} of run #${props.runId}` },
  };
});

const place = await useRunPlace({
  projectId: props.projectId,
  machine: await useRunOnMyMachine(props.projectId, false),
  whats: () => [selectionWhat.value],
  prefersCi: () => false,
  thisComputer: {
    projectLabel: () => props.projectLabel,
    sourceRunId: () => props.runId,
    environmentId: () => props.environmentId ?? null,
  },
});
</script>

<template>
  <RunButton :place="place" />
  <RunDialog :place="place" />
</template>

<script setup lang="ts">
/**
 * Desktop shell only: what an ended run of the Local runs tray failed on, in the layer's results list
 * (`DesktopRunResults`): its failed tests, then its flaky ones, each with the first lines of its first error and its
 * place in the linked folder. They come from the Piwi runs it reported (each step's, read once), else from what its
 * output printed (`runOutputSummary`), for a run that reported none. A test of a run of tests offers **Open** (its
 * execution, once reported), **Run again** and **Run with Hold failures** (`rerunTests`), which run it as the run ran.
 * Renders nothing for a run that goes on, or that failed on no test.
 */
import type { LocalRun } from '~/composables/useDesktopLocalRuns';
import type { TestCaseResult, TestRunDetails } from '~~/types/api';
import { flakyFinalAttempts, isFailedStatus, testOutcomes } from '#shared/utils/test-counts';
import { runErrorLines, runOutputSummary, type RunOutputResult, type RunResultRow } from '@piwitests/run-ui/run-output';
import { retryCaseOf, type RetryCase } from '~/utils/retry-command';

const props = defineProps<{ run: LocalRun }>();

const store = useDesktopLocalRuns();

/** A row, with what running its test again takes and, once reported, its execution. */
interface Row extends RunResultRow {
  retry: RetryCase | null;
  executionId: number | null;
}

/** The Piwi runs the run reported, each step's: read once each, when the run has ended. */
const reported = ref<TestCaseResult[] | null>(null);
const piwiRuns = computed(() =>
  props.run.status === 'running'
    ? []
    : [...new Set([props.run.piwiRunId, ...Object.values(props.run.piwiRunIds ?? {})])].filter(
        (id): id is number => id != null,
      ),
);

watch(
  () => piwiRuns.value.join(','),
  async () => {
    const ids = piwiRuns.value;
    if (ids.length === 0) return;
    try {
      const runs = await Promise.all(ids.map((id) => $fetch<TestRunDetails>(`/api/test-runs/${id}`)));
      reported.value = runs.flatMap((run) => run.testCases ?? []);
    } catch {
      reported.value = null;
    }
  },
  { immediate: true },
);

function rowOfCase(tc: TestCaseResult, status: 'failed' | 'flaky'): Row {
  const title = [...(tc.suitePath ?? []), tc.displayTitle ?? tc.title].join(' › ');
  return {
    key: `execution-${tc.executionId}`,
    status,
    title,
    place: tc.location ?? tc.filePath ?? null,
    error: runErrorLines(tc.error ?? ''),
    retry: retryCaseOf(tc),
    executionId: tc.executionId,
  };
}

function rowOfOutput(result: RunOutputResult, index: number): Row {
  const titles = result.title.split(' › ');
  return {
    key: `output-${index}`,
    status: result.status,
    title: result.title,
    place: `${result.file}:${result.line}`,
    error: result.error,
    retry: {
      filePath: result.file,
      line: result.line,
      title: titles.at(-1) ?? result.title,
      projectName: result.project,
    },
    executionId: null,
  };
}

const rows = computed<Row[]>(() => {
  if (props.run.status === 'running') return [];
  if (reported.value && reported.value.length > 0) {
    // One outcome a test and browser, as the run page counts them: a run stores a row an attempt.
    const attempts = reported.value.map((tc) => ({
      ...tc,
      browserName: tc.browser?.projectName ?? tc.browser?.browserName ?? null,
      repeatEachIndex: tc.repeatEachIndex ?? 0,
    }));
    const outcomes = testOutcomes(attempts);
    const flaky = flakyFinalAttempts(attempts);
    return [
      ...outcomes.filter((tc) => isFailedStatus(tc.status)).map((tc) => rowOfCase(tc, 'failed')),
      ...outcomes.filter((tc) => flaky.has(tc)).map((tc) => rowOfCase(tc, 'flaky')),
    ];
  }
  const summary = runOutputSummary(props.run.lines);
  return (summary?.results ?? [])
    .map(rowOfOutput)
    .filter((row) => row.status === 'failed' || row.status === 'flaky' || row.status === 'interrupted');
});

/** A test runs again from here only from a run of tests: the run's own Run again repeats the other kinds. */
const rerunnable = computed(() => props.run.kind === 'tests');
</script>

<template>
  <DesktopRunResults v-if="rows.length > 0" :rows="rows" class="mt-2" data-shot="desktop-run-results">
    <template #place="{ row }">
      <OpenInIdeLink
        v-if="row.place"
        :location="row.place"
        :project-key="run.projectId"
        :project-name="run.projectLabel"
        class="text-xs"
      />
    </template>
    <template #actions="{ row }">
      <UButton
        v-if="(row as Row).executionId != null"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-external-link"
        :to="`/test-run-cases/${(row as Row).executionId}`"
        :aria-label="`Open ${row.title}`"
        title="Open its execution"
        @click="store.trayOpen.value = false"
      />
      <template v-if="rerunnable && (row as Row).retry">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-rotate-ccw"
          :aria-label="`Run ${row.title} again`"
          title="Run this test again, as the run ran it"
          @click="store.rerunTests(run, [(row as Row).retry!])"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-circle-pause"
          :aria-label="`Run ${row.title} again with Hold failures`"
          title="Run this test again, waiting at its failure for you to look"
          @click="store.rerunTests(run, [(row as Row).retry!], { holdFailures: true })"
        />
      </template>
    </template>
  </DesktopRunResults>
</template>

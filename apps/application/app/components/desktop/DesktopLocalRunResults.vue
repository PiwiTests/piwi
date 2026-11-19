<script lang="ts">
import type { RunResultRow } from '@piwitests/run-ui/run-output';
import type { RetryCase } from '~/utils/retry-command';

/** How many runs' results the window keeps read, the latest ones: the tray mounts a run's list again at each opening. */
const KEPT_RESULTS = 30;

/** A row, with what running its test again takes and, once reported, its execution and the Piwi run it is of. */
interface DesktopRunRow extends RunResultRow {
  retry: RetryCase | null;
  executionId: number | null;
  piwiRunId: number | null;
}

/** The rows read of the Piwi runs a run reported, by those runs' ids. */
const readRows = new Map<string, DesktopRunRow[]>();
</script>

<script setup lang="ts">
/**
 * Desktop shell only: what an ended run of the Local runs tray failed on, in the layer's results list
 * (`DesktopRunResults`): its failed tests, then its flaky ones, each with its project, the first lines of its first
 * error (a flaky test's from the attempt that failed) and its place in the linked folder. They come from the Piwi runs
 * it reported, each step's, read once and kept while the window lasts (`readRows`), else from what its output printed
 * (`runOutputSummary`), for a run that reported none. A test of a run of tests offers **Open** (its execution, once
 * reported), **Run again** and, when the run's options can hold, **Run again with Hold failures** (`rerunTests`, which
 * runs it as the run ran). Emits `keep-open` as a row starts a run, so the run's card stays open on its list. Renders
 * nothing for a run that goes on, or that failed on no test.
 */
import type { LocalRun } from '~/composables/useDesktopLocalRuns';
import type { TestCaseResult, TestRunDetails } from '~~/types/api';
import { attemptKey, flakyFinalAttempts, isFailedStatus, testOutcomes } from '#shared/utils/test-counts';
import { runErrorLines, runOutputSummary, type RunOutputResult } from '@piwitests/run-ui/run-output';
import { retryCaseOf } from '~/utils/retry-command';
import { localRunHoldRefusal } from '~/utils/local-run-args';

const props = defineProps<{ run: LocalRun }>();
const emit = defineEmits<{ 'keep-open': [] }>();

const store = useDesktopLocalRuns();

/** The Piwi runs the run reported, each step's, once it ended. */
const piwiRuns = computed(() =>
  props.run.status === 'running'
    ? []
    : [...new Set([props.run.piwiRunId, ...Object.values(props.run.piwiRunIds ?? {})])].filter(
        (id): id is number => id != null,
      ),
);
const piwiRunsKey = computed(() => [...piwiRuns.value].sort((a, b) => a - b).join(','));
const reportedRows = ref<DesktopRunRow[] | null>(null);

/** The rows of the Piwi runs a run reported: one outcome a test, browser and repetition, as the run page counts them. */
function rowsOfReported(runs: Array<{ id: number; cases: TestCaseResult[] }>): DesktopRunRow[] {
  const attempts = runs.flatMap(({ id, cases }) =>
    cases.map((tc) => ({
      ...tc,
      piwiRunId: id,
      browserName: tc.browser?.projectName ?? tc.browser?.browserName ?? null,
      repeatEachIndex: tc.repeatEachIndex ?? 0,
    })),
  );
  type Attempt = (typeof attempts)[number];
  const outcomes = testOutcomes(attempts);
  const flaky = flakyFinalAttempts(attempts);
  /** A flaky test's error: its final attempt passed, so it is an earlier attempt's of its repetition. */
  const failedAttemptError = (tc: Attempt) =>
    attempts.find(
      (other) =>
        other.piwiRunId === tc.piwiRunId && attemptKey(other) === attemptKey(tc) && isFailedStatus(other.status),
    )?.error ?? '';
  const rowOf = (tc: Attempt, status: 'failed' | 'flaky'): DesktopRunRow => ({
    key: `execution-${tc.executionId}`,
    status,
    title: [...(tc.suitePath ?? []), tc.displayTitle ?? tc.title].join(' › '),
    place: tc.location ?? tc.filePath ?? null,
    project: tc.browser?.projectName ?? null,
    error: runErrorLines((status === 'flaky' ? failedAttemptError(tc) : tc.error) ?? ''),
    retry: retryCaseOf(tc),
    executionId: tc.executionId,
    piwiRunId: tc.piwiRunId,
  });
  return [
    ...outcomes.filter((tc) => isFailedStatus(tc.status)).map((tc) => rowOf(tc, 'failed')),
    ...outcomes.filter((tc) => flaky.has(tc)).map((tc) => rowOf(tc, 'flaky')),
  ];
}

watch(
  piwiRunsKey,
  async (key, _previous, onCleanup) => {
    reportedRows.value = readRows.get(key) ?? null;
    if (!key || reportedRows.value) return;
    // A later step linked meanwhile reads all of them again: this answer then shows nothing.
    let current = true;
    onCleanup(() => (current = false));
    const ids = piwiRuns.value;
    try {
      const runs = await Promise.all(
        ids.map(async (id) => ({ id, cases: (await $fetch<TestRunDetails>(`/api/test-runs/${id}`)).testCases ?? [] })),
      );
      const rows = rowsOfReported(runs);
      readRows.set(key, rows);
      for (const old of [...readRows.keys()].slice(0, Math.max(0, readRows.size - KEPT_RESULTS))) readRows.delete(old);
      if (current) reportedRows.value = rows;
    } catch {
      // The server does not answer: the run's output says what it can.
    }
  },
  { immediate: true },
);

function rowOfOutput(result: RunOutputResult, index: number): DesktopRunRow {
  const titles = result.title.split(' › ');
  return {
    key: `output-${index}`,
    status: result.status,
    title: result.title,
    place: `${result.file}:${result.line}`,
    project: result.project,
    error: result.error,
    retry: {
      filePath: result.file,
      line: result.line,
      title: titles.at(-1) ?? result.title,
      projectName: result.project,
    },
    executionId: null,
    piwiRunId: null,
  };
}

const rows = computed<DesktopRunRow[]>(() => {
  if (props.run.status === 'running') return [];
  if (reportedRows.value && reportedRows.value.length > 0) return reportedRows.value;
  const summary = runOutputSummary(props.run.lines);
  return (summary?.results ?? []).map(rowOfOutput).filter((row) => row.status === 'failed' || row.status === 'flaky');
});

/** A test runs again from here only from a run of tests: the run's own Run again repeats the other kinds. */
const rerunnable = computed(() => props.run.kind === 'tests');
/** Whether the run's options can hold a failure: not in UI mode, nor repeated past its first failure. */
const canHold = computed(() => !localRunHoldRefusal({ ...props.run.options, holdFailures: true }));

/** What a row's buttons say of its test: its title, and its project when it has one. */
const named = (row: RunResultRow) => (row.project ? `${row.title} in ${row.project}` : row.title);

function runAgain(row: RunResultRow, holdFailures?: true) {
  const { retry, piwiRunId } = row as DesktopRunRow;
  if (!retry) return;
  emit('keep-open');
  void store.rerunTests(props.run, [retry], holdFailures ? { holdFailures } : {}, piwiRunId);
}
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
        v-if="(row as DesktopRunRow).executionId != null"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-external-link"
        :to="`/test-run-cases/${(row as DesktopRunRow).executionId}`"
        :aria-label="`Open ${named(row)}`"
        title="Open its execution"
        @click="store.trayOpen.value = false"
      />
      <template v-if="rerunnable && (row as DesktopRunRow).retry">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-rotate-ccw"
          :aria-label="`Run ${named(row)} again`"
          title="Run this test again, as the run ran it"
          @click="runAgain(row)"
        />
        <UButton
          v-if="canHold"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-circle-pause"
          :aria-label="`Run ${named(row)} again with Hold failures`"
          title="Run this test again, waiting at its failure for you to look"
          @click="runAgain(row, true)"
        />
      </template>
    </template>
  </DesktopRunResults>
</template>

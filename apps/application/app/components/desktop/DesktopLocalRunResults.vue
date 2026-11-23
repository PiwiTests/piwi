<script setup lang="ts">
/**
 * Desktop shell only: what an ended run of the Local runs tray failed on, in the layer's results list
 * (`DesktopRunResults`), as `useDesktopLocalRunRows` reads it: its failed tests, then its flaky ones, each with its
 * project, the first lines of its first error and its place in the linked folder. A test of a run of tests offers
 * **Open** (its execution, once reported), **Run again** and, when the run's options can hold, **Run again with Hold
 * failures** (`rerunTests`, which runs it as the run ran). Emits `keep-open` as a row starts a run, so the run's card
 * stays open on its list. Renders nothing for a run that goes on, or that failed on no test.
 */
import type { LocalRun } from '~/composables/useDesktopLocalRuns';
import type { DesktopRunRow } from '~/composables/useDesktopLocalRunRows';
import type { RunResultRow } from '@piwitests/run-ui/run-output';

const props = defineProps<{ run: LocalRun }>();
const emit = defineEmits<{ 'keep-open': [] }>();

const store = useDesktopLocalRuns();
const { rows, rerunnable, canHold } = useDesktopLocalRunRows(() => props.run);

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

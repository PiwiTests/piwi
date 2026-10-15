<script setup lang="ts">
/**
 * The Coverage section's comparison of a failing execution with the test's
 * last passing execution with coverage (`GET /api/test-run-cases/:id/coverage-divergence`):
 * one line naming that run (its execution and run, when, branch and commit,
 * and whether it ran in another browser or on the default branch), a line when
 * one side's capture was incomplete, then the files whose code differs: those
 * only this execution ran, those both ran differently (what each side ran
 * only), those only the passing run ran. Files run at another version are
 * counted in one line. A file both ran at one version with line numbers
 * unfolds to its source with each side's lines marked
 * (`CoverageDivergenceSource`). With no difference between two complete
 * captures it says so in one line; with no earlier passing run with coverage,
 * it says that in one line; otherwise it renders nothing. The section mounts it
 * for failed executions only.
 */
import type { ApiResponse } from '~~/types/api';
import {
  changedFilesText,
  divergenceIncompleteText,
  divergenceRows,
  pathWrapParts,
  type DivergenceRow,
} from '~/utils/coverage-insights';

type DivergenceResponse = ApiResponse<
  typeof import('~~/server/api/test-run-cases/[id]/coverage-divergence.get').default
>;

const props = defineProps<{
  executionId: number;
  /** The execution's run, the commit a file's source falls back to. */
  runId: number | null;
  projectId: number | null;
  projectName?: string | null;
}>();

/** Rows shown before "Show all". */
const ROWS_SHOWN = 8;

const answer = ref<DivergenceResponse | null>(null);
const showAll = ref(false);
const expanded = ref(new Set<string>());

watch(
  () => props.executionId,
  async (id, _old, onCleanup) => {
    let stale = false;
    onCleanup(() => (stale = true));
    answer.value = null;
    showAll.value = false;
    expanded.value = new Set();
    const read = await $fetch<DivergenceResponse>(`/api/test-run-cases/${id}/coverage-divergence`).catch(() => null);
    if (!stale) answer.value = read;
  },
  { immediate: true },
);

const baseline = computed(() => (answer.value?.available ? (answer.value.baseline ?? null) : null));
const listed = computed(() => (answer.value ? divergenceRows(answer.value) : { rows: [], changed: [] }));
const shownRows = computed(() => (showAll.value ? listed.value.rows : listed.value.rows.slice(0, ROWS_SHOWN)));
const differs = computed(() => listed.value.rows.length + listed.value.changed.length > 0);
const incomplete = computed(() => (answer.value ? divergenceIncompleteText(answer.value) : null));
const changedTitle = computed(() => listed.value.changed.map((f) => f.path).join('\n'));

const rowKey = (row: DivergenceRow) => `${row.file.runtime}:${row.file.path}`;
const canUnfold = (row: DivergenceRow) => row.comparable && row.file.runtime === 'server' && props.projectId != null;
function toggle(row: DivergenceRow) {
  const next = new Set(expanded.value);
  const key = rowKey(row);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}
</script>

<template>
  <div
    v-if="baseline && differs"
    class="space-y-1.5"
    data-shot="execution-coverage-divergence"
    data-testid="coverage-divergence"
  >
    <h4 class="inline-flex items-center gap-1 text-sm font-semibold text-highlighted">
      Compared with the last passing run
      <HelpHint topic="case.coverage-divergence" />
    </h4>
    <p class="text-xs text-muted" data-testid="coverage-divergence-baseline">
      <NuxtLink :to="`/test-run-cases/${baseline.executionId}`" :class="SENTENCE_LINK_CLASS"
        >#{{ baseline.executionId }}</NuxtLink
      >
      in
      <NuxtLink :to="`/test-runs/${baseline.runId}`" :class="SENTENCE_LINK_CLASS">run #{{ baseline.runId }}</NuxtLink>
      · {{ formatRelativeTime(baseline.startedAt) }}
      <template v-if="baseline.branch"> · {{ baseline.branch }}</template>
      <template v-if="baseline.commit">
        · <span class="font-mono">{{ baseline.commit.slice(0, 7) }}</span></template
      >
      <template v-if="!baseline.sameProject">
        · different browser{{ baseline.project ? ` (${baseline.project})` : '' }}</template
      >
      <template v-if="!baseline.sameBranch"> · default branch</template>
    </p>
    <p v-if="incomplete" class="text-xs text-muted" data-testid="coverage-divergence-incomplete">{{ incomplete }}</p>

    <ul v-if="shownRows.length" class="rounded-md border border-default divide-y divide-default">
      <li
        v-for="row in shownRows"
        :key="rowKey(row)"
        :data-divergence-file="row.file.path"
        :data-divergence-status="row.file.status"
      >
        <div class="flex flex-col gap-0.5 px-3 py-1.5 sm:flex-row sm:items-baseline sm:gap-3">
          <span class="min-w-0 flex-1 inline-flex items-baseline gap-1 text-sm text-highlighted">
            <UButton
              v-if="canUnfold(row)"
              size="xs"
              color="neutral"
              variant="ghost"
              square
              class="-my-1 -ml-1.5 shrink-0 self-center"
              :icon="expanded.has(rowKey(row)) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              :aria-expanded="expanded.has(rowKey(row)) ? 'true' : 'false'"
              :aria-label="`${expanded.has(rowKey(row)) ? 'Hide' : 'Show'} what each run ran in ${row.file.path}`"
              @click="toggle(row)"
            />
            <span class="min-w-0">
              <OpenInIdeLink
                :file-path="row.file.path"
                :line="row.firstLine"
                :project-key="projectId"
                :project-name="projectName"
                ><span class="whitespace-normal [overflow-wrap:anywhere]"
                  ><template v-for="(part, i) in pathWrapParts(row.file.path)" :key="i"
                    >{{ part }}<wbr v-if="part.endsWith('/')" /></template></span
              ></OpenInIdeLink>
            </span>
          </span>
          <span class="text-xs text-muted sm:shrink-0" :class="canUnfold(row) ? 'pl-6 sm:pl-0' : ''">{{
            row.text
          }}</span>
        </div>
        <div v-if="expanded.has(rowKey(row)) && projectId != null" class="px-3 pb-3 pt-1">
          <CoverageDivergenceSource :project-id="projectId" :run-id="runId" :file="row.file" />
        </div>
      </li>
    </ul>
    <UButton
      v-if="listed.rows.length > shownRows.length"
      size="xs"
      color="neutral"
      variant="ghost"
      :label="`Show all ${listed.rows.length}`"
      @click="showAll = true"
    />
    <p v-if="listed.changed.length || answer?.moreFiles" class="text-xs text-muted" :title="changedTitle">
      <template v-if="listed.changed.length">{{ changedFilesText(listed.changed.length) }}</template>
      <template v-if="answer?.moreFiles"> {{ answer.moreFiles }} more files differ, not listed.</template>
    </p>
  </div>
  <p v-else-if="baseline && !incomplete" class="text-xs text-muted" data-testid="coverage-divergence-same">
    It ran the same code as its last passing run,
    <NuxtLink :to="`/test-run-cases/${baseline.executionId}`" :class="SENTENCE_LINK_CLASS"
      >#{{ baseline.executionId }}</NuxtLink
    >.
  </p>
  <p v-else-if="answer?.reason === 'no-baseline'" class="text-xs text-muted" data-testid="coverage-divergence-none">
    No earlier passing run of this test recorded coverage to compare with.
  </p>
</template>

<script setup lang="ts">
/**
 * The Coverage section of the execution page's Source tab: what this test
 * ran, from its coverage (`GET /api/test-run-cases/:id/coverage`). A summary
 * sentence ("Ran 5 server files (20 lines) and 3 browser files."), with a
 * hint when the capture was incomplete; then the server files, most executed
 * lines first, and the browser files, by path, the first 20 of each with the
 * rest one click away. Each row opens its file in the editor at the first
 * line it ran, says its precision and counts, marks a file the failure's
 * suspect lines name or the range changed (a link to the cluster's What
 * changed card), and links the file's coverage view; a server file with line
 * numbers unfolds to its source (`CoverageFileSource`). A test that recorded
 * nothing says so in one line, and one whose run recorded backend coverage
 * but none for it says that. A failed or timed-out execution also says how its
 * path differs from the test's last passing run (`CoverageDivergencePart`). The
 * page renders it only where the project's coverage capability is active.
 */
import type { CoverageCapture } from '@piwitests/core/coverage';
import type { ApiResponse } from '~~/types/api';
import type { SuspectLinesAnswer } from '#shared/suspect-lines';
import {
  COVERAGE_PRECISION_LABEL,
  COVERAGE_PRECISION_TITLE,
  COVERAGE_ROWS_SHOWN,
  coverageFileRoute,
  coverageGroups,
  coverageRowCounts,
  coverageSummary,
  type CoverageRow,
} from '~/utils/coverage-view';
import { lineRangesText } from '~/utils/suspect-lines';
import { isFailedStatus } from '#shared/utils/test-counts';

type RunCoverageResponse = ApiResponse<typeof import('~~/server/api/test-runs/[id]/coverage.get').default>;

const props = defineProps<{
  testRunsCaseId: number;
  /** The execution's run, for its run coverage. */
  runId: number | null;
  /** The execution's project: its file links and the source reads. */
  projectId: number | null;
  projectName?: string | null;
  /** The execution's suspect lines, which mark the files they name and the files the range changed. */
  suspects?: SuspectLinesAnswer | null;
  /** Where a mark leads: the cluster's What changed card. */
  whatChangedTo?: string | null;
  /** The execution's status: a failed one is compared with the test's last passing run. */
  status?: string | null;
}>();

const failing = computed(() => Boolean(props.status && isFailedStatus(props.status)));

const capture = ref<CoverageCapture | null>(null);
const pending = ref(true);
const failed = ref(false);
/** Whether the run recorded backend coverage, asked only when this test recorded none. */
const runHasServer = ref(false);

async function load(id: number) {
  pending.value = true;
  failed.value = false;
  runHasServer.value = false;
  try {
    const read = await $fetch<CoverageCapture>(`/api/test-run-cases/${id}/coverage`);
    if (id !== props.testRunsCaseId) return;
    capture.value = read;
    if (props.runId && !read.files.some((f) => f.runtime === 'server')) {
      const run = await $fetch<RunCoverageResponse>(`/api/test-runs/${props.runId}/coverage`, {
        query: { limit: 0 },
      }).catch(() => null);
      if (id === props.testRunsCaseId) runHasServer.value = (run?.fileCounts.server ?? 0) > 0;
    }
  } catch {
    if (id === props.testRunsCaseId) failed.value = true;
  } finally {
    if (id === props.testRunsCaseId) pending.value = false;
  }
}

onMounted(() => void load(props.testRunsCaseId));
watch(
  () => props.testRunsCaseId,
  (id) => {
    expanded.value = new Set();
    showAll.value = { server: false, browser: false };
    void load(id);
  },
);

const groups = computed(() => coverageGroups(capture.value, props.suspects));
const summary = computed(() => coverageSummary(groups.value));
const incomplete = computed(() => capture.value?.incomplete === true);
const hasFiles = computed(() => groups.value.server.length + groups.value.browser.length > 0);

const showAll = ref<Record<'server' | 'browser', boolean>>({ server: false, browser: false });
const sections = computed(() =>
  (['server', 'browser'] as const)
    .map((runtime) => {
      const rows = groups.value[runtime];
      const shown = showAll.value[runtime] ? rows : rows.slice(0, COVERAGE_ROWS_SHOWN);
      return { runtime, label: runtime === 'server' ? 'Server' : 'Browser', rows, shown };
    })
    .filter((section) => section.rows.length > 0),
);

/** The server files whose source is unfolded, by path. */
const expanded = ref(new Set<string>());
function toggle(path: string) {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

/** A server file with line numbers and a version unfolds to its source. */
const canUnfold = (row: CoverageRow) =>
  row.file.runtime === 'server' && Boolean(row.file.blob) && row.granularity !== 'files' && props.projectId != null;

/** A path cut after each slash, where a narrow row may wrap it. */
const pathParts = (path: string) => path.split(/(?<=\/)/);

function markText(row: CoverageRow): string {
  if (!row.mark) return '';
  return row.mark.kind === 'suspect'
    ? `suspect lines ${lineRangesText(row.mark.lines)}`
    : 'changed since the last passing run';
}
</script>

<template>
  <section data-shot="execution-coverage" data-tour="execution-coverage" class="border-t border-default pt-4">
    <SectionCard embedded title="Coverage" icon="i-lucide-scan-line" help="case.coverage">
      <p v-if="pending && !capture" class="text-xs text-muted">Reading the coverage…</p>
      <p v-else-if="failed" class="text-xs text-muted">The coverage of this execution could not be read.</p>

      <template v-else-if="!hasFiles">
        <p class="text-xs text-muted inline-flex items-center gap-1" data-testid="coverage-none">
          <template v-if="incomplete">This execution's coverage is no longer stored.</template>
          <template v-else>This execution recorded no coverage.</template>
          <HelpHint :topic="incomplete ? 'case.coverage-incomplete' : 'case.coverage-none'" />
        </p>
      </template>

      <div v-else class="space-y-3">
        <p class="text-sm text-highlighted leading-relaxed" data-testid="coverage-summary">
          {{ summary }}
          <template v-if="incomplete">
            Part of it is missing.
            <HelpHint topic="case.coverage-incomplete" />
          </template>
        </p>
        <p
          v-if="runHasServer && groups.server.length === 0"
          class="text-xs text-muted inline-flex items-center gap-1"
          data-testid="coverage-no-backend"
        >
          The backend recorded no coverage for this test.
          <HelpHint topic="case.coverage-backend-none" />
        </p>

        <CoverageDivergencePart
          v-if="failing"
          :execution-id="testRunsCaseId"
          :run-id="runId"
          :project-id="projectId"
          :project-name="projectName"
        />

        <div v-for="section in sections" :key="section.runtime" :data-coverage-group="section.runtime">
          <h4 class="mb-1 text-sm font-semibold text-highlighted">{{ section.label }}</h4>
          <ul class="rounded-md border border-default divide-y divide-default">
            <li v-for="row in section.shown" :key="row.file.path" :data-coverage-file="row.file.path">
              <div class="flex flex-col gap-0.5 px-3 py-1.5 sm:flex-row sm:items-baseline sm:gap-3">
                <span class="min-w-0 flex-1 inline-flex items-baseline gap-1 text-sm text-highlighted">
                  <UButton
                    v-if="canUnfold(row)"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    square
                    class="-my-1 -ml-1.5 shrink-0 self-center"
                    :icon="expanded.has(row.file.path) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                    :aria-expanded="expanded.has(row.file.path) ? 'true' : 'false'"
                    :aria-label="`${expanded.has(row.file.path) ? 'Hide' : 'Show'} the source of ${row.file.path}`"
                    @click="toggle(row.file.path)"
                  />
                  <span class="min-w-0">
                    <OpenInIdeLink
                      :file-path="row.file.path"
                      :line="row.firstLine"
                      :project-key="projectId"
                      :project-name="projectName"
                      ><span class="whitespace-normal [overflow-wrap:anywhere]"
                        ><template v-for="(part, i) in pathParts(row.file.path)" :key="i"
                          >{{ part }}<wbr v-if="part.endsWith('/')" /></template></span
                    ></OpenInIdeLink>
                  </span>
                </span>
                <span class="text-xs text-muted sm:shrink-0" :class="canUnfold(row) ? 'pl-6 sm:pl-0' : ''">
                  <span :title="COVERAGE_PRECISION_TITLE[row.granularity]">{{
                    COVERAGE_PRECISION_LABEL[row.granularity]
                  }}</span>
                  <template v-if="coverageRowCounts(row)"> · {{ coverageRowCounts(row) }}</template>
                  <template v-if="row.mark">
                    ·
                    <NuxtLink
                      v-if="whatChangedTo"
                      :to="whatChangedTo"
                      :class="SENTENCE_LINK_CLASS"
                      :data-coverage-mark="row.mark.kind"
                      title="In the cluster's What changed card"
                      >{{ markText(row) }}</NuxtLink
                    ><span v-else :data-coverage-mark="row.mark.kind">{{ markText(row) }}</span>
                  </template>
                  <template v-if="projectId != null">
                    ·
                    <NuxtLink
                      :to="coverageFileRoute(projectId, row.file.path, row.firstLine)"
                      :class="SENTENCE_LINK_CLASS"
                      title="The tests that run this file"
                      >tests</NuxtLink
                    >
                  </template>
                </span>
              </div>
              <div v-if="expanded.has(row.file.path) && projectId != null" class="px-3 pb-3 pt-1">
                <CoverageFileSource :project-id="projectId" :run-id="runId" :file="row.file" />
              </div>
            </li>
          </ul>
          <UButton
            v-if="section.rows.length > section.shown.length"
            size="xs"
            color="neutral"
            variant="ghost"
            class="mt-1"
            :label="`Show all ${section.rows.length}`"
            @click="showAll = { ...showAll, [section.runtime]: true }"
          />
        </div>
      </div>
    </SectionCard>
  </section>
</template>

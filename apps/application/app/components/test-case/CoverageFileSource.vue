<script setup lang="ts">
/**
 * The source of one file a test's coverage names, at the git blob its line
 * numbers refer to, with the lines the test ran marked and, when its run sent
 * run coverage for the same version, the executable lines it did not run.
 * Reads the source (`GET /api/projects/:id/source`) and, for a server file, the
 * run's coverage of the file (`GET /api/test-runs/:id/coverage?file=`) when it
 * mounts; a source the repository cannot serve leaves the line numbers alone.
 */
import { normalizeLineRanges, type CoverageFile } from '@piwitests/core/coverage';
import type { ApiResponse } from '~~/types/api';
import { subtractLineRanges } from '~/utils/coverage-view';

type SourceResponse = ApiResponse<typeof import('~~/server/api/projects/[id]/source.get').default>;
type RunCoverageResponse = ApiResponse<typeof import('~~/server/api/test-runs/[id]/coverage.get').default>;

const props = defineProps<{
  projectId: number;
  /** The run the coverage was recorded in, for its run coverage and the commit the source falls back to. */
  runId: number | null;
  /** The file as the test's coverage names it. */
  file: CoverageFile;
}>();

const content = ref<string | null>(null);
const executable = ref<CoverageFile['lines'] | null>(null);
const pending = ref(true);

watch(
  () => [props.projectId, props.runId, props.file.path, props.file.blob] as const,
  async ([projectId, runId, path, blob], _old, onCleanup) => {
    let stale = false;
    onCleanup(() => (stale = true));
    pending.value = true;
    const source = blob
      ? $fetch<SourceResponse>(`/api/projects/${projectId}/source`, {
          query: { path, blob, ...(runId ? { run: runId } : {}) },
        }).catch(() => null)
      : Promise.resolve(null);
    // Run coverage names the executable lines of server files only.
    const run =
      runId && blob && props.file.runtime === 'server'
        ? $fetch<RunCoverageResponse>(`/api/test-runs/${runId}/coverage`, { query: { file: path } }).catch(() => null)
        : Promise.resolve(null);
    const [read, runCoverage] = await Promise.all([source, run]);
    if (stale) return;
    content.value = read?.content ?? null;
    const own = runCoverage?.files.find((f) => f.runtime === 'server' && f.path === path && f.blob === blob);
    executable.value = own?.executable ?? null;
    pending.value = false;
  },
  { immediate: true },
);

const executed = computed(() => normalizeLineRanges(props.file.lines ?? []));
// The lines that did not run are known only at line precision, against the same version.
const notExecuted = computed(() =>
  executable.value && props.file.lines?.length
    ? subtractLineRanges(normalizeLineRanges(executable.value), executed.value)
    : null,
);
</script>

<template>
  <LoadingState v-if="pending" text="Reading the source…" />
  <CoverageSourceView
    v-else
    :path="file.path"
    :content="content"
    :executed="executed"
    :not-executed="notExecuted"
    :functions="file.functions ?? []"
    executed-title="Ran in this test"
    not-executed-title="Did not run in this test"
  />
</template>

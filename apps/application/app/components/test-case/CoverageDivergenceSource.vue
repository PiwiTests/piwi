<script setup lang="ts">
/**
 * The source of a file a failing execution and its last passing run both ran
 * at one version, with the lines only the execution ran marked, and the lines
 * only the passing run ran in the lighter mark. Reads the source at the file's
 * git blob (`GET /api/projects/:id/source`) when it mounts; a source the
 * repository cannot serve leaves the line numbers alone.
 */
import { normalizeLineRanges } from '@piwitests/core/coverage';
import type { DivergedFile } from '#shared/coverage-insights';
import type { ApiResponse } from '~~/types/api';

type SourceResponse = ApiResponse<typeof import('~~/server/api/projects/[id]/source.get').default>;

const props = defineProps<{
  projectId: number;
  /** The failing execution's run, the commit the source falls back to. */
  runId: number | null;
  file: DivergedFile;
}>();

const content = ref<string | null>(null);
const pending = ref(true);

watch(
  () => [props.projectId, props.runId, props.file.path, props.file.blob] as const,
  async ([projectId, runId, path, blob], _old, onCleanup) => {
    let stale = false;
    onCleanup(() => (stale = true));
    pending.value = true;
    const read = blob
      ? await $fetch<SourceResponse>(`/api/projects/${projectId}/source`, {
          query: { path, blob, ...(runId ? { run: runId } : {}) },
        }).catch(() => null)
      : null;
    if (stale) return;
    content.value = read?.content ?? null;
    pending.value = false;
  },
  { immediate: true },
);

const onlyHere = computed(() => normalizeLineRanges(props.file.linesOnlyHere ?? []));
const onlyPass = computed(() =>
  props.file.linesOnlyBaseline?.length ? normalizeLineRanges(props.file.linesOnlyBaseline) : null,
);
</script>

<template>
  <LoadingState v-if="pending" text="Reading the source…" />
  <CoverageSourceView
    v-else
    :path="file.path"
    :content="content"
    :executed="onlyHere"
    :not-executed="onlyPass"
    :focus-line="onlyHere[0]?.[0] ?? onlyPass?.[0]?.[0] ?? null"
    executed-title="Ran only in this execution"
    not-executed-title="Ran only in the passing run"
  />
</template>

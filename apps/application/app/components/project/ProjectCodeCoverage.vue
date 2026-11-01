<script setup lang="ts">
/**
 * The Coverage tab's Code view: the project's combined coverage at a commit
 * (`?commit=`, else the one whose coverage arrived last on `?branch=`), broken
 * down by `?folder=` and `?area=` (`GET /api/projects/:id/coverage-summary`).
 * A file of its tree opens the file's coverage page.
 */
import type { CoverageSummary } from '~~/server/utils/coverage-summary';

const props = defineProps<{ projectId: number }>();
const route = useRoute();

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

const {
  data: summary,
  status,
  error,
} = useFetch<CoverageSummary>(`/api/projects/${props.projectId}/coverage-summary`, {
  server: false,
  lazy: true,
  query: computed(() => ({
    commit: text(route.query.commit),
    branch: text(route.query.branch),
    folder: typeof route.query.folder === 'string' ? route.query.folder : undefined,
    area: text(route.query.area),
  })),
});
const loading = computed(() => status.value === 'idle' || status.value === 'pending');
/** The first read: a later one, for another folder or area, keeps the overview and its tree in place. */
const firstLoading = computed(() => loading.value && !summary.value);
/** No combined coverage at all: the summary answered 404. */
const noCombined = computed(() => error.value?.statusCode === 404);
</script>

<template>
  <div class="space-y-4">
    <LoadingState v-if="firstLoading" text="Combining the suites’ coverage…" />
    <EmptyState
      v-else-if="noCombined"
      text="No combined coverage yet: upload a suite’s coverage report with piwi coverage upload, or record run coverage with the reporter."
    />
    <ErrorState v-else-if="error || !summary" text="The combined coverage could not be read." />
    <ProjectCoverageOverview v-else :project-id="props.projectId" :summary="summary" :aria-busy="loading" />
  </div>
</template>

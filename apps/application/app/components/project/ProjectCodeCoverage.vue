<script setup lang="ts">
/**
 * The Coverage tab's Code view: the project's combined coverage at a commit
 * (`?commit=`, else the one whose coverage arrived last on `?branch=`), broken
 * down by `?folder=` and `?area=` (`GET /api/projects/:id/coverage-summary`).
 * The branch is the address's `?branch=`, else the one branch the project's
 * filters pick, else the default branch. A file of its tree opens the file's
 * coverage page.
 */
import type { CoverageSummary } from '~~/server/utils/coverage-summary';
import type { ProjectRunScope } from '#shared/project-run-scope';

const props = defineProps<{ projectId: number; scope?: ProjectRunScope }>();
const route = useRoute();

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
/** The filters' branch, when they pick exactly one. */
const filterBranch = computed(() => (props.scope?.branches.length === 1 ? props.scope.branches[0] : undefined));
const branch = computed(() => text(route.query.branch) ?? filterBranch.value);
/** The filters pick several branches and the address names none: the default branch is read. */
const severalBranches = computed(() => !text(route.query.branch) && (props.scope?.branches.length ?? 0) > 1);

const {
  data: summary,
  status,
  error,
} = useFetch<CoverageSummary>(`/api/projects/${props.projectId}/coverage-summary`, {
  server: false,
  lazy: true,
  query: computed(() => ({
    commit: text(route.query.commit),
    branch: branch.value,
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
    <p v-if="severalBranches" class="text-xs text-muted max-sm:px-4" data-testid="coverage-branch-note">
      Coverage is read on one branch: the filters pick several, so this is the default branch.
    </p>
    <p v-else-if="filterBranch && !text(route.query.branch)" class="text-xs text-muted max-sm:px-4">
      On <span class="font-mono">{{ filterBranch }}</span
      >, the branch the filters pick.
    </p>
    <LoadingState v-if="firstLoading" text="Combining the suites’ coverage…" />
    <EmptyState
      v-else-if="noCombined"
      text="No combined coverage yet: upload a suite’s coverage report with piwi coverage upload, or record run coverage with the reporter."
    />
    <ErrorState v-else-if="error || !summary" text="The combined coverage could not be read." />
    <ProjectCoverageOverview
      v-else
      :project-id="props.projectId"
      :summary="summary"
      :branch="branch"
      :aria-busy="loading"
    />
  </div>
</template>

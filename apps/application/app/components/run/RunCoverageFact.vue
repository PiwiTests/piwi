<script setup lang="ts">
/**
 * The run's commit's combined coverage, as one fact of the run header:
 * "Coverage 71.4% of 12,480 lines · 3 suites", linking to the project's
 * coverage page at that commit. Nothing when the commit has none.
 */
import type { CoverageSummary } from '~~/server/utils/coverage-summary';
import { formatPercent, plural } from '~/utils/combined-coverage';

const props = defineProps<{ projectId: number; commit: string }>();

// Read in the browser: a fact below the fold of the server render, and a 404 for most commits.
const { data } = useFetch<CoverageSummary>(`/api/projects/${props.projectId}/coverage-summary`, {
  server: false,
  lazy: true,
  query: { commit: props.commit },
});
const summary = computed(() => (data.value?.commit ? data.value : null));
</script>

<template>
  <template v-if="summary">
    <span class="text-dimmed">·</span>
    <NuxtLink
      :to="{ path: `/projects/${projectId}/coverage`, query: { commit: summary.commit } }"
      class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
      :title="`Every suite's coverage at ${summary.commit.slice(0, 7)}`"
      data-testid="run-coverage-fact"
    >
      Coverage {{ formatPercent(summary.totals.linePercent) }} of {{ plural(summary.totals.executableLines, 'line') }} ·
      {{ plural(summary.suites.length, 'suite') }}
    </NuxtLink>
  </template>
</template>

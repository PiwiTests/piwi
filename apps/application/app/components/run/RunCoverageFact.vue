<script setup lang="ts">
/**
 * The run's coverage, as facts of the run header: its commit's combined
 * coverage, "Coverage 71.4% of 12,480 lines · 3 suites", linking to the
 * project's coverage page at that commit ("· totals only" when a newer commit
 * superseded its files), and, when part of the run's server coverage is
 * missing, the flag "Coverage incomplete: the backend restarted during the
 * run", its title saying what each backend lost. Nothing when the commit has
 * no coverage and the run's is whole.
 */
import type { CoverageSummary } from '~~/server/utils/coverage-summary';
import type { RunCoverageGap } from '#shared/run-coverage-gaps';
import { coverageGapDetail, coverageGapHeadline, formatPercent, plural } from '~/utils/combined-coverage';

const props = defineProps<{ projectId: number; commit: string | null; gaps?: RunCoverageGap[] }>();

// Read in the browser: a fact below the fold of the server render, and a 404 for most commits.
const { data } = useFetch<CoverageSummary>(`/api/projects/${props.projectId}/coverage-summary`, {
  server: false,
  lazy: true,
  query: { commit: props.commit },
  immediate: props.commit !== null,
});
const summary = computed(() => (props.commit && data.value?.commit ? data.value : null));
const gapHeadline = computed(() => coverageGapHeadline(props.gaps ?? []));
const gapTitle = computed(() => (props.gaps ?? []).map((g) => coverageGapDetail(g, prettyDateFormat)).join('\n'));
</script>

<template>
  <template v-if="summary">
    <span class="text-dimmed">·</span>
    <NuxtLink
      :to="{ path: `/projects/${projectId}/coverage`, query: { commit: summary.commit } }"
      class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
      :title="
        summary.detailRemoved
          ? `Only the totals of ${summary.commit.slice(0, 7)} are kept: a newer commit superseded its files`
          : `Every suite's coverage at ${summary.commit.slice(0, 7)}`
      "
      data-testid="run-coverage-fact"
    >
      Coverage {{ formatPercent(summary.totals.linePercent) }} of {{ plural(summary.totals.executableLines, 'line') }} ·
      {{ plural(summary.suites.length, 'suite') }}<template v-if="summary.detailRemoved"> · totals only</template>
    </NuxtLink>
  </template>
  <template v-if="gapHeadline">
    <span class="text-dimmed">·</span>
    <span
      class="text-warning"
      :title="gapTitle"
      data-testid="run-coverage-incomplete"
      data-shot="run-coverage-incomplete"
      >{{ gapHeadline }}</span
    >
  </template>
</template>

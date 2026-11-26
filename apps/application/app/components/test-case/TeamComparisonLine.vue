<script setup lang="ts">
/**
 * Compare with team instance, in the desktop app: how the test does in the CI of the team instance its folder is
 * linked to. A failing execution's conclusion first (`withConclusion`), then the test's results there, one strip per
 * environment the CI ran it in and one for the teammates' shared runs, each with the pass rate of the results it shows,
 * then the links, which open in the browser: the test on the team instance, what the conclusion read there, and the
 * environment differences from the closest CI pass, in a side panel. When the app is connected and cannot compare,
 * one sentence says why (`teamComparisonProblem`), with a link to Settings → Team instance when the folder still needs
 * linking to a team project; the page shows nothing when the app is not connected.
 */
import type { DesktopTeamComparison } from '~~/server/utils/desktop-team-comparison';
import type { TestComparisonResult } from '#shared/test-comparison';
import type { TeamHistoryRow } from '#shared/test-comparison-conclusion';
import type { TestCaseHistoryPoint } from '~~/types/api';
import { flakyRate, passRate } from '#shared/utils/pass-rate';
import { HISTORY_STRIP_LENGTH } from '~/utils/history-streak';

const props = defineProps<{
  comparison: DesktopTeamComparison;
  /** Show the conclusion and the environment differences: an execution's line, not a test's. */
  withConclusion?: boolean;
}>();

const ok = computed(() => (props.comparison.status === 'ok' ? props.comparison : null));
const onInstance = (path: string) => `${ok.value?.instance ?? ''}${path}`;

/** A result as the history strip reads a point: its outcome, its run, and when. */
function pointsOf(results: TestComparisonResult[]): TestCaseHistoryPoint[] {
  return results.map((result) => ({
    id: result.executionId,
    runId: result.runId,
    status: result.status,
    duration: null,
    error: null,
    retries: null,
    passedAfterFailure: result.flaky,
    startTime: new Date(result.startTime ?? 0),
    runStatus: '',
  }));
}

function rowLabel(row: TeamHistoryRow): string {
  if (row.source === 'local') return 'Teammates';
  return row.environment ? `CI, ${row.environment}` : 'CI';
}

/** The pass rate of the results the row's strip shows, by the one pass rate rule, and its flaky share. */
function rateOf(row: TeamHistoryRow): string | null {
  const shown = row.results.slice(0, HISTORY_STRIP_LENGTH);
  const counts = {
    passed: shown.filter((r) => r.status === 'passed').length,
    failed: shown.filter((r) => r.status === 'failed' || r.status === 'timedOut').length,
    flaky: shown.filter((r) => r.status === 'passed' && r.flaky).length,
  };
  const rate = passRate(counts);
  if (rate === null) return null;
  const flaky = flakyRate(counts) ?? 0;
  return `${Math.round(rate * 100)}% passed${flaky > 0 ? `, ${Math.round(flaky * 100)}% flaky` : ''}`;
}

/** The page of the team instance the conclusion read: the cluster of the same error, else the CI execution. */
const conclusionLink = computed(() => {
  const answer = ok.value;
  const conclusion = answer?.conclusion;
  if (!answer || !conclusion) return null;
  if (conclusion.rule === 'same-error-in-ci' && answer.comparison.cluster) {
    return { href: onInstance(answer.comparison.cluster.path), label: 'Open the cluster on the team instance' };
  }
  return conclusion.result
    ? { href: onInstance(conclusion.result.path), label: `Open the CI execution of run #${conclusion.result.runId}` }
    : null;
});

const differences = computed(() => (ok.value?.environmentDiff ?? []).filter((entry) => !entry.informational).length);

const problem = computed(() => teamComparisonProblem(props.comparison));
const needsLink = computed(() => teamComparisonNeedsLink(props.comparison));

const panelOpen = ref(false);
const pass = computed(() => ok.value?.comparison.closestPass ?? null);
const passFacts = computed(() => {
  const p = pass.value;
  if (!p) return '';
  const where = [p.environment, p.branch, p.commit?.slice(0, 7)].filter(Boolean).join(', ');
  return `Run #${p.runId} on the team instance${where ? ` (${where})` : ''}${p.sameCommit ? ', on this commit' : ''}`;
});
</script>

<template>
  <div v-if="ok || problem" class="space-y-2" data-shot="team-ci-line">
    <template v-if="ok">
      <p v-if="withConclusion && ok.conclusion">{{ ok.conclusion.text }}</p>
      <p v-if="!ok.comparison.testCase" class="text-xs text-muted">
        Not on the team instance: a new test, a renamed one, or a CI that runs another config.
      </p>
      <div
        v-for="row in ok.rows"
        :key="`${row.source}:${row.environment ?? ''}`"
        class="flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <span class="text-xs text-muted w-28 shrink-0 truncate" :title="rowLabel(row)">{{ rowLabel(row) }}</span>
        <HistoryStrip :history="pointsOf(row.results)" :linked="false" />
        <span v-if="rateOf(row)" class="text-xs text-muted">{{ rateOf(row) }}</span>
      </div>
      <p class="text-xs text-muted flex flex-wrap gap-x-3 gap-y-1">
        <a
          v-if="withConclusion && conclusionLink"
          :href="conclusionLink.href"
          target="_blank"
          rel="noopener"
          :class="SENTENCE_LINK_CLASS"
          >{{ conclusionLink.label }}</a
        >
        <a
          v-if="ok.comparison.testCase"
          :href="onInstance(ok.comparison.testCase.path)"
          target="_blank"
          rel="noopener"
          :class="SENTENCE_LINK_CLASS"
          >Open on the team instance</a
        >
        <button
          v-if="withConclusion && pass && ok.environmentDiff"
          type="button"
          :class="SENTENCE_LINK_CLASS"
          data-shot="team-ci-differences"
          @click="panelOpen = true"
        >
          {{
            differences === 0
              ? 'Same environment as the closest CI pass'
              : `${differences} environment difference${differences === 1 ? '' : 's'} from the closest CI pass`
          }}
        </button>
        <span v-if="ok.comparison.playwrightProjectMatched === false && ok.rows.length"
          >Results of every Playwright project: the CI never ran this test in this run’s</span
        >
      </p>
    </template>
    <p v-else class="text-xs text-muted" data-testid="team-ci-problem">
      {{ problem }}
      <NuxtLink v-if="needsLink" to="/settings/team-instance" :class="SENTENCE_LINK_CLASS"
        >Link it on Settings → Team instance</NuxtLink
      >
    </p>

    <USlideover
      v-if="withConclusion && pass && ok?.environmentDiff"
      v-model:open="panelOpen"
      title="Compared with the closest CI pass"
      :description="passFacts"
      :ui="{ content: 'sm:max-w-2xl' }"
    >
      <template #body>
        <div class="space-y-3" data-shot="team-ci-differences-panel">
          <EnvironmentDiffEntries
            :entries="ok.environmentDiff"
            this-label="This run"
            :other-label="`CI, run #${pass.runId}`"
          />
          <p v-if="ok.environmentDiff.length === 0" class="text-sm text-highlighted">
            The environment is the same as the closest CI pass: the difference lies elsewhere, such as the data or the
            services the test reaches.
          </p>
          <a :href="onInstance(pass.path)" target="_blank" rel="noopener" class="text-xs" :class="SENTENCE_LINK_CLASS"
            >Open the CI execution on the team instance</a
          >
        </div>
      </template>
    </USlideover>
  </div>
</template>

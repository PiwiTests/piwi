<script setup lang="ts">
/**
 * The suspect lines of the What changed card: the changed hunks the cluster's
 * failing tests ran, most suspect first, each with its file (open in the IDE),
 * its lines, its granularity in words, and how many failing and passing tests
 * ran it; the score is on hover. A meta line says whose coverage it read, the
 * range when the diff below is not of the same commits, and how many changed
 * files had no patch to check. Each file links its coverage page, which lists
 * the tests running each of its lines. The first five show; the rest unfold.
 */
import type { ClusterSuspectLinesAnswer } from '~~/types/api';
import { lineRangesText, suspectGranularityLabel, suspectLinesSentence, testCountText } from '~/utils/suspect-lines';
import { coverageFileRoute } from '~/utils/coverage-view';

const props = defineProps<{
  answer: ClusterSuspectLinesAnswer;
  /** Whether the diff below is of the same head commit, so it marks these lines. */
  marked: boolean;
  project?: { id: number; name?: string | null } | null;
}>();

const FIRST = 5;
const showAll = ref(false);
const shown = computed(() => (showAll.value ? props.answer.suspects : props.answer.suspects.slice(0, FIRST)));
const hidden = computed(() => props.answer.suspects.length - shown.value.length);

/**
 * Whose coverage the list reads, the range when the diff below shows another,
 * and the changed files whose lines it could not check.
 */
const meta = computed(() => {
  const { summary, runId, range, unreadFiles } = props.answer;
  const tests = `${testCountText(summary.failingWithCoverage, 'failing')} and ${testCountText(summary.passingWithCoverage, 'passing')} with coverage`;
  const run = runId != null ? `, in run #${runId}` : '';
  const since = !props.marked && range ? ` · ${range.from.slice(0, 7)}..${range.to.slice(0, 7)}` : '';
  const unread = unreadFiles
    ? ` · ${unreadFiles} changed file${unreadFiles === 1 ? '' : 's'} not checked (no patch)`
    : '';
  return `${tests}${run}${since}${unread}`;
});

/** With no hunk the failing tests ran, the sentence that says so. */
const none = computed(() =>
  props.answer.suspects.length ? null : suspectLinesSentence(props.answer, 'cluster')?.lead,
);

const scoreTitle = (score: number) =>
  `Score ${score.toFixed(2)}: 1 when only failing tests ran these lines, lower the more passing tests ran them too`;
</script>

<template>
  <div data-shot="suspect-lines" class="space-y-1.5">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span class="inline-flex items-center gap-1 text-sm font-semibold text-highlighted">
        Suspect lines <HelpHint topic="cluster.suspect-lines" />
      </span>
      <span class="text-xs text-muted">{{ meta }}</span>
    </div>

    <p v-if="none" class="text-sm text-highlighted">{{ none }}</p>
    <ol v-else class="rounded-md border border-default divide-y divide-default">
      <li
        v-for="suspect in shown"
        :key="`${suspect.path}:${suspect.hunk[0]}`"
        class="flex flex-col gap-0.5 px-3 py-1.5 sm:flex-row sm:items-baseline sm:gap-3"
      >
        <span class="min-w-0 flex-1 text-sm text-highlighted break-words">
          <OpenInIdeLink
            :file-path="suspect.path"
            :line="suspect.lines[0]?.[0] ?? suspect.hunk[0]"
            :project-key="project?.id"
            :project-name="project?.name"
            >{{ suspect.path }}</OpenInIdeLink
          >
          {{ lineRangesText(suspect.lines) }}
        </span>
        <span class="text-xs text-muted sm:shrink-0" :title="scoreTitle(suspect.score)">
          {{ suspectGranularityLabel(suspect.granularity) }} · {{ testCountText(suspect.failing, 'failing') }},
          {{ testCountText(suspect.passing, 'passing') }}
          <template v-if="project">
            ·
            <NuxtLink
              :to="coverageFileRoute(project.id, suspect.path, suspect.lines[0]?.[0] ?? suspect.hunk[0])"
              :class="SENTENCE_LINK_CLASS"
              title="Every test that runs this file, line by line"
              >tests</NuxtLink
            >
          </template>
        </span>
      </li>
    </ol>
    <UButton
      v-if="hidden > 0"
      size="xs"
      color="neutral"
      variant="ghost"
      :label="`Show ${hidden} more`"
      @click="showAll = true"
    />
  </div>
</template>

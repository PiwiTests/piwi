<script setup lang="ts">
/**
 * The "What changed" card of the cluster page: the baseline picker, the commit
 * browser, the suspect lines and the diff between the baseline and the failing
 * run. It renders only with something to show, a resolved diff or a
 * hand-picked commit range; the situation block's "What changed" line
 * (`WhatChangedLine`) sums the range up and, with nothing to diff, says why and
 * offers the browser instead. The diff marks the suspect lines when it is of
 * the commit their coverage was recorded on and no commits are picked by hand,
 * so its line numbers are theirs.
 */
import { suspectMarks } from '~/utils/suspect-lines';

defineProps<{
  /** The cluster's project, for the suspect files' IDE links. */
  project?: { id: number; name?: string | null } | null;
}>();

const {
  clusterId,
  baseCommit,
  selectedCommitShas,
  autoSelectedCommits,
  baseCommitIsPinned,
  coverage,
  scmChanges,
  contextLoading,
  hasChangesToShow,
  refreshContext,
  suspectLines,
  loadSuspectLines,
} = useClusterDiagnosis();

const commitBrowserOpen = ref(false);

onMounted(() => void loadSuspectLines());
const suspects = computed(() => (suspectLines.value?.available ? suspectLines.value : null));
const marked = computed(() => {
  const head = suspects.value?.range?.to;
  const shown = coverage.value?.scm?.range?.to;
  return Boolean(head && shown && head.startsWith(shown) && selectedCommitShas.value.length === 0);
});
const marks = computed(() => (marked.value && suspects.value ? suspectMarks(suspects.value.suspects) : null));

function refresh() {
  void refreshContext();
  void loadSuspectLines(true);
}
</script>

<template>
  <SectionCard
    v-if="hasChangesToShow"
    icon="i-lucide-git-compare-arrows"
    title="What changed"
    help="cluster.scm"
    data-tour="what-changed-card"
  >
    <div class="space-y-3">
      <div class="pb-2 border-b border-default">
        <div class="flex items-center gap-2 flex-wrap" data-tour="what-changed-baseline">
          <span class="text-xs text-gray-500 font-medium shrink-0 inline-flex items-center gap-1">
            Baseline <HelpHint topic="cluster.baseline" />
          </span>
          <CommitPicker v-model="baseCommit" :cluster-id="clusterId" />
          <UTooltip v-if="baseCommitIsPinned" text="Baseline commit pinned for this cluster">
            <UIcon name="i-lucide-pin" class="size-3.5 text-primary shrink-0" />
          </UTooltip>
          <div class="flex items-center gap-1.5 ml-auto">
            <div
              v-if="selectedCommitShas.length"
              class="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium"
            >
              <UIcon name="i-lucide-git-commit-horizontal" class="size-3" />
              <span>{{ selectedCommitShas.length }} commit{{ selectedCommitShas.length === 1 ? '' : 's' }}</span>
              <button class="ml-0.5 hover:opacity-70 transition-opacity" @click="selectedCommitShas = []">
                <UIcon name="i-lucide-x" class="size-3" />
              </button>
            </div>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-list"
              data-tour="what-changed-browse"
              @click="commitBrowserOpen = true"
            >
              Browse
            </UButton>
            <UButton
              icon="i-lucide-refresh-cw"
              size="xs"
              color="neutral"
              variant="outline"
              :loading="contextLoading"
              @click="refresh"
            />
          </div>
        </div>
      </div>

      <SuspectLinesList v-if="suspects" :answer="suspects" :marked="marked" :project="project" />

      <div v-if="contextLoading && !scmChanges" class="flex items-center justify-center py-6">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-gray-400" />
      </div>
      <ScmChangesView v-else-if="scmChanges" :changes="scmChanges" :marks="marks" />
    </div>
    <CommitBrowserModal
      v-model:open="commitBrowserOpen"
      :cluster-id="clusterId"
      :initial-selected="selectedCommitShas"
      :auto-selected-shas="autoSelectedCommits"
      @confirm="selectedCommitShas = $event"
    />
  </SectionCard>
</template>

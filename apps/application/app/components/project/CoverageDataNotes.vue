<script setup lang="ts">
/**
 * What a commit's coverage numbers leave out or take from elsewhere, one
 * plain sentence per note (`dataNoteSentence`): only its totals kept, a suite
 * carried from an earlier commit, an incomplete report, runs whose backend
 * restarted or was unreachable, a suite the commit lacks, no inventory, an
 * earlier scope, runs that do not count. Each commit a note names links to the
 * coverage at that commit, each run to its page. Renders nothing without a
 * note.
 */
import type { CoverageDataNote } from '~~/server/utils/coverage-summary';
import { coverageLink, dataNoteSentence, type CoverageLinkContext } from '~/utils/combined-coverage';

const props = defineProps<{
  projectId: number;
  notes: CoverageDataNote[];
  /** The commit's branch; null for the default branch. */
  branch: string | null;
  /** What the commit links keep: the branch and the area. */
  link: CoverageLinkContext;
}>();

const LINK_CLASS = 'font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid';

const sentences = computed(() =>
  props.notes.map((note) => ({ kind: note.kind, parts: dataNoteSentence(note, props.branch) })),
);
</script>

<template>
  <div
    v-if="notes.length"
    class="flex items-start gap-2 rounded-md border border-default bg-elevated/40 px-3 py-2"
    role="note"
    aria-label="What these numbers leave out"
    data-testid="coverage-notes"
    data-tour="coverage-notes"
  >
    <UIcon name="i-lucide-info" class="mt-0.5 size-4 shrink-0 text-muted" />
    <ul class="min-w-0 flex-1 space-y-1 text-sm text-highlighted leading-relaxed">
      <li v-for="(sentence, i) in sentences" :key="i" :data-note="sentence.kind">
        <template v-for="(part, j) in sentence.parts" :key="j">
          <template v-if="typeof part === 'string'">{{ part }}</template>
          <NuxtLink
            v-else-if="'run' in part"
            :to="`/test-runs/${part.run}`"
            :class="LINK_CLASS"
            :title="`Run #${part.run}`"
            >#{{ part.run }}</NuxtLink
          >
          <NuxtLink
            v-else
            :to="coverageLink(projectId, { ...link, commit: part.commit })"
            :class="LINK_CLASS"
            :title="`The coverage at ${part.commit.slice(0, 7)}`"
            >{{ part.commit.slice(0, 7) }}</NuxtLink
          >
        </template>
      </li>
    </ul>
    <HelpHint topic="coverage.notes" />
  </div>
</template>

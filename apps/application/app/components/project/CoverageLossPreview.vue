<script setup lang="ts">
/**
 * What quarantining (or releasing) tests does to the code no other trusted
 * test runs, from their coverage loss: the answer in one sentence ("Leaves 12
 * lines in 2 files run by no other trusted test"), the worst files with the
 * lines, each opening in the editor, and one meta line for what only flaky
 * tests run and the files other tests ran at another version. `compact` keeps
 * the sentence alone. Renders nothing when the answer has nothing to say:
 * no coverage, or a release that covers nothing again.
 */
import type { CoverageLossAnswer } from '#shared/coverage-insights';
import { coverageLossPreview, pathWrapParts } from '~/utils/coverage-insights';

const props = defineProps<{
  answer: CoverageLossAnswer | null;
  /** `release` says what releasing the tests covers again. */
  action?: 'quarantine' | 'release';
  projectId: string | number;
  projectName?: string | null;
  /** The sentence alone, for a bar or a menu. */
  compact?: boolean;
}>();

const preview = computed(() => coverageLossPreview(props.answer, props.action ?? 'quarantine'));
</script>

<template>
  <div v-if="preview" class="space-y-1" data-shot="coverage-loss-preview" data-testid="coverage-loss-preview">
    <p class="text-sm text-highlighted leading-relaxed">
      {{ preview.headline }}
      <HelpHint v-if="!compact" topic="quarantine.coverage-loss" class="align-middle" />
    </p>
    <template v-if="!compact">
      <ul v-if="preview.files.length" class="space-y-0.5">
        <li
          v-for="row in preview.files"
          :key="`${row.file.runtime}:${row.file.path}`"
          class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted"
          :data-loss-file="row.file.path"
        >
          <OpenInIdeLink
            :file-path="row.file.path"
            :line="row.firstLine"
            :project-key="projectId"
            :project-name="projectName"
            class="min-w-0"
            ><span class="whitespace-normal [overflow-wrap:anywhere]"
              ><template v-for="(part, i) in pathWrapParts(row.file.path)" :key="i"
                >{{ part }}<wbr v-if="part.endsWith('/')" /></template></span
          ></OpenInIdeLink>
          <span>{{ row.text }}</span>
        </li>
      </ul>
      <p v-if="preview.extra" class="text-xs text-muted">{{ preview.extra }}</p>
    </template>
  </div>
</template>

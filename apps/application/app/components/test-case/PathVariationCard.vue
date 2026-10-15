<script setup lang="ts">
/**
 * A test's path variation (`GET /api/test-cases/:id/path-variation`): how its
 * code path varies across its recent executions with coverage. The card says
 * in how many executions it took a different path, names the earlier test
 * whose having finished first predicts it ("In 0 of 11 executions where
 * *updates the organization name* finished earlier in the run, it ran
 * `PreferencesEndpoints.cs` lines 58 to 59; in 3 of 3 otherwise"), says when
 * the test's failures follow that difference (the `order` flaky root cause),
 * and lists the varying code: the executions that ran each part, one that ran
 * it and one that did not, and its files, each opening in the editor and
 * linking the file's coverage view. Read in the browser when it mounts; it
 * renders nothing until the answer names varying code. The page mounts it only
 * where the project's coverage capability is active.
 */
import type { ApiResponse } from '~~/types/api';
import { coverageFileRoute } from '~/utils/coverage-view';
import {
  explanationRelationText,
  linesPhrase,
  orderDependentText,
  pathVariationHeadline,
  pathWrapParts,
  varyingCodeText,
  varyingFileLine,
  varyingFilePhrase,
} from '~/utils/coverage-insights';

type PathVariationResponse = ApiResponse<typeof import('~~/server/api/test-cases/[id]/path-variation.get').default>;

const props = defineProps<{
  testCaseId: number;
  projectId: number;
  projectName?: string | null;
}>();

/** Varying groups shown before "Show all". */
const GROUPS_SHOWN = 3;

const answer = ref<PathVariationResponse | null>(null);
const showAll = ref(false);

watch(
  () => props.testCaseId,
  async (id, _old, onCleanup) => {
    let stale = false;
    onCleanup(() => (stale = true));
    answer.value = null;
    showAll.value = false;
    const read = await $fetch<PathVariationResponse>(`/api/test-cases/${id}/path-variation`).catch(() => null);
    if (!stale) answer.value = read;
  },
  { immediate: true },
);

const headline = computed(() => (answer.value ? pathVariationHeadline(answer.value) : null));
const compared = computed(() => answer.value?.executions.compared ?? 0);
const explanation = computed(() => answer.value?.explanation ?? null);
/** The first file of the code the earlier test predicts, and how many more it has. */
const explained = computed(() => {
  const e = explanation.value;
  const code = e ? answer.value?.varying[e.varying] : null;
  const file = code?.files[0];
  if (!e || !code || !file) return null;
  return {
    file,
    line: varyingFileLine(file),
    ranges: linesPhrase(file.lines) || (file.functions?.length ? varyingFilePhrase(file) : ''),
    more: code.files.length - 1 + (code.moreFiles ?? 0),
  };
});
const orderText = computed(() => (answer.value ? orderDependentText(answer.value) : null));
const groups = computed(() => answer.value?.varying ?? []);
const shownGroups = computed(() => (showAll.value ? groups.value : groups.value.slice(0, GROUPS_SHOWN)));
const footer = computed(() => {
  const a = answer.value;
  if (!a) return '';
  const parts = [`Compared ${a.executions.compared} executions${a.project ? ` in ${a.project}` : ''}`];
  if (a.executions.incomplete > 0) parts.push(`${a.executions.incomplete} left out as incomplete`);
  if (a.files.changedVersion > 0) {
    parts.push(
      `${a.files.changedVersion} file${a.files.changedVersion === 1 ? '' : 's'} ran at several versions, not compared`,
    );
  }
  return `${parts.join('; ')}.`;
});
</script>

<template>
  <CollapsibleSectionCard
    v-if="answer?.available && headline"
    title="Path variation"
    icon="i-lucide-git-fork"
    help="case.path-variation"
    storage-key="test-path-variation"
    :default-folded="false"
    data-shot="test-path-variation"
    data-testid="path-variation"
  >
    <template #folded>{{ headline }}</template>
    <div class="space-y-3">
      <div class="space-y-1">
        <p class="text-sm text-highlighted leading-relaxed" data-testid="path-variation-headline">{{ headline }}.</p>
        <p
          v-if="explanation && explained"
          class="text-sm text-highlighted leading-relaxed"
          data-testid="path-variation-explanation"
        >
          In {{ explanation.before.ranCode }} of {{ explanation.before.executions }} executions where
          <NuxtLink :to="`/test-cases/${explanation.testCaseId}`" :class="SENTENCE_LINK_CLASS">{{
            explanation.title || `test #${explanation.testCaseId}`
          }}</NuxtLink>
          {{ explanationRelationText(explanation.relation) }}, it ran this code; in
          {{ explanation.notBefore.ranCode }} of {{ explanation.notBefore.executions }} otherwise:
        </p>
        <p
          v-if="explanation && explained"
          class="flex min-w-0 flex-col gap-x-3 sm:flex-row sm:items-baseline"
          data-testid="path-variation-explained-code"
        >
          <OpenInIdeLink
            :file-path="explained.file.path"
            :line="explained.line"
            :project-key="projectId"
            :project-name="projectName"
            class="min-w-0 text-sm"
            ><span class="whitespace-normal [overflow-wrap:anywhere]"
              ><template v-for="(part, i) in pathWrapParts(explained.file.path)" :key="i"
                >{{ part }}<wbr v-if="part.endsWith('/')" /></template></span
          ></OpenInIdeLink>
          <span class="text-xs text-muted"
            >{{ explained.ranges
            }}<template v-if="explained.more > 0">
              · and {{ explained.more }} more file{{ explained.more === 1 ? '' : 's' }}</template
            ></span
          >
        </p>
        <p v-if="orderText" class="text-sm text-highlighted leading-relaxed" data-testid="path-variation-order">
          {{ orderText }}
        </p>
      </div>

      <div>
        <h4 class="mb-1 text-sm font-semibold text-highlighted">Varying code</h4>
        <ul class="rounded-md border border-default divide-y divide-default">
          <li v-for="(code, index) in shownGroups" :key="index" class="space-y-1 px-3 py-2" data-varying-code>
            <p class="text-xs text-muted">
              {{ varyingCodeText(code, compared) }}
              <template v-if="code.examples.ran[0] && code.examples.notRan[0]">
                ·
                <NuxtLink :to="`/test-run-cases/${code.examples.ran[0]}`" :class="SENTENCE_LINK_CLASS"
                  >#{{ code.examples.ran[0] }}</NuxtLink
                >
                ran it,
                <NuxtLink :to="`/test-run-cases/${code.examples.notRan[0]}`" :class="SENTENCE_LINK_CLASS"
                  >#{{ code.examples.notRan[0] }}</NuxtLink
                >
                did not
              </template>
            </p>
            <ul class="space-y-0.5">
              <li
                v-for="file in code.files"
                :key="`${file.runtime}:${file.path}`"
                class="flex min-w-0 flex-col gap-x-3 sm:flex-row sm:items-baseline"
                :data-varying-file="file.path"
              >
                <OpenInIdeLink
                  :file-path="file.path"
                  :line="varyingFileLine(file)"
                  :project-key="projectId"
                  :project-name="projectName"
                  class="min-w-0 text-sm"
                  ><span class="whitespace-normal [overflow-wrap:anywhere]"
                    ><template v-for="(part, i) in pathWrapParts(file.path)" :key="i"
                      >{{ part }}<wbr v-if="part.endsWith('/')" /></template></span
                ></OpenInIdeLink>
                <span class="text-xs text-muted">
                  {{ varyingFilePhrase(file) }} ·
                  <NuxtLink
                    :to="coverageFileRoute(projectId, file.path, varyingFileLine(file))"
                    :class="SENTENCE_LINK_CLASS"
                    title="The tests that run this file"
                    >tests</NuxtLink
                  >
                </span>
              </li>
            </ul>
            <p v-if="code.moreFiles" class="text-xs text-muted">and {{ code.moreFiles }} more files</p>
          </li>
        </ul>
        <UButton
          v-if="groups.length > shownGroups.length"
          size="xs"
          color="neutral"
          variant="ghost"
          class="mt-1"
          :label="`Show all ${groups.length}`"
          @click="showAll = true"
        />
        <p v-if="answer.moreVarying" class="mt-1 text-xs text-muted">
          {{ answer.moreVarying }} more varying parts, not listed.
        </p>
      </div>

      <p class="text-xs text-muted" data-testid="path-variation-footer">{{ footer }}</p>
    </div>
  </CollapsibleSectionCard>
</template>

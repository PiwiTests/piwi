<script setup lang="ts">
/**
 * The tests a run reused from earlier passes under its pass reuse plan, each
 * with the Playwright projects it was skipped in and the pass that stood in for
 * it. Loaded when shown.
 */
import type { RunReusedResults } from '#shared/handlers/reused-results';

const props = defineProps<{ runId: number; projectKey?: number | null; projectName?: string | null }>();

const { data, status } = useFetch<RunReusedResults>(() => `/api/test-runs/${props.runId}/reused`, {
  server: false,
  lazy: true,
});
const loading = computed(() => status.value === 'idle' || status.value === 'pending');
</script>

<template>
  <div class="space-y-3" data-shot="run-reused-tests">
    <p class="text-sm text-highlighted leading-relaxed">
      An earlier pass ran the code of each of these tests, and the code had not changed since, so this run skipped them.
      The CI gate counts them as passed for its tag and selection rules when the run passed; the run's own status, pass
      rate and flaky scores read executions only.
    </p>
    <LoadingState v-if="loading && !data" />
    <EmptyState v-else-if="!data || data.items.length === 0" icon="i-lucide-recycle" text="No reused test recorded." />
    <template v-else>
      <ul class="divide-y divide-default">
        <li v-for="item in data.items" :key="item.testCaseId" class="py-2 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <NuxtLink :to="`/test-cases/${item.testCaseId}`" class="block text-sm text-primary hover:underline">
              {{ item.title }}
            </NuxtLink>
            <span class="block text-xs text-muted">
              <OpenInIdeLink :file-path="item.filePath" :project-key="projectKey" :project-name="projectName" inline />
              <span class="whitespace-nowrap"> · {{ item.projects.join(', ') }}</span>
            </span>
          </div>
          <span class="shrink-0 text-xs text-muted text-right">
            <NuxtLink
              v-if="item.sourceExecutionId"
              :to="`/test-run-cases/${item.sourceExecutionId}`"
              :class="SENTENCE_LINK_CLASS"
              >pass</NuxtLink
            >
            <template v-else>pass</template>
            at <span class="font-mono">{{ item.sourceCommit.slice(0, 7) }}</span>
            <span v-if="item.sourceStartedAt" class="block"><ClientDate :date="item.sourceStartedAt" date-only /></span>
          </span>
        </li>
      </ul>
      <p v-if="data.truncated" class="text-xs text-muted">
        The first {{ data.items.length }} of {{ data.count }} reused tests, by file and title.
      </p>
    </template>
  </div>
</template>

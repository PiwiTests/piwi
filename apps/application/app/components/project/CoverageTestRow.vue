<script setup lang="ts">
/**
 * One test on a file's coverage page: its latest outcome as a status dot, its
 * name linking to the test's page, and the outcome in words before its spec
 * file, which opens in the editor.
 */
import type { LocatorIndexTestStatus } from '#shared/locator-index';
import { statusPalette } from '~/utils/status-palette';

const props = defineProps<{
  test: { id: number; title: string; file: string; suite?: string[]; status: LocatorIndexTestStatus | null };
  projectId: number;
  projectName?: string | null;
}>();

const name = computed(() => [...(props.test.suite ?? []), props.test.title].join(' › '));
const outcome = computed(() => (props.test.status ? `Last run ${props.test.status}` : 'No outcome on this branch'));
</script>

<template>
  <div class="flex min-w-0 items-start gap-2">
    <span
      class="mt-1.5 size-2 shrink-0 rounded-full"
      :class="statusPalette(test.status).bg"
      :title="outcome"
      aria-hidden="true"
    />
    <div class="min-w-0">
      <NuxtLink
        :to="`/test-cases/${test.id}`"
        class="text-sm text-highlighted break-words"
        :class="SENTENCE_LINK_CLASS"
        title="The test's page: its history and latest execution"
        >{{ name }}</NuxtLink
      >
      <p class="text-xs text-muted break-words">
        <span data-test-outcome>{{ outcome }}</span> ·
        <OpenInIdeLink :file-path="test.file" :project-key="projectId" :project-name="projectName" />
      </p>
    </div>
  </div>
</template>

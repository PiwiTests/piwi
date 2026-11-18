<script setup lang="ts">
/** The tests a run's request asked for, folded under how many they are: each test's title, file, line and project. */
import type { RunnerRun } from '~/utils/runner-runs';

defineProps<{ run: RunnerRun; open?: boolean }>();
const words = useRunUiWords();
</script>

<template>
  <details :open="open" class="group" data-testid="runner-run-tests">
    <summary
      class="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs text-muted hover:text-default [&::-webkit-details-marker]:hidden"
    >
      <UIcon name="i-lucide-chevron-right" class="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
      <span class="font-medium">{{ words.tn('runui_tests', run.tests.length) }}</span>
    </summary>
    <ul class="space-y-1.5 px-4 pb-3 text-sm">
      <li v-for="test in run.tests" :key="`${test.filePath}:${test.line}:${test.projectName}`" class="min-w-0">
        <span class="text-highlighted">{{ test.title }}</span>
        <code class="block text-xs break-all text-muted"
          >{{ test.filePath }}{{ test.line ? `:${test.line}` : ''
          }}{{ test.projectName ? ` (${test.projectName})` : '' }}</code
        >
      </li>
    </ul>
  </details>
</template>

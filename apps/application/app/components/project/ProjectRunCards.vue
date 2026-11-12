<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui';
import type { TestRunSummary } from '~~/types/api';

/**
 * The runs list below `md`: one card per run, in place of the runs table. The
 * project page hydrates it only once it is visible, so a desktop screen never
 * builds it. A running run's card shows how far it is, from the counts the page
 * passes.
 */
defineProps<{
  runs: TestRunSummary[];
  selectedRunIds: number[];
  /** A run's overflow menu, as the table's row menu lists it. */
  menuItems: (run: TestRunSummary) => DropdownMenuItem[];
  /** Why an own run the filters leave out is listed ("Yours · partial run"), as the table's run cell says it. */
  ownMark?: (run: TestRunSummary) => string | null;
}>();

const emit = defineEmits<{ toggle: [runId: number] }>();
</script>

<template>
  <div class="space-y-2 md:hidden">
    <div v-for="run in runs" :key="run.id" class="rounded-lg border border-default p-3 space-y-2">
      <div class="flex items-start gap-2">
        <input
          type="checkbox"
          :checked="selectedRunIds.includes(run.id)"
          class="cursor-pointer size-4 mt-1 accent-primary shrink-0"
          :aria-label="`Select run #${run.id}`"
          @click.stop="emit('toggle', run.id)"
        />
        <NuxtLink :to="`/test-runs/${run.id}`" class="flex-1 min-w-0 space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <RunStatusBadge :status="run.status" />
            <span class="font-medium text-primary">Run #{{ run.id }}</span>
            <UIcon
              v-if="run.keptAt"
              name="i-lucide-lock"
              class="size-3.5 shrink-0 text-muted"
              :aria-label="`Run #${run.id} is kept forever`"
            />
            <EnvironmentBadge v-if="run.environment" :name="run.environment" class="text-xs text-muted" />
            <span v-if="ownMark?.(run)" class="text-xs text-muted" data-testid="own-run-mark">{{
              ownMark?.(run)
            }}</span>
          </div>
          <RunLiveProgress v-if="isLiveRun(run)" :run="run" />
          <TestStatusBar
            v-else
            :passed="run.passedTests"
            :failed="run.failedTests"
            :skipped="run.skippedTests"
            :fixme="run.fixmeTests ?? 0"
            :flaky="run.flakyTests"
            :did-not-run="run.didNotRunTests ?? 0"
            :interrupted="run.interruptedTests ?? 0"
            :total="run.totalTests"
          />
          <div class="flex items-center justify-between text-xs text-muted">
            <ClientDate :date="run.startTime" />
            <DurationValue v-if="!isLiveRun(run)" :ms="run.duration" />
          </div>
        </NuxtLink>
        <RunActionsMenu :label="`Run #${run.id} actions`" :items="() => menuItems(run)" />
      </div>
    </div>
  </div>
</template>

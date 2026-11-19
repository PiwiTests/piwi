<script setup lang="ts">
/**
 * A run that ended, as a row of the Finished list: how it ended, its name, its project, when it started and how long
 * it took, and its number and page on the instance (**Run #78 · Open**) once its process named them. A click on the row
 * shows the tests and the output (`RunnerRunOutput`, open on its own when the run failed), each as the person left it
 * on the run's card. A run that ended a moment ago comes in open.
 */
import type { RunnerRun } from '~/utils/runner-runs';

const props = defineProps<{ run: RunnerRun }>();

/** How long after its end a run's row comes in open. */
const OPEN_AFTER_END_MS = 10_000;

const { status, name, details } = useRunnerRunView(() => props.run);
const disclosures = useRunnerDisclosures();
const endedJustNow = Date.now() - (props.run.endedAt ?? 0) < OPEN_AFTER_END_MS;
const id = computed(() => `row:${props.run.key}`);
const open = computed(() => disclosures.isOpen(id.value, endedJustNow));
const hasMore = computed(() => props.run.tests.length > 0 || props.run.lines.length > 0);

function toggle() {
  if (hasMore.value) disclosures.choose(id.value, !open.value);
}
</script>

<template>
  <li data-testid="runner-run" :data-status="run.status">
    <div
      :class="['flex items-start gap-3 px-4 py-3', hasMore && 'cursor-pointer hover:bg-elevated/50']"
      @click="toggle"
    >
      <span :class="['flex size-8 shrink-0 items-center justify-center rounded-full', status.mark]" aria-hidden="true">
        <UIcon :name="status.icon" class="size-4.5" />
      </span>
      <div class="min-w-0 flex-1">
        <button
          type="button"
          class="max-w-full rounded text-left text-sm font-medium break-words text-highlighted focus-visible:outline-2 focus-visible:outline-primary"
          :aria-expanded="hasMore ? open : undefined"
          @click.stop="toggle"
        >
          {{ name }}
        </button>
        <p class="text-xs text-muted">
          <span :class="['font-medium', status.text]">{{ status.words }}</span>
          <span aria-hidden="true">{{ ' · ' }}</span>
          <span>{{ details.join(' · ') }}</span>
        </p>
      </div>
      <div v-if="run.page" class="shrink-0 pt-0.5" @click.stop>
        <DesktopRunPageLink :page="run.page" />
      </div>
      <UIcon
        v-if="hasMore"
        name="i-lucide-chevron-down"
        :class="['mt-1 size-4 shrink-0 text-muted transition-transform', open && 'rotate-180']"
        aria-hidden="true"
      />
    </div>
    <div v-if="open && hasMore" class="divide-y divide-default border-t border-default bg-muted/40">
      <RunnerRunTests v-if="run.tests.length" :run="run" />
      <RunnerRunOutput v-if="run.lines.length" :run="run" />
    </div>
  </li>
</template>

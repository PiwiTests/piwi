<script setup lang="ts">
/**
 * The block a project page opens on: the project's name, its description with
 * its tags beside it, then where it stands within the page's filters, one
 * labelled line per tab it summarizes. *Runs*: the latest run and the pass rate
 * of the last runs. *Failures*: the open clusters, the flaky tests and the
 * quarantined ones. Every figure that has a page is a link to it.
 */
import type { TagInfo, TestRunSummary } from '~~/types/api';

export type ProjectHeaderTarget = 'clusters' | 'flaky' | 'quarantine';

const props = defineProps<{
  title: string;
  description?: string | null;
  tags?: TagInfo[];
  /** The newest run within the filters; null when none matches them. */
  latestRun: TestRunSummary | null;
  /** The pass rate of the last `passRateRuns` runs within the filters, in percent. */
  passRate: number | null;
  passRateRuns: number;
  /** Whether the project has any run at all, filters aside. */
  hasRuns: boolean;
  /** The failure counts, or null while they load. */
  failures: { openClusters: number; flaky: number; quarantined: number | null } | null;
}>();

const emit = defineEmits<{ open: [target: ProjectHeaderTarget] }>();

/** The Failures tab segment each figure opens, as the `?tab=` alias that selects it. */
const TARGET_TABS: Record<ProjectHeaderTarget, string> = {
  clusters: 'failure-clusters',
  flaky: 'flaky-tests',
  quarantine: 'quarantine',
};

const LINK_CLASS = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const failureFigures = computed(() => {
  const f = props.failures;
  if (!f) return [];
  const figures: { target: ProjectHeaderTarget; text: string; tone: string }[] = [];
  if (f.openClusters > 0)
    figures.push({
      target: 'clusters',
      text: plural(f.openClusters, 'open cluster', 'open clusters'),
      tone: STATUS_PALETTE.failed.text,
    });
  if (f.flaky > 0)
    figures.push({
      target: 'flaky',
      text: plural(f.flaky, 'flaky test', 'flaky tests'),
      tone: STATUS_PALETTE.flaky.text,
    });
  if (f.quarantined) figures.push({ target: 'quarantine', text: `${f.quarantined} quarantined`, tone: '' });
  return figures;
});
</script>

<template>
  <div
    class="rounded-lg border border-default bg-default p-3 sm:p-4 max-sm:rounded-none max-sm:border-x-0"
    data-shot="project-header"
    data-tour="project-header"
  >
    <div class="flex items-start justify-between gap-2">
      <h1 class="min-w-0 break-words text-lg sm:text-xl font-semibold text-highlighted">{{ title }}</h1>
      <HelpHint topic="project.status" class="shrink-0" />
    </div>
    <p v-if="description || tags?.length" class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
      <span v-if="description">{{ description }}</span>
      <TagBadge v-for="tag in tags" :key="tag.id" :text="tag.text" :color="tag.color" />
    </p>

    <dl
      v-if="hasRuns"
      class="mt-3 grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-x-4"
      data-testid="project-state"
    >
      <dt class="font-semibold text-highlighted max-sm:-mb-1.5">Runs</dt>
      <dd class="min-w-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-highlighted">
        <template v-if="latestRun">
          <RunStatusBadge :status="latestRun.status" />
          <NuxtLink :to="`/test-runs/${latestRun.id}`" :class="LINK_CLASS">Latest run #{{ latestRun.id }}</NuxtLink>
          <span class="text-muted">{{ formatRelativeTime(latestRun.startTime) }}</span>
          <template v-if="passRate !== null">
            <span class="text-muted" aria-hidden="true">·</span>
            <span>
              <span class="tabular-nums font-medium" :class="passRateTextClass(passRate)">{{ passRate }}%</span>
              pass rate over the last {{ passRateRuns === 1 ? 'run' : `${passRateRuns} runs` }}
            </span>
          </template>
        </template>
        <span v-else class="text-muted">No run matches the filters</span>
      </dd>

      <dt class="font-semibold text-highlighted max-sm:-mb-1.5">Failures</dt>
      <dd class="min-w-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-highlighted">
        <span v-if="!failures" class="text-muted">Counting…</span>
        <span v-else-if="failureFigures.length === 0" class="text-muted">Nothing open</span>
        <template v-else>
          <template v-for="(figure, i) in failureFigures" :key="figure.target">
            <span v-if="i > 0" class="text-muted" aria-hidden="true">·</span>
            <a
              :href="`?tab=${TARGET_TABS[figure.target]}`"
              class="tabular-nums"
              :class="[LINK_CLASS, figure.tone]"
              @click.prevent="emit('open', figure.target)"
            >
              {{ figure.text }}
            </a>
          </template>
        </template>
      </dd>
    </dl>
  </div>
</template>

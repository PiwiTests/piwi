<script setup lang="ts">
/**
 * The pass reuse forecast of a project: how much of its recent test time ran
 * code identical to an earlier pass, on the default branch and on the others,
 * and the tests that failed anyway with their code unchanged.
 */
import type { ReuseForecast } from '#shared/handlers/reuse-forecast';
import type { ReuseScope, ReuseScopeForecast } from '#shared/reuse-forecast';

const props = defineProps<{ projectId: string | number }>();

const { data: forecast, status } = useFetch<ReuseForecast>(
  () => `/api/projects/${props.projectId}/selections/reuse-forecast`,
  { server: false, lazy: true },
);

const SCOPE_LABELS: Record<ReuseScope, string> = {
  'default-branch': 'Default branch',
  'other-branches': 'Other branches',
};

function share(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const pct = (part / whole) * 100;
  return `${pct > 0 && pct < 1 ? '<1' : Math.round(pct)}%`;
}

function scopeHint(scope: ReuseScopeForecast): string {
  const parts = [
    `${scope.reusable} of ${scope.results} results`,
    `${formatLongDuration(scope.reusableDurationMs)} saved`,
  ];
  if (scope.failed + scope.flaky > 0) parts.push(`${scope.failed} failed, ${scope.flaky} retried`);
  return parts.join(' · ');
}

const loading = computed(() => status.value === 'idle' || status.value === 'pending');
const total = computed(() => forecast.value?.total ?? null);
const hasComparable = computed(() => (total.value?.comparable ?? 0) > 0);
const uncomparable = computed(() => (total.value ? total.value.results - total.value.comparable : 0));
const scopes = computed(() => (forecast.value?.scopes ?? []).filter((s) => s.results > 0));
</script>

<template>
  <SectionCard
    title="Pass reuse forecast"
    icon="i-lucide-recycle"
    :subtitle="`The test time of the ${forecast?.windowDays ?? 30} days before the latest run that ran code identical to an earlier first-attempt pass, at most ${forecast?.maxSourceAgeDays ?? 14} days old: what a run could have skipped.`"
    data-shot="reuse-forecast"
  >
    <LoadingState v-if="loading && !forecast" />
    <EmptyState v-else-if="!total || total.results === 0" icon="i-lucide-recycle" text="No test results to read yet." />
    <EmptyState
      v-else-if="!hasComparable"
      icon="i-lucide-recycle"
      text="No result recorded coverage with file versions."
    >
      <p class="text-xs text-muted max-w-sm">
        Set <code>coverage.browser: 'functions'</code> in the reporter's options, or record
        <DocLink to="features/server-coverage" no-icon :class="SENTENCE_LINK_CLASS">server coverage</DocLink>, to see
        what a run could skip.
      </p>
    </EmptyState>
    <div v-else class="space-y-4">
      <StatTileGrid v-if="scopes.length > 1">
        <StatTile
          v-for="scope in scopes"
          :key="scope.scope"
          :label="
            scope.scope === 'default-branch' && forecast?.defaultBranch
              ? `${SCOPE_LABELS[scope.scope]} (${forecast.defaultBranch})`
              : SCOPE_LABELS[scope.scope]
          "
          :value="share(scope.reusableDurationMs, scope.durationMs)"
          :hint="scopeHint(scope)"
        />
      </StatTileGrid>

      <div class="space-y-1">
        <p class="text-sm text-highlighted leading-relaxed">
          {{ share(total.reusableDurationMs, total.durationMs) }} of the test time (<span
            :title="`${total.reusableDurationMs} ms`"
            >{{ formatLongDuration(total.reusableDurationMs) }}</span
          >
          of <span :title="`${total.durationMs} ms`">{{ formatLongDuration(total.durationMs) }}</span
          >) ran code identical to an earlier pass.
          <template v-if="total.failed + total.flaky === 0">None of those results failed.</template>
          <template v-else>
            Of those results, {{ total.failed }} failed and {{ total.flaky }} passed only on a retry: reuse would have
            skipped them.
          </template>
        </p>
        <p class="text-xs text-muted">
          Results from <ClientDate :date="forecast!.from" date-only /> to <ClientDate :date="forecast!.to" date-only />.
          An upper bound: the comparison covers the application files coverage records, not test code or configuration.
          <template v-if="uncomparable > 0">
            {{ uncomparable }} of {{ total.results }} results recorded no coverage with file versions and count as run.
          </template>
          <template v-if="forecast?.truncated"
            >The project has more results than the forecast reads at once, so it covers the most recent runs
            only.</template
          >
        </p>
      </div>

      <div v-if="forecast && forecast.tests.length > 0" class="space-y-1">
        <p class="text-sm font-semibold text-highlighted">Failed or retried with the code unchanged</p>
        <p class="text-xs text-muted">
          These tests ran code identical to an earlier pass, so the test, its data or its environment caused the failed
          attempt.
        </p>
        <ul class="divide-y divide-default">
          <li
            v-for="test in forecast.tests"
            :key="`${test.testCaseId}-${test.browserName}`"
            class="py-1.5 flex items-start justify-between gap-3"
          >
            <div class="min-w-0">
              <NuxtLink
                :to="`/test-run-cases/${test.lastExecutionId}`"
                class="block text-sm text-primary hover:underline"
              >
                {{ test.title }}
              </NuxtLink>
              <span class="block text-xs text-muted">
                <OpenInIdeLink :file-path="test.filePath" :project-key="projectId" inline />
                <span v-if="test.browserName" class="whitespace-nowrap"> · {{ test.browserName }}</span>
              </span>
            </div>
            <span class="shrink-0 text-xs text-muted text-right">
              {{
                [test.failed ? `${test.failed} failed` : '', test.flaky ? `${test.flaky} retried` : '']
                  .filter(Boolean)
                  .join(', ')
              }}
              <NuxtLink :to="`/test-run-cases/${test.sourceExecutionId}`" :class="['block', SENTENCE_LINK_CLASS]">
                matched pass
              </NuxtLink>
            </span>
          </li>
        </ul>
        <p v-if="forecast.moreTests > 0" class="text-xs text-muted">+{{ forecast.moreTests }} more tests</p>
      </div>
    </div>
  </SectionCard>
</template>

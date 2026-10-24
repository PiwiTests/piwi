<script setup lang="ts">
/**
 * What differs between this run and one baseline: the tests that started or
 * stopped failing, the ones that got slower or faster, the commits landed since
 * the baseline and the environment fields that moved. Every section reads the
 * same baseline — the automatic choice (same environment, then same branch,
 * then the base branch, then any; the last failed run when no earlier full run
 * passed), the base branch `?baseBranch=<name>` names, or the run
 * `?baseline=<runId>` names — so the "new failures" count is computed once and
 * reused everywhere. The selector says which run it is and why it was chosen.
 */
import { computed, ref, watch } from 'vue';
import type { TestRunDetails, TestCaseResult, RunClusterMeta } from '~~/types/api';
import type { RunInsightsResult } from '#shared/handlers/run-insights';
import { describeRunBaselineParts, type RunBaselinePart } from '#shared/run-baseline';

const props = defineProps<{
  testRun: TestRunDetails | null | undefined;
  /** This run's executions, so each changed test renders as a full TestRow. */
  testCases: TestCaseResult[];
  /** Resolved cluster names for the row chips. */
  clusterMeta?: RunClusterMeta;
  projectKey?: string | number | null;
  projectName?: string | null;
  /** Increments when the run finishes so this tab can refetch. */
  refreshKey?: number;
}>();

const route = useRoute();
const router = useRouter();
const runId = Number(route.params.id);
const { copy, copied } = useCopy();

const isLive = computed(() => props.testRun?.status === 'running' || props.testRun?.status === 'finalizing');

// The explicit baseline run the URL asks for, or null for the automatic choice.
const baselineId = computed<number | null>(() => {
  const raw = route.query.baseline;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
});

// The base branch the URL asks for: the baseline then comes from that branch only.
const baseBranch = computed<string | null>(() => {
  const raw = route.query.baseBranch;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
});

const data = ref<RunInsightsResult | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load() {
  if (!runId || isLive.value) {
    data.value = null;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const params = new URLSearchParams();
    if (baselineId.value != null) params.set('baseline', String(baselineId.value));
    else if (baseBranch.value) params.set('baseBranch', baseBranch.value);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    data.value = await $fetch<RunInsightsResult>(`/api/test-runs/${runId}/insights${query}`);
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || 'Failed to load changes';
  } finally {
    loading.value = false;
  }
}

watch([() => props.testRun?.id, baselineId, baseBranch, () => props.refreshKey], load, { immediate: true });

// ── Baseline choice ─────────────────────────────────────────────────────────
// Picking a run and picking a base branch are exclusive: the URL carries one.
function selectBaseline(id: number | null) {
  const query = { ...route.query };
  delete query.baseBranch;
  if (id == null) delete query.baseline;
  else query.baseline = String(id);
  router.replace({ query });
}

function selectBaseBranch(name: string | null) {
  const query = { ...route.query };
  delete query.baseline;
  if (!name) delete query.baseBranch;
  else query.baseBranch = name;
  router.replace({ query });
}

// Without a baseline: the first finished run has nothing before it; otherwise
// the earlier runs exist but none was eligible, or the chosen branch had none.
const noBaselineTitle = computed(() =>
  data.value && !data.value.baseBranch && data.value.earlierRuns.length === 0
    ? 'No earlier run to compare with'
    : 'No baseline run found',
);

// Why this baseline, as parts, so branch and environment names carry their icon.
const noteParts = computed<RunBaselinePart[]>(() => {
  const d = data.value;
  if (!d?.hasBaseline || !d.baseline) return [];
  if (!d.baselineMatch) return [{ kind: 'text', text: d.baselineNote ?? 'The run you picked.' }];
  return describeRunBaselineParts({
    run: d.run,
    baseline: { branch: d.baseline.branch, environment: d.baseline.environment },
    match: d.baselineMatch,
    fallback: d.fallbackBranch,
  });
});

// ── Section data ─────────────────────────────────────────────────────────────
// Every changed test refers to an execution in this run, so its full row is in
// `testCases`; look it up by executionId to render a real TestRow.
const caseById = computed(() => {
  const map = new Map<number, TestCaseResult>();
  for (const tc of props.testCases) map.set(tc.executionId, tc);
  return map;
});

function rowsFor(entries: Array<{ executionId: number }> | undefined): TestCaseResult[] {
  if (!entries) return [];
  const seen = new Set<number>();
  const rows: TestCaseResult[] = [];
  for (const e of entries) {
    if (seen.has(e.executionId)) continue;
    const tc = caseById.value.get(e.executionId);
    if (tc) {
      seen.add(e.executionId);
      rows.push(tc);
    }
  }
  return rows;
}

const newFailureRows = computed(() => rowsFor(data.value?.newRegressions));
const fixedRows = computed(() => rowsFor(data.value?.recovered));
const stillFailingRows = computed(() => rowsFor(data.value?.recurrences));
// "Newly flaky" (was stable, now needs retries) and the wider "passed on retry"
// set share the same section; a test in both appears once.
const flakyRows = computed(() => rowsFor([...(data.value?.newFlaky ?? []), ...(data.value?.flakyOnRetry ?? [])]));

const hasDurationChanges = computed(
  () => (data.value?.mostRegressed.length ?? 0) > 0 || (data.value?.mostImproved.length ?? 0) > 0,
);

const hasAnyChange = computed(() => {
  const d = data.value;
  if (!d) return false;
  return (
    newFailureRows.value.length > 0 ||
    fixedRows.value.length > 0 ||
    stillFailingRows.value.length > 0 ||
    flakyRows.value.length > 0 ||
    hasDurationChanges.value ||
    d.commitRange != null ||
    d.metadataDiff.length > 0
  );
});

function clusterName(tc: TestCaseResult): string | null {
  return tc.failureClusterId != null ? (props.clusterMeta?.[tc.failureClusterId]?.name ?? null) : null;
}

function clusterIssue(tc: TestCaseResult) {
  return tc.failureClusterId != null ? (props.clusterMeta?.[tc.failureClusterId]?.issue ?? null) : null;
}
</script>

<template>
  <div class="p-4">
    <ErrorState v-if="error" :text="error" padded>
      <template #action>
        <UButton size="sm" @click="load">Retry</UButton>
      </template>
    </ErrorState>

    <LoadingState v-else-if="loading" padded />

    <EmptyState v-else-if="isLive" icon="i-lucide-loader-circle" text="Run in progress">
      <p class="text-sm text-muted max-w-sm text-center">Changes are available once the run finishes.</p>
    </EmptyState>

    <EmptyState
      v-else-if="!data?.hasBaseline"
      icon="i-lucide-git-compare-arrows"
      :text="noBaselineTitle"
      data-shot="run-changes-empty"
    >
      <p v-if="data?.baseBranch" class="text-sm text-muted max-w-sm text-center">
        No earlier full run on <BranchLabel :name="data.baseBranch" copyable /> passed or failed. Pick another base
        branch or a run, or go back to the automatic choice.
      </p>
      <p v-else-if="data && data.earlierRuns.length === 0" class="text-sm text-muted max-w-sm text-center">
        This is the first finished run in the project. The next run compares against it.
      </p>
      <p v-else class="text-sm text-muted max-w-sm text-center">
        No earlier full run passed or failed, so none was picked automatically. Pick one of the earlier runs to compare
        with.
      </p>
      <RunBaselinePicker
        v-if="data"
        class="justify-center mt-2 max-w-xl"
        :insights="data"
        :base-branch="baseBranch"
        @select-run="selectBaseline"
        @select-base-branch="selectBaseBranch"
      />
    </EmptyState>

    <div v-else class="space-y-6" data-shot="run-changes">
      <!-- Baseline: which run, why, and the two ways to pick another -->
      <div class="space-y-2" data-shot="run-changes-baseline">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span class="text-muted inline-flex items-center gap-1">Compared with <HelpHint topic="run.changes" /></span>
          <NuxtLink
            :to="`/test-runs/${data.baseline!.id}`"
            class="font-medium text-primary hover:underline inline-flex items-center gap-1"
          >
            <RunStatusBadge :status="data.baseline!.status" />
            Run #{{ data.baseline!.id }}
          </NuxtLink>
          <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <BranchLabel :name="data.baseline!.branch" copyable />
            <EnvironmentBadge :name="data.baseline!.environment" />
            <span>{{ formatRelativeTime(data.baseline!.startTime) }}</span>
          </span>
        </div>
        <p class="text-xs text-muted leading-6">
          <template v-for="(part, i) in noteParts" :key="i">
            <BranchLabel v-if="part.kind === 'branch'" :name="part.name" copyable />
            <EnvironmentBadge v-else-if="part.kind === 'environment'" :name="part.name" inline />
            <template v-else>{{ part.text }}</template>
          </template>
          <template v-if="data.run.branch || data.run.environment">
            This run is on <BranchLabel :name="data.run.branch" copyable /> in
            <EnvironmentBadge :name="data.run.environment" inline />.
          </template>
        </p>
        <RunBaselinePicker
          :insights="data"
          :base-branch="baseBranch"
          @select-run="selectBaseline"
          @select-base-branch="selectBaseBranch"
        />
      </div>

      <EmptyState v-if="!hasAnyChange" icon="i-lucide-equal" text="No changes against the baseline">
        <p class="text-sm text-muted max-w-sm text-center">
          The same tests passed and failed, at the same durations, with no commits or environment changes recorded
          between the two runs.
        </p>
      </EmptyState>

      <!-- New failures -->
      <SectionCard
        v-if="newFailureRows.length > 0"
        icon="i-lucide-alert-circle"
        :icon-class="STATUS_PALETTE.failed.text"
        title="New failures"
        :count="data.newFailures"
        subtitle="Passed in the baseline, failing here"
      >
        <div class="-m-4">
          <TestRow
            v-for="tc in newFailureRows"
            :key="tc.executionId"
            :test-case="tc"
            :cluster-name="clusterName(tc)"
            :issue="clusterIssue(tc)"
            :project-key="projectKey"
            :project-name="projectName"
          />
        </div>
      </SectionCard>

      <!-- Fixed -->
      <SectionCard
        v-if="fixedRows.length > 0"
        icon="i-lucide-check-circle"
        :icon-class="STATUS_PALETTE.passed.text"
        title="Fixed"
        :count="fixedRows.length"
        subtitle="Failed in the baseline, passing here"
      >
        <div class="-m-4">
          <TestRow
            v-for="tc in fixedRows"
            :key="tc.executionId"
            :test-case="tc"
            :cluster-name="clusterName(tc)"
            :issue="clusterIssue(tc)"
            :project-key="projectKey"
            :project-name="projectName"
          />
        </div>
      </SectionCard>

      <!-- Still failing -->
      <SectionCard
        v-if="stillFailingRows.length > 0"
        icon="i-lucide-refresh-cw"
        :icon-class="STATUS_PALETTE.failed.text"
        title="Still failing"
        :count="stillFailingRows.length"
        subtitle="Failing in both the baseline and this run"
      >
        <div class="-m-4">
          <TestRow
            v-for="tc in stillFailingRows"
            :key="tc.executionId"
            :test-case="tc"
            :cluster-name="clusterName(tc)"
            :issue="clusterIssue(tc)"
            :project-key="projectKey"
            :project-name="projectName"
          />
        </div>
      </SectionCard>

      <!-- Newly flaky / passed on retry -->
      <SectionCard
        v-if="flakyRows.length > 0"
        icon="i-lucide-flask-conical"
        :icon-class="STATUS_PALETTE.flaky.text"
        title="Newly flaky / passed on retry"
        :count="flakyRows.length"
        subtitle="Passed, but needed a retry"
      >
        <div class="-m-4">
          <TestRow
            v-for="tc in flakyRows"
            :key="tc.executionId"
            :test-case="tc"
            :cluster-name="clusterName(tc)"
            :issue="clusterIssue(tc)"
            :project-key="projectKey"
            :project-name="projectName"
          />
        </div>
      </SectionCard>

      <!-- Slower / faster -->
      <SectionCard
        v-if="hasDurationChanges"
        icon="i-lucide-gauge"
        icon-class="text-blue-500"
        title="Slower / faster"
        subtitle="Duration change on tests that passed in both runs"
      >
        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
          <div v-if="data.mostRegressed.length > 0">
            <p class="text-xs font-medium text-red-500 mb-2">Slower</p>
            <div class="divide-y divide-default">
              <NuxtLink
                v-for="r in data.mostRegressed"
                :key="r.executionId"
                :to="`/test-run-cases/${r.executionId}?evidence=performance`"
                class="flex items-center gap-2 py-1.5 text-sm hover:bg-elevated/50 rounded px-1 -mx-1"
              >
                <span class="text-red-500 font-mono shrink-0 tabular-nums">+{{ r.pctChange }}%</span>
                <span class="truncate text-highlighted hover:underline min-w-0">{{ r.title }}</span>
                <span class="ml-auto shrink-0 text-xs text-muted tabular-nums">
                  <DurationValue :ms="r.durationBefore" /> → <DurationValue :ms="r.durationAfter" />
                </span>
              </NuxtLink>
            </div>
          </div>
          <div v-if="data.mostImproved.length > 0">
            <p class="text-xs font-medium text-green-600 mb-2">Faster</p>
            <div class="divide-y divide-default">
              <NuxtLink
                v-for="i in data.mostImproved"
                :key="i.executionId"
                :to="`/test-run-cases/${i.executionId}?evidence=performance`"
                class="flex items-center gap-2 py-1.5 text-sm hover:bg-elevated/50 rounded px-1 -mx-1"
              >
                <span class="text-green-600 font-mono shrink-0 tabular-nums">{{ i.pctChange }}%</span>
                <span class="truncate text-highlighted hover:underline min-w-0">{{ i.title }}</span>
                <span class="ml-auto shrink-0 text-xs text-muted tabular-nums">
                  <DurationValue :ms="i.durationBefore" /> → <DurationValue :ms="i.durationAfter" />
                </span>
              </NuxtLink>
            </div>
          </div>
        </div>
      </SectionCard>

      <!-- Commits since the baseline -->
      <SectionCard
        v-if="data.commitRange"
        icon="i-lucide-git-commit-horizontal"
        icon-class="text-gray-500"
        title="Commits since the baseline"
      >
        <div class="space-y-3">
          <div class="flex flex-wrap items-center gap-2 text-sm font-mono">
            <UBadge color="success" variant="soft" size="sm">{{ data.commitRange.fromShort }}</UBadge>
            <UIcon name="i-lucide-arrow-right" class="size-3 text-muted" />
            <UBadge color="error" variant="soft" size="sm">{{ data.commitRange.toShort }}</UBadge>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              v-if="data.commitRange.compareUrl"
              :to="data.commitRange.compareUrl"
              target="_blank"
              external
              icon="i-lucide-external-link"
              size="sm"
              variant="soft"
              color="primary"
              label="View commits"
            />
            <div class="flex items-center gap-1.5 flex-1 min-w-0">
              <code class="flex-1 text-xs bg-elevated px-3 py-1.5 rounded font-mono truncate select-all">{{
                data.commitRange.gitCommand
              }}</code>
              <UButton
                :icon="copied ? 'i-lucide-check' : 'i-lucide-clipboard'"
                size="xs"
                color="neutral"
                variant="ghost"
                :title="copied ? 'Copied' : 'Copy git command'"
                @click="copy(data.commitRange.gitCommand)"
              />
            </div>
          </div>
        </div>
      </SectionCard>

      <!-- Environment changes -->
      <SectionCard
        v-if="data.metadataDiff.length > 0"
        icon="i-lucide-sliders-horizontal"
        icon-class="text-gray-500"
        title="Environment changes"
      >
        <TableScroller min-width="32rem" :bleed="false">
          <table class="w-full min-w-[32rem] text-sm">
            <thead>
              <tr class="text-xs text-muted uppercase tracking-wider border-b border-default">
                <th class="text-left px-3 py-2 font-medium w-32">Field</th>
                <th class="text-left px-3 py-2 font-medium">This run</th>
                <th class="text-left px-3 py-2 font-medium">Baseline</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in data.metadataDiff" :key="entry.key" class="border-b last:border-b-0 border-default">
                <td class="px-3 py-2 text-muted">{{ entry.label }}</td>
                <td class="px-3 py-2 font-mono text-xs">
                  <span v-if="entry.after" class="text-red-700 dark:text-red-400">{{ entry.after }}</span>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="px-3 py-2 font-mono text-xs">
                  <span v-if="entry.before" class="text-green-700 dark:text-green-400">{{ entry.before }}</span>
                  <span v-else class="text-muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroller>
      </SectionCard>
    </div>
  </div>
</template>

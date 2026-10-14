<script setup lang="ts">
import type { ApiResponse, FlakyTest, VerifiedFixedFlakyTest } from '~~/types/api';
import type { TopFlakeSuspect } from '#shared/handlers/flake-profile';
import type { FlakeLabSummary } from '#shared/handlers/flake-lab';
import { buildTestRowBadges } from '~/utils/test-row-badges';
import { projectRunScopeQuery, type ProjectRunScope } from '#shared/project-run-scope';

const props = defineProps<{
  projectId: string | number;
  /** The project page's run scope: the analysis reads its runs. */
  scope?: ProjectRunScope | null;
  /** Piwi project name, threaded so the IDE opener can default the JetBrains project. */
  projectName?: string | null;
}>();

const emit = defineEmits<{ count: [total: number]; quarantined: [] }>();

const toast = useToast();
// Quarantining and dismissing a proposal need `quarantine:write` on the project.
const { can } = useAuth();
const canQuarantine = computed(() => can('quarantine:write', props.projectId));
const quarantiningId = ref<number | null>(null);

const runsWindow = ref(50);
const rootCauseFilter = ref<string[]>([]);

const { data: flaky, status } = await useFetch(
  () => {
    const params = new URLSearchParams({
      runs: String(runsWindow.value),
      ...(props.scope ? projectRunScopeQuery(props.scope) : {}),
    });
    return `/api/projects/${props.projectId}/flaky-tests?${params.toString()}`;
  },
  {
    lazy: true,
    server: false,
    transform: (r: { items: FlakyTest[]; verifiedFixed?: VerifiedFixedFlakyTest[] }) => r,
  },
);
const tests = computed(() => flaky.value?.items ?? null);
/** Tests a verified fix took off the ranking; they return to it at their next retry-pass. */
const verifiedFixed = computed(() => flaky.value?.verifiedFixed ?? []);
// The server renders before the client-only fetch starts (`idle`), so idle reads as loading too.
const loading = computed(() => status.value === 'idle' || status.value === 'pending');

const filteredTests = computed(() => {
  if (rootCauseFilter.value.length === 0) return tests.value ?? [];
  return (tests.value ?? []).filter((t) => rootCauseFilter.value.includes(t.rootCause ?? ''));
});

watch(tests, (list) => emit('count', list?.length ?? 0));

// The top suspect of each listed test and its latest Flake Lab result, read
// after the list so the list never waits on them. Hidden when the project
// declines flake suspects.
const { isHidden: capabilityHidden } = await useProjectCapabilities(Number(props.projectId));
const topSuspects = ref(new Map<number, TopFlakeSuspect & { lab: FlakeLabSummary | null }>());
watch(
  tests,
  async (list) => {
    if (!list?.length || capabilityHidden('flake-lab')) return;
    const ids = list.map((t) => t.testCaseId).join(',');
    try {
      const res = await $fetch<{ items: Array<TopFlakeSuspect & { lab: FlakeLabSummary | null }> }>(
        `/api/projects/${props.projectId}/flake-suspects?testCaseIds=${ids}`,
      );
      topSuspects.value = new Map(res.items.map((item) => [item.testCaseId, item]));
    } catch {
      // The column is optional; the list reads the same without it.
    }
  },
  { immediate: true },
);

// Piwi's quarantine proposals among the listed tests, read after the list so the
// list never waits on them. A proposal dismissed since the newest run is not marked.
type QuarantineResponse = ApiResponse<typeof import('~~/server/api/projects/[id]/quarantine.get').default>;
const proposals = ref(new Map<number, QuarantineResponse['candidates'][number]>());

async function loadProposals() {
  if (capabilityHidden('quarantine')) return;
  try {
    const res = await $fetch<QuarantineResponse>(`/api/projects/${props.projectId}/quarantine`);
    proposals.value = new Map(res.candidates.filter((c) => !c.dismissed).map((c) => [c.testCaseId, c]));
  } catch {
    // The proposals are optional; the list reads the same without them.
  }
}

watch(
  tests,
  (list) => {
    if (list?.length) loadProposals();
  },
  { immediate: true },
);

/** The latest Flake Lab experiment, when it reproduced the test. */
function reproducedBy(testCaseId: number): FlakeLabSummary | null {
  const lab = topSuspects.value.get(testCaseId)?.lab;
  return lab?.verdict === 'reproduced' ? lab : null;
}

function suspectLink(testCaseId: number, suspectId: string): string {
  return `/test-cases/${testCaseId}?tab=flakiness&suspect=${encodeURIComponent(suspectId)}`;
}

async function quarantineTest(test: FlakyTest) {
  quarantiningId.value = test.testCaseId;
  // Quarantining a proposed test applies Piwi's proposal, with its reasons.
  const proposal = proposals.value.get(test.testCaseId);
  try {
    await $fetch(`/api/projects/${props.projectId}/quarantine`, {
      method: 'POST',
      body: proposal
        ? { testCaseId: test.testCaseId, reason: proposal.rationale, source: 'proposed' }
        : { testCaseId: test.testCaseId, reason: 'Flaky', source: 'manual' },
    });
    toast.add({ title: 'Test quarantined', description: test.title, color: 'success' });
    if (proposal) {
      const next = new Map(proposals.value);
      next.delete(test.testCaseId);
      proposals.value = next;
    }
    emit('quarantined');
  } catch (error: unknown) {
    const message =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({ title: 'Quarantine failed', description: message || 'An error occurred', color: 'error' });
  } finally {
    quarantiningId.value = null;
  }
}

function scoreColor(score: number): 'error' | 'warning' | 'neutral' {
  if (score >= 60) return 'error';
  if (score >= 30) return 'warning';
  return 'neutral';
}

function rootCauseColor(cause: string | null): string {
  switch (cause) {
    case 'timing':
      return 'amber';
    case 'network':
      return 'red';
    case 'assertion':
      return 'blue';
    case 'environment':
      return 'purple';
    case 'order':
      return 'teal';
    default:
      return 'gray';
  }
}

function toggleRootCauseFilter(cause: string) {
  const idx = rootCauseFilter.value.indexOf(cause);
  if (idx >= 0) {
    rootCauseFilter.value = rootCauseFilter.value.filter((c) => c !== cause);
  } else {
    rootCauseFilter.value = [...rootCauseFilter.value, cause];
  }
}

const ROOT_CAUSE_OPTIONS = [
  { label: 'Timing', value: 'timing' },
  { label: 'Network', value: 'network' },
  { label: 'Assertion', value: 'assertion' },
  { label: 'Environment', value: 'environment' },
  { label: 'Order', value: 'order' },
  { label: 'Other', value: 'other' },
];

function impactDotClass(wastedCiMinutes: number): string {
  if (wastedCiMinutes >= 30) return 'bg-red-500';
  if (wastedCiMinutes >= 5) return 'bg-amber-500';
  return 'bg-green-500';
}

/** Tags and ownership metadata rendered as the row's badges. */
function flakyBadges(test: FlakyTest) {
  return buildTestRowBadges({
    tags: test.tags,
    meta: { owner: test.owner ?? undefined, priority: toTestPriority(test.priority) },
  });
}
</script>

<template>
  <UCard data-shot="flaky-table">
    <template #header>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <p class="text-sm text-gray-500 inline-flex items-center gap-1">
            Tests that fail intermittently — detected by retry passes and status alternations
            <HelpHint topic="project.flaky-tests" />
          </p>
          <div class="flex items-center gap-1.5">
            <UButton
              v-for="opt in ROOT_CAUSE_OPTIONS"
              :key="opt.value"
              size="xs"
              :variant="rootCauseFilter.includes(opt.value) ? 'solid' : 'outline'"
              :color="rootCauseFilter.includes(opt.value) ? 'neutral' : 'neutral'"
              @click="toggleRootCauseFilter(opt.value)"
            >
              {{ opt.label }}
            </UButton>
          </div>
        </div>
        <USelect
          v-model="runsWindow"
          :items="[
            { label: 'Last 20 runs', value: 20 },
            { label: 'Last 50 runs', value: 50 },
            { label: 'Last 100 runs', value: 100 },
          ]"
          size="xs"
          class="w-36"
        />
      </div>
    </template>

    <LoadingState v-if="loading && filteredTests.length === 0" text="Loading flaky tests…" />

    <div v-else-if="filteredTests.length" class="rounded-lg border border-default overflow-hidden">
      <TestRow
        v-for="test in filteredTests"
        :key="test.testCaseId"
        :href="`/test-cases/${test.testCaseId}`"
        data-tour="flaky-test-row"
        :title="test.title"
        status="flaky"
        :file-path="test.filePath"
        :badges="flakyBadges(test)"
        :project-key="projectId"
        :project-name="projectName"
      >
        <template #metrics>
          <span
            class="inline-flex items-center gap-1 tabular-nums"
            :title="`${Math.round(test.wastedCiMinutes)} CI minutes wasted`"
          >
            <span class="inline-block size-2 rounded-full shrink-0" :class="impactDotClass(test.wastedCiMinutes)" />
            {{ Math.round(test.wastedCiMinutes) }} min
          </span>
          <UBadge :color="scoreColor(test.score)" variant="subtle" size="xs" title="Flaky score">
            {{ test.score }}
          </UBadge>
          <NuxtLink
            v-if="reproducedBy(test.testCaseId)"
            :to="`/test-cases/${test.testCaseId}?tab=flakiness`"
            :title="`Reproduced by ${reproducedBy(test.testCaseId)!.label ?? 'a Flake Lab arm'}`"
            data-testid="flaky-reproduced"
            @click.stop
          >
            <UBadge color="neutral" variant="outline" size="xs">Reproduced</UBadge>
          </NuxtLink>
          <span class="tabular-nums" title="Failure rate">{{ Math.round(test.failureRate * 100) }}% fail</span>
          <QuarantineDismissButton
            v-if="canQuarantine && proposals.has(test.testCaseId)"
            :project-id="projectId"
            :test-case-id="test.testCaseId"
            proposal="quarantine"
            @dismissed="loadProposals"
          />
          <UButton
            v-if="canQuarantine"
            size="xs"
            variant="outline"
            color="warning"
            icon="i-lucide-shield-alert"
            :loading="quarantiningId === test.testCaseId"
            @click="quarantineTest(test)"
          >
            Quarantine
          </UButton>
        </template>

        <template #subline>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span
              v-if="proposals.has(test.testCaseId)"
              :title="proposals.get(test.testCaseId)!.reasons.join('\n')"
              data-testid="flaky-quarantine-proposed"
            >
              Proposed for quarantine
            </span>
            <NuxtLink
              v-if="topSuspects.get(test.testCaseId)?.suspect"
              :to="suspectLink(test.testCaseId, topSuspects.get(test.testCaseId)!.suspect!.id)"
              class="min-w-0 break-words underline decoration-dotted underline-offset-2 hover:decoration-solid"
              :title="topSuspects.get(test.testCaseId)!.suspect!.sentence"
              data-testid="flaky-top-suspect"
              @click.stop
            >
              Top suspect: {{ topSuspects.get(test.testCaseId)!.suspect!.label }} ·
              <span class="tabular-nums"
                >{{ topSuspects.get(test.testCaseId)!.suspect!.counts.failuresWith }}/{{
                  topSuspects.get(test.testCaseId)!.suspect!.counts.failures
                }}
                failures</span
              >
            </NuxtLink>
            <TagBadge v-if="test.rootCause" :text="test.rootCause" :color="rootCauseColor(test.rootCause)" />
            <span v-if="test.retryPassRuns" class="tabular-nums">
              {{ test.retryPassRuns }} retry pass{{ test.retryPassRuns === 1 ? '' : 'es' }}
            </span>
            <span v-if="test.alternations >= 2" class="tabular-nums">{{ test.alternations }} flips</span>
            <span v-if="test.lastFlakeAt">Last flake {{ formatRelativeTime(test.lastFlakeAt) }}</span>
          </div>
        </template>
      </TestRow>
    </div>

    <p v-if="!loading && filteredTests.length === 0" class="text-sm text-gray-500 py-4 text-center">
      No flaky tests detected in the last {{ runsWindow }} runs.
    </p>

    <div v-if="verifiedFixed.length" class="mt-4 space-y-1.5" data-testid="flaky-verified-fixed">
      <p class="text-xs text-muted inline-flex items-center gap-1">
        <UIcon name="i-lucide-badge-check" class="size-3.5 text-success" />
        Verified fixed: off the ranking until they retry-pass again
      </p>
      <ul class="rounded-lg border border-default divide-y divide-default">
        <li
          v-for="test in verifiedFixed"
          :key="test.testCaseId"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
          data-testid="flaky-verified-row"
        >
          <NuxtLink
            :to="`/test-cases/${test.testCaseId}?tab=flakiness`"
            class="min-w-0 text-sm font-medium text-highlighted hover:underline break-words"
          >
            {{ test.title }}
          </NuxtLink>
          <span class="min-w-0 text-xs text-muted font-mono truncate">{{ test.filePath }}</span>
          <span class="flex-1" />
          <UBadge
            color="success"
            variant="soft"
            size="xs"
            :title="`Flake Lab verified the fix ${formatRelativeTime(test.verifiedFix.verifiedAt)}`"
            data-testid="flaky-verified-badge"
          >
            Verified fixed{{ test.verifiedFix.commit ? ` on ${test.verifiedFix.commit.slice(0, 7)}` : '' }}
          </UBadge>
          <span class="text-xs text-muted tabular-nums">
            {{ test.retryPassRuns }} retry pass{{ test.retryPassRuns === 1 ? '' : 'es' }} before it
          </span>
        </li>
      </ul>
    </div>
  </UCard>
</template>

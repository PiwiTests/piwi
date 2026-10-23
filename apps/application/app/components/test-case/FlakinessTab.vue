<script setup lang="ts">
/**
 * The Flakiness tab of a flaky test: the suspects its history points at, each
 * with the counts behind it (failures and passes showing the factor, out of
 * all), the condition a lab would apply to test it and its latest lab result;
 * then the factors with no condition, as context; then the Flake Lab
 * experiments run on the test and the commands that run more.
 *
 * Loaded from `/flake-profile` and `/flake-experiments` when the tab mounts
 * (under a `v-if`). The
 * `suspect` query parameter, set by a link from the Attempts diff, marks one
 * suspect and scrolls to it.
 */
import type { FlakeProfile, FlakeSuspect } from '#shared/handlers/flake-profile';
import {
  flakeCommand,
  flakeSuspectLabNote,
  flakeSuspectLabShort,
  latestSuspectResults,
  type FlakeExperimentRecord,
  type FlakeSuspectResult,
} from '#shared/flake-lab';
import type { VerifiedFix } from '#shared/handlers/flake-verified';
import { flakeVerdictWord } from '~/utils/flake-lab';

const props = defineProps<{ testCaseId: number; projectId?: number | null; projectLabel?: string | null }>();

const route = useRoute();
const profile = ref<FlakeProfile | null>(null);
const experiments = ref<FlakeExperimentRecord[]>([]);
/** The verify experiment that marks the test verified fixed, holding or not. */
const verifiedFix = ref<VerifiedFix | null>(null);
const loading = ref(true);
const failed = ref(false);

/** Re-read the experiments, when a lab session run from the desktop app ends. */
async function reloadExperiments() {
  try {
    const res = await $fetch<{ items: FlakeExperimentRecord[]; verifiedFix?: VerifiedFix | null }>(
      `/api/test-cases/${props.testCaseId}/flake-experiments`,
    );
    experiments.value = res.items;
    verifiedFix.value = res.verifiedFix ?? null;
  } catch {
    // The list stays as it was; the next visit reads it again.
  }
}

watch(
  () => props.testCaseId,
  async (id) => {
    loading.value = true;
    failed.value = false;
    const [p, e] = await Promise.allSettled([
      $fetch<FlakeProfile>(`/api/test-cases/${id}/flake-profile`),
      $fetch<{ items: FlakeExperimentRecord[]; verifiedFix?: VerifiedFix | null }>(
        `/api/test-cases/${id}/flake-experiments`,
      ),
    ]);
    if (p.status === 'fulfilled') profile.value = p.value;
    else failed.value = true;
    experiments.value = e.status === 'fulfilled' ? e.value.items : [];
    verifiedFix.value = e.status === 'fulfilled' ? (e.value.verifiedFix ?? null) : null;
    loading.value = false;
  },
  { immediate: true },
);

const results = computed(() => latestSuspectResults(experiments.value));
const reproduced = computed(() => experiments.value.some((e) => e.kind === 'reproduce' && e.verdict === 'reproduced'));

const { copy, copied } = useCopy();
const copiedCommand = ref<string | null>(null);
const reproduceCommand = computed(() => flakeCommand(props.testCaseId));
const verifyCommand = computed(() => flakeCommand(props.testCaseId, 'verify'));
async function copyCommand(command: string) {
  await copy(command, { toast: 'Command copied' });
  copiedCommand.value = command;
}

/** "reproduced 3 of 4 · 2 days ago", "not reproduced 0 of 10 (below 26%) · 2 days ago". */
function labLine(r: FlakeSuspectResult): string {
  const when = r.finishedAt ? ` · ${formatRelativeTime(r.finishedAt)}` : '';
  return `${flakeSuspectLabShort(r)}${when}`;
}

const summaryLine = computed(() => {
  const list = experiments.value;
  if (list.length === 0) return '';
  const last = list[0]!;
  const count = list.length === 1 ? '1 experiment' : `${list.length} experiments`;
  const commit = last.commit ? ` on ${last.commit.slice(0, 7)}` : '';
  return `${count} · last: ${flakeVerdictWord(last.verdict)}${commit}`;
});

const marked = computed(() => (typeof route.query.suspect === 'string' ? route.query.suspect : null));

// Scroll the marked suspect into view once the list renders.
watch(
  () => [profile.value, marked.value] as const,
  async ([p, id]) => {
    if (!p || !id || !import.meta.client) return;
    await nextTick();
    document.querySelector(`[data-suspect-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
  },
);

const windowLine = computed(() => {
  const p = profile.value;
  if (!p) return '';
  const attempts = p.attempts === 1 ? '1 attempt' : `${p.attempts} attempts`;
  return `${attempts} in the last ${p.windowDays} days: ${p.failures} failed, ${p.passes} passed`;
});

function detailLine(s: FlakeSuspect): string | null {
  const parts: string[] = [];
  if (s.sharedRoutes?.length) parts.push(`Both write ${s.sharedRoutes.join(', ')}`);
  if (s.approximate) parts.push('Overlap across shards, approximate: their clocks agree only roughly');
  return parts.length ? parts.join(' · ') : null;
}
</script>

<template>
  <div class="space-y-4" data-shot="flakiness-tab" data-tour="test-flakiness">
    <SectionCard
      icon="i-lucide-search-check"
      title="Suspects"
      help="case.flakiness"
      :subtitle="windowLine || undefined"
      data-tour="flake-suspects"
    >
      <LoadingState v-if="loading" text="Reading this test’s history…" />
      <ErrorState v-else-if="failed" text="Could not load the suspects." />
      <EmptyState
        v-else-if="profile && profile.suspects.length === 0"
        icon="i-lucide-search-x"
        :text="
          profile.failures < 3
            ? 'Fewer than 3 failures in this test’s window — too few to rank suspects.'
            : 'Nothing in this test’s history separates its failures from its passes.'
        "
      />

      <div v-else-if="profile" data-testid="flake-suspects">
        <!-- From md up the rows line up as columns; below it each row stacks. -->
        <div
          class="hidden md:grid md:grid-cols-[minmax(0,1fr)_5rem_5rem_9rem_11rem] gap-x-4 px-3 pb-2 text-xs text-muted"
          aria-hidden="true"
        >
          <span>Suspect</span>
          <span class="text-right">Failures</span>
          <span class="text-right">Passes</span>
          <span>Condition</span>
          <span>Lab</span>
        </div>
        <ol class="rounded-lg border border-default divide-y divide-default">
          <li
            v-for="(s, i) in profile.suspects"
            :key="s.id"
            :data-suspect-id="s.id"
            class="grid grid-cols-2 md:grid-cols-[minmax(0,1fr)_5rem_5rem_9rem_11rem] gap-x-4 gap-y-1 px-3 py-2.5"
            :class="marked === s.id ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''"
            data-testid="flake-suspect"
          >
            <div class="col-span-2 md:col-span-1 min-w-0 space-y-0.5">
              <p class="text-sm font-semibold text-highlighted break-words" :title="s.sentence">
                <span class="text-muted tabular-nums">{{ i + 1 }}</span>
                {{ s.label }}
              </p>
              <p v-if="detailLine(s)" class="text-xs text-muted break-words">{{ detailLine(s) }}</p>
            </div>
            <p
              class="text-sm text-highlighted tabular-nums md:text-right"
              :title="`${s.counts.failuresWith} of ${s.counts.failures} failures`"
            >
              <span class="md:hidden text-xs text-muted">Failures </span>{{ s.counts.failuresWith }}/{{
                s.counts.failures
              }}
            </p>
            <p
              class="text-sm text-highlighted tabular-nums md:text-right"
              :title="`${s.counts.passesWith} of ${s.counts.passes} passes`"
            >
              <span class="md:hidden text-xs text-muted">Passes </span>{{ s.counts.passesWith }}/{{ s.counts.passes }}
            </p>
            <p class="col-span-2 md:col-span-1 text-sm text-highlighted">
              <span class="md:hidden text-xs text-muted">Condition </span>{{ s.conditionLabel }}
            </p>
            <p
              class="col-span-2 md:col-span-1 text-sm text-highlighted tabular-nums"
              :title="flakeSuspectLabNote(results.get(s.id)) ?? undefined"
              data-testid="flake-suspect-lab"
            >
              <span class="md:hidden text-xs text-muted">Lab </span>
              <template v-if="results.get(s.id)">{{ labLine(results.get(s.id)!) }}</template>
              <span v-else class="text-muted">not tested</span>
            </p>
          </li>
        </ol>
      </div>
    </SectionCard>

    <SectionCard v-if="profile && profile.context.length && profile.failures > 0" icon="i-lucide-info" title="Context">
      <p class="text-xs text-muted mb-2">Factors a lab cannot apply, shown with the same counts.</p>
      <ul class="space-y-1" data-testid="flake-context">
        <li v-for="c in profile.context" :key="c.kind" class="text-sm text-highlighted">
          {{ c.label.charAt(0).toUpperCase() + c.label.slice(1) }}:
          <span class="tabular-nums">{{ c.counts.failuresWith }} of {{ c.counts.failures }} failures</span>,
          <span class="tabular-nums">{{ c.counts.passesWith }} of {{ c.counts.passes }} passes</span>
        </li>
      </ul>
    </SectionCard>

    <SectionCard
      icon="i-lucide-flask-conical"
      title="Experiments"
      help="case.flake-experiments"
      :subtitle="summaryLine || undefined"
      data-shot="flake-experiments"
    >
      <div class="space-y-3" data-testid="flake-experiments">
        <p
          v-if="verifiedFix"
          class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
          data-testid="flake-verified-fix"
          :data-holding="verifiedFix.flakedAgainAt ? 'false' : 'true'"
        >
          <UIcon
            :name="verifiedFix.flakedAgainAt ? 'i-lucide-rotate-ccw' : 'i-lucide-badge-check'"
            :class="verifiedFix.flakedAgainAt ? 'text-warning' : 'text-success'"
            class="size-4 shrink-0"
          />
          <template v-if="!verifiedFix.flakedAgainAt">
            <span class="font-medium text-highlighted"
              >Verified fixed<template v-if="verifiedFix.commit">
                on <span class="font-mono">{{ verifiedFix.commit.slice(0, 7) }}</span></template
              ></span
            >
            <span class="text-muted"
              >· {{ formatRelativeTime(verifiedFix.verifiedAt) }} · off the flaky ranking until it retry-passes
              again</span
            >
          </template>
          <template v-else>
            <span class="text-highlighted"
              >Verified fixed<template v-if="verifiedFix.commit">
                on <span class="font-mono">{{ verifiedFix.commit.slice(0, 7) }}</span></template
              >, then it retry-passed again {{ formatRelativeTime(verifiedFix.flakedAgainAt) }}</span
            >
            <span class="text-muted">· back on the flaky ranking</span>
          </template>
        </p>
        <p v-if="!loading && experiments.length === 0" class="text-sm text-highlighted leading-relaxed">
          None yet. Run the lab from the project root: it applies each suspect’s condition next to a control, with
          retries off, until the failure reproduces.
        </p>
        <ol v-else-if="experiments.length" class="rounded-lg border border-default divide-y divide-default">
          <FlakeExperimentRow v-for="e in experiments" :key="e.id" :experiment="e" />
        </ol>
        <div class="flex flex-wrap gap-2">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="copied && copiedCommand === reproduceCommand ? 'i-lucide-check' : 'i-lucide-clipboard'"
            :title="reproduceCommand"
            data-testid="copy-flake-command"
            @click="copyCommand(reproduceCommand)"
          >
            Copy command
          </UButton>
          <UButton
            v-if="reproduced"
            size="sm"
            color="neutral"
            variant="outline"
            :icon="copied && copiedCommand === verifyCommand ? 'i-lucide-check' : 'i-lucide-clipboard'"
            :title="verifyCommand"
            data-testid="copy-flake-verify-command"
            @click="copyCommand(verifyCommand)"
          >
            Copy verify command
          </UButton>
          <FlakeLabDesktopButton
            :test-case-id="testCaseId"
            :project-id="projectId ?? null"
            :project-label="projectLabel"
            :suspect-count="profile?.suspects.length ?? 0"
            @finished="reloadExperiments"
          />
        </div>
        <p class="text-xs text-muted font-mono break-all">
          {{ reproduced ? verifyCommand : reproduceCommand }}
        </p>
      </div>
    </SectionCard>
  </div>
</template>

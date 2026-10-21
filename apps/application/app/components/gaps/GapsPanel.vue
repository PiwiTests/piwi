<script setup lang="ts">
/**
 * The Gaps tab: a project's scenario gaps and resilience findings, grouped by
 * feature and ranked, each with its class, exposure factors and evidence lines,
 * and the inbox verbs — accept (opens the draft), snooze, dismiss with a reason,
 * covered-by. A status filter switches between the open queue and the accepted
 * (or every) gap, so the Home inbox can link straight to the accepted ones.
 * Above the list sits the feature map — the project graph folded per feature —
 * and any feature or gap node opens in the feature-graph view under it; the
 * node it is open on is the address's `?node=kind:key`, so a link from another
 * page (a file's coverage, for one) opens the tab on that node. Under
 * the list, map health counts the inputs the map has and the steps it lacks.
 * Self-contained: fetches its own data with watch + $fetch so it fires only when
 * the tab mounts.
 */
import { errorMessage, SENTENCE_LINK_CLASS } from '~/utils';

interface GapFactors {
  churn: number;
  age: number;
  escapeHistory: number;
  priority: number;
}
interface Gap {
  id: number;
  kind: 'gap' | 'finding';
  detector: string;
  class: string;
  subject: { kind: string; key: string };
  title: string;
  evidence: string[];
  factors: GapFactors | null;
  score: number | null;
  status: string;
  feature: string | null;
  hub?: boolean;
  testCaseId: number | null;
}

const props = defineProps<{ projectId: number }>();
const { isHidden } = await useProjectCapabilities(props.projectId);
const toast = useToast();
const route = useRoute();
const router = useRouter();

/** The statuses the filter offers; the tab opens on the open queue. */
const STATUS_OPTIONS = [
  { label: 'Open', value: 'open' },
  { label: 'Accepted', value: 'accepted' },
  { label: 'Snoozed', value: 'snoozed' },
  { label: 'Dismissed', value: 'dismissed' },
  { label: 'All', value: 'all' },
];
const STATUS_VALUES = new Set(STATUS_OPTIONS.map((o) => o.value));
const statusFilter = useViewState<string>('gaps:status', () => 'open');
// A `?gapStatus=` link sets the status when it is new; a choice made after it
// is kept, Back to the same link included.
const linkedStatus =
  typeof route.query.gapStatus === 'string' && STATUS_VALUES.has(route.query.gapStatus) ? route.query.gapStatus : null;
const appliedLinkedStatus = useViewState<string | null>('gaps:linked-status', () => null);
if (linkedStatus && linkedStatus !== appliedLinkedStatus.value) statusFilter.value = linkedStatus;
appliedLinkedStatus.value = linkedStatus;

/** The most gaps one request returns; the server caps here, so a full page is truncated. */
const PAGE_LIMIT = 200;

const gaps = ref<Gap[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const recomputing = ref(false);
const graphSeed = ref<string | null>(
  typeof route.query.node === 'string' && route.query.node ? route.query.node : null,
);
const graphCard = ref<HTMLElement | null>(null);
// The graph's node is the address's `?node=`: an open graph can be shared, and a link can open one,
// also while the tab is open.
watch(graphSeed, (node) => {
  if ((route.query.node ?? null) === node) return;
  router.replace({ query: { ...route.query, node: node ?? undefined } });
});
watch(
  () => route.query.node,
  (node) => {
    const seed = typeof node === 'string' && node ? node : null;
    if (seed !== graphSeed.value) graphSeed.value = seed;
  },
);
onMounted(() => {
  if (graphSeed.value) nextTick(() => graphCard.value?.scrollIntoView?.({ block: 'start' }));
});
const mutedDetectors = ref<string[]>([]);
const mapView = ref<{ reload: () => Promise<void> } | null>(null);
const healthView = ref<{ reload: () => Promise<void> } | null>(null);

/** Open a node in the graph view and bring the view into sight. */
function openInGraph(node: { kind: string; key: string }) {
  graphSeed.value = `${node.kind}:${node.key}`;
  nextTick(() => graphCard.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
}

async function load() {
  loading.value = true;
  try {
    const res = await $fetch<{ items: Gap[] }>(`/api/projects/${props.projectId}/gaps` as `/api/projects/:id/gaps`, {
      query: { status: statusFilter.value, limit: PAGE_LIMIT },
    });
    gaps.value = res.items ?? [];
    loadError.value = null;
  } catch (err) {
    // A failed fetch is an error, not an empty queue: keep it distinct from
    // "nothing here" so the surface shows why rather than a misleading empty state.
    gaps.value = [];
    loadError.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
  // Precision is secondary — its failure must not wipe the gaps list.
  try {
    const precision = await $fetch<{ items: Array<{ detector: string; muted: boolean }> }>(
      `/api/projects/${props.projectId}/gaps/precision` as `/api/projects/:id/gaps/precision`,
    );
    mutedDetectors.value = (precision.items ?? []).filter((d) => d.muted).map((d) => d.detector);
  } catch {
    mutedDetectors.value = [];
  }
}

watch([() => props.projectId, statusFilter], load, { immediate: true });

/** True once a full page came back — the server capped the list, so some are hidden. */
const capped = computed(() => gaps.value.length >= PAGE_LIMIT);

/** The group a muted detector's gaps sit in, after every feature. */
const MUTED_GROUP = 'Muted detectors';
/** The group the gaps on a hub sit in: a node most tests reach or most features group. */
const SHARED_GROUP = 'Shared by most features';

/**
 * Gaps grouped by feature, features ordered by their top gap's score. The gaps
 * on a hub sit in their own group, and those of a muted detector leave their
 * feature for one last group.
 */
const grouped = computed(() => {
  const muted = new Set(mutedDetectors.value);
  const map = new Map<string, Gap[]>();
  for (const g of gaps.value) {
    const key = muted.has(g.detector) ? MUTED_GROUP : g.hub ? SHARED_GROUP : (g.feature ?? 'Ungrouped');
    const arr = map.get(key) ?? [];
    arr.push(g);
    map.set(key, arr);
  }
  return [...map.entries()]
    .map(([feature, items]) => ({ feature, items: items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) }))
    .sort(
      (a, b) =>
        Number(a.feature === MUTED_GROUP) - Number(b.feature === MUTED_GROUP) ||
        (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0),
    );
});

const CLASS_COLOR: Record<string, string> = {
  'blind-spot': 'warning',
  'false-comfort': 'error',
  fragile: 'warning',
  unhandled: 'error',
  degraded: 'warning',
};

function factorLine(f: GapFactors | null): string {
  if (!f) return '';
  return `churn ${f.churn.toFixed(1)} · age ${f.age.toFixed(1)} · escape ${f.escapeHistory.toFixed(1)} · priority ${f.priority.toFixed(1)}`;
}

/** Run a triage verb; returns whether it succeeded so callers show one outcome. */
async function triage(gap: Gap, body: Record<string, unknown>): Promise<boolean> {
  try {
    await $fetch(`/api/projects/${props.projectId}/gaps/${gap.id}/triage` as `/api/projects/:id/gaps/:gapId/triage`, {
      method: 'POST',
      body,
    });
    await load();
    // The map counts open gaps, so a verdict changes it too.
    await mapView.value?.reload();
    return true;
  } catch {
    toast.add({ title: 'Triage failed', color: 'error' });
    return false;
  }
}

async function accept(gap: Gap) {
  // One outcome, one toast: a failed triage stops here with its own error toast,
  // so accept never reports both "Triage failed" and "draft copied".
  if (!(await triage(gap, { verb: 'accept' }))) return;
  try {
    const draft = await $fetch<{ text: string }>(
      `/api/projects/${props.projectId}/gaps/${gap.id}/draft` as `/api/projects/:id/gaps/:gapId/draft`,
      { method: 'POST' },
    );
    if (draft?.text && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(draft.text).catch(() => {});
      toast.add({ title: 'Accepted — draft copied to clipboard', color: 'success' });
      return;
    }
  } catch {
    // The draft is best-effort; acceptance already succeeded.
  }
  toast.add({ title: 'Gap accepted', color: 'success' });
}

// Covered-by modal state.
const coveredOpen = ref(false);
const coveredGap = ref<Gap | null>(null);
const coveredTestId = ref<string>('');
const coveredDismiss = ref(false);
const coveredError = ref<string | null>(null);

function openCovered(gap: Gap, alsoDismiss: boolean) {
  coveredGap.value = gap;
  coveredTestId.value = '';
  coveredDismiss.value = alsoDismiss;
  coveredError.value = null;
  coveredOpen.value = true;
}

async function submitCovered() {
  const gap = coveredGap.value;
  const raw = coveredTestId.value.trim();
  const id = Number(raw);
  // Validate before sending: an empty box is `Number('') === 0`, which would
  // otherwise submit test case id 0.
  if (!gap || raw === '' || !Number.isInteger(id) || id <= 0) {
    coveredError.value = 'Enter a positive test case id.';
    return;
  }
  const ok = await triage(
    gap,
    coveredDismiss.value
      ? { verb: 'dismiss', reason: 'covered-elsewhere', coveringTestCaseId: id }
      : { verb: 'covered-by', coveringTestCaseId: id },
  );
  if (ok) coveredOpen.value = false;
}

function snoozeItems(gap: Gap) {
  return [
    [
      { label: 'For 1 day', onSelect: () => triage(gap, { verb: 'snooze', snooze: '1-day' }) },
      { label: 'For 1 week', onSelect: () => triage(gap, { verb: 'snooze', snooze: '1-week' }) },
      {
        label: 'Until the node changes',
        onSelect: () => triage(gap, { verb: 'snooze', snooze: 'until-node-changes' }),
      },
    ],
  ];
}

function dismissItems(gap: Gap) {
  return [
    [
      { label: 'Not worth testing', onSelect: () => triage(gap, { verb: 'dismiss', reason: 'not-worth-testing' }) },
      { label: 'Covered elsewhere…', onSelect: () => openCovered(gap, true) },
      { label: 'Wrong', onSelect: () => triage(gap, { verb: 'dismiss', reason: 'wrong' }) },
    ],
  ];
}

async function recompute() {
  recomputing.value = true;
  try {
    await $fetch(`/api/projects/${props.projectId}/gaps/recompute` as `/api/projects/:id/gaps/recompute`, {
      method: 'POST',
    });
    await load();
    await Promise.all([mapView.value?.reload(), healthView.value?.reload()]);
    toast.add({ title: 'Gaps recomputed', color: 'success' });
  } catch {
    toast.add({ title: 'Recompute failed', color: 'error' });
  } finally {
    recomputing.value = false;
  }
}

/** The empty-state line, worded for the status being shown. */
const emptyText = computed(() =>
  statusFilter.value === 'open'
    ? 'No open gaps — recompute to look against the latest graph.'
    : `No ${statusFilter.value === 'all' ? '' : `${statusFilter.value} `}gaps here.`,
);
</script>

<template>
  <div class="space-y-4" data-shot="gaps-panel">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-sm text-highlighted leading-relaxed" data-testid="gaps-lead">
        Proposed tests that do not exist yet, ranked by exposure, from observed reach: what tests visit, call and click.
        <template v-if="!isHidden('coverage')">
          Which lines they ran is on
          <NuxtLink :to="`/projects/${projectId}/coverage`" :class="SENTENCE_LINK_CLASS">the coverage page</NuxtLink>.
        </template>
        <HelpHint topic="project.gaps" />
      </p>
      <div class="flex items-center gap-2 shrink-0">
        <USelect
          v-model="statusFilter"
          :items="STATUS_OPTIONS"
          size="xs"
          class="w-32"
          :aria-label="'Filter gaps by status'"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :loading="recomputing"
          label="Recompute"
          @click="recompute"
        />
      </div>
    </div>

    <p v-if="mutedDetectors.length > 0" class="text-xs text-muted">
      Muted on this project (below 60% precision over 20+ verdicts; their gaps are listed last and left out of the PR
      comment and the gaps digest):
      <span class="font-mono">{{ mutedDetectors.join(', ') }}</span>
    </p>

    <SectionCard
      title="Feature map"
      subtitle="The project graph folded per feature — click one to open it in the graph"
    >
      <FeatureMapView ref="mapView" :project-id="projectId" :selected="graphSeed" @select="openInGraph" />
    </SectionCard>

    <div v-if="graphSeed" ref="graphCard" class="scroll-mt-4">
      <SectionCard title="Feature graph">
        <template #actions>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            aria-label="Close feature graph"
            @click="graphSeed = null"
          />
        </template>
        <FeatureGraphView :project-id="projectId" :seed-node="graphSeed" @select="openInGraph" />
      </SectionCard>
    </div>

    <ErrorState v-if="loadError" :text="`Couldn't load gaps: ${loadError}`">
      <template #action>
        <UButton size="xs" color="neutral" variant="outline" label="Retry" @click="load" />
      </template>
    </ErrorState>
    <LoadingState v-else-if="loading && gaps.length === 0" />
    <EmptyState v-else-if="gaps.length === 0" icon="i-lucide-radar" :text="emptyText" />

    <template v-else>
      <SectionCard
        v-for="group in grouped"
        :key="group.feature"
        :title="group.feature"
        :data-shot="`gaps-group-${group.feature}`"
      >
        <div class="divide-y divide-default">
          <div v-for="gap in group.items" :key="gap.id" class="py-3 space-y-2" :data-shot="`gap-${gap.id}`">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <UBadge :color="(CLASS_COLOR[gap.class] as any) ?? 'neutral'" variant="subtle" size="sm">{{
                    gap.class
                  }}</UBadge>
                  <span v-if="gap.kind === 'finding'" class="text-xs text-muted">finding</span>
                  <span v-if="statusFilter !== 'open'" class="text-xs text-muted">{{ gap.status }}</span>
                  <span class="text-xs text-muted font-mono">{{ gap.detector }}</span>
                </div>
                <p class="mt-1 text-sm text-highlighted leading-relaxed">{{ gap.title }}</p>
                <ul class="mt-1 space-y-0.5">
                  <li v-for="(line, i) in gap.evidence" :key="i" class="text-xs text-muted">{{ line }}</li>
                </ul>
                <p class="mt-1 text-xs text-muted">
                  Score {{ (gap.score ?? 0).toFixed(3)
                  }}<span v-if="gap.factors"> · {{ factorLine(gap.factors) }}</span>
                </p>
              </div>
              <div class="flex flex-wrap items-center gap-1 sm:shrink-0">
                <UButton size="xs" color="primary" label="Accept" @click="accept(gap)" />
                <UDropdownMenu :items="snoozeItems(gap)">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    label="Snooze"
                    trailing-icon="i-lucide-chevron-down"
                  />
                </UDropdownMenu>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  label="Covered by"
                  @click="openCovered(gap, false)"
                />
                <UDropdownMenu :items="dismissItems(gap)">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    label="Dismiss"
                    trailing-icon="i-lucide-chevron-down"
                  />
                </UDropdownMenu>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-radar"
                  :title="`View ${gap.subject.kind}:${gap.subject.key} in the graph`"
                  @click="openInGraph(gap.subject)"
                />
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      <p v-if="capped" class="text-xs text-muted">
        Showing the top {{ PAGE_LIMIT }} gaps by exposure — narrow with a status filter or on a feature to see the rest.
      </p>
    </template>

    <SectionCard
      data-shot="map-health-card"
      title="Map health"
      subtitle="What the map can see: an input it lacks keeps the detectors that read it silent"
    >
      <MapHealthView ref="healthView" :project-id="projectId" />
    </SectionCard>

    <UModal v-model:open="coveredOpen" :title="coveredDismiss ? 'Covered elsewhere' : 'Covered by a test'">
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-highlighted">
            Enter the test case id that covers this. A manual reaches edge is written so the gap closes on the next
            recompute<span v-if="coveredDismiss"> and the gap is dismissed</span>.
          </p>
          <UFormField label="Covering test case id" :error="coveredError ?? undefined">
            <UInput v-model="coveredTestId" type="number" placeholder="test case id" class="w-full" />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" label="Cancel" @click="coveredOpen = false" />
            <UButton color="primary" label="Save" @click="submitCovered" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

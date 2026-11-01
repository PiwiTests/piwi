<script setup lang="ts">
/**
 * The Coverage tab's Gaps view: a project's scenario gaps and resilience
 * findings, grouped by feature and ranked, each with its class, exposure
 * factors and evidence lines, and the inbox verbs — accept (opens the draft),
 * snooze, dismiss with a reason, covered-by. A status filter switches between
 * the open queue and the accepted (or every) gap, so the Home inbox can link
 * straight to the accepted ones. A gap's subject opens in the Map view's graph.
 * Self-contained: fetches its own data with watch + $fetch so it fires only when
 * the view mounts.
 */
import { errorMessage, SENTENCE_LINK_CLASS } from '~/utils';
import { coverageTabLink } from '~/utils/coverage-tab';
import type { GapRowItem } from '~/utils/gap-row';
import type { GapCode } from '~~/server/utils/coverage-summary';

type Gap = GapRowItem & {
  kind: 'gap' | 'finding';
  subject: { kind: string; key: string };
  evidence: string[];
  status: string;
  feature: string | null;
  hub?: boolean;
  testCaseId: number | null;
};

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

/** A positive integer from the query, else null. */
function queryId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// A pull-request comment's links show one gap (`?gap=`), or the gaps one pull request's change raised
// (`?gapPr=`, from its change-coverage status); an editor's, the gaps of one file (`?gapFile=`). Each
// shows them whatever their status.
const linkedGap = computed(() => queryId(route.query.gap));
const linkedPr = computed(() => (linkedGap.value ? null : queryId(route.query.gapPr)));
const linkedFile = computed(() =>
  linkedGap.value || linkedPr.value || typeof route.query.gapFile !== 'string' || !route.query.gapFile
    ? null
    : route.query.gapFile,
);
const linked = computed(() => linkedGap.value != null || linkedPr.value != null || linkedFile.value != null);

function showAllGaps() {
  router.replace({ query: { ...route.query, gap: undefined, gapPr: undefined, gapFile: undefined } });
}

const gaps = ref<Gap[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const recomputing = ref(false);
const mutedDetectors = ref<string[]>([]);

/** Open a gap's subject in the Map view's graph. */
function openInGraph(node: { kind: string; key: string }) {
  void router.push(coverageTabLink(props.projectId, 'map', { node: `${node.kind}:${node.key}` }));
}

async function load() {
  loading.value = true;
  try {
    const res = await $fetch<{ items: Gap[] }>(`/api/projects/${props.projectId}/gaps` as `/api/projects/:id/gaps`, {
      query: linkedGap.value
        ? { gap: linkedGap.value, status: 'all', limit: 1 }
        : linkedPr.value
          ? { pr: linkedPr.value, status: 'all', limit: PAGE_LIMIT }
          : linkedFile.value
            ? { key: linkedFile.value, status: 'all', limit: PAGE_LIMIT }
            : { status: statusFilter.value, limit: PAGE_LIMIT },
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
  await loadCode();
}

// The files behind the listed gaps, with their coverage on the default branch: secondary, so a
// project without coverage, or a failed read, shows the gaps alone.
const codeByGap = ref(new Map<number, GapCode['gaps'][number]['files']>());
async function loadCode() {
  const ids = gaps.value.map((g) => g.id);
  if (isHidden('coverage') || ids.length === 0) {
    codeByGap.value = new Map();
    return;
  }
  const code = await $fetch<GapCode>(`/api/projects/${props.projectId}/gaps/code` as `/api/projects/:id/gaps/code`, {
    query: { ids: ids.join(',') },
  }).catch(() => null);
  codeByGap.value = new Map((code?.gaps ?? []).map((g) => [g.id, g.files]));
}

watch([() => props.projectId, statusFilter, linkedGap, linkedPr, linkedFile], load, { immediate: true });

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

async function recompute() {
  recomputing.value = true;
  try {
    await $fetch(`/api/projects/${props.projectId}/gaps/recompute` as `/api/projects/:id/gaps/recompute`, {
      method: 'POST',
    });
    await load();
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
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between max-sm:px-4">
      <p class="text-sm text-highlighted leading-relaxed" data-testid="gaps-lead">
        Proposed tests that do not exist yet, ranked by exposure, from observed reach: what tests visit, call and click.
        <template v-if="!isHidden('coverage')">
          Which lines they ran is in the
          <NuxtLink :to="coverageTabLink(projectId, 'code')" :class="SENTENCE_LINK_CLASS">Code view</NuxtLink>.
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

    <p v-if="linked" class="text-xs text-muted max-sm:px-4" data-testid="gaps-linked">
      <span>
        <template v-if="linkedGap">Showing the gap a link named.</template>
        <template v-else-if="linkedPr">Showing the gaps of pull request #{{ linkedPr }}.</template>
        <template v-else>
          Showing the gaps of <span class="font-mono">{{ linkedFile }}</span
          >: an uncovered change a pull-request run raises, and code or an error path no suite runs, or code one test
          alone runs.
        </template>
      </span>
      <button type="button" :class="[SENTENCE_LINK_CLASS, 'ms-1']" @click="showAllGaps">Show all gaps</button>
    </p>

    <p v-if="mutedDetectors.length > 0" class="text-xs text-muted max-sm:px-4">
      Muted on this project (below 60% precision over 20+ verdicts; their gaps are listed last and left out of the PR
      comment and the gaps digest):
      <span class="font-mono">{{ mutedDetectors.join(', ') }}</span>
    </p>

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
            <GapRow
              :project-id="projectId"
              :gap="gap"
              :show-status="statusFilter !== 'open' || linked"
              :code="codeByGap.get(gap.id)"
              @changed="load"
              @graph="openInGraph"
            />
          </div>
        </div>
      </SectionCard>

      <p v-if="capped" class="text-xs text-muted max-sm:px-4">
        Showing the top {{ PAGE_LIMIT }} gaps by exposure — narrow with a status filter or on a feature to see the rest.
      </p>
    </template>
  </div>
</template>

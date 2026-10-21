<script setup lang="ts">
import { describeCluster } from '#shared/describe-cluster';
import { getProviderIcon } from '#shared/link-detect';
import { isCurrentlySnoozed } from '#shared/inbox-queues';
import type { TableColumn } from '@nuxt/ui';
import type { SortingState } from '@tanstack/vue-table';
import type { ProjectFailureCluster } from '~~/types/api';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { projectRunScopeQuery, type ProjectRunScope } from '#shared/project-run-scope';

const props = defineProps<{
  projectId: string | number;
  /** The status the list opens on (a drill-down from Analytics); every status when unset. */
  initialStatus?: 'open' | 'resolved' | 'ignored';
  /** The project page's run scope: the clusters seen in its runs, counted over them. */
  scope?: ProjectRunScope | null;
}>();

const emit = defineEmits<{ count: [total: number] }>();

// 'all' is a real select value so the control shows its current choice; the API
// takes no status param for it. A status the page passes (an analytics
// drill-down) wins over the one kept for the page.
const statusFilter = useViewState<'all' | 'open' | 'resolved' | 'ignored'>(
  'failures:clusters-status',
  () => props.initialStatus ?? 'all',
);
if (props.initialStatus) statusFilter.value = props.initialStatus;
const sorting = useViewState<SortingState>('failures:clusters-sorting', () => []);
watch(
  () => props.initialStatus,
  (status) => {
    if (status) statusFilter.value = status;
  },
);
const {
  data: clusters,
  status: clustersStatus,
  refresh,
} = await useFetch(
  () => {
    const params = new URLSearchParams(props.scope ? projectRunScopeQuery(props.scope) : {});
    if (statusFilter.value !== 'all') params.set('status', statusFilter.value);
    const qs = params.toString();
    return `/api/projects/${props.projectId}/failure-clusters${qs ? `?${qs}` : ''}`;
  },
  {
    lazy: true,
    server: false,
    watch: [statusFilter],
    transform: (r: { items: ProjectFailureCluster[] }) => r.items,
  },
);

// The server renders before the client-only fetch starts (`idle`), so idle reads as loading too.
const loading = computed(() => clustersStatus.value === 'idle' || clustersStatus.value === 'pending');

// Only the unfiltered list stands for the project's cluster count.
watch(clusters, (list) => {
  if (list && statusFilter.value === 'all') emit('count', list.length);
});

const nameOf = (cluster: ProjectFailureCluster) => describeCluster(cluster);
// The raw signature is a second line only when it differs from the display name.
const signatureOf = (cluster: ProjectFailureCluster) =>
  cluster.signature && cluster.signature !== nameOf(cluster) ? cluster.signature : null;
const resolutionOf = (cluster: ProjectFailureCluster) => fixVerificationBadge(cluster.fixVerification);
const isSnoozed = (cluster: ProjectFailureCluster) => isCurrentlySnoozed(cluster);

// ── Bulk status ─────────────────────────────────────────────────────────────
// Multi-select the clusters and set them all to one status at once, so a
// project's backlog doesn't have to be triaged a row at a time.
const toast = useToast();
// Setting a cluster's status needs `triage:write` on the project.
const { can } = useAuth();
const canTriage = computed(() => can('triage:write', props.projectId));
const selectedIds = ref<Set<number>>(new Set());
const rows = computed(() => clusters.value ?? []);
const selectedCount = computed(() => selectedIds.value.size);
const allSelected = computed(() => rows.value.length > 0 && rows.value.every((c) => selectedIds.value.has(c.id)));
const someSelected = computed(() => selectedIds.value.size > 0 && !allSelected.value);
const bulkBusy = ref(false);

function toggleRow(id: number) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}
function toggleAll() {
  selectedIds.value = allSelected.value ? new Set() : new Set(rows.value.map((c) => c.id));
}
function clearSelection() {
  selectedIds.value = new Set();
}
// Drop selections that scroll out when the status filter changes.
watch(clusters, () => {
  const present = new Set(rows.value.map((c) => c.id));
  const filtered = new Set([...selectedIds.value].filter((id) => present.has(id)));
  if (filtered.size !== selectedIds.value.size) selectedIds.value = filtered;
});

async function setStatus(status: 'open' | 'resolved' | 'ignored') {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  bulkBusy.value = true;
  let succeeded = 0;
  let failed = 0;
  try {
    for (const id of ids) {
      try {
        await $fetch(`/api/failure-clusters/${id}/status`, { method: 'PATCH', body: { status } });
        succeeded++;
      } catch {
        failed++;
      }
    }
    const label = `${succeeded} cluster${succeeded === 1 ? '' : 's'} set to ${status}`;
    if (failed === 0) toast.add({ title: label, color: 'success' });
    else
      toast.add({
        title: label,
        description: `${failed} could not be updated.`,
        color: succeeded > 0 ? 'warning' : 'error',
      });
    if (succeeded > 0) {
      clearSelection();
      await refresh();
    }
  } finally {
    bulkBusy.value = false;
  }
}

const columns = computed<TableColumn<ProjectFailureCluster>[]>(() => [
  ...(canTriage.value ? [{ id: 'select', header: '' } as TableColumn<ProjectFailureCluster>] : []),
  { accessorKey: 'signature', header: createSortHeader<ProjectFailureCluster>('Failure') },
  { accessorKey: 'errorType', header: createSortHeader<ProjectFailureCluster>('Type') },
  { accessorKey: 'status', header: createSortHeader<ProjectFailureCluster>('Triage') },
  { accessorKey: 'affectedTests', header: createSortHeader<ProjectFailureCluster>('Tests') },
  { accessorKey: 'occurrences', header: createSortHeader<ProjectFailureCluster>('Occurrences') },
  { accessorKey: 'lastSeenAt', header: createSortHeader<ProjectFailureCluster>('Last seen') },
]);
</script>

<template>
  <UCard data-shot="failure-clusters">
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <p class="text-sm text-gray-500 inline-flex items-center gap-1">
          Open root causes, one row per failure cluster.
          <HelpHint topic="cluster.concept" />
        </p>
        <div class="flex items-center gap-2 shrink-0">
          <label for="cluster-status-filter" class="text-xs text-muted">Triage</label>
          <USelect
            id="cluster-status-filter"
            v-model="statusFilter"
            :items="[
              { label: 'All', value: 'all' },
              { label: 'Open', value: 'open' },
              { label: 'Resolved', value: 'resolved' },
              { label: 'Ignored', value: 'ignored' },
            ]"
            size="xs"
            class="w-32"
          />
        </div>
      </div>
    </template>

    <!-- Bulk status bar — appears once clusters are selected. -->
    <div
      v-if="canTriage && selectedCount > 0"
      class="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
    >
      <span class="text-sm font-medium" aria-live="polite"> {{ selectedCount }} selected </span>
      <div class="flex flex-wrap items-center gap-2 ml-auto">
        <UDropdownMenu
          :items="[
            { label: 'Open', onSelect: () => setStatus('open') },
            { label: 'Resolved', onSelect: () => setStatus('resolved') },
            { label: 'Ignored', onSelect: () => setStatus('ignored') },
          ]"
        >
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-triangle-alert"
            trailing-icon="i-lucide-chevron-down"
            :loading="bulkBusy"
          >
            Set status…
          </UButton>
        </UDropdownMenu>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" @click="clearSelection">Clear</UButton>
      </div>
    </div>

    <!-- md+ : one row per cluster, sized to fit without a horizontal scroll -->
    <div class="hidden md:block">
      <UTable
        v-model:sorting="sorting"
        :data="clusters ?? []"
        :columns="columns"
        :loading="loading"
        :ui="{ base: 'w-full', td: 'py-3 align-top', th: 'py-2 text-xs uppercase tracking-wide' }"
      >
        <template #select-header>
          <input
            type="checkbox"
            class="size-4 cursor-pointer accent-primary focus-visible:ring-2 focus-visible:ring-primary rounded"
            :checked="allSelected"
            :indeterminate.prop="someSelected"
            :aria-label="allSelected ? 'Deselect all clusters' : 'Select all clusters'"
            @change="toggleAll"
          />
        </template>
        <template #select-cell="{ row }">
          <input
            type="checkbox"
            class="size-4 cursor-pointer accent-primary focus-visible:ring-2 focus-visible:ring-primary rounded"
            :checked="selectedIds.has(row.original.id)"
            :aria-label="`Select cluster ${nameOf(row.original)}`"
            @change="toggleRow(row.original.id)"
          />
        </template>

        <template #signature-cell="{ row }">
          <div class="min-w-0 max-w-[340px] space-y-0.5">
            <div class="flex items-center gap-1.5 min-w-0">
              <NuxtLink
                :to="`/failure-clusters/${row.original.id}`"
                class="text-sm text-primary hover:underline truncate"
                :title="nameOf(row.original)"
              >
                {{ nameOf(row.original) }}
              </NuxtLink>
              <UIcon
                v-if="row.original.diagnosis?.status === 'completed'"
                name="i-lucide-sparkles"
                class="size-3.5 shrink-0 text-muted"
                title="AI diagnosis available"
              />
              <a
                v-if="row.original.issueLink"
                :href="safeHttpUrl(row.original.issueLink.url) ?? undefined"
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0"
                :title="`Known issue: ${row.original.issueLink.key ?? row.original.issueLink.url}`"
                @click.stop
              >
                <UBadge color="neutral" variant="subtle" size="xs" class="gap-1">
                  <UIcon :name="getProviderIcon(row.original.issueLink.provider as any)" class="size-3" />
                  {{ row.original.issueLink.key ?? 'Issue' }}
                </UBadge>
              </a>
            </div>
            <p v-if="signatureOf(row.original)" class="text-xs text-gray-500 font-mono truncate">
              {{ signatureOf(row.original) }}
            </p>
            <p
              v-if="row.original.triageNote"
              class="text-xs text-gray-500 italic line-clamp-2"
              :title="row.original.triageNote"
            >
              {{ row.original.triageNote }}
            </p>
          </div>
        </template>

        <template #errorType-cell="{ row }">
          <UBadge
            v-if="row.original.errorType"
            :color="clusterErrorTypeColor(row.original.errorType)"
            variant="subtle"
            size="sm"
          >
            {{ row.original.errorType }}
          </UBadge>
          <span v-else class="text-gray-400 text-xs">—</span>
        </template>

        <!-- Triage status is what a human declared; the fix-verification badge below
             it is what the runs actually showed. They disagree often enough — a
             cluster fixed but never triaged — that both have to be visible. -->
        <template #status-cell="{ row }">
          <div class="flex flex-col items-start gap-1">
            <UBadge :color="clusterStatusColor(row.original.status)" variant="subtle" size="sm">
              {{ formatTriageStatus(row.original.status) }}
            </UBadge>
            <UBadge v-if="isSnoozed(row.original)" color="info" variant="subtle" size="sm" class="gap-1">
              <UIcon name="i-lucide-alarm-clock" class="size-3" />
              Snoozed
            </UBadge>
            <UTooltip v-if="resolutionOf(row.original)" :text="resolutionOf(row.original)!.hint">
              <UBadge :color="resolutionOf(row.original)!.color" variant="subtle" size="sm" class="gap-1">
                <UIcon :name="resolutionOf(row.original)!.icon" class="size-3" />
                {{ resolutionOf(row.original)!.label }}
              </UBadge>
            </UTooltip>
          </div>
        </template>

        <template #affectedTests-cell="{ row }">
          <span class="text-sm tabular-nums">{{ row.original.affectedTests }}</span>
        </template>

        <template #occurrences-cell="{ row }">
          <span class="text-sm tabular-nums">{{ row.original.occurrences }}</span>
        </template>

        <template #lastSeenAt-cell="{ row }">
          <div class="text-sm text-gray-500 whitespace-nowrap">
            <NuxtLink :to="`/test-runs/${row.original.lastSeenRunId}`" class="text-primary hover:underline">
              run #{{ row.original.lastSeenRunId }}
            </NuxtLink>
            <ClientOnly>
              <span v-if="row.original.lastSeenAt" class="ml-1 text-xs text-gray-400">
                ({{ formatRelativeTime(row.original.lastSeenAt) }})
              </span>
            </ClientOnly>
          </div>
        </template>
      </UTable>
    </div>

    <!-- Below md : one card per cluster (no horizontal scroll) -->
    <div class="space-y-2 md:hidden">
      <div v-for="cluster in rows" :key="cluster.id" class="rounded-lg border border-default p-3 space-y-2">
        <div class="flex items-start gap-2">
          <input
            v-if="canTriage"
            type="checkbox"
            class="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary rounded"
            :checked="selectedIds.has(cluster.id)"
            :aria-label="`Select cluster ${nameOf(cluster)}`"
            @change="toggleRow(cluster.id)"
          />
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex items-center gap-1.5 min-w-0">
              <NuxtLink
                :to="`/failure-clusters/${cluster.id}`"
                class="text-sm font-medium text-primary hover:underline truncate"
                :title="nameOf(cluster)"
              >
                {{ nameOf(cluster) }}
              </NuxtLink>
              <UIcon
                v-if="cluster.diagnosis?.status === 'completed'"
                name="i-lucide-sparkles"
                class="size-3.5 shrink-0 text-muted"
                title="AI diagnosis available"
              />
            </div>
            <p v-if="signatureOf(cluster)" class="text-xs text-gray-500 font-mono truncate">
              {{ signatureOf(cluster) }}
            </p>
            <p v-if="cluster.triageNote" class="text-xs text-gray-500 italic line-clamp-2" :title="cluster.triageNote">
              {{ cluster.triageNote }}
            </p>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
          <UBadge v-if="cluster.errorType" :color="clusterErrorTypeColor(cluster.errorType)" variant="subtle" size="sm">
            {{ cluster.errorType }}
          </UBadge>
          <UBadge :color="clusterStatusColor(cluster.status)" variant="subtle" size="sm">
            {{ formatTriageStatus(cluster.status) }}
          </UBadge>
          <UBadge
            v-if="resolutionOf(cluster)"
            :color="resolutionOf(cluster)!.color"
            variant="subtle"
            size="sm"
            class="gap-1"
            :title="resolutionOf(cluster)!.hint"
          >
            <UIcon :name="resolutionOf(cluster)!.icon" class="size-3" />
            {{ resolutionOf(cluster)!.label }}
          </UBadge>
        </div>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          <span class="tabular-nums"
            >{{ cluster.affectedTests }} {{ cluster.affectedTests === 1 ? 'test' : 'tests' }}</span
          >
          <span class="tabular-nums"
            >{{ cluster.occurrences }} occurrence{{ cluster.occurrences === 1 ? '' : 's' }}</span
          >
          <span class="inline-flex items-center gap-1">
            <NuxtLink :to="`/test-runs/${cluster.lastSeenRunId}`" class="text-primary hover:underline">
              run #{{ cluster.lastSeenRunId }}
            </NuxtLink>
            <ClientOnly>
              <span v-if="cluster.lastSeenAt" class="text-gray-400"
                >({{ formatRelativeTime(cluster.lastSeenAt) }})</span
              >
            </ClientOnly>
          </span>
        </div>
      </div>
    </div>

    <EmptyState
      v-if="!loading && clusters && clusters.length === 0"
      text="No failure clusters recorded for this project."
      :padded="false"
      class="py-4"
    />
  </UCard>
</template>

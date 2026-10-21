<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { SortingState } from '@tanstack/vue-table';
import type { TimeoutOpportunity } from '#shared/analytics/timeout-hygiene';
import { projectRunScopeQuery, type ProjectRunScope } from '#shared/project-run-scope';

const props = defineProps<{
  projectId: string | number;
  projectName?: string | null;
  /** The project page's run scope: the recent runs read are its runs. */
  scope?: ProjectRunScope | null;
}>();

const { data, status } = await useFetch(() => `/api/projects/${props.projectId}/timeout-opportunities`, {
  lazy: true,
  server: false,
  query: computed(() => (props.scope ? projectRunScopeQuery(props.scope) : {})),
  transform: (r: { items: TimeoutOpportunity[] }) => r.items,
});

// The server renders before the client-only fetch starts (`idle`), so idle reads as loading too.
const loading = computed(() => status.value === 'idle' || status.value === 'pending');
const opportunities = computed(() => data.value ?? []);

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const columns: TableColumn<TimeoutOpportunity>[] = [
  { accessorKey: 'title', header: createSortHeader<TimeoutOpportunity>('Test') },
  { accessorKey: 'kind', header: 'Type' },
  { accessorKey: 'timeout', header: createSortHeader<TimeoutOpportunity>('Timeout') },
  { accessorKey: 'p95', header: createSortHeader<TimeoutOpportunity>('p95') },
  { accessorKey: 'recommendedTimeout', header: 'Recommendation' },
  { accessorKey: 'estimatedSavingMs', header: createSortHeader<TimeoutOpportunity>('Est. saving / failure') },
  { accessorKey: 'runCount', header: createSortHeader<TimeoutOpportunity>('Runs') },
];
const sorting = useViewState<SortingState>('performance:timeouts-sorting', () => []);
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-xl font-semibold">Timeout opportunities</h2>
      <p class="text-sm text-gray-600 mt-1">
        Tests whose configured timeout far exceeds their real duration, or that still carry a stale
        <code class="text-xs">test.slow()</code> mark — tightening these makes failures surface sooner.
      </p>
    </template>

    <LoadingState v-if="loading" />

    <EmptyState
      v-else-if="opportunities.length === 0"
      text="No timeout opportunities"
      description="No oversized timeouts or stale test.slow() marks were found for this project."
    />

    <TableScroller v-else min-width="52rem" :bleed="false">
      <UTable v-model:sorting="sorting" :data="opportunities" :columns="columns" sticky class="max-h-[32rem]">
        <template #title-cell="{ row }">
          <div class="min-w-0">
            <NuxtLink
              :to="`/test-cases/${row.original.testCaseId}`"
              class="font-medium truncate block hover:text-primary hover:underline"
            >
              {{ row.original.title }}
            </NuxtLink>
            <div class="mt-1">
              <OpenInIdeLink
                :file-path="row.original.filePath"
                :project-key="projectId"
                :project-name="projectName"
                class="text-xs"
              />
            </div>
          </div>
        </template>

        <template #kind-cell="{ row }">
          <UBadge :color="row.original.kind === 'oversized-timeout' ? 'warning' : 'info'" variant="subtle" size="sm">
            {{ row.original.kind === 'oversized-timeout' ? 'Oversized timeout' : 'Stale test.slow()' }}
          </UBadge>
        </template>

        <template #timeout-cell="{ row }">
          <span class="tabular-nums">{{ formatMs(row.original.timeout) }}</span>
          <span v-if="row.original.headroomRatio != null" class="ml-1 text-xs text-gray-500" :title="'timeout ÷ p95'">
            ({{ row.original.headroomRatio }}×)
          </span>
        </template>

        <template #p95-cell="{ row }">
          <span class="tabular-nums text-gray-500">{{ formatMs(row.original.p95) }}</span>
        </template>

        <template #recommendedTimeout-cell="{ row }">
          <span v-if="row.original.kind === 'stale-slow'" class="text-sm"
            >Remove <code class="text-xs">test.slow()</code></span
          >
          <span v-else class="tabular-nums">Lower to ~{{ formatMs(row.original.recommendedTimeout) }}</span>
        </template>

        <template #estimatedSavingMs-cell="{ row }">
          <span class="tabular-nums font-medium text-green-600 dark:text-green-400">
            {{ formatMs(row.original.estimatedSavingMs) }}
          </span>
        </template>

        <template #runCount-cell="{ row }">
          <span class="tabular-nums text-gray-500">{{ row.original.runCount }}</span>
        </template>
      </UTable>
    </TableScroller>
  </UCard>
</template>

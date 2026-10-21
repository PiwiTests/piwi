<script setup lang="ts">
/**
 * The slow-endpoints table for a project: the network requests captured by the
 * Piwi fixtures, aggregated per route, for one selected run (the latest by
 * default). The run selector lets a reader check a specific run's endpoint
 * timings without leaving the project's Performance tab.
 */
import type { TableColumn } from '@nuxt/ui';
import type { SortingState } from '@tanstack/vue-table';
import type { EndpointSummary, TestRunSummary } from '~~/types/api';

const props = defineProps<{
  projectId: string | number;
  /** The runs to choose from (already filtered by the page's scope). */
  runs: TestRunSummary[];
}>();

// Slow endpoints ride on the capture fixtures. A project that declined them
// drops the block; an undecided project gets one naming line instead of a pitch;
// an active project falls through to the table or its plain empty state.
const { state: capState } = await useProjectCapabilities(Number(props.projectId));
const fixturesDeclined = computed(() => capState('fixtures') === 'declined');
const fixturesUndecided = computed(() => capState('fixtures') === 'undecided');

const runId = defineModel<number | null>('runId', { default: null });

// USelect wants number | undefined; the model is number | null.
const selectedRunId = computed({
  get: () => runId.value ?? undefined,
  set: (v: number | undefined) => (runId.value = v ?? null),
});

const runOptions = computed(() =>
  props.runs.map((r) => ({
    label: `Run #${r.id}`,
    value: r.id,
  })),
);

const { data: endpoints, pending: loading } = await useFetch(() => `/api/test-runs/${runId.value}/network-requests`, {
  lazy: true,
  server: false,
  immediate: false,
  watch: [runId],
  transform: (r: { items: EndpointSummary[] }) => r.items,
});

const endpointColumns: TableColumn<EndpointSummary>[] = [
  { accessorKey: 'method', header: createSortHeader<EndpointSummary>('Method') },
  { accessorKey: 'route', header: createSortHeader<EndpointSummary>('Route') },
  { accessorKey: 'count', header: createSortHeader<EndpointSummary>('Calls') },
  { accessorKey: 'avgDuration', header: createSortHeader<EndpointSummary>('Avg') },
  { accessorKey: 'p90Duration', header: createSortHeader<EndpointSummary>('P90') },
  { accessorKey: 'maxDuration', header: createSortHeader<EndpointSummary>('Max') },
  { accessorKey: 'errorRate', header: createSortHeader<EndpointSummary>('Errors') },
];
const sorting = useViewState<SortingState>('performance:endpoints-sorting', () => []);
</script>

<template>
  <UCard v-if="!fixturesDeclined" data-shot="slow-endpoints">
    <template #header>
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 class="text-xl font-semibold inline-flex items-center gap-1">
            Slow endpoints <HelpHint topic="project.slow-endpoints" />
          </h2>
          <p class="text-sm text-gray-600 mt-1">Backend routes exercised by a run, ranked by time</p>
        </div>
        <USelect
          v-if="runOptions.length > 0"
          v-model="selectedRunId"
          :items="runOptions"
          value-key="value"
          size="sm"
          class="w-40"
          icon="i-lucide-play-circle"
          aria-label="Select run"
        />
      </div>
    </template>

    <div v-if="loading" class="flex items-center justify-center py-8 text-gray-500 gap-2">
      <UIcon name="i-lucide-loader-2" class="size-4 animate-spin" />
      <span>Loading network data…</span>
    </div>

    <TableScroller v-else-if="endpoints && endpoints.length > 0" min-width="44rem" :bleed="false">
      <UTable
        v-model:sorting="sorting"
        :data="endpoints"
        :columns="endpointColumns"
        aria-label="Slow endpoints"
        :ui="{
          base: 'table-fixed border-separate border-spacing-0',
          thead: '[&>tr]:bg-elevated/50 [&>tr]:after:content-none',
          tbody: '[&>tr]:last:[&>td]:border-b-0',
          th: 'first:rounded-l-lg last:rounded-r-lg border-y border-default first:border-l last:border-r',
          td: 'border-b border-default',
        }"
      >
        <template #method-cell="{ row }">
          <UBadge
            :color="
              row.original.method === 'GET'
                ? 'info'
                : row.original.method === 'POST'
                  ? 'success'
                  : row.original.method === 'PUT' || row.original.method === 'PATCH'
                    ? 'warning'
                    : row.original.method === 'DELETE'
                      ? 'error'
                      : 'neutral'
            "
            variant="soft"
            class="font-mono text-xs"
          >
            {{ row.original.method }}
          </UBadge>
        </template>
        <template #route-cell="{ row }">
          <code class="text-xs font-mono break-all">{{ row.original.route }}</code>
        </template>
        <template #avgDuration-cell="{ row }">
          <span
            :class="
              row.original.avgDuration > 1000
                ? 'text-red-600 font-medium'
                : row.original.avgDuration > 500
                  ? 'text-orange-500 font-medium'
                  : ''
            "
          >
            <DurationValue :ms="row.original.avgDuration" unit-class="opacity-60" />
          </span>
        </template>
        <template #p90Duration-cell="{ row }">
          <span
            :class="
              row.original.p90Duration > 2000
                ? 'text-red-600 font-medium'
                : row.original.p90Duration > 1000
                  ? 'text-orange-500'
                  : ''
            "
          >
            <DurationValue :ms="row.original.p90Duration" unit-class="opacity-60" />
          </span>
        </template>
        <template #maxDuration-cell="{ row }">
          <span
            :class="
              row.original.maxDuration > 2000
                ? 'text-red-600 font-medium'
                : row.original.maxDuration > 1000
                  ? 'text-orange-500'
                  : ''
            "
          >
            <DurationValue :ms="row.original.maxDuration" unit-class="opacity-60" />
          </span>
        </template>
        <template #errorRate-cell="{ row }">
          <span v-if="row.original.errorRate === 0" class="text-gray-400">0%</span>
          <span v-else class="text-red-600 font-medium">{{ row.original.errorRate }}%</span>
        </template>
      </UTable>
    </TableScroller>

    <p v-else-if="fixturesUndecided" class="py-6 text-sm text-muted">
      Network timing is not captured for this project.
    </p>

    <EmptyState v-else icon="i-lucide-wifi-off" text="No network requests captured for this run." />
  </UCard>
</template>

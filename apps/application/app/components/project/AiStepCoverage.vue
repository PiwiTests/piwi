<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { SortingState } from '@tanstack/vue-table';

const props = defineProps<{
  projectId: string | number;
}>();

interface AiStepArtifact {
  entry: string;
  testCount: number;
  replayCount: number;
  lastSeen: string | null;
}
interface AiStepCoverage {
  summary: { artifactCount: number; testCount: number; runCount: number; replayCount: number };
  artifacts: AiStepArtifact[];
}

const days = useViewState('performance:ai-steps-days', () => 30);
const sorting = useViewState<SortingState>('performance:ai-steps-sorting', () => []);
const { data, pending } = await useFetch<AiStepCoverage>(
  () => `/api/projects/${props.projectId}/ai-steps?days=${days.value}`,
  { lazy: true, server: false, watch: [days] },
);

const artifacts = computed(() => data.value?.artifacts ?? []);
const summary = computed(() => data.value?.summary ?? { artifactCount: 0, testCount: 0, runCount: 0, replayCount: 0 });

/** Show just the entry file name; the full path is on the title/tooltip. */
function entryName(entry: string): string {
  const parts = entry.split(/[\\/]/);
  return parts[parts.length - 1] || entry;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days_ = Math.round(hours / 24);
  return `${days_}d ago`;
}

const DAY_OPTIONS = [
  { label: 'Last 7 days', value: 7 },
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 90 days', value: 90 },
];

const columns: TableColumn<AiStepArtifact>[] = [
  { accessorKey: 'entry', header: createSortHeader<AiStepArtifact>('Artifact') },
  { accessorKey: 'testCount', header: createSortHeader<AiStepArtifact>('Tests') },
  { accessorKey: 'replayCount', header: createSortHeader<AiStepArtifact>('Replays') },
  { accessorKey: 'lastSeen', header: createSortHeader<AiStepArtifact>('Last seen') },
];
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-500">
          AI-step liveness — which committed <code class="text-xs">piwiLocator</code> /
          <code class="text-xs">piwiRun</code> artifacts were replayed, and when they were last seen
        </p>
        <USelect v-model="days" :items="DAY_OPTIONS" size="xs" class="w-32" />
      </div>
    </template>

    <LoadingState v-if="pending" />

    <EmptyState
      v-else-if="artifacts.length === 0"
      text="No AI steps"
      description="No committed AI-step artifacts were replayed in the selected period. Author them with page.piwiLocator / page.piwiRun in resolve mode."
    />

    <div v-else>
      <div class="grid grid-cols-3 gap-3 mb-4">
        <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
          <div class="text-2xl font-semibold tabular-nums">{{ summary.artifactCount }}</div>
          <div class="text-xs text-gray-500">Artifacts replayed</div>
        </div>
        <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
          <div class="text-2xl font-semibold tabular-nums">{{ summary.testCount }}</div>
          <div class="text-xs text-gray-500">Tests using AI steps</div>
        </div>
        <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
          <div class="text-2xl font-semibold tabular-nums">{{ summary.replayCount }}</div>
          <div class="text-xs text-gray-500">Total replays</div>
        </div>
      </div>

      <TableScroller min-width="40rem" :bleed="false">
        <UTable v-model:sorting="sorting" :data="artifacts" :columns="columns" sticky class="max-h-[32rem]">
          <template #entry-cell="{ row }">
            <span class="font-mono text-xs truncate block max-w-[28rem]" :title="row.original.entry">
              {{ entryName(row.original.entry) }}
            </span>
          </template>

          <template #testCount-cell="{ row }">
            <span class="tabular-nums">{{ row.original.testCount }}</span>
          </template>

          <template #replayCount-cell="{ row }">
            <span class="tabular-nums text-gray-500">{{ row.original.replayCount }}</span>
          </template>

          <template #lastSeen-cell="{ row }">
            <span class="tabular-nums text-gray-500" :title="row.original.lastSeen || ''">
              {{ relativeTime(row.original.lastSeen) }}
            </span>
          </template>
        </UTable>
      </TableScroller>
    </div>
  </UCard>
</template>

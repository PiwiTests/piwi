<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { ProjectOverview } from '~~/types/api';

const props = withDefaults(
  defineProps<{
    projects: ProjectOverview[];
    limit?: number;
  }>(),
  { limit: 10 },
);

type Row = ProjectOverview;

const TENDENCY_ORDER: Record<Row['tendency'], number> = { failing: 0, flaky: 1, passing: 2, unknown: 3 };

const tableExpanded = ref(false);
const hasMoreProjects = computed(() => props.projects.length > props.limit);

const sortedProjects = computed(() => {
  const sorted = [...props.projects].sort((a, b) => {
    const td = TENDENCY_ORDER[a.tendency] - TENDENCY_ORDER[b.tendency];
    if (td !== 0) return td;
    const at = a.latestFullRun ? new Date(a.latestFullRun.startTime).getTime() : 0;
    const bt = b.latestFullRun ? new Date(b.latestFullRun.startTime).getTime() : 0;
    return bt - at;
  });
  return tableExpanded.value ? sorted : sorted.slice(0, props.limit);
});

function tendencyStyle(t: Row['tendency']): string {
  switch (t) {
    case 'failing':
      return 'text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800';
    case 'flaky':
      return 'text-fuchsia-700 dark:text-fuchsia-400 bg-fuchsia-50 dark:bg-fuchsia-900/20 border-fuchsia-200 dark:border-fuchsia-800';
    case 'passing':
      return 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800';
    default:
      return 'text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700';
  }
}

function tendencyLabel(t: Row['tendency']): string {
  return t === 'unknown' ? 'Unknown' : t.charAt(0).toUpperCase() + t.slice(1);
}

function tendencyIcon(t: Row['tendency']): string {
  switch (t) {
    case 'failing':
      return 'i-lucide-trending-down';
    case 'flaky':
      return 'i-lucide-shuffle';
    case 'passing':
      return 'i-lucide-trending-up';
    default:
      return 'i-lucide-minus';
  }
}

const columns: TableColumn<Row>[] = [
  { accessorKey: 'name', header: 'Project' },
  { id: 'recentRuns', header: 'Last 20 runs' },
  { accessorKey: 'tendency', header: 'Tendency' },
  { id: 'passRate', header: 'Pass rate' },
  { id: 'latestRun', header: 'Latest run' },
  { id: 'tests', header: 'Tests' },
];
</script>

<template>
  <SectionCard icon="i-lucide-layout-dashboard" title="Project health" help="home.project-health">
    <template #actions>
      <UButton
        v-if="hasMoreProjects && !tableExpanded"
        variant="ghost"
        size="sm"
        trailing-icon="i-lucide-chevron-down"
        @click="tableExpanded = true"
      >
        Show all {{ props.projects.length }}
      </UButton>
      <UButton
        v-else-if="tableExpanded"
        variant="ghost"
        size="sm"
        trailing-icon="i-lucide-chevron-up"
        @click="tableExpanded = false"
      >
        Show less
      </UButton>
      <UButton to="/projects" variant="outline" size="sm">View all</UButton>
    </template>

    <!-- md+ : full trend table -->
    <div class="hidden md:block overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <UTable
        :data="sortedProjects"
        :columns="columns"
        :ui="{
          base: 'min-w-[700px]',
          td: 'py-3',
          th: 'py-3 text-xs uppercase tracking-wide',
        }"
      >
        <!-- Project name + tags -->
        <template #name-cell="{ row }">
          <NuxtLink
            :to="`/projects/${row.original.id}`"
            class="font-medium text-primary hover:underline truncate block max-w-[200px]"
          >
            {{ row.original.label || row.original.name }}
          </NuxtLink>
          <div v-if="row.original.tags.length > 0" class="flex flex-wrap gap-1 mt-0.5">
            <TagBadge v-for="tag in row.original.tags" :key="tag.id" :text="tag.text" :color="tag.color" />
          </div>
        </template>

        <!-- Trend bars -->
        <template #recentRuns-cell="{ row }">
          <div class="w-40">
            <MiniRunBars :runs="row.original.recentRuns" :height="28" />
          </div>
        </template>

        <!-- Tendency badge -->
        <template #tendency-cell="{ row }">
          <span
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium border whitespace-nowrap"
            :class="tendencyStyle(row.original.tendency)"
          >
            <UIcon :name="tendencyIcon(row.original.tendency)" class="size-3 shrink-0" />
            {{ tendencyLabel(row.original.tendency) }}
          </span>
        </template>

        <!-- Pass rate -->
        <template #passRate-cell="{ row }">
          <span
            v-if="row.original.latestFullRun"
            class="font-semibold tabular-nums text-sm"
            :class="passRateTextClass(passRate(row.original.latestFullRun))"
          >
            {{ passRate(row.original.latestFullRun) }}%
          </span>
          <span v-else class="text-gray-400 text-sm">—</span>
        </template>

        <!-- Latest run -->
        <template #latestRun-cell="{ row }">
          <NuxtLink
            v-if="row.original.latestFullRun"
            :to="`/test-runs/${row.original.latestFullRun.id}`"
            class="flex items-center gap-2 min-w-[140px] hover:opacity-80 transition-opacity"
          >
            <RunStatusBadge :status="row.original.latestFullRun.status" />
            <div class="text-xs text-gray-500 dark:text-gray-400">
              <div>{{ formatRelativeTime(row.original.latestFullRun.startTime) }}</div>
              <DurationValue v-if="row.original.latestFullRun.duration" :ms="row.original.latestFullRun.duration" />
            </div>
          </NuxtLink>
          <span v-else class="text-gray-400 text-sm">No full runs</span>
        </template>

        <!-- Tests passed/total -->
        <template #tests-cell="{ row }">
          <span v-if="row.original.latestFullRun" class="tabular-nums text-sm text-gray-600 dark:text-gray-400">
            {{ row.original.latestFullRun.passedTests }}/{{ row.original.latestFullRun.totalTests }}
          </span>
          <span v-else class="text-gray-400">—</span>
        </template>
      </UTable>
    </div>

    <!-- Below md : one card per project (no horizontal scroll) -->
    <div class="space-y-2 md:hidden">
      <div v-for="row in sortedProjects" :key="row.id" class="rounded-lg border border-default p-3 space-y-2">
        <div class="flex items-start justify-between gap-2">
          <NuxtLink :to="`/projects/${row.id}`" class="font-medium text-primary hover:underline truncate">
            {{ row.label || row.name }}
          </NuxtLink>
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap"
            :class="tendencyStyle(row.tendency)"
          >
            <UIcon :name="tendencyIcon(row.tendency)" class="size-3 shrink-0" />
            {{ tendencyLabel(row.tendency) }}
          </span>
        </div>

        <div v-if="row.tags.length > 0" class="flex flex-wrap gap-1">
          <TagBadge v-for="tag in row.tags" :key="tag.id" :text="tag.text" :color="tag.color" />
        </div>

        <MiniRunBars :runs="row.recentRuns" :height="24" />

        <div class="flex items-center justify-between gap-2 text-xs">
          <NuxtLink
            v-if="row.latestFullRun"
            :to="`/test-runs/${row.latestFullRun.id}`"
            class="flex items-center gap-1.5 min-w-0 hover:opacity-80"
          >
            <RunStatusBadge :status="row.latestFullRun.status" />
            <span class="text-gray-500 dark:text-gray-400 truncate">
              {{ formatRelativeTime(row.latestFullRun.startTime) }}
            </span>
          </NuxtLink>
          <span v-else class="text-gray-400">No full runs</span>

          <span v-if="row.latestFullRun" class="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
            <span class="font-semibold" :class="passRateTextClass(passRate(row.latestFullRun))">
              {{ passRate(row.latestFullRun) }}%
            </span>
            · {{ row.latestFullRun.passedTests }}/{{ row.latestFullRun.totalTests }}
          </span>
        </div>
      </div>
    </div>

    <EmptyState v-if="sortedProjects.length === 0" text="No projects yet" :padded="false" class="py-8" />
  </SectionCard>
</template>

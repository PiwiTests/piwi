<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { ProjectOverview } from '~~/types/api';
import { orderProjectHealth } from '~/utils/project-stars';

const props = withDefaults(
  defineProps<{
    projects: ProjectOverview[];
    limit?: number;
  }>(),
  { limit: 10 },
);

type Row = ProjectOverview;

const tableExpanded = useViewState('project-health-expanded', () => false);
const hasMoreProjects = computed(() => props.projects.length > props.limit);

// Starred projects first, then the rest, each by health; the preview cuts the combined list.
const stars = useStarredProjects();
const ordered = computed(() => orderProjectHealth(props.projects, stars.starred.value));
const sortedProjects = computed(() =>
  tableExpanded.value ? ordered.value.projects : ordered.value.projects.slice(0, props.limit),
);
/** How many of the shown rows are starred: the Starred divider ends after them. */
const shownStarred = computed(() => Math.min(ordered.value.starredCount, sortedProjects.value.length));
/** Whether the row at `index` is the first one after the starred rows. */
const startsUnstarred = (index: number) => shownStarred.value > 0 && index === shownStarred.value;

const tableMeta = computed(() => ({
  class: { tr: (row: { index: number }) => (startsUnstarred(row.index) ? 'border-t-2 border-t-default' : '') },
}));

function projectName(row: Row): string {
  return row.label || row.name;
}

/** Rows are keyed by project, so a starred row moves with its own button. */
const rowId = (row: Row) => String(row.id);

/** Focus the shown star of `projectId`, else the first shown star: its row moved, or left the preview. */
function refocusStar(projectId: number): void {
  const shown = (selector: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)].find((button) => button.offsetParent !== null);
  (shown(`[data-testid="project-star-${projectId}"]`) ?? shown('[data-testid^="project-star-"]'))?.focus();
}

/** Star or unstar from a row's button, which keeps the focus once its row has moved. */
async function toggleStar(projectId: number): Promise<void> {
  const hadFocus = import.meta.client && !!document.activeElement?.closest(`[data-testid="project-star-${projectId}"]`);
  const toggled = stars.toggle(projectId);
  if (!hadFocus) return toggled;
  await nextTick();
  refocusStar(projectId);
  // A refused change moves the row back.
  await toggled;
  await nextTick();
  refocusStar(projectId);
}

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
        :meta="tableMeta"
        :get-row-id="rowId"
        :ui="{
          base: 'min-w-[700px]',
          td: 'py-3',
          th: 'py-3 text-xs uppercase tracking-wide',
        }"
      >
        <template v-if="shownStarred > 0" #body-top>
          <tr data-testid="project-health-starred-divider">
            <td :colspan="columns.length" class="px-4 pt-3 pb-1 text-xs text-muted">Starred</td>
          </tr>
        </template>

        <!-- Star + project name + tags -->
        <template #name-cell="{ row }">
          <div class="flex items-start gap-1">
            <ProjectStarButton
              :project-id="row.original.id"
              :name="projectName(row.original)"
              :starred="stars.isStarred(row.original.id)"
              :pending="stars.isPending(row.original.id)"
              @toggle="toggleStar(row.original.id)"
            />
            <div class="min-w-0">
              <NuxtLink
                :to="`/projects/${row.original.id}`"
                class="font-medium text-primary hover:underline truncate block max-w-[200px]"
              >
                {{ projectName(row.original) }}
              </NuxtLink>
              <div v-if="row.original.tags.length > 0" class="flex flex-wrap gap-1 mt-0.5">
                <TagBadge v-for="tag in row.original.tags" :key="tag.id" :text="tag.text" :color="tag.color" />
              </div>
            </div>
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
            v-if="row.original.latestFullRun && runPassRate(row.original.latestFullRun) !== null"
            class="font-semibold tabular-nums text-sm"
            :class="passRateTextClass(runPassRate(row.original.latestFullRun))"
          >
            {{ runPassRate(row.original.latestFullRun) }}%
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
      <p v-if="shownStarred > 0" class="text-xs text-muted">Starred</p>
      <template v-for="(row, index) in sortedProjects" :key="row.id">
        <hr v-if="startsUnstarred(index)" class="border-default" />
        <div class="rounded-lg border border-default p-3 space-y-2">
          <div class="flex items-start justify-between gap-2">
            <div class="flex min-w-0 items-start gap-1">
              <ProjectStarButton
                :project-id="row.id"
                :name="projectName(row)"
                :starred="stars.isStarred(row.id)"
                :pending="stars.isPending(row.id)"
                @toggle="toggleStar(row.id)"
              />
              <NuxtLink :to="`/projects/${row.id}`" class="font-medium text-primary hover:underline truncate">
                {{ projectName(row) }}
              </NuxtLink>
            </div>
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
              <span class="font-semibold" :class="passRateTextClass(runPassRate(row.latestFullRun))">
                {{ runPassRate(row.latestFullRun) !== null ? `${runPassRate(row.latestFullRun)}%` : '—' }}
              </span>
              · {{ row.latestFullRun.passedTests }}/{{ row.latestFullRun.totalTests }}
            </span>
          </div>
        </div>
      </template>
    </div>

    <EmptyState v-if="sortedProjects.length === 0" text="No projects yet" :padded="false" class="py-8" />
  </SectionCard>
</template>

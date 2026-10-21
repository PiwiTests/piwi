<script setup lang="ts">
import { computed, ref } from 'vue';
import { z } from 'zod';
import type { TableColumn } from '@nuxt/ui';
import type { SortingState } from '@tanstack/vue-table';
import type { ProjectWithStats, TagInfo, TagsResponse } from '~~/types/api';
import type { DesktopFolderInspection } from '~/composables/useDesktopFolderInspect';
import { foldText } from '#shared/utils/fold-text';

useHead({ title: 'Projects — Piwi Dashboard' });

// Share the projects data already fetched by the layout (same key → single HTTP request, single SSE subscription).
// `lazy` so navigating to Projects is instant — a skeleton shows instead of blocking on the fetch.
const {
  data: projects,
  refresh,
  status: projectsStatus,
} = useFetch('/api/projects', {
  key: 'projects',
  lazy: true,
  default: () => [] as ProjectWithStats[],
  transform: (r: { items: ProjectWithStats[] }) => r.items,
  dedupe: 'defer',
  getCachedData: reuseWithinRender,
});
const { data: tagsData, refresh: refreshTags } = useFetch<TagsResponse>('/api/tags', { lazy: true });
const toast = useToast();
// Creating a project is an instance permission; editing one needs `project:manage` on it.
const { can } = useAuth();

const allTags = computed(() => tagsData.value?.items || []);

// Show a skeleton (not the "No projects yet" empty state) while the first load resolves.
const isInitialLoad = computed(() => projectsStatus.value === 'pending' && !projects.value?.length);

// Search, filter and sort state, kept for the page so it is still there when
// the user comes back from a project.
const searchQuery = useViewState('search', () => '');
const selectedTagIds = useViewState<number[]>('tags', () => []);
const sorting = useViewState<SortingState>('sorting', () => []);
useViewScroll(() => dashboardPanelBody('projects'));

const filteredProjects = computed(() => {
  let result = projects.value || [];

  if (searchQuery.value.trim()) {
    const q = foldText(searchQuery.value.trim());
    result = result.filter((p) => foldText(p.label || p.name).includes(q) || foldText(p.name).includes(q));
  }

  if (selectedTagIds.value.length > 0) {
    result = result.filter((p) => selectedTagIds.value.some((tagId) => (p.tags || []).some((t) => t.id === tagId)));
  }

  return result;
});

function toggleTagFilter(tagId: number) {
  const idx = selectedTagIds.value.indexOf(tagId);
  if (idx === -1) {
    selectedTagIds.value.push(tagId);
  } else {
    selectedTagIds.value.splice(idx, 1);
  }
}

function isTagFilterActive(tagId: number) {
  return selectedTagIds.value.includes(tagId);
}

// New Project modal
const isNewProjectModalOpen = ref(false);
const newProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(100),
  label: z.string().optional(),
  description: z.string().optional(),
});
type NewProjectSchema = z.output<typeof newProjectSchema>;
const newProject = reactive<Partial<NewProjectSchema>>({
  name: '',
  label: '',
  description: '',
});
const newProjectTags = ref<TagInfo[]>([]);
const creatingProject = ref(false);

// Desktop shell only: a folder picked to start the project from. Its inspection
// prefills the name; the folder is linked to the project once created.
const newProjectFolder = ref<string | null>(null);
const { propose: proposePrevRuns } = useDesktopImportPrevRuns();

function onFolderDetected(inspection: DesktopFolderInspection) {
  if (inspection.suggestedName) newProject.name = inspection.suggestedName;
}

// A folder picked for a dismissed modal must not silently attach to the next
// project created; the typed fields keep their draft behavior.
watch(isNewProjectModalOpen, (open) => {
  if (!open) newProjectFolder.value = null;
});

function resetNewProjectForm() {
  newProject.name = '';
  newProject.label = '';
  newProject.description = '';
  newProjectTags.value = [];
  newProjectFolder.value = null;
}

async function handleCreateProject() {
  if (!newProject.name?.trim()) return;
  try {
    creatingProject.value = true;
    const created = await $fetch<{ project: { id: number } }>('/api/projects', {
      method: 'POST',
      body: {
        name: newProject.name.trim(),
        label: newProject.label?.trim() || null,
        description: newProject.description?.trim() || null,
        tagIds: newProjectTags.value.map((t) => t.id),
      },
    });

    const folder = newProjectFolder.value;
    let folderLinked = false;
    if (folder && created?.project?.id != null) {
      try {
        await setDesktopProjectLink(created.project.id, folder);
        folderLinked = true;
        // Offer to backfill history from the runs already in the linked folder;
        // the proposal survives the navigation to the project page below.
        void proposePrevRuns(newProject.name?.trim(), folder);
      } catch (error) {
        toast.add({
          title: 'Project created, but the folder could not be linked',
          description: errorMessage(error),
          color: 'warning',
        });
      }
    }

    toast.add({
      title: 'Project created',
      description: folderLinked
        ? `Project "${newProject.name}" has been created and linked to its folder`
        : `Project "${newProject.name}" has been created`,
      color: 'success',
    });

    isNewProjectModalOpen.value = false;
    resetNewProjectForm();

    // A folder-backed project continues on its own page, where the linked
    // folder and reporter setup it just gained are shown.
    if (folderLinked && created?.project?.id != null) {
      await navigateTo(`/projects/${created.project.id}`);
      return;
    }

    await refresh();
  } catch (error: unknown) {
    const errorMessage =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({
      title: 'Failed to create project',
      description: errorMessage || 'An error occurred',
      color: 'error',
    });
  } finally {
    creatingProject.value = false;
  }
}

const columns: TableColumn<ProjectWithStats>[] = [
  {
    header: 'Project',
    columns: [
      {
        accessorKey: 'name',
        header: createSortHeader<ProjectWithStats>('Name'),
      },
      {
        accessorKey: 'totalRuns',
        header: createSortHeader<ProjectWithStats>('Runs'),
      },
    ],
  },
  {
    accessorKey: 'latestRunData',
    header: 'Latest run',
    columns: [
      {
        accessorKey: 'latestRun',
        header: createSortHeader<ProjectWithStats>('Date'),
      },
      {
        accessorKey: 'branch',
        header: 'Branch',
      },

      {
        accessorKey: 'duration',
        header: createSortHeader<ProjectWithStats>('Duration'),
      },
      {
        accessorKey: 'status',
        header: createSortHeader<ProjectWithStats>('Status'),
      },
      {
        accessorKey: 'testRatio',
        header: 'Test status',
      },
      {
        accessorKey: 'report',
        header: 'Reports',
      },
    ],
  },
  {
    accessorKey: 'actions',
    header: 'Project actions',
  },
];
</script>

<template>
  <UDashboardPanel id="projects">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <UBreadcrumb :items="[{ label: 'Home', icon: 'i-lucide-house', to: '/' }, { label: 'Projects' }]" />
        </template>
        <template #right>
          <NavbarActions
            :actions="[
              ...(can('project:create')
                ? [{ label: 'New project', icon: 'i-lucide-plus', onClick: () => (isNewProjectModalOpen = true) }]
                : []),
              { label: 'Refresh', icon: 'i-lucide-refresh-cw', variant: 'outline', onClick: () => refresh() },
            ]"
          >
            <template #leading>
              <HelpHint topic="projects.table" size="sm" />
            </template>
          </NavbarActions>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Search and filter toolbar -->
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <UInput
          v-model="searchQuery"
          icon="i-lucide-search"
          placeholder="Search projects by name..."
          class="min-w-48 flex-1"
          :ui="{ base: 'w-full' }"
        />

        <div v-if="allTags.length > 0" class="flex flex-wrap items-center gap-2">
          <span class="text-sm text-muted shrink-0 inline-flex items-center gap-1">
            Filter by tag (any match): <HelpHint topic="projects.tag-filter" />
          </span>
          <button
            v-for="tag in allTags"
            :key="tag.id"
            type="button"
            class="cursor-pointer focus:outline-none"
            @click="toggleTagFilter(tag.id)"
          >
            <TagBadge :text="tag.text" :color="tag.color" :variant="isTagFilterActive(tag.id) ? 'solid' : 'outline'" />
          </button>

          <UButton
            v-if="selectedTagIds.length > 0"
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-x"
            label="Clear filters"
            @click="selectedTagIds = []"
          />
        </div>
      </div>

      <TableScroller v-if="filteredProjects.length > 0" min-width="60rem" :bleed="false">
        <UTable
          v-model:sorting="sorting"
          :data="filteredProjects"
          :columns="columns"
          :ui="{
            base: 'table-fixed border-separate border-spacing-0',
            thead: '[&>tr]:bg-elevated/50 [&>tr]:after:content-none',
            tbody: '[&>tr]:last:[&>td]:border-b-0',
            th: 'first:rounded-l-lg last:rounded-r-lg border-y border-default first:border-l last:border-r',
            td: 'border-b border-default',
          }"
        >
          <template #name-cell="{ row }">
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <NuxtLink :to="`/projects/${row.original.id}`" class="text-primary hover:underline font-medium">
                  {{ row.original.label || row.original.name }}
                </NuxtLink>
              </div>
              <div v-if="row.original.tags?.length" class="flex flex-wrap gap-1">
                <TagBadge v-for="tag in row.original.tags" :key="tag.id" :text="tag.text" :color="tag.color" />
              </div>
            </div>
          </template>
          <template #totalRuns-cell="{ row }">
            <span v-if="row.original.totalRuns === 0" class="text-xs text-gray-600 italic">No data</span>
            <span v-else>{{ row.original.totalRuns }} runs</span>
          </template>
          <template #latestRun-cell="{ row }">
            <ClientDate
              v-if="row.original.latestRun"
              :date="row.original.latestRun.startTime"
              class="text-xs text-gray-600"
            />
            <span v-else class="text-xs text-gray-600 italic">No data</span>
          </template>
          <template #branch-cell="{ row }">
            <div v-if="row.original.latestRun?.metadata?.scm" class="flex items-center gap-1 flex-wrap">
              <BranchLabel
                v-if="row.original.latestRun.metadata.scm.branch"
                :name="row.original.latestRun.metadata.scm.branch"
                class="text-xs max-w-[12rem]"
              />
              <code v-if="row.original.latestRun.metadata.scm.commit" class="text-xs text-gray-500">
                {{ row.original.latestRun.metadata.scm.commit.substring(0, 7) }}
              </code>
            </div>
          </template>
          <template #duration-cell="{ row }">
            <DurationValue
              v-if="row.original.latestRun?.duration != null"
              :ms="row.original.latestRun.duration"
              class="text-sm text-gray-600"
            />
            <span v-else class="text-xs text-gray-600 italic">No data</span>
          </template>
          <template #status-cell="{ row }">
            <RunStatusBadge v-if="row.original.latestRun" :status="row.original.latestRun.status" />
            <span v-else class="text-xs text-gray-600 italic">No data</span>
          </template>
          <template #testRatio-cell="{ row }">
            <TestStatusBar
              v-if="row.original.latestRun"
              :passed="row.original.latestRun.passedTests"
              :failed="row.original.latestRun.failedTests"
              :skipped="row.original.latestRun.skippedTests"
              :fixme="row.original.latestRun.fixmeTests ?? 0"
              :flaky="row.original.latestRun.flakyTests"
              :did-not-run="row.original.latestRun.didNotRunTests ?? 0"
              :total="row.original.latestRun.totalTests"
            />
            <span v-else class="text-xs text-gray-600 italic">No data</span>
          </template>
          <template #report-cell="{ row }">
            <RunReports v-if="row.original.latestRun" :reports="row.original.latestRun.reports" />
          </template>
          <template #actions-header>
            <div class="text-right">Project actions</div>
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end gap-2">
              <UButton
                v-if="can('project:manage', row.original.id)"
                :to="`/projects/${row.original.id}/edit`"
                size="sm"
                variant="ghost"
                icon="i-lucide-pencil"
                :aria-label="`Edit ${row.original.label || row.original.name}`"
                title="Edit project"
              />
            </div>
          </template>
        </UTable>
      </TableScroller>

      <div v-else-if="isInitialLoad" class="space-y-2" aria-busy="true">
        <span class="sr-only" role="status">Loading projects…</span>
        <USkeleton class="h-10 w-full rounded-lg" />
        <USkeleton v-for="i in 6" :key="i" class="h-14 w-full rounded-lg" />
      </div>

      <div v-else-if="projects && projects.length > 0" class="text-center py-12 text-gray-500">
        <p class="text-lg mb-2">No projects match your search</p>
        <p class="text-sm">Try adjusting your search or filters</p>
      </div>

      <EmptyState v-else icon="i-lucide-rocket" text="No projects yet">
        <p class="text-xs text-gray-400 max-w-sm">
          Projects are created automatically once the reporter submits its first run —
          <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">npx @piwitests/reporter init</code> wires a Playwright
          project in one command. See the <NuxtLink to="/" class="text-primary hover:underline">home page</NuxtLink> for
          a copy-paste setup, or the
          <DocLink to="guide/getting-started#fast-path-one-command" no-icon class="text-primary hover:underline"
            >getting-started docs</DocLink
          >.
        </p>
        <UButton
          v-if="can('project:create')"
          icon="i-lucide-plus"
          label="New project"
          variant="ghost"
          size="sm"
          class="mt-2"
          @click="isNewProjectModalOpen = true"
        />
      </EmptyState>
    </template>
  </UDashboardPanel>

  <!-- New Project Modal -->
  <ClientOnly>
    <UModal :open="isNewProjectModalOpen" title="Create new project" @update:open="isNewProjectModalOpen = $event">
      <template #body>
        <div class="space-y-5">
          <!-- Desktop shell only: prefill from a checkout on this machine (renders nothing without the bridge). -->
          <DesktopNewProjectFolder v-model:folder="newProjectFolder" @detected="onFolderDetected" />

          <UForm :schema="newProjectSchema" :state="newProject">
            <ProjectFormFields
              mode="create"
              v-model:name="newProject.name"
              v-model:label="newProject.label"
              v-model:description="newProject.description"
              v-model:tags="newProjectTags"
              :all-tags="allTags"
              @tag-created="refreshTags()"
            />
          </UForm>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="isNewProjectModalOpen = false" />
          <UButton
            label="Create project"
            icon="i-lucide-plus"
            :loading="creatingProject"
            @click="handleCreateProject"
          />
        </div>
      </template>
    </UModal>
  </ClientOnly>
</template>

<script setup lang="ts">
/**
 * Import historical Playwright blob reports into this project, one archive per
 * request. Everything that can be decided without spending an upload — the size
 * limit, archives the project already has — is decided before any bytes move.
 */
import type { ProjectDetails } from '~~/types/api';

const route = useRoute();
const projectId = route.params.id as string;

const { data: project, error: projectError } = await useFetch<ProjectDetails>(`/api/projects/${projectId}`);
if (projectError.value) showPageLoadError(projectError.value, 'project');

useHead(
  computed(() => ({
    title: `Import runs — ${project.value?.label || project.value?.name || 'Project'} — Piwi Dashboard`,
  })),
);

/**
 * In the demo the whole import runs in the browser — the archive is parsed by
 * the service worker and stored in IndexedDB, so nothing is uploaded anywhere.
 * Worth saying plainly, since a visitor is being asked to hand over their own
 * test results.
 */
const isDemoMode = useRuntimeConfig().public.demoMode;

const projectName = computed(() => project.value?.name);
const {
  entries,
  maxBytes,
  limitError,
  importing,
  readyCount,
  importedCount,
  busy,
  batch,
  loadLimit,
  addFiles,
  addLocalPaths,
  startImport,
  remove,
  clearFinished,
} = useBlobReportImport(projectName);

onMounted(loadLimit);

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

// Desktop shell only: the folder linked to this project on this machine, so the
// native picker can open right where the reports are.
const { link } = useDesktopProjectLink(() => projectId);
const isDesktop = ref(false);
onMounted(() => {
  isDesktop.value = !!tauriCore();
});
const projectFolder = computed(() => (link.value?.exists ? link.value.path : null));

/**
 * In the desktop shell, browse with the native picker — filtered to `.zip` and
 * opened at the project's linked folder — and import the chosen files straight
 * from disk. In a plain browser, fall back to the file input (which cannot be
 * pointed at a folder).
 */
async function onChooseFiles() {
  if (isDesktop.value) {
    const picked = await pickDesktopImportFiles(projectFolder.value);
    if (picked.length) addLocalPaths(picked);
    return;
  }
  fileInput.value?.click();
}

function onPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) addFiles([...input.files]);
  // Reset so re-picking the same file fires `change` again.
  input.value = '';
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  const dropped = [...(event.dataTransfer?.files ?? [])];
  if (dropped.length) addFiles(dropped);
}

const finishedCount = computed(() => entries.value.filter((e) => ['imported', 'duplicate'].includes(e.state)).length);
</script>

<template>
  <UDashboardPanel id="project-import">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav
            :items="[
              { label: 'Home', icon: 'i-lucide-house', to: '/' },
              { label: 'Projects', to: '/projects' },
              { label: project?.label || project?.name || 'Project', to: `/projects/${projectId}` },
              { label: 'Import runs' },
            ]"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="space-y-4 max-sm:px-4">
        <SectionCard
          title="Import past runs"
          icon="i-lucide-import"
          help="project.import"
          subtitle="Backfill runs recorded before you started using Piwi, from Playwright's own blob reports."
          data-tour="import-runs"
        >
          <div class="space-y-4">
            <div class="text-sm text-gray-600 dark:text-gray-400 space-y-2">
              <p>
                Run your suite with the blob reporter and upload the archives it writes to
                <code>blob-report/</code>:
              </p>
              <CodeBlock code="npx playwright test --reporter=blob" language="bash" />
              <p>
                Each archive imports as one completed run, with its traces, screenshots and videos. Importing the same
                archive twice does nothing, so an interrupted batch is safe to repeat.
              </p>
            </div>

            <UAlert
              v-if="isDemoMode"
              color="primary"
              variant="subtle"
              icon="i-lucide-monitor-smartphone"
              title="Nothing leaves your browser"
              description="This is the demo: the archive is read by a service worker and stored in your browser, not uploaded. It is cleared when the demo's sample data is refreshed, or when you reset the demo."
              :ui="{ description: 'text-xs' }"
            />

            <UAlert
              color="neutral"
              variant="subtle"
              icon="i-lucide-info"
              title="What imported runs carry"
              description="Failures still cluster, and traces, screenshots and videos open exactly as they do for reported runs. Web vitals, page state and locator healing come from Piwi's own capture fixtures, so historical runs have none — they start once the reporter is in place."
              :ui="{ description: 'text-xs' }"
            />

            <UAlert
              v-if="limitError"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              :description="limitError"
            />
          </div>
        </SectionCard>

        <SectionCard title="Archives" icon="i-lucide-files" :count="entries.length || null">
          <template #actions>
            <div class="flex items-center gap-2">
              <span v-if="importing" class="text-xs text-gray-500 tabular-nums">
                {{ batch.done }} of {{ batch.total }} done
              </span>
              <UButton
                v-if="finishedCount > 0 && !importing"
                label="Clear finished"
                icon="i-lucide-eraser"
                color="neutral"
                variant="ghost"
                size="sm"
                :disabled="importing"
                @click="clearFinished()"
              />
              <UButton
                :label="readyCount > 0 ? `Import ${readyCount} archive${readyCount === 1 ? '' : 's'}` : 'Import'"
                icon="i-lucide-upload"
                size="sm"
                :loading="importing"
                :disabled="readyCount === 0 || busy"
                @click="startImport()"
              />
            </div>
          </template>

          <div class="space-y-4">
            <div
              class="rounded-lg border-2 border-dashed p-6 text-center transition-colors"
              :class="dragging ? 'border-primary bg-primary/5' : 'border-gray-200 dark:border-gray-700'"
              @dragover.prevent="dragging = true"
              @dragleave.prevent="dragging = false"
              @drop.prevent="onDrop"
            >
              <UIcon name="i-lucide-file-archive" class="size-7 text-gray-400 mb-2" />
              <p class="text-sm text-gray-600 dark:text-gray-400">Drop <code>report-*.zip</code> files here, or</p>
              <UButton
                label="Choose files"
                icon="i-lucide-folder-open"
                data-tour="import-choose-files"
                variant="outline"
                size="sm"
                class="mt-2"
                :disabled="importing"
                :title="isDesktop && projectFolder ? `Opens in ${projectFolder}` : undefined"
                @click="onChooseFiles"
              />
              <p v-if="isDesktop && projectFolder" class="text-xs text-gray-500 mt-2 break-all">
                Opens in <code>{{ projectFolder }}</code>
              </p>
              <p v-if="maxBytes" class="text-xs text-gray-500 mt-3">
                Up to {{ formatBytes(maxBytes) }} per archive. Larger ones are rejected here, before uploading.
              </p>
              <input ref="fileInput" type="file" accept=".zip" multiple class="hidden" @change="onPicked" />
            </div>

            <EmptyState v-if="entries.length === 0" icon="i-lucide-inbox" text="No archives selected yet." />

            <div
              v-else
              class="divide-y divide-gray-100 dark:divide-gray-800 border rounded-lg border-gray-200 dark:border-gray-800"
            >
              <ImportFileRow
                v-for="entry in entries"
                :key="entry.id"
                :entry="entry"
                :removable="!importing && entry.state !== 'uploading'"
                @remove="remove"
              />
            </div>

            <div v-if="importedCount > 0" class="flex justify-end">
              <UButton
                :label="`Open ${project?.label || project?.name || 'project'}`"
                icon="i-lucide-arrow-right"
                trailing
                variant="ghost"
                size="sm"
                :to="`/projects/${projectId}`"
              />
            </div>
          </div>
        </SectionCard>
      </div>
    </template>
  </UDashboardPanel>
</template>

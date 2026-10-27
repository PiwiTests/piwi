<script setup lang="ts">
import type { StorageAnalysis } from '~~/types/api';
import { envVarsByCategory, getEnvVarMeta } from '#shared/piwi-env-vars';

const toast = useToast();

// Client-only: the growth chart formats dates, so keep it off the server render
// to avoid a timezone hydration mismatch (matches the analytics widgets).
const {
  data: storage,
  refresh,
  status,
  error,
} = useFetch<StorageAnalysis>('/api/admin/storage', { lazy: true, server: false });
// The server renders before the fetch starts (`idle`), so idle reads as loading too.
const loading = computed(() => status.value === 'idle' || status.value === 'pending');

// Storage-backend env vars, driven by the shared registry (single source of
// truth). Excludes test-only vars (they are not runtime settings).
const storageEnvVars = envVarsByCategory('storage').map((name) => ({
  name,
  ...getEnvVarMeta(name),
}));

const periodOptions = [
  { label: '7 days', value: 7 },
  { label: '14 days', value: 14 },
  { label: '30 days', value: 30 },
  { label: '60 days', value: 60 },
  { label: '90 days', value: 90 },
  { label: '180 days', value: 180 },
  { label: '1 year', value: 365 },
];

const selectedPeriod = ref(30);
const isConfirmOpen = ref(false);
const cleaning = ref(false);

async function handleCleanup() {
  isConfirmOpen.value = false;
  cleaning.value = true;
  try {
    const result = await $fetch<{
      success: boolean;
      deletedRuns: number;
      keptRunsSkipped?: number;
      newestRunsSkipped?: number;
    }>('/api/admin/cleanup', {
      method: 'DELETE',
      body: { olderThanDays: selectedPeriod.value },
    });
    const skipped = [
      result.keptRunsSkipped ? `${result.keptRunsSkipped} kept` : null,
      result.newestRunsSkipped ? `${result.newestRunsSkipped} among their project's newest` : null,
    ].filter(Boolean);
    toast.add({
      title: 'Cleanup complete',
      description:
        `Deleted ${result.deletedRuns} test run(s) older than ${selectedPeriod.value} days.` +
        (skipped.length ? ` Skipped ${skipped.join(' and ')}.` : ''),
      color: 'success',
    });
    await refresh();
  } catch (error: unknown) {
    const errorMessage =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({
      title: 'Cleanup failed',
      description: errorMessage || 'An error occurred',
      color: 'error',
    });
  } finally {
    cleaning.value = false;
  }
}
</script>

<template>
  <div class="space-y-6" data-tour="storage-page">
    <!-- Data location (resolved on-disk paths) -->
    <DataLocationCard
      v-if="storage"
      :database="storage.databaseLocation"
      :storage="storage.storageLocation"
      data-tour="storage-data-location"
    />

    <!-- Storage backend (env-only reference) -->
    <SectionCard
      icon="i-lucide-server"
      title="Storage backend"
      help="settings.storage-backend"
      data-tour="storage-backend"
    >
      <template #subtitle> Configured through environment variables. The active backend is shown read-only. </template>

      <div class="space-y-3">
        <div class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-info" class="size-4" />
          Storage backend selection (local disk or S3) and its credentials are set via the environment. Each variable
          below is shown read-only — hover the lock to see what it controls.
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <template v-for="v in storageEnvVars" :key="v.name">
            <div class="text-muted">{{ v.name.replace('PIWI_S3_', 'S3 ').replace('PIWI_STORAGE_', 'Storage ') }}</div>
            <div class="flex items-center gap-2 font-mono">
              <code class="text-xs">{{ v.name }}</code>
              <EnvManagedBadge :env-vars="[v.name]" />
            </div>
          </template>
        </div>
      </div>
    </SectionCard>

    <!-- Storage analysis: usage, growth over time, by file kind, by project -->
    <StorageAnalysisDashboard :analysis="storage ?? null" :pending="loading" :error="error" @refresh="refresh()" />

    <!-- Cleanup Section -->
    <SectionCard
      icon="i-lucide-trash-2"
      title="Cleanup old test runs"
      help="settings.cleanup"
      data-shot="cleanup-card"
      data-tour="storage-cleanup"
    >
      <p v-if="storage?.kept" class="text-xs text-muted mb-3" data-shot="kept-runs-note">
        <template v-if="storage.kept.runs > 0">
          {{ storage.kept.runs }} kept {{ storage.kept.runs === 1 ? 'run is' : 'runs are' }} never deleted — they hold
          {{ formatBytes(storage.kept.bytes) }} in {{ storage.kept.files.toLocaleString() }}
          {{ storage.kept.files === 1 ? 'file' : 'files' }} of their own.
        </template>
        <template v-else>No run is kept forever. Keep one from its run menu to exempt it from cleanup.</template>
      </p>
      <div class="flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <UFormField label="Delete runs older than" name="period">
          <USelect v-model="selectedPeriod" :items="periodOptions" />
        </UFormField>

        <UButton
          icon="i-lucide-trash-2"
          color="error"
          variant="soft"
          :loading="cleaning"
          label="Run cleanup"
          class="mt-4 sm:mt-5"
          data-tour="run-storage-cleanup"
          @click="isConfirmOpen = true"
        />
      </div>
    </SectionCard>
  </div>

  <!-- Confirm Dialog -->
  <ClientOnly>
    <UModal :open="isConfirmOpen" title="Confirm cleanup" @update:open="isConfirmOpen = $event">
      <template #body>
        <p>
          This will permanently delete all test runs older than <strong>{{ selectedPeriod }} days</strong>, along with
          their associated reports, traces, and test results. Kept runs are skipped. This action cannot be undone.
        </p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="isConfirmOpen = false" />
        <UButton color="error" label="Delete" icon="i-lucide-trash-2" :loading="cleaning" @click="handleCleanup" />
      </template>
    </UModal>
  </ClientOnly>
</template>

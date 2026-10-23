<script setup lang="ts">
import type { ReportInfo, TestRunDetails } from '~~/types/api';

/**
 * Compact storage fact for the run meta strip: total size and file count,
 * with the per-report breakdown in a popover. While the run is finalizing it
 * shows the upload progress instead.
 */
defineProps<{
  storageStats?: TestRunDetails['storageStats'];
  reports: ReportInfo[];
  finalizing?: boolean;
}>();

const config = useRuntimeConfig();
const { onOpenReport } = useDesktopReportLink();
</script>

<template>
  <div v-if="finalizing" class="inline-flex items-center gap-2 text-info">
    <UIcon name="i-lucide-upload" class="size-3.5 shrink-0 animate-pulse" />
    <span class="text-xs font-medium whitespace-nowrap">Uploading reports &amp; traces…</span>
    <UProgress :value="null" size="sm" color="info" class="w-24 rounded-full animate-pulse" />
  </div>
  <UPopover v-else-if="storageStats?.totalFiles">
    <button
      type="button"
      class="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -my-0.5 -ml-1.5 text-muted hover:text-default hover:bg-elevated/60 transition-colors cursor-pointer"
      title="Stored reports & artifacts"
      data-tour="run-storage"
    >
      <UIcon name="i-lucide-database" class="size-3.5 text-dimmed shrink-0" />
      <span class="tabular-nums whitespace-nowrap">
        {{ formatBytes(storageStats.totalSize) }}
        <span class="text-dimmed"
          >· {{ storageStats.totalFiles }} file{{ storageStats.totalFiles === 1 ? '' : 's' }}</span
        >
      </span>
      <UIcon name="i-lucide-chevron-down" class="size-3 text-dimmed shrink-0" />
    </button>
    <template #content>
      <div class="p-3 w-72 space-y-2" data-tour="run-stored-artifacts">
        <p class="text-xs font-medium text-muted inline-flex items-center gap-1">
          Stored artifacts <HelpHint topic="run.reports" />
        </p>
        <div
          v-for="report in reports"
          :key="`${report.type}-${report.path}`"
          class="flex items-center justify-between gap-2 min-w-0"
        >
          <UButton
            :href="fileApiUrl(report.path, null, config.app?.baseURL)"
            :icon="reportIcon(report.type)"
            target="_blank"
            size="xs"
            variant="outline"
            class="min-w-0"
            :ui="{ label: 'truncate' }"
            @click="onOpenReport($event, report)"
          >
            {{ report.label }}
          </UButton>
          <span class="text-xs tabular-nums text-dimmed shrink-0">{{ formatBytes(report.size) }}</span>
        </div>
        <div
          v-if="storageStats.testCaseFilesCount > 0"
          class="flex items-center justify-between gap-2 text-sm border-t border-default pt-2"
        >
          <span class="truncate">Test files ({{ storageStats.testCaseFilesCount }})</span>
          <span class="text-xs tabular-nums text-dimmed shrink-0">{{
            formatBytes(storageStats.testCaseFilesSize)
          }}</span>
        </div>
      </div>
    </template>
  </UPopover>
</template>

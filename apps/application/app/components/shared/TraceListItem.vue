<script setup lang="ts">
import type { TraceInfo } from '~~/types/api';

const props = withDefaults(
  defineProps<{
    trace: TraceInfo;
    showTime?: boolean;
  }>(),
  {
    showTime: true,
  },
);

const { name, viewUrl, viewUnavailable, downloadUrl, onView, onDownload } = useTraceLinks(() => props.trace);
</script>

<template>
  <div class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-2 min-w-0">
      <UIcon name="i-lucide-file-archive" class="size-4 text-gray-400 shrink-0" />
      <span class="text-sm truncate" :title="trace.filePath">{{ name }}</span>
      <span v-if="trace.size" class="text-xs text-gray-400 shrink-0">{{ formatBytes(trace.size) }}</span>
      <span v-if="showTime" class="text-xs text-gray-400 shrink-0">{{ formatRelativeTime(trace.createdAt) }}</span>
    </div>
    <div class="flex items-center gap-1.5 shrink-0">
      <UButton
        :to="viewUrl ?? undefined"
        target="_blank"
        icon="i-lucide-bug-play"
        size="xs"
        color="neutral"
        variant="outline"
        label="Open trace"
        :disabled="!!viewUnavailable"
        :title="viewUnavailable ?? undefined"
        @click="onView"
      />
      <UButton
        :to="downloadUrl ?? undefined"
        target="_blank"
        icon="i-lucide-download"
        size="xs"
        color="neutral"
        variant="ghost"
        label="Download"
        @click="onDownload"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DiagnoseImage } from '~/composables/useClusterDiagnosis';
import { formatRelativeTime } from '~/utils';
import { failurePageFirst } from '#shared/file-classify';

interface AffectedCase {
  recentTestRunsCaseId: number;
  title: string;
}

interface ScreenshotItem {
  src: string;
  data: string;
  mediaType: string;
  name: string;
  selected: boolean;
  caseTitle: string;
  status: string;
  retries: number;
  browser: string | null;
  startTime: string | null;
}

const props = defineProps<{
  affectedTestCases: AffectedCase[];
}>();

const emit = defineEmits<{
  (e: 'update:images', images: DiagnoseImage[]): void;
}>();

const config = useRuntimeConfig();

const MAX_SCREENSHOTS = 8;

async function blobToBase64(blob: Blob): Promise<{ data: string; mediaType: string }> {
  const mediaType = (blob.type || 'image/webp').split(';')[0]!.trim();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const part = (reader.result as string).split(',')[1];
      if (part != null) resolve({ data: part, mediaType });
      else reject(new Error('Failed to read blob'));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const screenshots = ref<ScreenshotItem[]>([]);
const loading = ref(false);

async function loadScreenshots() {
  if (!props.affectedTestCases.length) return;
  loading.value = true;
  screenshots.value = [];
  const results: ScreenshotItem[] = [];

  for (const tc of props.affectedTestCases) {
    if (results.length >= MAX_SCREENSHOTS) break;
    try {
      const detail = await $fetch<{
        attachments: Array<{ path: string; contentType: string | null; name: string | null }>;
        status: string;
        retries: number;
        browser: string | null;
        testRun: { startTime: string | null } | null;
      }>(`/api/test-run-cases/${tc.recentTestRunsCaseId}`);
      const images = (detail.attachments ?? []).filter((att) => isImageFile(att.path, att.contentType));
      // The page the test failed on first, so the image limit keeps it.
      for (const att of failurePageFirst(images, (a) => a.name)) {
        if (results.length >= MAX_SCREENSHOTS) break;
        const imgName = att.name || att.path.split('/').pop() || 'screenshot';
        const url = fileApiUrl(att.path, att.contentType, config.app?.baseURL, true);
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const blob = await res.blob();
          const { data, mediaType } = await blobToBase64(blob);
          results.push({
            src: `data:${mediaType};base64,${data}`,
            data,
            mediaType,
            name: imgName,
            selected: true,
            caseTitle: tc.title,
            status: detail.status,
            retries: detail.retries,
            browser: detail.browser,
            startTime: detail.testRun?.startTime ?? null,
          });
        } catch {
          // skip images that fail to fetch
        }
      }
    } catch {
      // skip cases that fail to fetch
    }
  }

  screenshots.value = results;
  loading.value = false;
  emitSelected();
}

function emitSelected() {
  emit(
    'update:images',
    screenshots.value.filter((s) => s.selected).map(({ name, mediaType, data }) => ({ name, mediaType, data })),
  );
}

function toggle(i: number) {
  screenshots.value[i]!.selected = !screenshots.value[i]!.selected;
  emitSelected();
}

function selectAll() {
  screenshots.value.forEach((s) => (s.selected = true));
  emitSelected();
}

function deselectAll() {
  screenshots.value.forEach((s) => (s.selected = false));
  emitSelected();
}

const selectedCount = computed(() => screenshots.value.filter((s) => s.selected).length);

onMounted(loadScreenshots);
</script>

<template>
  <div v-if="loading" class="flex items-center gap-1.5 text-xs text-gray-400 py-1">
    <UIcon name="i-lucide-loader-2" class="size-3 animate-spin" />
    Loading screenshots from test evidence&hellip;
  </div>
  <div v-else-if="screenshots.length" class="space-y-1.5">
    <div class="flex items-center justify-between">
      <span class="text-xs font-medium text-gray-500">
        Test screenshots
        <span class="text-gray-400 font-normal">({{ selectedCount }}/{{ screenshots.length }} will be sent to AI)</span>
      </span>
      <div class="flex gap-0.5">
        <UButton size="xs" color="neutral" variant="ghost" @click="selectAll">All</UButton>
        <UButton size="xs" color="neutral" variant="ghost" @click="deselectAll">None</UButton>
      </div>
    </div>
    <div class="grid grid-cols-4 gap-1.5">
      <div
        v-for="(img, i) in screenshots"
        :key="i"
        class="cursor-pointer rounded overflow-hidden border-2 transition-all"
        :class="img.selected ? 'border-primary' : 'border-default opacity-50'"
        @click="toggle(i)"
      >
        <div class="relative">
          <img :src="img.src" :alt="img.name" class="w-full h-14 object-cover object-top" />
          <div class="absolute top-0.5 right-0.5">
            <UIcon
              :name="img.selected ? 'i-lucide-check-circle-2' : 'i-lucide-circle'"
              class="size-3.5 drop-shadow"
              :class="img.selected ? 'text-primary' : 'text-gray-300'"
            />
          </div>
        </div>
        <div class="px-1 py-0.5 bg-elevated space-y-0.5">
          <p
            class="text-[9px] text-gray-700 dark:text-gray-300 truncate font-medium leading-tight"
            :title="img.caseTitle"
          >
            {{ img.caseTitle }}
          </p>
          <div class="flex items-center gap-1 flex-wrap">
            <span
              class="text-[8px] px-1 rounded leading-tight font-medium"
              :class="
                img.status === 'passed'
                  ? 'bg-success/15 text-success'
                  : img.status === 'failed'
                    ? 'bg-error/15 text-error'
                    : 'bg-neutral/15 text-gray-500'
              "
              >{{ img.status }}</span
            >
            <span v-if="img.retries > 0" class="text-[8px] text-gray-400 leading-tight">retry {{ img.retries }}</span>
            <span v-if="img.browser" class="text-[8px] text-gray-400 leading-tight truncate">{{ img.browser }}</span>
            <span v-if="img.startTime" class="text-[8px] text-gray-400 leading-tight ml-auto">{{
              formatRelativeTime(img.startTime)
            }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

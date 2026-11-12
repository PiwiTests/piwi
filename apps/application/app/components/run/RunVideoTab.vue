<script setup lang="ts">
/**
 * The run's Video tab: the videos its tests recorded, played one after another beside a checklist of the tests, by
 * worker or by file. Fetched when the tab opens, from `GET /api/test-runs/:id/videos`.
 */
import type { RunVideos } from '#shared/handlers/run-videos';
import { buildReel, type ReelGroup } from '#shared/video-reel';

const props = defineProps<{ runId: number }>();

const data = ref<RunVideos | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await $fetch<RunVideos>(`/api/test-runs/${props.runId}/videos`);
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || 'Failed to load videos';
  } finally {
    loading.value = false;
  }
}

watch(() => props.runId, load, { immediate: true });

const group = ref<ReelGroup>('worker');
const groupItems = [
  { key: 'worker' as const, label: 'Worker' },
  { key: 'file' as const, label: 'File' },
];

const reels = computed(() => buildReel(data.value?.executions ?? [], group.value));
const chosenKey = ref<string | null>(null);
/** The reel on show: the one picked, else the first worker with a video. */
const reel = computed(
  () => reels.value.find((r) => r.key === chosenKey.value) ?? reels.value.find((r) => r.videoCount > 0) ?? null,
);
const laneItems = computed(() =>
  reels.value.map((r) => ({
    label: `${r.label} (${r.videoCount} ${r.videoCount === 1 ? 'video' : 'videos'})`,
    value: r.key,
  })),
);
const laneModel = computed({
  get: () => reel.value?.key,
  set: (key) => (chosenKey.value = key ?? null),
});
watch(group, () => (chosenKey.value = null));
</script>

<template>
  <div class="p-4" data-shot="run-video-tab">
    <ErrorState v-if="error" :text="error" padded>
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" @click="load">Retry</UButton>
      </template>
    </ErrorState>

    <LoadingState v-else-if="loading && !data" padded />

    <EmptyState v-else-if="!reel" icon="i-lucide-video-off" text="No videos in this run">
      <p class="text-sm text-muted max-w-sm text-center">
        Most suites keep video only for failing tests (<span class="font-mono">video: 'retain-on-failure'</span>), so a
        run with no failure often has none.
        <DocLink to="features/evidence#the-video-tab" />
      </p>
    </EmptyState>

    <div v-else class="space-y-3">
      <div class="flex flex-wrap items-center gap-3">
        <SegmentedSwitch v-model="group" :items="groupItems" aria-label="Group by" />
        <USelect
          v-if="group === 'worker' && reels.length > 1"
          v-model="laneModel"
          :items="laneItems"
          value-key="value"
          size="sm"
          class="w-full sm:w-64"
          aria-label="Worker"
        />
        <p v-if="group === 'file'" class="text-xs text-muted">Tests ran in parallel; played here in file order</p>
      </div>
      <RunVideoReel :key="`${group}:${reel.key}`" :reel="reel" :group="group" />
    </div>
  </div>
</template>

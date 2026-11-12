<script setup lang="ts">
/**
 * The video review opened from a test's Evidence: the run Video tab's player, bar and checklist (`RunVideoReel`) in a
 * modal, around the test on show. This test (default) plays that test's own span in its video, with the other tests of
 * its file listed dimmed. Whole file plays the file's final attempts in declared order, each tagged with its worker.
 * Its worker plays the run's reel of the test's parallel slot. Both of those start at the test.
 *
 * An earlier attempt has its own video and no place on a reel of final attempts, so it can only be played alone; a
 * test the run's video list was cut before is the same. The list is fetched when the modal opens, from
 * `GET /api/test-runs/:id/videos`. Closing the modal unmounts the reel, which stops both `<video>` elements and
 * takes their sources off.
 */
import type { RunVideos } from '#shared/handlers/run-videos';
import {
  MAX_LISTED_EXECUTIONS as LISTED_LIMIT,
  focusExecution,
  focusLimit,
  focusReel,
  type FocusDetail,
  type FocusMode,
  type ReelVideo,
} from '#shared/video-reel';

const props = defineProps<{
  /** The fetched execution the Evidence shows. */
  testCase: any;
  /** The video the execution recorded, as the Screen tab plays it. */
  video: ReelVideo;
}>();
const open = defineModel<boolean>('open', { default: false });

const data = ref<RunVideos | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const runId = computed<number | null>(() => props.testCase?.testRun?.id ?? null);

async function load() {
  if (runId.value == null) return;
  loading.value = true;
  error.value = null;
  try {
    data.value = await $fetch<RunVideos>(`/api/test-runs/${runId.value}/videos`);
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || 'Failed to load videos';
  } finally {
    loading.value = false;
  }
}

// Fetched each time the modal opens, so a run that finished meanwhile is read again.
watch(open, (isOpen) => {
  if (isOpen) {
    mode.value = 'test';
    void load();
  }
});

const mode = ref<FocusMode>('test');

const executions = computed(() => data.value?.executions ?? []);
const focus = computed(() => focusExecution(props.testCase as FocusDetail, props.video, executions.value));
const limit = computed(() => focusLimit(executions.value, focus.value));

const LIMIT_TITLE = {
  'earlier-attempt': 'Only final attempts are in the file and worker reels',
  'not-listed': `This test is not on the run's video list, which holds at most ${LISTED_LIMIT.toLocaleString()} tests with a video`,
} as const;

const modeItems = computed(() => {
  const off = limit.value != null;
  const title = off ? LIMIT_TITLE[limit.value!] : undefined;
  return [
    { key: 'test' as const, label: 'This test' },
    { key: 'file' as const, label: 'Whole file', disabled: off, title },
    { key: 'worker' as const, label: 'Its worker', disabled: off, title },
  ];
});

const focused = computed(() => focusReel(executions.value, focus.value, limit.value ? 'test' : mode.value));
const group = computed(() => (mode.value === 'file' && !limit.value ? 'file' : 'worker'));
</script>

<template>
  <UModal
    v-model:open="open"
    title="Video review"
    :description="testCase?.title"
    :ui="{
      content:
        'sm:w-[calc(100vw-4rem)] sm:max-w-6xl max-sm:inset-0 max-sm:translate-0 max-sm:w-screen max-sm:max-w-none max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none max-sm:ring-0',
      header: 'flex-wrap gap-x-4 gap-y-2 py-3 pe-14 sm:pe-16',
      wrapper: 'min-w-0 flex-1 basis-40',
      body: 'overflow-y-auto',
    }"
  >
    <template #actions>
      <SegmentedSwitch v-model="mode" :items="modeItems" aria-label="Show" />
    </template>
    <template #body>
      <div data-shot="video-review">
        <ErrorState v-if="error" :text="error" padded>
          <template #action>
            <UButton size="sm" color="neutral" variant="outline" @click="load">Retry</UButton>
          </template>
        </ErrorState>

        <LoadingState v-else-if="loading || !data" padded />

        <div v-else-if="focused" class="space-y-3">
          <p v-if="mode === 'file' && !limit" class="text-xs text-muted">
            Tests ran in parallel; played here in file order
          </p>
          <p v-else-if="mode === 'worker' && !limit" class="text-xs text-muted">
            The tests of the same worker slot, in the order they ran
          </p>
          <p v-else-if="limit === 'earlier-attempt'" class="text-xs text-muted">
            This is an earlier attempt: its own video plays here.
          </p>
          <p v-if="data.truncated" class="text-xs text-muted">
            This run has more tests than the list holds: the first {{ LISTED_LIMIT.toLocaleString() }} with a video and
            the first {{ LISTED_LIMIT.toLocaleString() }} without.
          </p>
          <RunVideoReel
            :key="`${mode}:${focused.reel.key}`"
            :reel="focused.reel"
            :group="group"
            :focus-id="focus.executionId"
            :start-index="focused.focusIndex"
          />
        </div>

        <EmptyState v-else icon="i-lucide-video-off" text="This test's video is not on the run's reel" />
      </div>
    </template>
  </UModal>
</template>

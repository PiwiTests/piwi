<script setup lang="ts">
/**
 * One reel of the Video tab: the video on show, the bar with a block for each test, and the checklist of the tests.
 * The reel's playing is `useReelPlayer`.
 */
import type { Reel, ReelEntry, ReelGroup } from '#shared/video-reel';
import { SELECTED_ROW_CLASS, formatDuration, getStatusIcon } from '~/utils';
import { statusPalette } from '~/utils/status-palette';

const props = defineProps<{ reel: Reel; group: ReelGroup }>();

const player = useReelPlayer(toRef(props, 'reel'));
const { current, ticked, failed, playing } = player;

/** A test with no video takes this much of the bar, whatever its duration. */
const STUB_WIDTH = '12px';
/** No block of the bar is narrower than this; a reel of more tests than fit scrolls the bar sideways. */
const MIN_BLOCK_WIDTH = '3px';

function resultStatus(entry: ReelEntry): string {
  const { status, passedAfterFailure } = entry.execution;
  return status === 'passed' && passedAfterFailure ? 'flaky' : status;
}
function palette(entry: ReelEntry) {
  return statusPalette(entry.execution.status, entry.execution.passedAfterFailure);
}
const playingEntry = computed(() => (current.value == null ? null : props.reel.entries[current.value]!));
const tickedCount = computed(() => ticked.value.filter(Boolean).length);

const bar = ref<HTMLElement | null>(null);
const blocks = ref<HTMLElement[]>([]);
/** Keeps the playing block in view in a bar that scrolls, by moving the bar alone: the page does not scroll. */
watch(current, async (index) => {
  await nextTick();
  const el = bar.value;
  const block = index == null ? null : blocks.value.find((b) => b.dataset.index === String(index));
  if (!el || !block || el.scrollWidth <= el.clientWidth) return;
  const barBox = el.getBoundingClientRect();
  const box = block.getBoundingClientRect();
  if (box.left < barBox.left) el.scrollLeft += box.left - barBox.left;
  else if (box.right > barBox.right) el.scrollLeft += box.right - barBox.right;
});

function seekFromBar(index: number, event: MouseEvent) {
  const entry = props.reel.entries[index]!;
  if (!entry.execution.video) {
    const next = props.reel.entries.findIndex((e, i) => i > index && e.execution.video && !failed.has(i));
    if (next >= 0) void player.seekTo(next, 0);
    return;
  }
  if (failed.has(index)) return;
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  player.seekToFraction(index, (event.clientX - box.left) / box.width);
}

function blockLabel(entry: ReelEntry): string {
  return `${entry.execution.title}, ${resultStatus(entry)}${entry.execution.video ? '' : ', no video'}`;
}
</script>

<template>
  <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <div class="min-w-0 space-y-2">
      <div class="relative aspect-video overflow-hidden rounded-lg border border-default bg-black">
        <video
          v-for="slot in [0, 1] as const"
          :key="slot"
          :ref="(el) => player.bind(slot, el as HTMLVideoElement | null)"
          class="absolute inset-0 size-full object-contain"
          :class="player.front.value === slot ? '' : 'invisible'"
          muted
          playsinline
          preload="auto"
          v-bind="player.events(slot)"
        />
        <div v-if="player.unplayable.value" class="absolute inset-0 flex items-center justify-center p-4">
          <ErrorState text="The videos of this reel could not be loaded" :padded="false" />
        </div>
      </div>

      <div class="flex items-center gap-2 min-w-0">
        <UButton
          :icon="playing ? 'i-lucide-pause' : 'i-lucide-play'"
          color="neutral"
          variant="outline"
          size="sm"
          :aria-label="playing ? 'Pause' : 'Play'"
          :disabled="player.unplayable.value"
          @click="player.togglePlay()"
        />
        <div v-if="playingEntry" class="min-w-0 text-sm">
          <NuxtLink
            :to="`/test-run-cases/${playingEntry.execution.executionId}`"
            class="block truncate text-highlighted hover:underline"
          >
            {{ playingEntry.execution.title }}
          </NuxtLink>
        </div>
      </div>

      <div ref="bar" class="flex h-6 items-stretch gap-px overflow-x-auto" role="group" aria-label="Tests in this reel">
        <button
          v-for="(entry, i) in reel.entries"
          :key="entry.execution.executionId"
          ref="blocks"
          :data-index="i"
          type="button"
          class="relative overflow-hidden rounded-sm transition-opacity focus-visible:outline-2 focus-visible:outline-offset-1"
          :class="[
            palette(entry).bg,
            entry.execution.video
              ? failed.has(i)
                ? 'opacity-30'
                : ''
              : 'border border-dashed border-default bg-transparent!',
            current === i ? 'ring-2 ring-inverted' : ticked[i] ? 'opacity-100' : 'opacity-60',
          ]"
          :style="
            entry.execution.video
              ? { flex: `${Math.max(player.lengthOf(i), 1)} 1 0`, minWidth: MIN_BLOCK_WIDTH }
              : { flex: `0 1 ${STUB_WIDTH}`, minWidth: MIN_BLOCK_WIDTH }
          "
          :aria-label="blockLabel(entry)"
          :aria-current="current === i ? 'true' : undefined"
          @click="seekFromBar(i, $event)"
        >
          <span
            v-if="current === i && entry.execution.video"
            class="absolute inset-y-0 w-0.5 bg-white mix-blend-difference"
            :style="{ left: `${player.progress.value * 100}%` }"
          />
        </button>
      </div>
    </div>

    <div class="min-w-0">
      <p class="mb-1 text-xs text-muted tabular-nums">
        {{ tickedCount }} of {{ reel.entries.length }} tests · {{ reel.videoCount }}
        {{ reel.videoCount === 1 ? 'video' : 'videos' }}
      </p>
      <ul class="max-h-96 overflow-y-auto divide-y divide-default rounded-lg border border-default lg:max-h-[28rem]">
        <li v-for="(entry, i) in reel.entries" :key="entry.execution.executionId">
          <button
            type="button"
            class="flex w-full items-start gap-2 px-3 py-2 text-left"
            :class="[
              current === i ? SELECTED_ROW_CLASS : 'hover:bg-elevated/50',
              !entry.execution.video || failed.has(i) ? 'cursor-default' : '',
            ]"
            :disabled="!entry.execution.video || failed.has(i)"
            :aria-current="current === i ? 'true' : undefined"
            @click="player.seekTo(i, 0)"
          >
            <UIcon
              :name="ticked[i] ? getStatusIcon(resultStatus(entry)) : 'i-lucide-circle'"
              class="mt-0.5 size-4 shrink-0"
              :class="ticked[i] ? palette(entry).text : 'text-muted opacity-50'"
              aria-hidden="true"
            />
            <span class="sr-only">{{ ticked[i] ? `Played, ${resultStatus(entry)}: ` : 'Not played yet: ' }}</span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm text-highlighted">{{ entry.execution.title }}</span>
              <span class="block text-xs text-muted">
                <template v-if="group === 'file' && entry.laneLabel">{{ entry.laneLabel }} · </template>
                {{ formatDuration(entry.execution.durationMs) }}
                <template v-if="!entry.execution.video"> · no video</template>
                <template v-else-if="failed.has(i)"> · video failed to load</template>
              </span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

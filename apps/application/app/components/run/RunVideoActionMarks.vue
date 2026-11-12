<script setup lang="ts">
/**
 * The marks under the video review's player: one for each action the playing test took, on the test's own span of its
 * video. A mark's tooltip says what the action was (never the text it typed), choosing it plays the test from there,
 * a failed action's mark is red, and marks too close to tell apart merge into one counted mark. The actions are
 * `useVideoActionMarks`'.
 */
import { useResizeObserver } from '@vueuse/core';
import { MAX_VIDEO_ACTIONS, markLabel, type VideoMark } from '#shared/video-actions';
import { statusPalette } from '~/utils/status-palette';

const props = defineProps<{
  /** The test that plays; the lane is its. */
  executionId: number | null;
  /** The test that plays after it; its actions are read ahead. */
  nextExecutionId: number | null;
  /** The span of the playing test in its video, in ms: the lane's length. */
  spanMs: number;
}>();
const emit = defineEmits<{ seek: [ms: number] }>();

/** The merged marks list this many actions in their tooltip; the rest is a count. */
const LISTED = 12;

const lane = ref<HTMLElement | null>(null);
const widthPx = ref(0);
useResizeObserver(lane, (entries) => {
  widthPx.value = entries[0]?.contentRect.width ?? 0;
});
onMounted(() => {
  widthPx.value = lane.value?.getBoundingClientRect().width ?? 0;
});

const { state, marks, total, capped, seekToMark } = useVideoActionMarks(
  toRef(props, 'executionId'),
  toRef(props, 'nextExecutionId'),
  toRef(props, 'spanMs'),
  widthPx,
  (ms) => emit('seek', ms),
);

const failedPalette = statusPalette('failed');
const MARK_BASE =
  'absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[10px] font-medium leading-none focus-visible:outline-2 focus-visible:outline-offset-2 before:absolute before:-inset-2 before:content-[""]';

function markClass(mark: VideoMark): string[] {
  const merged = mark.actions.length > 1;
  return [
    MARK_BASE,
    merged ? 'h-4 min-w-4 px-1' : 'size-2.5',
    mark.failed ? [failedPalette.bg, failedPalette.onBg] : 'bg-inverted text-inverted',
    mark.clamped ? 'ring-1 ring-offset-1 ring-offset-default ring-muted' : '',
  ].flat();
}
const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
function ariaLabel(mark: VideoMark): string {
  return `${markLabel(mark)}${mark.failed ? ', failed' : ''}, at ${seconds(mark.atMs)}`;
}
const countText = computed(() =>
  capped.value
    ? `First ${MAX_VIDEO_ACTIONS} of ${total.value} actions`
    : `${total.value} ${total.value === 1 ? 'action' : 'actions'}`,
);
</script>

<template>
  <div class="min-w-0 space-y-1" data-testid="video-action-marks">
    <div v-if="state === 'ready'" ref="lane" class="relative mx-1.5 h-5" role="group" aria-label="Actions of this test">
      <span class="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" aria-hidden="true" />
      <UTooltip
        v-for="(mark, i) in marks"
        :key="i"
        :delay-duration="0"
        :content="{ side: 'top' }"
        :ui="{ content: 'h-auto max-w-xs py-1.5' }"
      >
        <button
          type="button"
          :class="markClass(mark)"
          :style="{ left: `${mark.position * 100}%` }"
          :aria-label="ariaLabel(mark)"
          data-testid="video-action-mark"
          @click="seekToMark(mark)"
        >
          <template v-if="mark.actions.length > 1">{{ mark.actions.length }}</template>
        </button>
        <template #content>
          <div class="max-w-xs space-y-0.5 text-xs">
            <template v-if="mark.actions.length === 1">
              <p class="break-words">{{ mark.actions[0]!.label }}</p>
            </template>
            <template v-else>
              <p class="font-medium">{{ mark.actions.length }} actions</p>
              <ul class="space-y-0.5">
                <li v-for="(action, j) in mark.actions.slice(0, LISTED)" :key="j" class="break-words">
                  {{ action.label }}<template v-if="action.failed"> (failed)</template>
                </li>
              </ul>
              <p v-if="mark.actions.length > LISTED" class="text-muted">and {{ mark.actions.length - LISTED }} more</p>
            </template>
            <p v-if="mark.failed && mark.actions.length === 1" :class="failedPalette.text">Failed</p>
            <p class="text-muted tabular-nums">
              {{ seconds(mark.atMs) }}<template v-if="mark.clamped"> · outside the video, shown at its edge</template>
            </p>
          </div>
        </template>
      </UTooltip>
    </div>
    <p v-if="state === 'ready'" class="text-xs text-muted tabular-nums" data-testid="video-action-count">
      {{ countText }}
    </p>
    <p v-else-if="state === 'empty'" class="text-xs text-muted">No recorded actions for this test</p>
    <p v-else-if="state === 'error'" class="text-xs text-muted">The actions of this test could not be loaded</p>
    <p v-else class="text-xs text-muted">Loading actions…</p>
  </div>
</template>

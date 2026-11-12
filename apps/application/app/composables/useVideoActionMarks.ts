/**
 * The marks under the video review's player for the test that is playing: reads its actions (`readVideoActions`,
 * kept per execution), lays them out on a lane of `spanMs` and `widthPx` (`placeMarks`) and seeks the player when a
 * mark is chosen. The next test's actions are read ahead, so the lane is there when the player moves on.
 */
import { placeMarks, type VideoActionsResponse, type VideoMark } from '#shared/video-actions';
import { readVideoActions } from '~/utils/video-actions-cache';

/** `clock-unknown`: the test recorded actions but no start time to place them in its video by. */
export type VideoMarksState = 'loading' | 'error' | 'empty' | 'clock-unknown' | 'ready';

export function useVideoActionMarks(
  executionId: Ref<number | null>,
  nextExecutionId: Ref<number | null>,
  spanMs: Ref<number>,
  widthPx: Ref<number>,
  seek: (ms: number) => void,
) {
  const answer = ref<VideoActionsResponse | null>(null);
  const failed = ref(false);
  let token = 0;

  watch(
    executionId,
    async (id) => {
      const mine = ++token;
      answer.value = null;
      failed.value = false;
      if (id == null) return;
      try {
        const read = await readVideoActions(id);
        if (mine === token) answer.value = read;
      } catch {
        if (mine === token) failed.value = true;
      }
    },
    { immediate: true },
  );

  // Reading ahead only fills the cache: a failure surfaces when the test plays.
  watch(
    nextExecutionId,
    (id) => {
      if (id != null) readVideoActions(id).catch(() => undefined);
    },
    { immediate: true },
  );

  const state = computed<VideoMarksState>(() => {
    if (failed.value) return 'error';
    if (!answer.value) return 'loading';
    if (answer.value.actions.length > 0) return 'ready';
    return answer.value.reason === 'clock-unknown' ? 'clock-unknown' : 'empty';
  });
  const marks = computed<VideoMark[]>(() =>
    answer.value ? placeMarks(answer.value.actions, spanMs.value, widthPx.value) : [],
  );
  /** How many actions the test took, and whether the lane shows fewer. */
  const total = computed(() => answer.value?.total ?? 0);
  const capped = computed(() => answer.value?.capped === true);

  /** Plays the test from the mark; a mark at the lane's end seeks just inside the test, which is still its own. */
  function seekToMark(mark: VideoMark) {
    seek(Math.min(mark.atMs, Math.max(0, spanMs.value - 1)));
  }

  return { state, marks, total, capped, seekToMark };
}

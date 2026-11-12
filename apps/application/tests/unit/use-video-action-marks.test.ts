import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vue from 'vue';
import type { VideoAction, VideoActionsResponse } from '#shared/video-actions';

/** `useVideoActionMarks`: the lane's state for the test that plays, and what choosing a mark does. */

vi.stubGlobal('ref', vue.ref);
vi.stubGlobal('computed', vue.computed);
vi.stubGlobal('watch', vue.watch);
// A hand-written stand-in: a mock function tracks the promises it returns, and one that rejects fails the test.
type Reader = (id: number) => Promise<VideoActionsResponse>;
const reads: number[] = [];
let reader: Reader = async () => {
  throw new Error('no reader');
};
vi.mock('~/utils/video-actions-cache', () => ({
  readVideoActions: (id: number) => {
    reads.push(id);
    return reader(id);
  },
}));

const { useVideoActionMarks } = await import('../../app/composables/useVideoActionMarks');

const act = (atMs: number, label = `Click @${atMs}`): VideoAction => ({ kind: 'click', atMs, label, failed: false });
const answer = (actions: VideoAction[], over: Partial<VideoActionsResponse> = {}): VideoActionsResponse => ({
  source: 'steps',
  timing: 'create-page',
  actions,
  total: actions.length,
  capped: false,
  ...over,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function lane(id: number | null = 1, next: number | null = null) {
  const executionId = vue.ref<number | null>(id);
  const nextExecutionId = vue.ref<number | null>(next);
  const spanMs = vue.ref(10_000);
  const widthPx = vue.ref(1000);
  const seek = vi.fn();
  return {
    executionId,
    nextExecutionId,
    spanMs,
    widthPx,
    seek,
    ...useVideoActionMarks(executionId, nextExecutionId, spanMs, widthPx, seek),
  };
}

beforeEach(() => {
  reads.length = 0;
});

describe('useVideoActionMarks', () => {
  it('is loading until the actions arrive, then ready with the marks', async () => {
    reader = async () => answer([act(1_000), act(5_000)]);
    const l = lane();
    expect(l.state.value).toBe('loading');
    await settle();
    expect(l.state.value).toBe('ready');
    expect(l.marks.value.map((m) => m.position)).toEqual([0.1, 0.5]);
  });

  it('is empty for a test with no recorded actions', async () => {
    reader = async () => answer([], { source: 'none', timing: null });
    const l = lane();
    await settle();
    expect(l.state.value).toBe('empty');
    expect(l.marks.value).toEqual([]);
  });

  it('is an error when the read fails, and leaves the test it is on alone', async () => {
    reader = () => Promise.reject(new Error('500'));
    const l = lane();
    await settle();
    expect(l.state.value).toBe('error');
    expect(l.seek).not.toHaveBeenCalled();
  });

  it('seeks the player to a mark, held to the lane when the action was outside the video', async () => {
    reader = async () => answer([act(2_500), act(-40), act(12_000)]);
    const l = lane();
    await settle();
    l.seekToMark(l.marks.value[1]!);
    expect(l.seek).toHaveBeenLastCalledWith(2_500);
    l.seekToMark(l.marks.value[0]!);
    expect(l.seek).toHaveBeenLastCalledWith(0);
    l.seekToMark(l.marks.value[2]!);
    expect(l.seek).toHaveBeenLastCalledWith(10_000);
  });

  it('merges the marks of a narrow lane and seeks to the first of the merged', async () => {
    reader = async () => answer([act(1_000), act(1_020), act(1_040), act(1_050)]);
    const l = lane();
    await settle();
    expect(l.marks.value).toHaveLength(1);
    expect(l.marks.value[0]!.actions).toHaveLength(4);
    l.seekToMark(l.marks.value[0]!);
    expect(l.seek).toHaveBeenCalledWith(1_000);
  });

  it('says when the answer holds fewer actions than the test took', async () => {
    reader = async () => answer([act(1)], { total: 700, capped: true });
    const l = lane();
    await settle();
    expect(l.total.value).toBe(700);
    expect(l.capped.value).toBe(true);
  });

  it('follows the test that plays and drops the answer of the one it left', async () => {
    let release!: (a: VideoActionsResponse) => void;
    const answers: Reader[] = [
      () => new Promise((resolve) => (release = resolve)),
      async () => answer([act(7_000, 'second')]),
    ];
    reader = (id) => answers.shift()!(id);
    const l = lane(1);
    l.executionId.value = 2;
    await settle();
    release(answer([act(1_000, 'first')]));
    await settle();
    expect(l.marks.value.map((m) => m.actions[0]!.label)).toEqual(['second']);
  });

  it('reads the next test ahead, and shows no error for it', async () => {
    reader = async (id) => {
      if (id === 2) throw new Error('500');
      return answer([act(1)]);
    };
    const l = lane(1, 2);
    await settle();
    expect(reads).toContain(2);
    expect(l.state.value).toBe('ready');
  });

  it('has no lane for no test', async () => {
    const l = lane(null);
    await settle();
    expect(l.state.value).toBe('loading');
    expect(reads).toEqual([]);
  });
});

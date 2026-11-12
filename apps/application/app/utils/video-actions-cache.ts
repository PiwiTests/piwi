/**
 * The actions under the video review's player, kept per execution while the page lives. The player moves between the
 * tests of a reel and the modal opens again on the same ones, so an answer read is kept, for `KEEP_MS` at most.
 */
import type { VideoActionsResponse } from '#shared/video-actions';

/** How long an answer is served without asking again. */
const KEEP_MS = 5 * 60 * 1000;
/** How many executions' answers are kept: the oldest goes first. */
const KEEP_EXECUTIONS = 24;

export type VideoActionsFetcher = (executionId: number) => Promise<VideoActionsResponse>;

/**
 * A reader of the executions' actions over `fetcher`. Two reads of one execution in flight are one request; a failed
 * read is not kept, so the next one asks again.
 */
export function createVideoActionsCache(fetcher: VideoActionsFetcher, now: () => number = Date.now) {
  const answers = new Map<number, { at: number; read: Promise<VideoActionsResponse> }>();
  return {
    read(executionId: number): Promise<VideoActionsResponse> {
      const kept = answers.get(executionId);
      if (kept && now() - kept.at < KEEP_MS) return kept.read;
      const read = fetcher(executionId);
      answers.delete(executionId);
      answers.set(executionId, { at: now(), read });
      read.catch(() => {
        if (answers.get(executionId)?.read === read) answers.delete(executionId);
      });
      while (answers.size > KEEP_EXECUTIONS) answers.delete(answers.keys().next().value!);
      return read;
    },
  };
}

const cache = createVideoActionsCache((executionId) =>
  $fetch<VideoActionsResponse>(`/api/test-run-cases/${executionId}/video-actions`),
);

/** The execution's actions, from `GET /api/test-run-cases/:id/video-actions` or the copy read a moment ago. */
export const readVideoActions = (executionId: number): Promise<VideoActionsResponse> => cache.read(executionId);

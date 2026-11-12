/**
 * The run's video list, kept per run while the page lives. The video review opens often (every test of a run, every
 * open of the modal) and the list is the whole run's, up to `MAX_LISTED_EXECUTIONS` executions of each kind; a
 * finished run's list does not change, so a list read is kept, for `KEEP_MS` at most.
 */
import type { RunVideos } from '#shared/handlers/run-videos';

/** How long a list is served without asking again. */
const KEEP_MS = 5 * 60 * 1000;
/** How many runs' lists are kept: the oldest goes first. */
const KEEP_RUNS = 4;

export type RunVideosFetcher = (runId: number) => Promise<RunVideos>;

/**
 * A reader of the run's video lists over `fetcher`. Two reads of one run in flight are one request; a failed read is
 * not kept, so the next one asks again.
 */
export function createRunVideosCache(fetcher: RunVideosFetcher, now: () => number = Date.now) {
  const lists = new Map<number, { at: number; read: Promise<RunVideos> }>();
  return {
    read(runId: number): Promise<RunVideos> {
      const kept = lists.get(runId);
      if (kept && now() - kept.at < KEEP_MS) return kept.read;
      const read = fetcher(runId);
      lists.delete(runId);
      lists.set(runId, { at: now(), read });
      read.catch(() => {
        if (lists.get(runId)?.read === read) lists.delete(runId);
      });
      while (lists.size > KEEP_RUNS) lists.delete(lists.keys().next().value!);
      return read;
    },
  };
}

const cache = createRunVideosCache((runId) => $fetch<RunVideos>(`/api/test-runs/${runId}/videos`));

/** The run's video list, from `GET /api/test-runs/:id/videos` or the copy read a moment ago. */
export const readRunVideos = (runId: number): Promise<RunVideos> => cache.read(runId);

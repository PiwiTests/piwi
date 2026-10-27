import type {
  SeriesPoint,
  WireLiveResources,
  WireLiveResourcesAnswer,
  WireResourceTimeline,
} from '@piwitests/core/wire';
import { errorMessage } from '../support/errors.js';
import { Logger } from '../support/logger.js';
import { HttpError, type HttpClient } from '../transport/http-client.js';
import type { ResourceCensus } from '../capture/resource-ledger.js';
import type { RunSampler } from '../collect/process-sampler.js';
import {
  TIMELINE_SERIES_CAP,
  TIMELINE_WORKER_POINTS_CAP,
  downsamplePoints,
  pagesOverTime,
  workerTreesByIndex,
} from '../collect/resource-wire.js';

/**
 * A live run's resources, posted to the dashboard while someone has the run
 * open: every few seconds, what the run sampler read since the last post (the
 * machine's CPU, the run's memory, each worker's CPU and memory) and each
 * worker's open pages from the censuses so far, so the run's workers timeline
 * draws them as the run goes. Nothing is posted while nobody watches; the
 * points read meanwhile go with the next post. Separate from the event queue:
 * a lost post costs a gap in a chart, never a test result, so it is neither
 * buffered on disk nor retried beyond the next tick. The run's report still
 * goes with `finish`.
 */

/** The stream the posts ride on: its run and token, and whether the dashboard says anyone watches. */
export interface LiveStream {
  readonly enabled: boolean;
  readonly runId: number | null;
  readonly token: string | null;
  readonly auth: string | null;
  readonly isWatched: boolean | null;
  noteWatched(response: unknown): void;
}

export interface LiveResourcesOptions {
  sampler: RunSampler | null;
  /** The censuses received so far, in the order the tests ended. */
  censuses: () => readonly ResourceCensus[];
  /** The reporter's shard, as its `begin` named it. */
  shardIndex: number | null;
  /** Epoch ms the series count from when the sampler did not run: the run's start. */
  runStartedAt: number;
  intervalMs?: number;
}

/** What a post sends, and the cursors it moves once the dashboard took it. */
interface Draft {
  post: WireLiveResources;
  sent: Map<string, number>;
  censusCount: number;
}

/** Every how many milliseconds a watched run's resources are posted. */
const LIVE_INTERVAL_MS = 5000;

/** The points of `points` read after `cursor`, or all of them without one, within `cap`. */
function since(points: SeriesPoint[], cursor: number | undefined, cap: number, merge: 'mean' | 'max'): SeriesPoint[] {
  const fresh = cursor === undefined ? points : points.filter(([at]) => at > cursor);
  return downsamplePoints(fresh, cap, merge);
}

export class LiveResources {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  /** Whether the next post must carry every point: the first one, and after the dashboard lost them. */
  private reset = true;
  /** The time of the last point the dashboard took, per series. */
  private sent = new Map<string, number>();
  /** How many censuses the open pages last posted came from. */
  private censusCount = 0;

  constructor(
    private readonly stream: LiveStream,
    private readonly httpClient: HttpClient,
    private readonly options: LiveResourcesOptions,
    private readonly logger: Logger = new Logger(),
  ) {}

  /** Post on a timer that never keeps the process alive. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? LIVE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Post nothing more, and wait for a post in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** Post now, when the run is watched and no post is in flight: the dashboard says someone just opened it. */
  tick(): Promise<void> | null {
    if (this.stopped || this.inFlight) return null;
    const { enabled, runId, token } = this.stream;
    if (!enabled || runId === null || !token || this.stream.isWatched !== true) return null;
    let draft: Draft | null;
    try {
      draft = this.draft();
    } catch (error) {
      this.logger.debug(`Live resources not read: ${errorMessage(error)}`);
      return null;
    }
    if (!draft) return null;
    this.inFlight = this.send(runId, token, draft).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** What is new since the last post the dashboard took; null when nothing is. */
  private draft(): Draft | null {
    const samples = this.options.sampler?.timedSeries() ?? null;
    // The sampler's points count from its start; without it, the open pages count from the run's.
    const startedAt = samples?.startedAt || this.options.runStartedAt;
    const censuses = this.options.censuses();
    const cursors = this.reset ? new Map<string, number>() : this.sent;
    const sent = new Map(cursors);
    let fresh = false;

    // Each series' new points, and the time of its last point for the next post.
    const take = (key: string, points: SeriesPoint[], cap: number, merge: 'mean' | 'max'): SeriesPoint[] => {
      const out = since(points, cursors.get(key), cap, merge);
      const last = points[points.length - 1];
      if (out.length > 0 && last) {
        sent.set(key, last[0]);
        fresh = true;
      }
      return out;
    };

    const timeline: WireResourceTimeline = { startedAt, cpuPct: [], memoryBytes: [], pages: [], workers: [] };
    if (samples) {
      timeline.cpuPct = take('cpu', samples.cpuPct, TIMELINE_SERIES_CAP, 'mean');
      timeline.memoryBytes = take('memory', samples.memoryBytes, TIMELINE_SERIES_CAP, 'max');
      for (const tree of workerTreesByIndex(samples, censuses)) {
        const cpuCores = take(`cores:${tree.worker}`, tree.cpuCores, TIMELINE_WORKER_POINTS_CAP, 'mean');
        const memoryBytes = take(`bytes:${tree.worker}`, tree.memoryBytes, TIMELINE_WORKER_POINTS_CAP, 'max');
        if (cpuCores.length > 0 || memoryBytes.length > 0) {
          timeline.workers!.push({ worker: tree.worker, cpuCores, memoryBytes });
        }
      }
    }
    // A census can close a page an earlier one opened, so each worker's pages go whole when a census came in.
    if (this.reset || censuses.length !== this.censusCount) {
      for (const { worker, events } of pagesOverTime(censuses, true)) {
        const points = events.map(([at, open]): SeriesPoint => [at - startedAt, open]);
        const last = points.pop()!;
        timeline.pages.push({
          worker,
          points: [...downsamplePoints(points, TIMELINE_WORKER_POINTS_CAP - 1, 'max'), last],
        });
      }
      fresh ||= timeline.pages.length > 0;
    }
    if (!fresh) return null;

    const memory = this.options.sampler?.liveMemory() ?? { capacityBytes: null, kind: null };
    return {
      post: {
        shardIndex: this.options.shardIndex,
        reset: this.reset,
        timeline,
        memoryCapacityBytes: memory.capacityBytes,
        memoryKind: memory.kind,
      },
      sent,
      censusCount: censuses.length,
    };
  }

  private async send(runId: number, token: string, draft: Draft): Promise<void> {
    try {
      const answer = (await this.httpClient.postJSON(
        `/api/test-runs/${runId}/live-resources`,
        { streamToken: token, ...draft.post },
        this.stream.auth,
      )) as WireLiveResourcesAnswer | null;
      if (answer?.declined) {
        this.logger.debug('The project declined resources: live resources are not sent.');
        this.stopped = true;
        return;
      }
      this.stream.noteWatched(answer);
      if (answer?.resync) {
        this.reset = true;
        return;
      }
      this.sent = draft.sent;
      this.censusCount = draft.censusCount;
      this.reset = false;
    } catch (error) {
      // A dashboard without the route takes no live resources; the report still goes with `finish`.
      if (error instanceof HttpError && error.status === 404) {
        this.logger.debug('The dashboard takes no live resources.');
        this.stopped = true;
        return;
      }
      this.logger.debug(`Live resources not sent: ${errorMessage(error)}`);
    }
  }
}

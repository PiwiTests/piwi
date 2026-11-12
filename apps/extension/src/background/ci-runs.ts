/**
 * The CI runs in progress the Runs window lists, read-only, from the instance the extension is connected to: the runs
 * in progress of the projects this browser maps (`projectMappings`, `serverMappings`), each told a CI run's once it has
 * begun, by the origin the list names (`isCiOrigin`), else, from an older instance that names none, by its details
 * (`isCiMetadata`). Read only while a Runs window is open, once as it opens and then every `CI_RUNS_POLL_MS`: one list a
 * read, and from an older instance one run's details for each run it lists first, `MAX_DETAILS_READ` at most; details
 * that did not come are asked again after twice the wait before, `MAX_DETAILS_TRIES` times at most. Nothing is read
 * without connected mode (`isConnected`), and nothing here steers a run.
 *
 * The newest `MAX_CI_STREAMS` runs listed are also followed through their own stream (`GET /api/test-runs/:id/stream`)
 * while a window listens: whether their lanes can be watched (`live-view`: the project's live view on and the run
 * holding a key) and each lane as it stands (`lane`, read by `readLane`), whose running tests the window lists with
 * **Watch**. A stream that ends or brings nothing for `STREAM_IDLE_MS` is opened again at the next read; the changes
 * reach the windows at most every `PUSH_MS`.
 */
import { laneKey, readLane, type Lane } from '@piwitests/core/live-lane';
import { ciRunsListed, ciTally, isCiMetadata, isCiOrigin, type CiRun } from '@piwitests/run-model/ci';
import { isConnected, type ConnectionSettings } from '../shared/connection-settings.js';
import type { ActiveRun } from '../shared/piwi-client.js';
import type { RunsCiRun, RunsCiTest } from '../shared/runs.js';
import { EventParser } from './sse.js';

/** How often the list is read while a Runs window is open. */
export const CI_RUNS_POLL_MS = 15_000;
/** The most runs whose details a read asks for: the others wait for the next. */
const MAX_DETAILS_READ = 4;
/** How many times a run's details are asked before it is asked no more. */
const MAX_DETAILS_TRIES = 4;
/** The verdicts and the details that did not come kept, by instance and run: past it, the oldest go. */
const MAX_VERDICTS = 200;
/**
 * The most runs whose own stream is read at once, the newest listed: with a watch and a read of the list, within the
 * six connections a browser opens to one host.
 */
export const MAX_CI_STREAMS = 3;
/** The most running tests a run lists, by shard and lane. */
export const MAX_CI_TESTS = 32;
/** A stream that brings nothing for this long has lost the instance, which sends a heartbeat every 15 s. */
const STREAM_IDLE_MS = 45_000;
/** The lanes' changes reach the windows at most this often. */
const PUSH_MS = 500;
/** The lanes kept of one run: past it, the lanes that ended go. */
const MAX_LANES = 256;
/** The states of a lane whose test the window lists. */
const RUNNING = new Set(['running', 'pausing', 'stopped']);

export interface CiRunsOptions {
  /** The connection as stored: nothing is read unless it is connected mode's. */
  settings: () => Promise<ConnectionSettings>;
  activeRuns: (settings: ConnectionSettings) => Promise<ActiveRun[]>;
  metadata: (settings: ConnectionSettings, runId: number) => Promise<unknown>;
  /** The run's page on the instance. */
  runUrl: (settings: ConnectionSettings, runId: number) => string;
  /** One run's event stream, open until `signal` aborts; absent, no run's lanes are read. */
  stream?: (settings: ConnectionSettings, runId: number, signal: AbortSignal) => Promise<Response>;
  /** A run left the list: it ended, or is no longer one of the mapped projects' runs in progress. */
  left?: (runId: number) => void;
  pollMs?: number;
  streamIdleMs?: number;
  pushMs?: number;
}

/** A run followed through its own stream. */
interface Followed {
  runId: number;
  abort: AbortController;
  /** Its stream is open, or being opened. */
  open: boolean;
  watchable: boolean;
  lanes: Map<string, Lane>;
}

/** The tests a run's lanes run now, by shard and lane, `MAX_CI_TESTS` at most. */
export function ciTestsOf(lanes: Iterable<Lane>): RunsCiTest[] {
  return [...lanes]
    .filter((lane) => RUNNING.has(lane.state) && lane.test)
    .sort((a, b) => (a.id.shard ?? 0) - (b.id.shard ?? 0) || a.id.lane - b.id.lane)
    .slice(0, MAX_CI_TESTS)
    .map((lane) => ({
      shard: lane.id.shard,
      lane: lane.id.lane,
      worker: lane.worker,
      state: lane.state,
      title: lane.test!.title,
      retry: lane.test!.retry,
    }));
}

/** The projects a connection maps. */
export function mappedProjects(settings: ConnectionSettings): Set<number> {
  return new Set([...settings.projectMappings, ...settings.serverMappings].map((m) => m.projectId));
}

/** The CI runs of one read: the runs in progress of the mapped projects told CI runs'. */
export function ciRunsOf(
  runs: readonly ActiveRun[],
  projects: ReadonlySet<number>,
  isCi: (run: ActiveRun) => boolean | undefined,
  url: (runId: number) => string,
): CiRun[] {
  return ciRunsListed(
    runs
      .filter((run) => projects.has(run.projectId) && isCi(run) === true)
      .map((run) => ({
        id: run.id,
        projectId: run.projectId,
        project: typeof run.projectName === 'string' ? run.projectName : '',
        branch: typeof run.branch === 'string' && run.branch ? run.branch : null,
        status: run.status,
        startTime: typeof run.startTime === 'string' ? run.startTime : '',
        ...ciTally(run),
        url: url(run.id),
      })),
  );
}

/** Keep the newest `MAX_VERDICTS` entries of a map kept in the order they came. */
function bound(map: Map<string, unknown>): void {
  for (const oldest of map.keys()) {
    if (map.size <= MAX_VERDICTS) break;
    map.delete(oldest);
  }
}

export class CiRunsWatch {
  private runs: CiRun[] = [];
  /** The runs followed through their own stream, by run, of the instance `followedOn` names. */
  private readonly followed = new Map<number, Followed>();
  private followedOn = '';
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushedAt = 0;
  /** Whether each run is a CI run's, by instance and run: its origin never changes once it has begun. */
  private readonly verdicts = new Map<string, boolean>();
  /** The runs whose details did not come, by instance and run: how many times, and when they may be asked again. */
  private readonly missed = new Map<string, { tries: number; next: number }>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private sent = '[]';

  constructor(private readonly options: CiRunsOptions) {}

  /** The CI runs as last read, with the tests the runs followed run now. */
  state(): RunsCiRun[] {
    return this.runs.map((run) => {
      const f = this.followed.get(run.id);
      return { ...run, tests: f ? ciTestsOf(f.lanes.values()) : [], watchable: !!f?.watchable };
    });
  }

  /**
   * A lane of a listed run, for a watch of it: whether the run's lanes can be watched, and the worker in the lane
   * (Playwright's worker index; null before any); null for a run not followed now.
   */
  lane(runId: number, shard: number | null, lane: number): { watchable: boolean; worker: number | null } | null {
    const f = this.followed.get(runId);
    if (!f || !this.runs.some((run) => run.id === runId)) return null;
    const kept = [...f.lanes.values()].find((l) => l.id.shard === shard && l.id.lane === lane);
    return { watchable: f.watchable, worker: kept?.worker ?? null };
  }

  /**
   * A Runs window opened: the list is read now and every `pollMs` while one listens; `changed` is called when it
   * changes. The function returned stops listening, and the reads stop with the last listener.
   */
  listen(changed: () => void): () => void {
    this.listeners.add(changed);
    if (this.listeners.size === 1) void this.read();
    return () => {
      this.listeners.delete(changed);
      if (this.listeners.size) return;
      this.unfollowAll();
      if (!this.timer) return;
      clearTimeout(this.timer);
      this.timer = null;
    };
  }

  /** Read the list once, then again after `pollMs` while a window listens. */
  async read(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const runs = await this.fetch();
      this.show(runs);
      if (this.listeners.size) await this.follow();
    } catch {
      // The instance did not answer: the runs last read stay until it does.
    } finally {
      this.reading = false;
      if (this.listeners.size) this.timer = setTimeout(() => void this.read(), this.options.pollMs ?? CI_RUNS_POLL_MS);
    }
  }

  private async fetch(): Promise<CiRun[]> {
    const settings = await this.options.settings();
    if (!isConnected(settings)) return [];
    const projects = mappedProjects(settings);
    const active = (await this.options.activeRuns(settings)).filter((run) => projects.has(run.projectId));
    const key = (run: ActiveRun) => `${settings.instanceUrl}\n${run.id}`;
    // An initializing run is told nothing yet: the instance learns what launched it as it begins.
    const begun = active.filter((run) => run.status !== 'initializing');
    for (const run of begun) {
      if (typeof run.origin === 'string' && !this.verdicts.has(key(run))) {
        this.verdicts.set(key(run), isCiOrigin(run.origin));
      }
    }
    const now = Date.now();
    const unknown = begun
      .filter((run) => !this.verdicts.has(key(run)) && (this.missed.get(key(run))?.next ?? 0) <= now)
      .slice(0, MAX_DETAILS_READ);
    await Promise.all(
      unknown.map(async (run) => {
        const metadata = await this.options.metadata(settings, run.id).catch(() => undefined);
        if (metadata !== undefined) {
          this.verdicts.set(key(run), isCiMetadata(metadata));
          this.missed.delete(key(run));
          return;
        }
        const tries = (this.missed.get(key(run))?.tries ?? 0) + 1;
        const wait = (this.options.pollMs ?? CI_RUNS_POLL_MS) * 2 ** tries;
        this.missed.delete(key(run));
        this.missed.set(key(run), { tries, next: tries >= MAX_DETAILS_TRIES ? Infinity : now + wait });
      }),
    );
    bound(this.verdicts);
    bound(this.missed);
    return ciRunsOf(
      active,
      projects,
      (run) => this.verdicts.get(key(run)),
      (id) => this.options.runUrl(settings, id),
    );
  }

  private show(runs: CiRun[]): void {
    const gone = this.runs.filter((run) => !runs.some((r) => r.id === run.id));
    this.runs = runs;
    for (const run of gone) {
      this.unfollow(run.id);
      this.options.left?.(run.id);
    }
    this.tell();
  }

  /** The windows hear the state when it changed. */
  private tell(): void {
    const text = JSON.stringify(this.state());
    if (text === this.sent) return;
    this.sent = text;
    for (const changed of this.listeners) changed();
  }

  /** A lane changed: the windows hear it, at most every `pushMs`. */
  private tellSoon(): void {
    if (this.pushTimer) return;
    const wait = Math.max(0, this.pushedAt + (this.options.pushMs ?? PUSH_MS) - Date.now());
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushedAt = Date.now();
      this.tell();
    }, wait);
  }

  /** Follow the newest `MAX_CI_STREAMS` runs listed through their own stream, and those alone. */
  private async follow(): Promise<void> {
    if (!this.options.stream) return;
    const settings = await this.options.settings();
    if (settings.instanceUrl !== this.followedOn) {
      this.unfollowAll();
      this.followedOn = settings.instanceUrl;
    }
    const wanted = new Set(this.runs.slice(0, MAX_CI_STREAMS).map((run) => run.id));
    for (const runId of this.followed.keys()) if (!wanted.has(runId)) this.unfollow(runId);
    for (const runId of wanted) {
      const f = this.followed.get(runId) ?? {
        runId,
        abort: new AbortController(),
        open: false,
        watchable: false,
        lanes: new Map<string, Lane>(),
      };
      this.followed.set(runId, f);
      if (!f.open) void this.readStream(f, settings);
    }
  }

  private unfollow(runId: number): void {
    const f = this.followed.get(runId);
    if (!f) return;
    this.followed.delete(runId);
    f.abort.abort();
  }

  private unfollowAll(): void {
    for (const runId of this.followed.keys()) this.unfollow(runId);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
  }

  /** Read a run's stream until it ends, is let go or brings nothing for `streamIdleMs`. */
  private async readStream(f: Followed, settings: ConnectionSettings): Promise<void> {
    f.open = true;
    const abort = new AbortController();
    const stop = () => abort.abort();
    f.abort.signal.addEventListener('abort', stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(idle);
      idle = setTimeout(stop, this.options.streamIdleMs ?? STREAM_IDLE_MS);
    };
    try {
      alive();
      const response = await this.options.stream!(settings, f.runId, abort.signal);
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      abort.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true });
      const parser = new EventParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.followed.get(f.runId) !== f) break;
        alive();
        for (const data of parser.push(value)) this.heard(f, data);
      }
    } catch {
      // The stream dropped: it is opened again at the next read.
    } finally {
      clearTimeout(idle);
      f.abort.signal.removeEventListener('abort', stop);
      f.open = false;
    }
  }

  /** An event of a followed run's stream: whether its lanes can be watched, or a lane as it stands. */
  private heard(f: Followed, data: string): void {
    if (this.followed.get(f.runId) !== f) return;
    let event: { type?: unknown; data?: unknown };
    try {
      event = JSON.parse(data) as { type?: unknown; data?: unknown };
    } catch {
      return;
    }
    if (typeof event !== 'object' || event === null) return;
    if (event.type === 'live-view') {
      const view = event.data as { enabled?: unknown; keyed?: unknown } | null;
      f.watchable = view?.enabled === true && view.keyed === true;
    } else if (event.type === 'lane') {
      const lane = readLane(event.data);
      if (!lane) return;
      const key = laneKey(lane.id);
      f.lanes.delete(key);
      f.lanes.set(key, lane);
      for (const [oldest, kept] of f.lanes) {
        if (f.lanes.size <= MAX_LANES) break;
        if (!RUNNING.has(kept.state)) f.lanes.delete(oldest);
      }
    } else return;
    this.tellSoon();
  }
}

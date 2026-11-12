/**
 * The CI runs in progress the Runs window lists, read-only, from the instance the extension is connected to: the runs
 * in progress of the projects this browser maps (`projectMappings`, `serverMappings`), each told a CI run's once it has
 * begun, by the origin the list names (`isCiOrigin`), else, from an older instance that names none, by its details
 * (`isCiMetadata`). Read only while a Runs window is open, once as it opens and then every `CI_RUNS_POLL_MS`: one list a
 * read, and from an older instance one run's details for each run it lists first, `MAX_DETAILS_READ` at most; details
 * that did not come are asked again after twice the wait before, `MAX_DETAILS_TRIES` times at most. Nothing is read
 * without connected mode (`isConnected`), and nothing here steers a run.
 */
import { ciRunsListed, ciTally, isCiMetadata, isCiOrigin, type CiRun } from '@piwitests/run-model/ci';
import { isConnected, type ConnectionSettings } from '../shared/connection-settings.js';
import type { ActiveRun } from '../shared/piwi-client.js';

/** How often the list is read while a Runs window is open. */
export const CI_RUNS_POLL_MS = 15_000;
/** The most runs whose details a read asks for: the others wait for the next. */
const MAX_DETAILS_READ = 4;
/** How many times a run's details are asked before it is asked no more. */
const MAX_DETAILS_TRIES = 4;
/** The verdicts and the details that did not come kept, by instance and run: past it, the oldest go. */
const MAX_VERDICTS = 200;

export interface CiRunsOptions {
  /** The connection as stored: nothing is read unless it is connected mode's. */
  settings: () => Promise<ConnectionSettings>;
  activeRuns: (settings: ConnectionSettings) => Promise<ActiveRun[]>;
  metadata: (settings: ConnectionSettings, runId: number) => Promise<unknown>;
  /** The run's page on the instance. */
  runUrl: (settings: ConnectionSettings, runId: number) => string;
  pollMs?: number;
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
  /** Whether each run is a CI run's, by instance and run: its origin never changes once it has begun. */
  private readonly verdicts = new Map<string, boolean>();
  /** The runs whose details did not come, by instance and run: how many times, and when they may be asked again. */
  private readonly missed = new Map<string, { tries: number; next: number }>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private sent = '[]';

  constructor(private readonly options: CiRunsOptions) {}

  /** The CI runs as last read. */
  state(): CiRun[] {
    return this.runs;
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
      if (this.listeners.size || !this.timer) return;
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
      this.show(await this.fetch());
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
    const text = JSON.stringify(runs);
    if (text === this.sent) return;
    this.sent = text;
    this.runs = runs;
    for (const changed of this.listeners) changed();
  }
}

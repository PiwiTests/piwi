/**
 * The CI runs in progress the Runs window lists, read-only, from the instance the extension is connected to: the runs
 * in progress of the projects this browser maps (`projectMappings`, `serverMappings`), of every project the key reads
 * when it maps none, each told a CI run's by its details once (`isCiMetadata`). Read only while a Runs window is open,
 * once as it opens and then every `CI_RUNS_POLL_MS`: one list a read, and one run's details for each run it lists
 * first, `MAX_DETAILS_READ` at most. Nothing is read without connected mode, and nothing here steers a run.
 */
import { ciRunsListed, ciTally, isCiMetadata, type CiRun } from '@piwitests/run-model/ci';
import type { ConnectionSettings } from '../shared/connection-settings.js';
import type { ActiveRun } from '../shared/piwi-client.js';

/** How often the list is read while a Runs window is open. */
export const CI_RUNS_POLL_MS = 15_000;
/** The most runs whose details a read asks for: the others wait for the next. */
const MAX_DETAILS_READ = 4;
/** The verdicts kept, by instance and run: past it, the oldest go. */
const MAX_VERDICTS = 200;

export interface CiRunsOptions {
  /** The connection, or null without connected mode. */
  settings: () => Promise<ConnectionSettings | null>;
  activeRuns: (settings: ConnectionSettings) => Promise<ActiveRun[]>;
  metadata: (settings: ConnectionSettings, runId: number) => Promise<unknown>;
  /** The run's page on the instance. */
  runUrl: (settings: ConnectionSettings, runId: number) => string;
  pollMs?: number;
}

/** The projects a connection maps; none means every project its key reads. */
export function mappedProjects(settings: ConnectionSettings): Set<number> {
  return new Set([...settings.projectMappings, ...settings.serverMappings].map((m) => m.projectId));
}

/** The CI runs of one read: the runs in progress of the mapped projects whose details made them CI runs. */
export function ciRunsOf(
  runs: readonly ActiveRun[],
  projects: ReadonlySet<number>,
  isCi: (run: ActiveRun) => boolean | undefined,
  url: (runId: number) => string,
): CiRun[] {
  return ciRunsListed(
    runs
      .filter((run) => (projects.size === 0 || projects.has(run.projectId)) && isCi(run) === true)
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

export class CiRunsWatch {
  private runs: CiRun[] = [];
  /** Whether each run is a CI run's, by instance and run: its origin never changes. */
  private readonly verdicts = new Map<string, boolean>();
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
    if (!settings?.instanceUrl.trim()) return [];
    const projects = mappedProjects(settings);
    const active = (await this.options.activeRuns(settings)).filter(
      (run) => projects.size === 0 || projects.has(run.projectId),
    );
    const key = (run: ActiveRun) => `${settings.instanceUrl}\n${run.id}`;
    const unknown = active.filter((run) => !this.verdicts.has(key(run))).slice(0, MAX_DETAILS_READ);
    await Promise.all(
      unknown.map(async (run) => {
        const metadata = await this.options.metadata(settings, run.id).catch(() => undefined);
        if (metadata !== undefined) this.verdicts.set(key(run), isCiMetadata(metadata));
      }),
    );
    for (const oldest of this.verdicts.keys()) {
      if (this.verdicts.size <= MAX_VERDICTS) break;
      this.verdicts.delete(oldest);
    }
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

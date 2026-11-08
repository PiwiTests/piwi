import type {
  WireBrowserEnvironment,
  WireEnvironmentSnapshot,
  WireNetworkRequest,
  WireRunnerEnvironment,
  WireServerEnvironment,
} from '@piwitests/core/wire';
import { ENVIRONMENT_SNAPSHOTS_MAX } from '@piwitests/core/wire';
import { ATTACHMENT_NAMES, findPiwiAttachment } from '../capture/attachments.js';
import { fetchEnvironment, type FetchLike } from '../manifest/collect.js';
import { instrumentedOrigins } from '../manifest/run-manifests.js';

/** The longest the run's end waits for each read of a server's environment. */
const END_READ_TIMEOUT_MS = 6000;

/** The browser snapshot of a `piwi-environment` attachment, or null. */
export function parseBrowserEnvironment(body: Buffer | undefined): WireBrowserEnvironment | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as Partial<WireBrowserEnvironment>;
    if (parsed?.kind !== 'browser' || parsed.v !== 1 || typeof parsed.project !== 'string') return null;
    return parsed as WireBrowserEnvironment;
  } catch {
    return null;
  }
}

/** A process start read twice can differ by the time it took to compute it: a gap under this is the same start. */
const START_JITTER_MS = 2000;

/** Whether two reads of one server came from two processes: another `instance`, else another `startedAt`. */
export function serverRestarted(
  before: Pick<WireServerEnvironment, 'instance' | 'startedAt'>,
  after: Pick<WireServerEnvironment, 'instance' | 'startedAt'>,
): boolean {
  if (before.instance && after.instance) return before.instance !== after.instance;
  const a = before.startedAt ? Date.parse(before.startedAt) : NaN;
  const b = after.startedAt ? Date.parse(after.startedAt) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > START_JITTER_MS;
}

/**
 * The environment snapshots of one reporter's run: the runner's, read as the run begins; each project's browser, from
 * the first `piwi-environment` attachment of that project; and each instrumented server under test, read the first
 * time a test's requests reach its origin with an instrumentation header, and once more as the run's last test ends
 * (before Playwright stops a `webServer`), which says whether it restarted meanwhile.
 */
export class RunEnvironments {
  private readonly browsers = new Map<string, WireBrowserEnvironment>();
  private readonly firstReads = new Map<string, Promise<WireServerEnvironment | null>>();
  private secondReads: Map<string, Promise<WireServerEnvironment | null>> | null = null;

  constructor(
    private readonly runner: WireRunnerEnvironment,
    private readonly fetchImpl?: FetchLike,
  ) {}

  /** The snapshots known as the run begins: the runner's. */
  atBegin(): WireEnvironmentSnapshot[] {
    return [this.runner];
  }

  /** Note a test's end: the browser snapshot it carries, and the instrumented servers its requests reached. */
  noteTestEnd(
    attachments: ReadonlyArray<{ name: string; contentType?: string; body?: Buffer }>,
    requests?: readonly WireNetworkRequest[] | null,
  ): void {
    const browser = parseBrowserEnvironment(findPiwiAttachment(attachments, ATTACHMENT_NAMES.environment)?.body);
    if (browser && !this.browsers.has(browser.project)) {
      this.browsers.set(browser.project, { ...browser, shardIndex: this.runner.shardIndex ?? null });
    }
    if (this.secondReads) return;
    for (const origin of instrumentedOrigins(requests)) {
      if (this.firstReads.has(origin) || this.firstReads.size >= ENVIRONMENT_SNAPSHOTS_MAX) continue;
      this.firstReads.set(origin, fetchEnvironment(origin, this.fetchImpl));
    }
  }

  /** The run's last test ended: read every server again while it still runs. */
  lastTestEnded(): void {
    if (this.secondReads) return;
    this.secondReads = new Map(
      [...this.firstReads.keys()].map((origin) => [origin, fetchEnvironment(origin, this.fetchImpl)]),
    );
  }

  /**
   * Every snapshot. A server read twice says whether it restarted; one whose first read failed takes its second; a
   * run that ended before its last test (interrupted) reads none again. Each read waits `END_READ_TIMEOUT_MS` at most.
   * Never throws.
   */
  async atEnd(): Promise<WireEnvironmentSnapshot[]> {
    const bounded = (read: Promise<WireServerEnvironment | null> | undefined) =>
      read
        ? Promise.race([
            read,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), END_READ_TIMEOUT_MS).unref()),
          ])
        : Promise.resolve(null);
    const servers = await Promise.all(
      [...this.firstReads.entries()].map(async ([origin, first]): Promise<WireServerEnvironment | null> => {
        const [before, after] = await Promise.all([bounded(first), bounded(this.secondReads?.get(origin))]);
        if (!before) return after ? { ...after, restarted: null } : null;
        return { ...before, restarted: after ? serverRestarted(before, after) : null };
      }),
    );
    const all: WireEnvironmentSnapshot[] = [
      this.runner,
      ...this.browsers.values(),
      ...servers.filter((s): s is WireServerEnvironment => s !== null),
    ];
    return all.slice(0, ENVIRONMENT_SNAPSHOTS_MAX);
  }
}

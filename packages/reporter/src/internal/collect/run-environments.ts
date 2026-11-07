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

/** The longest the run's end waits for the servers' environments to be read again. */
const END_READ_TIMEOUT_MS = 6000;

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

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
 * time the run reaches its origin (its base URLs as the first test ends) and once more as the run ends, which says
 * whether it restarted meanwhile.
 */
export class RunEnvironments {
  private readonly browsers = new Map<string, WireBrowserEnvironment>();
  private readonly servers = new Map<string, Promise<WireServerEnvironment | null>>();
  private baseUrlsRead = false;

  constructor(
    private readonly runner: WireRunnerEnvironment,
    private readonly baseUrls: readonly string[],
    private readonly fetchImpl?: FetchLike,
  ) {}

  /** The snapshots known as the run begins: the runner's. */
  atBegin(): WireEnvironmentSnapshot[] {
    return [this.runner];
  }

  /** Note a test's end: the browser snapshot it carries, and the servers its requests reached. */
  noteTestEnd(
    attachments: ReadonlyArray<{ name: string; contentType?: string; body?: Buffer }>,
    requests?: readonly WireNetworkRequest[] | null,
  ): void {
    const browser = parseBrowserEnvironment(findPiwiAttachment(attachments, ATTACHMENT_NAMES.environment)?.body);
    if (browser && !this.browsers.has(browser.project)) {
      this.browsers.set(browser.project, { ...browser, shardIndex: this.runner.shardIndex ?? null });
    }
    if (!this.baseUrlsRead) {
      this.baseUrlsRead = true;
      for (const url of this.baseUrls) this.readServer(originOf(url));
    }
    for (const origin of instrumentedOrigins(requests)) this.readServer(origin);
  }

  private readServer(origin: string | null): void {
    if (!origin || this.servers.has(origin) || this.servers.size >= ENVIRONMENT_SNAPSHOTS_MAX) return;
    this.servers.set(origin, fetchEnvironment(origin, this.fetchImpl));
  }

  /** Every snapshot, each server read again to tell whether it restarted during the run. Never throws. */
  async atEnd(): Promise<WireEnvironmentSnapshot[]> {
    const servers = await Promise.all(
      [...this.servers.entries()].map(async ([origin, first]): Promise<WireServerEnvironment | null> => {
        const before = await first;
        if (!before) return null;
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), END_READ_TIMEOUT_MS).unref());
        const after = await Promise.race([fetchEnvironment(origin, this.fetchImpl), timeout]);
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

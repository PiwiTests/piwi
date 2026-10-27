/**
 * The editor's runs, for the Runs window, the popup's Runs tile and the global shortcut: the background worker finds
 * the hubs of every editor service through the Send to editor pairing (`GET …/live` beside `…/send`, the pairing's
 * token as a bearer credential), keeps a connection to each (`hub-connection.ts`) and the runs they push. The token
 * goes to the paired port only once the program there proved it holds it (`proveEditor`). The hubs' addresses and
 * tokens go to the secret area beside the editor's pairing, never to `chrome.storage.local`, and are found again
 * whenever a hub's connection fails, with a backoff. Nothing here runs in a content script or an extension page.
 */
import type { EditorPairing } from '@piwitests/core/editor-send';
import { liveUrlOf, parseLiveAnswer, type HubSession, type LiveHub } from '@piwitests/core/run-hub';
import {
  shortcutCommands,
  type RunsAnswer,
  type RunsDiscovery,
  type RunsRequest,
  type RunsRun,
  type RunsState,
} from '../shared/runs.js';
import { proveEditor } from '../shared/editor-proof.js';
import { HubConnection, type HubLoss, type HubTimings, type OpenSocket } from './hub-connection.js';

export interface RunHubsDeps {
  /** The paired editor, its address and token checked as a pasted pairing is; null when none. */
  pairing(): Promise<EditorPairing | null>;
  /** Whether the editor's address is granted to the extension. */
  granted(pairing: EditorPairing): Promise<boolean>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  open: OpenSocket;
  /** The hubs found last, kept in the secret area. */
  readHubs(): Promise<LiveHub[]>;
  writeHubs(hubs: LiveHub[]): Promise<void>;
  now?(): number;
  timings?: HubTimings;
}

/** How long the editor's live endpoint may take to answer. */
const LIVE_TIMEOUT_MS = 5000;
/** The first wait before the hubs are found again after a failure; it doubles up to `MAX_RETRY_MS`. */
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
/** With no Runs window open, how many times in a row the hubs are found again before the worker waits to be asked. */
const UNWATCHED_RETRIES = 4;
/** How long an ended run stays in the window, and how many do. */
const ENDED_KEPT_MS = 10 * 60_000;
const ENDED_KEPT = 5;
/** How long `ready` waits for the hubs to answer `subscribe`. */
const READY_MS = 3000;

type CommandRequest = Extract<RunsRequest, { type: 'command' }>;

/** A command that never reached a hub. */
const OFFLINE: RunsAnswer = { ok: false, message: '', failure: 'offline' };

export class RunHubs {
  private discovery: RunsDiscovery = 'searching';
  private hubs: LiveHub[] = [];
  private readonly connections = new Map<string, HubConnection>();
  private ended: Array<{ hub: string; session: HubSession; at: number }> = [];
  private finding: Promise<void> | null = null;
  private findAgain = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly deps: RunHubsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Hears every change; while a listener (a Runs window) is there, failures are retried without end. */
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state(): RunsState {
    const live: RunsRun[] = [];
    for (const hub of this.hubs) {
      for (const session of this.connections.get(hub.url)?.sessions.values() ?? [])
        live.push({ hub: hub.url, session });
    }
    const cutoff = this.now() - ENDED_KEPT_MS;
    this.ended = this.ended.filter((run) => run.at >= cutoff);
    const ended = this.ended.map(({ hub, session }) => ({ hub, session }));
    return {
      discovery: this.discovery,
      hubs: this.hubs.map((hub) => {
        const connection = this.connections.get(hub.url);
        return {
          id: hub.url,
          connected: connection?.state === 'open',
          client: connection?.welcome?.client ?? hub.client,
        };
      }),
      runs: [...live, ...ended],
    };
  }

  /** Whether a hub answers now. */
  connected(): boolean {
    return [...this.connections.values()].some((connection) => connection.state === 'open');
  }

  /** Asks the editor for its hubs, and connects to each; one call at a time, a call meanwhile runs once more after. */
  find(): Promise<void> {
    if (this.finding) {
      this.findAgain = true;
      return this.finding;
    }
    this.finding = (async () => {
      do {
        this.findAgain = false;
        await this.findNow().catch(() => this.settle('unreachable', this.hubs));
      } while (this.findAgain);
    })().finally(() => {
      this.finding = null;
    });
    return this.finding;
  }

  /** The hubs found and their runs heard, within a few seconds: what the popup, the window and the shortcut wait for. */
  async ready(): Promise<void> {
    if (!this.connected()) await this.find();
    const connections = [...this.connections.values()];
    await Promise.race([
      Promise.all(connections.map((connection) => connection.ready)),
      new Promise((resolve) => setTimeout(resolve, READY_MS)),
    ]);
  }

  /** Passes a command of the window to its hub. */
  command(request: Omit<CommandRequest, 'type' | 'id'>): Promise<RunsAnswer> {
    const connection = this.connections.get(request.hub);
    if (!connection) return Promise.resolve(OFFLINE);
    const { ref, worker, since, what } = request;
    if (what === 'image') {
      return worker === null ? Promise.resolve(OFFLINE) : connection.command({ type: 'pausedPage', ref, worker });
    }
    if (what === 'pick' || what === 'record') {
      // `parseRunsRequest` takes none without the stop it answers.
      return since === null ? Promise.resolve(OFFLINE) : connection.command({ type: what, ref, worker, since });
    }
    return connection.command({ type: 'runControl', ref, worker, action: what, since });
  }

  /** The global shortcut: resumes every stopped test, else pauses every run (`shortcutCommands`). */
  async shortcut(): Promise<RunsAnswer[]> {
    await this.ready();
    return Promise.all(
      shortcutCommands(this.state().runs).map(({ action, ...run }) => this.command({ ...run, what: action })),
    );
  }

  private async findNow(): Promise<void> {
    const pairing = await this.deps.pairing();
    if (!pairing) return this.settle('unpaired', []);
    const live = liveUrlOf(pairing.url);
    if (!live) return this.settle('outdated', []);
    if (!(await this.deps.granted(pairing))) return this.settle('no-access', []);
    const proof = await proveEditor(live, pairing.token, this.deps.fetch);
    // The editor is closed, or the window that held its port: the hubs found last may still be there.
    if (proof === 'unreachable') return this.settle('unreachable', await this.storedHubs());
    if (proof === 'outdated') return this.settle('outdated', []);
    if (proof === 'unproven') return this.settle('unproven', await this.storedHubs());
    let response: Response;
    try {
      response = await this.deps.fetch(live, {
        headers: { Authorization: `Bearer ${pairing.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      });
    } catch {
      // The editor is closed, or the window that held its port: the hubs found last may still be there.
      return this.settle('unreachable', await this.storedHubs());
    }
    if (response.status === 401 || response.status === 403) return this.settle('refused', []);
    if (response.status === 404) return this.settle('outdated', []);
    const hubs = response.ok ? parseLiveAnswer(await response.json().catch(() => null)) : null;
    if (!hubs) return this.settle('unreachable', await this.storedHubs());
    await this.deps.writeHubs(hubs).catch(() => undefined);
    return this.settle('found', hubs);
  }

  private async storedHubs(): Promise<LiveHub[]> {
    return this.deps.readHubs().catch(() => []);
  }

  /** Keeps a connection to each of `hubs`, and to nothing else. */
  private settle(discovery: RunsDiscovery, hubs: LiveHub[]): void {
    this.discovery = discovery;
    this.hubs = hubs;
    if (discovery === 'unpaired' || discovery === 'refused' || discovery === 'no-access' || discovery === 'outdated') {
      void this.deps.writeHubs([]).catch(() => undefined);
      this.ended = [];
    }
    for (const [url, connection] of this.connections) {
      if (!hubs.some((hub) => hub.url === url && hub.token === connection.hub.token)) {
        this.connections.delete(url);
        connection.close();
      }
    }
    for (const hub of hubs) if (!this.connections.has(hub.url)) this.connect(hub);
    // An editor not open yet, or open with no service sharing its runs, may be soon; a pairing to fix waits for it.
    if (discovery === 'unreachable' || discovery === 'unproven' || (discovery === 'found' && hubs.length === 0)) {
      this.retryLater();
    }
    this.changed();
  }

  private connect(hub: LiveHub): void {
    const connection: HubConnection = new HubConnection(
      hub,
      this.deps.open,
      {
        changed: () => {
          if (connection.state === 'open') this.retries = 0;
          this.changed();
        },
        ended: (session) => this.keepEnded(hub.url, session, connection.sessions.get(session.ref)),
        lost: (why) => this.lost(hub, connection, why),
      },
      this.deps.timings,
    );
    this.connections.set(hub.url, connection);
  }

  /** An ended run keeps the workers it had last, so the window still names its tests. */
  private keepEnded(hub: string, session: HubSession, before: HubSession | undefined): void {
    const workers = session.workers.length > 0 ? session.workers : (before?.workers ?? []);
    this.ended = [
      { hub, session: { ...session, workers }, at: this.now() },
      ...this.ended.filter((run) => !(run.hub === hub && run.session.ref === session.ref)),
    ].slice(0, ENDED_KEPT);
  }

  private lost(hub: LiveHub, connection: HubConnection, why: HubLoss): void {
    if (this.connections.get(hub.url) === connection) this.connections.delete(hub.url);
    if (why === 'refused') {
      // A token the hub no longer takes: the editor names the hubs again.
      this.hubs = this.hubs.filter((h) => h.url !== hub.url);
      void this.storedHubs().then((stored) => this.deps.writeHubs(stored.filter((h) => h.url !== hub.url)));
    }
    this.retryLater();
  }

  /** Finds the hubs again after a wait that doubles with each failure in a row. */
  private retryLater(): void {
    if (this.retryTimer) return;
    if (this.listeners.size === 0 && this.retries >= UNWATCHED_RETRIES) return;
    const wait = Math.min(FIRST_RETRY_MS * 2 ** this.retries, MAX_RETRY_MS);
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.find();
    }, wait);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

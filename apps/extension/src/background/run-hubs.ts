/**
 * The editor's runs, for the Runs window, the popup's Runs tile and the global shortcut: the background worker finds
 * the hubs of every editor service through the Send to editor pairing (`GET …/live` beside `…/send`, the pairing's
 * token as a bearer credential), keeps a connection to each (`hub-connection.ts`) and the runs they push. The token
 * goes to the paired port only once the program there proved it holds it (`proveEditor`). The hubs' addresses and
 * tokens go to the secret area beside the editor's pairing, never to `chrome.storage.local`, and are found again
 * whenever a hub's connection fails, with a backoff. What each code written at a stop came to goes to the listeners,
 * with the hub that said it. While a listener (a Runs window) is there, each connection says the runs are followed
 * (`follow`), which holds a failure no pause bar shows for the person watching: as the first window opens, on each
 * connection that opens while one is, and `on: false` as the last one closes.
 *
 * A window watches a stop's live view through the hub's `view`: the worker's one connection to the hub watches a
 * stop while any window does, and stops as the last one stops, closes or the stop ends. Each frame goes to the windows
 * that watch its stop alone, at most `MAX_VIEW_FPS` a second to each, the latest one waiting, no other; nothing keeps
 * one. A window's input goes on only for a stop it watches itself. A connection lost ends the views it carried, and
 * each window watching one hears so. Nothing here runs in a content script or an extension page.
 */
import type { EditorPairing } from '@piwitests/core/editor-send';
import {
  liveUrlOf,
  parseLiveAnswer,
  type HubFrameMessage,
  type HubSession,
  type LiveHub,
} from '@piwitests/core/run-hub';
import { LatestPacer, MAX_VIEW_FPS } from '@piwitests/core/run-view';
import {
  shortcutCommands,
  stateForViewer,
  viewKey,
  type RunsAnswer,
  type RunsCode,
  type RunsDiscovery,
  type RunsFrame,
  type RunsRequest,
  type RunsRun,
  type RunsState,
  type RunsView,
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

/** Who follows the runs: it hears each change, and what each code written at a stop came to. */
interface RunsListener {
  changed(): void;
  code(code: RunsCode): void;
}

/** A command that never reached a hub. */
const OFFLINE: RunsAnswer = { ok: false, message: '', failure: 'offline' };
/** Input for a stop the window does not watch itself. */
const UNWATCHED: RunsAnswer = { ok: false, message: '', failure: 'unwatched' };
/** The least time between two frames of one view to one window. */
const FRAME_MS = 1000 / MAX_VIEW_FPS;

/** A Runs window, as the live views it watches know it: where their frames go, and where it hears one ended. */
export interface RunsViewer {
  frame(frame: RunsFrame): void;
  /** A view it watched ended without its asking: the hub's connection was lost. */
  ended(view: RunsView): void;
}

/** A stop's live view some window watches: each window that does, with the pace of its frames. */
interface Watch {
  view: RunsView;
  viewers: Map<RunsViewer, LatestPacer<RunsFrame>>;
}

export class RunHubs {
  private discovery: RunsDiscovery = 'searching';
  private hubs: LiveHub[] = [];
  private readonly connections = new Map<string, HubConnection>();
  private ended: Array<{ hub: string; session: HubSession; at: number }> = [];
  private finding: Promise<void> | null = null;
  private findAgain = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private readonly listeners = new Set<RunsListener>();
  /** The live views some window watches, by `viewKey`. */
  private readonly watches = new Map<string, Watch>();
  private readonly now: () => number;

  constructor(private readonly deps: RunHubsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Hears every change, and what each code written at a stop came to; while a listener (a Runs window) is there,
   * failures are retried without end, and each hub hears that the runs are followed.
   */
  listen(changed: () => void, code: (code: RunsCode) => void = () => {}): () => void {
    const listener: RunsListener = { changed, code };
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.follow(true);
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) this.follow(false);
    };
  }

  /** Tells each open connection whether a person follows the runs, a Runs window open. */
  private follow(on: boolean): void {
    for (const connection of this.connections.values()) {
      if (connection.state === 'open') void connection.command({ type: 'follow', on });
    }
  }

  /**
   * The runs, and what the hubs were found to be. For a window (`viewer`), each stop takes from it what it takes from
   * a hub connection that watches the views that window watches (`stateForViewer`).
   */
  state(viewer?: RunsViewer): RunsState {
    const state = this.allRuns();
    return viewer ? stateForViewer(state, (view) => this.watching(view, viewer)) : state;
  }

  private allRuns(): RunsState {
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

  /** Passes a command of a window (`viewer`, for the live view's commands) to its hub. */
  command(request: Omit<CommandRequest, 'type' | 'id'>, viewer?: RunsViewer): Promise<RunsAnswer> {
    const connection = this.connections.get(request.hub);
    if (!connection) return Promise.resolve(OFFLINE);
    const { ref, worker, since, what } = request;
    switch (what) {
      case 'view':
        return this.view(connection, request, viewer);
      case 'input': {
        // `parseRunsRequest` takes none without the worker, the stop and its events.
        if (worker === null || since === null || !request.events) return Promise.resolve(OFFLINE);
        if (!viewer || !this.watching({ hub: request.hub, ref, worker, since }, viewer)) {
          return Promise.resolve(UNWATCHED);
        }
        return connection.command({ type: 'input', ref, worker, since, events: request.events });
      }
      case 'pick-at': {
        const { x, y } = request;
        if (since === null || x === undefined || y === undefined) return Promise.resolve(OFFLINE);
        return connection.command({ type: 'pick-at', ref, worker, since, x, y });
      }
      case 'image':
        return worker === null ? Promise.resolve(OFFLINE) : connection.command({ type: 'pausedPage', ref, worker });
      case 'pause':
      case 'step':
      case 'resume':
      case 'finish':
        return connection.command({ type: 'runControl', ref, worker, action: what, since });
      case 'mock':
        // `parseRunsRequest` takes none without the stop it answers and the response it mocks.
        return since === null || request.request === undefined
          ? Promise.resolve(OFFLINE)
          : connection.command({ type: 'mock', ref, worker, since, request: request.request });
      case 'requests':
        return since === null ? Promise.resolve(OFFLINE) : connection.command({ type: 'requests', ref, worker, since });
      default:
        // Pick, Record, Assert and Assert a region: an intent started in the test's window, at the stop it names.
        return since === null ? Promise.resolve(OFFLINE) : connection.command({ type: what, ref, worker, since });
    }
  }

  /** Whether a window watches a stop's live view, or asked to and was not answered yet. */
  private watching(view: RunsView, viewer: RunsViewer): boolean {
    return !!this.watches.get(viewKey(view))?.viewers.has(viewer);
  }

  /**
   * A window starts or stops watching a stop's live view. The hub hears `view` as the first window starts, and as the
   * last one stops; the frames that come before the hub's answer go to the window already, and a refusal takes it
   * off.
   */
  private async view(
    connection: HubConnection,
    request: Omit<CommandRequest, 'type' | 'id'>,
    viewer: RunsViewer | undefined,
  ): Promise<RunsAnswer> {
    const { hub, ref, worker, since, on } = request;
    if (!viewer || worker === null || since === null || on === undefined) return OFFLINE;
    const view: RunsView = { hub, ref, worker, since };
    const key = viewKey(view);
    if (!on) return (await this.leave(key, viewer)) ?? { ok: true, message: '' };
    let watch = this.watches.get(key);
    if (!watch) {
      watch = { view, viewers: new Map() };
      this.watches.set(key, watch);
    }
    if (!watch.viewers.has(viewer)) {
      watch.viewers.set(viewer, new LatestPacer({ intervalMs: FRAME_MS, send: (frame) => viewer.frame(frame) }));
    }
    const answer = await connection.command({ type: 'view', ref, worker, since, on: true });
    if (!answer.ok && this.watches.get(key) === watch) {
      watch.viewers.get(viewer)?.close();
      watch.viewers.delete(viewer);
      if (watch.viewers.size === 0) this.watches.delete(key);
    }
    return answer;
  }

  /** A window stops watching a view: the last one to go has the hub stop it, while its stop holds. */
  private leave(key: string, viewer: RunsViewer): Promise<RunsAnswer> | null {
    const watch = this.watches.get(key);
    if (!watch?.viewers.has(viewer)) return null;
    watch.viewers.get(viewer)!.close();
    watch.viewers.delete(viewer);
    if (watch.viewers.size > 0) return null;
    this.watches.delete(key);
    const { hub, ref, worker, since } = watch.view;
    const connection = this.connections.get(hub);
    if (connection?.state !== 'open' || !stopsAt(connection, watch.view)) return null;
    return connection.command({ type: 'view', ref, worker, since, on: false });
  }

  /** A window closed: it watches nothing any more. */
  unwatchAll(viewer: RunsViewer): void {
    for (const key of this.watches.keys()) void this.leave(key, viewer);
  }

  /** A frame of a view some window watches goes to those that watch it, while its stop holds. */
  private frame(hub: string, connection: HubConnection, { type: _type, ...frame }: HubFrameMessage): void {
    const view: RunsView = { hub, ref: frame.ref, worker: frame.worker, since: frame.since };
    const watch = this.watches.get(viewKey(view));
    if (!watch || !stopsAt(connection, view)) return;
    for (const pacer of watch.viewers.values()) pacer.offer({ hub, ...frame });
  }

  /** The views of a hub whose stop ended: the hub ended them with it. */
  private prune(hub: string, connection: HubConnection): void {
    for (const [key, watch] of this.watches) {
      if (watch.view.hub !== hub || stopsAt(connection, watch.view)) continue;
      for (const pacer of watch.viewers.values()) pacer.close();
      this.watches.delete(key);
    }
  }

  /** The views a hub's connection carried end with it: each window that watched one hears so. */
  private endViews(hub: string): void {
    for (const [key, watch] of this.watches) {
      if (watch.view.hub !== hub) continue;
      this.watches.delete(key);
      for (const [viewer, pacer] of watch.viewers) {
        pacer.close();
        viewer.ended(watch.view);
      }
    }
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
    // Another program holds the paired port: no hub's token goes anywhere until the editor proves itself again.
    if (proof === 'unproven') return this.settle('unproven', []);
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
        this.endViews(url);
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
        // A connection that opens starts the count of failures again; a run's changes on another one do not.
        opened: () => {
          this.retries = 0;
          if (this.listeners.size > 0) void connection.command({ type: 'follow', on: true });
        },
        changed: () => {
          this.prune(hub.url, connection);
          this.changed();
        },
        ended: (session) => this.keepEnded(hub.url, session, connection.sessions.get(session.ref)),
        code: ({ type: _type, warnings = [], ...code }) => {
          for (const listener of this.listeners) listener.code({ hub: hub.url, ...code, warnings });
        },
        frame: (frame) => this.frame(hub.url, connection, frame),
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
    if (this.connections.get(hub.url) === connection) {
      this.connections.delete(hub.url);
      this.endViews(hub.url);
    }
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
    for (const listener of this.listeners) listener.changed();
  }
}

/** Whether a connection's runs have the view's worker stopped at the view's stop. */
function stopsAt(connection: HubConnection, view: RunsView): boolean {
  const worker = connection.sessions.get(view.ref)?.workers.find((w) => w.worker === view.worker);
  return worker?.state === 'stopped' && worker.stop?.since === view.since;
}

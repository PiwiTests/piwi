/**
 * The runs the editor started, as their workers tell them over the run channel (`@piwitests/core/run-channel`): a
 * session per run, by the ref of its command (`PIWI_ORIGIN_REF`), holding its workers, the test each one runs and
 * where it stands stopped. The record channel's socket (`recorder/handoff.ts`) hands each worker's run connection here.
 * The client hears each session (`piwi/runSessionChanged`) and steers it (`piwi/runControl`, `piwi/setRunBreakpoints`,
 * `piwi/pausedPage`). A worker names places relative to the run's working directory; the client, by their file's URI
 * as the workspace names it: the session converts both ways. A stop that shows no pause bar while the client cannot
 * answer stops is resumed at once. A worker's connection that closes lets a stop no pause bar shows go on; a stop the
 * bar shows waits there for its answer.
 */
import * as path from 'node:path';
import type * as net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRunToHub, type HubToRun, type Place, type RunToHub } from '@piwitests/core/run-channel';
import type {
  PausedImage,
  PausedPageParams,
  PausedPageResult,
  RunControlParams,
  RunControlResult,
  RunSession,
  RunStop,
  RunTest,
  SetRunBreakpointsParams,
} from './protocol.js';
import { relativeTo } from './workspace.js';

/** How often a session's changes are sent at most, but a stop and its end, which are sent at once. */
export const SESSION_PACE_MS = 300;
/** The least time between two notifications of a session: a burst of stops and their ends is sent once in it. */
export const SESSION_BURST_MS = 50;
/** How long a session waits for a worker after its last one left before it ends: Playwright starts a new one. */
export const SESSION_LINGER_MS = 5_000;
/** How long `piwi/pausedPage` waits for the worker's answer. */
export const PAUSED_PAGE_WAIT_MS = 10_000;
/** The runs whose breakpoints the service keeps for workers that connect later, at most. */
const MAX_BREAKPOINT_RUNS = 50;

type RunAttach = Extract<RunToHub, { type: 'run-attach' }>;

export interface RunSessionsOptions {
  /** A session changed, or ended: the client hears it. */
  notify(session: RunSession): void;
  /** Whether the client shows the stops and answers them (`InitializationOptions.runControl`). */
  answersStops(): boolean;
  /** A sentence for the client to show once, about the folder `root`. */
  notice(root: string, severity: 'information' | 'warning', message: string): void;
  /** The folder of the Playwright config a run's working directory is, as the workspace names it; null for none. */
  rootOf(cwd: string): string | null;
  paceMs?: number;
  burstMs?: number;
  lingerMs?: number;
  requestMs?: number;
}

interface Worker {
  socket: net.Socket;
  index: number;
  parallelIndex: number;
  /** The run's working directory, which the worker's places are relative to. */
  cwd: string;
  test: RunTest | null;
  /** Where it stands stopped, and the worker's number for that stop. */
  stop: { id: number; view: RunStop } | null;
  pausing: boolean;
  /** The requests waiting for the worker's answer. */
  requests: Map<number, (image: PausedImage | null) => void>;
}

interface Session {
  ref: string;
  root: string | null;
  workers: Map<number, Worker>;
  ended: boolean;
  /** What the client last heard of it, and when. */
  sent: string;
  sentAt: number;
  /** The notification on its way, and when it goes. */
  paced: ReturnType<typeof setTimeout> | null;
  pacedAt: number;
  linger: ReturnType<typeof setTimeout> | null;
  /** The time of its latest stop, in milliseconds: each stop's is later. */
  stoppedAt: number;
  /** The client heard that a stop of this run was resumed for it. */
  resumedSaid: boolean;
}

function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export class RunSessions {
  private readonly sessions = new Map<string, Session>();
  /** The breakpoints a client sent for each run, as files and 0-based lines, newest last. */
  private readonly breakpoints = new Map<string, Array<{ file: string; line: number }>>();
  private requests = 0;

  constructor(private readonly options: RunSessionsOptions) {}

  /**
   * A worker connected with `attach`: it joins its run's session, a new one when none runs, and hears the breakpoints
   * sent for the run since it started. Returns where its next lines go. A connection naming the index of a worker
   * connected now is closed: another process the run's environment reached (a test running Playwright itself) takes
   * no worker's place. The workers of a command that ended are let go with its session (`commandEnded`), so those of
   * a rerun start a new one.
   */
  attach(socket: net.Socket, attach: RunAttach): (line: string) => void {
    let session = this.sessions.get(attach.ref);
    const holder = session?.workers.get(attach.workerIndex);
    if (holder && !holder.socket.destroyed) {
      socket.destroy();
      return () => {};
    }
    if (!session) {
      session = {
        ref: attach.ref,
        root: this.options.rootOf(attach.cwd),
        workers: new Map(),
        ended: false,
        sent: '',
        sentAt: 0,
        paced: null,
        pacedAt: 0,
        linger: null,
        stoppedAt: 0,
        resumedSaid: false,
      };
      this.sessions.set(attach.ref, session);
    }
    if (session.linger) clearTimeout(session.linger);
    session.linger = null;
    const worker: Worker = {
      socket,
      index: attach.workerIndex,
      parallelIndex: attach.parallelIndex,
      cwd: attach.cwd,
      test: null,
      stop: null,
      pausing: false,
      requests: new Map(),
    };
    session.workers.set(worker.index, worker);
    // A worker of that index whose connection closed, before its close was heard.
    if (holder) this.closeWorker(holder);
    const own = session;
    socket.on('close', () => this.detach(own, worker));
    const breakpoints = this.breakpoints.get(attach.ref);
    if (breakpoints) this.sendBreakpoints(worker, breakpoints, session.root);
    this.changed(session);
    return (line) => this.read(own, worker, line);
  }

  /** `piwi/runControl`: what the worker was asked, or why nothing was. */
  control(params: RunControlParams): RunControlResult {
    const refuse = (message: string): RunControlResult => ({ ok: false, message });
    const session = typeof params?.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    if (!session?.workers.size) return refuse('No worker of this run is connected to the editor.');
    const named = typeof params.worker === 'number' ? (session.workers.get(params.worker) ?? null) : null;
    if (typeof params.worker === 'number' && !named) {
      return refuse(`Worker ${params.worker} of this run is not connected to the editor.`);
    }
    const workers = named ? [named] : [...session.workers.values()];
    switch (params.action) {
      case 'pause': {
        const asked = workers.filter((w) => !w.stop && !w.test?.cannotPause);
        if (!asked.length) {
          if (workers.some((w) => w.stop)) return refuse('The test is stopped already.');
          const why = workers.find((w) => w.test?.cannotPause)?.test?.cannotPause;
          return refuse(`The test does not stop${why ? `: ${why}` : ''}.`);
        }
        for (const worker of asked) {
          this.send(worker, { type: 'control', action: 'pause' });
          worker.pausing = true;
        }
        this.changed(session, true);
        return {
          ok: true,
          message:
            asked.length > 1 ? `Pausing ${asked.length} workers at their next call.` : 'Pausing at the next call.',
        };
      }
      case 'step':
      case 'resume':
      case 'finish':
      case 'run-to': {
        // A control naming the stop it answers reaches no worker past it.
        const since = typeof params.since === 'string' ? params.since : null;
        const stopped = workers.filter((w) => w.stop && (since === null || w.stop.view.since === since));
        if (since !== null && !stopped.length) return refuse('The test went on.');
        if (!stopped.length) {
          if (named) return refuse(named.test ? 'The test is running.' : 'The worker runs no test now.');
          return refuse(workers.some((w) => w.test) ? 'The test is running.' : 'No test runs now.');
        }
        if (stopped.length > 1) return refuse(`${stopped.length} workers are stopped: choose one.`);
        const worker = stopped[0]!;
        const stop = worker.stop!.id;
        if (params.action === 'run-to') {
          const file = typeof params.place?.uri === 'string' ? uriToPath(params.place.uri) : null;
          const line = params.place?.line;
          if (!file || typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
            return refuse('Run to needs a line of a file.');
          }
          const relative = this.relative(worker, file, session.root);
          if (!relative) return refuse(`${path.basename(file)} is outside the folder the run runs in.`);
          this.send(worker, { type: 'run-to', stop, place: { file: relative, line: line + 1 } });
          return { ok: true, message: `Running to ${path.basename(file)}:${line + 1}.` };
        }
        this.send(worker, { type: 'control', action: params.action, stop });
        return {
          ok: true,
          message:
            params.action === 'step'
              ? 'Stepping to the next call.'
              : params.action === 'resume'
                ? 'Resuming.'
                : 'Finishing the test without stopping at a breakpoint.',
        };
      }
      default:
        return refuse(`Piwi does not know the action ${JSON.stringify(params.action)}.`);
    }
  }

  /** `piwi/setRunBreakpoints`: the run's workers stop at these lines from now on, a worker that starts later too. */
  setBreakpoints(params: SetRunBreakpointsParams): void {
    if (typeof params?.ref !== 'string' || !Array.isArray(params.places)) return;
    const files = params.places.flatMap((place) => {
      const file = typeof place?.uri === 'string' ? uriToPath(place.uri) : null;
      return file && Number.isInteger(place.line) && place.line >= 0 ? [{ file, line: place.line }] : [];
    });
    this.breakpoints.delete(params.ref);
    this.breakpoints.set(params.ref, files);
    for (const oldest of this.breakpoints.keys()) {
      if (this.breakpoints.size <= MAX_BREAKPOINT_RUNS) break;
      this.breakpoints.delete(oldest);
    }
    const session = this.sessions.get(params.ref);
    for (const worker of session?.workers.values() ?? []) this.sendBreakpoints(worker, files, session!.root);
  }

  /** `piwi/pausedPage`: an image of a stopped worker's page, null when there is none. */
  pausedPage(params: PausedPageParams): Promise<PausedPageResult> {
    const worker = typeof params?.ref === 'string' ? this.sessions.get(params.ref)?.workers.get(params.worker) : null;
    if (!worker?.stop || params.what !== 'image') return Promise.resolve({ image: null });
    const request = ++this.requests;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        worker.requests.delete(request);
        resolve({ image: null });
      }, this.options.requestMs ?? PAUSED_PAGE_WAIT_MS);
      timer.unref?.();
      worker.requests.set(request, (image) => {
        clearTimeout(timer);
        resolve({ image });
      });
      this.send(worker, { type: 'request', request, what: 'image' });
    });
  }

  /**
   * The client said the command of `ref` ended: its run ended with it. The connections of its workers, whose process
   * is ending, are closed, which lets a stop no pause bar shows go on at once.
   */
  commandEnded(ref: string): void {
    const session = this.sessions.get(ref);
    if (session) this.end(session);
  }

  /** The service stops: every worker's connection closes, which lets a stop no pause bar shows go on. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.paced) clearTimeout(session.paced);
      if (session.linger) clearTimeout(session.linger);
      for (const worker of session.workers.values()) this.closeWorker(worker);
    }
    this.sessions.clear();
  }

  private read(session: Session, worker: Worker, line: string): void {
    if (session.workers.get(worker.index) !== worker) return;
    const message = parseRunToHub(line);
    if (!message) return;
    switch (message.type) {
      case 'test-begin':
        worker.test = {
          id: message.testId,
          title: message.title,
          uri: this.uri(worker, message.file, session.root),
          line: message.line - 1,
          project: message.project,
          retry: message.retry,
          cannotPause: message.cannotPause,
        };
        worker.stop = null;
        if (message.cannotPause) worker.pausing = false;
        return this.changed(session);
      case 'stopped':
        worker.stop = {
          id: message.stop,
          view: {
            reason: message.reason,
            title: message.title,
            uri: this.uri(worker, message.place.file, session.root),
            line: message.place.line - 1,
            character: message.place.column ? message.place.column - 1 : null,
            locator: message.locator,
            bar: message.bar,
            since: this.stamp(session),
          },
        };
        worker.pausing = false;
        this.changed(session, true);
        if (!message.bar && !this.options.answersStops()) this.resumeUnanswered(session, worker, message.place);
        return;
      case 'running':
        if (worker.stop?.id !== message.stop) return;
        worker.stop = null;
        return this.changed(session, true);
      case 'test-end':
        if (worker.test?.id === message.testId) worker.test = null;
        worker.stop = null;
        return this.changed(session);
      case 'answer': {
        const answer = worker.requests.get(message.request);
        worker.requests.delete(message.request);
        return answer?.(message.value);
      }
      case 'notice':
        return this.options.notice(session.root ?? worker.cwd, 'warning', message.message);
    }
  }

  /** A stop no one can answer: no pause bar shows it, and the client shows no stop. It goes on, said once a run. */
  private resumeUnanswered(session: Session, worker: Worker, place: Place): void {
    this.send(worker, { type: 'control', action: 'resume', stop: worker.stop!.id });
    if (session.resumedSaid) return;
    session.resumedSaid = true;
    this.options.notice(
      session.root ?? worker.cwd,
      'information',
      `Piwi resumed the test stopped at ${path.basename(place.file)}:${place.line}: no pause bar shows in a headless ` +
        'browser, and this editor does not show where a run stops. Run it headed to pause there.',
    );
  }

  /** The time of a stop, ISO 8601, later than the run's stop before it, so it names this stop alone. */
  private stamp(session: Session): string {
    session.stoppedAt = Math.max(Date.now(), session.stoppedAt + 1);
    return new Date(session.stoppedAt).toISOString();
  }

  /**
   * A worker's connection closes, which lets a stop no pause bar shows go on, and its requests are answered with
   * nothing.
   */
  private closeWorker(worker: Worker): void {
    worker.socket.destroy();
    for (const answer of worker.requests.values()) answer(null);
    worker.requests.clear();
  }

  private detach(session: Session, worker: Worker): void {
    if (session.workers.get(worker.index) !== worker) return;
    session.workers.delete(worker.index);
    this.closeWorker(worker);
    if (session.ended) return;
    this.changed(session, true);
    if (session.workers.size) return;
    session.linger = setTimeout(() => this.end(session), this.options.lingerMs ?? SESSION_LINGER_MS);
    session.linger.unref?.();
  }

  /** The run ended: the client hears it last, and a later worker of its ref starts a new session. */
  private end(session: Session): void {
    if (session.ended) return;
    session.ended = true;
    if (session.linger) clearTimeout(session.linger);
    session.linger = null;
    const workers = [...session.workers.values()];
    session.workers.clear();
    for (const worker of workers) this.closeWorker(worker);
    if (this.sessions.get(session.ref) === session) this.sessions.delete(session.ref);
    this.flush(session);
  }

  /**
   * The client hears the session: for `now`, at once, or with the next burst when it heard it moments ago; else within
   * the pace.
   */
  private changed(session: Session, now = false): void {
    const at = now
      ? session.sentAt + (this.options.burstMs ?? SESSION_BURST_MS)
      : Date.now() + (this.options.paceMs ?? SESSION_PACE_MS);
    if (now && at <= Date.now()) return this.flush(session);
    if (session.paced && session.pacedAt <= at) return;
    if (session.paced) clearTimeout(session.paced);
    session.pacedAt = at;
    session.paced = setTimeout(() => this.flush(session), Math.max(0, at - Date.now()));
    session.paced.unref?.();
  }

  private flush(session: Session): void {
    if (session.paced) clearTimeout(session.paced);
    session.paced = null;
    const view: RunSession = {
      ref: session.ref,
      root: session.root,
      workers: [...session.workers.values()]
        .sort((a, b) => a.index - b.index)
        .map((worker) => ({
          worker: worker.index,
          parallelIndex: worker.parallelIndex,
          state: worker.stop ? 'stopped' : worker.test ? 'running' : 'between',
          test: worker.test,
          stop: worker.stop?.view ?? null,
          pausing: worker.pausing,
        })),
      ended: session.ended,
    };
    const text = JSON.stringify(view);
    if (text === session.sent) return;
    session.sent = text;
    session.sentAt = Date.now();
    this.options.notify(view);
  }

  private send(worker: Worker, message: HubToRun): void {
    if (!worker.socket.destroyed) worker.socket.write(`${JSON.stringify(message)}\n`);
  }

  private sendBreakpoints(worker: Worker, files: Array<{ file: string; line: number }>, root: string | null): void {
    const places = new Map<string, Place>();
    for (const { file, line } of files) {
      const relative = this.relative(worker, file, root);
      if (relative) places.set(`${relative}:${line}`, { file: relative, line: line + 1 });
    }
    this.send(worker, { type: 'breakpoints', places: [...places.values()] });
  }

  /**
   * A file of the client's, relative to the run's working directory, or to the workspace's spelling of its folder
   * (`root`: the run ran in the folder as the file system spells it); null outside it.
   */
  private relative(worker: Worker, file: string, root: string | null): string | null {
    return relativeTo(worker.cwd, file) ?? (root ? relativeTo(root, file) : null);
  }

  /** The URI of a worker's file, under the workspace's spelling of the run's folder when it is in it. */
  private uri(worker: Worker, file: string, root: string | null): string {
    const absolute = path.resolve(worker.cwd, file);
    const relative = root ? relativeTo(worker.cwd, absolute) : null;
    return pathToFileURL(relative ? path.join(root!, relative) : absolute).href;
  }
}

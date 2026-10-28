/**
 * Desktop shell only: the window's side of the hub the bundled server is for the Playwright runs the shell starts
 * (`server/utils/desktop-runs.ts`). One stream for the whole window (`GET /api/desktop/runs/events`), opened only
 * while the window wants it (`want`): while a run of the Local runs tray runs, or the hub still has a live run. While
 * it is open the window is a surface that answers stops, so a headless stop waits for it: the tray shows every stop
 * it hears (`onStop`), once, a stream that opens again included, and the stop waits there; closed, nobody here answers
 * and such a stop goes on at once, unless Piwi Picker follows the runs.
 *
 * What it keeps: each live run as the hub last told it, what each code made at a stop came to, and the codes and
 * the locators picked, to copy. The frames of a stop's live view go to whoever listens for that view (`onFrame`):
 * none is reactive state, and only the latest one of each view is kept, in memory, until the view ends. Commands go to
 * `POST /api/desktop/runs/commands`, naming the stream (`viewer`); `show` says which runs the person opened in the
 * window, so a failure no pause bar shows is held in them, and is said again as the stream opens again.
 */
import {
  parseHubMessage,
  type HubAnswer,
  type HubCodeMessage,
  type HubFrameMessage,
  type HubFrameRefusal,
  type HubSession,
  type HubWorker,
} from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';
import {
  isDesktopRunViewer,
  MAX_KEPT_STOP_CODES,
  type DesktopRunEvent,
  type DesktopRunPick,
} from '#shared/desktop-runs';
import { errorMessage } from '~/utils';
import { desktopViewKey, desktopWorkerKey } from '~/utils/desktop-run-view';

/** A code made at a stop, or a locator picked, in the order they came, each with the number it came as. */
export type DesktopKept =
  | { serial: number; type: 'stop-code'; code: StopCode }
  | { serial: number; type: 'pick'; pick: DesktopRunPick };

/** What the hub answered a command, as the window reads it: the hub's answer, or why it never reached the hub. */
export type DesktopRunAnswer = Pick<HubAnswer, 'ok' | 'message' | 'image' | 'requests' | 'locator'>;

/** What a code made at a stop came to, for the worker that stands at that stop. */
export type DesktopCodeOutcome = Omit<HubCodeMessage, 'type'>;

export type DesktopFrame = Omit<HubFrameMessage, 'type'> | Omit<HubFrameRefusal, 'type'>;

interface HubState {
  /** The stream is open and the server named it (`hello`). */
  connected: boolean;
  /** Each live run, by ref. */
  sessions: Record<string, HubSession>;
  /** The folder of each run heard since the window opened, for the place of its codes once it ended. */
  roots: Record<string, string | null>;
  /** What the latest code made at a worker's stop came to, by worker (`desktopWorkerKey`). */
  outcomes: Record<string, DesktopCodeOutcome>;
  kept: DesktopKept[];
  /** Goes up each time the stream opens again: every view of the stream before ended with it. */
  epoch: number;
}

/** How long the window waits before it opens a stream the server refused (no hub, too many windows) again. */
const REOPEN_MS = 5000;

const state = reactive<HubState>({ connected: false, sessions: {}, roots: {}, outcomes: {}, kept: [], epoch: 0 });

let source: EventSource | null = null;
let viewer: string | null = null;
let wanted = false;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
let serial = 0;
/** The runs the window shows live, and those the server was told of on this stream. */
let shown = new Set<string>();
let told = new Set<string>();
const frameListeners = new Map<string, Set<(frame: DesktopFrame) => void>>();
/** The latest frame of each view a listener asked for, in memory alone, until the view ends. */
const latestFrames = new Map<string, DesktopFrame>();
const stopListeners = new Set<(session: HubSession, worker: HubWorker) => void>();
/**
 * The stop each worker of each live run was last heard at (its `since`, by ref and worker), kept while a stream opens
 * again: the runs it hears again after `hello` bring no stop heard before.
 */
const heardAt = new Map<string, Map<number, string>>();
let toastApi: ReturnType<typeof useToast> | null = null;

function heard(text: string): void {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (value?.type) {
    case 'hello':
      if (!isDesktopRunViewer(value.viewer)) return;
      // A stream of its own: the runs, the codes and the picks come again on it.
      viewer = value.viewer;
      state.connected = true;
      state.sessions = {};
      state.kept = [];
      state.epoch++;
      latestFrames.clear();
      told = new Set();
      void tellShown();
      return;
    case 'stop-code':
      if (typeof value.code === 'object' && value.code) keep({ type: 'stop-code', code: value.code as StopCode });
      return;
    case 'pick': {
      const pick = value.pick as DesktopRunPick | undefined;
      if (typeof pick?.locator === 'string') keep({ type: 'pick', pick });
      return;
    }
    case 'notice':
      // A sentence about a run (a stop that went on, a code not made): the tray shows it as a toast.
      if (typeof value.message === 'string') {
        toastApi?.add({
          title: 'Desktop runs',
          description: value.message,
          color: value.severity === 'warning' ? 'warning' : 'neutral',
          icon: 'i-lucide-info',
        });
      }
      return;
    default:
      break;
  }
  const message = parseHubMessage(text);
  if (!message) return;
  if (message.type === 'session') heardSession(message.session);
  else if (message.type === 'code') {
    const { type: _type, ...outcome } = message;
    state.outcomes[desktopWorkerKey(outcome.ref, outcome.worker)] = outcome;
  } else if (message.type === 'frame') {
    const { type: _type, ...frame } = message;
    const key = desktopViewKey(frame.ref, frame.worker, frame.since);
    const listeners = frameListeners.get(key);
    if (!listeners?.size) return;
    latestFrames.set(key, frame);
    for (const listener of listeners) listener(frame);
  }
}

function heardSession(session: HubSession): void {
  state.roots[session.ref] = session.root;
  if (session.ended) {
    delete state.sessions[session.ref];
    heardAt.delete(session.ref);
    return;
  }
  state.sessions[session.ref] = session;
  const heard = heardAt.get(session.ref) ?? new Map<number, string>();
  heardAt.set(session.ref, heard);
  for (const worker of session.workers) {
    const since = worker.state === 'stopped' ? worker.stop?.since : undefined;
    if (!since || heard.get(worker.worker) === since) continue;
    heard.set(worker.worker, since);
    for (const listener of stopListeners) listener(session, worker);
  }
}

function keep(item: Extract<DesktopRunEvent, { type: 'stop-code' | 'pick' }>): void {
  state.kept = [...state.kept, { ...item, serial: ++serial }].slice(-MAX_KEPT_STOP_CODES);
}

function open(): void {
  // No EventSource on the server render: the stream is the window's.
  if (source || typeof EventSource === 'undefined') return;
  const opened = new EventSource('/api/desktop/runs/events');
  source = opened;
  opened.onmessage = (event) => heard(String(event.data));
  opened.onerror = () => {
    if (source !== opened) return;
    // Every view and every run shown ended with that stream: the next one names itself again.
    state.connected = false;
    viewer = null;
    // A stream the server refused does not come back by itself: asked again a while later, while it is wanted.
    if (opened.readyState === EventSource.CLOSED) {
      source = null;
      if (wanted && !reopenTimer) {
        reopenTimer = setTimeout(() => {
          reopenTimer = null;
          if (wanted) open();
        }, REOPEN_MS);
      }
    }
  };
}

function close(): void {
  if (reopenTimer) clearTimeout(reopenTimer);
  reopenTimer = null;
  source?.close();
  source = null;
  viewer = null;
  told = new Set();
  latestFrames.clear();
  heardAt.clear();
  Object.assign(state, { connected: false, sessions: {}, outcomes: {}, epoch: state.epoch + 1 });
}

/** Tells the server which runs the window shows live, what changed since it was told last. */
async function tellShown(): Promise<void> {
  const changes = [
    ...[...shown].filter((ref) => !told.has(ref)).map((ref) => ({ ref, on: true })),
    ...[...told].filter((ref) => !shown.has(ref)).map((ref) => ({ ref, on: false })),
  ];
  for (const { ref, on } of changes) {
    if (on) told.add(ref);
    else told.delete(ref);
    await command({ type: 'show', ref, on });
  }
}

/** A command of the window's, answered as the hub answers it; one that never reached the hub says why. */
async function command(body: Record<string, unknown>): Promise<DesktopRunAnswer> {
  if (!viewer) return { ok: false, message: 'The window is not connected to the runs: it connects again in a moment.' };
  try {
    return await $fetch<HubAnswer>('/api/desktop/runs/commands', {
      method: 'POST',
      body: { ...body, id: nextId++, viewer },
    });
  } catch (error) {
    return { ok: false, message: errorMessage(error, 'The desktop app did not answer.') };
  }
}

export function useDesktopRunHub() {
  toastApi ??= useToast();
  return {
    /** What the window heard: read it, never write it. */
    state: state as Readonly<HubState>,
    command,
    /** Whether the window wants the stream: open while it does, closed, and every stop let go, once it does not. */
    want(on: boolean): void {
      wanted = on;
      if (on) open();
      else close();
    },
    /** The runs the window shows live now: a failure no pause bar shows is held in them. */
    show(refs: Iterable<string>): void {
      shown = new Set(refs);
      void tellShown();
    },
    /** Hears each stop as a worker comes to it; returns the unsubscribe. */
    onStop(listener: (session: HubSession, worker: HubWorker) => void): () => void {
      stopListeners.add(listener);
      return () => stopListeners.delete(listener);
    },
    /**
     * Hears the frames of a stop's live view, the latest one at once when one came; returns the unsubscribe, which
     * drops the latest frame with the last listener.
     */
    onFrame(ref: string, worker: number, since: string, listener: (frame: DesktopFrame) => void): () => void {
      const key = desktopViewKey(ref, worker, since);
      const listeners = frameListeners.get(key) ?? new Set();
      frameListeners.set(key, listeners);
      listeners.add(listener);
      const latest = latestFrames.get(key);
      if (latest) listener(latest);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        frameListeners.delete(key);
        latestFrames.delete(key);
      };
    },
  };
}

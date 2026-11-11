/**
 * Desktop shell only: the window's side of the hub the bundled server is for the Playwright runs the shell starts
 * (`server/utils/desktop-runs.ts`). One stream for the whole window (`GET /api/desktop/runs/events`), opened only
 * while the window wants it (`want`, from `plugins/desktop-run-hub.client.ts`): while a run of the Local runs tray
 * runs, or the hub still has a live run. While it is open the window is a surface that answers stops, so a headless
 * stop waits for it: the tray shows every stop it hears (`onStop`), once, a stream that opens again included, and the
 * stop waits there; closed, nobody here answers and such a stop goes on at once, unless Piwi Picker follows the runs.
 *
 * What it keeps: each live run as the hub last told it, what each code made at a stop came to, the codes and the
 * locators picked, to copy, the workers whose **Watch live** is on, and the lanes the window watches (**Watch**: the
 * page of a worker's running test, and of its stops), which the tray and the run page both turn on. The frames of a
 * stop's live view go to whoever listens for that view (`onFrame`), and those of a lane to whoever listens for that
 * lane (`onLaneFrame`): none is reactive state, and only the latest one of each view and of each lane watched is kept,
 * in memory, until the view ends or the lane is no longer watched. Commands go to `POST /api/desktop/runs/commands`,
 * naming the stream (`viewer`); `show` says which runs hold their failures (the tray's **Hold failures**), so a failure
 * no pause bar shows is held in them, and is said again as the stream opens again; `watch` says which lanes the window
 * shows now: those watched that a listener shows while the window is not hidden, said again as the stream opens again.
 * Each time the window shows a lane again, its view goes up (`laneView`): a frame of an earlier view, the one kept
 * included, is the page as it last showed. A run the stream does not list as it opens (`listed`) ended meanwhile: what
 * the window kept of it goes. **Share live** asks what it sends the first time in this session of the app
 * (`shareAsks`).
 */
import {
  parseHubMessage,
  type HubAnswer,
  type HubCodeMessage,
  type HubFrameMessage,
  type HubFrameRefusal,
  type HubLaneFrameMessage,
  type HubLaneFrameRefusal,
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
import { errorMessage } from '@piwitests/run-ui/text';
import { desktopLaneKey, desktopLaneRun, desktopViewKey, desktopWorkerKey } from '~/utils/desktop-run-view';

/** A code made at a stop, or a locator picked, in the order they came, each with the number it came as. */
export type DesktopKept =
  | { serial: number; type: 'stop-code'; code: StopCode }
  | { serial: number; type: 'pick'; pick: DesktopRunPick };

/** What the hub answered a command, as the window reads it: the hub's answer, or why it never reached the hub. */
export type DesktopRunAnswer = Pick<HubAnswer, 'ok' | 'message' | 'image' | 'requests' | 'locator'>;

/** What a code made at a stop came to, for the worker that stands at that stop. */
export type DesktopCodeOutcome = Omit<HubCodeMessage, 'type'>;

export type DesktopFrame = Omit<HubFrameMessage, 'type'> | Omit<HubFrameRefusal, 'type'>;

export type DesktopLaneFrame = Omit<HubLaneFrameMessage, 'type'> | Omit<HubLaneFrameRefusal, 'type'>;

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
  /**
   * The workers whose Watch live is on, by run (ref): each next stop of theirs is watched, until it is turned off or
   * their run ends. A stream that opens again keeps them.
   */
  watchLive: Record<string, number[]>;
  /**
   * The lanes whose Interact is on (Playwright's `parallelIndex`), by run (ref): the clicks, the wheel and the keys on
   * their views go to the page, at each next stop too, until it is turned off, their run ends, the window is no longer
   * present or the stream opens again.
   */
  interacting: Record<string, number[]>;
  /**
   * The lanes the window watches (Playwright's `parallelIndex`), by run (ref): the page of each one's running test and
   * of its stops shows, until it is turned off or their run ends. A stream that opens again keeps them.
   */
  lanes: Record<string, number[]>;
  /** Why the hub would not show a lane the window asked to watch, by `desktopLaneKey`, until it is asked again. */
  laneRefusals: Record<string, string>;
  /** How many times the window told the hub to show each lane, by `desktopLaneKey`: the view its frames belong to. */
  laneViews: Record<string, number>;
}

/** How long the window waits before it opens a stream the server refused (no hub, too many windows) again. */
const REOPEN_MS = 5000;

const state = reactive<HubState>({
  connected: false,
  sessions: {},
  roots: {},
  outcomes: {},
  kept: [],
  epoch: 0,
  watchLive: {},
  interacting: {},
  lanes: {},
  laneRefusals: {},
  laneViews: {},
});

let source: EventSource | null = null;
let viewer: string | null = null;
let wanted = false;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
let serial = 0;
/** The runs the window shows live, and those the server was told of on this stream. */
let shown = new Set<string>();
let told = new Set<string>();
/** The window shows the runs to a person now (its tray, while the window is not hidden): each run names it present. */
let present = false;
const frameListeners = new Map<string, Set<(frame: DesktopFrame) => void>>();
/** The latest frame of each view a listener asked for, in memory alone, until the view ends. */
const latestFrames = new Map<string, DesktopFrame>();
/** Hears a frame of a lane, and the view of the lane it came in (`laneView`). */
export type DesktopLaneListener = (frame: DesktopLaneFrame, view: number) => void;

const laneListeners = new Map<string, Set<DesktopLaneListener>>();
/**
 * The latest frame of each lane the window watches, with the view it came in, in memory alone, until the lane is no
 * longer watched.
 */
const latestLaneFrames = new Map<string, { frame: Extract<DesktopLaneFrame, { data: string }>; view: number }>();
/** The lanes the server was told the window watches, on this stream, by `desktopLaneKey`. */
let lanesTold = new Map<string, { ref: string; lane: number }>();
/** A change of the lanes the window shows waits for the end of the tick: a listener that comes back changes none. */
let lanesQueued: Promise<Map<string, DesktopRunAnswer>> | null = null;
/** The window hears whether it is hidden: it shows no lane meanwhile. */
let hearsVisibility = false;
const stopListeners = new Set<(session: HubSession, worker: HubWorker) => void>();
/**
 * The stop each worker of each live run was last heard at (its `since`, by ref and worker), kept while a stream opens
 * again: the runs it hears again after `hello` bring no stop heard before.
 */
const heardAt = new Map<string, Map<number, string>>();
let toastApi: ReturnType<typeof useToast> | null = null;
/** The window said what Share live sends since the app started: it asks no more. */
let shareWarned = false;
/** Who hears that another tool asked to stop a run (`stop-run`): the window's hub plugin. */
const stopRunListeners = new Set<(ref: string) => void>();

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
      // A new viewer drives no stop: the one before gave its stops back, and Interact goes off with them.
      state.interacting = {};
      state.kept = [];
      state.epoch++;
      latestFrames.clear();
      told = new Set();
      lanesTold = new Map();
      void tellShown();
      void tellLanesSoon();
      if (present) void command({ type: 'follow', on: true });
      return;
    case 'stop-code':
      if (typeof value.code === 'object' && value.code) keep({ type: 'stop-code', code: value.code as StopCode });
      return;
    case 'stop-run':
      if (typeof value.ref === 'string') for (const listener of stopRunListeners) listener(value.ref);
      return;
    case 'pick': {
      const pick = value.pick as DesktopRunPick | undefined;
      if (typeof pick?.locator === 'string') keep({ type: 'pick', pick });
      return;
    }
    case 'listed': {
      // Every run live as the stream opened came before: a run the window kept that did not come ended meanwhile.
      const kept = [
        ...Object.keys(state.lanes),
        ...Object.keys(state.watchLive),
        ...Object.keys(state.interacting),
        ...heardAt.keys(),
        ...Object.keys(state.laneRefusals).map(desktopLaneRun),
      ];
      for (const ref of new Set(kept)) if (!state.sessions[ref]) forgetRun(ref);
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
  } else if (message.type === 'lane-frame') {
    const { type: _type, ...frame } = message;
    if (!watchesLane(frame.ref, frame.lane)) return;
    const key = desktopLaneKey(frame.ref, frame.lane);
    const view = state.laneViews[key] ?? 0;
    if ('data' in frame) latestLaneFrames.set(key, { frame, view });
    for (const listener of laneListeners.get(key) ?? []) listener(frame, view);
  }
}

function heardSession(session: HubSession): void {
  state.roots[session.ref] = session.root;
  if (session.ended) {
    delete state.sessions[session.ref];
    forgetRun(session.ref);
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

/** A run ended: what the window kept to watch it goes, its lanes' frames and refusals with them. */
function forgetRun(ref: string): void {
  heardAt.delete(ref);
  delete state.watchLive[ref];
  delete state.interacting[ref];
  for (const lane of state.lanes[ref] ?? []) forgetLane(ref, lane);
  delete state.lanes[ref];
  for (const key of Object.keys(state.laneRefusals)) if (desktopLaneRun(key) === ref) delete state.laneRefusals[key];
  for (const key of Object.keys(state.laneViews)) if (desktopLaneRun(key) === ref) delete state.laneViews[key];
  for (const key of [...lanesTold.keys()]) if (desktopLaneRun(key) === ref) lanesTold.delete(key);
}

function keep(item: Extract<DesktopRunEvent, { type: 'stop-code' | 'pick' }>): void {
  state.kept = [...state.kept, { ...item, serial: ++serial }].slice(-MAX_KEPT_STOP_CODES);
}

function open(): void {
  // No EventSource on the server render: the stream is the window's.
  if (source || typeof EventSource === 'undefined') return;
  if (!hearsVisibility && typeof document !== 'undefined') {
    hearsVisibility = true;
    document.addEventListener('visibilitychange', () => void tellLanesSoon());
  }
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
  lanesTold = new Map();
  latestFrames.clear();
  latestLaneFrames.clear();
  heardAt.clear();
  Object.assign(state, {
    connected: false,
    sessions: {},
    outcomes: {},
    epoch: state.epoch + 1,
    watchLive: {},
    interacting: {},
    lanes: {},
    laneRefusals: {},
    laneViews: {},
  });
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

function watchesLane(ref: string, lane: number): boolean {
  return state.lanes[ref]?.includes(lane) ?? false;
}

/** The lane is no longer watched: its latest frame goes. */
function forgetLane(ref: string, lane: number): void {
  latestLaneFrames.delete(desktopLaneKey(ref, lane));
}

/** Watches a lane, or stops, for the window. */
function setLane(ref: string, lane: number, on: boolean): void {
  const others = (state.lanes[ref] ?? []).filter((l) => l !== lane);
  if (on) state.lanes[ref] = [...others, lane];
  else if (others.length) state.lanes[ref] = others;
  else delete state.lanes[ref];
  if (!on) forgetLane(ref, lane);
}

/** The lanes the window shows now: those it watches that a listener shows, none while the window is hidden. */
function shownLanes(): Map<string, { ref: string; lane: number }> {
  const shown = new Map<string, { ref: string; lane: number }>();
  if (typeof document !== 'undefined' && document.hidden) return shown;
  for (const [ref, lanes] of Object.entries(state.lanes)) {
    for (const lane of lanes) {
      const key = desktopLaneKey(ref, lane);
      if (laneListeners.get(key)?.size) shown.set(key, { ref, lane });
    }
  }
  return shown;
}

/**
 * Tells the server which lanes the window shows, what changed since it was told last, once this tick ends; answers
 * what the hub said of each lane it was told of. A lane the hub would not show is watched no more, and says why.
 */
function tellLanesSoon(): Promise<Map<string, DesktopRunAnswer>> {
  lanesQueued ??= Promise.resolve().then(() => {
    lanesQueued = null;
    return tellLanes();
  });
  return lanesQueued;
}

async function tellLanes(): Promise<Map<string, DesktopRunAnswer>> {
  const answers = new Map<string, DesktopRunAnswer>();
  const stream = viewer;
  if (!stream) return answers;
  const shown = shownLanes();
  const changes = [
    ...[...shown].filter(([key]) => !lanesTold.has(key)).map(([key, at]) => ({ key, ...at, on: true })),
    ...[...lanesTold].filter(([key]) => !shown.has(key)).map(([key, at]) => ({ key, ...at, on: false })),
  ];
  for (const { key, ref, lane, on } of changes) {
    if (on) {
      lanesTold.set(key, { ref, lane });
      state.laneViews[key] = (state.laneViews[key] ?? 0) + 1;
    } else lanesTold.delete(key);
  }
  await Promise.all(
    changes.map(async ({ key, ref, lane, on }) => {
      const { answer, reached } = await send({ type: 'watch', ref, lane, on });
      answers.set(key, answer);
      if (!on || answer.ok || viewer !== stream) return;
      lanesTold.delete(key);
      // A command that never reached the hub leaves the lane watched: it is said again as the stream opens again.
      if (!reached) return;
      setLane(ref, lane, false);
      state.laneRefusals[key] = answer.message;
    }),
  );
  return answers;
}

/** A command of the window's, as the hub answered it (`reached`), or why it never reached the hub. */
async function send(body: Record<string, unknown>): Promise<{ answer: DesktopRunAnswer; reached: boolean }> {
  if (!viewer) {
    const message = 'The window is not connected to the runs: it connects again in a moment.';
    return { answer: { ok: false, message }, reached: false };
  }
  try {
    const answer = await $fetch<HubAnswer>('/api/desktop/runs/commands', {
      method: 'POST',
      body: { ...body, id: nextId++, viewer },
    });
    return { answer, reached: true };
  } catch (error) {
    return { answer: { ok: false, message: errorMessage(error, 'The desktop app did not answer.') }, reached: false };
  }
}

/** A command of the window's, answered as the hub answers it; one that never reached the hub says why. */
async function command(body: Record<string, unknown>): Promise<DesktopRunAnswer> {
  return (await send(body)).answer;
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
    /**
     * Whether the window shows the runs to a person now (`on`: its tray, while the window is not hidden): the hub names
     * it present on each run, said again as the stream opens again, and it gives back the stops it drove once it is not.
     */
    present(on: boolean): void {
      if (on === present) return;
      present = on;
      // Not present, the window gives back the stops it drove: Interact goes off with them.
      if (!on) state.interacting = {};
      if (viewer) void command({ type: 'follow', on });
    },
    /** Hears each run another tool asks through the hub to stop (`stop-run`), until the returned function is called. */
    onStopRun(listener: (ref: string) => void): () => void {
      stopRunListeners.add(listener);
      return () => stopRunListeners.delete(listener);
    },
    /** The runs the window shows live now: a failure no pause bar shows is held in them. */
    show(refs: Iterable<string>): void {
      shown = new Set(refs);
      void tellShown();
    },
    /**
     * Whether Share live still asks what it sends: the first time in this session of the app, until `shareWarned`.
     */
    shareAsks(): boolean {
      return !shareWarned;
    },
    shareWarned(): void {
      shareWarned = true;
    },
    /** Whether Watch live is on for a worker: each next stop of it is watched. */
    watchesLive(ref: string, worker: number): boolean {
      return state.watchLive[ref]?.includes(worker) ?? false;
    },
    /** Turns Watch live on or off for a worker, for the window, until its run ends. */
    setWatchLive(ref: string, worker: number, on: boolean): void {
      const others = (state.watchLive[ref] ?? []).filter((w) => w !== worker);
      if (on) state.watchLive[ref] = [...others, worker];
      else if (others.length) state.watchLive[ref] = others;
      else delete state.watchLive[ref];
    },
    /** Whether Interact is on for a lane of a run: the input on its views goes to the page. */
    interacts(ref: string, lane: number): boolean {
      return state.interacting[ref]?.includes(lane) ?? false;
    },
    /** Turns Interact on or off for a lane of a run, for the window, until its run ends. */
    setInteract(ref: string, lane: number, on: boolean): void {
      const others = (state.interacting[ref] ?? []).filter((l) => l !== lane);
      if (on) state.interacting[ref] = [...others, lane];
      else if (others.length) state.interacting[ref] = others;
      else delete state.interacting[ref];
    },
    /** Whether the window watches a lane of a run (Playwright's `parallelIndex`): its page shows as its test runs. */
    watchesLane,
    /** The view of a lane the window shows now: a frame of an earlier one is the page as it last showed. */
    laneView(ref: string, lane: number): number {
      return state.laneViews[desktopLaneKey(ref, lane)] ?? 0;
    },
    /**
     * Watches a lane of a run, or stops, for the window, until its run ends: the hub hears it while a listener shows
     * the lane (`onLaneFrame`). Answers what the hub said, once it was told.
     */
    async setLaneWatch(ref: string, lane: number, on: boolean): Promise<DesktopRunAnswer> {
      const key = desktopLaneKey(ref, lane);
      delete state.laneRefusals[key];
      setLane(ref, lane, on);
      return (await tellLanesSoon()).get(key) ?? { ok: true, message: '' };
    },
    /**
     * Hears the frames of a lane the window watches, each with the view it came in, the latest one at once when one
     * came; returns the unsubscribe. While a listener hears it, the window shows the lane, and the hub sends its frames.
     */
    onLaneFrame(ref: string, lane: number, listener: DesktopLaneListener): () => void {
      const key = desktopLaneKey(ref, lane);
      const listeners = laneListeners.get(key) ?? new Set();
      laneListeners.set(key, listeners);
      listeners.add(listener);
      void tellLanesSoon();
      const latest = latestLaneFrames.get(key);
      if (latest) listener(latest.frame, latest.view);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) laneListeners.delete(key);
        void tellLanesSoon();
      };
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

/**
 * A shell window's side of the hub its host is for the Playwright runs the shell starts (`ShellRuns` of
 * `@piwitests/editor`: the dashboard's bundled server, Piwi Runner's host). One stream for the whole window
 * (`GET /api/desktop/runs/events`), opened only while the window wants it (`want`): the dashboard while a run of its
 * Local runs tray runs or the hub still has a live run, Piwi Runner while a requested run runs. While it is open the
 * window is a surface that answers stops, so a headless stop waits for it: the window shows every stop it hears
 * (`onStop`), once, a stream that opens again included, and the stop waits there; closed, nobody here answers and such
 * a stop goes on at once, unless Piwi Picker follows the runs.
 *
 * What it keeps: each live run as the hub last told it, how many tests of each run that ended were ended at a stop
 * (`endedAtStop`, as its own process counted them) and how far it came (`endedProgress`), what each code made at a
 * stop came to, the codes and the locators picked, to copy, the workers whose stop's **Watch** is on, and the lanes the
 * window watches (**Watch**: the page of a worker's running test, and of its stops). The frames of a stop's live view
 * go to whoever listens for that view (`onFrame`), and those of a lane to whoever listens for that lane
 * (`onLaneFrame`): none is reactive state, and only the latest one of each view and of each lane watched is kept,
 * in memory, until the view ends or the lane is no longer watched. Commands go to `POST /api/desktop/runs/commands`,
 * naming the stream (`viewer`); `show` says which runs hold their failures (**Hold failures**), so a failure
 * no pause bar shows is held in them, and is said again as the stream opens again; `watch` says which lanes the window
 * shows now: those watched that a listener shows while the window is not hidden, said again as the stream opens again.
 * Each time the window shows a lane again, its view goes up (`laneView`): a frame of an earlier view, the one kept
 * included, is the page as it last showed. Each `watch` of a lane asks its layers (`@piwitests/run-model/layers`): every
 * one but the page's text, which the person asks for (`askLaneText`, which takes it now and follows it after, and
 * again as the lane's next test begins); the layers that come are kept by lane for the test it runs (`laneLayers`, each
 * replaced as one comes), in memory alone, until the lane is no longer watched. A run the stream does not list as it
 * opens (`listed`) ended meanwhile: what the window kept of it goes. **Share live** asks what it sends the first time in
 * this session of the app (`shareAsks`). **Inspect** of a lane, for a host that has it (`RunViewInspect`: `setInspect`,
 * on until it is turned off, the lane is no longer watched, its run ends or the server refuses it, `inspectRefusalOf`)
 * has the server read the pages of its running test while a view of it shows (`showInspect`) and the window is not
 * hidden, told once the tick ends, so a view that comes back changes nothing, and told again as the stream opens
 * again: each `inspect` its stream says of the lane goes to the host (`heard`), which keeps what it heard, and reads
 * what the server read so far each time the server took it (`taken`); the pages stay on the server.
 *
 * A live run of several workers shows one at a time behind its worker tabs, kept here by run (`tabs`) and followed as
 * each of its sessions is heard (`tabsAfter`, `@piwitests/run-model/tabs`): the worker shown stays while it stands at a
 * stop or its lane is watched, a new stop takes the tab once, and the person's Resume or End the
 * test there (`advanceTab`) moves it to the next stopped test. The person's choice (`chooseTab`) holds until a stop is
 * answered there, or, while that worker runs and nobody watches it, until a new stop comes.
 */
import {
  asksLaneTextAgain,
  laneLayersAsked,
  noLaneLayers,
  takeLaneLayer,
  type LaneLayers,
} from '@piwitests/run-model/layers';
import { endedAtStopOf } from '@piwitests/run-model/outcome';
import {
  parseHubMessage,
  type HubAnswer,
  type HubCodeMessage,
  type HubFrameMessage,
  type HubFrameRefusal,
  type HubLaneFrameMessage,
  type HubLaneFrameRefusal,
  type HubProgress,
  type HubSession,
  type HubWorker,
} from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';
import {
  isDesktopRunViewer,
  MAX_KEPT_STOP_CODES,
  type DesktopRunEvent,
  type DesktopRunPick,
} from '@piwitests/editor/shell-run-events';
import { errorMessage } from '@piwitests/run-ui/text';
import { tabsAdvanced, tabsAfter, tabsChosen, type WorkerTabs } from '@piwitests/run-model/tabs';
import {
  desktopLaneKey,
  desktopLaneRun,
  desktopShareWarning,
  desktopViewKey,
  desktopWorkerKey,
} from '../utils/run-view';
import type { RunViewInspect } from '../utils/run-view-host';

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
  /** The id the server named the stream by, which the window's commands and Inspect's pages carry; null while closed. */
  viewer: string | null;
  /** The stream has sent every run live as it opened (`listed`): a run it does not hold now has ended. */
  listed: boolean;
  /** Each live run, by ref. */
  sessions: Record<string, HubSession>;
  /** The folder of each run heard since the window opened, for the place of its codes once it ended. */
  roots: Record<string, string | null>;
  /**
   * How many tests of each run that ended were ended at a stop (End the test), by ref, as its own process counted them:
   * the tray marks its outcome with them. Only runs that ended any.
   */
  endedAtStop: Record<string, number>;
  /**
   * How far each run that ended came, by ref, as its own process last counted it (`HubProgress`, its first failure
   * included): the tray counts a run of several steps and leads its end to its failure with it. The latest
   * `MAX_ENDED_PROGRESS` runs that sent one.
   */
  endedProgress: Record<string, HubProgress>;
  /** What the latest code made at a worker's stop came to, by worker (`desktopWorkerKey`). */
  outcomes: Record<string, DesktopCodeOutcome>;
  kept: DesktopKept[];
  /** Goes up each time the stream opens again: every view of the stream before ended with it. */
  epoch: number;
  /**
   * The workers whose stop's Watch is on, by run (ref): each next stop of theirs is watched, until it is turned off or
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
  /**
   * The layers of each lane the window watches, as they came (`takeLaneLayer`), by `desktopLaneKey`, once its worker's
   * reporter sent one: of the test the lane runs, each replaced whole as a layer comes.
   */
  laneLayers: Record<string, LaneLayers>;
  /** The lanes whose page's text the person asked for, by `desktopLaneKey`: the hub takes it and follows it. */
  laneTexts: Record<string, boolean>;
  /** The lanes whose page's text was asked and has not come yet, by `desktopLaneKey`. */
  laneTextAsking: Record<string, boolean>;
  /** The worker tabs of each live run of several workers, by run (ref). A stream that opens again keeps them. */
  tabs: Record<string, WorkerTabs>;
  /**
   * The lanes the window has Inspect open on, by `desktopLaneKey`. A stream that opens again keeps them, and opens them
   * again.
   */
  inspecting: Record<string, true>;
  /**
   * Why the server last refused to open Inspect of a lane, by `desktopLaneKey`: each refusal a new one (`serial`), shown
   * as a click's answer is, whether a click, a view that showed or a stream that opened again asked.
   */
  inspectRefusals: Record<string, { message: string; serial: number }>;
}

/** How many ended runs' progress the window keeps (`endedProgress`). */
const MAX_ENDED_PROGRESS = 50;

/** How long the window waits before it opens a stream the server refused (no hub, too many windows) again. */
const REOPEN_MS = 5000;

const state = reactive<HubState>({
  connected: false,
  viewer: null,
  listed: false,
  sessions: {},
  roots: {},
  endedAtStop: {},
  endedProgress: {},
  outcomes: {},
  kept: [],
  epoch: 0,
  watchLive: {},
  interacting: {},
  lanes: {},
  laneRefusals: {},
  laneViews: {},
  laneLayers: {},
  laneTexts: {},
  laneTextAsking: {},
  tabs: {},
  inspecting: {},
  inspectRefusals: {},
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
/** Ends the wait for each lane's page's text `TEXT_WAIT_MS` after its latest ask, by `desktopLaneKey`. */
const laneTextTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
/** The lanes the window has Inspect open on, by `desktopLaneKey`, each with the host that keeps what it heard. */
const inspectLanes = new Map<string, { ref: string; lane: number; host: RunViewInspect }>();
/** How many views show each lane's Inspect, by `desktopLaneKey`: the server reads a lane's pages while one does. */
const inspectViews = new Map<string, number>();
/** The lanes the server was told the window has Inspect open on, on this stream, by `desktopLaneKey`. */
let inspectsTold = new Map<string, { ref: string; lane: number }>();
/** A change of the Inspects the window shows waits for the end of the tick: a view that comes back changes none. */
let inspectsQueued: Promise<Map<string, DesktopRunAnswer>> | null = null;

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
      state.viewer = value.viewer;
      state.connected = true;
      state.listed = false;
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
      inspectsTold = new Map();
      void tellInspectsSoon();
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
      state.listed = true;
      // Every run live as the stream opened came before: a run the window kept that did not come ended meanwhile.
      const kept = [
        ...Object.keys(state.lanes),
        ...Object.keys(state.watchLive),
        ...Object.keys(state.interacting),
        ...heardAt.keys(),
        ...Object.keys(state.laneRefusals).map(desktopLaneRun),
        ...Object.keys(state.tabs),
      ];
      for (const ref of new Set(kept)) if (!state.sessions[ref]) forgetRun(ref);
      return;
    }
    case 'ask-to-watch':
      // A teammate asks to watch a run: Share live shares it, Not now tells them.
      if (typeof value.ref === 'string' && typeof value.id === 'string' && typeof value.by === 'string') {
        const ref = value.ref;
        const ask = value.id;
        // The first share of the app's session says what it sends, as the run's Share live does.
        const warns = !shareWarned;
        toastApi?.add({
          title: `${value.by} asks to watch ${typeof value.run === 'number' ? `run #${value.run}` : 'this run'} live`,
          description: warns ? desktopShareWarning({ page: state.sessions[ref]?.live?.page ?? null }) : undefined,
          icon: 'i-lucide-radio',
          color: 'neutral',
          duration: 0,
          actions: [
            {
              label: 'Share live',
              color: 'primary' as const,
              onClick: () => {
                shareWarned = true;
                void command({ type: 'share', ref, on: true }).then((answer) => {
                  if (answer.ok) return;
                  toastApi?.add({
                    title: 'Share live',
                    description: answer.message,
                    color: 'warning',
                    icon: 'i-lucide-info',
                  });
                });
              },
            },
            {
              label: 'Not now',
              color: 'neutral' as const,
              variant: 'outline' as const,
              onClick: () =>
                void command({ type: 'answer-ask', ref, ask }).then((answer) => {
                  if (answer.ok) return;
                  toastApi?.add({
                    title: 'Not now',
                    description: answer.message,
                    color: 'warning',
                    icon: 'i-lucide-info',
                  });
                }),
            },
          ],
        });
      }
      return;
    case 'inspect':
      heardInspect(value);
      return;
    case 'notice':
      // A sentence about a run (a stop that went on, a code not made): the tray shows it as a toast.
      if (typeof value.message === 'string') {
        toastApi?.add({
          title: 'Runs',
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
  } else if (message.type === 'lane-layer') {
    const { type: _type, ref, lane, ...layer } = message;
    if (!watchesLane(ref, lane)) return;
    const key = desktopLaneKey(ref, lane);
    const kept = state.laneLayers[key] ?? noLaneLayers();
    const again = !!state.laneTexts[key] && asksLaneTextAgain(kept, layer);
    // Kept whole and replaced as a layer comes: nothing in it is watched field by field.
    state.laneLayers[key] = markRaw(takeLaneLayer(kept, layer));
    if (layer.layer === 'text') endTextWait(key);
    if (again) void askText(ref, lane, true);
  }
}

/** What the server read of a lane the window has Inspect open on: its host hears it. */
function heardInspect(value: Record<string, unknown>): void {
  if (typeof value.ref !== 'string' || !Number.isInteger(value.lane)) return;
  const key = desktopLaneKey(value.ref, value.lane as number);
  inspectLanes.get(key)?.host.heard(key, value);
}

/**
 * Tells the server which lanes' Inspect the window shows, what changed since it was told last, once this tick ends;
 * answers what it said of each lane it was told of.
 */
function tellInspectsSoon(): Promise<Map<string, DesktopRunAnswer>> {
  inspectsQueued ??= Promise.resolve().then(() => {
    inspectsQueued = null;
    return tellInspects();
  });
  return inspectsQueued;
}

async function tellInspects(): Promise<Map<string, DesktopRunAnswer>> {
  const answers = new Map<string, DesktopRunAnswer>();
  if (!viewer) return answers;
  const hidden = typeof document !== 'undefined' && document.hidden;
  const shown = hidden ? [] : [...inspectLanes].filter(([key]) => (inspectViews.get(key) ?? 0) > 0);
  const changes = [
    ...shown
      .filter(([key]) => !inspectsTold.has(key))
      .map(([key, at]) => ({ key, ref: at.ref, lane: at.lane, on: true })),
    ...[...inspectsTold]
      .filter(([key]) => !shown.some(([one]) => one === key))
      .map(([key, at]) => ({ key, ...at, on: false })),
  ];
  for (const { key, ref, lane, on } of changes) {
    if (on) inspectsTold.set(key, { ref, lane });
    else inspectsTold.delete(key);
  }
  await Promise.all(
    changes.map(async ({ key, ref, lane, on }) => {
      answers.set(key, on ? await openInspect(key, ref, lane) : await command({ type: 'inspect', ref, lane, on }));
    }),
  );
  return answers;
}

/**
 * Has the server read the lane's pages for the window's Inspect, then has its host take what it read so far, the view
 * keeping what it holds of the same test; a refusal closes it, saying why (`inspectRefusals`). Answers what the server
 * said.
 */
async function openInspect(key: string, ref: string, lane: number): Promise<DesktopRunAnswer> {
  const stream = viewer;
  const answer = await command({ type: 'inspect', ref, lane, on: true });
  const open = inspectLanes.get(key);
  if (!open || viewer !== stream || !stream) return answer;
  if (!answer.ok) {
    forgetInspect(key);
    inspectsTold.delete(key);
    state.inspectRefusals[key] = { message: answer.message, serial: ++serial };
    return answer;
  }
  await open.host.taken(key, { viewer: stream, ref, lane, current: () => viewer === stream });
  return answer;
}

/** The window has Inspect of a lane open no more: what its host heard of it goes. */
function forgetInspect(key: string): boolean {
  const open = inspectLanes.get(key);
  if (!open) return false;
  inspectLanes.delete(key);
  delete state.inspecting[key];
  open.host.closed(key);
  return true;
}

/** The window has Inspect of a lane open no more: the server is told once the tick ends. */
function closeInspect(key: string): Promise<Map<string, DesktopRunAnswer>> | null {
  if (!forgetInspect(key)) return null;
  return tellInspectsSoon();
}

function heardSession(session: HubSession): void {
  state.roots[session.ref] = session.root;
  if (session.ended) {
    const endedAtStop = endedAtStopOf(session.progress);
    if (endedAtStop > 0) state.endedAtStop[session.ref] = endedAtStop;
    if (session.progress) keepEndedProgress(session.ref, session.progress);
    delete state.sessions[session.ref];
    forgetRun(session.ref);
    return;
  }
  state.sessions[session.ref] = session;
  followTabs(session);
  const heard = heardAt.get(session.ref) ?? new Map<number, string>();
  heardAt.set(session.ref, heard);
  for (const worker of session.workers) {
    const since = worker.state === 'stopped' ? worker.stop?.since : undefined;
    if (!since || heard.get(worker.worker) === since) continue;
    heard.set(worker.worker, since);
    for (const listener of stopListeners) listener(session, worker);
  }
}

/**
 * The tabs of a run as its workers stand now: none for a run of fewer than two workers. A worker is watched while the
 * window watches its lane, or while it pauses with its stop's Watch on (Pause and watch, where the lane cannot be watched);
 * a stopped one keeps its tab anyway, and a stop's Watch shows nothing of one that runs on.
 */
function followTabs(session: HubSession): void {
  const { ref } = session;
  const watched = (worker: HubWorker) =>
    watchesLane(ref, worker.parallelIndex) ||
    (worker.pausing && (state.watchLive[ref]?.includes(worker.worker) ?? false));
  const tabs = tabsAfter(state.tabs[ref], session.workers, watched);
  if (tabs) state.tabs[ref] = tabs;
  else delete state.tabs[ref];
}

/** Keeps how far a run that ended came, the latest `MAX_ENDED_PROGRESS` alone. */
function keepEndedProgress(ref: string, progress: HubProgress): void {
  delete state.endedProgress[ref];
  state.endedProgress[ref] = progress;
  const refs = Object.keys(state.endedProgress);
  for (const old of refs.slice(0, Math.max(0, refs.length - MAX_ENDED_PROGRESS))) delete state.endedProgress[old];
}

/** A run ended: what the window kept to watch it goes, its lanes' frames and refusals with them. */
function forgetRun(ref: string): void {
  heardAt.delete(ref);
  delete state.tabs[ref];
  delete state.watchLive[ref];
  delete state.interacting[ref];
  for (const lane of state.lanes[ref] ?? []) forgetLane(ref, lane);
  delete state.lanes[ref];
  for (const key of Object.keys(state.laneRefusals)) if (desktopLaneRun(key) === ref) delete state.laneRefusals[key];
  for (const key of Object.keys(state.laneViews)) if (desktopLaneRun(key) === ref) delete state.laneViews[key];
  for (const key of [...lanesTold.keys()]) if (desktopLaneRun(key) === ref) lanesTold.delete(key);
  for (const [key, at] of inspectLanes) if (at.ref === ref) forgetInspect(key);
  for (const key of Object.keys(state.inspectRefusals)) {
    if (desktopLaneRun(key) === ref) delete state.inspectRefusals[key];
  }
  for (const key of inspectsTold.keys()) if (desktopLaneRun(key) === ref) inspectsTold.delete(key);
}

function keep(item: Extract<DesktopRunEvent, { type: 'stop-code' | 'pick' }>): void {
  state.kept = [...state.kept, { ...item, serial: ++serial }].slice(-MAX_KEPT_STOP_CODES);
}

function open(): void {
  // No EventSource on the server render: the stream is the window's.
  if (source || typeof EventSource === 'undefined') return;
  if (!hearsVisibility && typeof document !== 'undefined') {
    hearsVisibility = true;
    document.addEventListener('visibilitychange', () => {
      void tellLanesSoon();
      void tellInspectsSoon();
    });
  }
  const opened = new EventSource('/api/desktop/runs/events');
  source = opened;
  opened.onmessage = (event) => heard(String(event.data));
  opened.onerror = () => {
    if (source !== opened) return;
    // Every view and every run shown ended with that stream: the next one names itself again.
    state.connected = false;
    state.listed = false;
    viewer = null;
    state.viewer = null;
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
  for (const key of inspectLanes.keys()) forgetInspect(key);
  inspectsTold = new Map();
  lanesTold = new Map();
  latestFrames.clear();
  latestLaneFrames.clear();
  heardAt.clear();
  for (const timer of laneTextTimers.values()) clearTimeout(timer);
  laneTextTimers.clear();
  Object.assign(state, {
    connected: false,
    viewer: null,
    listed: false,
    sessions: {},
    outcomes: {},
    epoch: state.epoch + 1,
    watchLive: {},
    interacting: {},
    lanes: {},
    laneRefusals: {},
    laneViews: {},
    laneLayers: {},
    laneTexts: {},
    laneTextAsking: {},
    tabs: {},
    inspecting: {},
    inspectRefusals: {},
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

/** The lane is no longer watched: its latest frame goes, and its layers. */
function forgetLane(ref: string, lane: number): void {
  const key = desktopLaneKey(ref, lane);
  latestLaneFrames.delete(key);
  delete state.laneLayers[key];
  delete state.laneTexts[key];
  endTextWait(key);
}

/** The layers a lane's watch asks of the hub: every one, the page's text once the person asked for it. */
function layersOf(key: string): ReturnType<typeof laneLayersAsked> {
  return laneLayersAsked(!!state.laneTexts[key]);
}

/** How long the window says it reads the page's text before it gives up waiting for it. */
const TEXT_WAIT_MS = 15_000;

/** The window waits no more for a lane's page's text. */
function endTextWait(key: string): void {
  const timer = laneTextTimers.get(key);
  if (timer) clearTimeout(timer);
  laneTextTimers.delete(key);
  delete state.laneTextAsking[key];
}

/**
 * Shows the page's text of a lane the window watches, takes it again (`on`), or hides it: the hub hears the lane's
 * layers again, the page's text among them taken now and followed after; a lane the hub was not told of yet asks for
 * it as it is told. The window says it reads the text `TEXT_WAIT_MS` after the latest ask at most. Answers what the hub
 * said.
 */
async function askText(ref: string, lane: number, on: boolean): Promise<DesktopRunAnswer> {
  const key = desktopLaneKey(ref, lane);
  state.laneTexts[key] = on;
  endTextWait(key);
  const timer = on ? setTimeout(() => endTextWait(key), TEXT_WAIT_MS) : null;
  if (timer) {
    laneTextTimers.set(key, timer);
    state.laneTextAsking[key] = true;
  }
  const kept = state.laneLayers[key];
  if (!on && kept) state.laneLayers[key] = markRaw({ ...kept, text: null, textRefused: null });
  if (!lanesTold.has(key)) return { ok: true, message: '' };
  const answer = await command({ type: 'watch', ref, lane, on: true, layers: layersOf(key) });
  if (!answer.ok && timer && laneTextTimers.get(key) === timer) endTextWait(key);
  return answer;
}

/** Watches a lane, or stops, for the window: Inspect of a lane no longer watched closes. */
function setLane(ref: string, lane: number, on: boolean): void {
  const others = (state.lanes[ref] ?? []).filter((l) => l !== lane);
  if (on) state.lanes[ref] = [...others, lane];
  else if (others.length) state.lanes[ref] = others;
  else delete state.lanes[ref];
  if (!on) {
    forgetLane(ref, lane);
    void closeInspect(desktopLaneKey(ref, lane));
  }
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
      const { answer, reached } = await send({
        type: 'watch',
        ref,
        lane,
        on,
        ...(on ? { layers: layersOf(key) } : {}),
      });
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
    return { answer: { ok: false, message: errorMessage(error, 'The app did not answer.') }, reached: false };
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
    /**
     * Takes back how far the runs that ended before a reload of the page came (`endedProgress`, `endedAtStop`), by ref,
     * as the page before kept them: a run the window heard of since keeps what it heard.
     */
    takeBackEnded(ended: Readonly<Record<string, { progress?: HubProgress; endedAtStop?: number }>>): void {
      for (const [ref, kept] of Object.entries(ended)) {
        if (kept.progress && !state.endedProgress[ref]) keepEndedProgress(ref, kept.progress);
        if (kept.endedAtStop && kept.endedAtStop > 0 && !state.endedAtStop[ref])
          state.endedAtStop[ref] = kept.endedAtStop;
      }
    },
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
    /** Whether a stop's Watch is on for a worker: each next stop of it is watched. */
    watchesLive(ref: string, worker: number): boolean {
      return state.watchLive[ref]?.includes(worker) ?? false;
    },
    /** Turns a stop's Watch on or off for a worker, for the window, until its run ends. */
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
    /** The layers of a lane the window watches, as they came; null until its worker's reporter sent one. */
    laneLayers(ref: string, lane: number): LaneLayers | null {
      return state.laneLayers[desktopLaneKey(ref, lane)] ?? null;
    },
    /** Whether the person asked for the page's text of a lane, and whether it is on its way. */
    laneText(ref: string, lane: number): { asked: boolean; asking: boolean } {
      const key = desktopLaneKey(ref, lane);
      return { asked: !!state.laneTexts[key], asking: !!state.laneTextAsking[key] };
    },
    /** Shows the page's text of a lane the window watches, takes it again (`on`), or hides it (`askText`). */
    askLaneText: askText,
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
    /** Whether the window has Inspect of a lane of a run open. */
    inspecting(ref: string, lane: number): boolean {
      return !!state.inspecting[desktopLaneKey(ref, lane)];
    },
    /** Why the server last refused to open Inspect of a lane of a run, each refusal a new one; null for none. */
    inspectRefusalOf(ref: string, lane: number): { message: string; serial: number } | null {
      return state.inspectRefusals[desktopLaneKey(ref, lane)] ?? null;
    },
    /**
     * Opens Inspect of a lane of a run for the window, its host keeping what it hears (`host`), or closes it (null):
     * the server reads the pages of the lane's running test while a view of it shows (`showInspect`), and lets them go
     * as it closes. Answers what the server said, once it was told.
     */
    async setInspect(ref: string, lane: number, host: RunViewInspect | null): Promise<DesktopRunAnswer> {
      const key = desktopLaneKey(ref, lane);
      if (!host) return (await closeInspect(key))?.get(key) ?? { ok: true, message: '' };
      if (!inspectLanes.has(key)) {
        inspectLanes.set(key, { ref, lane, host });
        state.inspecting[key] = true;
        host.opened(key);
      }
      return (await tellInspectsSoon()).get(key) ?? { ok: true, message: '' };
    },
    /**
     * A view shows Inspect of a lane: while one does, the server reads its pages, once the tick ends; returns what
     * stops showing it.
     */
    showInspect(ref: string, lane: number): () => void {
      const key = desktopLaneKey(ref, lane);
      inspectViews.set(key, (inspectViews.get(key) ?? 0) + 1);
      void tellInspectsSoon();
      let shown = true;
      return () => {
        if (!shown) return;
        shown = false;
        const left = (inspectViews.get(key) ?? 1) - 1;
        if (left > 0) inspectViews.set(key, left);
        else inspectViews.delete(key);
        void tellInspectsSoon();
      };
    },
    /** The worker tabs of a live run of several workers; null for a run that shows none. */
    tabsOf(ref: string): WorkerTabs | null {
      return state.tabs[ref] ?? null;
    },
    /** The person shows a worker of a run behind its tabs, by its lane (`tabsChosen`). */
    chooseTab(ref: string, lane: number): void {
      const tabs = state.tabs[ref];
      if (tabs) state.tabs[ref] = tabsChosen(tabs, lane);
    },
    /**
     * The person resumes or ends the test of the worker in `lane` at the stop `since`: once it leaves that stop, the
     * next stopped test takes the tab, when that worker is the one shown (`tabsAdvanced`).
     */
    advanceTab(ref: string, lane: number, since: string | null): void {
      const tabs = state.tabs[ref];
      if (tabs) state.tabs[ref] = tabsAdvanced(tabs, lane, since);
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

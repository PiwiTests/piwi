import { LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import type {
  HubAction,
  HubImage,
  HubKeptRequest,
  HubLive,
  HubProgress,
  HubSession,
  HubStop,
  HubWorker,
} from '@piwitests/core/run-hub';
import { canStopRun } from '@piwitests/core/run-hub';
import { isLaneThumbData } from '@piwitests/core/live-layers';
import { isViewFrameData, type ViewButton, type ViewInput } from '@piwitests/core/run-view';
import {
  CONTROLS,
  FOLDED,
  FOLD_FROM,
  JOINED,
  STEERING,
  controlTitle,
  controlsOf,
  runLevelControls,
  type Control,
} from '@piwitests/run-model/controls';
import { CI_READ_ONLY, ciRunName, ciRunWhere } from '@piwitests/run-model/ci';
import {
  asksLaneTextAgain,
  callWait,
  laneEventSaid,
  laneLayersAsked,
  laneTextSource,
  noLaneLayers,
  takeLaneLayer,
  type LaneEventEntry,
  type LaneFilmEntry,
  type LaneLayers,
} from '@piwitests/run-model/layers';
import { endedAtStopOf, endedAtStopWords } from '@piwitests/run-model/outcome';
import { driverOf, givesBack, presenceLine, watchersLine } from '@piwitests/run-model/presence';
import { tabStatus, workerStatus, type WorkerStatus } from '@piwitests/run-model/status';
import {
  IN_WINDOW,
  canOpenTrace,
  heldUntilWatched,
  laneFrameNow,
  laneWatchOf,
  pagePoint,
  runName as runNameOf,
  stopError,
  stopIntents,
  stopPlace,
  stopSaid,
  testName,
} from '@piwitests/run-model/stop';
import { tabsAdvanced, tabsAfter, tabsChosen, type WorkerTabs } from '@piwitests/run-model/tabs';
import { ViewInputBatcher, keyOnView, pastedText, type ViewModifier } from '@piwitests/run-model/view-input';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { decorateIcons, icon, iconText, setLabel, type IconName } from '../shared/icons.js';
import { formatUnit, initI18n, localizeDocument, t, tn, tNodes } from '../shared/i18n.js';
import {
  RUNS_PING_MS,
  RUNS_PORT,
  RUN_COMMAND,
  attentionOf,
  ciDashboardWatch,
  ciLaneKey,
  pageHintOf,
  shareRefusalOf,
  readRunsBounds,
  RUNS_BOUNDS_KEY,
  keyTargetOf,
  stopKeyOf,
  STOP_KEYS,
  slotKey,
  workerKey,
  type CiWatchEnd,
  type RunsAnswer,
  type RunsCiFrame,
  type RunsCiLane,
  type RunsCiRun,
  type RunsCiTest,
  type RunsCode,
  type RunsEvent,
  type RunsFrame,
  type RunsHub,
  type RunsLane,
  type RunsLaneFrame,
  type RunsLaneLayer,
  type RunsRequest,
  type RunsRun,
  type RunsState,
  type RunsView,
  type RunsWhat,
} from '../shared/runs.js';
import { runsSpeaker } from '../shared/run-words.js';
import { STEP_CSS, richText, urlView } from '../shared/step-view.js';

/**
 * The Runs window: the runs the paired editor started, and the paired desktop app's beside them (`Desktop app`, their
 * code made there for the app's window to copy), each worker's test and where it stands, an image of a stopped page or
 * its live view, and the controls, with the code a stop can write (Pick, Record, Assert, Assert a region, Mock a
 * request) as the stop takes them from this window (`stopIntents`); while none of a run's tests stands stopped, the run
 * says that a test's page shows here at a stop, and how a test stops (`pageHintOf`). Opened from the popup's Runs tile
 * in a small window of its own. It reads everything from the background worker through its port (`RUNS_PORT`), and
 * makes no network call: the worker holds the hubs' connections and tokens. The code itself never comes here: it goes
 * to the editor, which writes it and says there whether it did, and the window shows what the hub answered and what
 * each code made at the stop came to (sent to the editor to write, or refused), whoever asked for it. What a hub sends
 * is shown as text, and its image and the frames of a live view as images, the latest frame alone kept, in memory. Each
 * part of the window is drawn again only when what it shows changes (`part`), so a button under the pointer or the
 * keyboard stays the same element while the run goes on around it.
 *
 * **Share live** shares a run on the team instance its reporter reports to, for anyone who can open it there: the first
 * share in this window says what goes out and to whom, and waits for a yes; shared, the run says where and how many
 * watch, with its page's link to copy and **Stop sharing**; a run that cannot be shared says why, under its workers, in
 * place of Share live.
 *
 * A stop's own Watch shows its frames in place of its image, while the window shows that stop: the view ends as the
 * stop does, the window hides or the stop's Watch is turned off, and comes again at the worker's next stop while
 * the stop's Watch stays on. Where the stop takes input from this window (`input`), Interact, while the view is on, sends the pointer
 * and the keys on it to the page, and the first of them drives the stop: the left and right buttons with the click
 * count the system gave them where the stop takes it (`input-clicks`), Control, Alt and Meta held around a click. Tab
 * moves the focus on unless a click into the view took the keyboard; Escape turns Interact off and gives the stop
 * back (but goes to the page while a pick or a check runs there, the stop's `acting`), and the browser's shortcuts
 * stay the window's. Pick on the image, or a Shift+click on the image or the view,
 * names the element under the pointer.
 *
 * Watch, at a hub that shows a lane while it runs and for a worker whose reporter does, watches the worker's lane
 * (`watch`) in place of a stop's own view: its test's page while it runs, through its stops, its next tests and the
 * worker Playwright starts in its place, until it is turned off or the run ends; a hidden window watches nothing, and
 * watches again as it shows. A frame taken before a Step, a Resume or the end of a test stays shown, dimmed and marked
 * as running, until the next one comes. At a stop the lane's frames show, they are its live view, taking Interact's
 * input as a stop's own Watch's do; a watched lane that stops is brought into view. Pause and watch pauses the worker and watches it. At a
 * stop no pause bar shows and that the window does not watch, the actions in the test's window show held, saying to
 * watch first. At a hub that sends a lane's layers, a watched lane shows them under its page once its worker's reporter
 * sent one (`@piwitests/run-model/layers`): why its call waits (the latest lines of Playwright's log of it, what its locator matches and how), its
 * page's events, newest first, the page's text once the person asks for it, then followed, and the test's filmstrip,
 * an image shown larger with its call's title as it is chosen. They are kept in memory while the lane is watched.
 */

await initI18n();
localizeDocument();
const style = document.createElement('style');
style.textContent = `${BUTTON_CSS}${STEP_CSS}${LOCATOR_SYNTAX_CSS}`;
document.head.appendChild(style);
decorateIcons();

const hubsLine = document.getElementById('hubs') as HTMLElement;
const announcer = document.getElementById('announce') as HTMLElement;
const empty = document.getElementById('empty') as HTMLElement;
const emptyText = document.getElementById('empty-text') as HTMLElement;
const emptyActions = document.getElementById('empty-actions') as HTMLElement;
const runsList = document.getElementById('runs') as HTMLElement;
const ciBox = document.getElementById('ci') as HTMLElement;
const shortcutBox = document.getElementById('shortcut') as HTMLElement;
const shortcutText = document.getElementById('shortcut-text') as HTMLElement;
const shortcutActions = document.getElementById('shortcut-actions') as HTMLElement;

let state: RunsState | null = null;
/** The image of each stopped worker's page, for the stop it was taken at, with the viewport it shows. */
const images = new Map<
  string,
  {
    since: string;
    loading: boolean;
    img: HTMLImageElement | null;
    note: string;
    viewport: { width: number; height: number } | null;
    /** Its hub's connection was lost before it answered: it is asked again once the hub answers. */
    lost?: string;
  }
>();
/**
 * What the last command for a worker answered, or what the last code made at its stop came to, when there is
 * something to say, for the stop it was sent at (null for Pause): shown while the worker stands there, and gone with
 * that stop. `sent` when the code went to the editor to write, with what to check in it (`warnings`).
 */
const answers = new Map<
  string,
  {
    ok: boolean;
    text: string;
    since: string | null;
    sent: boolean;
    warnings: string[];
    rich: boolean;
    /** A picked locator no editor took, offered to copy. */
    copy: string | null;
  }
>();
/** The requests a stopped worker's test kept, listed for Mock a request at the stop they were asked at. */
interface RequestList {
  since: string;
  requests: HubKeptRequest[];
  /** Names the list drawn, and its element's id. */
  serial: number;
}
const requestLists = new Map<string, RequestList>();
let listSerial = 0;
/** The workers a command is on its way for: their buttons wait for it. */
const busy = new Set<string>();
/** The lanes (`slotKey`) whose Open the trace so far waits for the hub's answer: that button alone waits for it. */
const tracing = new Set<string>();
/** Share live said what it sends in this window: it asks no more. */
let shareWarned = false;
/** The runs whose Share live waits for a yes, those a share or its end is on its way for, and what a refusal said. */
const shareAsking = new Set<string>();
const sharing = new Set<string>();
/** The runs whose Hold failures is being turned over: the toggle waits for the hub's answer. */
const holding = new Set<string>();
const shareRefusals = new Map<string, string>();
/** Why the hub did not turn a run's Hold failures over, by run, until it is asked again. */
const holdRefusals = new Map<string, string>();
/** Each worker's state, stop and its driver as last shown, and the runs live then, for what the live region says. */
let seen: Map<string, WorkerSeen> | null = null;
let liveSeen = new Set<string>();
/** The live runs shared, and the hubs whose editor window shares its runs, as the live region last heard of them. */
let sharedSeen = new Set<string>();
let windowsSeen: Set<string> | null = null;
/** The hubs whose window's share this window changed, its answer said: the next state says nothing of it. */
const windowsAsked = new Set<string>();

// ── The port to the worker ──────────────────────────────────────────────────────────────────────────────────────────

let port: chrome.runtime.Port | null = null;
let nextId = 1;
/** How long a command waits for the worker's answer: past the hub's own wait for one, which the worker says. */
const COMMAND_TIMEOUT_MS = 25_000;
const waiting = new Map<number, (answer: RunsAnswer) => void>();

function post(request: RunsRequest): void {
  try {
    port?.postMessage(request);
  } catch {
    // Disconnected meanwhile: the port connects again.
  }
}

function connect(): void {
  let opened: chrome.runtime.Port;
  try {
    opened = chrome.runtime.connect({ name: RUNS_PORT });
  } catch {
    // The extension was reloaded or removed: this window is left from it.
    return;
  }
  port = opened;
  opened.onMessage.addListener((event: RunsEvent) => {
    if (event?.type === 'state') {
      showState(event.state);
    } else if (event?.type === 'found') {
      stopLooking();
    } else if (event?.type === 'code') {
      heardCode(event);
    } else if (event?.type === 'frame') {
      heardFrame(event);
    } else if (event?.type === 'view-ended') {
      heardViewEnded(event);
    } else if (event?.type === 'lane-frame') {
      heardLaneFrame(event);
    } else if (event?.type === 'lane-ended') {
      heardLaneEnded(event);
    } else if (event?.type === 'lane-layer') {
      heardLaneLayer(event);
    } else if (event?.type === 'ci-frame') {
      heardCiFrame(event);
    } else if (event?.type === 'ci-ended') {
      heardCiEnded(event);
    } else if (event?.type === 'answer') {
      const { id, type: _type, ...answer } = event;
      waiting.get(id)?.(answer);
      waiting.delete(id);
    }
  });
  opened.onDisconnect.addListener(() => {
    if (port === opened) port = null;
    for (const resolve of waiting.values()) resolve({ ok: false, message: '', failure: 'offline' });
    waiting.clear();
    // The worker that relayed the views is gone: the next one watches each again that a stop's Watch left on, and each lane
    // Watch left on.
    for (const [key, view] of views) if (isLive(view)) endView(key, false);
    for (const lane of lanes.values()) if (isLive(lane)) idleLane(lane, false);
    idleCi(false);
    // The worker stopped (it is started again by the connection) or restarted.
    setTimeout(connect, 500);
  });
  void chrome.windows
    .getCurrent()
    .then((window) => {
      if (window.id !== undefined) post({ type: 'window', windowId: window.id });
    })
    .catch(() => undefined);
  post({ type: 'shown', shown: !document.hidden });
}

/** What a command names besides its stop: the response to mock, whether a view is on, a lane, the input, a point. */
type CommandExtra = Pick<
  Extract<RunsRequest, { type: 'command' }>,
  'request' | 'on' | 'scope' | 'lane' | 'layers' | 'events' | 'x' | 'y'
>;

/**
 * Sends the worker a request it answers with `answer` of the request's id: `offline` without a port to it, `late` once
 * `COMMAND_TIMEOUT_MS` passed.
 */
function answered(make: (id: number) => RunsRequest, offline: RunsAnswer, late: RunsAnswer): Promise<RunsAnswer> {
  const id = nextId++;
  return new Promise((resolve) => {
    if (!port) {
      resolve(offline);
      return;
    }
    // A request the worker drops, or never answers, frees its buttons: a later answer finds nobody waiting.
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve(late);
    }, COMMAND_TIMEOUT_MS);
    waiting.set(id, (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
    post(make(id));
  });
}

const OFFLINE: RunsAnswer = { ok: false, message: '', failure: 'offline' };
const TIMEOUT: RunsAnswer = { ok: false, message: '', failure: 'timeout' };

function command(
  hub: string,
  ref: string,
  worker: number | null,
  what: RunsWhat,
  since: string | null,
  extra: CommandExtra = {},
): Promise<RunsAnswer> {
  return answered((id) => ({ type: 'command', id, hub, ref, worker, since, what, ...extra }), OFFLINE, TIMEOUT);
}

/**
 * The tool whose hub follows a run, as the window's sentences name it: the desktop app for its hub's runs, else the
 * editor by its name (`Visual Studio Code`), or "your editor" when its hub names none.
 */
function toolName(hub: string): string {
  const found = state?.hubs.find((h) => h.id === hub);
  return found?.desktop ? t('runs_desktopName') : (found?.client ?? t('runs_editor'));
}

/** What an answer says, the worker's own failures naming the tool whose hub it did not reach (`toolName`). */
function failureText(answer: RunsAnswer, hub: string): string {
  if (answer.failure === 'offline') return t('runs_failOffline', { tool: toolName(hub) });
  if (answer.failure === 'timeout') return t('runs_failTimeout', { tool: toolName(hub) });
  if (answer.failure === 'unwatched') return t('runs_failUnwatched');
  return answer.message;
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The stop a worker stands at in the state shown last: its `since`, null while it is not stopped, or is gone. */
function stopNow(run: RunsRun, worker: number): string | null {
  const shown = state?.runs.find((r) => r.hub === run.hub && r.session.ref === run.session.ref && !r.session.ended);
  const found = shown?.session.workers.find((w) => w.worker === worker);
  return found?.state === 'stopped' ? (found.stop?.since ?? null) : null;
}

/**
 * Sends a command for the stop a worker's button was drawn for (`since`, null for Pause), unless one is on its way:
 * its answer, or null when the worker no longer stands at that stop by then, which leaves nothing to say.
 */
async function send(
  run: RunsRun,
  worker: number,
  what: RunsWhat,
  since: string | null,
  extra: CommandExtra = {},
): Promise<RunsAnswer | null> {
  const key = workerKey(run.hub, run.session.ref, { worker });
  // A command on its way: the buttons say so (`aria-disabled`) and take no other until it is answered. So do those of
  // a run whose hub's connection was lost, until it answers again.
  if (busy.has(key) || !hubAnswers(run.hub)) return null;
  // Every control but Pause answers the stop shown; End the test while a Pause waits for a call names none.
  if (what !== 'pause' && what !== 'give-up' && since === null) return null;
  busy.add(key);
  answers.delete(key);
  render();
  const answer = await command(run.hub, run.session.ref, worker, what, since, extra);
  busy.delete(key);
  if (stopNow(run, worker) === since) return answer;
  render();
  return null;
}

/**
 * Shows what a command answered under the test, or what a code came to, with what to check in it, and reads it out:
 * `sent` when it went to the editor, `rich` for a sentence whose locators are set apart (a pick on the image's).
 */
function say(
  key: string,
  answer: RunsAnswer,
  since: string | null,
  options: { sent?: boolean; warnings?: string[]; rich?: boolean; copy?: string | null } = {},
): void {
  const { sent = false, warnings = [], rich = false, copy = null } = options;
  const text = answer.ok ? answer.message : failureText(answer, key.split('|')[0]!);
  answers.set(key, {
    ok: answer.ok,
    text,
    since,
    sent: answer.ok && sent,
    warnings,
    rich,
    copy: answer.ok ? copy : null,
  });
  if (text) announce([text, ...warnings].join(' '));
}

/**
 * What a code made at a stop came to, whoever asked for it (this window, the editor): sent to the editor to write, or
 * refused, shown under the test and read out while its worker stands at that stop; dropped otherwise.
 */
function heardCode(code: RunsCode): void {
  const run = state?.runs.find((r) => r.hub === code.hub && r.session.ref === code.ref && !r.session.ended);
  if (!run || stopNow(run, code.worker) !== code.since) return;
  const key = workerKey(code.hub, code.ref, { worker: code.worker });
  say(key, { ok: code.ok, message: code.message }, code.since, { sent: true, warnings: code.warnings });
  render();
}

/** The key a run is kept under, by its hub and its ref. */
function runKeyOf(run: RunsRun): string {
  return `${run.hub}|${run.session.ref}`;
}

/**
 * Share a run live (`on`), or stop sharing it, or with `byWindow`, share each run of its editor window until the person
 * stops, unless a share of it is on its way: a refusal is shown and read out.
 */
async function share(run: RunsRun, on: boolean, byWindow = false): Promise<void> {
  const key = runKeyOf(run);
  if (sharing.has(key)) return;
  sharing.add(key);
  shareRefusals.delete(key);
  render();
  const answer = await command(run.hub, run.session.ref, null, 'share', null, {
    on,
    ...(byWindow ? { scope: 'window' as const } : {}),
  });
  sharing.delete(key);
  if (byWindow && answer.ok && state?.hubs.find((h) => h.id === run.hub)?.windowShared !== on) {
    windowsAsked.add(run.hub);
  }
  const text = answer.ok ? answer.message : failureText(answer, run.hub);
  if (!answer.ok) shareRefusals.set(key, text);
  if (text) announce(text);
  render();
}

/**
 * Share live, or Share this editor window's runs (`byWindow`): asked first, the first time in this window, offering
 * both where the hub shares its window's runs; then each share goes at once.
 */
function askShare(run: RunsRun, byWindow = false): void {
  const key = runKeyOf(run);
  if (shareWarned) return void share(run, true, byWindow);
  shareAsking.add(key);
  focusKey = `${key}|${byWindow ? 'share-window-yes' : 'share-yes'}`;
  render();
}

function answerShare(run: RunsRun, yes: boolean, byWindow = false): void {
  const key = runKeyOf(run);
  shareAsking.delete(key);
  focusKey = `${key}|share`;
  if (!yes) return render();
  shareWarned = true;
  void share(run, true, byWindow);
}

/** The runs whose Stop sharing waits for the person to confirm it. */
const stopAsking = new Set<string>();

/** Stop sharing a run, asked first, every time: the run alone, whether or not its editor window shares its runs. */
function askStopSharing(run: RunsRun, yes: boolean | null): void {
  const key = runKeyOf(run);
  if (yes === null) {
    stopAsking.add(key);
    focusKey = `${key}|stop-sharing-yes`;
    return render();
  }
  stopAsking.delete(key);
  focusKey = `${key}|stop-sharing`;
  if (!yes) return render();
  void share(run, false);
}

/** The hubs whose Stop sharing this window's runs waits for the person to confirm it, or for the hub's answer. */
const windowStopAsking = new Set<string>();
const windowStopping = new Set<string>();
/** Why a hub refused to stop sharing its window's runs, until it is asked again. */
const windowStopRefusals = new Map<string, string>();

/** Stop sharing this window's runs, on the hubs line: asked first, every time, then every run of the window stops. */
function askStopWindow(hub: string, yes: boolean | null): void {
  if (yes === null) {
    windowStopAsking.add(hub);
    focusKey = `hubs|${hub}|stop-window-yes`;
    return render();
  }
  windowStopAsking.delete(hub);
  focusKey = `hubs|${hub}|stop-window`;
  if (!yes) return render();
  void stopWindow(hub);
}

async function stopWindow(hub: string): Promise<void> {
  if (windowStopping.has(hub)) return;
  windowStopping.add(hub);
  windowStopRefusals.delete(hub);
  render();
  const answer = await answered((id) => ({ type: 'unshare-window', id, hub }), OFFLINE, TIMEOUT);
  windowStopping.delete(hub);
  if (answer.ok && state?.hubs.find((h) => h.id === hub)?.windowShared) windowsAsked.add(hub);
  const text = answer.ok ? answer.message : failureText(answer, hub);
  if (!answer.ok) windowStopRefusals.set(hub, text);
  if (text) announce(text);
  render();
}

/** A control of the window, for the stop its button was drawn for (`since`, null for Pause). */
async function control(run: RunsRun, worker: number, what: Control, since: string | null): Promise<void> {
  const asked = what === 'pause' || what === 'give-up' ? null : since;
  if (what === 'resume' || what === 'end') advanceTab(run, worker, asked);
  const answer = await send(run, worker, what, asked);
  if (!answer) return;
  // The intents say what to do in the test's window; the other controls show in the state that follows.
  if (!answer.ok || (IN_WINDOW as readonly string[]).includes(what)) {
    say(workerKey(run.hub, run.session.ref, { worker }), answer, asked);
  }
  render();
}

/** Mock a request: lists the requests the test kept at this stop, or closes the list it shows. */
async function toggleRequests(run: RunsRun, worker: number, since: string): Promise<void> {
  const key = workerKey(run.hub, run.session.ref, { worker });
  if (busy.has(key)) return;
  if (requestLists.get(key)?.since === since) {
    closeRequests(key);
    render();
    return;
  }
  const answer = await send(run, worker, 'requests', since);
  if (!answer) return;
  if (answer.ok && answer.requests) {
    const { requests } = answer;
    requestLists.set(key, { since, requests, serial: ++listSerial });
    announce(requests.length > 0 ? tn('runs_requestsListed', requests.length) : t('runs_requestsNone'));
  } else {
    say(key, answer, since);
  }
  render();
}

/** Mocks the request chosen in the list: the code goes to the editor to write; the list closes once it went. */
async function mockRequest(run: RunsRun, worker: number, since: string, request: number): Promise<void> {
  const key = workerKey(run.hub, run.session.ref, { worker });
  const answer = await send(run, worker, 'mock', since, { request });
  if (!answer) return;
  // The hub said what the code came to before this answer, with what to review in it: the answer says it again.
  const shown = answers.get(key);
  if (!(answer.ok && shown?.since === since && shown.text === answer.message)) say(key, answer, since, { sent: true });
  if (answer.ok) closeRequests(key);
  render();
}

/**
 * Open the trace so far: the hub opens Playwright's trace viewer on the running test of a lane (Playwright's
 * `parallelIndex`), on its own machine, and its sentence shows under the test of the lane's worker as it answers, read
 * out, while that worker stands there. Nothing names the trace's file: the window sends the run and the lane alone.
 */
async function openTrace(run: RunsRun, lane: number): Promise<void> {
  const slot = slotKey(run.hub, run.session.ref, lane);
  if (tracing.has(slot) || !hubAnswers(run.hub)) return;
  tracing.add(slot);
  render();
  const answer = await command(run.hub, run.session.ref, null, 'trace', null, { lane });
  tracing.delete(slot);
  const shown = state?.runs.find((r) => r.hub === run.hub && r.session.ref === run.session.ref && !r.session.ended);
  const worker = shown?.session.workers.find((w) => w.parallelIndex === lane);
  if (worker) say(workerKey(run.hub, run.session.ref, worker), answer, stopNow(run, worker.worker));
  render();
}

/** Closes a worker's list of requests; the keyboard, when it was there, goes back to Mock a request. */
function closeRequests(key: string): void {
  requestLists.delete(key);
  if (focusKey?.startsWith(`${key}|request`)) focusKey = `${key}|mock`;
}

/** Asks for the image of a stopped worker's page, once per stop. */
function wantImage(run: RunsRun, worker: HubWorker, stop: HubStop): void {
  const key = workerKey(run.hub, run.session.ref, worker);
  if (images.get(key)?.since === stop.since) return;
  images.set(key, { since: stop.since, loading: true, img: null, note: '', viewport: null });
  void command(run.hub, run.session.ref, worker.worker, 'image', stop.since).then((answer) => {
    if (images.get(key)?.since !== stop.since) return;
    let img: HTMLImageElement | null = null;
    const image = answer.ok && isImage(answer.image) ? answer.image : null;
    const viewport = image?.width && image.height ? { width: image.width, height: image.height } : null;
    if (image) {
      // One element per stop, moved into each rendering, so the image is decoded once.
      const made = element('img');
      made.alt =
        stop.reason === 'failure'
          ? t('runs_imageAltFailure', { error: stopError(stop).split('\n')[0]! })
          : t('runs_imageAlt', { call: stop.title });
      made.src = `data:image/jpeg;base64,${image.data}`;
      made.draggable = false;
      // Pick on the image: a Shift+click, or a click while Pick on the image waits for one.
      made.addEventListener('pointerdown', (event) => {
        const kept = images.get(key);
        if (!(event.shiftKey || picking.has(key)) || kept?.since !== stop.since || !kept.viewport) return;
        event.preventDefault();
        void pickOnImage(key, stop.since, made, event, kept.viewport);
      });
      img = made;
    }
    images.set(key, {
      since: stop.since,
      loading: false,
      img,
      note: img ? '' : failureText(answer, run.hub),
      viewport,
      ...(answer.failure === 'offline' ? { lost: run.hub } : {}),
    });
    render();
  });
}

/** An image to show: a JPEG in base64, checked again before it goes into an address. */
function isImage(image: HubImage | null | undefined): image is HubImage {
  return !!image && image.mime === 'image/jpeg' && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data);
}

// ── The live view ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A frame of a live view that is an image. */
type ImageFrame = Extract<RunsFrame, { data: string }>;

/** A live image, a stop's view or a watched lane's: the element its frames are drawn in, and the input it sends. */
interface ViewSurface {
  /** The image the frames are drawn in, one element for the view, and the viewport of the frame it shows. */
  img: HTMLImageElement;
  viewport: { width: number; height: number } | null;
  /** Whether the stop it shows takes this window's input now (`input` among its intents), and what sends it. */
  inputOn: boolean;
  input: ViewInputBatcher | null;
  /** Whether a click into the view took the keyboard, Tab included, until Escape gives it back. */
  captured: boolean;
}

/** A stopped worker's live view, for the stop it watches: what the window shows of it, and the input it sends. */
interface LiveView extends RunsView, ViewSurface {
  /** Asked of the hub and not answered yet; on; ended as the hub's connection was lost; or refused. */
  status: 'starting' | 'on' | 'ended' | 'refused';
  /** Why it ended or was refused. */
  note: string;
  /** The latest frame not drawn yet, while another one decodes: the others are dropped. */
  next: ImageFrame | null;
  decoding: boolean;
  /** The hub's sentence saying why no frame comes now (the page is too heavy for the view), until one does. */
  heavy: string;
}

/** A frame of a lane that is an image. */
type LaneImageFrame = Extract<RunsLaneFrame, { data: string }>;

/**
 * A lane the window watches (Watch): what it shows of it, the frame drawn last, wherever the worker stands now, and the
 * input it sends while that frame shows the stop the worker stands at.
 */
interface LaneView extends RunsLane, ViewSurface {
  /**
   * Not asked now (the window hidden, or its port to the worker down), asked again as it can be; asked of the hub and
   * not answered yet; on; ended as the hub's connection was lost, asked again once it answers; or refused.
   */
  status: 'idle' | 'starting' | 'on' | 'ended' | 'refused';
  /** Why it ended or was refused. */
  note: string;
  /**
   * How many times the hub was asked to watch it: an answer to an earlier ask is dropped, and a frame that came in one
   * shows only as the frame before, dimmed and taking no input, until one of the latest ask comes.
   */
  asks: number;
  /** Its hub's connection was lost: it is asked again once the hub was away and answers again. */
  waitAway: boolean;
  /** Where its worker stood when the hub refused it, its worker and its test: the refusal shows until it moves on. */
  refusedAt: string | null;
  /** Where the frame drawn was taken: its worker, its test and its stop (null while the test ran), and in which ask. */
  shown: { worker: number; test: string; since: string | null; ask: number } | null;
  /** The latest frame not drawn yet, while another one decodes, and the ask it came in: the others are dropped. */
  next: LaneImageFrame | null;
  nextAsk: number;
  decoding: boolean;
  /** The hub's sentence saying why the lane sends no frame now, shown in place of its image until one comes. */
  refused: string;
  /** How many of those sentences came: a frame decoding as one came is older than it, and is not drawn. */
  refusals: number;
  /** The stop its input goes to, while the frame drawn shows the stop the worker stands at. */
  inputSince: string | null;
  /** Its layers as they came, of the test its worker runs (`takeLaneLayer`), in memory alone. */
  layers: LaneLayers;
  /** A layer came while it was watched: its worker's reporter sends them, and they show under its page. */
  layered: boolean;
  /** The person asked for the page's text: the hub takes it and follows it, until Hide the text. */
  text: boolean;
  /** The page's text was asked and has not come yet; why it did not, once the hub said. */
  textAsking: boolean;
  textNote: string;
  /** Ends `textAsking` `TEXT_WAIT_MS` after the latest ask. */
  textTimer: ReturnType<typeof setTimeout> | null;
  /** The image of the filmstrip shown larger, by its call's id; null for the strip alone. */
  film: string | null;
}

/** Each stopped worker's live view, by worker. */
const views = new Map<string, LiveView>();
/**
 * The lanes the person watches (Watch), by slot (`slotKey`): through the tests and stops of each and the workers
 * Playwright starts in it, until it is turned off or the run ends.
 */
const lanes = new Map<string, LaneView>();
/**
 * The slots whose stop's Watch the person left on (`slotKey`), each with its hub and run: each new stop of the worker in
 * the slot is watched too, a worker Playwright starts in its place after a failure included, until it is turned off or
 * the run ends.
 */
const watchLive = new Map<string, { hub: string; run: string }>();
/**
 * The slots whose Interact the person turned on (`slotKey`), each with its hub and run: the views of the slot's stops
 * send the person's clicks, wheel and keys to the page, through each next stop, until Interact, the stop's Watch or the lane's is
 * turned off, `Esc` is pressed on the view, or the run ends.
 */
const interacting = new Map<string, { hub: string; run: string }>();
/** The stop each slot's input last reached (`slotKey` to its `since`): the person drove it with that input. */
const inputAt = new Map<string, string>();
/**
 * The workers whose stop is being given back as Interact goes off (`workerKey`): their page's tools and Give back are
 * held until it is, so a second press neither ends the watch nor gives the stop back ahead of the input.
 */
const releasing = new Set<string>();
/** The workers whose Pick on the image waits for a click on the image. */
const picking = new Set<string>();
/** The view (worker and stop) the hint on its input shows under: the first one this window gave input to. */
let hintFor: string | null = null;

/** Whether the person's computer is a Mac, whose ⌘ holds the shortcuts. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** The buttons that go to the page: the middle one stays the window's, as it opens what it clicks in a new tab. */
const BUTTONS: Record<number, ViewButton> = { 0: 'left', 2: 'right' };

/** The keys held with a click, which go down around it in the page (Shift+click picks instead). */
function modifiersOf(event: MouseEvent): ViewModifier[] {
  const held: ViewModifier[] = [];
  if (event.ctrlKey) held.push('Control');
  if (event.altKey) held.push('Alt');
  if (event.metaKey) held.push('Meta');
  return held;
}

function isLive<T extends { status: string }>(view: T | undefined): view is T {
  return !!view && (view.status === 'starting' || view.status === 'on');
}

/** Whether the person watches a lane: Watch is on, though the window may not watch it right now. */
function isWatched(lane: LaneView | undefined): lane is LaneView {
  return !!lane && lane.status !== 'refused';
}

/** The run, the worker and the stop a worker of the state stands at, while it does. */
function stoppedAt(key: string): { run: RunsRun; worker: HubWorker; stop: HubStop } | null {
  for (const run of state?.runs ?? []) {
    if (run.session.ended) continue;
    for (const worker of run.session.workers) {
      if (workerKey(run.hub, run.session.ref, worker) !== key) continue;
      return worker.state === 'stopped' && worker.stop ? { run, worker, stop: worker.stop } : null;
    }
  }
  return null;
}

/**
 * The stop's Watch, on or off for a worker's slot; on, every next stop in the slot is watched too, until it is turned off.
 */
function toggleLive(run: RunsRun, worker: number, stop: HubStop): void {
  const key = workerKey(run.hub, run.session.ref, { worker });
  if (releasing.has(key)) return;
  const lane = run.session.workers.find((w) => w.worker === worker)?.parallelIndex ?? worker;
  const slot = slotKey(run.hub, run.session.ref, lane);
  // The run of a hub not connected now is shown as last heard: its stop's Watch waits for the hub.
  if (!hubAnswers(run.hub)) return;
  const view = views.get(key);
  if (view?.since === stop.since && isLive(view)) {
    watchLive.delete(slot);
    const shown = run.session.workers.find((w) => w.worker === worker);
    // The stop is given back, once its input went, before the view ends, which would give it back unsaid.
    const released = shown && interacting.has(slot) ? setInteract(run, shown, stop, false) : Promise.resolve();
    void released.then(() => {
      if (views.get(key) === view) endView(key, true);
      render();
    });
  } else {
    watchLive.set(slot, { hub: run.hub, run: run.session.ref });
    startView(run, worker, stop);
  }
  render();
}

/**
 * Interact, on or off for a worker's slot. On, the slot's views send the person's input to the page, and the first of
 * it drives the stop, where its hub names who drives (`presence`). Off, the input waiting goes first, then a stop this
 * window drives, or reached with its input, is given back, whatever command is on its way. The stop's Watch or the
 * lane's turned off, a view or a lane refused, and Give back turn it off too.
 */
function setInteract(run: RunsRun, worker: HubWorker, stop: HubStop, on: boolean): Promise<void> {
  const slot = slotKey(run.hub, run.session.ref, worker.parallelIndex);
  if (on) {
    interacting.set(slot, { hub: run.hub, run: run.session.ref });
    render();
    return Promise.resolve();
  }
  interacting.delete(slot);
  const key = workerKey(run.hub, run.session.ref, worker);
  releasing.add(key);
  const surface = [views.get(key), lanes.get(slot)].find((view) => view?.input);
  const drained = surface?.input?.finish() ?? Promise.resolve();
  if (surface) {
    surface.input = null;
    surface.inputOn = false;
    surface.captured = false;
  }
  const done = drained.then(async () => {
    // Interact on again meanwhile: the person drives on. Who drives is read as the hub says now, the toggle that called
    // this having been drawn before it changed; input that reached the stop gives it back while nobody else took it.
    if (interacting.has(slot)) return;
    const now = stoppedAt(key)?.stop;
    if (now?.since !== stop.since || !hubAnswers(run.hub)) return;
    if (!state?.hubs.find((h) => h.id === run.hub)?.presence) return;
    if (!givesBack(driverOf(now, runsSpeaker), inputAt.get(slot) === stop.since)) return;
    inputAt.delete(slot);
    await giveBack(run, worker.worker, stop.since);
  });
  render();
  return done.finally(() => {
    releasing.delete(key);
    render();
  });
}

/** Gives a stop back, past any command on its way: a refusal is shown under the test, the answer read out. */
async function giveBack(run: RunsRun, worker: number, since: string): Promise<void> {
  const answer = await command(run.hub, run.session.ref, worker, 'drive', since, { on: false });
  if (stopNow(run, worker) !== since) return;
  if (!answer.ok) say(workerKey(run.hub, run.session.ref, { worker }), answer, since);
  else if (answer.message) announce(answer.message);
  render();
}

/** Whether a hub's connection answers now: its runs are not shown as last heard. */
function hubAnswers(hub: string): boolean {
  return !!state?.hubs.some((h) => h.id === hub && h.connected);
}

/**
 * Asks the hub for a stop's live view; its frames take the image's place once the first one is drawn. Nothing while
 * the port to the worker is down: a stop's Watch left on starts it once the worker is back.
 */
function startView(run: RunsRun, worker: number, stop: HubStop): void {
  if (!port) return;
  const key = workerKey(run.hub, run.session.ref, { worker });
  endView(key, false);
  const view: LiveView = {
    hub: run.hub,
    ref: run.session.ref,
    worker,
    since: stop.since,
    status: 'starting',
    note: '',
    img: element('img', 'live'),
    viewport: null,
    next: null,
    decoding: false,
    heavy: '',
    inputOn: false,
    input: null,
    captured: false,
  };
  liveImage(view, `${key}|view`, () => ({ key, since: view.since, toggle: 'live' }));
  views.set(key, view);
  void command(view.hub, view.ref, worker, 'view', stop.since, { on: true }).then((answer) => {
    if (views.get(key) !== view || !isLive(view)) return;
    if (answer.ok) {
      view.status = 'on';
    } else {
      stopInput(view);
      // Refused, the view takes no input: Interact goes off, to be turned on again on a view that takes it.
      const lane = run.session.workers.find((w) => w.worker === worker)?.parallelIndex ?? worker;
      interacting.delete(slotKey(run.hub, run.session.ref, lane));
      // A view asked as its hub's connection was lost ends as the loss does, to start again once it answers.
      const lost = answer.failure === 'offline';
      view.status = lost ? 'ended' : 'refused';
      view.note = lost ? t('runs_liveLost', { tool: toolName(run.hub) }) : failureText(answer, run.hub);
      view.next = null;
      announce(view.note);
    }
    render();
  });
}

/** A worker's view ends: its input and its frames are dropped; the hub hears it (`tell`) while it was on. */
function endView(key: string, tell: boolean): void {
  const view = views.get(key);
  if (!view) return;
  views.delete(key);
  stopInput(view);
  view.next = null;
  view.img.removeAttribute('src');
  if (hintFor === `${key}|${view.since}`) hintFor = '';
  if (tell && isLive(view)) void command(view.hub, view.ref, view.worker, 'view', view.since, { on: false });
}

/** A view takes no more input: what waits is dropped, or sent first (`finish`) when the view still shows its stop. */
function stopInput(view: ViewSurface, finish = false): void {
  if (finish) view.input?.finish();
  else view.input?.dispose();
  view.input = null;
  view.inputOn = false;
  view.captured = false;
}

/**
 * The input on a view follows what the stop it shows takes from this window: none while it takes none. `send` plays a
 * batch, and `hint` names the stop for the hint on the input, shown under the first view that takes it.
 */
function syncInput(
  view: ViewSurface,
  on: boolean,
  clickCounts: boolean,
  send: (events: ViewInput[]) => Promise<boolean>,
  hint: string,
): void {
  if (on && !view.input) view.input = new ViewInputBatcher({ send, clickCounts });
  if (!on) stopInput(view, true);
  view.inputOn = on;
  if (on && hintFor === null) hintFor = hint;
}

/**
 * Sends a batch of input for the stop `at` names, while the view that sends it shows that stop (`showing`); a refusal
 * shows once under the test. Input played there that drives the stop, all but the pointer's moves, is kept for the
 * slot (`inputAt`).
 */
async function sendInput(at: RunsView, slot: string, showing: () => boolean, events: ViewInput[]): Promise<boolean> {
  if (!showing()) return false;
  const key = workerKey(at.hub, at.ref, at);
  const answer = await command(at.hub, at.ref, at.worker, 'input', at.since, { events });
  if (answer.ok && events.some((e) => e.type !== 'mouse' || e.action !== 'move')) inputAt.set(slot, at.since);
  if (answer.ok || !showing()) return answer.ok;
  if (answers.get(key)?.text !== failureText(answer, at.hub)) {
    say(key, answer, at.since);
    render();
  }
  return false;
}

/**
 * A frame of a view this window watches: drawn once decoded, the latest one alone waiting meanwhile. Why no frame
 * comes, when the hub says so, is shown under the view until one does.
 */
function heardFrame(frame: RunsFrame): void {
  const key = workerKey(frame.hub, frame.ref, frame);
  const view = views.get(key);
  // A frame of a stop the window no longer watches, or no longer shows, goes nowhere.
  if (!isLive(view) || view.since !== frame.since) return;
  if ('refused' in frame) {
    if (view.heavy === frame.refused) return;
    view.heavy = frame.refused;
    announce(view.heavy);
    render();
    return;
  }
  if (!isViewFrameData(frame.data)) return;
  view.next = frame;
  if (!view.decoding) void drawFrames(key, view);
}

async function drawFrames(key: string, view: LiveView): Promise<void> {
  view.decoding = true;
  while (view.next && views.get(key) === view) {
    const frame = view.next;
    view.next = null;
    const src = `data:image/jpeg;base64,${frame.data}`;
    // Decoded aside first: the view shows the frame before until this one is whole.
    const decoded = new Image();
    decoded.src = src;
    try {
      await decoded.decode();
    } catch {
      continue;
    }
    if (views.get(key) !== view || !isLive(view)) break;
    const changed = !view.viewport || !!view.heavy;
    view.img.src = src;
    view.viewport = { width: frame.width, height: frame.height };
    view.heavy = '';
    if (changed) render();
  }
  view.decoding = false;
}

/** A view this window watched ended without its asking: the hub's connection was lost. */
function heardViewEnded(ended: RunsView): void {
  const key = workerKey(ended.hub, ended.ref, ended);
  const view = views.get(key);
  if (!isLive(view) || view.since !== ended.since) return;
  stopInput(view);
  view.status = 'ended';
  view.note = t('runs_liveLost', { tool: toolName(ended.hub) });
  view.next = null;
  view.img.removeAttribute('src');
  view.viewport = null;
  announce(view.note);
  render();
}

// ── Watched lanes ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Watch, on or off for a worker's lane. */
function toggleLane(run: RunsRun, worker: HubWorker): void {
  // The run of a hub not connected now is shown as last heard: its Watch waits for the hub.
  if (!hubAnswers(run.hub)) return;
  const slot = slotKey(run.hub, run.session.ref, worker.parallelIndex);
  if (releasing.has(workerKey(run.hub, run.session.ref, worker))) return;
  const lane = lanes.get(slot);
  if (isWatched(lane)) {
    // The stop is given back, once its input went, before the watch ends, which would give it back unsaid.
    const released =
      interacting.has(slot) && worker.state === 'stopped' && worker.stop
        ? setInteract(run, worker, worker.stop, false)
        : Promise.resolve();
    void released.then(() => {
      if (lanes.get(slot) === lane) endLane(slot, true);
      render();
    });
  } else startLane(run, worker);
  render();
}

/** Pause and watch: the worker pauses before its next call, and its lane is watched. */
function pauseAndWatch(run: RunsRun, worker: HubWorker): void {
  if (!hubAnswers(run.hub)) return;
  if (!isWatched(lanes.get(slotKey(run.hub, run.session.ref, worker.parallelIndex)))) startLane(run, worker);
  void control(run, worker.worker, 'pause', null);
}

/** Starts watching a worker's lane: its frames are drawn in the lane's image as they come. */
function startLane(run: RunsRun, worker: HubWorker): void {
  const slot = slotKey(run.hub, run.session.ref, worker.parallelIndex);
  endLane(slot, false);
  const lane: LaneView = {
    hub: run.hub,
    ref: run.session.ref,
    lane: worker.parallelIndex,
    status: 'idle',
    note: '',
    asks: 0,
    waitAway: false,
    refusedAt: null,
    img: element('img', 'live'),
    viewport: null,
    shown: null,
    next: null,
    nextAsk: 0,
    decoding: false,
    refused: '',
    refusals: 0,
    inputSince: null,
    inputOn: false,
    input: null,
    captured: false,
    layers: noLaneLayers(),
    layered: false,
    text: false,
    textAsking: false,
    textNote: '',
    textTimer: null,
    film: null,
  };
  liveImage(lane, `${slot}|view`, () => laneTarget(lane));
  lanes.set(slot, lane);
  askLane(slot, lane);
}

/** The stop a lane's image shows, while the frame drawn shows one. */
function laneTarget(lane: LaneView): ViewTarget {
  const shown = lane.shown;
  if (!shown?.since) return null;
  return { key: workerKey(lane.hub, lane.ref, shown), since: shown.since, toggle: 'watch' };
}

/**
 * Asks the hub to watch a lane, the frame drawn last kept until the next one comes. Nothing while the port to the
 * worker is down or the window is hidden: it is asked again once it can be (`resumeLanes`).
 */
function askLane(slot: string, lane: LaneView): void {
  if (!port || document.hidden) {
    lane.status = 'idle';
    return;
  }
  lane.status = 'starting';
  const ask = ++lane.asks;
  const watch = (on: boolean) =>
    command(lane.hub, lane.ref, null, 'watch', null, { lane: lane.lane, on, ...(on ? layersAsk(lane) : {}) });
  void watch(true).then((answer) => {
    if (lanes.get(slot) !== lane || lane.asks !== ask || lane.status !== 'starting') return;
    if (answer.ok) {
      lane.status = 'on';
    } else {
      stopInput(lane);
      interacting.delete(slot);
      // The worker may still watch it for this window, which dropped the ask: it stops.
      if (answer.failure === 'timeout') void watch(false);
      // A lane asked as its hub's connection was lost ends as the loss does, to be asked again once it answers.
      const lost = answer.failure === 'offline';
      lane.status = lost ? 'ended' : 'refused';
      lane.note = lost ? t('runs_liveLost', { tool: toolName(lane.hub) }) : failureText(answer, lane.hub);
      lane.waitAway = lost;
      lane.refusedAt = lost || !state ? null : lanePlace(state, lane);
      lane.next = null;
      announce(lane.note);
    }
    render();
  });
}

/** Where a lane's worker stands in a state, as a refusal of the lane is kept by: its worker and its test. */
function lanePlace(current: RunsState, lane: RunsLane): string {
  const run = current.runs.find((r) => r.hub === lane.hub && r.session.ref === lane.ref && !r.session.ended);
  const worker = run?.session.workers.find((w) => w.parallelIndex === lane.lane);
  return worker ? `${worker.worker}|${worker.test?.id ?? ''}` : '';
}

/** The window no longer watches a lane: the hub hears it (`tell`) while it was on. */
function endLane(slot: string, tell: boolean): void {
  const lane = lanes.get(slot);
  if (!lane) return;
  lanes.delete(slot);
  interacting.delete(slot);
  idleLane(lane, tell);
  lane.img.removeAttribute('src');
}

/** A lane is not watched for now, Watch left on: its input and the frame waiting are dropped, the last one kept. */
function idleLane(lane: LaneView, tell: boolean): void {
  if (tell && isLive(lane)) void command(lane.hub, lane.ref, null, 'watch', null, { lane: lane.lane, on: false });
  stopInput(lane);
  lane.inputSince = null;
  lane.status = 'idle';
  lane.next = null;
}

/**
 * Watches again each lane Watch left on that is not watched now: once the window shows, and once its hub answers
 * again after its connection was lost. A lane the hub refused is let go once its worker, or the test it runs,
 * changes.
 */
function resumeLanes(current: RunsState): void {
  for (const [slot, lane] of lanes) {
    if (lane.status === 'refused') {
      if (lanePlace(current, lane) !== lane.refusedAt) endLane(slot, false);
      continue;
    }
    if (lane.status !== 'idle' && lane.status !== 'ended') continue;
    const connected = current.hubs.some((hub) => hub.id === lane.hub && hub.connected);
    // The loss is heard before the state that shows the hub away: the hub answers again only after that one.
    if (lane.waitAway) {
      if (!connected) lane.waitAway = false;
      continue;
    }
    const live = current.runs.some((r) => r.hub === lane.hub && r.session.ref === lane.ref && !r.session.ended);
    if (live && connected) askLane(slot, lane);
  }
}

/**
 * A frame of a lane this window watches: drawn once decoded, the latest one alone waiting meanwhile. Why no frame
 * comes, when the hub says so, is shown in place of the lane's image until one does.
 */
function heardLaneFrame(frame: RunsLaneFrame): void {
  const slot = slotKey(frame.hub, frame.ref, frame.lane);
  const lane = lanes.get(slot);
  if (!isLive(lane)) return;
  if ('refused' in frame) {
    lane.next = null;
    lane.refusals++;
    if (lane.refused === frame.refused) return;
    lane.refused = frame.refused;
    announce(lane.refused);
    render();
    return;
  }
  if (!isViewFrameData(frame.data)) return;
  lane.next = frame;
  lane.nextAsk = lane.asks;
  if (!lane.decoding) void drawLane(slot, lane);
}

async function drawLane(slot: string, lane: LaneView): Promise<void> {
  lane.decoding = true;
  while (lane.next && lanes.get(slot) === lane) {
    const frame = lane.next;
    const ask = lane.nextAsk;
    const refusals = lane.refusals;
    lane.next = null;
    const src = `data:image/jpeg;base64,${frame.data}`;
    // Decoded aside first: the lane shows the frame before until this one is whole.
    const decoded = new Image();
    decoded.src = src;
    try {
      await decoded.decode();
    } catch {
      continue;
    }
    if (lanes.get(slot) !== lane || !isLive(lane)) break;
    if (lane.refusals !== refusals || lane.asks !== ask) continue;
    const shown = { worker: frame.worker, test: frame.test, since: frame.since, ask };
    // Drawn again when the frame shows another place or comes in another ask, or the first one, or once the hub said
    // why none came.
    const moved = JSON.stringify(shown) !== JSON.stringify(lane.shown) || !lane.viewport || !!lane.refused;
    lane.img.src = src;
    lane.viewport = { width: frame.width, height: frame.height };
    lane.shown = shown;
    lane.refused = '';
    if (moved) render();
  }
  lane.decoding = false;
}

/** A lane this window watched is no longer watched without its asking: the hub's connection was lost. */
function heardLaneEnded(ended: RunsLane): void {
  const lane = lanes.get(slotKey(ended.hub, ended.ref, ended.lane));
  if (!isLive(lane)) return;
  idleLane(lane, false);
  lane.status = 'ended';
  lane.note = t('runs_liveLost', { tool: toolName(ended.hub) });
  lane.waitAway = true;
  announce(lane.note);
  render();
}

// ── A CI lane watched ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The CI lane this window watches, read-only, one at a time: asked of the worker (`asking`), watched (`on`), let go
 * while the window hides or its port is down (`idle`, asked again as it shows), ended without its asking or refused,
 * with why (`note`). Its images are decoded aside first, the latest waiting, and kept in memory alone.
 */
interface CiView extends RunsCiLane {
  status: 'asking' | 'on' | 'idle' | 'ended' | 'refused';
  note: string;
  /** Each ask counted: an answer to an earlier one changes nothing. */
  asks: number;
  img: HTMLImageElement;
  /** An image was drawn. */
  shown: boolean;
  next: Extract<RunsCiFrame, { data: string }> | null;
  decoding: boolean;
  /** Why the lane sends no image now, until one comes. */
  refused: string;
  test: string | null;
  call: string | null;
}

let ciView: CiView | null = null;

function isCiLive(view: CiView | null): view is CiView {
  return !!view && (view.status === 'asking' || view.status === 'on');
}

/** Ask the worker to watch a CI lane, or stop, answered as a command is. */
function ciCommand(lane: RunsCiLane, on: boolean): Promise<RunsAnswer> {
  return answered(
    (id) => ({ type: 'ci-watch', id, ...lane, on }),
    { ok: false, message: '', ci: 'offline' },
    { ok: false, message: '', ci: 'late' },
  );
}

/** **Watch** on a CI run's running test: watch its lane, or stop watching it. */
function toggleCi(lane: RunsCiLane): void {
  if (ciView && ciLaneKey(ciView) === ciLaneKey(lane) && ciView.status !== 'ended' && ciView.status !== 'refused') {
    const was = ciView;
    ciView = null;
    if (was.status !== 'idle') void ciCommand(lane, false);
    render();
    return;
  }
  const img = new Image();
  img.className = 'live';
  ciView = {
    ...lane,
    status: 'asking',
    note: '',
    asks: 0,
    img,
    shown: false,
    next: null,
    decoding: false,
    refused: '',
    test: null,
    call: null,
  };
  askCi(ciView);
  render();
}

async function askCi(view: CiView): Promise<void> {
  view.status = 'asking';
  const ask = ++view.asks;
  const answer = await ciCommand({ runId: view.runId, shard: view.shard, lane: view.lane }, true);
  if (ciView !== view || view.asks !== ask || view.status !== 'asking') return;
  if (answer.ok) {
    view.status = 'on';
    announce(t('runs_ciWatching', { worker: ciLaneName(view), id: String(view.runId) }));
  } else {
    view.status = 'refused';
    view.note = ciRefusalText(answer);
    announce(view.note);
  }
  render();
}

/** Why a CI lane was not watched, in the window's words, or the instance's own sentence. */
function ciRefusalText(answer: RunsAnswer): string {
  if (answer.message) return answer.message;
  switch (answer.ci) {
    case 'unlisted':
      return t('runs_ciRefusedUnlisted');
    case 'unfollowed':
      return t('runs_ciRefusedUnfollowed');
    case 'unwatchable':
      return t('runs_ciRefusedUnwatchable');
    case 'no-test':
      return t('runs_ciRefusedNoTest');
    case 'late':
      return t('runs_ciRefusedLate');
    case 'older':
      return t('runs_ciRefusedOlder');
    case 'refused':
      return t('runs_ciRefusedStatus', { status: String(answer.status ?? 0) });
    default:
      return t('runs_ciRefusedOffline');
  }
}

/** Why a CI lane watched ended, in the window's words. */
const CI_ENDS: Record<CiWatchEnd, Parameters<typeof t>[0]> = {
  'run-ended': 'runs_ciEndRun',
  off: 'runs_ciEndOff',
  replaced: 'runs_ciEndReplaced',
  'test-ended': 'runs_ciEndTest',
  'worker-left': 'runs_ciEndWorkerLeft',
  unshared: 'runs_ciEndUnshared',
  silent: 'runs_ciEndSilent',
  closed: 'runs_ciEndClosed',
  broken: 'runs_ciEndBroken',
  moved: 'runs_ciEndMoved',
};

function heardCiFrame(frame: RunsCiFrame): void {
  const view = ciView;
  if (!isCiLive(view) || ciLaneKey(view) !== ciLaneKey(frame)) return;
  if ('refused' in frame) {
    view.next = null;
    if (view.refused === frame.refused) return;
    view.refused = frame.refused;
    announce(view.refused);
    render();
    return;
  }
  if (!isViewFrameData(frame.data)) return;
  view.next = frame;
  if (!view.decoding) void drawCi(view);
}

async function drawCi(view: CiView): Promise<void> {
  view.decoding = true;
  while (view.next && ciView === view) {
    const frame = view.next;
    view.next = null;
    const src = `data:image/jpeg;base64,${frame.data}`;
    // Decoded aside first: the view shows the image before until this one is whole.
    const decoded = new Image();
    decoded.src = src;
    try {
      await decoded.decode();
    } catch {
      continue;
    }
    if (ciView !== view || !isCiLive(view)) break;
    const moved = !view.shown || !!view.refused || view.test !== frame.test || view.call !== frame.call;
    view.img.src = src;
    view.shown = true;
    view.refused = '';
    view.test = frame.test;
    view.call = frame.call;
    if (moved) render();
  }
  view.decoding = false;
}

function heardCiEnded(ended: RunsCiLane & { why: CiWatchEnd }): void {
  const view = ciView;
  if (!isCiLive(view) || ciLaneKey(view) !== ciLaneKey(ended)) return;
  view.status = 'ended';
  view.note = t(CI_ENDS[ended.why] ?? 'runs_ciEndClosed');
  announce(view.note);
  render();
}

/** The CI lane is let go while the window hides or its port is down, and asked again as it shows. */
function idleCi(tell: boolean): void {
  if (!isCiLive(ciView)) return;
  const view = ciView;
  view.status = 'idle';
  view.asks++;
  if (tell) void ciCommand({ runId: view.runId, shard: view.shard, lane: view.lane }, false);
}

// ── A watched lane's layers ─────────────────────────────────────────────────────────────────────────────────────────

/** The layers a lane's watch takes, at a hub that sends them: every one, the page's text once the person asked. */
function layersAsk(lane: LaneView): { layers?: ReturnType<typeof laneLayersAsked> } {
  return state?.hubs.find((hub) => hub.id === lane.hub)?.layers ? { layers: laneLayersAsked(lane.text) } : {};
}

/** How long the window says it reads the page's text before it gives up waiting for it. */
const TEXT_WAIT_MS = 15_000;

/**
 * Shows the page's text, takes it again (`on`), or hides it: the hub hears the lane's layers again, `text` among them
 * taking the page's text now and following it after.
 */
function askText(slot: string, on: boolean): void {
  const lane = lanes.get(slot);
  if (!isLive(lane)) return;
  lane.text = on;
  lane.textAsking = on;
  lane.textNote = '';
  if (lane.textTimer) clearTimeout(lane.textTimer);
  lane.textTimer = null;
  if (!on) lane.layers = { ...lane.layers, text: null, textRefused: null };
  void command(lane.hub, lane.ref, null, 'watch', null, { lane: lane.lane, on: true, ...layersAsk(lane) }).then(
    (answer) => {
      if (lanes.get(slot) !== lane || answer.ok || !lane.textAsking) return;
      lane.textAsking = false;
      lane.textNote = failureText(answer, lane.hub);
      render();
    },
  );
  if (on) {
    lane.textTimer = setTimeout(() => {
      lane.textTimer = null;
      if (lanes.get(slot) !== lane || !lane.textAsking) return;
      lane.textAsking = false;
      render();
    }, TEXT_WAIT_MS);
  }
  render();
}

/** The window is drawn again for a lane's layers at most every `LAYERS_DRAW_MS`: a call's log comes four times a second. */
const LAYERS_DRAW_MS = 200;
let layersDraw: ReturnType<typeof setTimeout> | null = null;

/**
 * A layer of a lane this window watches: kept with the lane's others, the test's alone. The lane's next test, while the
 * person shows the page's text, asks for its text.
 */
function heardLaneLayer({ hub, ref, lane: index, ...heard }: RunsLaneLayer): void {
  const slot = slotKey(hub, ref, index);
  const lane = lanes.get(slot);
  if (!isLive(lane)) return;
  const again = lane.text && asksLaneTextAgain(lane.layers, heard);
  lane.layers = takeLaneLayer(lane.layers, heard);
  lane.layered = true;
  if (heard.layer === 'text') {
    lane.textAsking = false;
    lane.textNote = '';
    if (lane.textTimer) clearTimeout(lane.textTimer);
    lane.textTimer = null;
  }
  if (again) askText(slot, true);
  // The image shown larger belongs to the strip: another test's strip shows none.
  if (lane.film && !lane.layers.film.some((entry) => entry.thumb.call === lane.film)) lane.film = null;
  layersDraw ??= setTimeout(() => {
    layersDraw = null;
    render();
  }, LAYERS_DRAW_MS);
}

/** A time in the window's language: `12 s`. */
const inSeconds = (value: number): string => formatUnit(value, 'second');

/** A section of a lane's layers: its heading, then what it shows. */
function layerSection(name: string, id: string, ...children: HTMLElement[]): HTMLElement {
  const heading = element('h3', 'layer-title', name);
  heading.id = id;
  const section = element('section', 'layer', heading, ...children);
  section.setAttribute('aria-labelledby', id);
  return section;
}

/**
 * A watched lane's layers under its page, at a hub that sends them: why its call waits, its page's events, the page's
 * text and the test's filmstrip. Each section is drawn again only when what it shows changes.
 */
function renderLaneLayers(key: string, slot: string, lane: LaneView, away: boolean): HTMLElement {
  const box = part(`${key}|layers`, null, () => element('div', 'layers'));
  const { layers } = lane;
  const text = {
    asked: lane.text,
    asking: lane.textAsking,
    note: lane.textNote,
    text: layers.text,
    refused: layers.textRefused,
  };
  const film = { open: lane.film, thumbs: layers.film.map((entry) => entry.thumb) };
  place(box, [
    part(`${key}|layer-calls`, layers.log, () => renderCallsLayer(key, layers.log)),
    part(`${key}|layer-events`, layers.events, () => renderEventsLayer(key, layers.events)),
    part(`${key}|layer-text`, text, () => renderTextLayer(key, slot, lane)),
    part(`${key}|layer-film`, film, () => renderFilmLayer(key, slot, lane, layers.film)),
  ]);
  markBusy(box.querySelectorAll('button.piwi-btn'), away);
  return box;
}

/** Why the lane's call waits: the call, how long, what its locator matches, then the latest lines of its log. */
function renderCallsLayer(key: string, log: LaneLayers['log']): HTMLElement {
  const id = domId('layer-calls', key);
  if (!log) return layerSection(t('runs_layerCalls'), id, element('p', 'layer-empty', t('runs_callNone')));
  const wait = callWait(log, runsSpeaker, inSeconds);
  const call = element('p', 'layer-call', element('span', 'call', ...richText(wait.title)));
  if (wait.place) call.append(' ', element('span', 'place', wait.place));
  const state = element('p', 'layer-state', wait.state);
  state.dataset.tone = wait.tone;
  if (wait.target) state.append(' · ', wait.target);
  const children: HTMLElement[] = [call, state];
  if (wait.error) children.push(element('p', 'layer-error', wait.error));
  if (wait.lines.length > 0) children.push(element('pre', 'layer-log', wait.lines.join('\n')));
  return layerSection(t('runs_layerCalls'), id, ...children);
}

/** The lane's page's events, newest first: what each is, what it says. */
function renderEventsLayer(key: string, events: readonly LaneEventEntry[]): HTMLElement {
  const id = domId('layer-events', key);
  if (events.length === 0) {
    return layerSection(t('runs_layerEvents'), id, element('p', 'layer-empty', t('runs_eventsNone')));
  }
  const list = element('ul', 'layer-events');
  for (const entry of events) {
    const said = laneEventSaid(entry.event, runsSpeaker, inSeconds);
    const item = element('li', 'layer-event', element('span', 'event-label', said.label));
    item.dataset.tone = said.tone;
    if (said.text) item.append(' ', element('span', 'event-text', said.text));
    list.append(item);
  }
  return layerSection(t('runs_layerEvents'), id, list);
}

/**
 * The page's text, once the person asked for it: Show the page's text, then the text with where it came from, Take
 * it again and Hide the text; or why none came.
 */
function renderTextLayer(key: string, slot: string, lane: LaneView): HTMLElement {
  const id = domId('layer-text', key);
  const { text, textRefused } = lane.layers;
  const button = (label: string, on: boolean, focus: string, icon: IconName, title?: string) => {
    const made = makeButton(label, (event) => !pressedHeld(event) && askText(slot, on), {
      icon,
      small: true,
      ...(title ? { title } : {}),
    });
    made.dataset.focus = `${key}|${focus}`;
    return made;
  };
  if (!lane.text) {
    const show = button(t('runs_textShow'), true, 'text-show', 'list', t('runs_textShowTitle'));
    return layerSection(t('runs_layerText'), id, element('div', 'piwi-actions', show));
  }
  const actions = element(
    'div',
    'piwi-actions',
    button(t('runs_textAgain'), true, 'text-again', 'refresh'),
    button(t('runs_textHide'), false, 'text-hide', 'eye-off'),
  );
  const children: HTMLElement[] = [actions];
  if (lane.textAsking) children.push(element('p', 'layer-empty', t('runs_textWaiting')));
  const why = lane.textNote || textRefused;
  if (why) children.push(iconText(element('p', 'note'), 'alert', why));
  if (text) {
    children.push(element('p', 'meta', laneTextSource(text, runsSpeaker)));
    const pre = element('pre', 'layer-text', text.text);
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', t('runs_textLabel'));
    children.push(pre);
  }
  return layerSection(t('runs_layerText'), id, ...children);
}

/**
 * The test's filmstrip: an image for each call that ended, in the strip's order, each a button that shows it larger
 * with its call's title, Close going back to the strip.
 */
function renderFilmLayer(key: string, slot: string, lane: LaneView, film: readonly LaneFilmEntry[]): HTMLElement {
  const id = domId('layer-film', key);
  const shown = film.filter((entry) => isLaneThumbData(entry.data));
  if (shown.length === 0) {
    return layerSection(t('runs_layerFilmstrip'), id, element('p', 'layer-empty', t('runs_filmstripNone')));
  }
  const choose = (call: string | null) => {
    const now = lanes.get(slot);
    if (now !== lane) return;
    lane.film = call;
    render();
  };
  const children: HTMLElement[] = [];
  const open = shown.find((entry) => entry.thumb.call === lane.film);
  if (open) {
    const image = element('img', 'film-large');
    image.src = `data:image/jpeg;base64,${open.data}`;
    image.alt = t('runs_filmstripAlt', { call: open.thumb.title });
    const close = makeButton(t('runs_filmstripClose'), () => choose(null), { icon: 'close', small: true });
    close.dataset.focus = `${key}|film-close`;
    children.push(
      element('figure', 'film-shown', image, element('figcaption', 'call', ...richText(open.thumb.title))),
      element('div', 'piwi-actions', close),
    );
  }
  const strip = element('ul', 'film-strip');
  for (const entry of shown) {
    const button = element('button', 'film-thumb');
    button.type = 'button';
    button.title = entry.thumb.title;
    button.dataset.focus = `${key}|film|${entry.thumb.call}`;
    button.setAttribute('aria-pressed', String(entry === open));
    const image = element('img');
    image.src = `data:image/jpeg;base64,${entry.data}`;
    image.alt = t('runs_filmstripAlt', { call: entry.thumb.title });
    button.append(image);
    button.addEventListener('click', () => choose(entry === open ? null : entry.thumb.call));
    strip.append(element('li', undefined, button));
  }
  children.push(strip);
  return layerSection(t('runs_layerFilmstrip'), id, ...children);
}

/** Where a pointer event is on an image, in CSS pixels of the viewport it shows. */
function pointOn(
  img: HTMLImageElement,
  event: MouseEvent,
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  return pagePoint(
    { x: event.clientX - rect.left - img.clientLeft, y: event.clientY - rect.top - img.clientTop },
    { width: img.clientWidth, height: img.clientHeight },
    viewport,
  );
}

/**
 * The stop a live image shows: its worker's key, its `since`, and the toggle that started it (`live`, `watch`), which
 * Escape gives the keyboard to when Interact is off; null while it shows no stop.
 */
type ViewTarget = { key: string; since: string; toggle: 'live' | 'watch' } | null;

/**
 * A live image (`focus` naming it for the focus): the pointer, the wheel, the keys and a paste on it go to the page
 * while it takes input; a Shift+click, or a click while Pick on the image waits, picks on the stop it shows (`target`).
 */
function liveImage(view: ViewSurface, focus: string, target: () => ViewTarget): void {
  const { img } = view;
  img.draggable = false;
  img.dataset.focus = focus;
  const at = (event: MouseEvent) => (view.viewport ? pointOn(img, event, view.viewport) : null);
  /** Where the pointer event before a mouse event put the pointer: a mouse event's own point is whole pixels. */
  let pointed: { x: number; y: number } | null = null;
  img.addEventListener('pointerdown', (event) => {
    const shown = target();
    if (event.shiftKey || (shown && picking.has(shown.key))) {
      // No mouse event follows: the page gets nothing of it.
      event.preventDefault();
      if (shown && view.viewport) void pickOnImage(shown.key, shown.since, img, event, view.viewport);
      return;
    }
    pointed = at(event);
    if (!view.input || !BUTTONS[event.button] || !pointed) return;
    // A click into the view takes the keyboard, Tab included.
    img.focus({ preventScroll: true });
    view.captured = true;
    img.setPointerCapture?.(event.pointerId);
  });
  // The buttons as the mouse events name them, which count a double click as the system does (`detail`).
  img.addEventListener('mousedown', (event) => {
    if (!view.input) return;
    // The image is no picture to drag or select, and the middle button scrolls nothing here.
    event.preventDefault();
    const button = BUTTONS[event.button];
    const point = pointed ?? at(event);
    if (button && point) {
      view.input.down(button, point.x, point.y, { count: event.detail, modifiers: modifiersOf(event) });
    }
  });
  img.addEventListener('pointermove', (event) => {
    pointed = at(event);
    if (view.input && pointed) view.input.move(pointed.x, pointed.y);
  });
  img.addEventListener('pointerup', (event) => {
    pointed = at(event);
  });
  img.addEventListener('mouseup', (event) => {
    const button = BUTTONS[event.button];
    const point = pointed ?? at(event);
    if (view.input && button && point) view.input.up(button, point.x, point.y, { count: event.detail });
  });
  img.addEventListener('pointercancel', (event) => {
    const point = at(event);
    if (view.input && point) view.input.cancel(point.x, point.y);
  });
  // A right click goes to the page, not to this window's menu.
  img.addEventListener('contextmenu', (event) => {
    if (view.input) event.preventDefault();
  });
  // The wheel scrolls the page once the view has the focus; until then it scrolls this window.
  img.addEventListener(
    'wheel',
    (event) => {
      const point = at(event);
      if (!view.input || !point || document.activeElement !== img) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (view.viewport?.height ?? 600) : 1;
      view.input.wheel(point.x, point.y, event.deltaX * scale, event.deltaY * scale);
    },
    { passive: false },
  );
  img.addEventListener('keydown', (event) => {
    if (!view.input) return;
    const shown = target();
    const at = shown ? stoppedAt(shown.key) : null;
    // An action runs in the test's window at the stop shown (a pick, a check): its Escape is the page's, unless Pick on
    // the image waits, which Escape stops.
    const acting = !!at?.stop.acting && at.stop.since === shown?.since && !picking.has(shown.key);
    const decided = keyOnView(
      {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        altGraph: event.getModifierState?.('AltGraph') ?? false,
        isComposing: event.isComposing,
      },
      { mac: MAC, captured: view.captured, acting },
    );
    if (decided === 'leave') {
      // Interact goes off, the stop this window drives given back, and the focus goes to Interact; else to the toggle
      // that started the view. Pick on the image, waiting, stops too.
      event.preventDefault();
      view.captured = false;
      if (!shown) return;
      if (picking.delete(shown.key)) render();
      const slot = at ? slotKey(at.run.hub, at.run.session.ref, at.worker.parallelIndex) : null;
      const toggle = at && slot && interacting.has(slot) ? 'interact' : shown.toggle;
      if (at && toggle === 'interact') void setInteract(at.run, at.worker, at.stop, false);
      document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(`${shown.key}|${toggle}`)}"]`)?.focus();
      return;
    }
    if (decided === 'window' || decided === 'none') return;
    event.preventDefault();
    view.input.key(decided.send);
  });
  img.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!view.input || !text) return;
    event.preventDefault();
    for (const typed of pastedText(text)) view.input.key(typed);
  });
  img.addEventListener('blur', () => {
    view.captured = false;
  });
}

/** Pick on the image: on, the next click on the stopped page's image or its view picks; Escape turns it off. */
function togglePicking(key: string): void {
  if (picking.delete(key)) {
    render();
    return;
  }
  picking.add(key);
  announce(t('runs_pickAtOn'));
  render();
}

/**
 * Pick on the image: the element under the pointer on an image of the stopped page, its locator sent to the editor
 * where a pick goes, as the worker answered; shown under the test and read out.
 */
async function pickOnImage(
  key: string,
  since: string,
  img: HTMLImageElement,
  event: MouseEvent,
  viewport: { width: number; height: number },
): Promise<void> {
  const found = stoppedAt(key);
  const point = pointOn(img, event, viewport);
  if (!found || found.stop.since !== since || !point) return;
  if (!stopIntents(found.worker, found.stop).includes('pick-at')) return;
  picking.delete(key);
  const answer = await send(found.run, found.worker.worker, 'pick-at', since, point);
  if (!answer) return;
  // Sent only when an editor took it; else the locator is offered to copy.
  const taken = answer.taken !== false;
  say(key, answer, since, { sent: taken, rich: true, copy: taken ? null : (answer.locator ?? null) });
  render();
}

// Where the person leaves the window, kept as it closes, is resized or loses the focus: the next one opens there.
function keepBounds(): void {
  // A maximized or full-screen window keeps the place it had before: its size is the screen's.
  if (window.outerWidth >= screen.availWidth && window.outerHeight >= screen.availHeight) return;
  const bounds = readRunsBounds({
    left: window.screenX,
    top: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight,
  });
  if (bounds) void chrome.storage.local.set({ [RUNS_BOUNDS_KEY]: bounds }).catch(() => undefined);
}
let resized: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resized);
  resized = setTimeout(keepBounds, 500);
});
window.addEventListener('blur', keepBounds);
window.addEventListener('pagehide', keepBounds);

// Resume, Step and Finish on the debuggers' keys (`stopKeyOf`), for the test whose row holds the focus, else the only
// stopped test of a hub that answers; never while a field takes the keys, nor at a held failure.
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || !state) return;
  const what = stopKeyOf(event);
  if (!what) return;
  const anyStopped = state.runs.some((run) => !run.session.ended && run.session.workers.some((w) => w.stop));
  // F5 reloads the window only while no test is stopped, a field's keys included.
  if (anyStopped) event.preventDefault();
  const field = event.target instanceof HTMLElement ? event.target.closest('input, textarea, select') : null;
  if (field) return;
  // The worker whose row holds the focus, else the only stopped worker shown: a run's tabs show one at a time.
  const shown = state.runs.map((run) => {
    const tab = tabs.get(runKeyOf(run));
    if (!tab) return run;
    const workers = run.session.workers.filter((w) => w.parallelIndex === tab.shown).slice(0, 1);
    return { ...run, session: { ...run.session, workers } };
  });
  const focused =
    document.activeElement instanceof HTMLElement
      ? (document.activeElement.closest<HTMLElement>('[data-worker]')?.dataset.worker ?? null)
      : null;
  const target = keyTargetOf(shown, focused, hubAnswers);
  if (!target) {
    // Several stopped tests shown, or only tests behind tabs not shown.
    const shownStopped = shown.some((run) => !run.session.ended && run.session.workers.some((w) => w.stop));
    if (anyStopped) announce(t(shownStopped ? 'runs_keyChoose' : 'runs_keyOtherTab'));
    return;
  }
  // A held failure ends as it failed with Resume: its button alone takes that, never a key pressed out of habit.
  if (target.failed) return;
  void control(target.run, target.worker, what, target.since);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || picking.size === 0) return;
  picking.clear();
  render();
});

// A window the person cannot see watches nothing: its views and lanes stop, and come again as it shows, the stop's Watch and
// Watch left on.
document.addEventListener('visibilitychange', () => {
  post({ type: 'shown', shown: !document.hidden });
  if (!document.hidden) {
    render();
    return;
  }
  for (const [key, view] of views) if (isLive(view)) endView(key, true);
  for (const lane of lanes.values()) if (isLive(lane)) idleLane(lane, true);
  idleCi(true);
  render();
});

// ── The run shortcut ────────────────────────────────────────────────────────────────────────────────────────────────

/** The browser's page of extension shortcuts, where the run shortcut gets its key, and in Chrome and Edge its scope. */
async function openShortcutSettings(): Promise<void> {
  // Firefox's own call opens Manage Extension Shortcuts in its add-ons manager, which no address reaches.
  const commands = chrome.commands as typeof chrome.commands & { openShortcutSettings?: () => Promise<void> };
  try {
    if (commands.openShortcutSettings) await commands.openShortcutSettings();
    else {
      const edge = /\bEdg\//.test(navigator.userAgent);
      await chrome.tabs.create({ url: edge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts' });
    }
  } catch {
    await chrome.tabs
      .create({ url: 'https://piwitests.dev/reference/keyboard-shortcuts#the-run-shortcut' })
      .catch(() => undefined);
  }
}

/** The key the run shortcut has, as last shown; null before the first read. */
let shortcutShown: string | null = null;
let shortcutButton: HTMLButtonElement | null = null;

/** Says which key the run shortcut has, or that it has none, with the button that sets it. Read again on focus. */
async function renderShortcut(): Promise<void> {
  let key: string;
  try {
    key = (await chrome.commands.getAll()).find((command) => command.name === RUN_COMMAND)?.shortcut ?? '';
  } catch {
    // No commands here: nothing to set.
    return;
  }
  if (key === shortcutShown) return;
  shortcutShown = key;
  if (key) iconText(shortcutText, 'keyboard', ...tNodes('runs_shortcutKey', { key: element('kbd', undefined, key) }));
  else iconText(shortcutText, 'keyboard', t('runs_shortcutNone'));
  const label = t(key ? 'runs_shortcutChange' : 'runs_shortcutSet');
  if (shortcutButton) setLabel(shortcutButton, label);
  else {
    shortcutButton = makeButton(label, () => void openShortcutSettings(), { icon: 'settings', small: true });
    shortcutButton.dataset.focus = 'shortcut';
    shortcutActions.append(shortcutButton);
  }
  shortcutBox.hidden = false;
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.append(...children);
  return el;
}

/** Each part drawn, by key, with the data it was drawn from. */
const drawn = new Map<string, { data: string; el: HTMLElement }>();
/** The parts the redraw under way uses: the others are dropped once it ends. */
let used = new Set<string>();

/** The part named `key`: the element drawn last while `data` is the same, else the one `draw` makes. */
function part(key: string, data: unknown, draw: () => HTMLElement): HTMLElement {
  used.add(key);
  const text = JSON.stringify(data) ?? '';
  const kept = drawn.get(key);
  if (kept?.data === text) return kept.el;
  const el = draw();
  drawn.set(key, { data: text, el });
  return el;
}

/** Puts `children` in `parent`, in their order: what goes is removed, what comes is inserted, nothing else moves. */
function place(parent: HTMLElement, children: readonly HTMLElement[]): void {
  const wanted = new Set<Element>(children);
  // A copy: the collection is live, and shrinks as a child goes.
  for (const child of Array.from(parent.children)) if (!wanted.has(child)) child.remove();
  children.forEach((child, index) => {
    const at = parent.children[index] ?? null;
    if (at !== child) parent.insertBefore(child, at);
  });
}

function showState(next: RunsState): void {
  state = next;
  // An image its hub's lost connection answered is asked again once the hub answers.
  for (const [key, image] of images) if (image.lost && hubAnswers(image.lost)) images.delete(key);
  announceChanges(next);
  render();
  document.documentElement.dataset.ready = '';
}

/** A worker as the live region last heard of it: its state, its stop, and whether an agent or this window drove it. */
interface WorkerSeen {
  state: HubWorker['state'];
  since: string | null;
  driver: 'self' | 'agent' | null;
}

/**
 * Says what changed since the last state: a test stopped or went on, a run ended, a stop taken here from the agent
 * that drove it. Nothing for the first state.
 */
function announceChanges(next: RunsState): void {
  const now = new Map<string, WorkerSeen>();
  const live = new Set<string>();
  const said: string[] = [];
  const shared = new Set<string>();
  const windows = new Set<string>();
  for (const hub of next.hubs) {
    if (!hub.connected || !hub.sharesWindow) continue;
    if (hub.windowShared) windows.add(hub.id);
    const editor = hub.client ?? t('runs_editor');
    // A window's share, turned on or off in the editor: one this window asked for says its answer.
    const asked =
      [...sharing].some((key) => key.startsWith(`${hub.id}|`)) ||
      windowStopping.has(hub.id) ||
      windowsAsked.delete(hub.id);
    if (windowsSeen && !asked && hub.windowShared !== windowsSeen.has(hub.id)) {
      said.push(t(hub.windowShared ? 'runs_announceWindowShared' : 'runs_announceWindowUnshared', { editor }));
    }
  }
  for (const run of next.runs) {
    const runKey = `${run.hub}|${run.session.ref}`;
    if (run.session.ended) {
      if (liveSeen.has(runKey)) said.push(t('runs_announceEnded', { run: runName(run.session) }));
      continue;
    }
    live.add(runKey);
    if (run.session.live?.shared) {
      shared.add(runKey);
      // Each run the editor window's share shares, as it is shared.
      if (seen && !sharedSeen.has(runKey) && windows.has(run.hub) && !sharing.has(runKey)) {
        said.push(t('runs_announceSharedWindow', { run: runName(run.session) }));
      }
    }
    for (const worker of run.session.workers) {
      const key = workerKey(run.hub, run.session.ref, worker);
      const since = worker.stop?.since ?? null;
      const driver = worker.stop?.driver;
      const drivenBy = driver?.self ? 'self' : driver?.kind === 'agent' ? 'agent' : null;
      now.set(key, { state: worker.state, since, driver: drivenBy });
      const before = seen?.get(key);
      const test = worker.test ? testName(worker.test) : runName(run.session);
      if (!seen) continue;
      if (worker.state === 'stopped' && worker.stop && before?.since !== since) {
        said.push(stopSaid(run.session, worker, worker.stop, runsSpeaker));
        // A watched lane that stops is brought into view.
        if (isWatched(lanes.get(slotKey(run.hub, run.session.ref, worker.parallelIndex)))) toView = key;
      } else if (before?.state === 'stopped' && worker.state !== 'stopped') {
        said.push(t('runs_announceRunning', { test }));
      } else if (worker.stop && before?.since === since && before.driver === 'agent' && drivenBy === 'self') {
        said.push(t('runs_announceDriveTaken', { test }));
      }
    }
  }
  seen = now;
  liveSeen = live;
  sharedSeen = shared;
  windowsSeen = windows;
  if (said.length > 0) announce(said.join(' '));
}

function announce(text: string): void {
  // Emptied first, so the same sentence twice is read twice.
  announcer.textContent = '';
  requestAnimationFrame(() => {
    announcer.textContent = text;
  });
}

function runName(session: HubSession): string {
  return runNameOf(session, runsSpeaker);
}

/** The worker whose watched lane stopped since the last drawing: brought into view once drawn. */
let toView: string | null = null;

/**
 * The window's title, which the browser's window bar and the system's window list show: what the runs ask of the
 * person first (the tests that wait for them, else the tests that failed, `attentionOf`), then the window's name.
 */
function showTitle(current: RunsState): void {
  const attention = attentionOf(current);
  const title = t('runs_title');
  document.title =
    attention?.state === 'waiting'
      ? tn('runs_titleWaiting', attention.waiting, { title })
      : attention?.state === 'failing'
        ? tn('runs_titleFailed', attention.failed, { title })
        : title;
}

function render(): void {
  if (!state) return;
  const current = state;
  showTitle(current);
  used = new Set();
  resumeLanes(current);
  renderHubs(current);
  renderEmpty(current);
  place(
    runsList,
    current.runs.map((run) => renderRun(current, run)),
  );
  renderCi(current);
  for (const key of drawn.keys()) if (!used.has(key)) drawn.delete(key);
  forgetGone(current);
  restoreFocus();
  bringIntoView();
}

/** The worker of a watched lane that stopped: scrolled to its controls when it is not wholly in view. */
function bringIntoView(): void {
  const item = toView ? drawn.get(`${toView}|item`)?.el : undefined;
  toView = null;
  if (!item?.isConnected) return;
  const { top, bottom } = item.getBoundingClientRect();
  if (top < 0 || bottom > window.innerHeight) item.scrollIntoView({ block: 'start' });
}

/**
 * Drops what is kept for a stop a worker no longer stands at: its image, its live view, its list of requests, an
 * answer for it; and the stop's Watch and the lane's for a worker whose run ended. A view whose hub's connection was lost stays
 * shown as ended while the hub is away, so the run that comes back at the same stop says so.
 */
function forgetGone(current: RunsState): void {
  /** Each live worker's stop, null while it is not stopped. */
  const at = new Map<string, string | null>();
  for (const run of current.runs) {
    if (run.session.ended) continue;
    for (const worker of run.session.workers) {
      at.set(
        workerKey(run.hub, run.session.ref, worker),
        worker.state === 'stopped' ? (worker.stop?.since ?? null) : null,
      );
    }
  }
  for (const key of images.keys()) if (!at.get(key)) images.delete(key);
  const connected = (hub: string) => current.hubs.some((h) => h.id === hub && h.connected);
  const named = (hub: string) => current.hubs.some((h) => h.id === hub);
  for (const [key, view] of views) {
    if (at.get(key) === view.since) continue;
    if (!at.has(key) && view.status === 'ended' && !connected(view.hub) && named(view.hub)) continue;
    endView(key, false);
  }
  // A slot's stop's Watch lasts while its run does: a worker Playwright starts in its place keeps it.
  const liveRuns = new Set(current.runs.filter((r) => !r.session.ended).map((r) => `${r.hub}|${r.session.ref}`));
  for (const [slot, { hub, run }] of watchLive) {
    if (!liveRuns.has(`${hub}|${run}`) && connected(hub)) watchLive.delete(slot);
  }
  for (const [slot, { hub, run }] of interacting) {
    if (!liveRuns.has(`${hub}|${run}`) && connected(hub)) interacting.delete(slot);
  }
  // Input kept for a run that ended, or a hub whose connection went (its next one drives nothing), is let go.
  for (const slot of inputAt.keys()) {
    const live = [...liveRuns].some((run) => slot.startsWith(`${run}|`));
    if (!live || !current.hubs.some((h) => h.connected && slot.startsWith(`${h.id}|`))) inputAt.delete(slot);
  }
  // A run's tabs, and why its Stop was refused, last while it does.
  for (const key of tabs.keys()) if (!liveRuns.has(key)) tabs.delete(key);
  for (const key of stopRefusals.keys()) if (!liveRuns.has(key)) stopRefusals.delete(key);
  // A lane lasts while its run does, and while its hub is named: until the hubs are first found, none is.
  for (const [slot, lane] of lanes) {
    const gone = !named(lane.hub) && current.discovery !== 'searching';
    if (gone || (!liveRuns.has(`${lane.hub}|${lane.ref}`) && connected(lane.hub))) endLane(slot, false);
  }
  for (const key of picking) if (!at.get(key)) picking.delete(key);
  for (const [key, list] of requestLists) if (at.get(key) !== list.since) requestLists.delete(key);
  for (const [key, answer] of answers) if (!at.has(key) || at.get(key) !== answer.since) answers.delete(key);
}

/**
 * One line for each paired tool: the editor's windows it follows, or why it follows none, then the desktop app's, so a
 * broken pairing of one shows beside the other's runs, with the buttons its sentence names. A tool whose state the
 * empty box says already has no line.
 */
function renderHubs(current: RunsState): void {
  const lines: HubLine[] = [];
  const editorPaired = current.discovery !== 'unpaired';
  const desktopPaired = current.desktop !== 'unpaired';
  // With no run, the empty box says the editor's state, else, with no editor paired, the desktop app's.
  const boxSays = current.runs.length === 0 ? (editorPaired ? 'editor' : 'desktop') : null;
  if (editorPaired) {
    const line = editorLine(current);
    if (!(boxSays === 'editor' && line.boxed)) lines.push(line);
    // Each editor window that shares its runs until the person stops says so, with its stop, whether or not a run is
    // listed.
    for (const hub of current.hubs) {
      if (!hub.connected || !hub.windowShared) continue;
      const editor = hub.client ?? t('runs_editor');
      lines.push({
        icon: 'eye',
        text: t('runs_windowShared', { editor }),
        boxed: false,
        actions: [],
        stopWindow: {
          hub: hub.id,
          asking: windowStopAsking.has(hub.id),
          waiting: windowStopping.has(hub.id),
          refusal: windowStopRefusals.get(hub.id) ?? null,
        },
      });
    }
  }
  if (desktopPaired) {
    const line = desktopLine(current);
    if (!(boxSays === 'desktop' && line.boxed)) lines.push(line);
  }
  hubsLine.hidden = lines.length === 0;
  const shown = JSON.stringify([lines, looking]);
  if (shown === hubsShown) return;
  hubsShown = shown;
  hubsLine.replaceChildren(
    ...lines.flatMap(({ icon, text, actions, stopWindow }, index) => {
      const line = iconText(element('p'), icon, text);
      line.classList.toggle('waiting', icon !== 'check-circle' && icon !== 'eye');
      for (const action of actions) line.append(emptyActionButton(action, `hubs|${index}|${action}`));
      return stopWindow ? [line, renderStopWindow(stopWindow)] : [line];
    }),
  );
}

/** A window's share, on the hubs line: Stop sharing this window's runs, asked first, and why it was refused. */
function renderStopWindow({ hub, asking, waiting, refusal }: NonNullable<HubLine['stopWindow']>): HTMLElement {
  const box = element('div', 'hub-share');
  const row = element('div', 'piwi-actions');
  const button = (label: string, onClick: () => void, focus: string, options: Parameters<typeof makeButton>[2]) => {
    const made = makeButton(label, onClick, options);
    made.dataset.focus = `hubs|${hub}|${focus}`;
    if (waiting) made.setAttribute('aria-disabled', 'true');
    row.append(made);
  };
  if (asking) {
    const question = element('p', 'share-warning', t('runs_stopSharingWindowAsk'));
    question.id = `stop-window-${++headings}`;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('runs_stopSharingWindow'));
    box.setAttribute('aria-describedby', question.id);
    box.append(question);
    button(t('runs_stopSharing'), () => askStopWindow(hub, true), 'stop-window-yes', {
      icon: 'eye-off',
      tone: 'danger',
    });
    button(t('common_cancel'), () => askStopWindow(hub, false), 'stop-window-no', { icon: 'close' });
  } else {
    button(t('runs_stopSharingWindow'), () => askStopWindow(hub, null), 'stop-window', {
      icon: 'eye-off',
      title: t('runs_stopSharingWindowTitle'),
    });
  }
  box.append(row);
  if (refusal) box.append(iconText(element('p', 'note'), 'info', refusal));
  return box;
}

/** A status line: its icon and sentence, whether the empty box says the same, and the buttons the sentence names. */
interface HubLine {
  icon: IconName;
  text: string;
  boxed: boolean;
  actions: EmptyAction[];
  /** For an editor window that shares its runs: its hub, and where its Stop sharing this window's runs stands. */
  stopWindow?: { hub: string; asking: boolean; waiting: boolean; refusal: string | null };
}

/** The status lines as last drawn. */
let hubsShown = '';

/** The editor's line. */
function editorLine(current: RunsState): HubLine {
  const hubs = current.hubs.filter((hub) => !hub.desktop);
  const connected = hubs.filter((hub) => hub.connected).length;
  if (connected > 0) return { icon: 'check-circle', text: tn('runs_following', connected), boxed: false, actions: [] };
  // The window follows the editor while any of its windows answers: one that does not is found again meanwhile.
  if (hubs.length > 0 && current.discovery !== 'searching') {
    const editor = hubs[0]!.client ?? t('runs_editor');
    return { icon: 'clock', text: t('runs_reconnecting', { editor }), boxed: false, actions: [] };
  }
  const [icon, text, actions] = editorEmptyOf(current);
  return { icon, text, boxed: true, actions };
}

/** The desktop app's line, as the editor's. */
function desktopLine(current: RunsState): HubLine {
  const hub = current.hubs.find((h) => h.desktop);
  if (hub?.connected) return { icon: 'check-circle', text: t('runs_followingDesktop'), boxed: false, actions: [] };
  if (hub) {
    return {
      icon: 'clock',
      text: t('runs_reconnecting', { editor: t('runs_desktopName') }),
      boxed: false,
      actions: [],
    };
  }
  const [icon, text, actions] = desktopEmptyOf(current);
  return { icon, text, boxed: true, actions };
}

type EmptyAction = 'settings' | 'again';

/**
 * Why there is nothing to show, and what to do: its icon, its sentence and its buttons. While no editor is paired, the
 * paired desktop app's answer says it.
 */
function emptyOf(current: RunsState): [IconName, string, EmptyAction[]] {
  if (current.discovery === 'unpaired' && current.desktop !== 'unpaired') return desktopEmptyOf(current);
  return editorEmptyOf(current);
}

/** Why the paired editor shows no run, and what to do. */
function editorEmptyOf(current: RunsState): [IconName, string, EmptyAction[]] {
  switch (current.discovery) {
    case 'searching':
      return ['clock', t('runs_statusSearching'), []];
    case 'unpaired':
      return ['link', t('runs_statusUnpaired'), ['settings']];
    case 'no-access':
      return ['lock', t('runs_statusNoAccess'), ['settings']];
    case 'refused':
      // Paired again at the same address, the worker hears it; Look again asks at once.
      return ['alert', t('runs_statusRefused'), ['settings', 'again']];
    case 'unreachable':
      return ['plug', t('runs_statusUnreachable'), ['again']];
    case 'outdated':
      return ['alert', t('runs_statusOutdated'), ['again']];
    case 'unproven':
      // An editor that moved to another port is paired again from the settings, at its new address.
      return ['alert', t('runs_statusUnproven'), ['settings', 'again']];
    case 'not-editor':
      return ['alert', t('runs_statusNotEditor'), ['settings', 'again']];
    default:
      if (current.hubs.length === 0) return ['plug', t('runs_statusNoHub'), ['again']];
      if (!current.hubs.some((hub) => hub.connected)) return ['clock', t('runs_statusSearching'), []];
      return ['play', t('runs_statusNoRuns'), []];
  }
}

/** Why the paired desktop app shows no run, and what to do. */
function desktopEmptyOf(current: RunsState): [IconName, string, EmptyAction[]] {
  switch (current.desktop) {
    case 'no-access':
      return ['lock', t('runs_statusDesktopNoAccess'), ['settings']];
    case 'refused':
      return ['alert', t('runs_statusDesktopRefused'), ['settings', 'again']];
    case 'unreachable':
      return ['plug', t('runs_statusDesktopUnreachable'), ['again']];
    case 'outdated':
      return ['alert', t('runs_statusDesktopOutdated'), ['again']];
    case 'unproven':
      return ['alert', t('runs_statusDesktopUnproven'), ['again']];
    default:
      if (!current.hubs.some((hub) => hub.connected)) return ['clock', t('runs_statusDesktopSearching'), []];
      return ['play', t('runs_statusDesktopNoRuns'), []];
  }
}

/** What the empty box shows, as last drawn. */
let emptyShown = '';

function renderEmpty(current: RunsState): void {
  empty.hidden = current.runs.length > 0;
  if (empty.hidden) return;
  const [icon, text, actions] = emptyOf(current);
  const shown = JSON.stringify([icon, text, actions, looking]);
  if (shown === emptyShown) return;
  emptyShown = shown;
  iconText(emptyText, icon, text);
  emptyActions.replaceChildren(...actions.map((action) => emptyActionButton(action, `empty|${action}`)));
}

/**
 * Look again is asking the editor and the desktop app for their hubs: its buttons say so until the worker says it found
 * them (`found`), `LOOKING_SHOWN_MS` at least so the word can be read, `LOOKING_MAX_MS` at most.
 */
let looking = false;
let lookingSince = 0;
let lookingEnd: ReturnType<typeof setTimeout> | undefined;
const LOOKING_SHOWN_MS = 600;
const LOOKING_MAX_MS = 15_000;

function stopLooking(): void {
  if (!looking) return;
  clearTimeout(lookingEnd);
  lookingEnd = setTimeout(
    () => {
      looking = false;
      render();
    },
    Math.max(0, lookingSince + LOOKING_SHOWN_MS - Date.now()),
  );
}

/** Look again: the worker asks for the hubs again, and the buttons say it looks, then show what it found. */
function lookAgain(): void {
  if (looking) return;
  looking = true;
  lookingSince = Date.now();
  post({ type: 'find' });
  announce(t('runs_looking'));
  render();
  clearTimeout(lookingEnd);
  lookingEnd = setTimeout(stopLooking, LOOKING_MAX_MS);
}

/** Open the settings, or Look again: a button the empty box or a status line shows, named for the focus by `focus`. */
function emptyActionButton(action: EmptyAction, focus: string): HTMLButtonElement {
  const button =
    action === 'settings'
      ? makeButton(t('runs_openSettings'), () => void chrome.runtime.openOptionsPage(), { icon: 'settings' })
      : makeButton(
          t(looking ? 'runs_looking' : 'runs_findAgain'),
          (event) => {
            if (!pressedHeld(event)) lookAgain();
          },
          { icon: 'refresh' },
        );
  if (action !== 'settings' && looking) unavailable(button);
  button.dataset.focus = focus;
  return button;
}

/** The ids of the runs' headings, one per run drawn. */
let headings = 0;

function renderRun(current: RunsState, run: RunsRun): HTMLElement {
  const { session } = run;
  const runKey = `${run.hub}|${session.ref}`;
  const section = part(`${runKey}|run`, null, () => {
    const made = element('section', 'run');
    made.setAttribute('aria-labelledby', `run-${++headings}`);
    return made;
  });
  section.classList.toggle('ended', session.ended);
  const headingId = section.getAttribute('aria-labelledby') ?? '';
  const name = runName(session);
  const hub = current.hubs.find((h) => h.id === run.hub);
  const client = hub?.desktop ? t('runs_desktopApp') : (hub?.client ?? null);
  // A live run of a hub whose connection was lost shows as last heard, grayed, until the hub answers again.
  const away = !session.ended && !hub?.connected;
  section.classList.toggle('away', away);
  const children = [
    part(
      `${runKey}|head`,
      { headingId, name, client, command: session.command, terminal: session.terminal, runner: session.runner },
      () => {
        const heading = element('h2', undefined, name);
        heading.id = headingId;
        const title = element('div', 'run-title', heading);
        if (client) title.append(element('span', 'client', client));
        // A run the editor did not start: in a terminal, or by the editor's own test runner.
        if (session.terminal) {
          const [mark, words] = session.runner
            ? (['list', 'runs_runner'] as const)
            : (['terminal', 'runs_terminal'] as const);
          title.append(iconText(element('span', 'client terminal'), mark, t(words)));
        }
        const head = element('div', 'run-head', title);
        if (session.command) {
          const code = element('code', 'command', session.command);
          code.title = session.command;
          head.append(code);
        }
        return head;
      },
    ),
  ];
  if (session.page) {
    const page = session.page;
    children.push(part(`${runKey}|page`, [page.id, page.url], () => renderRunPage(page)));
  }
  if (session.progress) {
    const { total, done, failed, flaky } = session.progress;
    const ended = endedAtStopOf(session.progress);
    children.push(
      part(`${runKey}|progress`, [total, done, failed, flaky, ended], () => renderProgress(session.progress!)),
    );
  }
  // Who else has the run open, from a hub that says so, while the run goes on and its hub is connected.
  const present = session.ended || away ? null : presenceLine(session.presence, runsSpeaker);
  if (present) {
    children.push(
      part(`${runKey}|presence`, present, () => iconText(element('p', 'run-presence'), 'monitor', present)),
    );
  }
  // One row under the name: Hold failures, from a hub that keeps it for each run, Pause all or Resume all, for a run of
  // several workers, and Stop the run, from a hub that stops it, while the run goes on and its hub is connected.
  const holds = session.hold && !session.ended && !away ? session.hold : null;
  const level = away ? null : runLevelControls(run.session);
  const levelShown = !!level && (level.pauseAll || level.resumeAll.length > 0);
  const stoppable = !away && !!hub?.stops && canStopRun(session);
  if (holds || levelShown || stoppable) {
    // Each drawn again only when what it shows changes, so the other's buttons stay the same elements.
    const bar = part(`${runKey}|bar`, null, () => element('div', 'run-bar'));
    const items: HTMLElement[] = [];
    if (holds) {
      const { on, by } = holds;
      const asking = holding.has(runKey);
      const refusal = holdRefusals.get(runKey) ?? null;
      items.push(part(`${runKey}|hold`, [on, by, asking, refusal], () => renderHold(run, on, by)));
    }
    if (levelShown) {
      const resumed = level!.resumeAll.map((c) => c.since).join('|');
      items.push(
        part(`${runKey}|all`, [level!.pauseAll, resumed, runBusy.has(runKey)], () => renderRunControls(run, level!)),
      );
    }
    if (stoppable) items.push(part(`${runKey}|stop`, stopping.has(runKey), () => renderStopRun(run)));
    place(bar, items);
    children.push(bar);
    // Why its Stop was refused, under the row.
    const refused = stoppable ? stopRefusals.get(runKey) : undefined;
    if (refused) {
      children.push(
        part(`${runKey}|stop-refused`, refused, () =>
          iconText(element('p', 'note run-note stop-refused'), 'info', refused),
        ),
      );
    }
  }
  // A run that cannot be shared says why under its workers, after what steers it.
  const refused = session.ended ? null : (session.live?.refused ?? null);
  if (session.ended) {
    const progress = session.progress ?? null;
    const failure = progress?.status === 'failed' ? progress.failure : null;
    children.push(
      part(`${runKey}|ended`, [progress?.status ?? null, failure?.title ?? null, failure?.error ?? null], () =>
        renderEnded(progress),
      ),
    );
  } else if (away) {
    const editor = hub?.desktop ? t('runs_desktopName') : (hub?.client ?? t('runs_editor'));
    children.push(
      part(`${runKey}|away`, editor, () =>
        iconText(element('p', 'note run-note run-away'), 'clock', t('runs_runAway', { editor })),
      ),
    );
  } else if (session.live && !refused) {
    children.push(renderShare(run, session.live, hub));
  }
  const workers = [...session.workers].sort((a, b) => a.parallelIndex - b.parallelIndex);
  // A live run of several workers shows one at a time, behind a tab for each.
  const tab = session.ended ? null : tabsAfter(tabs.get(runKey), workers, (w) => watchingWorker(run, w));
  if (tab) {
    tabs.set(runKey, tab);
    children.push(renderWorkerTabs(run, workers, tab.shown));
  } else tabs.delete(runKey);
  if (workers.length > 0) {
    const list = part(`${runKey}|workers`, null, () => element('ul', 'workers'));
    const listed = tab ? workers.filter((w) => w.parallelIndex === tab.shown).slice(0, 1) : workers;
    place(
      list,
      listed.map((worker) => renderWorker(run, hub, worker, away)),
    );
    if (tab) {
      // The tab panel holds the list of the one worker shown, named by its tab.
      const id = domId('workers', runKey);
      const panel = part(`${runKey}|panel`, id, () => {
        const made = element('div', 'worker-panel');
        made.id = id;
        made.setAttribute('role', 'tabpanel');
        return made;
      });
      panel.setAttribute('aria-labelledby', `${id}-tab-${tab.shown}`);
      place(panel, [list]);
      children.push(panel);
    } else children.push(list);
  }
  const hint = pageHintOf(run, hub);
  if (hint) {
    const words = hint === 'desktop' ? 'runs_pageAtStopDesktop' : 'runs_pageAtStop';
    children.push(
      part(`${runKey}|page-hint`, words, () => iconText(element('p', 'note run-note page-hint'), 'info', t(words))),
    );
  }
  if (refused) {
    children.push(
      part(`${runKey}|share-refused`, refused, () =>
        iconText(element('p', 'note run-note share-refused'), 'info', refusalText(refused)),
      ),
    );
  }
  place(section, children);
  return section;
}

/**
 * The CI runs in progress the connected instance lists, under the runs the hubs follow, read-only: each named as other
 * runs are, where it runs, its page (`Run #78`, **Open** and **Copy**), its tally and the tests it runs now, each with
 * **Watch** where its lanes can be watched and **Watch on the dashboard**, then one line saying nothing here steers
 * them. None without connected mode.
 */
function renderCi(current: RunsState): void {
  const runs = current.ci ?? [];
  // A watch of a run no longer listed ends: the worker said why, or the run ended.
  if (ciView && !runs.some((run) => run.id === ciView!.runId)) ciView = null;
  if (ciView?.status === 'idle' && !document.hidden && port) askCi(ciView);
  ciBox.hidden = runs.length === 0;
  if (!runs.length) {
    place(ciBox, []);
    return;
  }
  const several = new Set(runs.map((run) => run.projectId)).size > 1;
  place(ciBox, [
    part('ci|heading', null, () => element('h2', 'ci-heading', runsSpeaker.say('runs_ciHeading'))),
    ...runs.map((run) => renderCiRun(run, several)),
    part('ci|note', null, () => iconText(element('p', 'note ci-note'), 'info', runsSpeaker.say(CI_READ_ONLY.key))),
  ]);
}

/**
 * A CI run in progress: its name, where it runs, its page, its tally, and the tests it runs now with **Watch** and
 * **Watch on the dashboard**; the lane watched under them. No control, since it runs on CI.
 */
function renderCiRun(run: RunsCiRun, several: boolean): HTMLElement {
  const key = `ci|${run.url}`;
  const section = part(key, null, () => {
    const made = element('section', 'run ci-run');
    made.setAttribute('aria-labelledby', domId('ci', run.url));
    return made;
  });
  const where = ciRunWhere(run, several);
  const children = [
    part(`${key}|head`, [run.id, where], () => {
      const name = element('h2', undefined, ciRunName(run, runsSpeaker));
      name.id = domId('ci', run.url);
      const title = element('div', 'run-title', name);
      if (where) title.append(element('span', 'client', runsSpeaker.say(where.key, where.args)));
      return element('div', 'run-head', title);
    }),
    part(`${key}|page`, [run.id, run.url], () => renderRunPage({ id: run.id, url: run.url })),
    part(`${key}|progress`, [run.total, run.done, run.failed, run.flaky], () =>
      renderProgress({
        total: run.total,
        done: run.done,
        failed: run.failed,
        flaky: run.flaky,
        skipped: 0,
        status: 'running',
        failure: null,
      }),
    ),
  ];
  if (run.tests.length) {
    const list = part(`${key}|tests`, null, () => {
      const made = element('ul', 'ci-tests');
      made.setAttribute('aria-label', t('runs_ciTests'));
      return made;
    });
    place(
      list,
      run.tests.map((test) => {
        const lane: RunsCiLane = { runId: run.id, shard: test.shard, lane: test.lane };
        const watched = !!ciView && ciLaneKey(ciView) === ciLaneKey(lane) && ciView.status !== 'ended';
        return part(`${key}|test|${ciLaneKey(lane)}`, [test, run.watchable, watched], () =>
          renderCiTest(run, test, lane, watched),
        );
      }),
    );
    children.push(list);
  }
  if (!run.watchable && run.tests.length) {
    children.push(
      part(`${key}|unwatchable`, null, () =>
        iconText(element('p', 'note run-note'), 'info', t('runs_ciRefusedUnwatchable')),
      ),
    );
  }
  if (ciView?.runId === run.id) children.push(renderCiView(run, ciView));
  place(section, children);
  return section;
}

/** `Worker 2`, or `Shard 1, worker 2`: a CI lane as the window names it, its worker counted from 1. */
function ciLaneName(lane: Pick<RunsCiLane, 'shard' | 'lane'>): string {
  const worker = String(lane.lane + 1);
  return lane.shard !== null
    ? t('runs_ciShardWorker', { shard: String(lane.shard), worker })
    : t('runs_ciWorker', { worker });
}

/** A test a CI run runs now: its lane, its title, **Watch** where the run's lanes can be watched, and the dashboard's. */
function renderCiTest(run: RunsCiRun, test: RunsCiTest, lane: RunsCiLane, watched: boolean): HTMLElement {
  const item = element(
    'li',
    'ci-test',
    element('span', 'ci-lane', ciLaneName(test)),
    element('span', 'ci-title', test.title),
  );
  const actions = element('div', 'piwi-actions');
  const focus = `ci|${ciLaneKey(lane)}`;
  if (run.watchable) {
    const watch = makeButton(t('runs_watch'), () => toggleCi(lane), {
      icon: 'eye',
      small: true,
      title: t('runs_ciWatchTitle'),
    });
    watch.setAttribute('aria-pressed', String(watched));
    watch.dataset.focus = `${focus}|watch`;
    actions.append(watch);
  }
  const dashboard = makeButton(
    t('runs_ciWatchDashboard'),
    () => void chrome.tabs.create({ url: ciDashboardWatch(run, lane) }),
    { icon: 'external', small: true, tone: 'ghost', title: t('runs_ciWatchDashboardTitle') },
  );
  dashboard.dataset.focus = `${focus}|dashboard`;
  actions.append(dashboard);
  item.append(actions);
  return item;
}

/** The CI lane watched: its images, read-only, under a **Live** badge; why it ended or sends none, with the dashboard's. */
function renderCiView(run: RunsCiRun, view: CiView): HTMLElement {
  const key = `ci|${ciLaneKey(view)}|view`;
  const figure = part(key, null, () => element('figure', 'page ci-view'));
  const caption = part(`${key}|caption`, [view.test, view.call, view.lane, view.shard], () => {
    const made = element('figcaption', 'page-head', element('span', 'ci-lane', ciLaneName(view)));
    if (view.test) made.append(element('span', 'ci-title', view.test));
    if (view.call) made.append(element('span', 'ci-call', ...richText(view.call)));
    return made;
  });
  const children: HTMLElement[] = [caption];
  const live = view.status === 'on' && !view.refused && view.shown;
  if (view.shown) {
    view.img.classList.toggle('stale', !live);
    view.img.alt = t('runs_ciLiveAlt');
    const box = part(`${key}|frame`, null, () => element('div', 'page-frame'));
    place(box, live ? [view.img, part(`${key}|badge`, null, liveBadge)] : [view.img]);
    children.push(box);
  }
  const note =
    view.status === 'ended' || view.status === 'refused'
      ? { icon: 'alert' as const, text: view.note }
      : view.refused
        ? { icon: 'alert' as const, text: view.refused }
        : !view.shown
          ? { icon: 'clock' as const, text: t('runs_liveStarting') }
          : null;
  if (note) children.push(pageNotePart(key, note, !view.shown));
  if (view.status === 'ended' || view.status === 'refused') {
    children.push(
      part(`${key}|again`, [view.status, view.note], () => {
        const line = element('div', 'piwi-actions');
        const dashboard = makeButton(
          t('runs_ciWatchDashboard'),
          () => void chrome.tabs.create({ url: ciDashboardWatch(run, view) }),
          { icon: 'external', small: true, title: t('runs_ciWatchDashboardTitle') },
        );
        dashboard.dataset.focus = `ci|${ciLaneKey(view)}|ended-dashboard`;
        line.append(dashboard);
        return line;
      }),
    );
  }
  place(figure, children);
  return figure;
}

/** The run's page on the instance, as its own process named it: `Run #77`, **Open** and **Copy**, ended or not. */
function renderRunPage(page: { id: number; url: string }): HTMLElement {
  const line = element(
    'div',
    'run-page piwi-actions',
    element('span', 'run-number', t('runs_runNumber', { id: String(page.id) })),
  );
  const open = makeButton(t('runs_openRunPage'), () => void chrome.tabs.create({ url: page.url }), {
    icon: 'external',
    small: true,
    title: page.url,
  });
  const copy = makeButton(t('runs_copyRunPageShort'), () => void copyWithFeedback(page.url, copy), {
    icon: 'copy',
    small: true,
    title: t('runs_copyRunPage'),
  });
  line.append(open, copy);
  return line;
}

/**
 * **Hold failures**: a toggle saying whether a failed test no pause bar shows waits at its line in the run, the run's
 * own whichever surface set it; held while the hub answers, and saying when an agent set it.
 */
function renderHold(run: RunsRun, on: boolean, by: 'start' | 'person' | 'agent'): HTMLElement {
  const row = element('div', 'run-hold piwi-actions');
  const toggle = makeButton(t('runs_holdFailures'), () => void hold(run, !on), {
    icon: 'pause',
    small: true,
    title: t(on ? 'runs_holdFailuresOn' : 'runs_holdFailuresOff'),
  });
  toggle.setAttribute('aria-pressed', String(on));
  toggle.dataset.focus = `${runKeyOf(run)}|hold`;
  if (holding.has(runKeyOf(run))) unavailable(toggle);
  row.append(toggle);
  if (by === 'agent') row.append(element('span', 'hold-by', t('runs_holdByAgent')));
  const refusal = holdRefusals.get(runKeyOf(run));
  if (!refusal) return row;
  const box = element('div', 'run-hold-box');
  box.append(row, iconText(element('p', 'note run-note hold-refused'), 'info', refusal));
  return box;
}

/** A live run's tabs, by run (`runKeyOf`), while it has several workers (`tabsAfter`). */
const tabs = new Map<string, WorkerTabs>();

/** The person chooses a worker's tab, by its lane. */
function chooseTab(runKey: string, lane: number): void {
  const tab = tabs.get(runKey);
  if (tab) tabs.set(runKey, tabsChosen(tab, lane));
  focusKey = `${runKey}|tab|${lane}`;
  render();
}

/** Resume or End the test at the stop `since` of the worker a run's tabs show: the next stopped test takes the tab. */
function advanceTab(run: RunsRun, worker: number, since: string | null): void {
  const runKey = runKeyOf(run);
  const tab = tabs.get(runKey);
  const lane = run.session.workers.find((w) => w.worker === worker)?.parallelIndex;
  if (tab && lane !== undefined) tabs.set(runKey, tabsAdvanced(tab, lane, since));
}

/** An element id of the window's own, for `prefix` and a key: the same for the same key. */
function domId(prefix: string, key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

/** Whether the window watches a worker's page now: its stop's live view, or its lane. */
function watchingWorker(run: RunsRun, worker: HubWorker): boolean {
  return (
    isLive(views.get(workerKey(run.hub, run.session.ref, worker))) ||
    isLive(lanes.get(slotKey(run.hub, run.session.ref, worker.parallelIndex)))
  );
}

/**
 * A run's workers as tabs, by lane, one shown at a time (`shownLaneOf`): each names its worker and marks its state in
 * its tone (`tabStatus`, `data-status`). The arrow keys, Home and End move between them. Each tab is drawn again only when its own
 * state changes.
 */
function renderWorkerTabs(run: RunsRun, workers: readonly HubWorker[], shown: number | null): HTMLElement {
  const runKey = runKeyOf(run);
  const panel = domId('workers', runKey);
  const list = part(`${runKey}|tabs`, null, () => {
    const made = element('div', 'worker-tabs');
    made.setAttribute('role', 'tablist');
    made.setAttribute('aria-label', t('runs_workerTabs'));
    return made;
  });
  const items = workers.map((worker) => {
    const lane = worker.parallelIndex;
    const status = tabStatus(worker);
    const state = { icon: status.icon, words: runsSpeaker.say(status.message.key, status.message.args) };
    const tone = status.tone;
    const selected = lane === shown;
    return part(`${runKey}|tab|${lane}`, [state, tone, selected], () => {
      const tab = makeButton(t('runs_worker', { number: lane + 1 }), () => chooseTab(runKey, lane), {
        icon: state.icon,
        small: true,
        tone: 'ghost',
        title: state.words,
      });
      tab.id = `${panel}-tab-${lane}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selected));
      tab.setAttribute('aria-controls', panel);
      tab.tabIndex = selected ? 0 : -1;
      tab.dataset.focus = `${runKey}|tab|${lane}`;
      tab.dataset.lane = String(lane);
      tab.dataset.status = tone;
      tab.addEventListener('keydown', (event) => {
        const all = [...(tab.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
        const index = all.indexOf(tab);
        const to =
          event.key === 'ArrowRight'
            ? (index + 1) % all.length
            : event.key === 'ArrowLeft'
              ? (index - 1 + all.length) % all.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? all.length - 1
                  : null;
        if (to === null || index < 0) return;
        event.preventDefault();
        chooseTab(runKey, Number(all[to]!.dataset.lane));
      });
      return tab;
    });
  });
  place(list, items);
  return list;
}

/** The runs whose Pause all or Resume all is on its way: their buttons wait for the answers. */
const runBusy = new Set<string>();

/**
 * A run's own controls (`runLevelControls`): Resume all, each stopped test at the stop it stands at, and Pause all,
 * each worker before its next call. A refusal is read out.
 */
function renderRunControls(run: RunsRun, level: ReturnType<typeof runLevelControls>): HTMLElement {
  const key = runKeyOf(run);
  const row = element('div', 'run-controls piwi-actions');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', t('runs_runControls'));
  const act = async (
    commands: ReadonlyArray<{ worker: number | null; what: 'pause' | 'resume'; since: string | null }>,
  ) => {
    if (runBusy.has(key) || !hubAnswers(run.hub)) return;
    // Each worker a command names waits for it too, as its own buttons and keys would.
    const workers = commands.flatMap((c) =>
      c.worker === null ? [] : [workerKey(run.hub, run.session.ref, { worker: c.worker })],
    );
    if (workers.some((worker) => busy.has(worker))) return;
    runBusy.add(key);
    for (const worker of workers) busy.add(worker);
    render();
    const said = await Promise.all(commands.map((c) => command(run.hub, run.session.ref, c.worker, c.what, c.since)));
    runBusy.delete(key);
    for (const worker of workers) busy.delete(worker);
    const refused = said.find((answer) => !answer.ok);
    if (refused) announce(failureText(refused, run.hub));
    render();
  };
  const buttons: HTMLButtonElement[] = [];
  if (level.resumeAll.length > 0) {
    const resume = makeButton(
      t('runs_resumeAll'),
      (event) => {
        if (!pressedHeld(event))
          void act(level.resumeAll.map((c) => ({ worker: c.worker, what: 'resume', since: c.since })));
      },
      { icon: 'play', small: true, title: t('runs_resumeAllTitle') },
    );
    resume.dataset.focus = `${key}|resume-all`;
    buttons.push(resume);
  }
  if (level.pauseAll) {
    const pause = makeButton(
      t('runs_pauseAll'),
      (event) => {
        if (!pressedHeld(event)) void act([{ worker: null, what: 'pause', since: null }]);
      },
      { icon: 'pause', small: true, title: t('runs_pauseAllTitle') },
    );
    pause.dataset.focus = `${key}|pause-all`;
    buttons.push(pause);
  }
  if (runBusy.has(key)) for (const button of buttons) unavailable(button);
  row.append(...buttons);
  return row;
}

/** The runs whose Stop is on its way: its button waits for the answer. */
const stopping = new Set<string>();
/** Why a run's Stop was refused, by run: shown under its row until the next Stop. */
const stopRefusals = new Map<string, string>();

/**
 * Stop the run, as its own Stop does where it was started, through its hub (`stop`): the button below the run's name,
 * apart from its other controls. The hub's answer is read out; the run's end follows in its session.
 */
function renderStopRun(run: RunsRun): HTMLElement {
  const key = runKeyOf(run);
  const stop = makeButton(
    t('runs_stopRun'),
    async (event) => {
      if (pressedHeld(event) || stopping.has(key) || !hubAnswers(run.hub)) return;
      stopping.add(key);
      stopRefusals.delete(key);
      render();
      const answer = await command(run.hub, run.session.ref, null, 'stop', null);
      stopping.delete(key);
      if (!answer.ok) stopRefusals.set(key, failureText(answer, run.hub));
      announce(answer.ok ? answer.message : failureText(answer, run.hub));
      render();
    },
    { icon: 'stop', small: true, tone: 'remove', title: t('runs_stopRunTitle') },
  );
  stop.classList.add('run-stop');
  stop.dataset.focus = `${key}|stop-run`;
  if (stopping.has(key)) unavailable(stop);
  return stop;
}

/**
 * Turn a run's Hold failures on or off, unless a turn of it is on its way: the hub's answer is read out, and a refusal
 * shown under the toggle.
 */
async function hold(run: RunsRun, on: boolean): Promise<void> {
  const key = runKeyOf(run);
  if (holding.has(key)) return;
  holding.add(key);
  holdRefusals.delete(key);
  render();
  const answer = await command(run.hub, run.session.ref, null, 'hold', null, { on });
  holding.delete(key);
  const text = answer.ok ? answer.message : failureText(answer, run.hub);
  if (!answer.ok && text) holdRefusals.set(key, text);
  if (text) announce(text);
  render();
}

/**
 * How far a run is, under its name: how many of its tests ended, of all it holds, and how many failed, were flaky or
 * were ended at a stop (skipped, marked so).
 */
function renderProgress(progress: HubProgress): HTMLElement {
  const line = element('p', 'run-progress', tn('runs_progress', progress.total, { done: progress.done }));
  if (progress.failed > 0) line.append(' · ', element('span', 'failed', tn('runs_progressFailed', progress.failed)));
  if (progress.flaky > 0) line.append(' · ', element('span', 'flaky', tn('runs_progressFlaky', progress.flaky)));
  const endedAtStop = endedAtStopWords(endedAtStopOf(progress), runsSpeaker);
  if (endedAtStop) line.append(' · ', element('span', 'ended-at-stop', endedAtStop));
  return line;
}

/** How a run ended, with the icon and words of its status: just that it ended when its reporter does not say. */
const ENDINGS = {
  passed: ['check-circle', 'runs_endedPassed'],
  failed: ['x-circle', 'runs_endedFailed'],
  timedout: ['clock', 'runs_endedTimedOut'],
  interrupted: ['stop', 'runs_endedInterrupted'],
} as const satisfies Partial<Record<HubProgress['status'], readonly [IconName, string]>>;

/** The line of a run that ended: how, as its own process said, and its first failure's title, its error as the tip. */
function renderEnded(progress: HubProgress | null): HTMLElement {
  const status = progress?.status ?? 'other';
  const [mark, words] =
    status in ENDINGS ? ENDINGS[status as keyof typeof ENDINGS] : (['check-circle', 'runs_ended'] as const);
  const note = iconText(element('p', `run-ended ${status}`), mark, t(words));
  const failure = status === 'failed' ? (progress?.failure ?? null) : null;
  if (failure) {
    const first = element('span', 'first-failure', t('runs_firstFailure', { title: failure.title }));
    if (failure.error) first.title = failure.error;
    note.lastElementChild?.append(' ', first);
  }
  return note;
}

/** What the window says of a run that cannot be shared live, by why the reporter gave it no key. */
const SHARE_REFUSALS = {
  'no-instance': 'runs_shareRefusedNoInstance',
  'streaming-off': 'runs_shareRefusedStreamingOff',
  unregistered: 'runs_shareRefusedUnregistered',
  'setup-failed': 'runs_shareRefusedSetupFailed',
  off: 'runs_shareRefusedOff',
  local: 'runs_shareRefusedLocal',
  unknown: 'runs_shareRefusedUnknown',
} as const satisfies Record<NonNullable<ReturnType<typeof shareRefusalOf>>, string>;

/** Why a run cannot be shared live, in the window's language when the reporter's reason is known, else as the hub said. */
function refusalText(refused: string): string {
  const why = shareRefusalOf(refused);
  return why ? t(SHARE_REFUSALS[why]) : refused;
}

/** The instance a run's page is on, as the window names it (its host); the words for any instance without one. */
function instanceOf(live: Pick<HubLive, 'page'>): string {
  try {
    return (live.page && new URL(live.page).host) || t('runs_shareInstance');
  } catch {
    return t('runs_shareInstance');
  }
}

/**
 * A run's Share live, under its heading: shared, where and how many views are open, its page's link and Stop sharing;
 * asked, what it sends and to whom, with Share live and Cancel; else Share live. A refusal shows under it, else why
 * the sharing stopped though nobody asked.
 */
function renderShare(run: RunsRun, live: HubLive, hub: RunsHub | undefined): HTMLElement {
  const key = runKeyOf(run);
  const asking = shareAsking.has(key);
  const waiting = sharing.has(key);
  const refusal = shareRefusals.get(key) ?? null;
  // The hub shares its editor window's runs: offered beside the run's own, and while on, said under the run, whose Stop
  // sharing stops it alone (the hubs line stops the window's).
  const offersWindow = !!hub?.sharesWindow;
  const byWindow = offersWindow && !!hub?.windowShared;
  const stopping = live.shared && stopAsking.has(key);
  if (!live.shared) stopAsking.delete(key);
  return part(`${key}|share`, { live, asking, waiting, refusal, offersWindow, byWindow, stopping }, () => {
    const box = element('div', 'run-share');
    const row = element('div', 'piwi-actions');
    const button = (label: string, onClick: () => void, focus: string, options: Parameters<typeof makeButton>[2]) => {
      const made = makeButton(label, onClick, options);
      made.dataset.focus = `${key}|${focus}`;
      if (waiting) made.setAttribute('aria-disabled', 'true');
      row.append(made);
      return made;
    };
    if (live.shared) {
      const watching = live.viewers === 0 ? t('runs_sharedNobody') : tn('runs_sharedViews', live.viewers);
      box.append(
        iconText(
          element('p', 'shared'),
          'eye',
          `${t('runs_sharedLive', { instance: instanceOf(live) })} · ${watching}`,
        ),
      );
      // A run that names its page offers it above, ended or not.
      const page = run.session.page ? null : live.page;
      if (page) {
        const copy = button(t('runs_copyRunPage'), () => void copyWithFeedback(page, copy), 'copy-page', {
          icon: 'copy',
        });
      }
      if (byWindow) box.append(iconText(element('p', 'note shared-window'), 'info', t('runs_sharedByWindow')));
      if (stopping) {
        const question = element('p', 'share-warning', t('runs_stopSharingAsk'));
        question.id = `stop-sharing-${++headings}`;
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', t('runs_stopSharing'));
        box.setAttribute('aria-describedby', question.id);
        box.append(question);
        row.replaceChildren();
        button(t('runs_stopSharing'), () => askStopSharing(run, true), 'stop-sharing-yes', {
          icon: 'eye-off',
          tone: 'danger',
        });
        button(t('common_cancel'), () => askStopSharing(run, false), 'stop-sharing-no', { icon: 'close' });
      } else {
        button(t('runs_stopSharing'), () => askStopSharing(run, null), 'stop-sharing', {
          icon: 'eye-off',
          title: t('runs_stopSharingTitle'),
        });
      }
    } else if (asking) {
      const warning = element('p', 'share-warning', t('runs_shareWarning', { instance: instanceOf(live) }));
      warning.id = `share-warning-${++headings}`;
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', t('runs_shareLive'));
      box.setAttribute('aria-describedby', warning.id);
      box.append(warning);
      button(t('runs_shareLive'), () => answerShare(run, true), 'share-yes', { icon: 'share', tone: 'primary' });
      if (offersWindow) {
        button(t('runs_shareWindow'), () => answerShare(run, true, true), 'share-window-yes', {
          icon: 'share',
          title: t('runs_shareWindowTitle'),
        });
      }
      button(t('common_cancel'), () => answerShare(run, false), 'share-no', { icon: 'close' });
    } else {
      button(t('runs_shareLive'), () => askShare(run), 'share', { icon: 'share', title: t('runs_shareLiveTitle') });
      if (offersWindow && !byWindow) {
        button(t('runs_shareWindow'), () => askShare(run, true), 'share-window', {
          icon: 'share',
          tone: 'ghost',
          title: t('runs_shareWindowTitle'),
        });
      }
    }
    box.append(row);
    const note = refusal ?? (live.shared ? null : live.stopped);
    if (note) box.append(iconText(element('p', 'note'), 'info', note));
    return box;
  });
}

/** The state line of a worker (`workerStatus`): a Pause waiting in a call names it as code, with how long it has run. */
function stateLine(status: WorkerStatus): HTMLElement {
  const line = element('p', 'state');
  if (status.waiting) {
    // How long it has waited, kept up to date each second (`tickWaits`).
    const waited = element('span', 'waited');
    const { since, title } = status.waiting;
    if (since) {
      waited.dataset.since = since;
      waited.textContent = waitedText(since, Date.now());
    }
    const call = element('span', 'call', ...richText(title));
    iconText(line, status.icon, ...tNodes(status.message.key, { call }), ' ', waited);
  } else iconText(line, status.icon, runsSpeaker.say(status.message.key, status.message.args));
  return line;
}

/** How long a call has run, from `since` to `now` (`for 12 s`); empty for a time that does not read. */
function waitedText(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return Number.isFinite(seconds) ? t('runs_waitedFor', { time: formatUnit(seconds, 'second') }) : '';
}

/** Each `.waited` with a `data-since`: how long since then, as the time goes. */
function tickWaits(): void {
  const now = Date.now();
  for (const waited of document.querySelectorAll<HTMLElement>('.waited[data-since]')) {
    waited.textContent = waitedText(waited.dataset.since ?? '', now);
  }
}

setInterval(tickWaits, 1000);

/** The stops whose More is open, by worker and stop (`since`), the latest `MORE_KEPT`: a new stop folds them again. */
const moreOpen = new Set<string>();
const MORE_KEPT = 50;

/** Whether a worker's More shows what it folds at the stop `since`. */
function moreShown(key: string, since: string | null): boolean {
  return moreOpen.has(`${key}|${since}`);
}

/**
 * Watch and Pause and watch on the row of a worker that runs: whether its lane can be watched (`outdated` for a
 * reporter that cannot show it), whether it is, and whether Pause and watch shows.
 */
interface RunningLane {
  can: 'watch' | 'outdated';
  watched: boolean;
  pauseWatch: boolean;
}

/**
 * A worker's buttons: those that steer the test, Resume, Step and Finish joined in one group and End the test apart at
 * the row's end; then the code a stop can write, under its label, Assert a region and Mock a request folded under More
 * where the row holds all five.
 * `held` are shown, held, saying to watch first; `lane` adds Pause and watch and Watch after Pause while the worker runs.
 */
function renderActions(
  run: RunsRun,
  worker: HubWorker,
  controls: Control[],
  stop: HubStop | null,
  held: readonly Control[],
  lane: RunningLane | null,
): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const since = stop?.since ?? null;
  const steering = element('div', 'piwi-actions steer');
  const joined = element('div', 'joined');
  const code = element('div', 'piwi-actions code');
  code.setAttribute('role', 'group');
  code.setAttribute('aria-label', t('runs_codeActions'));
  const label = element('span', 'row-label', t('runs_codeLabel'));
  label.setAttribute('aria-hidden', 'true');
  const folded: HTMLButtonElement[] = [];
  const button = (what: Control): HTMLButtonElement => {
    const look = CONTROLS[what];
    const waits = held.includes(what);
    // Mock a request opens the list of the stop's requests; the other controls send themselves.
    const onClick = () => {
      if (waits) return;
      if (what !== 'mock') void control(run, worker.worker, what, since);
      else if (since !== null) void toggleRequests(run, worker.worker, since);
    };
    const title = runsSpeaker.say(controlTitle(what, stop));
    const keys = what === 'resume' || what === 'step' || what === 'finish' ? STOP_KEYS[what] : null;
    const made = makeButton(runsSpeaker.say(look.label), onClick, {
      icon: look.icon,
      tone: 'tone' in look ? look.tone : undefined,
      title: waits ? t('runs_watchToUse') : keys ? t('runs_withKey', { title, key: keys.split(' ')[0]! }) : title,
    });
    if (keys) made.setAttribute('aria-keyshortcuts', keys);
    made.dataset.focus = `${key}|${what}`;
    if (waits) unavailable(made);
    return made;
  };
  const folds = controls.filter((what) => !STEERING.has(what)).length >= FOLD_FROM;
  for (const what of controls) {
    const made = button(what);
    if (JOINED.has(what)) joined.append(made);
    else if (STEERING.has(what)) steering.append(made);
    else if (folds && FOLDED.has(what)) folded.push(made);
    else code.append(made);
  }
  if (joined.childElementCount > 0) {
    steering.prepend(joined);
    // End the test, apart from the controls that move the test on.
    for (const end of steering.querySelectorAll<HTMLElement>(':scope > [data-tone="remove"]')) end.dataset.apart = '';
  }
  if (folded.length > 0) {
    const fold = `${key}|${since}`;
    const open = moreShown(key, since);
    const more = makeButton(
      t('runs_more'),
      (event) => {
        if (pressedHeld(event)) return;
        // Folded, Mock a request takes its list of requests with it.
        if (moreOpen.delete(fold)) {
          if (requestLists.get(key)?.since === since) closeRequests(key);
        } else moreOpen.add(fold);
        if (moreOpen.size > MORE_KEPT) moreOpen.delete(moreOpen.values().next().value!);
        focusKey = `${key}|more`;
        render();
      },
      { icon: 'chevron-down', tone: 'ghost', title: folded.map((made) => made.textContent ?? '').join(', ') },
    );
    more.dataset.focus = `${key}|more`;
    more.setAttribute('aria-expanded', String(open));
    code.append(more, ...(open ? folded : []));
  }
  if (code.childElementCount > 0) code.prepend(label);
  if (lane?.pauseWatch) {
    const pauseWatch = makeButton(
      t('runs_pauseWatch'),
      (event) => {
        if (!pressedHeld(event)) pauseAndWatch(run, worker);
      },
      { icon: 'pause', title: t('runs_pauseWatchTitle') },
    );
    pauseWatch.dataset.focus = `${key}|pause-watch`;
    steering.append(pauseWatch);
  }
  if (lane) steering.append(watchButton(run, worker, lane.can, lane.watched, false));
  const actions = element('div', 'controls');
  actions.append(...[steering, code].filter((row) => row.childElementCount > 0));
  return actions;
}

/**
 * Watch, a toggle saying whether the worker's lane is watched; held, saying to update the reporter, for one that cannot
 * show its lane (`outdated`).
 */
function watchButton(
  run: RunsRun,
  worker: HubWorker,
  can: 'watch' | 'outdated',
  watched: boolean,
  small: boolean,
): HTMLButtonElement {
  const made = makeButton(
    t('runs_watch'),
    (event) => {
      if (!pressedHeld(event)) toggleLane(run, worker);
    },
    { icon: 'eye', small, title: t(can === 'watch' ? 'runs_watchTitle' : 'runs_watchOutdated') },
  );
  made.dataset.focus = `${workerKey(run.hub, run.session.ref, worker)}|watch`;
  if (can === 'watch') made.setAttribute('aria-pressed', String(watched));
  else unavailable(made);
  return made;
}

/** A button this worker cannot take now, whatever else happens: held (`aria-disabled`), its tooltip saying why. */
function unavailable(button: HTMLElement): void {
  button.dataset.unavailable = '';
  button.setAttribute('aria-disabled', 'true');
}

/** Whether a press landed on a held button (`aria-disabled`): a command on its way, or one it cannot take. */
function pressedHeld(event: Event): boolean {
  return (event.currentTarget as HTMLElement | null)?.getAttribute('aria-disabled') === 'true';
}

/**
 * Marks the buttons of a worker that wait for a command's answer (`aria-disabled`): they keep the focus. A button it
 * cannot take stays held.
 */
function markBusy(buttons: Iterable<Element>, waiting: boolean): void {
  for (const button of buttons) {
    if (button.hasAttribute('data-unavailable')) continue;
    if (waiting) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }
}

/** A request's size: bytes, or kilobytes from a thousand bytes; null when its response did not state one. */
function sizeText(size: number | null): string {
  if (size === null) return t('runs_requestNoSize');
  return size < 1000 ? formatUnit(size, 'byte') : formatUnit(size / 1000, 'kilobyte');
}

/** A request of the list, as a button that mocks it: its method and address, then its status, type, size and time. */
function requestButton(request: HubKeptRequest, onClick: () => void): HTMLButtonElement {
  const button = element('button', 'request');
  button.type = 'button';
  // The address is cut to the row's width: the whole of it is in the tooltip and the button's name.
  button.title = `${request.method} ${request.url}`;
  const facts = element(
    'span',
    'request-facts',
    element('span', request.status >= 400 ? 'status failed' : 'status', String(request.status)),
  );
  const time = t('runs_requestAt', { time: formatUnit(request.time / 1000, 'second') });
  for (const fact of [request.type, sizeText(request.size), time]) if (fact) facts.append(` · ${fact}`);
  // The spaces between the parts are not drawn in the rows' flex boxes; they keep the words apart in the button's name.
  button.append(
    element(
      'span',
      'request-line',
      element('span', 'method', request.method),
      ' ',
      element('span', 'path', urlView(request.url)),
    ),
    ' ',
    facts,
  );
  button.addEventListener('click', onClick);
  return button;
}

/** From how many requests a filter box narrows the list. */
const FILTER_FROM = 6;

/** Of a list's rows, the one Tab reaches: the one the keyboard was on last, else the first shown. */
function rove(rows: readonly HTMLElement[], to: HTMLElement | undefined): void {
  for (const row of rows) row.tabIndex = row === to ? 0 : -1;
}

/**
 * The requests a stopped test kept, to choose the one to mock: one button each, oldest first, which the arrow keys,
 * Home and End move between, Escape closing the list; a filter box above them when there are many.
 */
function renderRequests(run: RunsRun, worker: HubWorker, list: RequestList): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const box = element('div', 'requests');
  box.id = `requests-${list.serial}`;
  box.setAttribute('role', 'group');
  const title = element('p', 'requests-title', t('runs_requestsTitle'));
  title.id = `${box.id}-title`;
  box.setAttribute('aria-labelledby', title.id);
  const close = makeButton(
    t('runs_requestsClose'),
    () => {
      closeRequests(key);
      render();
    },
    { icon: 'close', iconOnly: true, tone: 'ghost', small: true },
  );
  close.dataset.focus = `${key}|requests-close`;
  box.append(element('div', 'requests-head', title, close));
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeRequests(key);
    render();
  });
  if (list.requests.length === 0) {
    box.append(iconText(element('p', 'note'), 'info', t('runs_requestsNone')));
    return box;
  }
  const rows = list.requests.map((request) => {
    const button = requestButton(request, () => void mockRequest(run, worker.worker, list.since, request.id));
    button.dataset.focus = `${key}|request-${request.id}`;
    const text = `${request.method} ${request.url} ${request.status} ${request.type}`.toLowerCase();
    return { item: element('li', undefined, button), button, text };
  });
  const buttons = rows.map((row) => row.button);
  const shown = () => rows.filter((row) => !row.item.hidden).map((row) => row.button);
  rove(buttons, buttons[0]);
  const listed = element('ul', 'request-list', ...rows.map((row) => row.item));
  listed.addEventListener('focusin', (event) => rove(buttons, event.target as HTMLElement));
  listed.addEventListener('keydown', (event) => {
    const visible = shown();
    const at = visible.indexOf(event.target as HTMLButtonElement);
    const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: visible.length - 1 };
    if (at < 0 || !(event.key in moves)) return;
    event.preventDefault();
    visible[Math.max(0, Math.min(visible.length - 1, moves[event.key]!))]?.focus();
  });
  const noMatch = iconText(element('p', 'note'), 'search', t('runs_requestsNoMatch'));
  noMatch.hidden = true;
  if (rows.length >= FILTER_FROM) {
    const filter = element('input', 'requests-filter');
    filter.type = 'search';
    filter.placeholder = t('runs_requestsFilter');
    filter.setAttribute('aria-label', t('runs_requestsFilter'));
    filter.dataset.focus = `${key}|requests-filter`;
    filter.addEventListener('input', () => {
      const query = filter.value.trim().toLowerCase();
      for (const row of rows) row.item.hidden = !!query && !row.text.includes(query);
      const visible = shown();
      noMatch.hidden = visible.length > 0;
      rove(buttons, visible[0]);
    });
    filter.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      const first = shown()[0];
      if (!first) return;
      event.preventDefault();
      first.focus();
    });
    box.append(filter);
  }
  box.append(listed, noMatch);
  return box;
}

/**
 * A worker of a run, of the hub `hub`; `away` while its hub's connection is lost, its controls held until it answers
 * again: its test, then a card of where it stands, its controls, and its page, the stop's or its watched lane's.
 */
function renderWorker(run: RunsRun, hub: RunsHub | undefined, worker: HubWorker, away: boolean): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const held = away || busy.has(key);
  const { ended } = run.session;
  const item = part(`${key}|item`, null, () => element('li', 'worker'));
  item.dataset.state = ended ? 'ended' : worker.state;
  // The worker a key steers when the focus is in its row (`keyTargetOf`).
  item.dataset.worker = key;
  const parts: HTMLElement[] = [];
  const stop = !ended && worker.state === 'stopped' ? worker.stop : null;
  const where = stop ? stopPlace(stop, run.session.root) : null;
  item.toggleAttribute('data-failed', stop?.reason === 'failure');
  // The test first: its name, then its project and attempt, on one line where they fit.
  const test = worker.test;
  if (test) {
    const name = testName(test);
    const meta = [test.project, t('runs_attempt', { attempt: test.retry + 1 })].filter(Boolean).join(' · ');
    parts.push(
      part(`${key}|test`, [name, meta], () =>
        element('div', 'test-head', element('p', 'test', name), element('p', 'meta', meta)),
      ),
    );
    const reason = test.cannotPause;
    if (reason && !ended) {
      parts.push(
        part(`${key}|cannot`, reason, () => iconText(element('p', 'note'), 'info', t('runs_cannotPause', { reason }))),
      );
    }
  }
  // Then where it stands, in a card of its tone: how it runs, or why it stopped with the call about to run and its
  // place, or the error it failed with. An ended run names the tests it ran last; the hub says nothing of how they
  // ended.
  if (!ended) {
    const shown = {
      state: worker.state,
      reason: stop?.reason ?? null,
      by: stop?.by ?? null,
      place: stop?.reason === 'failure' ? where : null,
      pausing: worker.pausing,
      waiting: worker.pausing ? (worker.waiting ?? null) : null,
      stop: stop && where ? { title: stop.title, where, error: stop.error ?? null } : null,
    };
    parts.push(
      part(`${key}|status`, shown, () => {
        const status = workerStatus(worker, where);
        const card = element('div', 'status', stateLine(status));
        card.dataset.tone = status.tone;
        if (stop && where) card.append(stopView(stop, where));
        return card;
      }),
    );
  }
  if (!ended) {
    // A worker whose lane can be watched shows it, and the stops of its tests, through Watch; another one, and a stop
    // outside a test, which no lane shows, a stop's own view.
    const can = laneWatchOf(hub, worker);
    const lane = can === 'watch' ? lanes.get(slotKey(run.hub, run.session.ref, worker.parallelIndex)) : undefined;
    const byLane = can === 'watch' && (!stop || !!worker.test);
    // Who watches its page, as a hub with `presence` says, while it answers: in the page's head, else on a line.
    const watchers = away ? null : watchersLine(worker.watchers, runsSpeaker);
    // Who drives its stop, under its page, where it comes and goes without moving the page: while another tool or an
    // agent drives it, an agent follows the run, or this window drives it while another tool has the run open.
    const driver = stop && hub?.presence && !away ? driverOf(stop, runsSpeaker) : null;
    const agentFollows = !!run.session.presence?.some((tool) => tool.kind === 'agent');
    const othersOpen = !!run.session.presence?.some((tool) => !tool.self);
    let drive: HTMLElement | null = null;
    if (stop && hub?.presence && !away && ((driver && (driver.who !== 'self' || othersOpen)) || agentFollows)) {
      drive = part(`${key}|drive`, { since: stop.since, driver }, () => renderDriver(run, worker, stop, driver));
      markBusy(drive.querySelectorAll('button'), held || releasing.has(key));
    }
    const head = { watchers, drive };
    let page: HTMLElement | null = null;
    if (stop && where) {
      if (!away) wantImage(run, worker, stop);
      page = byLane ? renderLanePage(run, worker, stop, away, head) : renderPage(run, worker, stop, away, head);
    } else if (byLane) {
      page = renderLanePage(run, worker, null, away, head);
    }
    const since = stop?.since ?? null;
    const list = stop ? requestLists.get(key) : undefined;
    const listed = list?.since === since ? list : undefined;
    const watchable = byLane || (!!stop && stopIntents(worker, stop).includes('view'));
    const untilWatched: Control[] = stop ? heldUntilWatched(worker, stop, watchable) : [];
    const controls = controlsOf(worker, stop, untilWatched);
    const running: RunningLane | null =
      !stop && can
        ? { can, watched: isWatched(lane), pauseWatch: can === 'watch' && !isWatched(lane) && !worker.pausing }
        : null;
    if (controls.length > 0 || running) {
      // Drawn again for another stop, so each control answers the stop shown; a command on its way leaves them be.
      const failure = stop?.reason === 'failure';
      const more = moreShown(key, since);
      const actions = part(`${key}|actions`, { controls, since, failure, untilWatched, running, more }, () =>
        renderActions(run, worker, controls, stop, untilWatched, running),
      );
      markBusy(actions.querySelectorAll('button'), held);
      const mock = actions.querySelector(`[data-focus="${CSS.escape(`${key}|mock`)}"]`);
      mock?.setAttribute('aria-expanded', String(!!listed));
      if (listed) mock?.setAttribute('aria-controls', `requests-${listed.serial}`);
      else mock?.removeAttribute('aria-controls');
      parts.push(actions);
    }
    const answer = answers.get(key);
    if (answer && answer.since === since) {
      const [className, icon]: [string, IconName] = !answer.ok
        ? ['answer', 'alert']
        : answer.sent
          ? ['note sent', 'send']
          : ['note', 'info'];
      const text = answer.rich ? richText(answer.text) : [answer.text];
      parts.push(part(`${key}|answer`, answer, () => iconText(element('p', className), icon, ...text)));
      const locator = answer.copy;
      if (locator) {
        parts.push(
          part(`${key}|copy-pick`, locator, () => {
            const copy = makeButton(t('common_copy'), () => void copyWithFeedback(locator, copy), {
              icon: 'copy',
              small: true,
            });
            copy.dataset.focus = `${key}|copy-pick`;
            return element('div', 'piwi-actions', copy);
          }),
        );
      }
      if (answer.warnings.length > 0) parts.push(part(`${key}|warnings`, answer.warnings, () => warningList(answer)));
    }
    if (listed) {
      const requests = part(`${key}|requests`, { since: listed.since, serial: listed.serial }, () =>
        renderRequests(run, worker, listed),
      );
      markBusy(requests.querySelectorAll('button.request'), held);
      parts.push(requests);
    }
    if (page) parts.push(page);
    else if (watchers) {
      parts.push(part(`${key}|watchers`, watchers, () => iconText(element('p', 'watchers'), 'eye', watchers)));
    }
    // A watched lane's layers, under its page, once its worker's reporter sent one.
    if (lane && isWatched(lane) && lane.layered && hub?.layers && byLane) {
      parts.push(renderLaneLayers(key, slotKey(run.hub, run.session.ref, worker.parallelIndex), lane, away));
    }
  }
  place(item, parts);
  return item;
}

/** What to check in the code sent to the editor, as the hub said it: a line each. */
function warningList(answer: { warnings: readonly string[] }): HTMLElement {
  const list = element(
    'ul',
    'warnings',
    ...answer.warnings.map((warning) => iconText(element('li', 'note'), 'alert', warning)),
  );
  list.setAttribute('aria-label', t('runs_codeWarnings'));
  return list;
}

/**
 * Where the test stands, under its state in its status card: the call about to run and its place; where it failed,
 * the error alone, its place in the state above.
 */
function stopView(stop: HubStop, where: string): HTMLElement {
  if (stop.reason === 'failure') return element('div', 'stop', element('p', 'error', ...richText(stopError(stop))));
  return element(
    'dl',
    'stop',
    element('dt', undefined, t('runs_nextLabel')),
    element('dd', undefined, ...richText(stop.title)),
    element('dt', undefined, t('runs_whereLabel')),
    element('dd', 'place', where),
  );
}

/**
 * Who drives a stop, one at a time, with **Take control** while another tool drives it or an agent follows the run,
 * and **Give back** while this window drives it.
 */
function renderDriver(
  run: RunsRun,
  worker: HubWorker,
  stop: HubStop,
  driver: ReturnType<typeof driverOf>,
): HTMLElement {
  const row = element('div', 'run-driver piwi-actions');
  if (driver)
    row.append(iconText(element('span', 'driver'), driver.who === 'agent' ? 'sparkles' : 'hand', driver.words));
  const mine = driver?.who === 'self';
  const button = makeButton(
    t(mine ? 'runs_giveBack' : 'runs_takeControl'),
    (event) => {
      if (pressedHeld(event)) return;
      // Give back with Interact on turns it off, which gives the stop back.
      if (mine && interacting.has(slotKey(run.hub, run.session.ref, worker.parallelIndex))) {
        void setInteract(run, worker, stop, false);
      } else void drive(run, worker.worker, stop.since, !mine, driver?.who ?? null);
    },
    { icon: mine ? 'undo' : 'hand', small: true, title: t(mine ? 'runs_giveBackTitle' : 'runs_takeControlTitle') },
  );
  button.dataset.focus = `${workerKey(run.hub, run.session.ref, worker)}|drive`;
  row.append(button);
  return row;
}

/**
 * Take control of a stop (`on`), or give it back: a refusal is shown under the test; the answer is read out, but for
 * control taken from the agent, which the state that follows says (`announceChanges`).
 */
async function drive(
  run: RunsRun,
  worker: number,
  since: string,
  on: boolean,
  before: 'self' | 'agent' | 'other' | null,
): Promise<void> {
  const answer = await send(run, worker, 'drive', since, { on });
  if (!answer) return;
  if (!answer.ok) say(workerKey(run.hub, run.session.ref, { worker }), answer, since);
  else if (answer.message && !(on && before === 'agent')) announce(answer.message);
  render();
}

/**
 * The stopped page, in a card: its head with who watches it, and the stop's Watch and Pick on the image where the stop takes
 * them; then its live view once a frame came (the Live badge on it), else its image, else why there is none in its
 * place; under it, why the view ended, the first time the view takes input how, and who drives the stop. The image's
 * box stays the same element for the stop, so the live view keeps the focus.
 */
function renderPage(run: RunsRun, worker: HubWorker, stop: HubStop, away: boolean, around: PageAround): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const intents: HubAction[] = stopIntents(worker, stop);
  const kept = images.get(key);
  const still = kept?.since === stop.since ? kept : undefined;
  if (views.get(key)?.since !== stop.since) endView(key, false);
  const canView = intents.includes('view');
  // A stop's Watch left on for the slot watches this stop, and starts again on its own once a lost hub answers.
  const watched = watchLive.has(slotKey(run.hub, run.session.ref, worker.parallelIndex));
  const restart = !views.has(key) || views.get(key)!.status === 'ended';
  if (canView && watched && restart && !away && !document.hidden) startView(run, worker.worker, stop);
  const view = views.get(key);
  const live = isLive(view);
  const framed = live && !!view.viewport;
  const slot = slotKey(run.hub, run.session.ref, worker.parallelIndex);
  const interact = interacting.has(slot);
  if (view) {
    syncInput(
      view,
      framed && view.status === 'on' && intents.includes('input') && interact,
      intents.includes('input-clicks'),
      (events) => sendInput(view, slot, () => views.get(key) === view, events),
      `${key}|${view.since}`,
    );
  }
  const pickable = intents.includes('pick-at') && (framed || !!still?.viewport);
  if (!pickable) picking.delete(key);

  const figure = part(`${key}|page`, stop.since, () => element('figure', 'page'));
  figure.toggleAttribute('data-picking', picking.has(key));
  // While its hub is away, the stop's Watch shows as the person left it, for when the hub answers.
  const tools = {
    since: stop.since,
    watchers: around.watchers,
    live: canView ? live || (away && watched) : null,
    watch: null,
    interact: framed && view.status === 'on' && intents.includes('input') ? interact : null,
    pickable,
    picking: picking.has(key),
    // A stop's own view is no lane's: Open the trace so far shows on a watched lane's page.
    trace: null,
  };
  const head = pageHead(run, worker, stop, figure, tools, away);
  const children: HTMLElement[] = [head];
  const shown = framed ? view.img : (still?.img ?? null);
  if (shown) {
    const box = part(`${key}|frame`, stop.since, () => element('div', 'page-frame'));
    if (framed) {
      view.img.alt = t(view.inputOn ? 'runs_liveAltInput' : 'runs_liveAlt');
      if (view.inputOn) view.img.tabIndex = 0;
      else view.img.removeAttribute('tabindex');
      // An action runs in the test's window there: Escape on the view goes to the page (`keyOnView`).
      view.img.toggleAttribute('data-acting', !!stop.acting);
    }
    place(box, framed ? [shown, part(`${key}|badge`, null, liveBadge)] : [shown]);
    children.push(box);
  }
  const note = pageNote(view, live, framed, shown, still);
  if (note) children.push(pageNotePart(key, note, !shown));
  if (view?.inputOn && hintFor === `${key}|${view.since}`) {
    children.push(
      part(`${key}|hint`, null, () => iconText(element('p', 'view-note hint'), 'info', t('runs_liveHint'))),
    );
  }
  if (around.drive) children.push(around.drive);
  place(figure, children);
  return figure;
}

/**
 * What the page's part says under it: why a view ended or was refused, why it sends no frame now, or that it starts
 * (with an icon), else why there is no image, or that it is on its way.
 */
function pageNote(
  view: LiveView | undefined,
  live: boolean,
  framed: boolean,
  shown: HTMLImageElement | null,
  still: { loading: boolean; note: string } | undefined,
): { icon?: IconName; text: string } | null {
  if (view && !live) return { icon: 'alert', text: view.note };
  if (live && view?.heavy) return { icon: 'alert', text: view.heavy };
  if (live && !framed) return { icon: 'clock', text: t('runs_liveStarting') };
  if (shown) return null;
  if (still && !still.loading) return { text: still.note || t('runs_imageNone') };
  return { text: t('runs_imageLoading') };
}

/** Around a worker's page: who watches it, in its head, and who drives its stop, under it. */
interface PageAround {
  watchers: string | null;
  drive: HTMLElement | null;
}

/**
 * The page card's head, which names the card (`figure`): its caption, who watches the page under it, then the tools
 * the stop takes on its page, each a toggle saying whether it is on: the stop's Watch (`live`, null where the stop takes no
 * view of its own), Watch for a watched lane's stop (`watch`), Interact once a view the hub accepted shows the stop
 * and it takes input (`interact`), and Pick on the image; then, on a watched lane's page, Open the trace so far, a
 * button (`trace`, held while its ask waits). Who watches and the tools are each drawn again only when they change, so
 * a tool stays the same element as others come to watch.
 */
function pageHead(
  run: RunsRun,
  worker: HubWorker,
  stop: HubStop | null,
  figure: HTMLElement,
  shown: {
    since: string | null;
    watchers: string | null;
    live: boolean | null;
    watch: boolean | null;
    interact: boolean | null;
    pickable: boolean;
    picking: boolean;
    /** Open the trace so far, and whether it waits for the hub's answer; null where the lane opens no trace. */
    trace: boolean | null;
  },
  away: boolean,
): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const captionId = domId('page', key);
  figure.setAttribute('aria-labelledby', captionId);
  const head = part(`${key}|page-head`, null, () => element('div', 'page-head'));
  const { watchers, ...tools } = shown;
  const title = part(`${key}|page-title`, [captionId, watchers], () => {
    const caption = element('span', 'page-caption', t('runs_pageCaption'));
    caption.id = captionId;
    const made = element('div', 'page-title', caption);
    if (watchers) made.append(iconText(element('span', 'watchers'), 'eye', watchers));
    return made;
  });
  const items = [title];
  if (
    tools.live !== null ||
    tools.watch !== null ||
    tools.interact !== null ||
    tools.pickable ||
    tools.trace !== null
  ) {
    const row = part(`${key}|page-tools`, tools, () => {
      const made = element('div', 'piwi-actions page-tools');
      if (tools.live !== null && stop) {
        // The stop's own view, named as the lane's: one view, one name.
        const live = makeButton(t('runs_watch'), () => toggleLive(run, worker.worker, stop), {
          icon: 'eye',
          small: true,
          title: t('runs_watchTitle'),
        });
        live.setAttribute('aria-pressed', String(tools.live));
        live.dataset.focus = `${key}|live`;
        made.append(live);
      }
      if (tools.watch !== null) made.append(watchButton(run, worker, 'watch', tools.watch, true));
      if (tools.interact !== null && stop) {
        const on = tools.interact;
        const interact = makeButton(
          t('runs_interact'),
          (event) => {
            if (!pressedHeld(event)) void setInteract(run, worker, stop, !on);
          },
          { icon: 'hand', small: true, title: t('runs_interactTitle') },
        );
        interact.setAttribute('aria-pressed', String(on));
        interact.dataset.focus = `${key}|interact`;
        made.append(interact);
      }
      if (tools.pickable) made.append(pickAtButton(key, tools.picking));
      if (tools.trace !== null) made.append(traceButton(run, worker.parallelIndex, key));
      return made;
    });
    markTools(row, key, away);
    items.push(row);
  }
  place(head, items);
  return head;
}

/**
 * What the page card says: under its image, or, with no image to show, in the image's place, where the image will
 * come.
 */
function pageNotePart(key: string, note: { icon?: IconName; text: string }, empty: boolean): HTMLElement {
  return part(`${key}|page-note`, { ...note, empty }, () => {
    const text = note.icon
      ? iconText(element('p', 'view-note'), note.icon, note.text)
      : element('p', undefined, note.text);
    return empty ? element('div', 'page-frame page-empty', text) : text;
  });
}

/** Pick on the image, a toggle saying whether it waits for a click. */
function pickAtButton(key: string, picking: boolean): HTMLButtonElement {
  const pick = makeButton(
    t('runs_pickAt'),
    (event) => {
      // A command on its way: the button says so (`aria-disabled`) and waits for it.
      if (!pressedHeld(event)) togglePicking(key);
    },
    { icon: 'pointer', small: true, title: t('runs_pickAtTitle') },
  );
  pick.setAttribute('aria-pressed', String(picking));
  pick.dataset.focus = `${key}|pick-at`;
  return pick;
}

/** Open the trace so far, on a watched lane's page: the hub opens Playwright's trace viewer on its machine. */
function traceButton(run: RunsRun, lane: number, key: string): HTMLButtonElement {
  const made = makeButton(
    t('runs_openTrace'),
    (event) => {
      // Its ask on its way: the button says so (`aria-disabled`) and waits for the answer.
      if (!pressedHeld(event)) void openTrace(run, lane);
    },
    { icon: 'file', small: true, title: t('runs_openTraceTitle') },
  );
  made.dataset.focus = `${key}|trace`;
  made.dataset.slot = slotKey(run.hub, run.session.ref, lane);
  return made;
}

/**
 * The tools above a page are held while its hub is away, Pick on the image while a command is on its way, and Open the
 * trace so far while its own ask is.
 */
function markTools(row: HTMLElement, key: string, away: boolean): void {
  const pickAt = `[data-focus="${CSS.escape(`${key}|pick-at`)}"]`;
  const trace = `[data-focus="${CSS.escape(`${key}|trace`)}"]`;
  for (const button of row.querySelectorAll<HTMLElement>('button')) {
    const asking = button.matches(trace) && tracing.has(button.dataset.slot ?? '');
    markBusy([button], away || releasing.has(key) || (button.matches(pickAt) && busy.has(key)) || asking);
  }
}

/**
 * The page of a worker whose lane can be watched, in a card: its head with who watches it, at a stop Watch and Pick
 * on the image, and while the lane is watched at a hub that opens traces, Open the trace so far (`canOpenTrace`); then
 * the lane's
 * frame of where the worker stands, with the Live badge (at a stop, the stop's live view, which takes Interact's input
 * as a stop's own Watch's does), else the stop's image, else the lane's last frame, dimmed and, while the test runs, marked as running.
 * Why the lane sends no frame shows in place of its image; under it, why the lane ended or was refused, that it starts,
 * or why the stop has no image, the first time the view takes input how, and who drives the stop. Null for a worker
 * that runs, its lane neither watched nor refused.
 */
function renderLanePage(
  run: RunsRun,
  worker: HubWorker,
  stop: HubStop | null,
  away: boolean,
  around: PageAround,
): HTMLElement | null {
  const key = workerKey(run.hub, run.session.ref, worker);
  const slot = slotKey(run.hub, run.session.ref, worker.parallelIndex);
  const lane = lanes.get(slot);
  // The lane's frames are the stop's live view: no view of the stop's own is asked.
  if (views.has(key)) endView(key, true);
  if (!stop && !lane) return null;
  const intents: HubAction[] = stop ? stopIntents(worker, stop) : [];
  const kept = images.get(key);
  const still = stop && kept?.since === stop.since ? kept : undefined;
  const live = isLive(lane);
  // Whether the frame drawn shows where the worker stands now, in this watch: its running test, or the stop it is the
  // live view of.
  const now =
    live && !lane.refused && !!lane.viewport && lane.shown?.ask === lane.asks && laneFrameNow(lane.shown, worker);
  const viewing = now && stop ? stop.since : null;
  if (lane) {
    if (lane.inputSince !== viewing) {
      stopInput(lane);
      lane.inputSince = viewing;
    }
    const at: RunsView = { hub: run.hub, ref: run.session.ref, worker: worker.worker, since: viewing ?? '' };
    syncInput(
      lane,
      viewing !== null && lane.status === 'on' && intents.includes('input') && interacting.has(slot),
      intents.includes('input-clicks'),
      (events) => sendInput(at, slot, () => lanes.get(slot) === lane && lane.inputSince === at.since, events),
      `${key}|${viewing}`,
    );
  }
  const pickable = !!stop && intents.includes('pick-at') && (viewing !== null || !!still?.viewport);
  if (!pickable) picking.delete(key);

  const figure = part(`${key}|page`, null, () => element('figure', 'page'));
  figure.toggleAttribute('data-picking', picking.has(key));
  // At a stop, Watch and Pick on the image in its head; while the test runs, Watch stays with the controls.
  // Open the trace so far, while the lane is watched at a hub that opens a trace, for a worker that runs a test whose
  // reporter answers the ask.
  const traceable = isWatched(lane) && !!state?.hubs.find((h) => h.id === run.hub)?.traces && canOpenTrace(worker);
  const tools = {
    since: stop?.since ?? null,
    watchers: around.watchers,
    live: null,
    watch: stop ? isWatched(lane) : null,
    interact: viewing !== null && lane?.status === 'on' && intents.includes('input') ? interacting.has(slot) : null,
    pickable,
    picking: picking.has(key),
    trace: traceable ? tracing.has(slot) : null,
  };
  const head = pageHead(run, worker, stop, figure, tools, away);
  const children: HTMLElement[] = [head];
  const lastFrame = !!lane?.viewport && !(live && lane.refused);
  const shown = viewing !== null ? lane!.img : (still?.img ?? (lastFrame ? lane!.img : null));
  if (shown) {
    const box = part(`${key}|frame`, null, () => element('div', 'page-frame'));
    let badge: HTMLElement | null = null;
    if (lane && shown === lane.img) {
      lane.img.classList.toggle('stale', !now);
      lane.img.alt = t(now ? (lane.inputOn ? 'runs_liveAltInput' : 'runs_liveAlt') : 'runs_laneAltLast');
      if (lane.inputOn) lane.img.tabIndex = 0;
      else lane.img.removeAttribute('tabindex');
      lane.img.toggleAttribute('data-acting', now && !!stop?.acting);
      if (now) badge = part(`${key}|badge`, null, liveBadge);
      else if (!stop) badge = part(`${key}|running`, null, runningBadge);
    }
    place(box, badge ? [shown, badge] : [shown]);
    children.push(box);
  }
  const note = laneNote(lane, stop !== null, shown, still);
  if (note) children.push(pageNotePart(key, note, !shown));
  if (lane?.inputOn && hintFor === `${key}|${lane.inputSince}`) {
    children.push(
      part(`${key}|hint`, null, () => iconText(element('p', 'view-note hint'), 'info', t('runs_liveHint'))),
    );
  }
  if (around.drive) children.push(around.drive);
  place(figure, children);
  return figure;
}

/**
 * What a watched lane's page says under it: why the lane ended or was refused, why it sends no frame now, or that it
 * starts (with an icon); else, at a stop with nothing to show, why there is no image, or that it is on its way.
 */
function laneNote(
  lane: LaneView | undefined,
  stopped: boolean,
  shown: HTMLImageElement | null,
  still: { loading: boolean; note: string } | undefined,
): { icon?: IconName; text: string } | null {
  if (lane?.status === 'ended' || lane?.status === 'refused') return { icon: 'alert', text: lane.note };
  if (isLive(lane) && lane.refused) return { icon: 'alert', text: lane.refused };
  if (isLive(lane) && !lane.viewport) return { icon: 'clock', text: t('runs_liveStarting') };
  if (!stopped || shown) return null;
  if (still && !still.loading) return { text: still.note || t('runs_imageNone') };
  return { text: t('runs_imageLoading') };
}

/** The badge on a live view: a dot and the word, drawn still (no animation). */
function liveBadge(): HTMLElement {
  const badge = element('span', 'live-badge', icon('dot'), t('runs_liveBadge'));
  // The view's own name says it is live.
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

/** The mark on a watched lane's last frame while its test runs on: the word, drawn still. */
function runningBadge(): HTMLElement {
  const badge = element('span', 'live-badge running', t('runs_laneRunning'));
  // The image's own name says it is the page as last seen.
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

// ── Focus ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The control the keyboard is on, by its `data-focus`, given the focus again when a redraw takes its element away. */
let focusKey: string | null = null;
/** While the window lends the focus to another control of the same worker, until the one it was on comes back. */
let lending = false;

document.addEventListener('focusin', (event) => {
  if (lending) return;
  focusKey = (event.target as HTMLElement | null)?.dataset?.focus ?? null;
});
// A press anywhere but on a control: the person put the focus there themselves.
document.addEventListener(
  'pointerdown',
  (event) => {
    if (!(event.target as Element | null)?.closest?.('[data-focus]')) focusKey = null;
  },
  true,
);

/**
 * Gives the focus back after a redraw that took it to the page: to the control it was on (Step at the next stop), or
 * meanwhile to another control of the same worker (Pause, while the step runs), whose own focus does not replace it.
 */
function restoreFocus(): void {
  const active = document.activeElement;
  if (!focusKey || (active && active !== document.body)) return;
  const same = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`);
  if (same) {
    same.focus();
    return;
  }
  const owner = focusKey.slice(0, focusKey.lastIndexOf('|') + 1);
  // An action More folds again at the next stop leaves the focus on More; never End the test, which a key pressed
  // again would answer, nor Stop the run.
  const folded = FOLDED.has(focusKey.slice(owner.length) as Control)
    ? document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(`${owner}more`)}"]`)
    : null;
  const near =
    folded ??
    (owner
      ? document.querySelector<HTMLElement>(
          `[data-focus^="${CSS.escape(owner)}"]:not([data-focus$="|give-up"]):not([data-focus$="|stop-run"])`,
        )
      : null);
  if (!near) return;
  lending = true;
  near.focus();
  lending = false;
}

connect();
void renderShortcut();
// Back from the browser's shortcuts page: the key it was given shows.
window.addEventListener('focus', () => void renderShortcut());
// Says the window is still open: the worker stays alive meanwhile, and keeps finding the hubs again after a failure.
setInterval(() => post({ type: 'ping' }), RUNS_PING_MS);

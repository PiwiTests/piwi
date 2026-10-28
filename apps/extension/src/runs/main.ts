import { LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import type { HubAction, HubImage, HubKeptRequest, HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import { isViewFrameData, type ViewButton, type ViewInput } from '@piwitests/core/run-view';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { decorateIcons, icon, iconText, setLabel, type IconName } from '../shared/icons.js';
import { formatUnit, initI18n, localizeDocument, t, tn, tNodes } from '../shared/i18n.js';
import {
  IN_WINDOW,
  RUNS_PING_MS,
  RUNS_PORT,
  RUN_COMMAND,
  pagePoint,
  stopError,
  stopIntents,
  stopPlace,
  testName,
  workerKey,
  type RunsAnswer,
  type RunsCode,
  type RunsEvent,
  type RunsFrame,
  type RunsRequest,
  type RunsRun,
  type RunsState,
  type RunsView,
  type RunsWhat,
} from '../shared/runs.js';
import { STEP_CSS, richText, urlView } from '../shared/step-view.js';
import { ViewInputBatcher, keyOnView, pastedText, type ViewModifier } from '../shared/view-input.js';

/**
 * The Runs window: the runs the paired editor started, each worker's test and where it stands, an image of a stopped
 * page or its live view, and the controls, with the code a stop can write (Pick, Record, Assert, Assert a region, Mock
 * a request) as the stop takes them from this window (`stopIntents`). Opened from the popup's Runs tile in a small
 * window of its own. It reads everything from the background worker through its port (`RUNS_PORT`), and makes no
 * network call: the worker holds the hubs' connections and tokens. The code itself never comes here: it goes to the
 * editor, which writes it and says there whether it did, and the window shows what the hub answered and what each code
 * made at the stop came to (sent to the editor to write, or refused), whoever asked for it. What a hub sends is shown
 * as text, and its image and the frames of a live view as images, the latest frame alone kept, in memory. Each part of
 * the window is drawn again only when what it shows changes (`part`), so a button under the pointer or the keyboard
 * stays the same element while the run goes on around it.
 *
 * Watch live shows the stop's frames in place of its image, while the window shows that stop: the view ends as the
 * stop does, the window hides or Watch live is turned off, and comes again at the worker's next stop while Watch live
 * stays on. Where the stop takes input from this window (`input`), the pointer and the keys on the live view go to the
 * page, the left and right buttons with the click count the system gave them where the stop takes it
 * (`input-clicks`), Control, Alt and Meta held around a click: Tab moves the focus on unless a click into the view
 * took the keyboard, and Escape gives it back, as it does the browser's shortcuts. Pick on the image, or a Shift+click
 * on the image or the view, names the element under the pointer.
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
  }
>();
/**
 * What the last command for a worker answered, or what the last code made at its stop came to, when there is
 * something to say, for the stop it was sent at (null for Pause): shown while the worker stands there, and gone with
 * that stop. `sent` when the code went to the editor to write, with what to check in it (`warnings`).
 */
const answers = new Map<
  string,
  { ok: boolean; text: string; since: string | null; sent: boolean; warnings: string[]; rich: boolean }
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
/** Each worker's state and stop as last shown, and the runs live then, for what the live region says. */
let seen: Map<string, { state: HubWorker['state']; since: string | null }> | null = null;
let liveSeen = new Set<string>();

// ── The port to the worker ──────────────────────────────────────────────────────────────────────────────────────────

let port: chrome.runtime.Port | null = null;
let nextId = 1;
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
    } else if (event?.type === 'code') {
      heardCode(event);
    } else if (event?.type === 'frame') {
      heardFrame(event);
    } else if (event?.type === 'view-ended') {
      heardViewEnded(event);
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
    // The worker that relayed the views is gone: the next one watches each again that Watch live left on.
    for (const [key, view] of views) if (isLive(view)) endView(key, false);
    // The worker stopped (it is started again by the connection) or restarted.
    setTimeout(connect, 500);
  });
  void chrome.windows
    .getCurrent()
    .then((window) => {
      if (window.id !== undefined) post({ type: 'window', windowId: window.id });
    })
    .catch(() => undefined);
}

/** What a command names besides its stop: the response to mock, whether a view is on, the input, a point. */
type CommandExtra = Pick<Extract<RunsRequest, { type: 'command' }>, 'request' | 'on' | 'events' | 'x' | 'y'>;

function command(
  hub: string,
  ref: string,
  worker: number | null,
  what: RunsWhat,
  since: string | null,
  extra: CommandExtra = {},
): Promise<RunsAnswer> {
  const id = nextId++;
  return new Promise((resolve) => {
    if (!port) {
      resolve({ ok: false, message: '', failure: 'offline' });
      return;
    }
    waiting.set(id, resolve);
    post({ type: 'command', id, hub, ref, worker, since, what, ...extra });
  });
}

function failureText(answer: RunsAnswer): string {
  if (answer.failure === 'offline') return t('runs_failOffline');
  if (answer.failure === 'timeout') return t('runs_failTimeout');
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
  // A command on its way: the buttons say so (`aria-disabled`) and take no other until it is answered.
  if (busy.has(key)) return null;
  // Every control but Pause answers the stop shown.
  if (what !== 'pause' && since === null) return null;
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
  options: { sent?: boolean; warnings?: string[]; rich?: boolean } = {},
): void {
  const { sent = false, warnings = [], rich = false } = options;
  const text = answer.ok ? answer.message : failureText(answer);
  answers.set(key, { ok: answer.ok, text, since, sent: answer.ok && sent, warnings, rich });
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

/** A control of the window, for the stop its button was drawn for (`since`, null for Pause). */
async function control(run: RunsRun, worker: number, what: Control, since: string | null): Promise<void> {
  const asked = what === 'pause' ? null : since;
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
    images.set(key, { since: stop.since, loading: false, img, note: img ? '' : failureText(answer), viewport });
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

/** A stopped worker's live view, for the stop it watches: what the window shows of it, and the input it sends. */
interface LiveView extends RunsView {
  /** Asked of the hub and not answered yet; on; ended as the hub's connection was lost; or refused. */
  status: 'starting' | 'on' | 'ended' | 'refused';
  /** Why it ended or was refused. */
  note: string;
  /** The image the frames are drawn in, one element for the view, and the viewport of the frame it shows. */
  img: HTMLImageElement;
  viewport: { width: number; height: number } | null;
  /** The latest frame not drawn yet, while another one decodes: the others are dropped. */
  next: ImageFrame | null;
  decoding: boolean;
  /** The hub's sentence saying why no frame comes now (the page is too heavy for the view), until one does. */
  heavy: string;
  /** Whether the stop takes this window's input now (`input` among its intents), and what sends it. */
  inputOn: boolean;
  input: ViewInputBatcher | null;
  /** Whether a click into the view took the keyboard, Tab included, until Escape gives it back. */
  captured: boolean;
}

/** Each stopped worker's live view, by worker. */
const views = new Map<string, LiveView>();
/** The workers whose Watch live the person left on, each with its hub: each new stop of theirs is watched too. */
const watchLive = new Map<string, string>();
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

function isLive(view: LiveView | undefined): view is LiveView {
  return !!view && (view.status === 'starting' || view.status === 'on');
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

/** Watch live, on or off for a worker; on, every next stop of the worker is watched too, until it is turned off. */
function toggleLive(run: RunsRun, worker: number, stop: HubStop): void {
  const key = workerKey(run.hub, run.session.ref, { worker });
  const view = views.get(key);
  if (view?.since === stop.since && isLive(view)) {
    watchLive.delete(key);
    endView(key, true);
  } else {
    watchLive.set(key, run.hub);
    startView(run, worker, stop);
  }
  render();
}

/** Asks the hub for a stop's live view; its frames take the image's place once the first one is drawn. */
function startView(run: RunsRun, worker: number, stop: HubStop): void {
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
  liveImage(key, view);
  views.set(key, view);
  void command(view.hub, view.ref, worker, 'view', stop.since, { on: true }).then((answer) => {
    if (views.get(key) !== view || !isLive(view)) return;
    if (answer.ok) {
      view.status = 'on';
    } else {
      stopInput(view);
      view.status = 'refused';
      view.note = failureText(answer);
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

function stopInput(view: LiveView): void {
  view.input?.dispose();
  view.input = null;
  view.inputOn = false;
  view.captured = false;
}

/** The input on a view follows what its stop takes from this window: none while it takes none. */
function syncInput(key: string, view: LiveView, on: boolean, clickCounts: boolean): void {
  if (on && !view.input) {
    view.input = new ViewInputBatcher({ send: (events) => sendInput(key, view, events), clickCounts });
  }
  if (!on) stopInput(view);
  view.inputOn = on;
  if (on && hintFor === null) hintFor = `${key}|${view.since}`;
}

/** Sends a batch of input for the stop a view watches, while it does; a refusal shows once under the test. */
async function sendInput(key: string, view: LiveView, events: ViewInput[]): Promise<boolean> {
  if (views.get(key) !== view || !view.inputOn) return false;
  const answer = await command(view.hub, view.ref, view.worker, 'input', view.since, { events });
  if (answer.ok || views.get(key) !== view) return answer.ok;
  if (answers.get(key)?.text !== failureText(answer)) {
    say(key, answer, view.since);
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
  view.note = t('runs_liveLost');
  view.next = null;
  view.img.removeAttribute('src');
  view.viewport = null;
  announce(view.note);
  render();
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

/** The live view's image: the pointer, the wheel, the keys and a paste on it go to the page while it takes input. */
function liveImage(key: string, view: LiveView): void {
  const { img } = view;
  img.draggable = false;
  img.dataset.focus = `${key}|view`;
  const at = (event: MouseEvent) => (view.viewport ? pointOn(img, event, view.viewport) : null);
  /** Where the pointer event before a mouse event put the pointer: a mouse event's own point is whole pixels. */
  let pointed: { x: number; y: number } | null = null;
  img.addEventListener('pointerdown', (event) => {
    if (event.shiftKey || picking.has(key)) {
      // No mouse event follows: the page gets nothing of it.
      event.preventDefault();
      if (view.viewport) void pickOnImage(key, view.since, img, event, view.viewport);
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
      { mac: MAC, captured: view.captured },
    );
    if (decided === 'leave') {
      // The keyboard back to the window, on Watch live; Pick on the image, waiting, stops too.
      event.preventDefault();
      view.captured = false;
      if (picking.delete(key)) render();
      document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(`${key}|live`)}"]`)?.focus();
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
  say(key, answer, since, { sent: true, rich: true });
  render();
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || picking.size === 0) return;
  picking.clear();
  render();
});

// A window the person cannot see watches nothing: its views stop, and come again as it shows, Watch live left on.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    render();
    return;
  }
  for (const [key, view] of views) if (isLive(view)) endView(key, true);
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
      .create({ url: 'https://piwitests.dev/features/runs-window#the-run-shortcut' })
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
  announceChanges(next);
  render();
  document.documentElement.dataset.ready = '';
}

/** Says what changed since the last state: a test stopped or went on, a run ended. Nothing for the first state. */
function announceChanges(next: RunsState): void {
  const now = new Map<string, { state: HubWorker['state']; since: string | null }>();
  const live = new Set<string>();
  const said: string[] = [];
  for (const run of next.runs) {
    const runKey = `${run.hub}|${run.session.ref}`;
    if (run.session.ended) {
      if (liveSeen.has(runKey)) said.push(t('runs_announceEnded', { run: runName(run.session) }));
      continue;
    }
    live.add(runKey);
    for (const worker of run.session.workers) {
      const key = workerKey(run.hub, run.session.ref, worker);
      const since = worker.stop?.since ?? null;
      now.set(key, { state: worker.state, since });
      const before = seen?.get(key);
      const test = worker.test ? testName(worker.test) : runName(run.session);
      if (!seen) continue;
      if (worker.state === 'stopped' && worker.stop && before?.since !== since) {
        const place = stopPlace(worker.stop, run.session.root);
        said.push(
          t(worker.stop.reason === 'failure' ? 'runs_announceFailed' : 'runs_announceStopped', { test, place }),
        );
      } else if (before?.state === 'stopped' && worker.state !== 'stopped') {
        said.push(t('runs_announceRunning', { test }));
      }
    }
  }
  seen = now;
  liveSeen = live;
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
  return session.project ?? session.label ?? t('runs_run');
}

function render(): void {
  if (!state) return;
  const current = state;
  used = new Set();
  renderHubs(current);
  renderEmpty(current);
  place(
    runsList,
    current.runs.map((run) => renderRun(current, run)),
  );
  for (const key of drawn.keys()) if (!used.has(key)) drawn.delete(key);
  forgetGone(current);
  restoreFocus();
}

/**
 * Drops what is kept for a stop a worker no longer stands at: its image, its live view, its list of requests, an
 * answer for it; and Watch live for a worker whose run ended. A view whose hub's connection was lost stays shown as
 * ended while the hub is away, so the run that comes back at the same stop says so.
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
  for (const [key, view] of views) {
    if (at.get(key) === view.since) continue;
    if (!at.has(key) && view.status === 'ended' && !connected(view.hub)) continue;
    endView(key, false);
  }
  for (const [key, hub] of watchLive) if (!at.has(key) && connected(hub)) watchLive.delete(key);
  for (const key of picking) if (!at.get(key)) picking.delete(key);
  for (const [key, list] of requestLists) if (at.get(key) !== list.since) requestLists.delete(key);
  for (const [key, answer] of answers) if (!at.has(key) || at.get(key) !== answer.since) answers.delete(key);
}

function renderHubs(current: RunsState): void {
  const connected = current.hubs.filter((hub) => hub.connected).length;
  // The window follows the editor while any of its windows answers: one that does not is found again meanwhile.
  const away = connected === 0 ? current.hubs[0] : undefined;
  hubsLine.hidden = current.hubs.length === 0;
  hubsLine.classList.toggle('waiting', !!away);
  if (away) iconText(hubsLine, 'clock', t('runs_reconnecting', { editor: away.client ?? t('runs_editor') }));
  else iconText(hubsLine, 'check-circle', tn('runs_following', connected));
}

type EmptyAction = 'settings' | 'again';

/** Why there is nothing to show, and what to do: its icon, its sentence and its buttons. */
function emptyOf(current: RunsState): [IconName, string, EmptyAction[]] {
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
      return ['alert', t('runs_statusUnproven'), ['again']];
    default:
      if (current.hubs.length === 0) return ['plug', t('runs_statusNoHub'), ['again']];
      if (!current.hubs.some((hub) => hub.connected)) return ['clock', t('runs_statusSearching'), []];
      return ['play', t('runs_statusNoRuns'), []];
  }
}

/** What the empty box shows, as last drawn. */
let emptyShown = '';

function renderEmpty(current: RunsState): void {
  empty.hidden = current.runs.length > 0;
  if (empty.hidden) return;
  const [icon, text, actions] = emptyOf(current);
  const shown = JSON.stringify([icon, text, actions]);
  if (shown === emptyShown) return;
  emptyShown = shown;
  iconText(emptyText, icon, text);
  emptyActions.replaceChildren(
    ...actions.map((action) => {
      const button =
        action === 'settings'
          ? makeButton(t('runs_openSettings'), () => void chrome.runtime.openOptionsPage(), { icon: 'settings' })
          : makeButton(t('runs_findAgain'), () => post({ type: 'find' }), { icon: 'refresh' });
      button.dataset.focus = `empty|${action}`;
      return button;
    }),
  );
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
  const client = current.hubs.find((hub) => hub.id === run.hub)?.client ?? null;
  const children = [
    part(`${runKey}|head`, { headingId, name, client, command: session.command }, () => {
      const heading = element('h2', undefined, name);
      heading.id = headingId;
      const title = element('div', 'run-title', heading);
      if (client) title.append(element('span', 'client', client));
      const head = element('div', 'run-head', title);
      if (session.command) {
        const code = element('code', 'command', session.command);
        code.title = session.command;
        head.append(code);
      }
      return head;
    }),
  ];
  if (session.ended) {
    children.push(
      part(`${runKey}|ended`, null, () => iconText(element('p', 'run-ended'), 'check-circle', t('runs_ended'))),
    );
  }
  const workers = [...session.workers].sort((a, b) => a.parallelIndex - b.parallelIndex);
  if (workers.length > 0) {
    const list = part(`${runKey}|workers`, null, () => element('ul', 'workers'));
    place(
      list,
      workers.map((worker) => renderWorker(run, worker, workers.length)),
    );
    children.push(list);
  }
  place(section, children);
  return section;
}

/** The state line of a stop, by its reason; a failure's names where it failed instead (`runs_failedAt`). */
const STOP_WORDS = {
  breakpoint: 'runs_stoppedBreakpoint',
  step: 'runs_stoppedStep',
  pause: 'runs_stoppedPause',
  'run-to': 'runs_stoppedRunTo',
  'page-pause': 'runs_stoppedPagePause',
  other: 'runs_stoppedOther',
} as const satisfies Record<Exclude<HubStop['reason'], 'failure'>, string>;

function stateLine(worker: HubWorker, count: number, place: string | null): HTMLElement {
  const line = element('p', 'state');
  const stop = worker.state === 'stopped' ? worker.stop : null;
  if (stop?.reason === 'failure') iconText(line, 'x-circle', t('runs_failedAt', { place: place ?? '' }));
  else if (stop) iconText(line, 'pause', t(STOP_WORDS[stop.reason]));
  else if (worker.pausing) iconText(line, 'clock', t('runs_statePausing'));
  else if (worker.state === 'running') iconText(line, 'play', t('runs_stateRunning'));
  else iconText(line, 'dot', t('runs_stateBetween'));
  if (count > 1) line.append(element('span', 'worker-number', t('runs_worker', { number: worker.parallelIndex + 1 })));
  return line;
}

/** The window's controls: each button's words, tooltip, icon and tone. */
const CONTROLS = {
  resume: { label: 'runs_resume', title: 'runs_resumeTitle', icon: 'play', tone: 'primary' },
  step: { label: 'runs_step', title: 'runs_stepTitle', icon: 'skip' },
  finish: { label: 'runs_finish', title: 'runs_finishTitle', icon: 'next' },
  pick: { label: 'runs_pick', title: 'runs_pickTitle', icon: 'pick' },
  record: { label: 'runs_record', title: 'runs_recordTitle', icon: 'record' },
  assert: { label: 'runs_assert', title: 'runs_assertTitle', icon: 'check-circle' },
  'assert-region': { label: 'runs_assertRegion', title: 'runs_assertRegionTitle', icon: 'layers' },
  mock: { label: 'runs_mock', title: 'runs_mockTitle', icon: 'network' },
  pause: { label: 'runs_pause', title: 'runs_pauseTitle', icon: 'pause' },
} as const satisfies Record<
  Exclude<RunsWhat, 'image' | 'requests' | 'view' | 'input' | 'pick-at'>,
  { label: string; title: string; icon: IconName; tone?: 'primary' }
>;

type Control = keyof typeof CONTROLS;

/** The controls that steer the test, on a row of their own above the code a stop can write. */
const STEERING: ReadonlySet<Control> = new Set(['resume', 'step', 'finish', 'pause']);

/**
 * The controls a worker takes now: at a stop, Resume, Step and Finish (Resume alone where the test failed, which ends
 * it as it failed); then the actions the stop takes from this window (`stopIntents`): Pick, Record, Assert and Assert
 * a region, which start in the test's window where the pause bar shows, or through the live view this window watches
 * at a headless stop, and Mock a request.
 */
function controlsOf(worker: HubWorker, stop: HubStop | null): Control[] {
  if (!stop) return worker.pausing ? [] : ['pause'];
  const controls: Control[] = stop.reason === 'failure' ? ['resume'] : ['resume', 'step', 'finish'];
  const intents = stopIntents(worker, stop);
  controls.push(...IN_WINDOW.filter((what) => intents.includes(what)));
  if (intents.includes('mock')) controls.push('mock');
  return controls;
}

function renderActions(run: RunsRun, worker: HubWorker, controls: Control[], stop: HubStop | null): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const since = stop?.since ?? null;
  const steering = element('div', 'piwi-actions');
  const code = element('div', 'piwi-actions');
  code.setAttribute('role', 'group');
  code.setAttribute('aria-label', t('runs_codeActions'));
  for (const what of controls) {
    const look = CONTROLS[what];
    // Mock a request opens the list of the stop's requests; the other controls send themselves.
    const onClick = () => {
      if (what !== 'mock') void control(run, worker.worker, what, since);
      else if (since !== null) void toggleRequests(run, worker.worker, since);
    };
    const made = makeButton(t(look.label), onClick, {
      icon: look.icon,
      tone: 'tone' in look ? look.tone : undefined,
      title: what === 'resume' && stop?.reason === 'failure' ? t('runs_resumeFailureTitle') : t(look.title),
    });
    made.dataset.focus = `${key}|${what}`;
    (STEERING.has(what) ? steering : code).append(made);
  }
  const actions = element('div', 'controls');
  actions.append(...[steering, code].filter((row) => row.childElementCount > 0));
  return actions;
}

/** Marks the buttons of a worker that wait for a command's answer (`aria-disabled`): they keep the focus. */
function markBusy(buttons: Iterable<Element>, waiting: boolean): void {
  for (const button of buttons) {
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

function renderWorker(run: RunsRun, worker: HubWorker, count: number): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const { ended } = run.session;
  const item = part(`${key}|item`, null, () => element('li', 'worker'));
  item.dataset.state = ended ? 'ended' : worker.state;
  const parts: HTMLElement[] = [];
  const stop = !ended && worker.state === 'stopped' ? worker.stop : null;
  const where = stop ? stopPlace(stop, run.session.root) : null;
  item.toggleAttribute('data-failed', stop?.reason === 'failure');
  // An ended run names the tests it ran last; the hub says nothing of how they ended.
  if (!ended) {
    const shown = {
      state: worker.state,
      reason: stop?.reason ?? null,
      place: stop?.reason === 'failure' ? where : null,
      pausing: worker.pausing,
      number: count > 1 ? worker.parallelIndex : null,
    };
    parts.push(part(`${key}|state`, shown, () => stateLine(worker, count, where)));
  }
  const test = worker.test;
  if (test) {
    const name = testName(test);
    parts.push(part(`${key}|test`, name, () => element('p', 'test', name)));
    const meta = [test.project, t('runs_attempt', { attempt: test.retry + 1 })].filter(Boolean).join(' · ');
    parts.push(part(`${key}|meta`, meta, () => element('p', 'meta', meta)));
    const reason = test.cannotPause;
    if (reason && !ended) {
      parts.push(
        part(`${key}|cannot`, reason, () => iconText(element('p', 'note'), 'info', t('runs_cannotPause', { reason }))),
      );
    }
  }
  if (!ended) {
    if (stop && where) {
      const stopShown = { title: stop.title, where, reason: stop.reason, error: stop.error ?? null };
      parts.push(part(`${key}|stop`, stopShown, () => stopView(stop, where)));
      wantImage(run, worker, stop);
      parts.push(renderPage(run, worker, stop));
    }
    const since = stop?.since ?? null;
    const list = stop ? requestLists.get(key) : undefined;
    const listed = list?.since === since ? list : undefined;
    const controls = controlsOf(worker, stop);
    if (controls.length > 0) {
      // Drawn again for another stop, so each control answers the stop shown; a command on its way leaves them be.
      const failure = stop?.reason === 'failure';
      const actions = part(`${key}|actions`, { controls, since, failure }, () =>
        renderActions(run, worker, controls, stop),
      );
      markBusy(actions.querySelectorAll('button'), busy.has(key));
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
      if (answer.warnings.length > 0) parts.push(part(`${key}|warnings`, answer.warnings, () => warningList(answer)));
    }
    if (listed) {
      const requests = part(`${key}|requests`, { since: listed.since, serial: listed.serial }, () =>
        renderRequests(run, worker, listed),
      );
      markBusy(requests.querySelectorAll('button.request'), busy.has(key));
      parts.push(requests);
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

/** Where the test stands: the call about to run and its place; where it failed, the error alone, its place above. */
function stopView(stop: HubStop, where: string): HTMLElement {
  if (stop.reason === 'failure') {
    return element(
      'dl',
      'stop',
      element('dt', undefined, t('runs_errorLabel')),
      element('dd', 'error', ...richText(stopError(stop))),
    );
  }
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
 * The stopped page: Watch live and Pick on the image where the stop takes them, then its live view once a frame came
 * (the Live badge on it), else its image; under it, why there is none, or why the view ended, and the first time the
 * view takes input, how. The image's box stays the same element for the stop, so the live view keeps the focus.
 */
function renderPage(run: RunsRun, worker: HubWorker, stop: HubStop): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const intents: HubAction[] = stopIntents(worker, stop);
  const kept = images.get(key);
  const still = kept?.since === stop.since ? kept : undefined;
  if (views.get(key)?.since !== stop.since) endView(key, false);
  const canView = intents.includes('view');
  if (canView && watchLive.has(key) && !views.has(key) && !document.hidden) startView(run, worker.worker, stop);
  const view = views.get(key);
  const live = isLive(view);
  const framed = live && !!view.viewport;
  if (view) {
    syncInput(key, view, framed && view.status === 'on' && intents.includes('input'), intents.includes('input-clicks'));
  }
  const pickable = intents.includes('pick-at') && (framed || !!still?.viewport);
  if (!pickable) picking.delete(key);

  const figure = part(`${key}|page`, stop.since, () => element('figure', 'page'));
  figure.toggleAttribute('data-picking', picking.has(key));
  const children: HTMLElement[] = [];
  if (canView || pickable) {
    const tools = { canView, live, pickable, picking: picking.has(key) };
    const row = part(`${key}|page-tools`, tools, () => pageTools(run, worker.worker, stop, tools));
    markBusy(row.querySelectorAll(`[data-focus="${CSS.escape(`${key}|pick-at`)}"]`), busy.has(key));
    children.push(row);
  }
  const shown = framed ? view.img : (still?.img ?? null);
  if (shown) {
    const box = part(`${key}|frame`, stop.since, () => element('div', 'page-frame'));
    if (framed) {
      view.img.alt = t(view.inputOn ? 'runs_liveAltInput' : 'runs_liveAlt');
      if (view.inputOn) view.img.tabIndex = 0;
      else view.img.removeAttribute('tabindex');
    }
    place(box, framed ? [shown, part(`${key}|badge`, null, liveBadge)] : [shown]);
    children.push(box);
  }
  const note = pageNote(view, live, framed, shown, still);
  if (note) {
    children.push(
      part(`${key}|page-note`, note, () =>
        note.icon ? iconText(element('p', 'view-note'), note.icon, note.text) : element('p', undefined, note.text),
      ),
    );
  }
  if (view?.inputOn && hintFor === `${key}|${view.since}`) {
    children.push(
      part(`${key}|hint`, null, () => iconText(element('p', 'view-note hint'), 'info', t('runs_liveHint'))),
    );
  }
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

/** Watch live and Pick on the image, each a toggle saying whether it is on. */
function pageTools(
  run: RunsRun,
  worker: number,
  stop: HubStop,
  shown: { canView: boolean; live: boolean; pickable: boolean; picking: boolean },
): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, { worker });
  const row = element('div', 'piwi-actions page-tools');
  if (shown.canView) {
    const live = makeButton(t('runs_live'), () => toggleLive(run, worker, stop), {
      icon: 'eye',
      small: true,
      title: t('runs_liveTitle'),
    });
    live.setAttribute('aria-pressed', String(shown.live));
    live.dataset.focus = `${key}|live`;
    row.append(live);
  }
  if (shown.pickable) {
    const pick = makeButton(
      t('runs_pickAt'),
      (event) => {
        // A command on its way: the button says so (`aria-disabled`) and waits for it.
        if ((event.currentTarget as HTMLElement).getAttribute('aria-disabled') !== 'true') togglePicking(key);
      },
      { icon: 'pointer', small: true, title: t('runs_pickAtTitle') },
    );
    pick.setAttribute('aria-pressed', String(shown.picking));
    pick.dataset.focus = `${key}|pick-at`;
    row.append(pick);
  }
  return row;
}

/** The badge on a live view: a dot and the word, drawn still (no animation). */
function liveBadge(): HTMLElement {
  const badge = element('span', 'live-badge', icon('dot'), t('runs_liveBadge'));
  // The view's own name says it is live.
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
  const near = owner ? document.querySelector<HTMLElement>(`[data-focus^="${CSS.escape(owner)}"]`) : null;
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

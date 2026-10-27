import { LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import type { HubImage, HubKeptRequest, HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { decorateIcons, iconText, setLabel, type IconName } from '../shared/icons.js';
import { formatUnit, initI18n, localizeDocument, t, tn, tNodes } from '../shared/i18n.js';
import {
  RUNS_PING_MS,
  RUNS_PORT,
  RUN_COMMAND,
  stopPlace,
  testName,
  workerKey,
  type RunsAnswer,
  type RunsEvent,
  type RunsRequest,
  type RunsRun,
  type RunsState,
  type RunsWhat,
} from '../shared/runs.js';
import { STEP_CSS, richText, urlView } from '../shared/step-view.js';

/**
 * The Runs window: the runs the paired editor started, each worker's test and where it stands, an image of a stopped
 * page, and the controls, with the code a stop can write (Pick, Record, Assert, Assert a region, Mock a request) as
 * the worker's reporter and the editor take them. Opened from the popup's Runs tile in a small window of its own. It
 * reads everything from the background worker through its port (`RUNS_PORT`), and makes no network call: the worker
 * holds the hubs' connections and tokens. The code itself never comes here: the editor writes it, and the window
 * shows what it answered. What a hub sends is shown as text, and its image as an image. Each part of the window is
 * drawn again only when what it shows changes (`part`), so a button under the pointer or the keyboard stays the same
 * element while the run goes on around it.
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
/** The image of each stopped worker's page, for the stop it was taken at. */
const images = new Map<string, { since: string; loading: boolean; img: HTMLImageElement | null; note: string }>();
/**
 * What the last command for a worker answered, when there is something to say, for the stop it was sent at (null for
 * Pause): shown while the worker stands there, and gone with that stop. `written` when the editor wrote code.
 */
const answers = new Map<string, { ok: boolean; text: string; since: string | null; written: boolean }>();
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

function command(
  run: RunsRun,
  worker: number | null,
  what: RunsWhat,
  since: string | null,
  request?: number,
): Promise<RunsAnswer> {
  const id = nextId++;
  return new Promise((resolve) => {
    if (!port) {
      resolve({ ok: false, message: '', failure: 'offline' });
      return;
    }
    waiting.set(id, resolve);
    const asked = { type: 'command', id, hub: run.hub, ref: run.session.ref, worker, since, what } as const;
    post(request === undefined ? asked : { ...asked, request });
  });
}

function failureText(answer: RunsAnswer): string {
  if (answer.failure === 'offline') return t('runs_failOffline');
  if (answer.failure === 'timeout') return t('runs_failTimeout');
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
  request?: number,
): Promise<RunsAnswer | null> {
  const key = workerKey(run.hub, run.session.ref, { worker });
  // A command on its way: the buttons say so (`aria-disabled`) and take no other until it is answered.
  if (busy.has(key)) return null;
  // Every control but Pause answers the stop shown.
  if (what !== 'pause' && since === null) return null;
  busy.add(key);
  answers.delete(key);
  render();
  const answer = await command(run, worker, what, since, request);
  busy.delete(key);
  if (stopNow(run, worker) === since) return answer;
  render();
  return null;
}

/** Shows what a command answered under the test, and reads it out. */
function say(key: string, answer: RunsAnswer, since: string | null, written = false): void {
  const text = answer.ok ? answer.message : failureText(answer);
  answers.set(key, { ok: answer.ok, text, since, written: answer.ok && written });
  if (text) announce(text);
}

/** The intents a stop starts in the test's window, which say there what to do. */
const IN_WINDOW = ['pick', 'record', 'assert', 'assert-region'] as const;

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

/** Mocks the request chosen in the list: the editor writes the code; the list closes once it did. */
async function mockRequest(run: RunsRun, worker: number, since: string, request: number): Promise<void> {
  const key = workerKey(run.hub, run.session.ref, { worker });
  const answer = await send(run, worker, 'mock', since, request);
  if (!answer) return;
  say(key, answer, since, true);
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
  images.set(key, { since: stop.since, loading: true, img: null, note: '' });
  void command(run, worker.worker, 'image', stop.since).then((answer) => {
    if (images.get(key)?.since !== stop.since) return;
    let img: HTMLImageElement | null = null;
    if (answer.ok && isImage(answer.image)) {
      // One element per stop, moved into each rendering, so the image is decoded once.
      img = element('img');
      img.alt =
        stop.reason === 'failure'
          ? t('runs_imageAltFailure', { error: failureOf(stop.title) })
          : t('runs_imageAlt', { call: stop.title });
      img.src = `data:image/jpeg;base64,${answer.image.data}`;
    }
    images.set(key, { since: stop.since, loading: false, img, note: img ? '' : failureText(answer) });
    render();
  });
}

/** An image to show: a JPEG in base64, checked again before it goes into an address. */
function isImage(image: HubImage | null | undefined): image is HubImage {
  return !!image && image.mime === 'image/jpeg' && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data);
}

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
      .create({ url: 'https://piwitests.dev/features/extension#runs-from-the-editor' })
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

/** Drops what is kept for a stop a worker no longer stands at: its image, its list of requests, an answer for it. */
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

/**
 * The error a failure's stop names, under its label: the reporter titles the stop `Failed: ` and the error's first
 * line, which Playwright starts with the error's name (`Error: expect(locator).toBeVisible() failed`).
 */
function failureOf(title: string): string {
  return title.replace(/^Failed:\s*(?:Error:\s*)?/, '');
}

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
  Exclude<RunsWhat, 'image' | 'requests'>,
  { label: string; title: string; icon: IconName; tone?: 'primary' }
>;

type Control = keyof typeof CONTROLS;

/** The controls that steer the test, on a row of their own above the code a stop can write. */
const STEERING: ReadonlySet<Control> = new Set(['resume', 'step', 'finish', 'pause']);

/**
 * The controls a worker takes now: at a stop, Resume, Step and Finish (Resume alone where the test failed, which ends
 * it as it failed); then the actions its reporter and the editor take (`intents`): Pick, Record, Assert and Assert a
 * region where the pause bar shows, which they start in the test's window, and Mock a request at any stop.
 */
function controlsOf(worker: HubWorker, stop: HubStop | null): Control[] {
  if (!stop) return worker.pausing ? [] : ['pause'];
  const controls: Control[] = stop.reason === 'failure' ? ['resume'] : ['resume', 'step', 'finish'];
  if (stop.bar) controls.push(...IN_WINDOW.filter((what) => worker.intents.includes(what)));
  if (worker.intents.includes('mock')) controls.push('mock');
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
      parts.push(part(`${key}|stop`, { title: stop.title, where, reason: stop.reason }, () => stopView(stop, where)));
      wantImage(run, worker, stop);
      const kept = images.get(key);
      const image = kept?.since === stop.since ? { ...kept, img: !!kept.img } : { since: stop.since };
      parts.push(part(`${key}|image`, image, () => renderImage(key, stop)));
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
        : answer.written
          ? ['note written', 'check-circle']
          : ['note', 'info'];
      parts.push(part(`${key}|answer`, answer, () => iconText(element('p', className), icon, answer.text)));
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

/** Where the test stands: the call about to run and its place; where it failed, the error alone, its place above. */
function stopView(stop: HubStop, where: string): HTMLElement {
  if (stop.reason === 'failure') {
    return element(
      'dl',
      'stop',
      element('dt', undefined, t('runs_errorLabel')),
      element('dd', 'error', ...richText(failureOf(stop.title))),
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

function renderImage(key: string, stop: HubStop): HTMLElement {
  const figure = element('figure', 'page');
  const kept = images.get(key);
  if (kept?.since === stop.since && kept.img) {
    figure.append(kept.img);
  } else if (kept?.since === stop.since && !kept.loading) {
    figure.append(element('p', undefined, kept.note || t('runs_imageNone')));
  } else {
    figure.append(element('p', undefined, t('runs_imageLoading')));
  }
  return figure;
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

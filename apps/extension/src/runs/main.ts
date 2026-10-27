import { LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import type { HubImage, HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { decorateIcons, iconText, setLabel, type IconName } from '../shared/icons.js';
import { initI18n, localizeDocument, t, tn, tNodes } from '../shared/i18n.js';
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
import { STEP_CSS, richText } from '../shared/step-view.js';

/**
 * The Runs window: the runs the paired editor started, each worker's test and where it stands, an image of a stopped
 * page, and the controls. Opened from the popup's Runs tile in a small window of its own. It reads everything from
 * the background worker through its port (`RUNS_PORT`), and makes no network call: the worker holds the hubs'
 * connections and tokens. What a hub sends is shown as text, and its image as an image. Each part of the window is
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
/** What the last command for a worker answered, when there is something to say. */
const answers = new Map<string, { ok: boolean; text: string }>();
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

function command(run: RunsRun, worker: number | null, what: RunsWhat, since: string | null): Promise<RunsAnswer> {
  const id = nextId++;
  return new Promise((resolve) => {
    if (!port) {
      resolve({ ok: false, message: '', failure: 'offline' });
      return;
    }
    waiting.set(id, resolve);
    post({ type: 'command', id, hub: run.hub, ref: run.session.ref, worker, since, what });
  });
}

function failureText(answer: RunsAnswer): string {
  if (answer.failure === 'offline') return t('runs_failOffline');
  if (answer.failure === 'timeout') return t('runs_failTimeout');
  return answer.message;
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A control of the window, for the stop its button was drawn for (`since`, null for Pause). */
async function control(run: RunsRun, worker: number, what: RunsWhat, since: string | null): Promise<void> {
  const key = workerKey(run.hub, run.session.ref, { worker });
  // A command on its way: the buttons say so (`aria-disabled`) and take no other until it is answered.
  if (busy.has(key)) return;
  // Every control but Pause answers the stop shown.
  if (what !== 'pause' && since === null) return;
  busy.add(key);
  answers.delete(key);
  render();
  const answer = await command(run, worker, what, what === 'pause' ? null : since);
  busy.delete(key);
  // Pick and Record say what to do in the test's window; the other controls show in the state that follows.
  if (!answer.ok || what === 'pick' || what === 'record') {
    const text = answer.ok ? answer.message : failureText(answer);
    answers.set(key, { ok: answer.ok, text });
    if (text) announce(text);
  }
  render();
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
      img.alt = t('runs_imageAlt', { call: stop.title });
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
        said.push(t('runs_announceStopped', { test, place: stopPlace(worker.stop, run.session.root) }));
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

/** Drops what is kept for workers no longer stopped, or gone. */
function forgetGone(current: RunsState): void {
  const stopped = new Set<string>();
  const present = new Set<string>();
  for (const run of current.runs) {
    for (const worker of run.session.workers) {
      const key = workerKey(run.hub, run.session.ref, worker);
      present.add(key);
      if (!run.session.ended && worker.state === 'stopped') stopped.add(key);
    }
  }
  for (const key of images.keys()) if (!stopped.has(key)) images.delete(key);
  for (const key of answers.keys()) if (!present.has(key)) answers.delete(key);
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

const STOP_WORDS = {
  breakpoint: 'runs_stoppedBreakpoint',
  step: 'runs_stoppedStep',
  pause: 'runs_stoppedPause',
  'run-to': 'runs_stoppedRunTo',
  'page-pause': 'runs_stoppedPagePause',
  other: 'runs_stoppedOther',
} as const;

function stateLine(worker: HubWorker, count: number): HTMLElement {
  const line = element('p', 'state');
  if (worker.state === 'stopped' && worker.stop) iconText(line, 'pause', t(STOP_WORDS[worker.stop.reason]));
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
  pause: { label: 'runs_pause', title: 'runs_pauseTitle', icon: 'pause' },
} as const satisfies Record<
  Exclude<RunsWhat, 'image'>,
  { label: string; title: string; icon: IconName; tone?: 'primary' }
>;

type Control = keyof typeof CONTROLS;

/** The controls a worker takes now: at a stop, Resume, Step and Finish, and Pick and Record where the bar shows. */
function controlsOf(worker: HubWorker, stop: HubStop | null): Control[] {
  if (!stop) return worker.pausing ? [] : ['pause'];
  const controls: Control[] = ['resume', 'step', 'finish'];
  if (stop.bar && worker.intents.includes('pick')) controls.push('pick');
  if (stop.bar && worker.intents.includes('record')) controls.push('record');
  return controls;
}

function renderActions(run: RunsRun, worker: HubWorker, controls: Control[], since: string | null): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const actions = element('div', 'piwi-actions');
  for (const what of controls) {
    const look = CONTROLS[what];
    const made = makeButton(t(look.label), () => void control(run, worker.worker, what, since), {
      icon: look.icon,
      tone: 'tone' in look ? look.tone : undefined,
      title: t(look.title),
    });
    made.dataset.focus = `${key}|${what}`;
    actions.append(made);
  }
  return actions;
}

function renderWorker(run: RunsRun, worker: HubWorker, count: number): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const { ended } = run.session;
  const item = part(`${key}|item`, null, () => element('li', 'worker'));
  item.dataset.state = ended ? 'ended' : worker.state;
  const parts: HTMLElement[] = [];
  // An ended run names the tests it ran last; the hub says nothing of how they ended.
  if (!ended) {
    const shown = {
      state: worker.state,
      reason: worker.state === 'stopped' ? (worker.stop?.reason ?? null) : null,
      pausing: worker.pausing,
      number: count > 1 ? worker.parallelIndex : null,
    };
    parts.push(part(`${key}|state`, shown, () => stateLine(worker, count)));
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
    const stop = worker.state === 'stopped' ? worker.stop : null;
    if (stop) {
      const where = stopPlace(stop, run.session.root);
      parts.push(
        part(`${key}|stop`, { title: stop.title, where }, () =>
          element(
            'dl',
            'stop',
            element('dt', undefined, t('runs_nextLabel')),
            element('dd', undefined, ...richText(stop.title)),
            element('dt', undefined, t('runs_whereLabel')),
            element('dd', 'place', where),
          ),
        ),
      );
      wantImage(run, worker, stop);
      const kept = images.get(key);
      const image = kept?.since === stop.since ? { ...kept, img: !!kept.img } : { since: stop.since };
      parts.push(part(`${key}|image`, image, () => renderImage(key, stop)));
    }
    const controls = controlsOf(worker, stop);
    if (controls.length > 0) {
      // Drawn again for another stop, so each control answers the stop shown; a command on its way leaves them be.
      const since = stop?.since ?? null;
      const actions = part(`${key}|actions`, { controls, since }, () => renderActions(run, worker, controls, since));
      for (const button of actions.querySelectorAll('button')) {
        if (busy.has(key)) button.setAttribute('aria-disabled', 'true');
        else button.removeAttribute('aria-disabled');
      }
      parts.push(actions);
    }
    const answer = answers.get(key);
    if (answer) {
      parts.push(
        part(`${key}|answer`, answer, () =>
          iconText(element('p', answer.ok ? 'note' : 'answer'), answer.ok ? 'info' : 'alert', answer.text),
        ),
      );
    }
  }
  place(item, parts);
  return item;
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

import { LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import type { HubImage, HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { decorateIcons, iconText, type IconName } from '../shared/icons.js';
import { initI18n, localizeDocument, t, tn } from '../shared/i18n.js';
import {
  RUNS_PING_MS,
  RUNS_PORT,
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
 * connections and tokens. What a hub sends is shown as text, and its image as an image.
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

async function control(run: RunsRun, worker: HubWorker, what: RunsWhat): Promise<void> {
  const key = workerKey(run.hub, run.session.ref, worker);
  const since = what === 'pause' ? null : (worker.stop?.since ?? null);
  // Every control but Pause answers the stop shown.
  if (what !== 'pause' && since === null) return;
  busy.add(key);
  answers.delete(key);
  render();
  const answer = await command(run, worker.worker, what, since);
  busy.delete(key);
  // Pick and Record say what to do in the test's window; the other controls show in the state that follows.
  if (!answer.ok || what === 'pick' || what === 'record') {
    answers.set(key, { ok: answer.ok, text: answer.ok ? answer.message : failureText(answer) });
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

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────────────────────────

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
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus ?? null;
  renderHubs(state);
  renderEmpty(state);
  runsList.replaceChildren(...state.runs.map((run, index) => renderRun(state!, run, index)));
  forgetGone(state);
  if (focused) document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
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
  const connected = current.hubs.filter((hub) => hub.connected);
  const away = current.hubs.find((hub) => !hub.connected);
  hubsLine.hidden = current.hubs.length === 0;
  hubsLine.classList.toggle('waiting', !!away);
  if (away) iconText(hubsLine, 'clock', t('runs_reconnecting', { editor: away.client ?? t('runs_editor') }));
  else iconText(hubsLine, 'check-circle', tn('runs_following', connected.length));
}

function renderEmpty(current: RunsState): void {
  const settings = () =>
    makeButton(t('runs_openSettings'), () => void chrome.runtime.openOptionsPage(), { icon: 'settings' });
  const again = () => makeButton(t('runs_findAgain'), () => post({ type: 'find' }), { icon: 'refresh' });
  const show = (icon: IconName, text: string, ...actions: HTMLElement[]) => {
    iconText(emptyText, icon, text);
    emptyActions.replaceChildren(...actions);
    for (const button of actions) button.dataset.focus = `empty|${button.textContent}`;
  };
  empty.hidden = current.runs.length > 0;
  if (!empty.hidden) {
    switch (current.discovery) {
      case 'searching':
        return show('clock', t('runs_statusSearching'));
      case 'unpaired':
        return show('link', t('runs_statusUnpaired'), settings());
      case 'no-access':
        return show('lock', t('runs_statusNoAccess'), settings());
      case 'refused':
        return show('alert', t('runs_statusRefused'), settings());
      case 'unreachable':
        return show('plug', t('runs_statusUnreachable'), again());
      case 'outdated':
        return show('alert', t('runs_statusOutdated'), again());
      case 'unproven':
        return show('alert', t('runs_statusUnproven'), again());
      default:
        if (current.hubs.length === 0) return show('plug', t('runs_statusNoHub'), again());
        if (!current.hubs.some((hub) => hub.connected)) return show('clock', t('runs_statusSearching'));
        return show('play', t('runs_statusNoRuns'));
    }
  }
}

function renderRun(current: RunsState, run: RunsRun, index: number): HTMLElement {
  const { session } = run;
  const section = element('section', session.ended ? 'run ended' : 'run');
  const headingId = `run-${index}`;
  section.setAttribute('aria-labelledby', headingId);
  const heading = element('h2', undefined, runName(session));
  heading.id = headingId;
  const client = current.hubs.find((hub) => hub.id === run.hub)?.client;
  const title = element('div', 'run-title', heading);
  if (client) title.append(element('span', 'client', client));
  const head = element('div', 'run-head', title);
  if (session.command) {
    const code = element('code', 'command', session.command);
    code.title = session.command;
    head.append(code);
  }
  section.append(head);
  if (session.ended) {
    section.append(iconText(element('p', 'run-ended'), 'check-circle', t('runs_ended')));
  }
  const workers = [...session.workers].sort((a, b) => a.parallelIndex - b.parallelIndex);
  if (workers.length > 0) {
    section.append(element('ul', 'workers', ...workers.map((worker) => renderWorker(run, worker, workers.length))));
  }
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

function renderWorker(run: RunsRun, worker: HubWorker, count: number): HTMLElement {
  const key = workerKey(run.hub, run.session.ref, worker);
  const item = element('li', 'worker');
  item.dataset.state = run.session.ended ? 'ended' : worker.state;
  // An ended run names the tests it ran last; the hub says nothing of how they ended.
  if (!run.session.ended) item.append(stateLine(worker, count));
  if (worker.test) {
    item.append(element('p', 'test', testName(worker.test)));
    const meta = [worker.test.project, t('runs_attempt', { attempt: worker.test.retry + 1 })].filter(Boolean);
    item.append(element('p', 'meta', meta.join(' · ')));
    if (worker.test.cannotPause && !run.session.ended) {
      item.append(iconText(element('p', 'note'), 'info', t('runs_cannotPause', { reason: worker.test.cannotPause })));
    }
  }
  if (run.session.ended) return item;

  const actions = element('div', 'piwi-actions');
  const button = (what: RunsWhat, label: string, title: string, icon: IconName, tone?: 'primary') => {
    const made = makeButton(label, () => void control(run, worker, what), { icon, tone, title });
    made.dataset.focus = `${key}|${what}`;
    made.disabled = busy.has(key);
    actions.append(made);
  };
  const stop = worker.state === 'stopped' ? worker.stop : null;
  if (stop) {
    const where = element('dl', 'stop');
    where.append(
      element('dt', undefined, t('runs_nextLabel')),
      element('dd', undefined, ...richText(stop.title)),
      element('dt', undefined, t('runs_whereLabel')),
      element('dd', 'place', stopPlace(stop, run.session.root)),
    );
    item.append(where, renderImage(key, stop));
    wantImage(run, worker, stop);
    button('resume', t('runs_resume'), t('runs_resumeTitle'), 'play', 'primary');
    button('step', t('runs_step'), t('runs_stepTitle'), 'skip');
    button('finish', t('runs_finish'), t('runs_finishTitle'), 'next');
    if (stop.bar && worker.intents.includes('pick')) button('pick', t('runs_pick'), t('runs_pickTitle'), 'pick');
    if (stop.bar && worker.intents.includes('record')) {
      button('record', t('runs_record'), t('runs_recordTitle'), 'record');
    }
  } else if (!worker.pausing) {
    button('pause', t('runs_pause'), t('runs_pauseTitle'), 'pause');
  }
  if (actions.childElementCount > 0) item.append(actions);
  const answer = answers.get(key);
  if (answer) {
    const line = iconText(element('p', answer.ok ? 'note' : 'answer'), answer.ok ? 'info' : 'alert', answer.text);
    item.append(line);
  }
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

connect();
// Says the window is still open: the worker stays alive meanwhile, and keeps finding the hubs again after a failure.
setInterval(() => post({ type: 'ping' }), RUNS_PING_MS);

import { BUG_REPORT_EXTENSION, BUG_REPORT_MEDIA_TYPE, describeStepInParts } from '@piwitests/core/bug-report';
import { highlightLocator, LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import { conditionText } from '../shared/condition-words.js';
import { interfacePhrases } from '../shared/core-words.js';
import { pageKey } from '@piwitests/core/page-key';
import {
  normalizeSteps,
  sessionFromEvents,
  stepViews,
  type RecordedStep,
  type StepView,
  type StepViewport,
} from '@piwitests/core/recording';
import { parseSteps, sessionFromSteps, toStepsDocument, type PiwiSteps } from '@piwitests/core/steps';
import { formatNumber, initI18n, t, tn, tNodes, tnNodes, uiLanguage } from '../shared/i18n.js';
import { BUTTON_CSS } from '../shared/buttons.js';
import { icon } from '../shared/icons.js';
import { richText, STEP_CSS, stepView, urlView } from '../shared/step-view.js';
import { getRecordingState, recordingMode } from '../shared/recording-storage.js';
import {
  appendReplayEvidence,
  getReplayEvidence,
  getReplayState,
  type ReplayEvidence,
  updateReplayState,
  type ReplayState,
  type ReplayStepResult,
} from '../shared/replay-storage.js';
import { ensureSessionAccess } from '../shared/session-access.js';
import { isOwnHost, REPLAY_DIALOG_HOST_ID, REPLAY_HUD_HOST_ID, SHARED_STYLE } from './record-ui.js';
import { fileNames } from '@piwitests/core/codegen';
import type { FallbackReason, ReplayDriver } from '../shared/cdp-input.js';
import {
  NotActionable,
  setTrustedReplay,
  trustedCheck,
  trustedClick,
  trustedDrag,
  trustedFill,
  trustedHover,
  trustedPress,
  trustedSelect,
  TrustedInputLost,
} from './replay-trusted.js';
import {
  createWaker,
  driverText,
  evaluateAssertion,
  evidenceLines,
  quoted,
  replayVerdict,
  stepStatus,
  VERDICT_ICONS,
  verdictText,
  wait,
  type ReplayVerdict,
} from './replay-core.js';
import { relayEvidence } from '../shared/bug-relay.js';
import { storeAsPageLeaves } from '../shared/bug-storage.js';
import { createCursor, type FakeCursor } from './replay-cursor.js';
import {
  ACTION_TIMEOUT_MS,
  ASSERT_TIMEOUT_MS,
  assignFiles,
  dropLocatorFor,
  endHover,
  findAll,
  locatorFor,
  observe,
  pageEngine,
  performCheck,
  performClick,
  performDoubleClick,
  performDrag,
  performFill,
  performHover,
  performPress,
  performSelect,
  resolveForAction,
  waitForPageReady,
  waitForStepReady,
} from './replay-actions.js';
import { readReportFile } from './steps-file.js';
import type { ReplayStepView } from '../shared/step-views.js';
import { attachPanelShadow, clearPanelShadow } from './panel-root.js';
import { openDesktopRun } from './desktop-run-panel.js';
import { shareable, shareResultRow } from './share-result.js';
import { button, DIALOG_CSS, holdFocus } from './replay-ui.js';

/**
 * Replay: plays a bug report's steps (or any steps file) in this tab, on this
 * tab's origin, with a fake cursor showing each action, and says whether the
 * bug shows here.
 *
 * The background script registers this script for the origin while a replay
 * runs, so every page the replay reaches loads it again; the replay's state in
 * session storage says which step comes next. Opened from the popup with no
 * replay running, it asks for the report to play.
 */

interface ReplayGlobals {
  __piwiReplayEntry?: () => Promise<void>;
  /** The last verdict in this page, for the e2e suite. */
  __piwiReplayVerdict?: ReplayVerdict;
}

const STYLE = `
  ${SHARED_STYLE}
  ${LOCATOR_SYNTAX_CSS}
  ${BUTTON_CSS}
  ${STEP_CSS}
  .box { background: #111827; color: #f9fafb; color-scheme: dark; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.4);
    font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; hyphens: auto; }
  @media (prefers-color-scheme: light) {
    .box { background: #ffffff; color: #111827; color-scheme: light; box-shadow: 0 8px 30px rgba(0,0,0,.2); border: 1px solid #e5e7eb; }
  }
  .title { font-weight: 600; font-size: 13px; }
  .sub { color: #9ca3af; font-size: 11.5px; }
  .steps { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow: auto; margin: 8px 0; font-size: 11.5px; }
  .step { display: flex; align-items: flex-start; gap: 6px; padding: 3px 4px; border-radius: 6px; }
  .step.current { background: rgba(124,58,237,.18); box-shadow: inset 2px 0 0 #a78bfa; }
  .step .num { color: #9ca3af; min-width: 16px; text-align: end; flex-shrink: 0; padding-top: 2px; font-variant-numeric: tabular-nums; }
  .step .piwi-step { flex: 1; gap: 6px; }
  .step .piwi-step-badge { width: 18px; height: 18px; }
  .step .piwi-step-badge .piwi-icon { width: 12px; height: 12px; }
  .status { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 18px; flex-shrink: 0; color: #9ca3af; }
  .status .piwi-icon { width: 14px; height: 14px; }
  .status[data-state="pending"] .piwi-icon { width: 8px; height: 8px; opacity: .6; }
  .status[data-state="current"] { color: #a78bfa; }
  .status[data-state="ok"] { color: #34d399; }
  .status[data-state="failed"] { color: #f87171; }
  .status[data-state="diverged"] { color: #fbbf24; }
  .pending .piwi-step { opacity: .62; }
  .detail { color: #fca5a5; font-size: 11px; padding-left: 44px; }
  .note { color: #9ca3af; font-size: 11px; padding-left: 44px; }
  .tag { color: #9ca3af; font-size: 10px; margin-left: auto; padding: 0 5px; white-space: nowrap; border: 1px solid rgba(148,163,184,.3); border-radius: 999px; align-self: center; }
  .ask { border-radius: 8px; padding: 8px 10px; margin: 6px 0; background: rgba(124,58,237,.14); border: 1px solid rgba(167,139,250,.35); }
  .ask .what { font-weight: 500; margin: 6px 0; overflow-wrap: anywhere; font-size: 13px; }
  .ask .row { margin-top: 8px; }
  .shot { position: relative; display: inline-block; max-width: 100%; margin: 4px 0; line-height: 0; }
  .shot img { display: block; max-width: 100%; max-height: 220px; border-radius: 4px; border: 1px solid rgba(128,128,128,.4); }
  .shot .mark { position: absolute; border: 2px solid #f59e0b; border-radius: 3px; box-shadow: 0 0 0 2px rgba(245,158,11,.35); }
  .locs { margin: 4px 0; padding: 0; list-style: none; font-size: 11px; display: flex; flex-direction: column; gap: 3px; }
  .locs li { overflow-wrap: anywhere; padding: 3px 6px; border-radius: 5px; background: rgba(148,163,184,.12); }
  .found { color: #fbbf24; }
  @media (prefers-color-scheme: light) { .found { color: #b45309; } }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .row .end { margin-inline-start: auto; }
  label.check { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; }
  .verdict { --verdict: #94a3b8; border-radius: 8px; padding: 8px 10px; margin-top: 8px;
    background: color-mix(in srgb, var(--verdict) 15%, transparent); border-inline-start: 3px solid var(--verdict); }
  .verdict.reproduced { --verdict: #f87171; }
  .verdict.not-reproduced { --verdict: #34d399; }
  .verdict.diverged, .verdict.stopped { --verdict: #fbbf24; }
  .verdict .title { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; line-height: 20px; }
  .verdict .title .piwi-icon { color: var(--verdict); }
  .box > .head { display: flex; align-items: center; gap: 6px; line-height: 20px; }
  .box > .head .piwi-icon { color: #a78bfa; }
  .seen, .share { margin-top: 8px; }
  .share { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .message { color: #fca5a5; font-size: 12px; margin-top: 6px; }
  .message:empty { display: none; }
  input[type=file] { font: inherit; font-size: 12px; margin: 8px 0; color: inherit; }
  @media (prefers-color-scheme: light) {
    .sub, .note, .tag, .step .num, .status { color: #6b7280; }
    .detail, .message { color: #b91c1c; }
    .status[data-state="current"] { color: #6d28d9; }
    .status[data-state="ok"] { color: #059669; }
    .status[data-state="failed"] { color: #dc2626; }
    .status[data-state="diverged"] { color: #b45309; }
    .step.current { background: rgba(124,58,237,.1); box-shadow: inset 2px 0 0 #7c3aed; }
    .ask { background: rgba(124,58,237,.07); border-color: rgba(124,58,237,.3); }
    .verdict.reproduced { --verdict: #dc2626; }
    .verdict.not-reproduced { --verdict: #059669; }
    .verdict.diverged, .verdict.stopped { --verdict: #d97706; }
    .verdict.completed { --verdict: #64748b; }
    .box > .head .piwi-icon { color: #6d28d9; }
    .locs li { background: rgba(100,116,139,.09); }
  }
`;

/** A step in plain words, without the Markdown code marks the report uses: for the cursor's caption. */
function plainStepWords(step: RecordedStep): string {
  return describeStepInParts(step, interfacePhrases())
    .map((part) => part.text)
    .join('');
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * The address a goto opens, when the replay follows it: http or https, on the
 * replay's origin. Null for another site, another scheme (`javascript:`,
 * `data:`, `file:`) or a value that is no address.
 */
function followedUrl(value: string): URL | null {
  try {
    const url = new URL(value, location.href);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === location.origin ? url : null;
  } catch {
    return null;
  }
}

/**
 * Whether the page is the one a step happened on, by page key (ids and tokens
 * aside). A replay started on the tab's own page takes that page for the first
 * recorded one, whatever their addresses; a step whose page is not known
 * (empty) happens on any.
 */
function onPageOf(url: string, startPage: ReplayState['startPage']): boolean {
  if (!url) return true;
  const here = pageKey(location.href);
  const there = pageKey(url);
  if (startPage && there === pageKey(startPage.recorded) && here === pageKey(startPage.actual)) return true;
  return here === null || there === null || here === there;
}

async function waitForPage(
  url: string,
  timeout: number,
  startPage: ReplayState['startPage'],
  replayId: string,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (!onPageOf(url, startPage)) {
    if (Date.now() >= deadline || movedAway === replayId) return false;
    await wait(100);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Talking to the background script

/**
 * Where a replay's step screenshots come from: the images a report's file
 * holds, the recording's own by view id, or the running replay's, when it
 * plays again.
 */
type ReplayViews =
  | { views: ReplayStepView[] }
  | { recordingViews: Array<StepView & { step: number }> }
  | { keepViews: true };

/** Starts a replay; `startOn` is the page it starts on instead of opening the first recorded one. */
async function startReplay(
  steps: PiwiSteps,
  stepMode: boolean,
  startOn: string | null,
  bugReportId: number | null = null,
  views: ReplayViews | null = null,
  runFailedStep: number | null = null,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'piwi-start-replay',
      steps,
      origin: location.origin,
      stepMode,
      inject: false,
      startOn,
      bugReportId,
      runFailedStep,
      ...views,
    })) as { ok: boolean; error?: string } | undefined;
    return response ?? { ok: false, error: t('common_workerNoAnswer') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type InstanceReports =
  | { ok: true; project: { id: number; label: string } | null; items: Array<{ id: number; title: string }> }
  | { ok: false; error: string };

/** The bug reports of the project this tab maps to on the connected instance; null when not connected. */
async function listInstanceReports(): Promise<InstanceReports | null> {
  try {
    return (
      ((await chrome.runtime.sendMessage({ type: 'piwi-list-bug-reports' })) as InstanceReports | undefined) ?? null
    );
  } catch {
    return null;
  }
}

async function instanceReportSteps(id: number): Promise<{ ok: true; steps: PiwiSteps } | { ok: false; error: string }> {
  try {
    const answer = (await chrome.runtime.sendMessage({ type: 'piwi-get-bug-report', id })) as
      | { ok: true; steps: PiwiSteps }
      | { ok: false; error: string }
      | undefined;
    return answer ?? { ok: false, error: t('common_workerNoAnswer') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function notifyFinished(): void {
  try {
    void chrome.runtime.sendMessage({ type: 'piwi-replay-finished' }).catch(() => undefined);
  } catch {
    // The extension was reloaded; the replay has ended either way.
  }
}

/**
 * Whether this tab plays the replay, as the background worker says: the tab
 * it started in, else the first of its origin's tabs to ask. A worker that
 * does not know the question (one older than this script) leaves it to the tab.
 */
async function replayHere(state: ReplayState): Promise<boolean> {
  try {
    const answer = (await chrome.runtime.sendMessage({ type: 'piwi-replay-tab', replayId: state.id })) as
      | { ok?: boolean }
      | undefined;
    return answer?.ok !== false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The panel

let cursor: FakeCursor | null = null;
let loopActive = false;
/** The replay a step took on to a tab this one opened (`piwi-replay-moved`): this page lets go of it. */
let movedAway: string | null = null;
/** Resolves the wait for Next in step mode, or for Continue after a pause. */
const waker = createWaker();

function waitForRelease(): Promise<void> {
  return waker.wait();
}

function wakeLoop(): void {
  waker.wake();
}

/** The attribute naming each control of the panel, so the one that had the focus has it again once redrawn. */
const CONTROL_KEY = 'data-piwi-control';

function keyed<T extends HTMLElement>(control: T, key: string): T {
  control.setAttribute(CONTROL_KEY, key);
  return control;
}

/** The replay's panel, drawn again on every change: steps, controls, and the verdict once done. */
let hud: { host: HTMLElement; root: ShadowRoot } | null = null;

/**
 * The pointer and focus events of the panel's own controls, stopped at its
 * root: they are composed, and a page's outside-click or focus-outside handler
 * would close its open menu on a click on Next.
 */
const HUD_CONTAINED_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'focusin', 'focusout'];

function hudRoot(): ShadowRoot {
  if (hud && hud.host.isConnected) {
    clearPanelShadow(hud.root);
    return hud.root;
  }
  document.getElementById(REPLAY_HUD_HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = REPLAY_HUD_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:auto 16px 16px auto;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed', delegatesFocus: true });
  for (const type of HUD_CONTAINED_EVENTS) root.addEventListener(type, (event) => event.stopPropagation());
  // A click on a control leaves focus where it is on the page, where a key press with no element goes.
  root.addEventListener('mousedown', (event) => {
    const pressed = event.composedPath()[0];
    if (pressed instanceof Element && pressed.closest('button, label.check')) event.preventDefault();
  });
  hud = { host, root };
  return hud.root;
}

/** The page's element that last had focus, the extension's own surfaces left out. */
let pageFocus: Element | null = null;

function trackPageFocus(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || isOwnHost(target)) return;
  const inner = event.composedPath()[0];
  pageFocus = inner instanceof Element ? inner : target;
}

/**
 * Gives focus back to the page before a key press that goes wherever focus
 * is, when it is on one of the extension's surfaces (the person tabbed to
 * Next): to the page's element that last had it, else to the page itself.
 */
function focusBackOnPage(): void {
  const active = document.activeElement;
  if (!active || !isOwnHost(active)) return;
  if (pageFocus?.isConnected && (pageFocus instanceof HTMLElement || pageFocus instanceof SVGElement)) {
    pageFocus.focus({ preventScroll: true });
  }
  const still = document.activeElement;
  if (still && isOwnHost(still) && still instanceof HTMLElement) still.blur();
}

/** Which steps the person played by hand, under the verdict; null when none. */
function byHandText(results: ReplayStepResult[]): string | null {
  const steps = results.flatMap((r, i) => (r?.status === 'manual' ? [formatNumber(i + 1)] : []));
  return steps.length > 0 ? tn('replay_byHand', steps.length, { steps: steps.join(', ') }) : null;
}

/** What the panel says of the viewport: the recorded one, set on the tab, or how it differs from the tab's. */
function viewportText(viewport: ReplayState['viewport']): string | null {
  if (!viewport) return null;
  const recorded = `${viewport.width}×${viewport.height}`;
  if (viewport.set) return t('replay_viewportSet', { size: recorded });
  const actual = `${window.innerWidth}×${window.innerHeight}`;
  return actual === recorded ? null : t('replay_viewportDiffers', { recorded, actual });
}

function renderHud(
  state: ReplayState,
  verdict: ReplayVerdict | null = null,
  evidence: ReplayEvidence | null = null,
): void {
  const focused = hud?.host.isConnected ? (hud.root.activeElement?.getAttribute(CONTROL_KEY) ?? null) : null;
  const root = hudRoot();
  const style = document.createElement('style');
  style.textContent = STYLE;
  const box = document.createElement('div');
  box.className = 'box';
  box.style.cssText = 'padding:10px 12px;width:380px;max-width:calc(100vw - 32px);';
  box.setAttribute('role', 'region');
  box.lang = uiLanguage();
  box.setAttribute('aria-label', t('replay_hudLabel'));

  const steps = sessionFromSteps(state.steps, state.origin).steps;
  const done = state.status === 'done' || state.status === 'stopped';
  const title = document.createElement('div');
  title.className = 'title';
  const status = t(
    done ? 'replay_statusDone' : state.status === 'paused' ? 'replay_statusPaused' : 'replay_statusRunning',
  );
  title.textContent = state.steps.title ? t('replay_statusWithTitle', { status, title: state.steps.title }) : status;
  const head = document.createElement('div');
  head.className = 'head';
  head.append(icon(done ? 'check-circle' : state.status === 'paused' ? 'pause' : 'replay'), title);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.append(
    ...(done
      ? tnNodes('replay_progressDone', steps.length, { origin: urlView(state.origin) })
      : tNodes('replay_progress', {
          origin: urlView(state.origin),
          step: formatNumber(Math.min(state.position + 1, steps.length)),
          total: formatNumber(steps.length),
        })),
  );
  box.append(head, sub);
  if (state.driver) {
    const how = document.createElement('div');
    how.className = 'sub';
    how.textContent = driverText(state.driver);
    box.appendChild(how);
  }
  if (state.conditions?.length) {
    const conditions = document.createElement('div');
    conditions.className = 'sub';
    conditions.textContent = t('replay_underConditions', {
      conditions: state.conditions.map(conditionText).join(' · '),
    });
    box.appendChild(conditions);
  }
  const sizeText = viewportText(state.viewport);
  if (sizeText) {
    const size = document.createElement('div');
    size.className = 'sub';
    size.textContent = sizeText;
    box.appendChild(size);
  }

  const list = document.createElement('div');
  list.className = 'steps';
  steps.forEach((step, i) => {
    const result = state.results[i];
    const current = !done && i === state.position;
    const row = document.createElement('div');
    row.className = `step ${current ? 'current' : (result?.status ?? 'pending')}`;
    const status = stepStatus(result, current);
    const mark = document.createElement('span');
    mark.className = 'status';
    mark.dataset.state = status.state;
    mark.append(icon(status.icon));
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = formatNumber(i + 1);
    row.append(mark, num, stepView(step));
    if (result?.driver) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t(result.driver === 'cdp' ? 'replay_stepTrusted' : 'replay_stepEvents');
      row.appendChild(tag);
    }
    list.appendChild(row);
    if (result?.detail && (result.status === 'failed' || result.status === 'diverged')) {
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.append(...richText(result.detail));
      list.appendChild(detail);
    } else if (
      result?.detail &&
      (result.status === 'skipped' || result.status === 'manual' || step.action === 'setInputFiles')
    ) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = result.detail;
      list.appendChild(note);
    }
  });
  box.appendChild(list);
  if (!done && filePrompt) box.appendChild(filePromptBox(filePrompt));
  const handed = handOver;
  if (!done && handed && steps[handed.step]) box.appendChild(handOverBox(handed, steps[handed.step]!));

  /** What a control says under the controls, such as why Replay again could not start. */
  const notices: HTMLElement[] = [];
  const controls = document.createElement('div');
  controls.className = 'row';
  if (!done) {
    const paused = state.status === 'paused';
    controls.appendChild(
      keyed(
        button(
          paused ? t('replay_continue') : t('replay_pause'),
          () => {
            void updateReplayState((s) => ({ ...s, status: paused ? 'running' : 'paused' }), state.id).then((s) => {
              if (s) renderHud(s);
              waker.wakeWaiting();
            });
          },
          { icon: paused ? 'play' : 'pause' },
        ),
        'pause',
      ),
    );
    if (state.stepMode) {
      controls.appendChild(keyed(button(t('replay_nextStep'), wakeLoop, { icon: 'next', tone: 'primary' }), 'next'));
    }
    const stepLabel = document.createElement('label');
    stepLabel.className = 'check';
    const stepBox = keyed(document.createElement('input'), 'step-mode');
    stepBox.type = 'checkbox';
    stepBox.checked = state.stepMode;
    stepBox.addEventListener('change', () => {
      void updateReplayState((s) => ({ ...s, stepMode: stepBox.checked }), state.id).then((s) => {
        if (s) renderHud(s);
        if (!stepBox.checked) wakeLoop();
      });
    });
    stepLabel.append(stepBox, t('replay_stepByStep'));
    controls.appendChild(stepLabel);
    controls.appendChild(
      keyed(
        button(
          t('common_stop'),
          () => {
            void updateReplayState((s) => ({ ...s, status: 'stopped' }), state.id).then(() => wakeLoop());
          },
          { icon: 'stop', tone: 'danger', className: 'end' },
        ),
        'stop',
      ),
    );
  } else {
    if (verdict) {
      const { title: verdictTitle, detail } = verdictText(verdict, steps);
      const box2 = document.createElement('div');
      box2.className = `verdict ${verdict.kind}`;
      box2.setAttribute('role', 'status');
      const titleEl = document.createElement('div');
      titleEl.className = 'title';
      titleEl.append(icon(VERDICT_ICONS[verdict.kind]), verdictTitle);
      const d = document.createElement('div');
      d.append(...richText(detail));
      box2.append(titleEl, d);
      if (state.driver) {
        const how = document.createElement('div');
        how.className = 'sub';
        how.textContent = driverText(state.driver);
        box2.appendChild(how);
      }
      const byHand = byHandText(state.results);
      if (byHand) {
        const note = document.createElement('div');
        note.className = 'sub';
        note.textContent = byHand;
        box2.appendChild(note);
      }
      box.appendChild(box2);
      if (state.bugReportId && shareable(verdict.kind)) {
        box.appendChild(
          shareResultRow({
            bugReportId: state.bugReportId,
            source: 'replay',
            verdict: verdict.kind,
            divergedAt: verdict.kind === 'diverged' ? verdict.step : null,
            origin: state.origin,
          }),
        );
      }
    }
    const seen = evidenceLines(evidence);
    if (seen.lines.length) {
      const box3 = document.createElement('div');
      box3.className = 'seen';
      const head = document.createElement('div');
      head.className = 'sub';
      head.textContent = t('replay_seenHere');
      box3.appendChild(head);
      for (const text of seen.lines) {
        const line = document.createElement('div');
        line.className = 'detail';
        line.textContent = text;
        box3.appendChild(line);
      }
      if (seen.more) {
        const more = document.createElement('div');
        more.className = 'sub';
        more.textContent = t('replay_seenMore', { count: formatNumber(seen.more) });
        box3.appendChild(more);
      }
      box.appendChild(box3);
    }
    controls.style.marginTop = '8px';
    const againError = document.createElement('div');
    againError.className = 'message';
    againError.setAttribute('role', 'alert');
    notices.push(againError);
    // Disabled until the worker answers: a second click would start a second replay.
    const again = button(
      t('replay_again'),
      () => {
        again.disabled = true;
        againError.textContent = '';
        void (async () => {
          const response = await startReplay(
            state.steps,
            state.stepMode,
            state.startPage?.actual ?? null,
            state.bugReportId ?? null,
            { keepViews: true },
          );
          if (response.ok) return void runReplay();
          again.disabled = false;
          againError.textContent = response.error ?? t('common_replayStartFailed');
        })();
      },
      { icon: 'replay', tone: 'primary' },
    );
    controls.appendChild(keyed(again, 'again'));
    controls.appendChild(
      keyed(
        button(t('replay_runWithPlaywright'), () => openDesktopRun(state.steps, state.bugReportId ?? null, STYLE), {
          icon: 'terminal',
        }),
        'playwright',
      ),
    );
    controls.appendChild(
      keyed(
        button(t('common_close'), () => document.getElementById(REPLAY_HUD_HOST_ID)?.remove(), {
          icon: 'close',
          className: 'end',
        }),
        'close',
      ),
    );
  }
  box.append(controls, ...notices);
  root.append(style, box);
  if (focused) root.querySelector<HTMLElement>(`[${CONTROL_KEY}="${focused}"]`)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// The run

/**
 * Stores a step's result on the stored replay, so a Pause, a Stop or a change
 * of step mode made while the step played is kept.
 */
async function recordResult(state: ReplayState, index: number, result: ReplayStepResult): Promise<ReplayState> {
  const next = await updateReplayState((s) => {
    const results = s.results.slice();
    results[index] = result;
    return { ...s, results, position: index + 1, cursor: cursor?.position() ?? s.cursor, handOver: null };
  }, state.id);
  return next ?? state;
}

/** This page stops playing a replay that ended or was replaced elsewhere: its panel, cursor and evidence relay go. */
function leaveReplay(): void {
  void stopEvidence();
  endHover();
  hud?.host.remove();
  hud = null;
  cursor?.remove();
  cursor = null;
}

async function finish(state: ReplayState, stopped: boolean): Promise<void> {
  await stopEvidence();
  const evidence = await getReplayEvidence(state.evidenceToken).catch(() => null);
  endHover();
  const final = await updateReplayState(
    (s) => ({ ...s, status: stopped ? 'stopped' : 'done', cursor: cursor?.position() ?? null, finished: true }),
    state.id,
  );
  if (!final) return leaveReplay();
  const steps = sessionFromSteps(final.steps, final.origin).steps;
  const verdict = replayVerdict(steps, final.results, stopped, final.runFailedStep ?? null);
  notifyFinished();
  renderHud(final, verdict, evidence);
  (globalThis as ReplayGlobals).__piwiReplayVerdict = verdict;
  const shown = cursor;
  cursor = null;
  setTimeout(() => shown?.remove(), 1200);
}

/** A step's action with the page's own events: false when it could not be done here. */
async function actWithEvents(step: RecordedStep, element: Element | null, dropOn: Element | null): Promise<boolean> {
  const c = cursor!;
  const words = plainStepWords(step);
  if (!element) {
    await performPress(null, step.value ?? 'Enter', c, words);
    return true;
  }
  switch (step.action) {
    case 'click':
      await performClick(element, c, words);
      return true;
    case 'dblclick':
      await performDoubleClick(element, c, words);
      return true;
    case 'hover':
      await performHover(element, c, words);
      return true;
    case 'fill':
      return performFill(element, step.redacted ? '' : (step.value ?? ''), c, words);
    case 'check':
      return performCheck(element, true, c, words);
    case 'uncheck':
      return performCheck(element, false, c, words);
    case 'selectOption':
      return performSelect(element, step.value ?? '', c, words);
    case 'press':
      await performPress(element, step.value ?? 'Enter', c, words);
      return true;
    case 'dragTo':
      if (!dropOn) return false;
      await performDrag(element, dropOn, c, words);
      return true;
    default:
      return true;
  }
}

/** A step's action as trusted input, through the background worker. */
async function actTrusted(step: RecordedStep, element: Element | null, dropOn: Element | null): Promise<boolean> {
  const c = cursor!;
  const words = plainStepWords(step);
  if (!element) {
    await trustedPress(null, step.value ?? 'Enter', c, words);
    return true;
  }
  switch (step.action) {
    case 'click':
      await trustedClick(element, c, words);
      return true;
    case 'dblclick':
      await trustedClick(element, c, words, 2);
      return true;
    case 'hover':
      await trustedHover(element, c, words);
      return true;
    case 'fill':
      return trustedFill(element, step.redacted ? '' : (step.value ?? ''), c, words);
    case 'check':
      return trustedCheck(element, true, c, words);
    case 'uncheck':
      return trustedCheck(element, false, c, words);
    case 'selectOption':
      return trustedSelect(element, step.value ?? '', c, words);
    case 'press':
      await trustedPress(element, step.value ?? 'Enter', c, words);
      return true;
    case 'dragTo':
      if (!dropOn) return false;
      await trustedDrag(element, dropOn, c, words);
      return true;
    default:
      return true;
  }
}

type ActResult = { ok: true; driver: ReplayDriver } | { ok: false; reason: string | null };

/**
 * Performs one action step with the replay's driver. When trusted input is
 * lost before it reached the page (the person cancelled the debugging bar),
 * the replay goes on with the page's own events, from this step; lost once
 * part of it reached the page, the step fails and the replay stops.
 */
async function act(
  replayId: string,
  step: RecordedStep,
  element: Element | null,
  dropOn: Element | null,
): Promise<ActResult> {
  if (!element) focusBackOnPage();
  const state = await getReplayState();
  if (state?.id === replayId && state.driver?.driver === 'cdp') {
    try {
      return (await actTrusted(step, element, dropOn)) ? { ok: true, driver: 'cdp' } : { ok: false, reason: null };
    } catch (e) {
      if (e instanceof NotActionable) return { ok: false, reason: e.message };
      if (!(e instanceof TrustedInputLost)) throw e;
      await fallBack(e.reason, replayId);
      // Part of the action reached the page: playing it again with events would do it twice.
      if (e.started) return { ok: false, reason: t('replay_reasonInputInterrupted') };
    }
  }
  return (await actWithEvents(step, element, dropOn)) ? { ok: true, driver: 'synthetic' } : { ok: false, reason: null };
}

/**
 * The replay goes on with the page's own events, and its panel says why. The
 * viewport it set went with the session.
 */
async function fallBack(reason: FallbackReason, replayId: string): Promise<void> {
  const next = await updateReplayState(
    (s) =>
      s.driver?.driver === 'synthetic'
        ? s
        : {
            ...s,
            driver: { driver: 'synthetic', reason },
            viewport: s.viewport ? { ...s.viewport, set: false } : s.viewport,
          },
    replayId,
  );
  if (next && loopActive) renderHud(next);
}

/**
 * Asks the background worker how this replay acts on this page: trusted input
 * when it can attach to the tab, the page's own events otherwise. The choice
 * is kept in the replay's state, so a replay that fell back stays there.
 */
async function pickDriver(state: ReplayState): Promise<ReplayState> {
  let answer: { driver?: ReplayDriver; reason?: FallbackReason | null } | undefined;
  try {
    answer = await chrome.runtime.sendMessage({
      type: 'piwi-replay-driver',
      replayId: state.id,
      previous: state.driver ?? null,
    });
  } catch {
    answer = undefined;
  }
  const choice =
    answer?.driver === 'cdp' || answer?.driver === 'synthetic'
      ? { driver: answer.driver, reason: answer.reason ?? null }
      : { driver: 'synthetic' as const, reason: 'unavailable' as const };
  if (state.driver?.driver === choice.driver && state.driver.reason === choice.reason) return state;
  return (await updateReplayState((s) => ({ ...s, driver: choice }), state.id)) ?? state;
}

/** The file step waiting for the developer: the names the report gives, and what answers it. */
interface FilePrompt {
  step: number;
  names: string[];
  answer: (files: File[] | null) => void;
}

let filePrompt: FilePrompt | null = null;

/** What the panel shows while a file step waits: the file the report names, a chooser, and Skip. */
function filePromptBox(prompt: FilePrompt): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ask';
  box.setAttribute('role', 'group');
  const text = document.createElement('div');
  text.textContent = tn('replay_fileAsk', prompt.names.length, {
    step: formatNumber(prompt.step + 1),
    files: prompt.names.map(quoted).join(', '),
  });
  const input = keyed(document.createElement('input'), 'file');
  input.type = 'file';
  input.multiple = prompt.names.length > 1;
  input.setAttribute('data-piwi-replay-file', '');
  input.setAttribute('aria-label', t('replay_fileChoose'));
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    if (files.length) prompt.answer(files);
  });
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(
    keyed(
      button(t('replay_fileSkip'), () => prompt.answer(null), { icon: 'skip' }),
      'file-skip',
    ),
  );
  box.append(text, input, row);
  return box;
}

/**
 * A file step: the report names the files but does not carry them, so the
 * developer chooses them in the panel (or skips the step), and they are set on
 * the page's field as the browser sets a choice. Answers null when the replay
 * was stopped meanwhile.
 */
async function askForFiles(state: ReplayState, index: number, step: RecordedStep): Promise<File[] | 'skip' | null> {
  const names = fileNames(step.value);
  if (names.length === 0) return [];
  const chosen = new Promise<File[] | null>((resolve) => {
    filePrompt = { step: index, names, answer: resolve };
  });
  renderHud(state);
  try {
    for (;;) {
      const answer = await waker.until(chosen);
      if (!answer.woken) return answer.value ?? 'skip';
      const latest = await getReplayState();
      if (!latest || latest.id !== state.id || latest.status === 'stopped') return null;
    }
  } finally {
    filePrompt = null;
  }
}

async function checkAssertion(state: ReplayState, step: RecordedStep): Promise<ReplayStepResult> {
  const assertion = step.assertion ?? {
    matcher: 'toBeVisible',
    expected: null,
    actual: null,
    negated: false,
    note: null,
  };
  const deadline = Date.now() + ASSERT_TIMEOUT_MS;
  let pointed = false;
  for (;;) {
    const engine = pageEngine({ strict: true });
    const observation = observe(step, engine);
    const { holds, found } = evaluateAssertion(assertion, observation, state.origin);
    if (!pointed && observation.count === 1 && assertion.matcher !== 'toHaveURL') {
      pointed = true;
      const locator = locatorFor(step);
      const element = locator ? findAll(locator, engine)[0] : undefined;
      if (element) {
        const r = element.getBoundingClientRect();
        cursor?.outline(r);
        await cursor?.moveTo(
          r.left + r.width / 2,
          r.top + r.height / 2,
          t('replay_cursorCheck', { step: plainStepWords(step) }),
        );
      }
    }
    if (holds) {
      cursor?.outline(null);
      return { status: 'passed', detail: null };
    }
    if (Date.now() >= deadline) {
      cursor?.outline(null);
      return { status: 'failed', detail: t('replay_stepFound', { found }), found };
    }
    await wait(150);
  }
}

type HandOverAnswer = 'done' | 'skip' | 'stop';

/** The step the replay handed to the person: why, the page as it began, and what answers it. */
interface HandOver {
  step: number;
  reason: string;
  view: ReplayStepView | null;
  answer: (answer: HandOverAnswer) => void;
  /** How many elements of the page its recorded locators find now. */
  found: number;
}

/** At most this many of an element's recorded locators are listed in the hand-over. */
const HANDED_LOCATORS = 3;
/** How often the elements a handed-over step is about are looked for again while the person acts. */
const HAND_OVER_LOOK_MS = 400;

/** The locators a step's element was recorded with: the one the replay looked for first, then the others. */
function recordedLocators(step: RecordedStep): { element: string[]; dropOn: string[] } {
  const listed = (first: string | null, target: RecordedStep['target'] | undefined) => [
    ...new Set([first, ...(target?.alternatives ?? []).map((a) => a.locator)].filter((l): l is string => !!l)),
  ];
  return {
    element: listed(locatorFor(step), step.target),
    dropOn: step.action === 'dragTo' ? listed(dropLocatorFor(step), step.dropTarget) : [],
  };
}

/** The elements of the page the listed locators of a step find now, its own and where it drops. */
function recordedElements(step: RecordedStep): Element[] {
  const { element, dropOn } = recordedLocators(step);
  const listed = [...element.slice(0, HANDED_LOCATORS), ...dropOn.slice(0, HANDED_LOCATORS)];
  const engine = pageEngine();
  return [...new Set(listed.flatMap((locator) => findAll(locator, engine)))];
}

function locatorList(locators: string[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'locs';
  for (const locator of locators.slice(0, HANDED_LOCATORS)) {
    const item = document.createElement('li');
    const code = document.createElement('span');
    code.className = 'piwi-loc';
    code.innerHTML = highlightLocator(locator);
    item.appendChild(code);
    list.appendChild(item);
  }
  return list;
}

function foundText(found: number): string {
  return found > 0 ? tn('replay_handOverFound', found) : t('replay_handOverNotFound');
}

let handOver: HandOver | null = null;

/** The screenshot of a step the replay hands over, from the worker; null when the report has none. */
async function replayStepView(step: number): Promise<ReplayStepView | null> {
  try {
    const view = (await chrome.runtime.sendMessage({ type: 'piwi-replay-step-view', step })) as ReplayStepView | null;
    return view && typeof view.dataUrl === 'string' && view.dataUrl.startsWith('data:image/') ? view : null;
  } catch {
    return null;
  }
}

/** The page as a handed-over step began, its element outlined where the recording found it. */
function shotFigure(view: ReplayStepView, step: number): HTMLElement {
  const figure = document.createElement('div');
  figure.className = 'shot';
  const img = document.createElement('img');
  img.src = view.dataUrl;
  img.alt = t('replay_handOverShot', { step: formatNumber(step + 1) });
  figure.appendChild(img);
  const { box, viewport } = view;
  if (box && viewport && box.width > 0 && box.height > 0) {
    const mark = document.createElement('div');
    mark.className = 'mark';
    const pct = (n: number, of: number) => `${Math.max(0, Math.min(100, (n / of) * 100))}%`;
    mark.style.left = pct(box.x, viewport.width);
    mark.style.top = pct(box.y, viewport.height);
    mark.style.width = pct(box.width, viewport.width);
    mark.style.height = pct(box.height, viewport.height);
    figure.appendChild(mark);
  }
  return figure;
}

/** What the panel shows while a step waits for the person: why, the step in words, its screenshot, and the answers. */
function handOverBox(handed: HandOver, step: RecordedStep): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ask';
  box.setAttribute('role', 'group');
  box.setAttribute('data-piwi-replay-hand-over', '');
  const why = document.createElement('div');
  why.append(...richText(t('replay_handOverWhy', { step: formatNumber(handed.step + 1), reason: handed.reason })));
  const what = document.createElement('div');
  what.className = 'what';
  what.append(stepView(step));
  box.append(why, what);
  if (handed.view) box.appendChild(shotFigure(handed.view, handed.step));
  // Which element it is, as the recording found it, and where it is on this page now.
  const { element, dropOn } = recordedLocators(step);
  if (element.length > 0) {
    const label = document.createElement('div');
    label.className = 'sub';
    label.textContent = t('replay_handOverLocators');
    box.append(label, locatorList(element));
  }
  if (dropOn.length > 0) {
    const label = document.createElement('div');
    label.className = 'sub';
    label.textContent = t('replay_handOverDropOn');
    box.append(label, locatorList(dropOn));
  }
  if (element.length > 0) {
    const found = document.createElement('div');
    found.className = 'sub found';
    found.setAttribute('data-piwi-replay-found', '');
    found.setAttribute('aria-live', 'polite');
    found.textContent = foundText(handed.found);
    box.appendChild(found);
  }
  const how = document.createElement('div');
  how.className = 'sub';
  how.textContent = t(handed.view ? 'replay_handOverHow' : 'replay_handOverHowNoShot');
  const row = document.createElement('div');
  row.className = 'row';
  row.append(
    keyed(
      button(t('replay_handOverDone'), () => handed.answer('done'), { icon: 'check', tone: 'success' }),
      'hand-over-done',
    ),
    keyed(
      button(t('replay_handOverSkip'), () => handed.answer('skip'), { icon: 'skip' }),
      'hand-over-skip',
    ),
    keyed(
      button(t('replay_handOverStop'), () => handed.answer('stop'), { icon: 'stop', tone: 'danger' }),
      'hand-over-stop',
    ),
  );
  box.append(how, row);
  return box;
}

/**
 * A step the replay could not play goes to the person: the panel shows why,
 * the step in words and the page as it began, its element outlined, and waits
 * for them to do it on the page, skip it, or stop. The replay's state keeps
 * the hand-over, so it waits on the page the person's action loads too.
 * Answers null when the replay was stopped meanwhile.
 */
async function handOverStep(
  state: ReplayState,
  index: number,
  reason: string,
): Promise<{ answer: HandOverAnswer; state: ReplayState } | null> {
  const current =
    state.handOver?.step === index
      ? state
      : ((await updateReplayState((s) => ({ ...s, position: index, handOver: { step: index, reason } }), state.id)) ??
        state);
  cursor?.outline(null);
  const view = await replayStepView(index);
  const step = sessionFromSteps(current.steps, current.origin).steps[index];
  const chosen = new Promise<HandOverAnswer>((resolve) => {
    handOver = { step: index, reason, view, answer: resolve, found: 0 };
  });
  // The elements the step is about, outlined on the page while the person acts, as the page changes.
  const look = () => {
    if (!handOver || !step) return;
    const elements = recordedElements(step);
    cursor?.marks(elements.map((e) => e.getBoundingClientRect()));
    if (elements.length === handOver.found) return;
    handOver.found = elements.length;
    const line = hud?.root.querySelector('[data-piwi-replay-found]');
    if (line) line.textContent = foundText(elements.length);
  };
  look();
  const looking = setInterval(look, HAND_OVER_LOOK_MS);
  renderHud(current);
  try {
    for (;;) {
      const answer = await waker.until(chosen);
      const latest = await getReplayState();
      if (!latest || latest.id !== state.id || latest.status === 'stopped' || movedAway === state.id) return null;
      if (!answer.woken) return { answer: answer.value, state: latest };
      renderHud(latest);
    }
  } finally {
    clearInterval(looking);
    cursor?.marks([]);
    handOver = null;
  }
}

/** Hands a step to the person and records what they did; false when the replay ends there. */
async function playByHand(state: ReplayState, index: number, reason: string): Promise<boolean> {
  const handed = await handOverStep(state, index, reason);
  if (!handed) return true;
  if (handed.answer === 'done') {
    await recordResult(handed.state, index, { status: 'manual', detail: t('replay_doneByHand') });
    return true;
  }
  if (handed.answer === 'skip') {
    await recordResult(handed.state, index, { status: 'skipped', detail: t('replay_stepSkipped') });
    return true;
  }
  await finish(await recordResult(handed.state, index, { status: 'diverged', detail: reason }), false);
  return false;
}

/** How long the page gets to lay out again after its viewport changes. */
const VIEWPORT_LAYOUT_MS = 150;

/** The viewport the steps were recorded at from step `index` on, when it changes there. */
function viewportFrom(state: ReplayState, index: number): StepViewport | null {
  return state.steps.viewports?.find((v) => v.step === index) ?? null;
}

/** The viewport step `index` was recorded at: the last one the steps give at or before it. */
function viewportAt(state: ReplayState, index: number): StepViewport | null {
  let found: StepViewport | null = null;
  for (const v of state.steps.viewports ?? []) if (v.step <= index && (!found || v.step >= found.step)) found = v;
  return found;
}

/**
 * Sets the viewport the steps were recorded at on the tab, through the
 * debugging protocol when the replay acts with trusted input; otherwise the
 * panel says how the tab's size differs.
 */
async function applyViewport(state: ReplayState, viewport: StepViewport): Promise<ReplayState> {
  let set = false;
  if (state.driver?.driver === 'cdp') {
    try {
      const answer = (await chrome.runtime.sendMessage({
        type: 'piwi-replay-viewport',
        replayId: state.id,
        width: viewport.width,
        height: viewport.height,
      })) as { ok?: boolean } | undefined;
      set = answer?.ok === true;
    } catch {
      set = false;
    }
  }
  const next = await updateReplayState(
    (s) => ({ ...s, viewport: { width: viewport.width, height: viewport.height, set } }),
    state.id,
  );
  if (set) await wait(VIEWPORT_LAYOUT_MS);
  return next ?? state;
}

/** The stored replay while it still runs at step `index`; null once it was paused, stopped or replaced. */
async function runningAt(replayId: string, index: number): Promise<ReplayState | null> {
  const latest = await getReplayState();
  return latest &&
    latest.id === replayId &&
    latest.status === 'running' &&
    latest.position === index &&
    movedAway !== replayId
    ? latest
    : null;
}

/**
 * In step mode: waits for Next, then answers the state if the replay is still
 * on this step and running. Answers null without waiting when the replay was
 * paused, stopped or replaced while the step looked for its element: the loop
 * waits for Continue first, and a Continue never stands for this step's Next.
 */
async function waitForNext(replayId: string, index: number): Promise<ReplayState | null> {
  if (!(await runningAt(replayId, index))) return null;
  await waitForRelease();
  return runningAt(replayId, index);
}

/** How long a navigation gets to unload the page once it has started. */
const UNLOAD_TIMEOUT_MS = ACTION_TIMEOUT_MS;

/** Set once the page has begun to leave for another document: a goto, a link, a form's submit. */
let leaving = false;

/**
 * Waits for the page to unload, a navigation having started: the replay goes
 * on in the next page. Answers `stayed` when the page is still here after
 * `UNLOAD_TIMEOUT_MS` (a 204, a download, a "Stay on page"), or `ended` once
 * the replay was stopped or replaced meanwhile, what is left of the
 * navigation cancelled either way.
 */
async function waitForUnload(replayId: string): Promise<'stayed' | 'ended'> {
  const deadline = Date.now() + UNLOAD_TIMEOUT_MS;
  let outcome: 'stayed' | 'ended' = 'stayed';
  for (let left = UNLOAD_TIMEOUT_MS; left > 0; left = deadline - Date.now()) {
    if (!(await waker.until(wait(left))).woken) break;
    const latest = await getReplayState();
    if (!latest || latest.id !== replayId || latest.status === 'stopped' || movedAway === replayId) {
      outcome = 'ended';
      break;
    }
  }
  window.stop();
  leaving = false;
  return outcome;
}

/**
 * The goto of step `index` started a navigation: waits for the page to
 * unload. A page that stays puts the step back, and it goes to the person, as
 * a step on another page does. False when the replay ends there.
 */
async function gotoUnloads(replayId: string, index: number, expected: string): Promise<boolean> {
  const outcome = await waitForUnload(replayId);
  const back = await updateReplayState(
    (s) => ({ ...s, position: index, results: s.results.slice(0, index) }),
    replayId,
  );
  if (outcome === 'ended' || !back || back.status === 'stopped') return true;
  return playByHand(
    back,
    index,
    t('replay_reasonOtherPage', { expected: pathOf(expected), actual: pathOf(location.href) }),
  );
}

/** Stores what the evidence script relayed and is still pending, and stops listening; null while none listens. */
let evidenceStop: (() => Promise<void>) | null = null;
/** The replay whose entries this page listens for; a new replay (Replay again) listens anew. */
let evidenceToken: string | null = null;

/** This page stops listening to the evidence script, once what it relayed is stored. */
async function stopEvidence(): Promise<void> {
  const stop = evidenceStop;
  evidenceStop = null;
  evidenceToken = null;
  await stop?.();
}

/**
 * Listens to the main-world evidence script (registered by the background
 * script while a replay runs) with the replay's token, and keeps its entries in
 * batches (`relayEvidence`), handing them to the worker as the page is left.
 * Only what the page showed from `since`, the replay's start, is the replay's:
 * the script in a page a bug recording ran on still holds what the recording's
 * debugging session collected. Returns the disposer, which stores what is still
 * pending and stops listening.
 */
function startReplayEvidence(token: string, since: number): () => Promise<void> {
  return relayEvidence(token, (entries) => appendReplayEvidence(token, entries), {
    since,
    leave: (entries) => storeAsPageLeaves(token, entries),
  });
}

async function runReplay(): Promise<void> {
  if (loopActive) return;
  loopActive = true;
  waker.reset();
  /** Set when another replay took this one's place, which this tab may play next. */
  let replaced = false;
  try {
    let state = await getReplayState();
    if (!state || (state.status !== 'running' && state.status !== 'paused') || state.origin !== location.origin) return;
    if (!(await replayHere(state))) return;
    const replayId = state.id;
    document.getElementById(REPLAY_DIALOG_HOST_ID)?.remove();
    if (state.evidenceToken && state.evidenceToken !== evidenceToken) {
      void stopEvidence();
      evidenceToken = state.evidenceToken;
      evidenceStop = startReplayEvidence(state.evidenceToken, state.startedAt);
    }
    cursor?.remove();
    cursor = createCursor(state.cursor);
    setTrustedReplay(state.id);
    state = await pickDriver(state);
    // The recorded viewport, set again on each page: the session may be new here (the tab came back from another
    // origin, the worker restarted), and a replay on the page's events says it is not set.
    const size = viewportAt(state, state.position);
    if (size && (state.driver?.driver === 'cdp' || state.viewport?.set)) state = await applyViewport(state, size);
    // The panel shows at once; the first step waits for the page to be ready.
    renderHud(state);
    await waitForPageReady();
    for (;;) {
      // A step opened its page in a new tab, which plays the rest.
      if (movedAway === replayId) return leaveReplay();
      const latest = await getReplayState();
      if (!latest || latest.id !== replayId || latest.origin !== location.origin) {
        replaced = !!latest;
        return leaveReplay();
      }
      state = latest;
      if (state.status === 'stopped') return void (await finish(state, true));
      renderHud(state);
      if (state.status === 'paused') {
        await waitForRelease();
        continue;
      }
      const steps = sessionFromSteps(state.steps, state.origin).steps;
      const index = state.position;
      const step = steps[index];
      if (!step) return void (await finish(state, false));

      const viewport = viewportFrom(state, index);
      if (viewport && (state.viewport?.width !== viewport.width || state.viewport?.height !== viewport.height)) {
        state = await applyViewport(state, viewport);
        renderHud(state);
      }

      // A step handed to the person on the page before still waits for them here.
      if (state.handOver?.step === index) {
        if (!(await playByHand(state, index, state.handOver.reason))) return;
        continue;
      }

      if (step.action === 'goto' && index === 0 && state.startPage) {
        const actual = state.startPage.actual;
        // The page it started on, as any goto: followed only on the replay's own origin.
        const url = followedUrl(actual);
        if (!url) {
          const reason = t('replay_reasonOtherPage', { expected: actual, actual: pathOf(location.href) });
          if (!(await playByHand(state, index, reason))) return;
          continue;
        }
        await recordResult(state, index, { status: 'done', detail: t('replay_startedHere') });
        // Replayed again from another page: back to the page it started on.
        if (location.href.split('#')[0] !== url.href.split('#')[0]) {
          location.assign(url.href);
          if (!(await gotoUnloads(replayId, index, actual))) return;
        }
        continue;
      }

      if (step.action === 'goto') {
        const target = step.value ?? step.pageUrl;
        const url = followedUrl(target);
        if (!url) {
          const reason = t('replay_reasonOtherPage', { expected: target, actual: pathOf(location.href) });
          if (!(await playByHand(state, index, reason))) return;
          continue;
        }
        await recordResult(state, index, { status: 'done', detail: null });
        const here = new URL(location.href);
        if (url.href.split('#')[0] === here.href.split('#')[0] && url.hash !== here.hash) {
          location.assign(url.href);
          continue;
        }
        if (url.href === here.href) location.reload();
        else location.assign(url.href);
        // The page unloads; the replay continues on the next one.
        if (!(await gotoUnloads(replayId, index, target))) return;
        continue;
      }

      if (!(await waitForPage(step.pageUrl, ACTION_TIMEOUT_MS, state.startPage, replayId))) {
        if (movedAway === replayId) continue;
        const reason = t('replay_reasonOtherPage', { expected: pathOf(step.pageUrl), actual: pathOf(location.href) });
        if (!(await playByHand(state, index, reason))) return;
        continue;
      }

      await waitForStepReady();

      // The last action began to load another document, whose address may not differ (a submit to the same page,
      // `/items/1` to `/items/2`): the step plays there.
      if (leaving) {
        await waitForUnload(replayId);
        continue;
      }

      // A manual step of a report made from a test run: nothing plays it, the person does.
      if (step.action === 'manual') {
        const location = step.manual?.location;
        const reason = location ? t('replay_reasonManualAt', { location }) : t('replay_reasonManual');
        if (!(await playByHand(state, index, reason))) return;
        continue;
      }

      if (step.action === 'assert' || step.action === 'assertVisible') {
        if (state.stepMode) {
          const latest = await waitForNext(replayId, index);
          if (!latest) continue;
          state = latest;
        }
        const result = await checkAssertion(state, step);
        await recordResult(state, index, result);
        continue;
      }

      const resolved =
        step.action === 'press' && !step.target ? ({ ok: true, element: null } as const) : await resolveForAction(step);
      if (!resolved.ok) {
        if (!(await playByHand(state, index, resolved.reason))) return;
        continue;
      }
      const dropOn =
        step.action === 'dragTo' ? await resolveForAction(step, ACTION_TIMEOUT_MS, dropLocatorFor(step)) : null;
      if (dropOn && !dropOn.ok) {
        if (!(await playByHand(state, index, dropOn.reason))) return;
        continue;
      }
      if (state.stepMode) {
        if (resolved.element) {
          const r = resolved.element.getBoundingClientRect();
          cursor?.outline(r);
          await cursor?.moveTo(
            r.left + r.width / 2,
            r.top + r.height / 2,
            t('replay_cursorNext', { step: plainStepWords(step) }),
          );
        }
        const latest = await waitForNext(replayId, index);
        if (!latest) continue;
        state = latest;
      }
      if (step.action === 'setInputFiles' && resolved.element) {
        const files = await askForFiles(state, index, step);
        if (files === null) continue;
        if (files === 'skip') {
          await recordResult(state, index, { status: 'skipped', detail: t('replay_fileSkipped') });
          continue;
        }
        if (!assignFiles(resolved.element, files)) {
          if (!(await playByHand(state, index, t('replay_reasonActionFailed')))) return;
          continue;
        }
        await recordResult(state, index, {
          status: 'done',
          detail: files.length ? t('replay_fileChosen', { files: files.map((f) => quoted(f.name)).join(', ') }) : null,
        });
        continue;
      }
      // Paused, stopped, replaced or put in step mode while the step waited for its element: it is not played yet.
      const current = await runningAt(replayId, index);
      if (!current || (current.stepMode && !state.stepMode)) continue;
      // Saved before acting: the action may leave the page, and the next one continues from here.
      const driver = current.driver?.driver ?? 'synthetic';
      await recordResult(current, index, { status: 'done', detail: null, driver });
      const worked = await act(replayId, step, resolved.element, dropOn?.ok ? dropOn.element : null);
      if (!worked.ok) {
        // Back on the step, which the person does or skips.
        const back = await updateReplayState(
          (s) => ({ ...s, position: index, results: s.results.slice(0, index) }),
          replayId,
        );
        if (!back) continue;
        if (!(await playByHand(back, index, worked.reason ?? t('replay_reasonActionFailed')))) return;
        continue;
      }
      if (worked.driver !== driver) {
        await updateReplayState(
          (s) => ({
            ...s,
            results: Object.assign(s.results.slice(), { [index]: { ...s.results[index]!, driver: worked.driver } }),
          }),
          replayId,
        );
      }
      await updateReplayState((s) => ({ ...s, cursor: cursor?.position() ?? s.cursor }), replayId);
    }
  } finally {
    loopActive = false;
    if (replaced) void runReplay();
  }
}

// ---------------------------------------------------------------------------
// Choosing what to replay

/** A report to replay, and where its step screenshots come from. */
interface ChosenReport {
  steps: PiwiSteps;
  views: ReplayViews | null;
}

/**
 * The recording made in this browser and not discarded yet, a bug report or a
 * plain recording, as steps, with its step screenshots and which of the two it is.
 */
async function lastRecordedReport(): Promise<(ChosenReport & { bug: boolean }) | null> {
  try {
    const recording = await getRecordingState();
    if (recording.active || recording.events.length === 0) return null;
    const steps = normalizeSteps(recording.events);
    if (steps.length === 0) return null;
    const session = sessionFromEvents(recording.events, recording.startedAt ?? steps[0]!.timestamp);
    return {
      steps: toStepsDocument(session),
      views: { recordingViews: stepViews(session.steps) },
      bug: recordingMode(recording) === 'bug',
    };
  } catch {
    return null;
  }
}

function openChooser(lastReport: (ChosenReport & { bug: boolean }) | null): void {
  document.getElementById(REPLAY_DIALOG_HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = REPLAY_DIALOG_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `${STYLE}${DIALOG_CSS}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'box';
  panel.style.cssText = 'padding:16px;width:min(520px,92vw);';
  panel.setAttribute('role', 'dialog');
  panel.lang = uiLanguage();
  panel.setAttribute('aria-label', t('replay_dialogTitle'));
  let giveFocusBack: (() => void) | null = null;
  const close = () => {
    host.remove();
    giveFocusBack?.();
  };

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = t('replay_dialogTitle');
  const head = document.createElement('div');
  head.className = 'head';
  head.append(icon('replay'), title);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.append(...tNodes('replay_dialogIntro', { origin: urlView(location.origin) }));
  panel.append(head, sub);

  let chosen: PiwiSteps | null = null;
  /** The instance's report the steps came from, when they did. */
  let chosenReportId: number | null = null;
  /** Where the chosen report's step screenshots come from. */
  let chosenViews: ReplayViews | null = null;
  /** In a report made from a test run, the step the test failed at there. */
  let chosenRunFailedStep: number | null = null;
  /** Counts the reports asked for: an answer that comes after a later choice is left out. */
  let asked = 0;
  const summary = document.createElement('div');
  summary.className = 'sub';
  summary.style.marginTop = '6px';
  const message = document.createElement('div');
  message.className = 'message';
  message.setAttribute('role', 'alert');
  const startLabel = document.createElement('label');
  startLabel.className = 'check';
  startLabel.style.marginTop = '8px';
  startLabel.hidden = true;
  const startBox = document.createElement('input');
  startBox.type = 'checkbox';
  const startText = document.createElement('span');
  startLabel.append(startBox, startText);
  const describe = (
    steps: PiwiSteps,
    reportId: number | null = null,
    views: ReplayViews | null = null,
    runFailedStep: number | null = null,
  ) => {
    chosen = steps;
    chosenReportId = reportId;
    chosenViews = views;
    chosenRunFailedStep = runFailedStep;
    const first = steps.steps[0];
    startLabel.hidden = first?.action !== 'goto';
    startBox.checked = false;
    if (first?.action === 'goto') {
      startText.replaceChildren(...tNodes('replay_startHere', { path: urlView(first.value ?? first.pageUrl) }));
    }
    summary.replaceChildren(tn('replay_summary', steps.steps.length, { title: steps.title ?? t('replay_untitled') }));
    if (steps.origin && steps.origin !== location.origin) {
      summary.append(' · ', ...tNodes('replay_recordedOn', { origin: urlView(steps.origin) }));
    }
    message.textContent = '';
  };

  if (lastReport) {
    const use = button(
      lastReport.bug ? t('replay_useRecorded') : t('replay_useRecordedActions'),
      () => {
        asked++;
        reports.value = '';
        describe(lastReport.steps, null, lastReport.views);
      },
      { icon: lastReport.bug ? 'bug' : 'record' },
    );
    use.style.marginTop = '10px';
    panel.appendChild(use);
  }

  const file = document.createElement('input');
  file.type = 'file';
  file.accept = `.${BUG_REPORT_EXTENSION},.zip,.json,${BUG_REPORT_MEDIA_TYPE},application/zip,application/json`;
  file.setAttribute('aria-label', t('replay_fileLabel'));
  file.addEventListener('change', () => {
    const picked = file.files?.[0];
    if (!picked) return;
    const ask = ++asked;
    reports.value = '';
    void picked
      .arrayBuffer()
      .then((buffer) => readReportFile(picked.name, new Uint8Array(buffer)))
      .then(
        ({ steps, views, runFailedStep }) => {
          if (ask === asked) describe(steps, null, { views }, runFailedStep);
        },
        (e: unknown) => {
          if (ask !== asked) return;
          chosen = null;
          summary.textContent = '';
          message.textContent = e instanceof Error ? e.message : String(e);
        },
      );
  });
  const fileLabel = document.createElement('div');
  fileLabel.className = 'sub';
  fileLabel.style.marginTop = '10px';
  fileLabel.textContent = t('replay_chooseFile');
  panel.append(fileLabel, file);

  // Steps copied as text, such as the steps of an execution copied from the dashboard.
  const paste = document.createElement('details');
  const pasteSummary = document.createElement('summary');
  pasteSummary.className = 'sub';
  pasteSummary.textContent = t('replay_pasteSteps');
  const pasted = document.createElement('textarea');
  pasted.rows = 4;
  pasted.spellcheck = false;
  pasted.setAttribute('aria-label', t('replay_pasteLabel'));
  pasted.style.cssText =
    'display:block;width:100%;box-sizing:border-box;margin:6px 0;font:11px ui-monospace,monospace;';
  const usePasted = button(
    t('replay_pasteUse'),
    () => {
      asked++;
      reports.value = '';
      file.value = '';
      const parsed = parseSteps(pasted.value);
      if (parsed.ok) return describe(parsed.steps);
      chosen = null;
      summary.textContent = '';
      message.textContent = t('replay_pasteNotSteps', { error: parsed.errors[0] ?? '' });
    },
    { icon: 'paste' },
  );
  paste.append(pasteSummary, pasted, usePasted);
  paste.style.marginTop = '10px';
  panel.appendChild(paste);

  // Connected, the bug reports of the project this tab maps to, read by the worker.
  const fromPiwi = document.createElement('div');
  fromPiwi.hidden = true;
  const fromPiwiLabel = document.createElement('div');
  fromPiwiLabel.className = 'sub';
  fromPiwiLabel.style.marginTop = '10px';
  const reports = document.createElement('select');
  fromPiwi.append(fromPiwiLabel, reports);
  panel.append(fromPiwi, summary);
  void listInstanceReports().then((answer) => {
    if (!answer) return;
    if (!answer.ok) {
      fromPiwi.hidden = false;
      fromPiwiLabel.textContent = t('replay_fromPiwiFailed', { error: answer.error });
      reports.hidden = true;
      return;
    }
    if (!answer.project) return;
    fromPiwi.hidden = false;
    if (answer.items.length === 0) {
      fromPiwiLabel.textContent = t('replay_fromPiwiNone', { project: answer.project.label });
      reports.hidden = true;
      return;
    }
    fromPiwiLabel.textContent = t('replay_fromPiwi', { project: answer.project.label });
    reports.setAttribute('aria-label', t('replay_fromPiwiChoose'));
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('replay_fromPiwiChoose');
    reports.appendChild(placeholder);
    for (const item of answer.items) {
      const option = document.createElement('option');
      option.value = String(item.id);
      option.textContent = t('replay_fromPiwiItem', { id: item.id, title: item.title });
      reports.appendChild(option);
    }
  });
  reports.addEventListener('change', () => {
    const ask = ++asked;
    const id = Number(reports.value);
    if (!id) return;
    void instanceReportSteps(id).then((answer) => {
      if (ask !== asked || reports.value !== String(id)) return;
      if (answer.ok) describe(answer.steps, id);
      else {
        chosen = null;
        summary.textContent = '';
        message.textContent = t('replay_fromPiwiFailed', { error: answer.error });
      }
    });
  });

  const stepLabel = document.createElement('label');
  stepLabel.className = 'check';
  stepLabel.style.marginTop = '8px';
  const stepBox = document.createElement('input');
  stepBox.type = 'checkbox';
  stepLabel.append(stepBox, t('replay_stepByStepHint'));
  panel.append(startLabel, stepLabel);

  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '12px';
  // Disabled until the worker answers: a second click would start a second replay.
  const start = button(
    t('replay_start'),
    () => {
      if (!chosen) {
        message.textContent = t('replay_chooseFirst');
        return;
      }
      const steps = chosen;
      const startOn = !startLabel.hidden && startBox.checked ? location.href : null;
      start.disabled = true;
      void startReplay(steps, stepBox.checked, startOn, chosenReportId, chosenViews, chosenRunFailedStep).then(
        (response) => {
          if (!response.ok) {
            start.disabled = false;
            message.textContent = response.error ?? t('common_replayStartFailed');
            return;
          }
          close();
          void runReplay();
        },
      );
    },
    { icon: 'play', tone: 'primary' },
  );
  row.appendChild(start);
  row.appendChild(
    button(
      t('replay_runWithPlaywright'),
      () => {
        if (!chosen) {
          message.textContent = t('replay_chooseFirst');
          return;
        }
        const steps = chosen;
        close();
        openDesktopRun(steps, chosenReportId, STYLE);
      },
      { icon: 'terminal' },
    ),
  );
  row.appendChild(button(t('common_cancel'), close, { icon: 'close', className: 'end' }));
  panel.append(row, message);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.appendChild(panel);
  root.append(style, backdrop);
  giveFocusBack = holdFocus(panel, close);
}

// ---------------------------------------------------------------------------

async function entry(): Promise<void> {
  if (loopActive) return;
  const texts = initI18n();
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) =>
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }),
    );
  }
  const [state] = await Promise.all([ensureSessionAccess().then(() => getReplayState()), texts]);
  if (state && !state.finished && state.origin === location.origin) {
    const running = state.status === 'running' || state.status === 'paused';
    if (await replayHere(state)) {
      if (running) return void (await runReplay());
      // Stopped or done while no page of its tab played it (a Stop during a navigation): the verdict shows here.
      return void (await finish(state, state.status === 'stopped'));
    }
    // Another tab plays it. One stopped there has ended now, and this tab may replay a report.
    if (running) return;
  }
  openChooser(await lastRecordedReport());
}

const globals = globalThis as ReplayGlobals;
if (globals.__piwiReplayEntry) {
  void globals.__piwiReplayEntry();
} else {
  globals.__piwiReplayEntry = entry;
  document.addEventListener('focusin', trackPageFocus, true);
  const active = document.activeElement;
  if (active && active !== document.body && !isOwnHost(active)) pageFocus = active;
  window.addEventListener('beforeunload', () => {
    leaving = true;
  });
  chrome.runtime.onMessage.addListener((message) => {
    // A step opened its page in a new tab, and the replay goes on there: this page stops where it waits.
    if (message?.type === 'piwi-replay-moved') {
      if (typeof message.replayId === 'string') movedAway = message.replayId;
      waker.wakeWaiting();
      return undefined;
    }
    // The worker lost the replay's debugging session: the replay goes on with the page's own events.
    if (message?.type === 'piwi-replay-driver-lost') {
      void getReplayState().then((state) => {
        if (state && state.id === message.replayId) void fallBack(message.reason ?? 'lost', state.id);
      });
      return undefined;
    }
    // The Piwi panel in DevTools changed the stored state: draw it, and go on when asked.
    if (message?.type !== 'piwi-replay-wake') return undefined;
    void getReplayState().then((state) => {
      if (state && loopActive) renderHud(state);
    });
    if (message.wake === true) wakeLoop();
    else if (message.wake === 'waiting') waker.wakeWaiting();
    return undefined;
  });
  void entry();
}

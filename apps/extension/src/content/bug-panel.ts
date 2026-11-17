import { installPickerOverlay, removePickerOverlay, LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import {
  type AssertionMatcher,
  type RawCaptureEvent,
  type RecordedStep,
  type RecordedTarget,
  type StepAssertion,
} from '@piwitests/core/recording';
import { bugContextFrom, emptyBugEvidence, summarizeEvidence, type BugContext } from '@piwitests/core/bug-report';
import { parseLocatorChain, renderLocatorChain } from '@piwitests/core/locator-chain';

import { pickerOverlayStrings } from './picker-strings.js';
import { DomModel } from './engine-aria.js';
import { createLocatorEngine } from './locator-engine.js';
import { buildOutline, outlineRoot } from './bug-outline.js';
import { NO_SCREENSHOT_TAKEN, stepViewIds, type ReportLanguage } from './bug-report-files.js';
import { interfacePhrases } from '../shared/core-words.js';
import {
  BUG_DIALOG_HOST_ID,
  FRAME_HOST_ID,
  HUD_HOST_ID,
  SHARED_STYLE,
  hideSurfaces,
  isOwnHost,
  mountSurface,
} from './record-ui.js';
import { cornerInset, hudCorner, moveHudButton } from './hud-corner.js';

import {
  addBugScreenshot,
  getBugEvidence,
  setBugEvidenceFields,
  type ScreenshotFailure,
  type StoredBugEvidence,
} from '../shared/bug-storage.js';
import {
  endTool,
  installEscapeToCancel,
  startTool,
  teardownToolSurfaces,
  toolIsCurrent,
  waitForGlobal,
} from '../shared/tool-session.js';
import { formatNumber, t, tn, uiLanguage, type MessageKey } from '../shared/i18n.js';

import type { StoredStepView } from '../shared/step-views.js';
import { attachPanelShadow } from './panel-root.js';
import { getConnectionSettings } from '../shared/connection-settings.js';
import { activePathPrefixes } from '../shared/active-project.js';

import { BUTTON_CSS, makeButton, styleButton, type ButtonOptions } from '../shared/buttons.js';
import type { IconName } from '../shared/icons.js';
import { richText, STEP_CSS, stepView } from '../shared/step-view.js';
import { IDE_BUILD } from '../shared/ide-build.js';

/**
 * The recording's page UI: its bar, the record dialog the checks and
 * Something is missing open, the pick, the screenshots and the page outline.
 * `record-panel.ts` does the recording itself and relays the main-world
 * evidence script's entries (`shared/bug-relay.ts`); `check-panel.ts` holds
 * the checks and `finish-panel.ts` the finish panel.
 */

/** What `record-panel.ts` lends this module to record an assertion. */
export interface BugRecorderHooks {
  targetFor(element: Element): RecordedTarget;
  /** Records an `assert` event and answers the index of the step it became, or null when it was not recorded. */
  addAssert(target: RecordedTarget | null, assertion: StepAssertion): Promise<number | null>;
  /** While paused, the recorder captures nothing: a pick's click is not a step. */
  setPaused(paused: boolean): void;
}

/**
 * Why a report has no screenshot, as the report stores it: the browser takes
 * one only under the `activeTab` grant. The panels show
 * {@link screenshotNoteText} instead, in the interface language.
 */
const NO_SCREENSHOT_NOTE =
  'Chrome lets Piwi Picker take a screenshot only after you open it on this tab. Open Piwi Picker and choose Take a screenshot.';
/** The same in Firefox, whose grant is the same. */
const NO_SCREENSHOT_NOTE_FIREFOX =
  'Firefox lets Piwi Picker take a screenshot only after you open it on this tab. Open Piwi Picker and choose Take a screenshot.';

/** Why a report has no screenshot when its tab was in the background, as the report stores it. */
const TAB_NOT_IN_FRONT_NOTE = 'The tab was not the one in front, and the browser captures only the tab on screen.';

/** Why a report has no screenshot when the browser gave none for another reason, as the report stores it. */
const SCREENSHOT_FAILED_NOTE = 'The browser could not take the screenshot.';

/** Why a report has no screenshot when session storage had no room for the last one, as the report stores it. */
const SCREENSHOT_NOT_KEPT_NOTE = 'The screenshot was too large to keep in this browser’s storage.';

/** A stored screenshot note in the interface language; a note this module does not know stays as it is. */
export function screenshotNoteText(note: string): string {
  if (note === NO_SCREENSHOT_NOTE) return t('bug_screenshotBlocked', { action: t('popup_takeScreenshot') });
  if (note === NO_SCREENSHOT_NOTE_FIREFOX) {
    return t('bug_screenshotBlockedFirefox', { action: t('popup_takeScreenshot') });
  }
  if (note === TAB_NOT_IN_FRONT_NOTE) return t('bug_screenshotNotInFront');
  if (note === SCREENSHOT_FAILED_NOTE) return t('bug_screenshotFailed');
  if (note === SCREENSHOT_NOT_KEPT_NOTE) return t('bug_screenshotNotKept');
  if (note === NO_SCREENSHOT_TAKEN) return t('bug_noScreenshotNone');
  return note;
}

/** The note for a screenshot the worker could not take, by the reason it gave. */
function screenshotFailureNote(reason: ScreenshotFailure | undefined): string {
  if (reason === 'not-granted') {
    return navigator.userAgent.includes('Firefox/') ? NO_SCREENSHOT_NOTE_FIREFOX : NO_SCREENSHOT_NOTE;
  }
  if (reason === 'not-in-front') return TAB_NOT_IN_FRONT_NOTE;
  return SCREENSHOT_FAILED_NOTE;
}

/** The report's Markdown in the interface language. */
export function reportLanguage(): ReportLanguage {
  return { phrases: interfacePhrases(), screenshotNote: screenshotNoteText };
}

export const PANEL_CSS = `
  ${SHARED_STYLE}
  [hidden] { display: none !important; }
  ${LOCATOR_SYNTAX_CSS}
  ${BUTTON_CSS}
  ${STEP_CSS}
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: flex-start; justify-content: center; padding-top: 6vh; }
  .panel { background: #111827; color: #f9fafb; border-radius: 12px; padding: 16px; width: min(640px, 92vw); max-height: 86vh;
    overflow: auto; box-shadow: 0 8px 40px rgba(0,0,0,.5); font-size: 13px; line-height: 1.5; }
  @media (prefers-color-scheme: light) { .panel { background: #ffffff; color: #111827; box-shadow: 0 8px 40px rgba(0,0,0,.2); } }
  .panel { color-scheme: dark; }
  .panel:focus { outline: none; }
  option { background: #1f2937; color: #f9fafb; }
  @media (prefers-color-scheme: light) { .panel { color-scheme: light; } option { background: #ffffff; color: #111827; } }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .title { font-weight: 600; font-size: 14px; min-width: 0; overflow-wrap: anywhere; hyphens: auto; }
  .sub { color: #9ca3af; font-size: 12px; overflow-wrap: anywhere; }
  label { display: block; font-size: 11.5px; color: #9ca3af; margin: 10px 0 4px; overflow-wrap: anywhere; }
  input, select { width: 100%; font: inherit; font-size: 12.5px; padding: 6px 8px; border-radius: 6px;
    border: 1px solid rgba(128,128,128,.4); background: rgba(128,128,128,.1); color: inherit; }
  .actual { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; padding: 6px 8px; border-radius: 6px;
    background: rgba(148,163,184,.12); word-break: break-word; }
  .message { color: #fca5a5; font-size: 12px; margin-top: 8px; min-height: 1em; }
  .message:empty { display: none; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
  .actions + .actions { margin-top: 6px; }
  .actions .piwi-btn { white-space: nowrap; }
  .actions .discard { margin-inline-start: auto; }
  .steps { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; max-height: 260px; overflow: auto; margin: 10px 0; }
  .step { padding: 6px 10px; font-size: 12.5px; border-bottom: 1px solid rgba(128,128,128,.15); display: flex; gap: 8px; align-items: flex-start; }
  .step:last-child { border-bottom: none; }
  .step-idx { color: #9ca3af; flex-shrink: 0; min-width: 18px; text-align: end; font-size: 11px; padding-top: 3px; font-variant-numeric: tabular-nums; }
  .step .piwi-step { flex: 1; }
  .step.marked { background: rgba(239,68,68,.1); box-shadow: inset 3px 0 0 #ef4444; }
  .step-actual { color: #fca5a5; }
  .step-fn { margin-left: auto; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(124,58,237,.2); color: #a78bfa;
    flex-shrink: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .verdict { font-size: 12px; margin-top: 10px; padding: 6px 8px; border-radius: 6px; background: rgba(16,185,129,.12); color: #6ee7b7; }
  .verdict.wrong { background: rgba(239,68,68,.12); color: #fca5a5; }
  .evidence { font-size: 12px; color: #9ca3af; }
  .warn { color: #fca5a5; font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
  .local { color: #9ca3af; font-size: 11px; margin-top: 10px; }
  label.keep { display: flex; align-items: center; gap: 6px; font-size: 12px; color: inherit; margin: 8px 0 2px; }
  label.keep input { width: auto; margin: 0; }
  @media (prefers-color-scheme: light) {
    .sub, label, .step-idx, .evidence, .local { color: #6b7280; }
    label.keep { color: inherit; }
    .message, .warn, .step-actual, .verdict.wrong { color: #b91c1c; }
    .verdict { color: #047857; }
    .step-fn { color: #6d28d9; }
  }
`;

/** The HUD's lines that say what evidence the report holds: written again whenever it changes. */
interface BugHudEvidence {
  summary: HTMLElement;
  /** What the debugging session is doing, or why it stopped. */
  debugging: HTMLElement;
  /** Why there is no screenshot, when the last one failed. */
  screenshotNote: HTMLElement;
}

interface BugPanelGlobals {
  __piwiBugFlow?: boolean;
  /** Ends the pick of the flow on screen, as a cancel: see {@link cancelBugPick}. */
  __piwiBugPickCancel?: () => void;
  /** The HUD on screen, its shadow root and its evidence line: see {@link updateBugHudEvidence}. */
  __piwiBugHud?: BugHudEvidence & { host: HTMLElement; root: ShadowRoot };
  __piwiPickState?: string;
  __piwiPickedElement?: Element;
}

function panelGlobals(): BugPanelGlobals {
  return globalThis as BugPanelGlobals;
}

/** Pick-flow globals, cleared around a pick so a stale answer is never read. */
function clearPickGlobals(): void {
  const g = panelGlobals();
  delete g.__piwiPickState;
  delete g.__piwiPickedElement;
}

/**
 * Ends Check an element's pick, if one is on screen, as Escape does: its
 * overlay goes and the flow records nothing. Capture stopping calls it; a
 * global, since each injection of the recorder is its own module instance.
 */
export function cancelBugPick(): void {
  panelGlobals().__piwiBugPickCancel?.();
}

/**
 * Picks an element as a pick tool of its own (`tool-session.ts`): a Pick
 * started meanwhile leaves it be, any other tool, Escape or
 * {@link cancelBugPick} ends it. Answers the element picked, or null.
 */
export async function pickElement(): Promise<Element | null> {
  const g = panelGlobals();
  const epoch = startTool('pick', teardownToolSurfaces);
  installEscapeToCancel();
  const cancel = () => endTool(epoch);
  g.__piwiBugPickCancel = cancel;
  try {
    clearPickGlobals();
    installPickerOverlay({ transport: 'global', failing: null, strings: pickerOverlayStrings() });
    const state = await waitForGlobal<string>('__piwiPickState', epoch);
    // Another tool took over: the overlay and the pick globals are its own.
    if (!toolIsCurrent(epoch)) return null;
    const element = g.__piwiPickedElement;
    return state === 'picked' && element ? element : null;
  } finally {
    if (g.__piwiBugPickCancel === cancel) delete g.__piwiBugPickCancel;
    if (toolIsCurrent(epoch)) {
      removePickerOverlay();
      clearPickGlobals();
    }
    endTool(epoch);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Hides the recorder's own surfaces for the duration of `run`, so a screenshot shows only the page. */
async function withSurfacesHidden<T>(run: () => Promise<T>): Promise<T> {
  const show = hideSurfaces([HUD_HOST_ID, FRAME_HOST_ID, BUG_DIALOG_HOST_ID]);
  try {
    return await run();
  } finally {
    show();
  }
}

/**
 * Asks the background worker for a screenshot of this tab and keeps it.
 * Without the debugging session the browser allows one only under the
 * `activeTab` grant; when the worker gets none, the report notes why, by the
 * reason the worker gives, instead of asking for a wider permission. Never
 * rejects: a screenshot session storage has no room for leaves a note saying so.
 */
export async function takeBugScreenshot(moment: 'marked' | 'finish' | 'manual', step: number | null): Promise<boolean> {
  const response = await withSurfacesHidden(async () => {
    await nextFrame();
    await nextFrame();
    try {
      return (await chrome.runtime.sendMessage({ type: 'piwi-bug-screenshot' })) as
        | { ok: true; dataUrl: string }
        | { ok: false; error?: string; reason?: ScreenshotFailure }
        | undefined;
    } catch {
      return undefined;
    }
  });
  try {
    if (response?.ok && typeof response.dataUrl === 'string' && response.dataUrl.startsWith('data:image/')) {
      await addBugScreenshot({ moment, step, takenAt: Date.now(), dataUrl: response.dataUrl });
      return true;
    }
    await setBugEvidenceFields({ screenshotNote: screenshotFailureNote(response?.ok ? undefined : response?.reason) });
  } catch {
    await setBugEvidenceFields({ screenshotNote: SCREENSHOT_NOT_KEPT_NOTE }).catch(() => undefined);
  } finally {
    // The HUD drawn while the screenshot was taken counted the evidence before it.
    await refreshBugHudEvidence();
  }
  return false;
}

/**
 * Asks the background worker for a screenshot of the page as the next step
 * begins, kept under `id` (see `background/step-views.ts`). With `hide`, the
 * recorder's own surfaces are hidden until the screenshot is taken; an action
 * that asks as it starts leaves them, rather than delay the page.
 */
export async function captureStepView(
  id: string,
  viewport: { width: number; height: number },
  hide: boolean,
): Promise<void> {
  const ask = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'piwi-bug-step-view', id, viewport });
    } catch {
      // No screenshot for this step: the report goes without it.
    }
  };
  if (!hide) return ask();
  await withSurfacesHidden(async () => {
    await nextFrame();
    await nextFrame();
    await ask();
  });
}

/** The screenshots of the page as each step began that the worker kept for this recording. */
export async function keptStepViews(events: RawCaptureEvent[]): Promise<StoredStepView[]> {
  const ids = stepViewIds(events);
  if (ids.length === 0) return [];
  try {
    const views = (await chrome.runtime.sendMessage({ type: 'piwi-bug-step-views', ids })) as unknown;
    return Array.isArray(views)
      ? views.filter(
          (v): v is StoredStepView =>
            typeof v?.id === 'string' && typeof v?.dataUrl === 'string' && v.dataUrl.startsWith('data:image/jpeg;'),
        )
      : [];
  } catch {
    return [];
  }
}

/** The context of this page for the report, its page keyed through the path prefixes of the site's URL mapping. */
export async function currentBugContext(): Promise<BugContext> {
  const prefixes = await getConnectionSettings()
    .then((settings) => activePathPrefixes(settings, location.href))
    .catch(() => ({}));
  let extensionVersion: string | null = null;
  try {
    extensionVersion = chrome.runtime.getManifest().version;
  } catch {
    extensionVersion = null;
  }
  return bugContextFrom({
    url: location.href,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    time: Date.now(),
    extensionVersion,
    ...prefixes,
  });
}

/** An outline around `element`, or of the page's main landmark (else its body) with no element. */
export function outlineAround(element: Element | null): string {
  const model = new DomModel();
  const start = element ?? document.querySelector('main, [role="main"]') ?? document.body;
  return buildOutline(outlineRoot(start, model), { model, skip: isOwnHost });
}

// ---------------------------------------------------------------------------
// Dialogs

interface DialogParts {
  form: HTMLFormElement;
  /** Shows why the dialog cannot be submitted yet. */
  say(message: string): void;
  field(label: string, control: HTMLElement): void;
}

/**
 * A modal dialog over the page, in its own closed shadow root. `build` fills
 * the form and answers the element to focus and a submit function: its value
 * closes the dialog, and null keeps it open (after `say` explained why). A
 * dialog removed from the page (capture stopped, the page replaced its
 * content) answers null, as Cancel does. Its main button reads `submitLabel`.
 * Shared by the bug report's dialogs and a test recording's checks.
 */
export function openRecordDialog<T>(
  title: string,
  build: (parts: DialogParts) => { focus: HTMLElement; submit: () => T | null | Promise<T | null> },
  submitLabel: string = t('bug_addToReport'),
  submitIcon: IconName = 'flag',
): Promise<T | null> {
  document.getElementById(BUG_DIALOG_HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = BUG_DIALOG_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  mountSurface(host);
  const root = attachPanelShadow(host, { mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  panel.lang = uiLanguage();
  const heading = document.createElement('div');
  heading.className = 'title';
  heading.textContent = title;
  const form = document.createElement('form');
  const message = document.createElement('div');
  message.className = 'message';
  message.setAttribute('role', 'alert');
  const parts: DialogParts = {
    form,
    say: (text) => {
      message.textContent = text;
    },
    field: (label, control) => {
      const id = `f${form.querySelectorAll('label').length}`;
      const el = document.createElement('label');
      el.textContent = label;
      el.htmlFor = id;
      control.id = id;
      form.append(el, control);
    },
  };
  const { focus, submit } = build(parts);
  const actions = document.createElement('div');
  actions.className = 'actions';
  const addBtn = document.createElement('button');
  addBtn.type = 'submit';
  addBtn.textContent = submitLabel;
  styleButton(addBtn, { icon: submitIcon, tone: 'primary', className: 'action primary' });
  let cancel = (): void => undefined;
  const cancelBtn = makeButton(t('common_cancel'), () => cancel(), { icon: 'close', className: 'action' });
  actions.append(addBtn, cancelBtn);
  form.append(message, actions);
  panel.append(heading, form);
  backdrop.appendChild(panel);
  root.append(style, backdrop);

  return new Promise<T | null>((resolve) => {
    const controller = new AbortController();
    const removed = new MutationObserver(() => {
      if (!host.isConnected) close(null);
    });
    const close = (value: T | null) => {
      controller.abort();
      removed.disconnect();
      host.remove();
      resolve(value);
    };
    removed.observe(document, { childList: true, subtree: true });
    cancel = () => close(null);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void Promise.resolve(submit()).then((value) => {
        if (value != null) close(value);
      });
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close(null);
      },
      { capture: true, signal: controller.signal },
    );
    focus.focus();
    if (focus instanceof HTMLInputElement) focus.select();
  });
}

export function input(value = '', placeholder = ''): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.value = value;
  el.placeholder = placeholder;
  el.autocomplete = 'off';
  return el;
}

/** The state words a recorded assertion keeps in `actual`, which the report stores in English. */
const STATE_WORDS: Record<string, MessageKey> = {
  visible: 'bug_stateVisible',
  hidden: 'bug_stateHidden',
  enabled: 'bug_stateEnabled',
  disabled: 'bug_stateDisabled',
};

const STATE_MATCHERS = new Set<AssertionMatcher>(['toBeVisible', 'toBeHidden', 'toBeEnabled', 'toBeDisabled']);

/** What `actual` holds for an element named in Something is missing. */
const MISSING_ACTUAL = 'not on the page';

/** The kinds of element a person can say are missing, in their words, most common first. */
const MISSING_KINDS: ReadonlyArray<{ role: string; label: MessageKey }> = [
  { role: 'button', label: 'bug_kindButton' },
  { role: 'link', label: 'bug_kindLink' },
  { role: 'heading', label: 'bug_kindHeading' },
  { role: 'textbox', label: 'bug_kindTextbox' },
  { role: 'combobox', label: 'bug_kindCombobox' },
  { role: 'checkbox', label: 'bug_kindCheckbox' },
  { role: 'radio', label: 'bug_kindRadio' },
  { role: 'option', label: 'bug_kindOption' },
  { role: 'tab', label: 'bug_kindTab' },
  { role: 'menuitem', label: 'bug_kindMenuitem' },
  { role: 'listitem', label: 'bug_kindListitem' },
  { role: 'row', label: 'bug_kindRow' },
  { role: 'cell', label: 'bug_kindCell' },
  { role: 'img', label: 'bug_kindImg' },
  { role: 'dialog', label: 'bug_kindDialog' },
  { role: 'alert', label: 'bug_kindAlert' },
  { role: 'status', label: 'bug_kindStatus' },
  { role: 'region', label: 'bug_kindRegion' },
];

/** `getByRole(role, { name })`, rendered by the chain grammar so the name is quoted the one safe way. */
function roleLocator(role: string, name: string): string {
  return renderLocatorChain({
    calls: [
      {
        method: 'getByRole',
        args: [
          { type: 'string', value: role },
          { type: 'object', entries: [['name', { type: 'string', value: name }]] },
        ],
      },
    ],
  });
}

function missingDialog(): Promise<{ target: RecordedTarget; note: string | null } | null> {
  return openRecordDialog(t('bug_missing'), ({ field, say }) => {
    const role = document.createElement('select');
    for (const kind of MISSING_KINDS) {
      const option = document.createElement('option');
      option.value = kind.role;
      option.textContent = t(kind.label);
      role.appendChild(option);
    }
    field(t('bug_whatShouldBeThere'), role);
    const name = input('', t('bug_namePlaceholder'));
    field(t('bug_itsNameLabel'), name);
    const note = input('', t('bug_notePlaceholder'));
    field(t('bug_note'), note);
    return {
      focus: name,
      submit: () => {
        const text = name.value.trim();
        if (!text) {
          say(t('bug_nameRequired'));
          return null;
        }
        const locator = roleLocator(role.value, text);
        const engine = createLocatorEngine(document, { ignore: isOwnHost });
        let found = 0;
        try {
          found = engine.queryAll(parseLocatorChain(locator)).length;
        } catch {
          found = 0;
        }
        if (found > 0) {
          say(tn('bug_alreadyThere', found, { mark: t('record_checkElement') }));
          return null;
        }
        return {
          target: {
            tagName: '',
            role: role.value,
            accessibleName: text,
            testId: null,
            text: null,
            alternatives: [{ locator, method: 'getByRole', score: 100 }],
          },
          note: note.value.trim() || null,
        };
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Flows started from the HUD

/** Runs one flow of the recorder's at a time: a flow started while another is on screen does nothing. */
export async function exclusive(run: () => Promise<void>): Promise<void> {
  const g = panelGlobals();
  if (g.__piwiBugFlow) return;
  g.__piwiBugFlow = true;
  try {
    await run();
  } finally {
    g.__piwiBugFlow = false;
  }
}

/** Name an element that should be on the page and is not. */
export function runMissingFlow(hooks: BugRecorderHooks): Promise<void> {
  return exclusive(async () => {
    hooks.setPaused(true);
    try {
      const missing = await missingDialog();
      if (!missing) return;
      const step = await hooks.addAssert(missing.target, {
        matcher: 'toBeVisible',
        expected: null,
        actual: MISSING_ACTUAL,
        negated: false,
        note: missing.note,
      });
      await setBugEvidenceFields({ outline: outlineAround(null) });
      await takeBugScreenshot('marked', step);
    } finally {
      hooks.setPaused(false);
    }
  });
}

// ---------------------------------------------------------------------------
// HUD

/** What the recording bar's buttons do: `record-panel.ts` runs each. */
export interface RecordingBarHandlers {
  checkElement(): void;
  checkAddress(): void;
  /** Something is missing: not in the IDE bundle. */
  missing(): void;
  /** A screenshot now: offered while the debugging protocol takes them. */
  screenshot(): void;
  pause(): void;
  /** Finish in the extension, Stop in the IDE bundle. */
  finish(): void;
}

/** What the recording bar shows, read by `record-panel.ts` as it draws it. */
export interface RecordingBarView {
  title: string;
  steps: RecordedStep[];
  paused: boolean;
  /** The evidence collected so far; null in the IDE bundle, which collects none. */
  evidence: StoredBugEvidence | null;
  captureError: string | null;
  /** The matching test functions, drawn under the buttons when the project has a catalog. */
  functions: HTMLElement | null;
}

/** What the HUD says about the debugging session: expected while it runs, and why it stopped when it did. */
function debuggingNote(evidence: StoredBugEvidence): string | null {
  const debugging = evidence.debugging;
  if (!debugging) return null;
  if (debugging.state === 'on') return t('bug_debuggingOn');
  if (debugging.reason === 'canceled') return t('bug_debuggingCanceled', { action: t('popup_takeScreenshot') });
  if (debugging.reason === 'refused' || debugging.reason === 'lost') {
    return t('bug_debuggingRefused', { action: t('popup_takeScreenshot') });
  }
  return null;
}

function evidenceSummary(evidence: StoredBugEvidence): string {
  return summarizeEvidence(
    {
      ...emptyBugEvidence(),
      console: evidence.console,
      requests: evidence.requests,
      outline: evidence.outline,
      screenshots: Array.from({ length: evidence.screenshots }, () => ({
        file: '',
        step: null,
        moment: 'manual',
        takenAt: 0,
      })),
    },
    interfacePhrases(),
  );
}

export function stepRow(step: RecordedStep, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = step.action === 'assert' && step.assertion?.actual != null ? 'step marked' : 'step';
  const idx = document.createElement('span');
  idx.className = 'step-idx';
  idx.textContent = formatNumber(index + 1);
  const view = stepView(step);
  row.append(idx, view);
  const assertion = step.assertion;
  if (step.action === 'assert' && assertion?.actual != null) {
    const shown = document.createElement('span');
    shown.className = 'step-actual';
    shown.append(' · ', ...richText(actualInWords(assertion.matcher, assertion.actual)));
    view.querySelector('.piwi-step-words')?.appendChild(shown);
  }
  return row;
}

/** A recorded state word (`hidden`) in the interface language. */
export function stateWord(actual: string): string {
  const key = STATE_WORDS[actual];
  return key ? t(key) : actual;
}

/** What the page showed at a marked step: a text in quotes, a state, or the missing element's absence. */
function actualInWords(matcher: AssertionMatcher, actual: string): string {
  if (matcher === 'toBeVisible' && actual === MISSING_ACTUAL) return t('bug_stepAbsent');
  if (STATE_MATCHERS.has(matcher) && STATE_WORDS[actual]) return t('bug_stepIs', { state: stateWord(actual) });
  return t('bug_stepShows', { text: actual });
}

/**
 * Writes the evidence line of the HUD on screen again, leaving the rest of it,
 * and the focus in it, as it is: what the page relays changes nothing else.
 * False when there is no HUD to update.
 */
export function updateBugHudEvidence(evidence: StoredBugEvidence): boolean {
  const shown = shownBugHud();
  if (!shown) return false;
  writeHudEvidence(shown, evidence);
  return true;
}

/** Reads the evidence stored now and writes the HUD's evidence lines with it, when the HUD is on screen. */
export async function refreshBugHudEvidence(): Promise<void> {
  if (!shownBugHud()) return;
  const evidence = await getBugEvidence().catch(() => null);
  if (evidence) updateBugHudEvidence(evidence);
}

function writeHudEvidence(lines: BugHudEvidence, evidence: StoredBugEvidence): void {
  lines.summary.textContent = evidenceSummary(evidence);
  const debugging = debuggingNote(evidence);
  lines.debugging.textContent = debugging ?? '';
  lines.debugging.hidden = !debugging;
  const note = evidence.screenshotNote ? screenshotNoteText(evidence.screenshotNote) : null;
  lines.screenshotNote.textContent = note ?? '';
  lines.screenshotNote.hidden = !note;
}

function shownBugHud(): BugPanelGlobals['__piwiBugHud'] | null {
  const shown = panelGlobals().__piwiBugHud;
  return shown && document.getElementById(HUD_HOST_ID) === shown.host ? shown : null;
}

/** The action of the HUD button that has the focus, or null when the focus is not in the HUD. */
function focusedHudAction(): string | null {
  const focused = shownBugHud()?.root.activeElement;
  return focused instanceof HTMLElement ? (focused.dataset.action ?? null) : null;
}

/**
 * The recording bar: the last steps, the checks, Something is missing, a
 * screenshot while the debugging protocol takes them, Pause and Finish, the
 * matching test functions, and what evidence has been collected. Every label
 * stays on one line: a row of buttons wraps between buttons. Its shadow root
 * delegates focus, so focusing the host reaches its first button. A redraw
 * keeps the focus in the bar, on the button that had it when it is still there.
 */
export function renderRecordingBar(view: RecordingBarView, handlers: RecordingBarHandlers): void {
  const focusedAction = focusedHudAction();
  document.getElementById(HUD_HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HUD_HOST_ID;
  host.style.cssText = `all:initial;position:fixed;inset:${cornerInset(hudCorner())};z-index:2147483647;`;
  mountSurface(host);
  const root = attachPanelShadow(host, { mode: 'closed', delegatesFocus: true });
  const style = document.createElement('style');
  style.textContent = `
    ${SHARED_STYLE}
    ${LOCATOR_SYNTAX_CSS}
    ${BUTTON_CSS}
    ${STEP_CSS}
    [hidden] { display: none !important; }
    .bar { display: flex; flex-direction: column; gap: 8px; background: #111827; color: #f9fafb; border-radius: 12px;
      padding: 10px 12px; box-shadow: 0 8px 30px rgba(0,0,0,.4); font-size: 12.5px; width: 360px; max-width: calc(100vw - 32px);
      position: relative; }
    .bar > .move { position: absolute; top: 6px; right: 8px; }
    @media (prefers-color-scheme: light) {
      .bar { background: #ffffff; color: #111827; box-shadow: 0 8px 30px rgba(0,0,0,.2); border: 1px solid #e5e7eb; }
    }
    .top { display: flex; align-items: center; gap: 6px; padding-right: 28px; min-height: 24px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; flex-shrink: 0; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    .dot.paused { background: #9ca3af; animation: none; }
    .title { font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .steps { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; max-height: 170px; overflow: auto; }
    .step { display: flex; gap: 6px; overflow-wrap: anywhere; align-items: flex-start; }
    .step-idx { color: #9ca3af; width: 16px; flex-shrink: 0; text-align: right; padding-top: 2px; font-variant-numeric: tabular-nums; }
    .step .piwi-step { flex: 1; gap: 6px; }
    .step .piwi-step-badge { width: 18px; height: 18px; }
    .step .piwi-step-badge .piwi-icon { width: 12px; height: 12px; }
    .step.marked .piwi-step-words { color: #fca5a5; }
    .step-actual { opacity: .85; }
    .buttons { display: flex; flex-wrap: wrap; gap: 6px; }
    .buttons .piwi-btn { flex: 1 1 auto; white-space: nowrap; }
    .buttons .finish { flex-grow: 3; }
    .evidence, .empty { color: #9ca3af; font-size: 11px; overflow-wrap: anywhere; }
    .warn { color: #fca5a5; font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
    .section-title { color: #9ca3af; font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; }
    .match { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
    .match-name { font-family: ui-monospace, monospace; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .match-bar { width: 34px; height: 4px; border-radius: 2px; background: rgba(128,128,128,.25); overflow: hidden; flex-shrink: 0; }
    .match-bar-fill { height: 100%; background: #7c3aed; }
    .match-badge { font-size: 9.5px; padding: 1px 4px; border-radius: 4px; flex-shrink: 0; }
    .match-badge.complete { background: rgba(34,197,94,.2); color: #22c55e; }
    .match-badge.partial { color: #9ca3af; }
    @media (prefers-color-scheme: light) {
      .warn, .step.marked .piwi-step-words { color: #b91c1c; }
      .evidence, .empty, .step-idx, .section-title, .match-badge.partial { color: #6b7280; }
      .match-badge.complete { color: #15803d; }
    }
  `;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', t('record_hudLabel'));
  bar.lang = uiLanguage();

  const top = document.createElement('div');
  top.className = 'top';
  const dot = document.createElement('div');
  dot.className = view.paused ? 'dot paused' : 'dot';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = view.title;
  top.append(dot, title);
  bar.appendChild(top);

  if (view.paused) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = t('record_pausedNote');
    bar.appendChild(note);
  }

  const { steps } = view;
  if (steps.length > 0) {
    const list = document.createElement('div');
    list.className = 'steps';
    const first = Math.max(0, steps.length - 6);
    steps.slice(first).forEach((step, i) => list.appendChild(stepRow(step, first + i)));
    bar.appendChild(list);
    // Keep the latest step in view.
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  }

  const tools = document.createElement('div');
  tools.className = 'buttons';
  const ends = document.createElement('div');
  ends.className = 'buttons';
  const button = (
    into: HTMLElement,
    action: keyof RecordingBarHandlers,
    label: string,
    options: ButtonOptions,
  ): HTMLButtonElement => {
    const b = makeButton(label, () => handlers[action](), { small: true, ...options });
    b.dataset.action = action;
    into.appendChild(b);
    return b;
  };
  // Nothing is recorded while paused, so no check either.
  button(tools, 'checkElement', t('record_checkElement'), {
    icon: 'check-circle',
    title: t('record_checkElementHint'),
  }).disabled = view.paused;
  button(tools, 'checkAddress', t('record_checkAddress'), {
    icon: 'globe',
    title: t('record_checkAddressHint'),
  }).disabled = view.paused;
  if (!IDE_BUILD) {
    button(tools, 'missing', t('bug_missing'), { icon: 'missing', title: t('bug_missingHint') }).disabled = view.paused;
  }
  if (view.evidence?.debugging?.state === 'on') {
    button(tools, 'screenshot', t('bug_screenshot'), { icon: 'camera', title: t('bug_screenshotHint') });
  }
  bar.appendChild(tools);

  const pause = button(ends, 'pause', view.paused ? t('record_resume') : t('record_pause'), {
    icon: view.paused ? 'play' : 'pause',
    className: 'pause',
  });
  pause.setAttribute('aria-pressed', String(view.paused));
  if (IDE_BUILD) {
    button(ends, 'finish', t('common_stop'), { icon: 'stop-circle', tone: 'danger', className: 'stop finish' });
  } else {
    button(ends, 'finish', t('bug_finish'), { icon: 'check', tone: 'success', className: 'finish' });
  }
  bar.appendChild(ends);

  if (view.captureError) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.setAttribute('role', 'alert');
    warn.textContent = view.captureError;
    bar.appendChild(warn);
  }
  if (view.functions) bar.appendChild(view.functions);

  const lines: BugHudEvidence = {
    summary: document.createElement('div'),
    debugging: document.createElement('div'),
    screenshotNote: document.createElement('div'),
  };
  lines.summary.className = 'evidence';
  lines.debugging.className = 'evidence';
  lines.screenshotNote.className = 'warn';
  if (view.evidence) {
    bar.append(lines.summary, lines.debugging, lines.screenshotNote);
    writeHudEvidence(lines, view.evidence);
  }
  panelGlobals().__piwiBugHud = { host, root, ...lines };

  // Last in the bar, so its actions come first from the keyboard; drawn in its top right corner.
  const move = moveHudButton(host);
  move.classList.add('move');
  // Named as the actions are, so a redraw keeps the focus on it.
  move.dataset.action = 'move';
  bar.appendChild(move);
  root.append(style, bar);
  if (focusedAction) (root.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`) ?? host).focus();
}

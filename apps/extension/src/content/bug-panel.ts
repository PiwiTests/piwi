import { installPickerOverlay, removePickerOverlay, highlightLocator, LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import {
  normalizeSteps,
  sessionFromEvents,
  stepViews,
  VALUE_MATCHERS,
  type AssertionMatcher,
  type RawCaptureEvent,
  type RecordedStep,
  type RecordedTarget,
  type StepAssertion,
} from '@piwitests/core/recording';
import {
  BUG_REPORT_EXTENSION,
  BUG_REPORT_MEDIA_TYPE,
  bugContextFrom,
  emptyBugEvidence,
  expectedSteps,
  renderBugSpec,
  summarizeEvidence,
  type BugContext,
} from '@piwitests/core/bug-report';
import { parseLocatorChain, renderLocatorChain } from '@piwitests/core/locator-chain';
import { suggestAssertions } from './assertion-suggest.js';
import { isSensitiveField } from './sensitive-fields.js';
import { pickerOverlayStrings } from './picker-strings.js';
import { DomModel } from './engine-aria.js';
import { createLocatorEngine } from './locator-engine.js';
import { buildOutline, outlineRoot } from './bug-outline.js';
import {
  assembleBugReport,
  bugReportArchive,
  bugReportMarkdown,
  NO_SCREENSHOT_TAKEN,
  stepShotsOf,
  stepViewIds,
  withoutStepShots,
  type ReportLanguage,
} from './bug-report-files.js';
import { codegenWarningText, interfacePhrases } from '../shared/core-words.js';
import {
  BUG_DIALOG_HOST_ID,
  FRAME_HOST_ID,
  HUD_HOST_ID,
  PANEL_HOST_ID,
  SHARED_STYLE,
  copyToClipboard,
  fileStamp,
  hideSurfaces,
  isOwnHost,
  mountSurface,
} from './record-ui.js';
import { downloadBlob } from '../shared/download.js';
import {
  addBugScreenshot,
  getBugEvidence,
  getBugScreenshots,
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
import { formatNumber, t, tn, tNodes, uiLanguage, type MessageKey } from '../shared/i18n.js';
import type { RecordingState } from '../shared/recording-storage.js';
import type { StoredStepView } from '../shared/step-views.js';
import { attachPanelShadow } from './panel-root.js';
import { getConnectionSettings } from '../shared/connection-settings.js';
import { activePathPrefixes } from '../shared/active-project.js';
import { openSendPreview, SEND_DIALOG_HOST_ID, sendTarget } from './bug-send-panel.js';
import { BUTTON_CSS, makeButton, styleButton, type ButtonOptions } from '../shared/buttons.js';
import type { IconName } from '../shared/icons.js';
import { STEP_CSS, stepView, urlView } from '../shared/step-view.js';

/**
 * The bug recording's page UI: its HUD, the three ways to say what is wrong
 * (a picked element's expected value or state, an element that is missing,
 * the page the flow should have reached), its screenshots and page outline,
 * and the finish panel that exports the report. `record-panel.ts` does the
 * recording itself, relays the main-world evidence script's entries
 * (`shared/bug-relay.ts`), and calls into this module when the recording is a
 * bug report.
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
function screenshotNoteText(note: string): string {
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
function reportLanguage(): ReportLanguage {
  return { phrases: interfacePhrases(), screenshotNote: screenshotNoteText };
}

const PANEL_CSS = `
  ${SHARED_STYLE}
  ${LOCATOR_SYNTAX_CSS}
  ${BUTTON_CSS}
  ${STEP_CSS}
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: flex-start; justify-content: center; padding-top: 6vh; }
  .panel { background: #111827; color: #f9fafb; border-radius: 12px; padding: 16px; width: min(640px, 92vw); max-height: 86vh;
    overflow: auto; box-shadow: 0 8px 40px rgba(0,0,0,.5); font-size: 13px; line-height: 1.5; }
  @media (prefers-color-scheme: light) { .panel { background: #ffffff; color: #111827; box-shadow: 0 8px 40px rgba(0,0,0,.2); } }
  .panel { color-scheme: dark; }
  option { background: #1f2937; color: #f9fafb; }
  @media (prefers-color-scheme: light) { .panel { color-scheme: light; } option { background: #ffffff; color: #111827; } }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .title { font-weight: 600; font-size: 14px; min-width: 0; overflow-wrap: anywhere; hyphens: auto; }
  .sub { color: #9ca3af; font-size: 12px; overflow-wrap: anywhere; }
  label { display: block; font-size: 11.5px; color: #9ca3af; margin: 10px 0 4px; overflow-wrap: anywhere; }
  input, select { width: 100%; font: inherit; font-size: 12.5px; padding: 6px 8px; border-radius: 6px;
    border: 1px solid rgba(128,128,128,.4); background: rgba(128,128,128,.1); color: inherit; }
  .actual { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; padding: 6px 8px; border-radius: 6px;
    background: rgba(239,68,68,.12); word-break: break-word; }
  .message { color: #fca5a5; font-size: 12px; margin-top: 8px; min-height: 1em; }
  .message:empty { display: none; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
  .actions .discard { margin-inline-start: auto; }
  .steps { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; max-height: 260px; overflow: auto; margin: 10px 0; }
  .step { padding: 6px 10px; font-size: 12.5px; border-bottom: 1px solid rgba(128,128,128,.15); display: flex; gap: 8px; align-items: flex-start; }
  .step:last-child { border-bottom: none; }
  .step-idx { color: #9ca3af; flex-shrink: 0; min-width: 18px; text-align: end; font-size: 11px; padding-top: 3px; font-variant-numeric: tabular-nums; }
  .step .piwi-step { flex: 1; }
  .step.marked { background: rgba(239,68,68,.1); box-shadow: inset 3px 0 0 #ef4444; }
  .step-actual { color: #fca5a5; }
  .evidence { font-size: 12px; color: #9ca3af; }
  .warn { color: #fca5a5; font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
  .local { color: #9ca3af; font-size: 11px; margin-top: 10px; }
  label.keep { display: flex; align-items: center; gap: 6px; font-size: 12px; color: inherit; margin: 8px 0 2px; }
  label.keep input { width: auto; margin: 0; }
  @media (prefers-color-scheme: light) {
    .sub, label, .step-idx, .evidence, .local { color: #6b7280; }
    label.keep { color: inherit; }
    .message, .warn, .step-actual { color: #b91c1c; }
  }
`;

interface BugPanelGlobals {
  __piwiBugFlow?: boolean;
  /** Ends the pick of the flow on screen, as a cancel: see {@link cancelBugPick}. */
  __piwiBugPickCancel?: () => void;
  /** The HUD on screen, its shadow root and its evidence line: see {@link updateBugHudEvidence}. */
  __piwiBugHud?: { host: HTMLElement; root: ShadowRoot; summary: HTMLElement };
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
 * Ends Mark what's wrong's pick, if one is on screen, as Escape does: its
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
async function keptStepViews(events: RawCaptureEvent[]): Promise<StoredStepView[]> {
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

interface ExpectedChoice {
  matcher: AssertionMatcher;
  label: string;
  /** What the page shows now. */
  actual: string;
}

const STATE_LABELS: Partial<Record<AssertionMatcher, MessageKey>> = {
  toBeVisible: 'bug_shouldBeVisible',
  toBeHidden: 'bug_shouldBeHidden',
  toBeEnabled: 'bug_shouldBeEnabled',
  toBeDisabled: 'bug_shouldBeDisabled',
};

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

/**
 * What can be said to be wrong about an element: its value, text or name, or
 * the opposite of each state it is in. A field that holds a secret
 * (`isSensitiveField`) offers its states only, so what it holds is never shown
 * or kept.
 */
function expectedChoices(element: Element): { locator: string | null; choices: ExpectedChoice[] } {
  const suggestion = suggestAssertions(element);
  const choices: ExpectedChoice[] = [];
  const secret = isSensitiveField(element);
  for (const c of suggestion.candidates) {
    if (c.detail == null || secret) continue;
    if (c.method === 'toHaveValue') choices.push({ matcher: c.method, label: t('bug_itsValue'), actual: c.detail });
    if (c.method === 'toHaveText') choices.push({ matcher: c.method, label: t('bug_itsText'), actual: c.detail });
    if (c.method === 'toHaveAccessibleName')
      choices.push({ matcher: c.method, label: t('bug_itsName'), actual: c.detail });
  }
  const model = new DomModel();
  const visible = model.isVisible(element);
  const disabled = model.disabled(element);
  const states: Array<[AssertionMatcher, string]> = [
    [visible ? 'toBeHidden' : 'toBeVisible', visible ? 'visible' : 'hidden'],
    [disabled ? 'toBeEnabled' : 'toBeDisabled', disabled ? 'disabled' : 'enabled'],
  ];
  for (const [matcher, actual] of states) choices.push({ matcher, label: t(STATE_LABELS[matcher]!), actual });
  return { locator: suggestion.locator, choices };
}

/** The expected-value dialog for a picked element. */
function expectedDialog(element: Element): Promise<StepAssertion | null> {
  const { locator, choices } = expectedChoices(element);
  return openRecordDialog<StepAssertion>(t('bug_mark'), ({ form, field, say }) => {
    if (locator) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      const code = document.createElement('span');
      code.className = 'piwi-loc';
      code.innerHTML = highlightLocator(locator);
      sub.append(...tNodes('bug_onElement', { locator: code }));
      form.appendChild(sub);
    }
    const select = document.createElement('select');
    choices.forEach((c, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = c.label;
      select.appendChild(option);
    });
    field(t('bug_whatsWrong'), select);
    const actual = document.createElement('div');
    actual.className = 'actual';
    field(t('bug_pageShows'), actual);
    const expected = input();
    field(t('bug_shouldShow'), expected);
    const note = input('', t('bug_notePlaceholder'));
    field(t('bug_note'), note);

    const expectedLabel = expected.previousElementSibling as HTMLElement;
    const show = () => {
      const choice = choices[Number(select.value)]!;
      const takesValue = VALUE_MATCHERS.has(choice.matcher);
      expected.hidden = !takesValue;
      expectedLabel.hidden = !takesValue;
      actual.textContent = takesValue ? choice.actual : stateWord(choice.actual);
      if (takesValue) expected.value = choice.actual;
      say('');
    };
    select.addEventListener('change', show);
    show();

    return {
      focus: VALUE_MATCHERS.has(choices[0]!.matcher) ? expected : select,
      submit: () => {
        const choice = choices[Number(select.value)]!;
        const takesValue = VALUE_MATCHERS.has(choice.matcher);
        if (takesValue && expected.value === choice.actual) {
          say(t('bug_sameAsPage'));
          return null;
        }
        return {
          matcher: choice.matcher,
          expected: takesValue ? expected.value : null,
          actual: choice.actual,
          negated: false,
          note: note.value.trim() || null,
        };
      },
    };
  });
}

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
          say(tn('bug_alreadyThere', found, { mark: t('bug_mark') }));
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

function wrongPageDialog(): Promise<StepAssertion | null> {
  const here = `${location.pathname}${location.search}`;
  return openRecordDialog<StepAssertion>(t('bug_wrongPage'), ({ form, field, say }) => {
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.append(...tNodes('bug_youAreOn', { path: urlView(here) }));
    form.appendChild(sub);
    const expected = input(location.pathname, '/checkout/thanks');
    field(t('bug_pageShouldBe'), expected);
    const note = input('', t('bug_notePlaceholder'));
    field(t('bug_note'), note);
    return {
      focus: expected,
      submit: () => {
        const value = expected.value.trim();
        if (!value || value === here || value === location.pathname || value === location.href) {
          say(t('bug_samePage'));
          return null;
        }
        return { matcher: 'toHaveURL', expected: value, actual: here, negated: false, note: note.value.trim() || null };
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

/** Pick an element, say what it should show, and record that as an expected assertion. */
export function runMarkFlow(hooks: BugRecorderHooks): Promise<void> {
  return exclusive(async () => {
    hooks.setPaused(true);
    // Out of the way while picking, so the HUD itself cannot be picked.
    let showHud = hideSurfaces([HUD_HOST_ID]);
    try {
      const element = await pickElement();
      showHud();
      showHud = () => undefined;
      if (!element) return;
      const assertion = await expectedDialog(element);
      if (!assertion) return;
      const step = await hooks.addAssert(hooks.targetFor(element), assertion);
      await setBugEvidenceFields({ outline: outlineAround(element) });
      await takeBugScreenshot('marked', step);
    } finally {
      showHud();
      hooks.setPaused(false);
    }
  });
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

/** Say which page the flow should have reached. */
export function runWrongPageFlow(hooks: BugRecorderHooks): Promise<void> {
  return exclusive(async () => {
    hooks.setPaused(true);
    try {
      const assertion = await wrongPageDialog();
      if (!assertion) return;
      const step = await hooks.addAssert(null, assertion);
      await setBugEvidenceFields({ outline: outlineAround(null) });
      await takeBugScreenshot('marked', step);
    } finally {
      hooks.setPaused(false);
    }
  });
}

// ---------------------------------------------------------------------------
// HUD

export interface BugHudHandlers {
  mark(): void;
  missing(): void;
  wrongPage(): void;
  finish(): void;
  /** A screenshot now: offered while the debugging protocol takes them. */
  screenshot(): void;
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

function stepRow(step: RecordedStep, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = step.action === 'assert' ? 'step marked' : 'step';
  const idx = document.createElement('span');
  idx.className = 'step-idx';
  idx.textContent = formatNumber(index + 1);
  const view = stepView(step);
  row.append(idx, view);
  const assertion = step.assertion;
  if (step.action === 'assert' && assertion?.actual != null) {
    const shown = document.createElement('span');
    shown.className = 'step-actual';
    shown.textContent = ` · ${actualInWords(assertion.matcher, assertion.actual)}`;
    view.querySelector('.piwi-step-words')?.appendChild(shown);
  }
  return row;
}

/** A recorded state word (`hidden`) in the interface language. */
function stateWord(actual: string): string {
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
  shown.summary.textContent = evidenceSummary(evidence);
  return true;
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
 * The HUD of a bug recording: the last steps, the three ways to mark what is
 * wrong, Finish, and what evidence has been collected. Its shadow root
 * delegates focus, so focusing the host reaches its first button. A redraw
 * keeps the focus in the HUD, on the button that had it when it is still there.
 */
export function renderBugHud(
  state: RecordingState,
  evidence: StoredBugEvidence,
  captureError: string | null,
  handlers: BugHudHandlers,
): void {
  const focusedAction = focusedHudAction();
  document.getElementById(HUD_HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HUD_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:auto 16px 16px auto;z-index:2147483647;';
  mountSurface(host);
  const root = attachPanelShadow(host, { mode: 'closed', delegatesFocus: true });
  const style = document.createElement('style');
  style.textContent = `
    ${SHARED_STYLE}
    ${LOCATOR_SYNTAX_CSS}
    ${BUTTON_CSS}
    ${STEP_CSS}
    .bar { display: flex; flex-direction: column; gap: 8px; background: #111827; color: #f9fafb; border-radius: 12px;
      padding: 10px 12px; box-shadow: 0 8px 30px rgba(0,0,0,.4); font-size: 12.5px; width: 360px; max-width: calc(100vw - 32px); }
    @media (prefers-color-scheme: light) {
      .bar { background: #ffffff; color: #111827; box-shadow: 0 8px 30px rgba(0,0,0,.2); border: 1px solid #e5e7eb; }
    }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; flex-shrink: 0; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    .title { font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .steps { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; max-height: 170px; overflow: auto; }
    .step { display: flex; gap: 6px; overflow-wrap: anywhere; align-items: flex-start; }
    .step-idx { color: #9ca3af; width: 16px; flex-shrink: 0; text-align: right; padding-top: 2px; font-variant-numeric: tabular-nums; }
    .step .piwi-step { flex: 1; gap: 6px; }
    .step .piwi-step-badge { width: 18px; height: 18px; }
    .step .piwi-step-badge .piwi-icon { width: 12px; height: 12px; }
    .step.marked .piwi-step-words { color: #fca5a5; }
    .step-actual { opacity: .85; }
    .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .buttons .piwi-btn { justify-content: flex-start; }
    .buttons .finish { grid-column: 1 / -1; justify-content: center; }
    .evidence { color: #9ca3af; font-size: 11px; overflow-wrap: anywhere; }
    .warn { color: #fca5a5; font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
    @media (prefers-color-scheme: light) { .warn, .step.marked .piwi-step-words { color: #b91c1c; } .evidence, .step-idx { color: #6b7280; } }
  `;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', t('bug_reportLabel'));
  bar.lang = uiLanguage();

  const steps = normalizeSteps(state.events);
  const top = document.createElement('div');
  top.className = 'row';
  const dot = document.createElement('div');
  dot.className = 'dot';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = tn('bug_hudTitle', steps.length);
  top.append(dot, title);
  bar.appendChild(top);

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

  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const button = (action: keyof BugHudHandlers, label: string, options: ButtonOptions) => {
    const b = makeButton(label, () => handlers[action](), { small: true, ...options });
    b.dataset.action = action;
    buttons.appendChild(b);
    return b;
  };
  button('mark', t('bug_mark'), { icon: 'flag', title: t('bug_markHint') });
  button('missing', t('bug_missing'), { icon: 'missing', title: t('bug_missingHint') });
  button('wrongPage', t('bug_wrongPage'), { icon: 'globe', title: t('bug_wrongPageHint') });
  if (evidence.debugging?.state === 'on') {
    button('screenshot', t('bug_screenshot'), { icon: 'camera', title: t('bug_screenshotHint') });
  }
  button('finish', t('bug_finish'), { icon: 'check', tone: 'danger', className: 'finish' });
  bar.appendChild(buttons);

  const summary = document.createElement('div');
  summary.className = 'evidence';
  summary.textContent = evidenceSummary(evidence);
  bar.appendChild(summary);
  panelGlobals().__piwiBugHud = { host, root, summary };

  const note = debuggingNote(evidence);
  if (note) {
    const line = document.createElement('div');
    line.className = 'evidence';
    line.textContent = note;
    bar.appendChild(line);
  }

  for (const text of [captureError, evidence.screenshotNote && screenshotNoteText(evidence.screenshotNote)]) {
    if (!text) continue;
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = text;
    bar.appendChild(warn);
  }

  root.append(style, bar);
  if (focusedAction) (root.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`) ?? host).focus();
}

// ---------------------------------------------------------------------------
// Finish panel

/**
 * The finished report: a title, the steps with what was marked, the evidence,
 * the exports, and, when an instance is connected, Send to Piwi…, which shows
 * exactly what would be sent before anything is.
 */
export async function renderBugFinishPanel(state: RecordingState, onDiscard: () => Promise<void>): Promise<void> {
  document.getElementById(HUD_HOST_ID)?.remove();
  document.getElementById(PANEL_HOST_ID)?.remove();
  document.getElementById(FRAME_HOST_ID)?.remove();

  const [evidence, screenshots, views] = await Promise.all([
    getBugEvidence(),
    getBugScreenshots(),
    keptStepViews(state.events),
  ]);
  const context = evidence.context ?? (await currentBugContext());
  const startedAt = state.startedAt ?? state.events[0]?.timestamp ?? Date.now();
  let title = evidence.title ?? '';
  /** The reporter keeps the step screenshots unless they leave them out. */
  let keepStepShots = true;
  const report = () => {
    const assembled = assembleBugReport({
      events: state.events,
      startedAt,
      evidence: { ...evidence, title },
      screenshots,
      context,
      views,
    });
    return keepStepShots ? assembled : withoutStepShots(assembled);
  };
  const initial = report();
  const stepImages = new Map(
    stepShotsOf(sessionFromEvents(state.events, startedAt).steps, views).map(({ shot, dataUrl }) => [
      shot.file,
      dataUrl,
    ]),
  );

  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('bug_reportLabel'));
  panel.lang = uiLanguage();
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'header';
  const heading = document.createElement('div');
  heading.className = 'title';
  heading.textContent = tn('bug_finishTitle', initial.steps.steps.length);
  const closeBtn = makeButton(t('common_close'), () => closePanel(), {
    icon: 'close',
    iconOnly: true,
    tone: 'ghost',
    className: 'close',
  });
  header.append(heading, closeBtn);
  panel.appendChild(header);

  const titleLabel = document.createElement('label');
  titleLabel.textContent = t('bug_title');
  titleLabel.htmlFor = 'bug-title';
  const titleInput = input(title, t('bug_titlePlaceholder'));
  titleInput.id = 'bug-title';
  titleInput.addEventListener('input', () => {
    title = titleInput.value;
    void setBugEvidenceFields({ title }).catch(() => undefined);
  });
  panel.append(titleLabel, titleInput);

  const stepsWrap = document.createElement('div');
  stepsWrap.className = 'steps';
  initial.steps.steps.forEach((step, i) => stepsWrap.appendChild(stepRow(step, i)));
  panel.appendChild(stepsWrap);

  const summary = document.createElement('div');
  summary.className = 'evidence';
  const summarize = () => t('bug_attached', { summary: summarizeEvidence(report().evidence, interfacePhrases()) });
  summary.textContent = summarize();
  panel.appendChild(summary);

  if (stepImages.size > 0) {
    const keep = document.createElement('label');
    keep.className = 'keep';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      keepStepShots = box.checked;
      summary.textContent = summarize();
    });
    keep.append(box, t('bug_stepShots', { count: formatNumber(stepImages.size) }));
    const hint = document.createElement('div');
    hint.className = 'evidence';
    hint.textContent = t('bug_stepShotsHint');
    panel.append(keep, hint);
  }

  const notes: string[] = [];
  if (expectedSteps(initial).length === 0) {
    notes.push(t('bug_nothingMarked', { mark: t('bug_mark') }));
  }
  for (const w of renderBugSpec(initial).warnings)
    notes.push(t('bug_stepWarning', { step: w.step + 1, message: codegenWarningText(w) }));
  if (initial.evidence.screenshots.length === 0) {
    notes.push(
      evidence.screenshotNote
        ? t('bug_noScreenshot', { reason: screenshotNoteText(evidence.screenshotNote) })
        : t('bug_noScreenshotTaken'),
    );
  }
  for (const text of notes) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = text;
    panel.appendChild(warn);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const action = (label: string, options: ButtonOptions, onClick: (btn: HTMLButtonElement) => void) => {
    const b: HTMLButtonElement = makeButton(label, () => onClick(b), options);
    actions.appendChild(b);
    return b;
  };
  action(t('bug_copyTest'), { icon: 'code', tone: 'primary', title: t('bug_copyTestHint') }, (b) => {
    void copyToClipboard(renderBugSpec(report()).code, b);
  });
  action(t('bug_copyReport'), { icon: 'copy', title: t('bug_copyReportHint') }, (b) => {
    void copyToClipboard(bugReportMarkdown(report(), reportLanguage()), b);
  });
  action(t('bug_downloadReport'), { icon: 'download', title: t('bug_downloadReportHint') }, () => {
    const current = report();
    downloadBlob(
      new Blob([bugReportArchive(current, screenshots, reportLanguage(), stepImages) as BlobPart], {
        type: BUG_REPORT_MEDIA_TYPE,
      }),
      `piwi-bug-${fileStamp(current.context.time)}.${BUG_REPORT_EXTENSION}`,
    );
  });

  const controller = new AbortController();
  const closePanel = () => {
    controller.abort();
    host.remove();
  };
  const replayMessage = document.createElement('div');
  replayMessage.className = 'warn';
  action(t('bug_replay'), { icon: 'play', title: t('bug_replayHint') }, (b) => {
    b.disabled = true;
    void (async () => {
      let response: { ok: boolean; error?: string } | undefined;
      try {
        response = await chrome.runtime.sendMessage({
          type: 'piwi-start-replay',
          steps: report().steps,
          origin: location.origin,
          stepMode: false,
          inject: true,
          // The replay shows a step it hands to the person as the recording saw it.
          recordingViews: stepViews(sessionFromEvents(state.events, startedAt).steps),
        });
      } catch (e) {
        response = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (response?.ok) closePanel();
      else {
        b.disabled = false;
        replayMessage.textContent = response?.error ?? t('common_replayStartFailed');
      }
    })();
  });
  const sendBtn = action(t('bug_sendToPiwi'), { icon: 'send', title: t('bug_sendToPiwiHint') }, () => {
    void sendTarget().then((target) => {
      if (!target.project) {
        replayMessage.textContent = t('bug_sendNoProject');
        return;
      }
      openSendPreview({
        report: report(),
        screenshots,
        stepImages,
        target: { ...target, project: target.project },
        css: PANEL_CSS,
      });
    });
  });
  sendBtn.hidden = true;
  action(t('common_discard'), { icon: 'trash', tone: 'remove', className: 'discard' }, () => {
    void onDiscard().then(closePanel, closePanel);
  });
  panel.append(actions, replayMessage);

  const local = document.createElement('div');
  local.className = 'local';
  local.textContent = t('bug_staysLocal');
  panel.appendChild(local);
  void sendTarget().then((target) => {
    if (!target.connected) return;
    sendBtn.hidden = false;
    local.textContent = t('bug_staysLocalUntilSent');
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closePanel();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && !document.getElementById(SEND_DIALOG_HOST_ID)) closePanel();
    },
    { capture: true, signal: controller.signal },
  );

  backdrop.appendChild(panel);
  root.append(style, backdrop);
  panel.focus();
}

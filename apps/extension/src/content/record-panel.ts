import {
  normalizeSteps,
  buildSession,
  RECORDED_KEYS,
  type RawCaptureEvent,
  type RecordedTarget,
  type StepAssertion,
  type StepView,
} from '@piwitests/core/recording';
import { rankFunctionMatches, type TestFunctionEntry, type RankedFunctionMatch } from '@piwitests/core/function-match';
import { renderSpec } from '@piwitests/core/codegen';
import { toStepsDocument, type PiwiSteps } from '@piwitests/core/steps';
import { IDE_PAUSED_MESSAGE, type IdeRecorderSettings } from '@piwitests/core/ide-recorder';
import { highlightLocator, LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import { formatNumber, initI18n, t, tn, uiLanguage } from '../shared/i18n.js';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { STEP_CSS, stepView } from '../shared/step-view.js';
import { relayEvidence } from '../shared/bug-relay.js';
import { classifyInputKind, isActionKind, lastActionOf, ownNavigation } from './record-capture.js';
import { cornerInset, hudCorner, loadHudCorner, moveHudButton } from './hud-corner.js';
import { isSensitiveField, rememberChangedFields } from './sensitive-fields.js';
import { rankElement, verifiedLocators } from './verified-locators.js';
import { parentElementOrShadowHost } from './engine-aria.js';
import { HoverTracker, cssHoverSubjects, outermostFirst } from './hover-reveal.js';
import { documentStyleRules } from './hover-rules.js';
import {
  getRecordingState,
  appendRecordingEvent,
  stopRecording,
  discardRecording,
  recordingMode,
  updateRecording,
  type RecordingState,
} from '../shared/recording-storage.js';
import { appendBugEntries, getBugEvidence, setBugEvidenceFields, storeAsPageLeaves } from '../shared/bug-storage.js';
import {
  cancelBugPick,
  captureStepView,
  currentBugContext,
  outlineAround,
  renderBugFinishPanel,
  renderBugHud,
  runMarkFlow,
  runMissingFlow,
  runWrongPageFlow,
  takeBugScreenshot,
  updateBugHudEvidence,
  type BugRecorderHooks,
} from './bug-panel.js';
import {
  HUD_HOST_ID,
  PANEL_HOST_ID,
  FRAME_HOST_ID,
  BUG_DIALOG_HOST_ID,
  OWN_HOST_IDS,
  SHARED_STYLE,
  copyToClipboard,
  fileStamp,
  mountSurface,
  startReplayHere,
} from './record-ui.js';
import { downloadBlob } from '../shared/download.js';
import { getCachedCatalog } from '../shared/catalog-cache.js';
import { requestCatalogRefresh } from '../shared/catalog-refresh.js';
import { ensureSessionAccess } from '../shared/session-access.js';
import { getConnectionSettings } from '../shared/connection-settings.js';
import { getActiveProjectOverride, resolveActiveProject } from '../shared/active-project.js';
import { attachPanelShadow } from './panel-root.js';
import { getEditorPairing } from '../shared/editor-pairing.js';
import { sendToEditor, showSendResult } from '../shared/editor-send.js';
import { IDE_BUILD, getIdeSettings, ideHostInstalled } from '../shared/ide-build.js';
import { runCheckAddressFlow, runCheckElementFlow } from './check-panel.js';
import { webOrigin } from '../shared/web-origin.js';
import { cleanTitle, RECORDING_TITLE_MAX, titleFromSteps } from '../shared/recording-title.js';

/**
 * The DOM shapes a click/action can reasonably land on — a click deeper inside one of these snaps up to it, same intent
 * as the picker overlay's own snapping, though not the identical algorithm — but for the elements carrying a test id,
 * which {@link actionableSelector} adds.
 */
const ACTIONABLE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="combobox"], [role="treeitem"], [contenteditable]:not([contenteditable="false" i])';

/**
 * The attribute `getByTestId` reads in the project being recorded (Playwright's `testIdAttribute`): in the IDE bundle,
 * the launcher's, read as the recorder starts on a page (`loadRecorderSettings`); null for Playwright's default,
 * `data-testid`, which the extension always uses.
 */
let testIdAttribute: string | null = null;

/** In the IDE bundle, what the launcher hands the recorder: the file the steps are written into, which the HUD names. */
let ideSettings: IdeRecorderSettings | null = null;

/**
 * Whether the recording is paused, from the HUD's Pause or, in the IDE bundle, the editor's: nothing is captured until
 * it resumes. Read from the recording as each page starts, then kept up to date by the HUD and by
 * `piwi-recording-paused`, which the worker passes on to the recording's other tabs and the launcher to every page.
 */
let recordingPaused = false;

/** The start time of the recording this page captures, read as it starts: Pause applies to that recording only. */
let recordingStartedAt: number | null = null;

/** {@link ACTIONABLE_SELECTOR} with the elements carrying the project's test id attribute. */
function actionableSelector(): string {
  return `${ACTIONABLE_SELECTOR}, [${CSS.escape(testIdAttribute ?? 'data-testid')}]`;
}

/** Where an arrow key moves through choices rather than a caret or the page, and so is worth replaying. */
const ARROW_KEY_WIDGETS =
  'select, [role="combobox"], [role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="grid"], [role="tablist"], [role="radiogroup"], [aria-activedescendant]';

/** Inputs Playwright's `fill` refuses: their `input` event is not a fill. */
const UNFILLABLE_INPUT_TYPES = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'hidden']);

/** Fields a character typed into is text, not a shortcut; {@link inTextField} adds the editable elements. */
const TEXT_FIELDS =
  'textarea, select, input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="file"], [type="range"], [type="color"], [type="image"])';

/** Whether `el` takes what is typed as text: a text field, or an element the page lets the person edit. */
function inTextField(el: Element | null | undefined): boolean {
  return !!el && (!!el.closest(TEXT_FIELDS) || (el as Partial<HTMLElement>).isContentEditable === true);
}
const MODIFIER_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'AltGraph',
  'Meta',
  'CapsLock',
  'Fn',
  'Dead',
  'Unidentified',
]);
/** Keys that edit a field or move its caret, with or without a modifier: the field's fill says what they did. */
const FIELD_EDIT_KEYS = new Set([
  'a',
  'c',
  'v',
  'x',
  'z',
  'y',
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * A key press as Playwright writes it, or null when it only types, edits or
 * moves the focus: Enter, Escape and the arrows in a list (`RECORDED_KEYS`),
 * a shortcut with a modifier (`ControlOrMeta+K`, portable between Ctrl and
 * ⌘), and a character pressed outside a field, a page's own shortcut.
 *
 * A character typed with AltGr (which also sets Ctrl and Alt on Windows) or
 * with Option on a Mac (`©`) is typing, not a shortcut. In a field that holds
 * a secret (`isSensitiveField`), and when the focus is inside a closed shadow
 * root (`hiddenFocus`), which may hold one, only an unmodified key of
 * `RECORDED_KEYS` is recorded, so no key a password holds is ever written down.
 */
function recordedKey(e: KeyboardEvent, focused: Element | null, hiddenFocus: boolean): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (e.getModifierState?.('AltGraph')) return null;
  const secret = hiddenFocus || (!!focused && isSensitiveField(focused));
  const inField = secret || inTextField(focused);
  const typedWithOption =
    IS_MAC && e.altKey && !e.metaKey && !e.ctrlKey && [...e.key].length === 1 && e.key.trim() !== '';
  // A letter or digit by its key, whatever Alt or a layout made of it.
  const named = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3).toLowerCase()
    : /^Digit\d$/.test(e.code)
      ? e.code.slice(5)
      : e.key;
  const modifiers = typedWithOption
    ? []
    : [
        (IS_MAC ? e.metaKey : e.ctrlKey) && 'ControlOrMeta',
        IS_MAC && e.ctrlKey && 'Control',
        !IS_MAC && e.metaKey && 'Meta',
        e.altKey && 'Alt',
      ].filter((m): m is string => !!m);
  if (modifiers.length > 0 && secret) return null;
  if (modifiers.length === 0) {
    if (e.shiftKey && [...e.key].length > 1) return null;
    if (RECORDED_KEYS.has(e.key)) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !focused?.closest(ARROW_KEY_WIDGETS)) return null;
      return e.key;
    }
    return !inField && [...e.key].length === 1 && e.key !== ' ' ? e.key : null;
  }
  if (inField && FIELD_EDIT_KEYS.has(named)) return null;
  if (e.shiftKey) modifiers.push('Shift');
  return [...modifiers, named === ' ' ? 'Space' : named].join('+');
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * A stable identity for an element, for as long as this document lives.
 *
 * `normalizeSteps` needs to know whether two consecutive `input` events came
 * from the same field, and two unlabelled `<input>`s are indistinguishable by
 * everything else a `RecordedTarget` carries — same tag, same role, no name, no
 * test id, and no locator alternative either. The prefix keeps keys from two
 * pages of one recording from ever colliding.
 */
const elementKeys = new WeakMap<Element, string>();
const KEY_PREFIX = Math.random().toString(36).slice(2, 8);
let nextElementKey = 0;

function elementKeyFor(el: Element): string {
  let key = elementKeys.get(el);
  if (key == null) {
    key = `${KEY_PREFIX}-${++nextElementKey}`;
    elementKeys.set(el, key);
  }
  return key;
}

/**
 * Element → `RecordedTarget`: the element named and ranked as every picking
 * tool does (`rankElement`: the accessible name Playwright computes, "Regressions
 * 5" rather than `textContent`'s "Regressions5", and no ranking on the probe's
 * estimated counts), keeping the top few locators that find it alone on the
 * page (`verifiedLocators`) and the role/testId/text a catalog pattern match
 * needs, the test id read from the project's attribute (`testIdAttribute`).
 * Tested by driving the real built bundle, since `generateAlternatives`
 * can't be reconstructed from its source (see `extension/AGENTS.md`).
 */
function deriveRecordedTarget(el: Element): RecordedTarget {
  const { attrs, accessibleName, role, ranked } = rankElement(el, { testIdAttribute });
  return {
    tagName: attrs.tagName,
    role,
    accessibleName,
    testId: attrs.attributes[testIdAttribute ?? 'data-testid'] ?? null,
    text: el.textContent ? normalizeText(el.textContent).slice(0, 200) : null,
    alternatives: verifiedLocators(el, ranked, { testIdAttribute }),
    elementKey: elementKeyFor(el),
  };
}

/**
 * `deriveRecordedTarget` for a field mid-burst, computed once per element.
 *
 * The probe behind it walks the document to count same-role and same-text
 * elements and to score anchor ancestors — cheap once per click, too costly on
 * every `input` event. Coalescing already discards all but the last value of a
 * burst, and `normalizeSteps` keeps the target from the burst's first event, so
 * deriving it once per field changes nothing it produces.
 */
const fieldTargets = new WeakMap<Element, RecordedTarget>();

function fieldTarget(el: Element): RecordedTarget {
  let derived = fieldTargets.get(el);
  if (derived == null) {
    derived = deriveRecordedTarget(el);
    fieldTargets.set(el, derived);
  }
  return derived;
}

/** Controls that hold controls of their own a person aims at apart: a tree item's expand arrow, its label. */
const COMPOSITE_CONTROLS = '[role="treeitem"]';

/**
 * Where the page made the pointer a hand on the way up from `el` to `stop`
 * (left out): the outermost element showing a pointer cursor its parent does
 * not show. Null when there is none, or when `stop` shows one too, which its
 * content then only inherits.
 */
function pointerRegion(el: Element, stop: Element | null): Element | null {
  const pointer = (node: Element) => getComputedStyle(node).cursor === 'pointer';
  if (stop && pointer(stop)) return null;
  let region: Element | null = null;
  for (let node: Element | undefined = el; node && node !== stop; node = parentElementOrShadowHost(node)) {
    if (node === node.ownerDocument.body || node === node.ownerDocument.documentElement) return null;
    if (pointer(node)) region = node;
    else if (region) break;
  }
  return region;
}

/**
 * The control `el` is part of: itself or its nearest actionable ancestor, out
 * through the hosts of the shadow roots it is in. Inside a tree item, the
 * part the page made clickable on its own (its expand arrow); for an icon's
 * drawing in no control at all, the element the page made clickable around
 * it, else the icon.
 */
function nearestActionable(el: Element): Element {
  const selector = actionableSelector();
  for (let node: Element | undefined = el; node; node = parentElementOrShadowHost(node)) {
    if (!node.matches(selector)) continue;
    return node !== el && node.matches(COMPOSITE_CONTROLS) ? (pointerRegion(el, node) ?? node) : node;
  }
  if (el instanceof SVGElement) return pointerRegion(el, null) ?? el.closest('svg') ?? el;
  return el;
}

/** What a person points at when the pointer enters `entered`: the control around it, if inside `within`. */
function pointedAt(entered: Element, within: Element): Element {
  const control = entered.closest(actionableSelector());
  return control && within.contains(control) ? control : entered;
}

/** Follows the pointer and the page's insertions while this document records, for `hoverTargets`. */
let hoverTracker: HoverTracker | null = null;

/**
 * The hovers a click on `el` depends on, outermost first, named as the page
 * stands now: the elements whose CSS `:hover` or script reveal showed `el` or
 * one of its ancestors. An element named by text the hover shows is named by
 * the element inside it the pointer entered it through instead. Plain pointer
 * movement gives none.
 */
function hoverTargets(el: Element): RecordedTarget[] {
  const css = cssHoverSubjects(el, documentStyleRules());
  const scripted = hoverTracker?.scriptSubject(el, pointedAt);
  const subjects = css.map((s) => s.subject);
  if (scripted && scripted !== el && !el.contains(scripted)) subjects.push(scripted);
  return outermostFirst(subjects).map((subject) => {
    const target = deriveRecordedTarget(subject);
    const revealed = css.find((s) => s.subject === subject)?.revealed;
    const via = revealed ? hoverTracker?.enteredVia(subject) : null;
    if (!revealed || !via || via === subject || revealed.contains(via)) return target;
    return namesRevealed(target, revealed) ? deriveRecordedTarget(pointedAt(via, subject)) : target;
  });
}

/** Whether the best locator of a target names it by text only its hover shows. */
function namesRevealed(target: RecordedTarget, revealed: Element): boolean {
  const locator = target.alternatives[0]?.locator ?? '';
  const words = normalizeText(revealed.textContent ?? '');
  return !locator || (words.length > 0 && locator.includes(words.slice(0, 40)));
}

/**
 * The control a press began on, and its target as the page stood then. A
 * control that opens on press (a custom select, a menu button) covers itself
 * with what it opened before the button comes back up: the browser then sends
 * the click to what the press and the release have in common, often `<html>`,
 * and a modal popup has already hidden the rest of the page from role queries.
 * The press says which control it was, what named it, and which hovers
 * revealed it, while the pointer is still on it.
 */
interface Press {
  el: Element;
  target: RecordedTarget;
  hovers: RecordedTarget[];
  at: number;
}
let lastPress: Press | null = null;
const PRESS_CLICK_WINDOW_MS = 2000;

/** The control a click acted on, from its press when it had one; `pointer` is false for a click from the keyboard, which no hover revealed. */
function clickTarget(raw: Element, at: number, pointer: boolean): Omit<Press, 'at'> {
  const el = nearestActionable(raw);
  const press = lastPress;
  lastPress = null;
  if (press && press.el.isConnected && at - press.at <= PRESS_CLICK_WINDOW_MS) {
    if (press.el === el || el.contains(press.el)) return press;
  }
  return { el, target: deriveRecordedTarget(el), hovers: pointer ? hoverTargets(el) : [] };
}

/**
 * Enter recorded in a form's field. The browser answers it with a click on the
 * form's submit button, no pointer behind it (`detail` 0), which the press
 * already stands for. The next key or press ends it, so the button's own
 * activation from the keyboard stays a step. The click comes within the same
 * few tasks as the key; the allowance is for a busy page, not for human timing.
 */
let enterInForm: { form: HTMLFormElement; at: number } | null = null;
const ENTER_SUBMIT_WINDOW_MS = 500;

/** Whether `el` submits `form` when clicked. */
function submitsForm(el: Element, form: HTMLFormElement): boolean {
  if (el instanceof HTMLButtonElement) return el.type === 'submit' && el.form === form;
  return el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image') && el.form === form;
}

/** Whether a click is the one the browser sends to a form's submit button for the Enter just recorded in its field. */
function submitFromEnter(e: MouseEvent, el: Element): boolean {
  const enter = enterInForm;
  if (!enter || e.detail !== 0 || performance.now() - enter.at > ENTER_SUBMIT_WINDOW_MS) return false;
  if (!submitsForm(el, enter.form)) return false;
  enterInForm = null;
  return true;
}

function withinOwnUi(e: Event): boolean {
  return e.composedPath().some((n) => n instanceof HTMLElement && OWN_HOST_IDS.has(n.id));
}

/**
 * The element an event began at. To a listener on the document, `target` is
 * the host of the shadow root the event came from; the composed path goes on
 * inside every open shadow root, and ends at the host of a closed one.
 */
function deepTarget(e: Event): Element | null {
  const first = e.composedPath()[0];
  return first instanceof Element ? first : null;
}

/**
 * Whether the focus is inside a closed shadow root `el` hosts, as far as the
 * browser shows one to an extension (`chrome.dom` in Chrome and Edge,
 * `openOrClosedShadowRoot` in Firefox). An open one is never hidden: the
 * composed path goes inside it.
 */
function focusInClosedShadowRoot(el: Element): boolean {
  if (el.shadowRoot) return false;
  try {
    const root =
      chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement) ??
      (el as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot;
    return root?.activeElement != null;
  } catch {
    return false;
  }
}

/** Whether capture is paused in this document: a bug report's pick or dialog is on screen, or the recording is paused. */
function capturePaused(): boolean {
  return recorderGlobals().__piwiRecordPaused === true || recordingPaused;
}

/**
 * Pauses or resumes the recording from the HUD. The extension keeps it in the
 * recording, which each page reads as it starts, and the worker tells the
 * recording's other tabs; in the IDE bundle the launcher keeps it for every
 * page, and tells the editor.
 */
async function setRecordingPaused(paused: boolean): Promise<void> {
  recordingPaused = paused;
  scheduleHudRefresh();
  try {
    if (!IDE_BUILD) await updateRecording(recordingStartedAt, { paused });
    await chrome.runtime.sendMessage({ type: IDE_PAUSED_MESSAGE, paused });
  } catch {
    captureError = t('common_workerNoAnswer');
    scheduleHudRefresh();
  }
}

/**
 * A border drawn around the viewport for as long as the recording runs, so
 * it's obvious at a glance that this tab is being captured — the HUD alone
 * is easy to overlook, and easy to mistake for a leftover from a previous
 * session.
 *
 * Its own host rather than part of the HUD: `renderHud` tears its host down
 * and rebuilds it on *every* captured step, which would make a border flicker
 * constantly. `pointer-events: none` throughout so it never intercepts a
 * click the recorder is supposed to be capturing.
 */
function ensureRecordingFrame(): void {
  if (document.getElementById(FRAME_HOST_ID)) return;
  const host = document.createElement('div');
  host.id = FRAME_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  mountSurface(host);
  const root = attachPanelShadow(host, { mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .frame {
      position: fixed; inset: 0; pointer-events: none;
      border: 3px solid rgba(239,68,68,.9);
      box-shadow: inset 0 0 0 1px rgba(239,68,68,.35), inset 0 0 18px rgba(239,68,68,.18);
      animation: breathe 2.6s ease-in-out infinite;
    }
    @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    @media (prefers-reduced-motion: reduce) { .frame { animation: none; } }
  `;
  const frame = document.createElement('div');
  frame.className = 'frame';
  root.append(style, frame);
}

function removeRecordingFrame(): void {
  document.getElementById(FRAME_HOST_ID)?.remove();
}

/** The HUD's top line: how many steps are recorded, and in the IDE bundle the file they are written into. */
function hudTitle(steps: number): string {
  const file = IDE_BUILD ? ideSettings?.file : null;
  return file ? tn('record_hudTitleInto', steps, { file }) : tn('record_hudTitle', steps);
}

function renderHud(state: RecordingState, catalog: TestFunctionEntry[]): void {
  document.getElementById(HUD_HOST_ID)?.remove();
  document.getElementById(PANEL_HOST_ID)?.remove();
  ensureRecordingFrame();

  const host = document.createElement('div');
  host.id = HUD_HOST_ID;
  host.style.cssText = `all:initial;position:fixed;inset:${cornerInset(hudCorner())};z-index:2147483647;`;
  mountSurface(host);
  const root = attachPanelShadow(host, { mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    ${SHARED_STYLE}
    ${LOCATOR_SYNTAX_CSS}
    ${BUTTON_CSS}
    .bar {
      display: flex; flex-direction: column; gap: 8px; background: #111827; color: #f9fafb;
      border-radius: 12px; padding: 10px 12px; box-shadow: 0 8px 30px rgba(0,0,0,.4);
      font-size: 12.5px; min-width: 260px; max-width: 340px;
    }
    @media (prefers-color-scheme: light) {
      .bar { background: #ffffff; color: #111827; box-shadow: 0 8px 30px rgba(0,0,0,.2); border: 1px solid #e5e7eb; }
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; flex-shrink: 0; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    .dot.paused { background: #9ca3af; animation: none; }
    .title { font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; hyphens: auto; }
    .checks { display: flex; gap: 6px; flex-wrap: wrap; }
    .section-title { color: #9ca3af; font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; margin-top: 2px; }
    code.last { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; display: block;
      padding: 5px 7px; border-radius: 6px; background: rgba(148,163,184,.12); border: 1px solid rgba(148,163,184,.22); }
    .match { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
    .match-name { font-family: ui-monospace, monospace; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .match-bar { width: 34px; height: 4px; border-radius: 2px; background: rgba(128,128,128,.25); overflow: hidden; flex-shrink: 0; }
    .match-bar-fill { height: 100%; background: #7c3aed; }
    .match-badge { font-size: 9.5px; padding: 1px 4px; border-radius: 4px; flex-shrink: 0; }
    .match-badge.complete { background: rgba(34,197,94,.2); color: #22c55e; }
    .match-badge.partial { color: #9ca3af; }
    .empty { color: #9ca3af; font-size: 11px; }
    .empty, .warn { overflow-wrap: anywhere; hyphens: auto; }
    .warn { color: #fca5a5; font-size: 11px; line-height: 1.35; }
    @media (prefers-color-scheme: light) {
      .warn { color: #b91c1c; }
      .match-badge.complete { color: #15803d; }
      .match-badge.partial, .empty, .section-title { color: #6b7280; }
    }
  `;
  root.appendChild(style);

  const steps = normalizeSteps(state.events);
  const matches = catalog.length > 0 ? rankFunctionMatches(steps, catalog).slice(0, 3) : [];
  const lastTarget = [...state.events].reverse().find((e) => e.target)?.target ?? null;

  // A landmark, not a dialog: the page stays usable around it.
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', t('record_hudLabel'));
  bar.lang = uiLanguage();

  const topRow = document.createElement('div');
  topRow.className = 'row';
  const dot = document.createElement('div');
  dot.className = 'dot';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = hudTitle(steps.length);
  const stopBtn = makeButton(t('common_stop'), () => void handleStop(), {
    icon: 'stop',
    tone: 'danger',
    small: true,
    className: 'stop',
  });
  dot.classList.toggle('paused', recordingPaused);
  const pauseBtn = makeButton(
    recordingPaused ? t('record_resume') : t('record_pause'),
    () => void setRecordingPaused(!recordingPaused),
    {
      icon: recordingPaused ? 'play' : 'pause',
      small: true,
      className: 'pause',
    },
  );
  pauseBtn.setAttribute('aria-pressed', String(recordingPaused));
  topRow.append(dot, title, pauseBtn, stopBtn, moveHudButton(host));
  bar.appendChild(topRow);

  if (recordingPaused) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = t('record_pausedNote');
    bar.appendChild(note);
  }

  // Checks of what the page shows now; none while paused, when nothing is recorded.
  const checks = document.createElement('div');
  checks.className = 'checks';
  for (const [label, glyph, run] of [
    ['record_checkElement', 'check-circle', runCheckElementFlow],
    ['record_checkAddress', 'globe', runCheckAddressFlow],
  ] as const) {
    const button = makeButton(t(label), () => void run(bugHooks), { icon: glyph, small: true });
    button.disabled = recordingPaused;
    checks.appendChild(button);
  }
  bar.appendChild(checks);

  if (captureError) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.setAttribute('role', 'alert');
    warn.textContent = captureError;
    bar.appendChild(warn);
  }

  if (lastTarget?.alternatives[0]) {
    const locTitle = document.createElement('div');
    locTitle.className = 'section-title';
    locTitle.textContent = t('record_lastLocator');
    const code = document.createElement('code');
    code.className = 'piwi-loc last';
    code.innerHTML = highlightLocator(lastTarget.alternatives[0].locator);
    bar.append(locTitle, code);
  }

  if (catalog.length > 0) {
    const matchTitle = document.createElement('div');
    matchTitle.className = 'section-title';
    matchTitle.textContent = t('record_matchingFunctions');
    bar.appendChild(matchTitle);
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = t('record_noMatch');
      bar.appendChild(empty);
    } else {
      for (const m of matches) bar.appendChild(renderMatchRow(m));
    }
  }

  root.appendChild(bar);
}

function renderMatchRow(m: RankedFunctionMatch): HTMLElement {
  const row = document.createElement('div');
  row.className = 'match';
  const name = document.createElement('div');
  name.className = 'match-name';
  name.textContent = m.entry.name;
  const barWrap = document.createElement('div');
  barWrap.className = 'match-bar';
  const fill = document.createElement('div');
  fill.className = 'match-bar-fill';
  fill.style.width = `${Math.round(m.score * 100)}%`;
  barWrap.appendChild(fill);
  const badge = document.createElement('span');
  badge.className = `match-badge ${m.complete ? 'complete' : 'partial'}`;
  badge.textContent = m.complete
    ? t('record_matchReady')
    : `${formatNumber(m.matchedIndices.length)}/${formatNumber(m.entry.steps.length)}`;
  row.append(name, barWrap, badge);
  return row;
}

/** Save a steps document as `piwi-steps-<date>-<time>.json`, through the page's own download handling. */
function downloadSteps(doc: PiwiSteps): void {
  downloadBlob(
    new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
    `piwi-steps-${fileStamp(doc.recordedAt)}.json`,
  );
}

/** How long after the last keystroke the review panel stores its title. */
const TITLE_WRITE_MS = 300;

interface TitleWriter {
  /** Stores `title` once {@link TITLE_WRITE_MS} pass without another. */
  schedule(title: string): void;
  /** Stores the pending title now; resolves once no write is in flight. */
  flush(): Promise<void>;
  /** Forgets the pending title; resolves once no write is in flight. */
  drop(): Promise<void>;
}

/** The review panel's title, stored on the recording the panel reviews and on no other (see `updateRecording`). */
function titleWriter(startedAt: number | null): TitleWriter {
  let pending: { title: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<unknown> = Promise.resolve();
  const cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const idle = (): Promise<void> => writing.then(() => undefined);
  const flush = (): Promise<void> => {
    cancel();
    if (pending) {
      const { title } = pending;
      pending = null;
      writing = writing.then(() => updateRecording(startedAt, { title })).catch(() => undefined);
    }
    return idle();
  };
  return {
    schedule(title) {
      pending = { title };
      cancel();
      timer = setTimeout(() => void flush(), TITLE_WRITE_MS);
    },
    flush,
    drop() {
      cancel();
      pending = null;
      return idle();
    },
  };
}

async function renderReviewPanel(state: RecordingState): Promise<void> {
  if (recordingMode(state) === 'bug') {
    await renderBugFinishPanel(state, discardRecording);
    return;
  }
  const { events } = state;
  document.getElementById(HUD_HOST_ID)?.remove();
  document.getElementById(PANEL_HOST_ID)?.remove();
  // Recording is over by the time the review panel opens — drop the border
  // before anything else, so it never outlives the capture it signals.
  removeRecordingFrame();

  const steps = normalizeSteps(events);
  const session = buildSession(steps, events[0]?.timestamp ?? Date.now());
  const fallbackTitle = titleFromSteps(steps);
  const [connection, override] = await Promise.all([getConnectionSettings(), getActiveProjectOverride()]);
  const activeProject = resolveActiveProject(connection, override, location.href);
  // Worth waiting for here, unlike in the live HUD: this is the one-shot that
  // feeds "Copy as TypeScript", and generating a spec against a catalog that
  // predates a function added mid-session would silently emit raw locators
  // where a call belonged.
  await requestCatalogRefresh(activeProject?.projectId ?? null);
  const catalog = await getCachedCatalog(activeProject?.projectId ?? null);
  // URL checks: after a step that leads to another page, the spec waits for
  // it, and for the next element as the only match, before acting.
  const withCatalog = renderSpec(session, { catalog, urlChecks: true });

  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    ${SHARED_STYLE}
    ${LOCATOR_SYNTAX_CSS}
    ${BUTTON_CSS}
    ${STEP_CSS}
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: flex-start; justify-content: center; padding-top: 6vh; }
    .panel { background: #111827; color: #f9fafb; border-radius: 12px; padding: 16px; width: min(680px, 92vw); max-height: 84vh;
      overflow: auto; box-shadow: 0 8px 40px rgba(0,0,0,.5); font-size: 13px; line-height: 1.5; }
    @media (prefers-color-scheme: light) { .panel { background: #ffffff; color: #111827; box-shadow: 0 8px 40px rgba(0,0,0,.2); } }
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .header > div { min-width: 0; overflow-wrap: anywhere; hyphens: auto; }
    .panel:focus { outline: none; }
    .title { font-weight: 600; font-size: 14px; }
    .sub { color: #9ca3af; font-size: 12px; }
    .steps { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; max-height: 280px; overflow: auto; margin-bottom: 12px; }
    .step { padding: 6px 10px; font-size: 12.5px; border-bottom: 1px solid rgba(128,128,128,.15); display: flex; gap: 8px; align-items: flex-start; }
    .step-desc { min-width: 0; flex: 1; }
    .step:last-child { border-bottom: none; }
    .step-idx { color: #9ca3af; flex-shrink: 0; min-width: 18px; text-align: end; font-variant-numeric: tabular-nums; font-size: 11px; padding-top: 3px; }
    .step-fn { margin-left: auto; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(124,58,237,.2); color: #a78bfa; flex-shrink: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; font-size: 12px; color: #9ca3af; }
    .field input { font: inherit; font-size: 13px; color: inherit; background: rgba(148,163,184,.12);
      border: 1px solid rgba(148,163,184,.35); border-radius: 6px; padding: 6px 8px; width: 100%; }
    .field input:focus { outline: 2px solid #7c3aed; outline-offset: 0; }
    .panel .field input { color: #f9fafb; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .actions .discard { margin-inline-start: auto; }
    .empty { color: #9ca3af; font-size: 12.5px; padding: 16px; text-align: center; }
    .message { color: #fca5a5; font-size: 12px; margin-top: 8px; overflow-wrap: anywhere; }
    .message:empty { display: none; }
    @media (prefers-color-scheme: light) {
      .sub, .step-idx, .empty, .field { color: #6b7280; }
      .panel .field input { color: #111827; }
      .step-fn { color: #6d28d9; }
      .message { color: #b91c1c; }
    }
  `;
  root.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.lang = uiLanguage();
  panel.setAttribute('aria-label', t('record_reviewLabel'));
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'header';
  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = steps.length === 0 ? t('record_nothingRecorded') : tn('record_stepsRecorded', steps.length);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent =
    withCatalog.matchedSpans.length > 0
      ? tn('record_stepsMatched', withCatalog.matchedSpans.length)
      : catalog.length > 0
        ? t('record_noFunctionMatches')
        : t('record_notConnected');
  titleWrap.append(title, sub);
  // Every close path (the ×, the backdrop, Discard, Escape) goes through one
  // function, which stores the title still pending and detaches the
  // document-level listeners below with the panel.
  const titles = titleWriter(state.startedAt);
  const closeController = new AbortController();
  const closePanel = (): void => {
    void titles.flush();
    closeController.abort();
    host.remove();
  };
  const closeBtn = makeButton(t('common_close'), closePanel, {
    icon: 'close',
    iconOnly: true,
    tone: 'ghost',
    className: 'close',
  });
  header.append(titleWrap, closeBtn);
  panel.appendChild(header);

  // The test's title, which the spec and the steps file take: the first page's own title unless changed, and the
  // first action's words when the field is left empty.
  const titleField = document.createElement('label');
  titleField.className = 'field';
  const titleLabel = document.createElement('span');
  titleLabel.textContent = t('record_testTitle');
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.maxLength = RECORDING_TITLE_MAX;
  titleInput.value = state.title ?? '';
  titleInput.placeholder = fallbackTitle ?? t('record_testTitlePlaceholder');
  titleInput.addEventListener('input', () => titles.schedule(titleInput.value));
  titleField.append(titleLabel, titleInput);
  const specTitle = (): string | undefined => cleanTitle(titleInput.value) ?? fallbackTitle ?? undefined;
  const stepsDocument = (): PiwiSteps => toStepsDocument(session, { title: specTitle() ?? null });
  if (steps.length > 0) panel.appendChild(titleField);

  if (steps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = t('record_noSteps');
    panel.appendChild(empty);
  } else {
    const stepsWrap = document.createElement('div');
    stepsWrap.className = 'steps';
    steps.forEach((step, i) => {
      const row = document.createElement('div');
      row.className = 'step';
      const idx = document.createElement('span');
      idx.className = 'step-idx';
      idx.textContent = formatNumber(i + 1);
      const desc = stepView(step);
      desc.classList.add('step-desc');
      row.append(idx, desc);
      const span = withCatalog.matchedSpans.find((s) => i >= s.startStep && i <= s.endStep);
      if (span) {
        const fnBadge = document.createElement('span');
        fnBadge.className = 'step-fn';
        fnBadge.textContent = span.functionName;
        row.appendChild(fnBadge);
      }
      stepsWrap.appendChild(row);
    });
    panel.appendChild(stepsWrap);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const message = document.createElement('div');
  message.className = 'message';
  message.setAttribute('role', 'alert');

  if (steps.length > 0) {
    const copyPrimary = makeButton(
      catalog.length > 0 ? t('record_copyCodeWithFunctions') : t('record_copyCode'),
      () => {
        void titles.flush();
        void copyToClipboard(renderSpec(session, { catalog, urlChecks: true, title: specTitle() }).code, copyPrimary);
      },
      { icon: 'copy', tone: 'primary' },
    );
    actions.appendChild(copyPrimary);

    if (catalog.length > 0 && withCatalog.matchedSpans.length > 0) {
      const copyRaw = makeButton(
        t('record_copyCodeWithoutFunctions'),
        () => {
          void titles.flush();
          void copyToClipboard(renderSpec(session, { urlChecks: true, title: specTitle() }).code, copyRaw);
        },
        { icon: 'code' },
      );
      actions.appendChild(copyRaw);
    }

    actions.appendChild(
      makeButton(
        t('record_downloadSteps'),
        () => {
          void titles.flush();
          downloadSteps(stepsDocument());
        },
        {
          icon: 'download',
          title: t('record_downloadStepsTitle'),
        },
      ),
    );

    if (await getEditorPairing().catch(() => null)) {
      const sendBtn = makeButton(
        t('record_sendToEditor'),
        () => {
          void titles.flush();
          void sendToEditor({ kind: 'steps', steps: stepsDocument() }).then((result) =>
            showSendResult(sendBtn, result),
          );
        },
        { icon: 'send' },
      );
      actions.appendChild(sendBtn);
    }

    // Played again before export: the one check that every recorded locator still finds its element.
    const replayBtn = makeButton(
      t('record_replay'),
      () => {
        replayBtn.disabled = true;
        void titles
          .flush()
          .then(() => startReplayHere(stepsDocument()))
          .then((response) => {
            if (response.ok) return closePanel();
            replayBtn.disabled = false;
            message.textContent = response.error ?? t('common_replayStartFailed');
          });
      },
      { icon: 'play', title: t('record_replayHint') },
    );
    actions.appendChild(replayBtn);
  }

  actions.appendChild(
    makeButton(t('common_discard'), () => void titles.drop().then(discardRecording).then(closePanel, closePanel), {
      icon: 'trash',
      tone: 'remove',
      className: 'discard',
    }),
  );
  panel.appendChild(actions);
  panel.appendChild(message);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closePanel();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') closePanel();
    },
    { capture: true, signal: closeController.signal },
  );
  window.addEventListener('pagehide', () => void titles.flush(), { signal: closeController.signal });

  backdrop.appendChild(panel);
  root.appendChild(backdrop);
  panel.focus();
}

/** The longest Stop waits for the worker's answer before it opens the review. */
const STOP_ANSWER_MS = 2000;

/**
 * Tells the worker the recording stopped. Its answer comes once it has stored
 * what its debugging session still held, which the review then shows.
 */
function tellWorkerStopped(): Promise<unknown> {
  try {
    const answer = Promise.resolve(chrome.runtime.sendMessage({ type: 'piwi-recording-stopped' })).catch(
      () => undefined,
    );
    return Promise.race([answer, new Promise((resolve) => setTimeout(resolve, STOP_ANSWER_MS))]);
  } catch {
    // Extension context can be gone (e.g. reloaded mid-recording) — the storage write already stuck.
    return Promise.resolve();
  }
}

async function handleStop(): Promise<void> {
  const state = await stopRecording();
  stopCapture();
  await tellWorkerStopped();
  // The IDE bundle opens no review: the steps are in the editor.
  if (!IDE_BUILD) await renderReviewPanel(state);
}

/**
 * Finishes a bug recording: the last evidence entries, a screenshot of the
 * page as it is, an outline when nothing was marked, and the page's context,
 * then the same stop as any recording.
 */
async function handleBugFinish(): Promise<void> {
  const g = recorderGlobals();
  if (g.__piwiBugFinishing) return;
  g.__piwiBugFinishing = true;
  try {
    await g.__piwiBugRelayStop?.();
    const state = await getRecordingState();
    if (!state.active) return;
    await takeBugScreenshot('finish', normalizeSteps(state.events).length - 1);
    // A write session storage refuses leaves the report without its context, never unfinished.
    await getBugEvidence()
      .then(async (evidence) =>
        setBugEvidenceFields({
          context: await currentBugContext(),
          ...(evidence.outline ? {} : { outline: outlineAround(null) }),
        }),
      )
      .catch(() => undefined);
    await handleStop();
  } finally {
    g.__piwiBugFinishing = false;
  }
}

function buildEvent(
  kind: RawCaptureEvent['kind'],
  el: Element | null,
  extra: Partial<RawCaptureEvent> = {},
): RawCaptureEvent {
  return {
    kind,
    value: null,
    checked: null,
    inputType: null,
    isPasswordField: false,
    pageUrl: location.href,
    timestamp: Date.now(),
    ...extra,
    // Resolved last, and only derived when the caller has not supplied one —
    // deriving first and letting `extra` overwrite it would still pay for the
    // probe the caller passed a cached target precisely to avoid.
    target: extra.target !== undefined ? extra.target : el ? deriveRecordedTarget(el) : null,
  };
}

/** What the bug panel and a test recording's checks need from the recorder to add an assertion to the recording. */
const bugHooks: BugRecorderHooks = {
  targetFor: deriveRecordedTarget,
  async addAssert(target: RecordedTarget | null, assertion: StepAssertion): Promise<number | null> {
    try {
      const state = await appendRecordingEvent(buildEvent('assert', null, { target, assertion: { ...assertion } }));
      if (!state.active) return null;
      return normalizeSteps(state.events).length - 1;
    } catch {
      captureError = t('record_stepNotSaved');
      return null;
    } finally {
      scheduleHudRefresh();
    }
  },
  setPaused(paused: boolean) {
    recorderGlobals().__piwiRecordPaused = paused;
  },
};

async function refreshHud(): Promise<void> {
  const [state, connection, override] = await Promise.all([
    getRecordingState(),
    getConnectionSettings(),
    getActiveProjectOverride(),
  ]);
  if (!state.active) return;
  if (recordingMode(state) === 'bug') {
    const evidence = await getBugEvidence();
    ensureRecordingFrame();
    renderBugHud(state, evidence, captureError, {
      mark: () => void runMarkFlow(bugHooks),
      missing: () => void runMissingFlow(bugHooks),
      wrongPage: () => void runWrongPageFlow(bugHooks),
      finish: () => void handleBugFinish(),
      screenshot: () =>
        void getRecordingState().then(async (latest) => {
          await takeBugScreenshot('manual', normalizeSteps(latest.events).length - 1);
          scheduleHudRefresh();
        }),
    });
    return;
  }
  const activeProject = resolveActiveProject(connection, override, location.href);
  const catalog = await getCachedCatalog(activeProject?.projectId ?? null);
  renderHud(state, catalog);
}

/**
 * Records one captured event and refreshes the HUD, at most one redraw per
 * `HUD_REFRESH_MS` with the last one always landing.
 *
 * The HUD re-runs `rankFunctionMatches` over the whole catalog and rebuilds its
 * host from scratch, which is fine per click and wasteful per keystroke. It is
 * pure presentation, so throttling it cannot reorder or drop a step — the
 * `appendRecordingEvent` call it follows is what actually records, and that one
 * is never skipped.
 */
const HUD_REFRESH_MS = 120;
let hudRefreshAt = 0;
let hudRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleHudRefresh(): void {
  if (hudRefreshTimer != null) return;
  const wait = Math.max(0, hudRefreshAt + HUD_REFRESH_MS - Date.now());
  hudRefreshTimer = setTimeout(() => {
    hudRefreshTimer = null;
    hudRefreshAt = Date.now();
    void refreshHud();
  }, wait);
}

/**
 * The last capture write that failed, surfaced in the HUD.
 *
 * Session storage can fill up mid-recording; without this, a rejected write
 * would look exactly like a recording still going fine, and the steps after it
 * would be absent from the export.
 */
let captureError: string | null = null;

/** When the person's last action was recorded, unless a page was reached since (`lastActionOf`); else null. */
let lastActionAt: number | null = null;

function captureEvent(event: RawCaptureEvent): void {
  if (isActionKind(event.kind)) lastActionAt = event.timestamp;
  void appendRecordingEvent(event)
    .then(() => {
      captureError = null;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : '';
      captureError = /quota|exceeded/i.test(message) ? t('record_storageFull') : t('record_stepNotSaved');
    })
    .then(() => scheduleHudRefresh());
}

/** One TTL-guarded catalog re-fetch for whichever project this page maps to — called once per page load, never from `refreshHud`. */
async function refreshCatalogForThisPage(): Promise<void> {
  const [connection, override] = await Promise.all([getConnectionSettings(), getActiveProjectOverride()]);
  const activeProject = resolveActiveProject(connection, override, location.href);
  await requestCatalogRefresh(activeProject?.projectId ?? null);
}

/**
 * In the IDE bundle, reads the launcher's settings, which this page's capture
 * and HUD follow: the file the steps are written into and the project's test id
 * attribute. Never rejects: without them, Playwright's default attribute
 * applies.
 */
async function loadRecorderSettings(): Promise<void> {
  if (!IDE_BUILD) return;
  ideSettings = await getIdeSettings().catch(() => null);
  testIdAttribute = ideSettings?.testIdAttribute ?? null;
}

interface RecorderGlobals {
  /** Aborting this detaches every capture listener at once — see `stopCapture`. */
  __piwiRecordCapture?: AbortController;
  /** Set while a bug report's pick or dialog is open: nothing is captured meanwhile. */
  __piwiRecordPaused?: boolean;
  /** Stores the evidence entries received but not stored yet, and stops the relay. */
  __piwiBugRelayStop?: () => Promise<void>;
  /** Whether this document's back/forward cache listener is already registered. */
  __piwiRecordPageShow?: boolean;
  /** Guards Finish against a second click while it runs. */
  __piwiBugFinishing?: boolean;
  /** Serializes concurrent injections of this script into one document. */
  __piwiRecordPanelRun?: Promise<void>;
  /** Whether this document's `chrome.runtime` stop listener is already registered. */
  __piwiRecordStopListener?: boolean;
}

function recorderGlobals(): RecorderGlobals {
  return globalThis as RecorderGlobals;
}

/**
 * Ends capture on this page: detaches the listeners, ends a bug report's pick
 * and closes its dialog, drops the HUD, and drops the border that says the tab
 * is being recorded.
 *
 * Idempotent, and safe when nothing was ever attached — it runs both from the
 * HUD's own Stop button and from a stop initiated elsewhere (the popup, or
 * another tab), which reaches this document as a `piwi-recording-stopped`
 * message from the service worker.
 */
function stopCapture(): void {
  const g = recorderGlobals();
  g.__piwiRecordCapture?.abort();
  g.__piwiRecordCapture = undefined;
  cancelBugPick();
  stopViews();
  g.__piwiRecordPaused = false;
  document.getElementById(HUD_HOST_ID)?.remove();
  document.getElementById(BUG_DIALOG_HOST_ID)?.remove();
  removeRecordingFrame();
}

/**
 * A bug recording's screenshots of the page as each step begins (see
 * `background/step-views.ts`). Once the page has been still for
 * `VIEW_SETTLE_MS` after a step, the recorder asks for the view the next step
 * begins from; an action that comes before one is taken asks for its own as it
 * starts. Each action keeps the view's id and its element's box. A scroll or a
 * resize moves the page under a view no action began from yet: it is taken
 * again under its id, once the page settles or as the next action starts.
 */
const VIEW_SETTLE_MS = 600;

interface PendingView {
  id: string;
  /** An action began from it already. */
  used: boolean;
  /** The page scrolled or resized since it was asked for. */
  moved: boolean;
}

let viewsOn = false;
let currentView: PendingView | null = null;
let viewTimer: ReturnType<typeof setTimeout> | null = null;
let viewCount = 0;
/** The field typed in last and the view its typing began from: the rest of the typing keeps it. */
let typing: { field: Element; view: StepView | undefined } | null = null;

function requestView(hide: boolean): PendingView {
  const id =
    currentView && !currentView.used ? currentView.id : `${Date.now().toString(36)}-${(viewCount++).toString(36)}`;
  const view = { id, used: false, moved: false };
  currentView = view;
  void captureStepView(view.id, viewportNow(), hide);
  return view;
}

function scheduleView(): void {
  if (!viewsOn) return;
  if (viewTimer != null) clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    viewTimer = null;
    // A pick or a dialog of the bug panel is open: the page it shows is not the next step's.
    if (capturePaused()) return scheduleView();
    requestView(true);
  }, VIEW_SETTLE_MS);
}

function pageMoved(): void {
  if (currentView && !currentView.used) currentView.moved = true;
  scheduleView();
}

/** On a page the recording reaches, the first view is taken at once: the page as its first step begins. */
function startViews(signal: AbortSignal): void {
  viewsOn = true;
  requestView(true);
  // Scrolls of the page and of any element in it; the recorder's own surfaces do not compose theirs.
  document.addEventListener('scroll', pageMoved, { capture: true, passive: true, signal });
  window.addEventListener('resize', pageMoved, { passive: true, signal });
}

function stopViews(): void {
  viewsOn = false;
  if (viewTimer != null) clearTimeout(viewTimer);
  viewTimer = null;
}

function boxOf(el: Element): StepView['box'] {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/** The view an action begins from, with its element's box: the settled one if no action used it, else one taken now. */
function viewForAction(el: Element | null): StepView | undefined {
  typing = null;
  if (!viewsOn) return undefined;
  const view = currentView && !currentView.used && !currentView.moved ? currentView : requestView(false);
  view.used = true;
  scheduleView();
  return { id: view.id, box: el ? boxOf(el) : null };
}

/** The same view, with no element marked: a hover step's element is not the one clicked. */
function withoutBox(view: StepView | undefined): StepView | undefined {
  return view ? { id: view.id, box: null } : undefined;
}

/** Typing in the same field goes on from the view its first keystroke took. */
function viewForTyping(field: Element): StepView | undefined {
  if (typing?.field === field) {
    scheduleView();
    return typing.view;
  }
  const view = viewForAction(field);
  typing = { field, view };
  return view;
}

function attachListeners(): void {
  const g = recorderGlobals();
  g.__piwiRecordCapture?.abort();
  const controller = new AbortController();
  g.__piwiRecordCapture = controller;
  // Capture phase throughout, so a page that stops propagation on its own
  // handlers can't hide an interaction from the recorder; `signal` is what
  // makes the whole set removable in one go from `stopCapture`.
  const opts = { capture: true, signal: controller.signal };
  const tracker = new HoverTracker();
  hoverTracker = tracker;
  const mutations = new MutationObserver((records) => tracker.mutations(records));
  mutations.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'hidden'],
    attributeOldValue: true,
  });
  // A field shown in clear (`type` from `password` to `text`) stays a secret.
  const fieldChanges = new MutationObserver(rememberChangedFields);
  fieldChanges.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'autocomplete'],
    attributeOldValue: true,
  });
  controller.signal.addEventListener('abort', () => {
    mutations.disconnect();
    fieldChanges.disconnect();
    if (hoverTracker === tracker) hoverTracker = null;
  });

  // `change` does not leave a shadow root: each open one a press or the focus
  // goes into gets a listener of its own.
  const watchedRoots = new WeakSet<ShadowRoot>();
  const watchShadowRoots = (e: Event): void => {
    for (const node of e.composedPath()) {
      if (!(node instanceof ShadowRoot) || watchedRoots.has(node)) continue;
      watchedRoots.add(node);
      node.addEventListener('change', onChange, opts);
    }
  };

  document.addEventListener(
    'focusin',
    (e) => {
      if (!e.isTrusted || withinOwnUi(e)) return;
      watchShadowRoots(e);
      // A field focused as a secret stays one: its value is never recorded, whatever its type becomes.
      const el = deepTarget(e);
      if (el) isSensitiveField(el);
    },
    opts,
  );

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.isTrusted) enterInForm = null;
      if (!e.isTrusted || capturePaused() || withinOwnUi(e)) return;
      watchShadowRoots(e);
      const raw = deepTarget(e);
      if (!raw) {
        lastPress = null;
        return;
      }
      const el = nearestActionable(raw);
      const hovers = hoverTargets(el);
      hoverTracker?.press();
      lastPress = { el, target: deriveRecordedTarget(el), hovers, at: e.timeStamp };
    },
    opts,
  );

  // Back or Forward within a page that routes itself: the address changes, and no page loads.
  window.addEventListener(
    'popstate',
    (e) => {
      if (!e.isTrusted || capturePaused()) return;
      const navigation = ownNavigation('back_forward', Date.now(), lastActionAt);
      if (navigation) captureEvent(buildEvent('navigate', null, { value: location.href, navigation }));
    },
    opts,
  );

  document.addEventListener(
    'pointerover',
    (e) => {
      if (!e.isTrusted || withinOwnUi(e)) return;
      const raw = e.composedPath()[0];
      if (raw instanceof Element) hoverTracker?.pointerOver(raw);
    },
    opts,
  );

  document.addEventListener(
    'click',
    (e) => {
      // A click the page's own script sends (`el.click()` when Enter picks an
      // option) follows from an action already recorded.
      if (!e.isTrusted || capturePaused() || withinOwnUi(e)) return;
      const raw = deepTarget(e);
      if (!raw || submitFromEnter(e, raw)) return;
      const { el, target, hovers } = clickTarget(raw, e.timeStamp, e.detail > 0);
      const kind = classifyInputKind(el.tagName, (el as HTMLInputElement).type ?? null);
      // A checkbox or a radio is recorded by its `change`, which takes the view.
      const view = hovers.length > 0 || (kind !== 'checkbox' && kind !== 'radio') ? viewForAction(el) : undefined;
      for (const hover of hovers) captureEvent(buildEvent('hover', null, { target: hover, view: withoutBox(view) }));
      if (kind === 'checkbox' || kind === 'radio') return; // the resulting `change` event records this one
      captureEvent(buildEvent('click', el, { target, view }));
    },
    opts,
  );

  document.addEventListener(
    'input',
    (e) => {
      // Only what the person does: a component that mirrors its state into a
      // hidden input (a switch, a custom select) sends its own events there.
      if (!e.isTrusted || capturePaused() || withinOwnUi(e)) return;
      const el = deepTarget(e);
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
      // A checkbox or a radio fires `input` too; its `change` records it as a check.
      if (el instanceof HTMLInputElement && UNFILLABLE_INPUT_TYPES.has(el.type)) return;
      const passwordField = isSensitiveField(el);
      // The raw value never enters the event at all for a field that holds a
      // secret — redacting later in normalizeSteps would still mean the
      // plaintext sat in chrome.storage.session in the meantime.
      captureEvent(
        buildEvent('input', el, {
          // Cached per field: the probe behind a target is a document-wide walk,
          // and one per keystroke would make typing lag on a large page.
          target: fieldTarget(el),
          value: passwordField ? null : el.value,
          isPasswordField: passwordField,
          view: viewForTyping(el),
        }),
      );
    },
    opts,
  );

  function onChange(e: Event): void {
    // A change the document hears is recorded there, one in a shadow root by that root's listener.
    if (e.currentTarget !== document && e.composedPath().includes(document)) return;
    if (!e.isTrusted || capturePaused() || withinOwnUi(e)) return;
    const el = deepTarget(e);
    if (!el) return;
    const typeAttr = el instanceof HTMLInputElement ? el.type : null;
    const kind = classifyInputKind(el.tagName, typeAttr);
    if (kind === 'checkbox' || kind === 'radio') {
      const checked = (el as HTMLInputElement).checked;
      captureEvent(buildEvent('change', el, { inputType: kind, checked, view: viewForAction(el) }));
    } else if (kind === 'select') {
      const value = (el as HTMLSelectElement).value;
      captureEvent(buildEvent('change', el, { inputType: 'select', value, view: viewForAction(el) }));
    } else if (el instanceof HTMLInputElement && el.type === 'file') {
      // The names of the chosen files, one per line: never their content, which stays on this computer.
      const names = [...(el.files ?? [])].map((file) => file.name.replace(/[\r\n]+/g, ' '));
      captureEvent(buildEvent('files', el, { value: names.join('\n'), view: viewForAction(el) }));
    }
  }
  document.addEventListener('change', onChange, opts);

  document.addEventListener(
    'dblclick',
    (e) => {
      if (!e.isTrusted || capturePaused() || withinOwnUi(e)) return;
      const raw = deepTarget(e);
      if (!raw) return;
      const el = nearestActionable(raw);
      captureEvent(buildEvent('dblclick', el, { view: viewForAction(el) }));
    },
    opts,
  );

  // An HTML drag and drop: the element dragged, and the one it was dropped on.
  let dragged: Element | null = null;
  document.addEventListener(
    'dragstart',
    (e) => {
      dragged = e.isTrusted && !capturePaused() && !withinOwnUi(e) ? deepTarget(e) : null;
    },
    opts,
  );
  document.addEventListener(
    'drop',
    (e) => {
      const source = dragged;
      dragged = null;
      const raw = deepTarget(e);
      if (!source || !raw || !e.isTrusted || capturePaused() || withinOwnUi(e)) return;
      const dropTarget = deriveRecordedTarget(nearestActionable(raw));
      captureEvent(buildEvent('drop', source, { dropTarget, view: viewForAction(source) }));
    },
    opts,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.isTrusted) enterInForm = null;
      if (!e.isTrusted || e.isComposing || capturePaused() || withinOwnUi(e)) return;
      const focused = deepTarget(e);
      const key = recordedKey(e, focused, !!focused && focusInClosedShadowRoot(focused));
      if (!key) return;
      // Escape and a page's shortcuts go to whatever has focus, as the replay
      // sends them: their target is often the page itself, which no locator names.
      const shortcut = key.includes('+') ? !inTextField(focused) : [...key].length === 1;
      const onPage = !focused || focused === document.body || focused === document.documentElement;
      const el = key === 'Escape' || shortcut || onPage ? null : focused;
      if (key === 'Enter' && focused instanceof HTMLInputElement && focused.form) {
        enterInForm = { form: focused.form, at: performance.now() };
      }
      captureEvent(buildEvent('keydown', el, { value: key, view: viewForAction(el) }));
    },
    opts,
  );
}

/**
 * Listens for a stop that came from somewhere other than this page's own HUD —
 * the popup's Stop button, or the HUD in a different tab of the same recording
 * — and for the popup's Finish of a bug report and its screenshot.
 * The service worker fans the stop out with `chrome.tabs.sendMessage`, which is
 * the only thing that reaches a content script: `chrome.runtime.sendMessage`
 * goes to extension pages and the worker, never here, so a stop from the popup
 * would otherwise leave this page's HUD and border standing indefinitely.
 *
 * Registered once per document — repeated starts on the same page must not
 * stack handlers.
 */
function installStopListener(): void {
  const g = recorderGlobals();
  if (g.__piwiRecordStopListener) return;
  g.__piwiRecordStopListener = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'piwi-recording-stopped') stopCapture();
    if (message?.type === IDE_PAUSED_MESSAGE && typeof message.paused === 'boolean') {
      // Pause or Resume from another tab of the recording, or from the editor.
      recordingPaused = message.paused;
      scheduleHudRefresh();
    }
    if (message?.type === 'piwi-bug-debugger-lost') {
      // The debugging session ended: the page's own script, registered all along, relays from then on; what it
      // noted before, the session collected.
      void Promise.all([getRecordingState(), getBugEvidence().catch(() => null)]).then(([state, evidence]) => {
        if (state.active && state.bugToken) startPageRelay(state.bugToken, evidence?.debugging?.endedAt ?? Date.now());
        scheduleHudRefresh();
      });
    }
    if (message?.type === 'piwi-bug-finish' && recorderGlobals().__piwiRecordCapture) {
      // The popup's Finish: answered once the page knows it records a bug, then finished as the HUD's Finish is.
      void getRecordingState().then(
        (state) => {
          const bug = state.active && recordingMode(state) === 'bug';
          sendResponse({ ok: bug });
          if (bug) void handleBugFinish();
        },
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    if (message?.type === 'piwi-bug-take-screenshot' && recorderGlobals().__piwiRecordCapture) {
      // Answered at once: the popup that asked closes as soon as it hears back.
      sendResponse({ ok: true });
      void getRecordingState().then(async (state) => {
        if (!state.active || recordingMode(state) !== 'bug') return;
        await takeBugScreenshot('manual', normalizeSteps(state.events).length - 1);
        scheduleHudRefresh();
      });
    }
    return undefined;
  });
}

/**
 * The recorder's entry point — injected once for the very first page of a
 * recording (via `chrome.scripting.executeScript` from the popup) and once
 * per navigation after that (via a dynamic content-script registration
 * scoped to the granted origin, see `background/index.ts`). Renders the
 * always-on HUD while recording, or the review/export panel once stopped but
 * not yet discarded — the same module handles both so a stray injection on
 * an already-stopped recording still shows something useful instead of
 * nothing.
 */
async function runRecordPanel(restored = false): Promise<void> {
  const g = recorderGlobals();
  installPageShowListener();
  // Each run waits for the one before it: this script is injected both by the
  // dynamic registration (on every navigation) and one-off from the popup, and
  // the two can land together. Chained, the second sees the capture the first
  // attached, and a run after a stop still renders the review panel. A failed
  // run never blocks the next: the usual cause is the worker not having
  // widened session-storage access yet, which is transient.
  g.__piwiRecordPanelRun = (g.__piwiRecordPanelRun ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => initRecordPanel(restored))
    .catch((err: unknown) => {
      console.warn('[Piwi Picker] recorder failed to start on this page:', err);
    });
  await g.__piwiRecordPanelRun;
}

/**
 * A page the browser restores from its back/forward cache runs no script
 * again, and heard no message while it was cached: the recorder runs as on a
 * page the recording reaches, or lets go of the page when the recording ended
 * meanwhile. Registered once per document.
 */
function installPageShowListener(): void {
  const g = recorderGlobals();
  if (g.__piwiRecordPageShow) return;
  g.__piwiRecordPageShow = true;
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) void runRecordPanel(true);
  });
}

/**
 * Whether this tab's console and requests reach the report through the
 * background worker's debugging session. The page's own relay stays quiet
 * then, so no entry is counted twice.
 */
async function evidenceThroughDebugger(): Promise<boolean> {
  try {
    const answer = (await chrome.runtime.sendMessage({ type: 'piwi-bug-evidence-source' })) as
      | { debugger?: boolean }
      | undefined;
    return answer?.debugger === true;
  } catch {
    return false;
  }
}

/**
 * Listens to the main-world evidence script for this recording, once per
 * capture, and stores what it relays; with `since`, what it noted from then
 * on only.
 */
function startPageRelay(token: string, since?: number): void {
  const g = recorderGlobals();
  const capture = g.__piwiRecordCapture;
  if (!capture || g.__piwiBugRelayStop) return;
  const stop = relayEvidence(
    token,
    async (entries) => {
      await appendBugEntries(entries);
      void showRelayedEvidence();
    },
    { since, signal: capture.signal, leave: (entries) => storeAsPageLeaves(token, entries) },
  );
  g.__piwiBugRelayStop = stop;
  capture.signal.addEventListener('abort', () => {
    if (g.__piwiBugRelayStop === stop) g.__piwiBugRelayStop = undefined;
  });
}

/** What the page relayed, on the HUD: its evidence line updated in place, or the HUD drawn when there is none. */
async function showRelayedEvidence(): Promise<void> {
  const evidence = await getBugEvidence().catch(() => null);
  if (!evidence || !updateBugHudEvidence(evidence)) scheduleHudRefresh();
}

/** How long the window keeps its size before a resize counts, so a drag records its end only. */
const VIEWPORT_SETTLE_MS = 400;

interface ViewportSize {
  width: number;
  height: number;
  /** The browser's zoom factor, when it is not 100%. */
  zoom?: number;
}

function viewportNow(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** The page's viewport size and the tab's zoom, which only the background worker can read. */
async function viewportWithZoom(): Promise<ViewportSize> {
  const size = viewportNow();
  try {
    const answer = (await chrome.runtime.sendMessage({ type: 'piwi-tab-zoom' })) as { zoom?: unknown } | undefined;
    const zoom = answer?.zoom;
    return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 && zoom !== 1 ? { ...size, zoom } : size;
  } catch {
    return size;
  }
}

function sameSize(a: ViewportSize | null, b: ViewportSize): boolean {
  return !!a && a.width === b.width && a.height === b.height && (a.zoom ?? 1) === (b.zoom ?? 1);
}

/** The last viewport size the recording holds. */
function lastRecordedViewport(events: RawCaptureEvent[]): ViewportSize | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const viewport = events[i]!.viewport;
    if (events[i]!.kind === 'viewport' && viewport) return viewport;
  }
  return null;
}

/**
 * A bug report keeps the viewport size its steps were played at: the page's
 * size when the recording reaches it, if it differs from the last one kept.
 * Answers the size kept last.
 */
async function recordPageViewport(state: RecordingState): Promise<ViewportSize> {
  const last = lastRecordedViewport(state.events);
  const now = await viewportWithZoom();
  if (sameSize(last, now)) return last!;
  await appendRecordingEvent(buildEvent('viewport', null, { viewport: now }));
  return now;
}

/** Then each size the window settles at after a resize, until `signal` ends capture. */
function watchViewport(kept: ViewportSize, signal: AbortSignal): void {
  let last = kept;
  let timer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener(
    'resize',
    () => {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void viewportWithZoom().then((size) => {
          if (sameSize(last, size)) return;
          last = size;
          captureEvent(buildEvent('viewport', null, { viewport: size }));
        });
      }, VIEWPORT_SETTLE_MS);
    },
    { signal },
  );
  signal.addEventListener('abort', () => {
    if (timer != null) clearTimeout(timer);
  });
}

/** `restored`: the page came back from the back/forward cache, and attaches as a page the recording reaches. */
async function initRecordPanel(restored: boolean): Promise<void> {
  // Before any session-storage read — see `session-access.ts`. The catalog
  // override and the recorder's settings load alongside, so the HUD paints no
  // later for them.
  const [state] = await Promise.all([
    ensureSessionAccess().then(getRecordingState),
    initI18n(),
    loadRecorderSettings(),
    loadHudCorner(),
  ]);
  recordingPaused = state.paused === true;
  recordingStartedAt = state.startedAt;

  if (!state.active) {
    // The recording is over, however it ended. Tear the capture surfaces down
    // first — a border that outlives the capture it signals is worse than no
    // border at all — then show whatever is left to review, unless the page
    // only came back from the cache: the review is the stopping tab's. The
    // IDE bundle has no review: the steps are in the editor.
    stopCapture();
    if (state.events.length > 0 && !restored && !IDE_BUILD) await renderReviewPanel(state);
    return;
  }

  if (recorderGlobals().__piwiRecordCapture && !restored) {
    // Already capturing in this document; a second injection only refreshes.
    await refreshHud();
    return;
  }

  // A recording of actions takes its first page's own title, which the review panel offers as the test's.
  if (!IDE_BUILD && recordingMode(state) === 'actions' && state.title === undefined) {
    await updateRecording(state.startedAt, { title: cleanTitle(document.title) });
  }
  // The size comes before the page, so the first one is the size of the first step.
  const viewport = recordingMode(state) === 'bug' ? await recordPageViewport(state) : null;
  // Seed this page's own URL so a mid-recording navigation's `RecordedStep`s
  // carry the right `pageUrl`; only the very first one across the whole
  // recording survives into a `page.goto()`, and a page the person reached
  // through the history or by reloading — see `normalizeSteps`.
  lastActionAt = lastActionOf(state.events);
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const navigation = restored
    ? ownNavigation('back_forward', Date.now(), lastActionAt)
    : ownNavigation(entry?.type, performance.timeOrigin, lastActionAt);
  await appendRecordingEvent(
    buildEvent('navigate', null, { value: location.href, ...(navigation ? { navigation } : {}) }),
  );
  attachListeners();
  installStopListener();
  const capture = recorderGlobals().__piwiRecordCapture;
  if (viewport && capture) {
    watchViewport(viewport, capture.signal);
    startViews(capture.signal);
  }
  if (recordingMode(state) === 'bug' && state.bugToken && capture && !(await evidenceThroughDebugger())) {
    startPageRelay(state.bugToken);
  }
  // Once per page, not per step — `refreshHud` runs on every captured
  // interaction and must stay local-only. TTL-guarded, so a recording that
  // crosses many pages still only re-fetches occasionally. Never in the IDE
  // bundle, which has no catalog.
  if (!IDE_BUILD) void refreshCatalogForThisPage().then(() => void refreshHud());
  await refreshHud();
}

/**
 * Whether this document records. The extension injects the recorder only
 * where it records. The IDE bundle, which the launcher loads into every
 * document, records the top-level document of an http or https page its host
 * is installed in, and nothing in a frame, on another page (a new tab's
 * `about:blank`, the browser's error page) or without the host.
 */
function recordsHere(): boolean {
  return !IDE_BUILD || (window.top === window && webOrigin(location.href) !== null && ideHostInstalled());
}

if (recordsHere()) void runRecordPanel();

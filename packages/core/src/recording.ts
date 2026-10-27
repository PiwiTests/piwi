/**
 * Cross-page action recording — the wire shapes and pure normalization for
 * turning a stream of captured DOM interactions into a `RecordedSession`
 * that `codegen.ts` (raw) and `function-match.ts` (catalog-aware) both
 * consume.
 *
 * The single source of truth for the extension's recorder (which builds
 * `RawCaptureEvent`s from real DOM events, one page/content-script instance
 * at a time) and, later, any server-side consumer of a recorded session.
 * Everything here is plain data plus pure functions — no DOM, no `node:*` —
 * so it stays inlineable everywhere `@piwitests/core` already is.
 */

/** The Playwright action a recorded step maps to. */
export type StepAction =
  | 'goto'
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'fill'
  | 'check'
  | 'uncheck'
  | 'selectOption'
  | 'press'
  | 'setInputFiles'
  | 'dragTo'
  | 'assertVisible'
  | 'assert'
  | 'manual';

/** The web-first assertions an `assert` step can state. */
export type AssertionMatcher =
  | 'toHaveText'
  | 'toHaveValue'
  | 'toHaveAccessibleName'
  | 'toBeVisible'
  | 'toBeHidden'
  | 'toBeEnabled'
  | 'toBeDisabled'
  | 'toHaveURL'
  | 'toContainText'
  | 'toHaveCount'
  | 'toBeChecked';

export const ASSERTION_MATCHERS: readonly AssertionMatcher[] = [
  'toHaveText',
  'toHaveValue',
  'toHaveAccessibleName',
  'toBeVisible',
  'toBeHidden',
  'toBeEnabled',
  'toBeDisabled',
  'toHaveURL',
  'toContainText',
  'toHaveCount',
  'toBeChecked',
];

/** Matchers that compare with an expected value; the others check a state. */
export const VALUE_MATCHERS: ReadonlySet<AssertionMatcher> = new Set([
  'toHaveText',
  'toHaveValue',
  'toHaveAccessibleName',
  'toHaveURL',
  'toContainText',
  'toHaveCount',
]);

/**
 * What an `assert` step expects. `toHaveURL` checks the page and needs no
 * target; `toHaveCount` counts the elements its target's locator finds, and
 * its expected value is a whole number written as text (`"3"`).
 */
export interface StepAssertion {
  matcher: AssertionMatcher;
  /** The value the page should show: set for `VALUE_MATCHERS`, null for a state matcher. */
  expected: string | null;
  /** What the page showed when the step was recorded, when that is worth keeping (a bug report's wrong value). */
  actual: string | null;
  negated: boolean;
  /** Free text from the person who recorded it. */
  note: string | null;
}

/** One ranked locator alternative, trimmed to what codegen/matching need (mirrors `RankedLocator` minus scoring metadata not used here). */
export interface RecordedLocatorAlternative {
  locator: string;
  method: string;
  score: number;
}

/** The element a step acted on — enough to re-derive/re-rank a locator and to match it against a catalog's DOM pattern. */
export interface RecordedTarget {
  tagName: string;
  role: string | null;
  accessibleName: string | null;
  testId: string | null;
  /** Normalized, whitespace-collapsed visible text, truncated to 120 chars. */
  text: string | null;
  /** Ranked locator alternatives for this element, best first — computed once at capture time. */
  alternatives: RecordedLocatorAlternative[];
  /**
   * An opaque per-document identity for the element itself, assigned by the
   * recorder at capture time. Only ever compared for equality (see
   * `sameTarget`) and never emitted into generated code.
   *
   * Exists because nothing else here identifies an element reliably: two
   * unlabelled `<input>`s on one form share tag, role, accessible name *and*
   * text, and neither gets any locator alternative at all (a bare role anchor
   * needs the role to be document-unique). Without it, typing into the second
   * field would read as a continuation of the first and overwrite its value.
   * Optional, so a recording without it still deserializes.
   */
  elementKey?: string | null;
}

/**
 * A step nothing can play: a person does it by hand from its description. A
 * steps document made from a test run holds one for each call Replay and the
 * spec cannot perform (a raw mouse move, a regex expectation, a value the run
 * kept only in part).
 */
export interface StepManual {
  /** What to do, in words. */
  description: string;
  /** Where the step is in the test's source, `file:line`, when known. */
  location: string | null;
  /** The Playwright call or step title it stands for, when known. */
  call: string | null;
  /**
   * What to do without its words, for each reader to write in its own
   * language; `description` says the same in English. Absent from a step a
   * person wrote.
   */
  instruction?: ManualInstruction | null;
}

/** What a check found in the run, as its error says: the values it expected and received, when it says. */
export interface ManualCheckValues {
  expected: string | null;
  received: string | null;
}

/**
 * A manual step a report made from a test run holds, by kind, with the
 * values its sentence names: the element as the locator the test found it
 * by, the Playwright call or step title (`call`), a check's matcher (`not.`
 * first when negated) or the test's own words for what it checked (`what`),
 * a select's options by value or label (a string) or by index (a number).
 */
export type ManualInstruction =
  | { kind: 'goBack' | 'goForward' | 'reload' | 'gotoUnknown' | 'setContent' | 'keyboardType' }
  | { kind: 'mouseAt'; x: number; y: number; call: string }
  | { kind: 'mouseOrKeyboard' | 'failedCall'; call: string }
  | { kind: 'locatorCall'; locator: string; call: string }
  | {
      kind:
        | 'fillUnknown'
        | 'fillPartial'
        | 'pressUnknown'
        | 'selectOptionUnknown'
        | 'setInputFiles'
        | 'dragTo'
        | 'drop'
        | 'focus'
        | 'blur'
        | 'dispatchEvent'
        | 'scrollIntoViewIfNeeded';
      locator: string;
    }
  | { kind: 'selectOptions'; locator: string; options: Array<string | number> }
  | ({ kind: 'expectPoll'; matcher: string } & ManualCheckValues)
  | ({ kind: 'expectValue'; what: string } & ManualCheckValues)
  | ({ kind: 'expectLocator'; locator: string; matcher: string } & ManualCheckValues)
  | ({ kind: 'expectURL' } & ManualCheckValues)
  | { kind: 'leadingSteps'; count: number; limit: number };

export type ManualInstructionKind = ManualInstruction['kind'];

/** A box on the page, in CSS pixels from the viewport's top left corner. */
export interface ViewportBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The screenshot a bug recording took of the page as a step began, by the id
 * the recorder gave it, and where the step's element was on it. Kept by the
 * recorder only: a steps document never holds it.
 */
export interface StepView {
  id: string;
  box: ViewportBox | null;
}

/** One recorded, already-normalized user action. */
export interface RecordedStep {
  action: StepAction;
  target: RecordedTarget | null;
  /**
   * `fill`/`selectOption` value, the key name for `press`, or the names of the
   * files chosen for `setInputFiles`, one per line (never their content). Never
   * set for a password-type field — see `redacted`.
   */
  value: string | null;
  /** True when `value` was stripped because the source field was `type="password"` — codegen emits a placeholder instead. */
  redacted: boolean;
  /** The page the step happened on; empty when it is not known (a step made from a test run, after an action that may have left the page). */
  pageUrl: string;
  timestamp: number;
  /** Set on `assert` steps only. */
  assertion?: StepAssertion;
  /** Where a `dragTo` step drops what it drags; set on `dragTo` steps only. */
  dropTarget?: RecordedTarget | null;
  /** What a `manual` step asks a person to do; set on `manual` steps only. */
  manual?: StepManual;
  /** The page as the step began, in a bug recording; see {@link StepView}. */
  view?: StepView;
}

/**
 * The size of the page's viewport from the step at `step` on, in CSS pixels,
 * as `page.setViewportSize` sets it. A recording's first one, at step 0, is
 * the size it was recorded at; the others follow a resize. The browser's zoom
 * is already in the size (at 200%, a 1280-pixel window is 640 CSS pixels
 * wide); `zoom` keeps the factor itself when it was not 100%.
 */
export interface StepViewport {
  step: number;
  width: number;
  height: number;
  /** The browser's zoom factor, such as 1.25; absent at 100%. */
  zoom?: number;
}

export interface RecordedSession {
  steps: RecordedStep[];
  startedAt: number;
  /** The very first page's URL — the only step that becomes an explicit `page.goto(...)` in codegen. */
  startUrl: string;
  /** The viewport sizes the steps were recorded at, by the step each starts at; absent when none was recorded. */
  viewports?: StepViewport[];
}

/** A raw capture event, as built by the extension's DOM listeners — one per meaningful browser event, before coalescing. */
export interface RawCaptureEvent {
  kind:
    | 'click'
    | 'dblclick'
    | 'hover'
    | 'input'
    | 'change'
    | 'files'
    | 'drop'
    | 'keydown'
    | 'navigate'
    | 'assert'
    | 'viewport';
  /** The element acted on or asserted about; null for a navigation and for a `toHaveURL` assertion. */
  target: RecordedTarget | null;
  /** Current field value (input/change), the key pressed (keydown), the new URL (navigate), or the chosen files' names, one per line (files). */
  value: string | null;
  checked: boolean | null;
  inputType: string | null;
  isPasswordField: boolean;
  pageUrl: string;
  timestamp: number;
  /** What an `assert` event states: an expected value or state, added by hand during a recording. */
  assertion?: StepAssertion;
  /** Where a `drop` event's element was dropped; its `target` is the element dragged. */
  dropTarget?: RecordedTarget | null;
  /** The page's viewport size, on a `viewport` event: when the recording starts, and after a resize; with the zoom when not 100%. */
  viewport?: { width: number; height: number; zoom?: number };
  /** The page as the action began, in a bug recording; see {@link StepView}. */
  view?: StepView;
  /**
   * On a `navigate` event, a page the person reached on their own: through the
   * history (Back, Forward) or by reloading it, with no action of theirs
   * leading there. The steps go to it again.
   */
  navigation?: 'history' | 'reload';
}

/**
 * The narrowest identity available for a target, best first: the recorder's own
 * per-element token, then a test id, then the best locator alternative, and only
 * as a last resort the element's shape — which two unlabelled fields on the same
 * form share exactly.
 */
function targetKey(t: RecordedTarget): string {
  if (t.elementKey) return `el:${t.elementKey}`;
  if (t.testId) return `testid:${t.testId}`;
  const best = t.alternatives[0]?.locator;
  if (best) return `loc:${best}`;
  return `shape:${t.tagName}|${t.role ?? ''}|${t.accessibleName ?? ''}`;
}

function sameTarget(a: RecordedTarget | null, b: RecordedTarget | null): boolean {
  if (!a || !b) return a === b;
  return targetKey(a) === targetKey(b);
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * How long after an `Enter` press a click on the same element still counts as
 * the browser's own synthetic activation rather than a second, deliberate
 * click. The synthetic one lands in the same task; the allowance is for a busy
 * event loop, not for human timing.
 */
const ENTER_CLICK_WINDOW_MS = 500;

/**
 * The keys a recording keeps: Enter submits or picks, Escape closes a popup or
 * a dialog, and the arrows move through a list or a menu. Any other key only
 * edits a field, which the field's `fill` already carries.
 */
export const RECORDED_KEYS: ReadonlySet<string> = new Set(['Enter', 'Escape', 'ArrowDown', 'ArrowUp']);

/**
 * Whether a recorded key press becomes a step: one of `RECORDED_KEYS`, a
 * shortcut with a modifier as Playwright writes it (`ControlOrMeta+K`), or a
 * single character pressed outside a field (a page's own shortcut, such as `?`).
 * The recorder decides which presses to send; this keeps the rest out.
 */
function isRecordedKey(key: string | null | undefined): key is string {
  if (!key) return false;
  return (
    RECORDED_KEYS.has(key) || /^(?:(?:ControlOrMeta|Control|Meta|Alt|Shift)\+)+.+$/.test(key) || [...key].length === 1
  );
}

/**
 * Coalesce a stream of raw capture events into `RecordedStep`s:
 *  - a burst of `input` events on the same field collapses into one `fill`,
 *    committed once the field changes or the burst ends (the last value
 *    wins);
 *  - `change` on a checkbox/radio becomes `check`/`uncheck` from the
 *    resulting `checked` state, not a raw `click`;
 *  - `change` on a `<select>` becomes `selectOption`;
 *  - `Enter` becomes `press('Enter')`, and a click on the same element right
 *    after it (the activation Enter gives a focused button or link) is dropped
 *    rather than recorded a second time. The click the browser sends to a
 *    form's submit button for an Enter in one of its fields never arrives
 *    here: the recorder leaves it out. `Escape`, the arrow keys (`RECORDED_KEYS`)
 *    and the page's shortcuts (`isRecordedKey`) become presses too;
 *  - a plain `click` becomes a `click` step, and a `dblclick` replaces the
 *    two clicks on the same element the browser sent before it;
 *  - `files` (a file field's choice, names only) becomes `setInputFiles`, and
 *    `drop` (an HTML drag and drop) becomes `dragTo`;
 *  - a `hover` event becomes a `hover` step: the recorder sends one only for
 *    the element whose hover revealed what the next click lands on; a second
 *    hover on the same element right after the first is dropped;
 *  - `navigate` events become `goto` steps for the session's very first page,
 *    and for a page the person reached through the history or by reloading
 *    (`navigation`) — other navigations are implied by the click/press that
 *    caused them and are dropped (they still update `pageUrl` on later steps
 *    via the caller passing the current page's URL on each event).
 *  - an `assert` event becomes an `assert` step where it was added, after
 *    committing any fill in progress; one without an assertion is dropped;
 *  - password-field values are never carried through — `redacted: true`,
 *    `value: null`.
 */
export function normalizeSteps(events: RawCaptureEvent[]): RecordedStep[] {
  const steps: RecordedStep[] = [];
  let pendingFill: {
    target: RecordedTarget | null;
    value: string;
    pageUrl: string;
    timestamp: number;
    redacted: boolean;
    view?: StepView;
  } | null = null;
  /** The view of the event a step comes from, when the recorder took one. */
  const viewOf = (view: StepView | undefined): { view?: StepView } => (view ? { view } : {});
  let sawFirstGoto = false;

  function flushPendingFill(): void {
    if (!pendingFill) return;
    steps.push({
      action: 'fill',
      target: pendingFill.target,
      value: pendingFill.redacted ? null : pendingFill.value,
      redacted: pendingFill.redacted,
      pageUrl: pendingFill.pageUrl,
      timestamp: pendingFill.timestamp,
      ...viewOf(pendingFill.view),
    });
    pendingFill = null;
  }

  for (const ev of events) {
    // A viewport size is not a step: `viewportsForSteps` places it.
    if (ev.kind === 'viewport') continue;

    if (ev.kind === 'navigate') {
      flushPendingFill();
      if (!sawFirstGoto || ev.navigation) {
        sawFirstGoto = true;
        steps.push({
          action: 'goto',
          target: null,
          value: ev.value,
          redacted: false,
          pageUrl: ev.value ?? ev.pageUrl,
          timestamp: ev.timestamp,
        });
      }
      continue;
    }

    if (ev.kind === 'input') {
      if (pendingFill && sameTarget(pendingFill.target, ev.target)) {
        pendingFill.value = ev.value ?? '';
        pendingFill.timestamp = ev.timestamp;
        pendingFill.redacted = pendingFill.redacted || ev.isPasswordField;
        continue;
      }
      flushPendingFill();
      pendingFill = {
        target: ev.target,
        value: ev.value ?? '',
        pageUrl: ev.pageUrl,
        timestamp: ev.timestamp,
        redacted: ev.isPasswordField,
        ...viewOf(ev.view),
      };
      continue;
    }

    if (ev.kind === 'keydown') {
      if (!isRecordedKey(ev.value)) continue;
      // A key commits whatever field was mid-fill; Enter then replaces the click that would otherwise follow it.
      flushPendingFill();
      steps.push({
        action: 'press',
        target: ev.target,
        value: ev.value,
        redacted: false,
        pageUrl: ev.pageUrl,
        timestamp: ev.timestamp,
        ...viewOf(ev.view),
      });
      continue;
    }

    if (ev.kind === 'change') {
      flushPendingFill();
      if (ev.inputType === 'checkbox' || ev.inputType === 'radio') {
        steps.push({
          action: ev.checked ? 'check' : 'uncheck',
          target: ev.target,
          value: null,
          redacted: false,
          pageUrl: ev.pageUrl,
          timestamp: ev.timestamp,
          ...viewOf(ev.view),
        });
        continue;
      }
      if (ev.inputType === 'select') {
        steps.push({
          action: 'selectOption',
          target: ev.target,
          value: ev.value,
          redacted: false,
          pageUrl: ev.pageUrl,
          timestamp: ev.timestamp,
          ...viewOf(ev.view),
        });
        continue;
      }
      continue;
    }

    if (ev.kind === 'assert') {
      flushPendingFill();
      if (!ev.assertion) continue;
      steps.push({
        action: 'assert',
        target: ev.assertion.matcher === 'toHaveURL' ? null : ev.target,
        value: null,
        redacted: false,
        pageUrl: ev.pageUrl,
        timestamp: ev.timestamp,
        ...viewOf(ev.view),
        assertion: { ...ev.assertion },
      });
      continue;
    }

    if (ev.kind === 'hover') {
      flushPendingFill();
      const prev = steps[steps.length - 1];
      if (!ev.target || (prev?.action === 'hover' && sameTarget(prev.target, ev.target))) continue;
      steps.push({
        action: 'hover',
        target: ev.target,
        value: null,
        redacted: false,
        pageUrl: ev.pageUrl,
        timestamp: ev.timestamp,
        ...viewOf(ev.view),
      });
      continue;
    }

    if (ev.kind === 'dblclick') {
      flushPendingFill();
      // The page as the first of the clicks it replaces began.
      let view = ev.view;
      for (let i = 0; i < 2; i++) {
        const prev = steps[steps.length - 1];
        if (prev?.action === 'click' && sameTarget(prev.target, ev.target)) view = steps.pop()!.view ?? view;
      }
      steps.push({
        action: 'dblclick',
        target: ev.target,
        value: null,
        redacted: false,
        pageUrl: ev.pageUrl,
        timestamp: ev.timestamp,
        ...viewOf(view),
      });
      continue;
    }

    if (ev.kind === 'files') {
      flushPendingFill();
      if (!ev.target) continue;
      steps.push({
        action: 'setInputFiles',
        target: ev.target,
        value: ev.value ?? '',
        redacted: false,
        pageUrl: ev.pageUrl,
        timestamp: ev.timestamp,
        ...viewOf(ev.view),
      });
      continue;
    }

    if (ev.kind === 'drop') {
      flushPendingFill();
      if (!ev.target || !ev.dropTarget) continue;
      steps.push({
        action: 'dragTo',
        target: ev.target,
        value: null,
        redacted: false,
        pageUrl: ev.pageUrl,
        timestamp: ev.timestamp,
        ...viewOf(ev.view),
        dropTarget: ev.dropTarget,
      });
      continue;
    }

    if (ev.kind === 'click') {
      flushPendingFill();
      // A checkbox/radio click that will also fire `change` is handled there; a plain click on anything else records here.
      if (ev.inputType === 'checkbox' || ev.inputType === 'radio') continue;
      // Enter on a focused button or link fires `keydown` *and* a synthetic
      // `click`. The press already records the intent: the click would make the
      // generated spec activate the same control a second time.
      const prev = steps[steps.length - 1];
      if (
        prev?.action === 'press' &&
        prev.value === 'Enter' &&
        sameTarget(prev.target, ev.target) &&
        ev.timestamp - prev.timestamp <= ENTER_CLICK_WINDOW_MS
      ) {
        continue;
      }
      steps.push({
        action: 'click',
        target: ev.target,
        value: null,
        redacted: false,
        pageUrl: ev.pageUrl,
        timestamp: ev.timestamp,
        ...viewOf(ev.view),
      });
      continue;
    }
  }

  flushPendingFill();
  const withText = (t: RecordedTarget): RecordedTarget => ({ ...t, text: t.text ? normalizeText(t.text) : null });
  return steps.map((s) => {
    const step = s.target ? { ...s, target: withText(s.target) } : s;
    return step.dropTarget ? { ...step, dropTarget: withText(step.dropTarget) } : step;
  });
}

/** Builds a `RecordedSession` from a flat step list — `startUrl` is the first step's page, or the first `goto`'s value. */
export function buildSession(steps: RecordedStep[], startedAt: number): RecordedSession {
  const firstGoto = steps.find((s) => s.action === 'goto');
  const startUrl = firstGoto?.value ?? steps[0]?.pageUrl ?? '';
  return { steps, startedAt, startUrl };
}

/**
 * The viewport sizes of `viewport` events, by the step each applies from: the
 * first step recorded at or after the size was. Of several sizes before one
 * step the last counts, a size equal to the one before it is left out, and a
 * size taken after the last step is dropped.
 */
export function viewportsForSteps(steps: RecordedStep[], events: RawCaptureEvent[]): StepViewport[] {
  const sizes = events.filter((e) => e.kind === 'viewport' && e.viewport).sort((a, b) => a.timestamp - b.timestamp);
  const byStep = new Map<number, StepViewport>();
  for (const e of sizes) {
    const step = steps.findIndex((s) => s.timestamp >= e.timestamp);
    if (step < 0) continue;
    const { width, height, zoom } = e.viewport!;
    byStep.set(step, { step, width, height, ...(zoom != null && zoom !== 1 ? { zoom } : {}) });
  }
  const out: StepViewport[] = [];
  for (const v of [...byStep.values()].sort((a, b) => a.step - b.step)) {
    const last = out[out.length - 1];
    if (!last || last.width !== v.width || last.height !== v.height || (last.zoom ?? 1) !== (v.zoom ?? 1)) out.push(v);
  }
  return out;
}

/** The view each step began from, by step: the steps a bug recording took a screenshot for. */
export function stepViews(steps: RecordedStep[]): Array<StepView & { step: number }> {
  return steps.flatMap((s, step) => (s.view ? [{ step, id: s.view.id, box: s.view.box }] : []));
}

/** A recording's session from its raw events: its steps, and the viewport sizes it recorded when there are any. */
export function sessionFromEvents(events: RawCaptureEvent[], startedAt: number): RecordedSession {
  const session = buildSession(normalizeSteps(events), startedAt);
  const viewports = viewportsForSteps(session.steps, events);
  return viewports.length > 0 ? { ...session, viewports } : session;
}

/** The kinds of capture event a recorder sends. */
const CAPTURE_KINDS: ReadonlySet<RawCaptureEvent['kind']> = new Set([
  'click',
  'dblclick',
  'hover',
  'input',
  'change',
  'files',
  'drop',
  'keydown',
  'navigate',
  'assert',
  'viewport',
]);

/** The longest strings `parseCaptureEvent` keeps, and the bounds of its numbers. */
const CAPTURE_LIMITS = {
  tagName: 64,
  /** A target's role, accessible name, test id and text. */
  targetText: 500,
  elementKey: 128,
  alternatives: 10,
  locator: 2000,
  method: 64,
  value: 100_000,
  inputType: 32,
  pageUrl: 4096,
  /** An assertion's expected and recorded values. */
  assertionValue: 2000,
  note: 500,
  /** The widest and tallest viewport, in CSS pixels. */
  viewportSize: 10_000,
  zoom: { min: 0.25, max: 5 },
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A string cut to its first `max` characters; null for anything else. */
function boundedText(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

/** A locator alternative within the limits, or null. */
function parseAlternative(v: unknown): RecordedLocatorAlternative | null {
  if (!isRecord(v)) return null;
  const { locator, method, score } = v;
  if (typeof locator !== 'string' || locator.length > CAPTURE_LIMITS.locator) return null;
  if (typeof method !== 'string' || method.length > CAPTURE_LIMITS.method) return null;
  if (!isFiniteNumber(score)) return null;
  return { locator, method, score };
}

/** A target rebuilt from its known fields, strings cut to their limits and the alternatives that parse; null for anything but an object. */
function parseTarget(v: unknown): RecordedTarget | null {
  if (!isRecord(v)) return null;
  const alternatives: RecordedLocatorAlternative[] = [];
  if (Array.isArray(v.alternatives)) {
    for (const entry of v.alternatives) {
      if (alternatives.length === CAPTURE_LIMITS.alternatives) break;
      const alternative = parseAlternative(entry);
      if (alternative) alternatives.push(alternative);
    }
  }
  return {
    tagName: boundedText(v.tagName, CAPTURE_LIMITS.tagName) ?? '',
    role: boundedText(v.role, CAPTURE_LIMITS.targetText),
    accessibleName: boundedText(v.accessibleName, CAPTURE_LIMITS.targetText),
    testId: boundedText(v.testId, CAPTURE_LIMITS.targetText),
    text: boundedText(v.text, CAPTURE_LIMITS.targetText),
    alternatives,
    ...(typeof v.elementKey === 'string' ? { elementKey: v.elementKey.slice(0, CAPTURE_LIMITS.elementKey) } : {}),
  };
}

/** An assertion with a known matcher, or null. */
function parseAssertion(v: unknown): StepAssertion | null {
  if (!isRecord(v)) return null;
  const matcher = v.matcher as AssertionMatcher;
  if (!ASSERTION_MATCHERS.includes(matcher)) return null;
  return {
    matcher,
    expected: boundedText(v.expected, CAPTURE_LIMITS.assertionValue),
    actual: boundedText(v.actual, CAPTURE_LIMITS.assertionValue),
    negated: v.negated === true,
    note: boundedText(v.note, CAPTURE_LIMITS.note),
  };
}

/** A viewport size within the bounds, with its zoom when it has one; null for anything else. */
function parseViewport(v: unknown): RawCaptureEvent['viewport'] | null {
  if (!isRecord(v)) return null;
  const { width, height, zoom } = v;
  const isSize = (n: unknown): n is number => isFiniteNumber(n) && n >= 1 && n <= CAPTURE_LIMITS.viewportSize;
  if (!isSize(width) || !isSize(height)) return null;
  if (zoom == null) return { width, height };
  if (!isFiniteNumber(zoom) || zoom < CAPTURE_LIMITS.zoom.min || zoom > CAPTURE_LIMITS.zoom.max) return null;
  return { width, height, zoom };
}

/**
 * A capture event from a page that cannot be trusted (a page can call the
 * binding a recording browser exposes), rebuilt field by field: the known
 * fields only, each of its own type or else null (false for
 * `isPasswordField`), strings cut to their limits, and the locator
 * alternatives that parse. Null when it has no known `kind`, no `pageUrl`
 * string, no finite `timestamp`, or an assertion without a known matcher. A
 * password field's value is never kept; a viewport out of bounds is left out,
 * and so is `view`. A navigation's cause stays on a navigate event to the
 * http(s) address the event was sent from only.
 */
export function parseCaptureEvent(value: unknown): RawCaptureEvent | null {
  if (!isRecord(value)) return null;
  const kind = value.kind as RawCaptureEvent['kind'];
  if (!CAPTURE_KINDS.has(kind)) return null;
  const { pageUrl, timestamp } = value;
  if (typeof pageUrl !== 'string' || !isFiniteNumber(timestamp)) return null;
  const isPasswordField = value.isPasswordField === true;
  const event: RawCaptureEvent = {
    kind,
    target: parseTarget(value.target),
    value: isPasswordField ? null : boundedText(value.value, CAPTURE_LIMITS.value),
    checked: typeof value.checked === 'boolean' ? value.checked : null,
    inputType: boundedText(value.inputType, CAPTURE_LIMITS.inputType),
    isPasswordField,
    pageUrl: pageUrl.slice(0, CAPTURE_LIMITS.pageUrl),
    timestamp,
  };
  if (value.assertion != null) {
    const assertion = parseAssertion(value.assertion);
    if (!assertion) return null;
    event.assertion = assertion;
  }
  if (value.dropTarget !== undefined) event.dropTarget = parseTarget(value.dropTarget);
  const viewport = parseViewport(value.viewport);
  if (viewport) event.viewport = viewport;
  if (
    kind === 'navigate' &&
    (value.navigation === 'history' || value.navigation === 'reload') &&
    event.value === event.pageUrl &&
    /^https?:\/\//i.test(event.pageUrl)
  ) {
    event.navigation = value.navigation;
  }
  return event;
}
